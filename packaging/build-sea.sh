#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
AGENT_DIR="$REPO_DIR/apps/local-agent"
OUTPUT_DIR=${AGENTFLEET_RELEASE_DIR:-"$REPO_DIR/release"}
VERSION=${1:-$(node -p "require('$AGENT_DIR/package.json').version")}

if ! printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$'; then
  echo "SEA release version must be semantic" >&2
  exit 2
fi

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "SEA releases must be built on Linux x86_64" >&2
  exit 1
fi
if [ "$(node -p 'process.versions.node.split(`.`)[0]')" != "24" ]; then
  echo "Node 24 is required to build the AgentFleet SEA" >&2
  exit 1
fi

mkdir -p "$SCRIPT_DIR/build" "$OUTPUT_DIR"
ARTIFACT="$OUTPUT_DIR/agentfleet-linux-x64-$VERSION"
PORTABLE_ARTIFACT="$ARTIFACT.tar.gz"
RELEASE_LOCK="$OUTPUT_DIR/.agentfleet-release-build.lock"
LOCK_ACQUIRED=no
STAGED_ARTIFACT=""
STAGED_CHECKSUM=""
STAGED_MANIFEST=""
PUBLISHED_ARTIFACT=no
PUBLISHED_CHECKSUM=no
MANIFEST_COMMITTED=no
cleanup() {
  if [ "$MANIFEST_COMMITTED" = no ]; then
    if [ "$PUBLISHED_CHECKSUM" = yes ] && [ -e "$ARTIFACT.sha256" ] && [ "$ARTIFACT.sha256" -ef "$STAGED_CHECKSUM" ]; then
      rm -f -- "$ARTIFACT.sha256"
    fi
    if [ "$PUBLISHED_ARTIFACT" = yes ] && [ -e "$ARTIFACT" ] && [ "$ARTIFACT" -ef "$STAGED_ARTIFACT" ]; then
      rm -f -- "$ARTIFACT"
    fi
  fi
  if [ -n "$STAGED_ARTIFACT" ]; then rm -f -- "$STAGED_ARTIFACT"; fi
  if [ -n "$STAGED_CHECKSUM" ]; then rm -f -- "$STAGED_CHECKSUM"; fi
  if [ -n "$STAGED_MANIFEST" ]; then rm -f -- "$STAGED_MANIFEST"; fi
  if [ "$LOCK_ACQUIRED" = yes ]; then rmdir -- "$RELEASE_LOCK" 2>/dev/null || true; fi
}
trap cleanup EXIT HUP INT TERM
if ! mkdir "$RELEASE_LOCK"; then
  echo "another release build is already publishing into $OUTPUT_DIR" >&2
  exit 73
fi
LOCK_ACQUIRED=yes
for EXISTING_RELEASE_PATH in \
  "$ARTIFACT" "$ARTIFACT.sha256" \
  "$PORTABLE_ARTIFACT" "$PORTABLE_ARTIFACT.sha256"
do
  if [ -e "$EXISTING_RELEASE_PATH" ] || [ -L "$EXISTING_RELEASE_PATH" ]; then
    echo "immutable release already exists for version $VERSION: $EXISTING_RELEASE_PATH" >&2
    exit 73
  fi
done

cd "$AGENT_DIR"
npm run build
"$AGENT_DIR/node_modules/.bin/esbuild" "$AGENT_DIR/dist/src/cli.js" \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node24 \
  --banner:js="$(tr '\n' ' ' < "$SCRIPT_DIR/sea-prelude.cjs")" \
  --log-level=error \
  --outfile="$SCRIPT_DIR/build/agentfleet.cjs"

cd "$SCRIPT_DIR"
node --experimental-sea-config "$SCRIPT_DIR/sea-config.json"
STAGED_ARTIFACT="$OUTPUT_DIR/.agentfleet-linux-x64-$VERSION.staging-$$"
STAGED_CHECKSUM="$OUTPUT_DIR/.agentfleet-linux-x64-$VERSION.sha256.staging-$$"
STAGED_MANIFEST="$OUTPUT_DIR/.manifest.json.staging-$$"
for STAGING_PATH in "$STAGED_ARTIFACT" "$STAGED_CHECKSUM" "$STAGED_MANIFEST"; do
  if [ -e "$STAGING_PATH" ] || [ -L "$STAGING_PATH" ]; then
    echo "refusing to overwrite existing release staging path: $STAGING_PATH" >&2
    exit 1
  fi
done
cp "$(command -v node)" "$STAGED_ARTIFACT"
"$AGENT_DIR/node_modules/.bin/postject" "$STAGED_ARTIFACT" NODE_SEA_BLOB "$SCRIPT_DIR/build/agentfleet.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
chmod 755 "$STAGED_ARTIFACT"

ACTUAL_VERSION=$($STAGED_ARTIFACT --version 2> "$SCRIPT_DIR/build/sea-version.stderr")
if [ "$ACTUAL_VERSION" != "$VERSION" ]; then
  echo "SEA smoke test returned version '$ACTUAL_VERSION', expected '$VERSION'" >&2
  exit 1
fi
if [ -s "$SCRIPT_DIR/build/sea-version.stderr" ]; then
  echo "SEA version smoke test unexpectedly wrote to stderr" >&2
  cat "$SCRIPT_DIR/build/sea-version.stderr" >&2
  exit 1
fi
if ! "$STAGED_ARTIFACT" --help | grep -q 'agentfleet onboard'; then
  echo "SEA argv smoke test did not expose the onboard command" >&2
  exit 1
fi
if "$STAGED_ARTIFACT" onboard --sea-argv-smoke-invalid x > /dev/null 2> "$SCRIPT_DIR/build/sea-argv-smoke.log"; then
  echo "SEA argv smoke test unexpectedly accepted an invalid option" >&2
  exit 1
fi
if ! grep -q 'ARGUMENT_UNKNOWN' "$SCRIPT_DIR/build/sea-argv-smoke.log"; then
  echo "SEA argv smoke test did not dispatch to onboard" >&2
  exit 1
fi

# Prepare and validate the complete release tuple before exposing any of it.
# The checksum line and manifest use the final public basename even though
# their content is calculated from the private staging artifact.
STAGED_DIGEST=$(sha256sum "$STAGED_ARTIFACT" | awk '{print $1}')
printf '%s  %s\n' "$STAGED_DIGEST" "$(basename -- "$ARTIFACT")" > "$STAGED_CHECKSUM"
node "$SCRIPT_DIR/generate-manifest.mjs" \
  "$VERSION" sea "$STAGED_ARTIFACT" "$STAGED_MANIFEST" "$(basename -- "$ARTIFACT")"

# A hard-link publication is atomic and fails if another builder published the
# same immutable version after the preflight check. Never use mv -f here.
if ! ln "$STAGED_ARTIFACT" "$ARTIFACT"; then
  echo "immutable release was published concurrently for version $VERSION" >&2
  exit 73
fi
PUBLISHED_ARTIFACT=yes
if ! ln "$STAGED_CHECKSUM" "$ARTIFACT.sha256"; then
  echo "immutable checksum was published concurrently for version $VERSION" >&2
  exit 73
fi
PUBLISHED_CHECKSUM=yes
# Ignore termination signals only for the tiny manifest commit window. EXIT
# cleanup still rolls back both hard links if the move itself fails.
trap '' HUP INT TERM
if mv -f "$STAGED_MANIFEST" "$OUTPUT_DIR/manifest.json"; then
  MANIFEST_COMMITTED=yes
else
  trap cleanup HUP INT TERM
  echo "failed to publish release manifest" >&2
  exit 1
fi
trap cleanup HUP INT TERM
STAGED_MANIFEST=""
rm -f -- "$STAGED_ARTIFACT" "$STAGED_CHECKSUM"
STAGED_ARTIFACT=""
STAGED_CHECKSUM=""
echo "Built $ARTIFACT"
