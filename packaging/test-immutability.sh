#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agentfleet-immutability.XXXXXX")
cleanup() {
  rm -rf -- "$TEMP_DIR"
}
trap cleanup EXIT HUP INT TERM

FAILURE_INDEX=0
expect_status() {
  EXPECTED_STATUS=$1
  EXPECTED_PATTERN=$2
  shift 2
  FAILURE_INDEX=$((FAILURE_INDEX + 1))
  STDOUT_FILE="$TEMP_DIR/failure-$FAILURE_INDEX.stdout"
  STDERR_FILE="$TEMP_DIR/failure-$FAILURE_INDEX.stderr"
  set +e
  "$@" > "$STDOUT_FILE" 2> "$STDERR_FILE"
  ACTUAL_STATUS=$?
  set -e
  if [ "$ACTUAL_STATUS" -ne "$EXPECTED_STATUS" ]; then
    echo "expected exit $EXPECTED_STATUS, got $ACTUAL_STATUS: $*" >&2
    cat "$STDERR_FILE" >&2
    exit 1
  fi
  if ! grep -q "$EXPECTED_PATTERN" "$STDERR_FILE"; then
    echo "expected error pattern '$EXPECTED_PATTERN': $*" >&2
    cat "$STDERR_FILE" >&2
    exit 1
  fi
}

# Direct builders and the SEA-to-portable wrapper must fail before touching an
# existing version, including an adjacent dangling checksum symlink.
SEA_OUTPUT="$TEMP_DIR/sea-output"
mkdir "$SEA_OUTPUT"
printf '%s\n' original-sea > "$SEA_OUTPUT/agentfleet-linux-x64-8.8.8"
printf '%s\n' original-manifest > "$SEA_OUTPUT/manifest.json"
expect_status 73 'immutable release already exists' \
  env AGENTFLEET_RELEASE_DIR="$SEA_OUTPUT" "$SCRIPT_DIR/build-sea.sh" 8.8.8
test "$(cat "$SEA_OUTPUT/agentfleet-linux-x64-8.8.8")" = original-sea
test "$(cat "$SEA_OUTPUT/manifest.json")" = original-manifest
expect_status 73 'refusing portable fallback' \
  env AGENTFLEET_RELEASE_DIR="$SEA_OUTPUT" "$SCRIPT_DIR/build-release.sh" 8.8.8
test ! -e "$SEA_OUTPUT/agentfleet-linux-x64-8.8.8.tar.gz"

PORTABLE_OUTPUT="$TEMP_DIR/portable-output"
mkdir "$PORTABLE_OUTPUT"
ln -s missing "$PORTABLE_OUTPUT/agentfleet-linux-x64-9.9.9.tar.gz.sha256"
expect_status 73 'immutable release already exists' \
  env AGENTFLEET_RELEASE_DIR="$PORTABLE_OUTPUT" "$SCRIPT_DIR/build-portable.sh" 9.9.9
test -L "$PORTABLE_OUTPUT/agentfleet-linux-x64-9.9.9.tar.gz.sha256"

LOCKED_OUTPUT="$TEMP_DIR/locked-output"
mkdir -p "$LOCKED_OUTPUT/.agentfleet-release-build.lock"
expect_status 73 'another release build is already publishing' \
  env AGENTFLEET_RELEASE_DIR="$LOCKED_OUTPUT" "$SCRIPT_DIR/build-sea.sh" 10.10.10

# Replace curl with a deterministic local fixture copier. The production
# installer still exercises manifest parsing, size/SHA verification, staging,
# installed-version metadata, and symlink activation.
FAKE_BIN="$TEMP_DIR/fake-bin"
FIXTURE_SITE="$TEMP_DIR/site"
mkdir -p "$FAKE_BIN" "$FIXTURE_SITE/downloads"
cat > "$FAKE_BIN/curl" <<'EOF'
#!/bin/sh
set -eu
URL=""
DESTINATION=""
EXPECT_DESTINATION=no
for ARGUMENT in "$@"; do
  if [ "$EXPECT_DESTINATION" = yes ]; then
    DESTINATION=$ARGUMENT
    EXPECT_DESTINATION=no
  else
    case "$ARGUMENT" in
      -o) EXPECT_DESTINATION=yes ;;
      http://*|https://*) URL=$ARGUMENT ;;
    esac
  fi
done
if [ -z "$URL" ] || [ -z "$DESTINATION" ] || [ "$EXPECT_DESTINATION" = yes ]; then
  echo "fixture curl received invalid arguments" >&2
  exit 2
fi
case "$URL" in
  */downloads/manifest.json) SOURCE="$FIXTURE_SITE/downloads/manifest.json" ;;
  */downloads/*) SOURCE="$FIXTURE_SITE/downloads/${URL##*/}" ;;
  *) echo "fixture curl rejected URL: $URL" >&2; exit 2 ;;
esac
cp "$SOURCE" "$DESTINATION"
EOF
chmod 755 "$FAKE_BIN/curl"

# Keep these installer tests network-free while exercising the verified Codex
# fallback used when the target has no compatible local executable.
CODEX_FIXTURE_DIR="$TEMP_DIR/codex-fixture"
mkdir -p "$CODEX_FIXTURE_DIR"
cat > "$CODEX_FIXTURE_DIR/codex-x86_64-unknown-linux-musl" <<'EOF'
#!/bin/sh
set -eu
if [ "${1:-}" = "--version" ]; then
  echo 'codex-cli 0.153.2'
  exit 0
fi
test "${1:-}" = app-server
test "${2:-}" = generate-json-schema
test "${3:-}" = --out
mkdir -p "$4"
printf '{}\n' > "$4/codex_app_server_protocol.v2.schemas.json"
EOF
chmod 755 "$CODEX_FIXTURE_DIR/codex-x86_64-unknown-linux-musl"
CODEX_FIXTURE_FILE=codex-linux-x64-0.153.2.tar.gz
tar -czf "$FIXTURE_SITE/downloads/$CODEX_FIXTURE_FILE" \
  -C "$CODEX_FIXTURE_DIR" codex-x86_64-unknown-linux-musl
CODEX_FIXTURE_SHA=$(sha256sum "$FIXTURE_SITE/downloads/$CODEX_FIXTURE_FILE" | awk '{print $1}')
CODEX_FIXTURE_SIZE=$(wc -c < "$FIXTURE_SITE/downloads/$CODEX_FIXTURE_FILE" | tr -d ' ')
CODEX_FIXTURE_SCHEMA_HASH=$(printf '{}\n' | sha256sum | awk '{print $1}')
printf 'immutable-test-helper\n' > "$FIXTURE_SITE/downloads/codex-bwrap-linux-x64-0.153.2"
BWRAP_FIXTURE_SHA256=$(sha256sum "$FIXTURE_SITE/downloads/codex-bwrap-linux-x64-0.153.2" | awk '{print $1}')
printf '{"schemaVersion":1,"version":"0.153.2","artifacts":{"linux-x64":{"file":"%s","sha256":"%s","size":%s,"format":"tar.gz"}}}\n' \
  "$CODEX_FIXTURE_FILE" "$CODEX_FIXTURE_SHA" "$CODEX_FIXTURE_SIZE" \
  > "$FIXTURE_SITE/downloads/codex-manifest.json"

write_manifest() {
  MANIFEST_VERSION=$1
  MANIFEST_FORMAT=$2
  MANIFEST_FILE=$3
  MANIFEST_ARTIFACT="$FIXTURE_SITE/downloads/$MANIFEST_FILE"
  MANIFEST_SHA=$(sha256sum "$MANIFEST_ARTIFACT" | awk '{print $1}')
  MANIFEST_SIZE=$(wc -c < "$MANIFEST_ARTIFACT" | tr -d ' ')
  printf '{"schemaVersion":1,"version":"%s","artifacts":{"linux-x64":{"file":"%s","sha256":"%s","size":%s,"format":"%s"}}}\n' \
    "$MANIFEST_VERSION" "$MANIFEST_FILE" "$MANIFEST_SHA" "$MANIFEST_SIZE" "$MANIFEST_FORMAT" \
    > "$FIXTURE_SITE/downloads/manifest.json"
}

write_agent_stub() {
  STUB_PATH=$1
  STUB_VERSION=$2
  STUB_VARIANT=$3
  printf '%s\n' \
    '#!/bin/sh' \
    'set -eu' \
    "# variant: $STUB_VARIANT" \
    "if [ \"\${1:-}\" = \"--version\" ]; then echo '$STUB_VERSION'; exit 0; fi" \
    'if [ "${1:-}" = "onboard" ]; then exit 0; fi' \
    'if [ "${1:-}" = "service" ] && [ "${2:-}" = "uninstall" ]; then exit 0; fi' \
    'echo "unexpected fixture command" >&2' \
    'exit 2' > "$STUB_PATH"
  chmod 755 "$STUB_PATH"
}

run_installer() {
  INSTALL_HOME=$1
  shift
  mkdir -p "$INSTALL_HOME/home" "$INSTALL_HOME/tmp"
  env \
    HOME="$INSTALL_HOME/home" \
    XDG_DATA_HOME="$INSTALL_HOME/data" \
    XDG_CONFIG_HOME="$INSTALL_HOME/config" \
    TMPDIR="$INSTALL_HOME/tmp" \
    FIXTURE_SITE="$FIXTURE_SITE" \
    AGENTFLEET_INSTALLER_TEST_SCHEMA_HASH="$CODEX_FIXTURE_SCHEMA_HASH" \
    AGENTFLEET_INSTALLER_TEST_BWRAP_SHA256="$BWRAP_FIXTURE_SHA256" \
    PATH="$FAKE_BIN:$PATH" \
    "$SCRIPT_DIR/install.sh" "$@"
}

assert_no_installer_temp() {
  for RESIDUAL_PATH in "$1"/tmp/agentfleet-install.*; do
    if [ -e "$RESIDUAL_PATH" ] || [ -L "$RESIDUAL_PATH" ]; then
      echo "installer left a temporary download behind: $RESIDUAL_PATH" >&2
      exit 1
    fi
  done
}

SEA_HOME="$TEMP_DIR/sea-home"
mkdir -p "$SEA_HOME/home"
SEA_VERSION=1.2.3
SEA_FILE="agentfleet-linux-x64-$SEA_VERSION"
write_agent_stub "$FIXTURE_SITE/downloads/$SEA_FILE" "$SEA_VERSION" first
write_manifest "$SEA_VERSION" sea "$SEA_FILE"
FIRST_SEA_SHA=$(sha256sum "$FIXTURE_SITE/downloads/$SEA_FILE" | awk '{print $1}')
run_installer "$SEA_HOME" --url http://127.0.0.1 --no-service >/dev/null
assert_no_installer_temp "$SEA_HOME"
SEA_TARGET="$SEA_HOME/data/agentfleet/bin/$SEA_VERSION"
SEA_METADATA="$SEA_TARGET/.artifact-metadata"
SEA_PROFILE="$SEA_HOME/data/agentfleet/runtime-profile.json"
test -f "$SEA_METADATA"
test ! -L "$SEA_METADATA"
grep -qx "sha256=$FIRST_SEA_SHA" "$SEA_METADATA"
grep -qx 'format=sea' "$SEA_METADATA"
test -f "$SEA_PROFILE"
test ! -L "$SEA_PROFILE"
test "$(stat -c '%a' "$SEA_PROFILE")" = 600
grep -q '"schemaVersion":1' "$SEA_PROFILE"
grep -q "\"codexExecutable\":\"$SEA_HOME/data/agentfleet/codex/codex\"" "$SEA_PROFILE"
grep -q "\"codexHome\":\"$SEA_HOME/home/.codex\"" "$SEA_PROFILE"
grep -q '"source":"managed"' "$SEA_PROFILE"
FIRST_SEA_PROFILE_SHA=$(sha256sum "$SEA_PROFILE" | awk '{print $1}')
run_installer "$SEA_HOME" --url http://127.0.0.1 --no-service >/dev/null
assert_no_installer_temp "$SEA_HOME"
test "$(sha256sum "$SEA_PROFILE" | awk '{print $1}')" = "$FIRST_SEA_PROFILE_SHA"

PURGE_HOME="$TEMP_DIR/purge-home"
run_installer "$PURGE_HOME" --url http://127.0.0.1 --no-service >/dev/null
printf '%s\n' local-state > "$PURGE_HOME/data/agentfleet/state.sqlite"
run_installer "$PURGE_HOME" --uninstall --purge >/dev/null
test ! -e "$PURGE_HOME/data/agentfleet"
test ! -e "$PURGE_HOME/home/.local/bin/agentfleet"
assert_no_installer_temp "$PURGE_HOME"

# A locally replaced SEA must be rejected by its pinned SHA before the
# installer executes the replacement even for a --version probe.
cp "$SEA_TARGET/agentfleet" "$TEMP_DIR/original-installed-sea"
printf '%s\n' \
  '#!/bin/sh' \
  "printf '%s\\n' executed > '$SEA_HOME/tampered-executed'" \
  "echo '$SEA_VERSION'" > "$SEA_TARGET/agentfleet"
chmod 755 "$SEA_TARGET/agentfleet"
expect_status 1 'installed SEA content does not match' \
  run_installer "$SEA_HOME" --url http://127.0.0.1 --no-service
test ! -e "$SEA_HOME/tampered-executed"
assert_no_installer_temp "$SEA_HOME"
cp "$TEMP_DIR/original-installed-sea" "$SEA_TARGET/agentfleet"
chmod 755 "$SEA_TARGET/agentfleet"

cp "$SEA_METADATA" "$TEMP_DIR/sea-metadata.saved"
rm -f -- "$SEA_METADATA"
expect_status 1 'lacks valid immutable artifact metadata' \
  run_installer "$SEA_HOME" --url http://127.0.0.1 --no-service
assert_no_installer_temp "$SEA_HOME"
cp "$TEMP_DIR/sea-metadata.saved" "$SEA_METADATA"
chmod 600 "$SEA_METADATA"

write_agent_stub "$FIXTURE_SITE/downloads/$SEA_FILE" "$SEA_VERSION" changed
write_manifest "$SEA_VERSION" sea "$SEA_FILE"
expect_status 1 'immutable artifact mismatch' \
  run_installer "$SEA_HOME" --url http://127.0.0.1 --no-service
assert_no_installer_temp "$SEA_HOME"
test "$(sha256sum "$SEA_TARGET/agentfleet" | awk '{print $1}')" = "$FIRST_SEA_SHA"
test "$(readlink "$SEA_HOME/home/.local/bin/agentfleet")" = "$SEA_TARGET/agentfleet"

PORTABLE_HOME="$TEMP_DIR/portable-home"
PORTABLE_STAGE="$TEMP_DIR/portable-stage"
mkdir -p "$PORTABLE_HOME/home" "$PORTABLE_STAGE/agentfleet/lib"
PORTABLE_VERSION=2.3.4
PORTABLE_FILE="agentfleet-linux-x64-$PORTABLE_VERSION.tar.gz"
write_agent_stub "$PORTABLE_STAGE/agentfleet/agentfleet" "$PORTABLE_VERSION" first
printf '%s\n' first-payload > "$PORTABLE_STAGE/agentfleet/lib/payload.txt"
tar -czf "$FIXTURE_SITE/downloads/$PORTABLE_FILE" -C "$PORTABLE_STAGE" agentfleet
write_manifest "$PORTABLE_VERSION" portable "$PORTABLE_FILE"
FIRST_PORTABLE_SHA=$(sha256sum "$FIXTURE_SITE/downloads/$PORTABLE_FILE" | awk '{print $1}')
run_installer "$PORTABLE_HOME" --url http://127.0.0.1 --no-service >/dev/null
assert_no_installer_temp "$PORTABLE_HOME"
PORTABLE_TARGET="$PORTABLE_HOME/data/agentfleet/bin/$PORTABLE_VERSION"
PORTABLE_METADATA="$PORTABLE_TARGET/.artifact-metadata"
grep -qx "sha256=$FIRST_PORTABLE_SHA" "$PORTABLE_METADATA"
grep -qx 'format=portable' "$PORTABLE_METADATA"
run_installer "$PORTABLE_HOME" --url http://127.0.0.1 --no-service >/dev/null
assert_no_installer_temp "$PORTABLE_HOME"

# Keep the executable identical and change only another archive member. The
# installed-version guard must pin the source archive, not merely --version.
printf '%s\n' changed-payload > "$PORTABLE_STAGE/agentfleet/lib/payload.txt"
tar -czf "$FIXTURE_SITE/downloads/$PORTABLE_FILE" -C "$PORTABLE_STAGE" agentfleet
write_manifest "$PORTABLE_VERSION" portable "$PORTABLE_FILE"
expect_status 1 'immutable artifact mismatch' \
  run_installer "$PORTABLE_HOME" --url http://127.0.0.1 --no-service
assert_no_installer_temp "$PORTABLE_HOME"
test "$(cat "$PORTABLE_METADATA" | sed -n 's/^sha256=//p')" = "$FIRST_PORTABLE_SHA"

"$SCRIPT_DIR/install.sh" --self-test >/dev/null
echo "release and installer immutability tests passed"
