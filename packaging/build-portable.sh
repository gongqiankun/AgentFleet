#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
AGENT_DIR="$REPO_DIR/apps/local-agent"
OUTPUT_DIR=${AGENTFLEET_RELEASE_DIR:-"$REPO_DIR/release"}
VERSION=${1:-$(node -p "require('$AGENT_DIR/package.json').version")}

if ! printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$'; then
  echo "portable release version must be semantic" >&2
  exit 2
fi

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo "portable releases must be built on Linux x86_64" >&2
  exit 1
fi
if [ "$(node -p 'process.versions.node.split(`.`)[0]')" != "24" ]; then
  echo "Node 24 is required to build the portable AgentFleet runtime" >&2
  exit 1
fi

mkdir -p "$SCRIPT_DIR/build" "$OUTPUT_DIR"
SEA_ARTIFACT="$OUTPUT_DIR/agentfleet-linux-x64-$VERSION"
ARTIFACT="$SEA_ARTIFACT.tar.gz"
RELEASE_LOCK="$OUTPUT_DIR/.agentfleet-release-build.lock"
LOCK_ACQUIRED=no
STAGE=""
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
  if [ -n "$STAGE" ]; then rm -rf -- "$STAGE"; fi
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
  "$SEA_ARTIFACT" "$SEA_ARTIFACT.sha256" \
  "$ARTIFACT" "$ARTIFACT.sha256"
do
  if [ -e "$EXISTING_RELEASE_PATH" ] || [ -L "$EXISTING_RELEASE_PATH" ]; then
    echo "immutable release already exists for version $VERSION: $EXISTING_RELEASE_PATH" >&2
    exit 73
  fi
done

cd "$AGENT_DIR"
npm run build

STAGE=$(mktemp -d "$SCRIPT_DIR/build/portable-$VERSION.XXXXXX")
mkdir -p "$STAGE/agentfleet/runtime" "$STAGE/agentfleet/lib"
cp "$(command -v node)" "$STAGE/agentfleet/runtime/node"
cp -R "$AGENT_DIR/dist" "$STAGE/agentfleet/lib/dist"
cp "$AGENT_DIR/package.json" "$STAGE/agentfleet/lib/package.json"
cp "$SCRIPT_DIR/portable-launcher.sh" "$STAGE/agentfleet/agentfleet"
chmod 755 "$STAGE/agentfleet/agentfleet" "$STAGE/agentfleet/runtime/node"

STAGED_ARTIFACT="$OUTPUT_DIR/.agentfleet-linux-x64-$VERSION.tar.gz.staging-$$"
STAGED_CHECKSUM="$OUTPUT_DIR/.agentfleet-linux-x64-$VERSION.tar.gz.sha256.staging-$$"
STAGED_MANIFEST="$OUTPUT_DIR/.manifest.json.staging-$$"
for STAGING_PATH in "$STAGED_ARTIFACT" "$STAGED_CHECKSUM" "$STAGED_MANIFEST"; do
  if [ -e "$STAGING_PATH" ] || [ -L "$STAGING_PATH" ]; then
    echo "refusing to overwrite existing release staging path: $STAGING_PATH" >&2
    exit 1
  fi
done
tar -czf "$STAGED_ARTIFACT" -C "$STAGE" agentfleet
PORTABLE_VERSION=$($STAGE/agentfleet/agentfleet --version 2> "$SCRIPT_DIR/build/portable-version.stderr")
if [ "$PORTABLE_VERSION" != "$VERSION" ] || [ -s "$SCRIPT_DIR/build/portable-version.stderr" ]; then
  echo "portable version smoke test failed or wrote to stderr" >&2
  cat "$SCRIPT_DIR/build/portable-version.stderr" >&2
  exit 1
fi
PORTABLE_LINK="$STAGE/agentfleet-via-link"
ln -s "$STAGE/agentfleet/agentfleet" "$PORTABLE_LINK"
LINKED_PORTABLE_VERSION=$($PORTABLE_LINK --version 2> "$SCRIPT_DIR/build/portable-link-version.stderr")
if [ "$LINKED_PORTABLE_VERSION" != "$VERSION" ] || [ -s "$SCRIPT_DIR/build/portable-link-version.stderr" ]; then
  echo "portable symlink launcher smoke test failed or wrote to stderr" >&2
  cat "$SCRIPT_DIR/build/portable-link-version.stderr" >&2
  exit 1
fi
if ! "$STAGE/agentfleet/agentfleet" --help | grep -q 'agentfleet onboard'; then
  echo "portable argv smoke test did not expose the onboard command" >&2
  exit 1
fi
if "$STAGE/agentfleet/agentfleet" onboard --portable-argv-smoke-invalid x > /dev/null 2> "$SCRIPT_DIR/build/portable-argv-smoke.log"; then
  echo "portable argv smoke test unexpectedly accepted an invalid option" >&2
  exit 1
fi
if ! grep -q 'ARGUMENT_UNKNOWN' "$SCRIPT_DIR/build/portable-argv-smoke.log"; then
  echo "portable argv smoke test did not dispatch to onboard" >&2
  exit 1
fi

STAGED_DIGEST=$(sha256sum "$STAGED_ARTIFACT" | awk '{print $1}')
printf '%s  %s\n' "$STAGED_DIGEST" "$(basename -- "$ARTIFACT")" > "$STAGED_CHECKSUM"
node "$SCRIPT_DIR/generate-manifest.mjs" \
  "$VERSION" portable "$STAGED_ARTIFACT" "$STAGED_MANIFEST" "$(basename -- "$ARTIFACT")"

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
