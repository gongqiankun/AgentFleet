#!/bin/sh
set -eu

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agentfleet-installer-ci.XXXXXX")
SERVER_PID=""
ROOT_CODEX_FIXTURE=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$(/usr/bin/id -u)" = "0" ]; then
    for MANAGED_LINK in /root/.local/bin/agentfleet /root/.local/bin/agentfleet.previous; do
      if [ -L "$MANAGED_LINK" ]; then
        case "$(readlink "$MANAGED_LINK")" in
          /root/.local/share/agentfleet/bin/9.8.7/agentfleet|/root/.local/share/agentfleet/bin/9.8.8/agentfleet)
            unlink "$MANAGED_LINK"
            ;;
        esac
      fi
    done
    rm -rf -- /root/.local/share/agentfleet/bin/9.8.7 /root/.local/share/agentfleet/bin/9.8.8
    rm -f -- /root/onboard-arguments
    if [ -n "$ROOT_CODEX_FIXTURE" ]; then rm -rf -- "$ROOT_CODEX_FIXTURE"; fi
  fi
  rm -rf -- "$TEMP_DIR"
}
trap cleanup EXIT HUP INT TERM

SITE_DIR="$TEMP_DIR/site"
HOME_DIR="$TEMP_DIR/home"
mkdir -p "$SITE_DIR/downloads" "$HOME_DIR"
ARTIFACT_NAME=agentfleet-linux-x64-9.8.7
ARTIFACT="$SITE_DIR/downloads/$ARTIFACT_NAME"
cat > "$ARTIFACT" <<'EOF'
#!/bin/sh
set -eu
if [ "${1:-}" = "--version" ]; then
  echo 9.8.7
  exit 0
fi
test "${1:-}" = onboard
shift
if [ "$(/usr/bin/id -u)" = "0" ]; then
  test "$HOME" = /root
  test "$XDG_DATA_HOME" = /root/.local/share
  test "$XDG_CONFIG_HOME" = /root/.config
  test "$CODEX_HOME" = /root/.codex
  test "$PATH" = /root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  test -z "${NODE_OPTIONS:-}"
fi
printf '%s\n' "$@" > "$HOME/onboard-arguments"
echo installer-smoke-ok
EOF
chmod 755 "$ARTIFACT"

SHA256=$(sha256sum "$ARTIFACT" | cut -d ' ' -f 1)
SIZE=$(wc -c < "$ARTIFACT" | tr -d ' ')
printf '{"schemaVersion":1,"version":"9.8.7","artifacts":{"linux-x64":{"file":"%s","sha256":"%s","size":%s,"format":"sea"}}}\n' \
  "$ARTIFACT_NAME" "$SHA256" "$SIZE" > "$SITE_DIR/downloads/manifest.json"

PORT_FILE="$TEMP_DIR/port"
node "$REPO_DIR/.github/scripts/static-server.mjs" "$SITE_DIR" "$PORT_FILE" &
SERVER_PID=$!
attempt=0
while [ ! -s "$PORT_FILE" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 100 ]; then
    echo "installer smoke server did not start" >&2
    exit 1
  fi
  sleep 0.05
done
PORT=$(tr -d '\r\n' < "$PORT_FILE")

# An install must not depend on Codex on PATH. Without an existing independent
# managed runtime, it downloads and verifies the bundled Codex runtime.
# Root additionally proves that a safe custom CODEX_HOME survives sanitization.
if [ "$(/usr/bin/id -u)" = "0" ]; then
  ROOT_CODEX_FIXTURE="/root/agentfleet-smoke-codex-$$"
  TEST_CODEX_HOME=$ROOT_CODEX_FIXTURE
else
  TEST_CODEX_HOME="$TEMP_DIR/untrusted-codex-home"
fi
mkdir -p "$TEMP_DIR/untrusted-bin" "$TEST_CODEX_HOME"
cat > "$TEMP_DIR/untrusted-bin/codex" <<'EOF'
#!/bin/sh
echo 'codex-cli 0.145.0'
EOF
chmod 755 "$TEMP_DIR/untrusted-bin/codex"

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
CODEX_FIXTURE_ARCHIVE="$SITE_DIR/downloads/codex-linux-x64-0.153.2.tar.gz"
tar -czf "$CODEX_FIXTURE_ARCHIVE" -C "$CODEX_FIXTURE_DIR" codex-x86_64-unknown-linux-musl
CODEX_FIXTURE_SHA256=$(sha256sum "$CODEX_FIXTURE_ARCHIVE" | cut -d ' ' -f 1)
CODEX_FIXTURE_SIZE=$(wc -c < "$CODEX_FIXTURE_ARCHIVE" | tr -d ' ')
CODEX_FIXTURE_SCHEMA_HASH=$(printf '{}\n' | sha256sum | cut -d ' ' -f 1)
printf 'ci-helper-not-executed\n' > "$SITE_DIR/downloads/codex-bwrap-linux-x64-0.153.4"
BWRAP_FIXTURE_SHA256=$(sha256sum "$SITE_DIR/downloads/codex-bwrap-linux-x64-0.153.4" | cut -d ' ' -f 1)
cp "$SITE_DIR/downloads/codex-bwrap-linux-x64-0.153.4" "$SITE_DIR/downloads/codex-bwrap-linux-x64-0.153.2"
printf '{"schemaVersion":1,"version":"0.153.2","artifacts":{"linux-x64":{"file":"codex-linux-x64-0.153.2.tar.gz","sha256":"%s","size":%s,"format":"tar.gz"}}}\n' \
  "$CODEX_FIXTURE_SHA256" "$CODEX_FIXTURE_SIZE" > "$SITE_DIR/downloads/codex-manifest.json"

OUTPUT=$(HOME="$HOME_DIR" XDG_DATA_HOME="$TEMP_DIR/data" XDG_CONFIG_HOME="$TEMP_DIR/config" \
  PATH="$TEMP_DIR/untrusted-bin:$PATH" \
  CODEX_HOME="$TEST_CODEX_HOME" \
  AGENTFLEET_INSTALLER_TEST_SCHEMA_HASH="$CODEX_FIXTURE_SCHEMA_HASH" \
  AGENTFLEET_INSTALLER_TEST_BWRAP_SHA256="$BWRAP_FIXTURE_SHA256" \
  NODE_OPTIONS="--require=$TEMP_DIR/untrusted.js" \
  sh "$REPO_DIR/packaging/install.sh" \
    --url "http://127.0.0.1:$PORT" \
    --ticket 'enrollment_ci.abcdefghijklmnop' \
    --name ci-host \
    --project "$REPO_DIR" \
    --no-service)
printf '%s\n' "$OUTPUT" | grep -q installer-smoke-ok
if [ "$(/usr/bin/id -u)" = "0" ]; then
  INSTALLED_HOME=/root
  INSTALLED_DATA=/root/.local/share
else
  INSTALLED_HOME=$HOME_DIR
  INSTALLED_DATA=$TEMP_DIR/data
fi
test -L "$INSTALLED_HOME/.local/bin/agentfleet"
test -x "$INSTALLED_DATA/agentfleet/bin/9.8.7/agentfleet"
test "$("$INSTALLED_DATA/agentfleet/codex/codex" --version)" = 'codex-cli 0.153.2'
test -x "$INSTALLED_DATA/agentfleet/codex/codex-resources/bwrap"
test "$(sha256sum "$INSTALLED_DATA/agentfleet/codex/codex-resources/bwrap" | cut -d ' ' -f 1)" = "$BWRAP_FIXTURE_SHA256"
printf '%s\n' "$OUTPUT" | grep -q 'Preparing the independent AgentFleet Codex runtime'
printf '%s\n' "$OUTPUT" | grep -q 'Prepared codex-cli 0.153.2'
grep -qx -- onboard "$INSTALLED_HOME/onboard-arguments" && {
  echo "installer failed to remove the onboard command before forwarding arguments" >&2
  exit 1
}
grep -qx -- '--ticket' "$INSTALLED_HOME/onboard-arguments"
grep -qx -- 'enrollment_ci.abcdefghijklmnop' "$INSTALLED_HOME/onboard-arguments"
grep -qx -- '--no-service' "$INSTALLED_HOME/onboard-arguments"

STAGED_VERSION=9.8.8
STAGED_ARTIFACT_NAME="agentfleet-linux-x64-$STAGED_VERSION"
STAGED_ARTIFACT="$SITE_DIR/downloads/$STAGED_ARTIFACT_NAME"
cat > "$STAGED_ARTIFACT" <<EOF
#!/bin/sh
test "\${1:-}" = --version
echo '$STAGED_VERSION'
EOF
chmod 755 "$STAGED_ARTIFACT"
STAGED_SHA256=$(sha256sum "$STAGED_ARTIFACT" | cut -d ' ' -f 1)
STAGED_SIZE=$(wc -c < "$STAGED_ARTIFACT" | tr -d ' ')
printf '{"schemaVersion":1,"version":"%s","artifacts":{"linux-x64":{"file":"%s","sha256":"%s","size":%s,"format":"sea"}}}\n' \
  "$STAGED_VERSION" "$STAGED_ARTIFACT_NAME" "$STAGED_SHA256" "$STAGED_SIZE" > "$SITE_DIR/downloads/manifest.json"
HOME="$HOME_DIR" XDG_DATA_HOME="$TEMP_DIR/data" XDG_CONFIG_HOME="$TEMP_DIR/config" \
  PATH="$TEMP_DIR/untrusted-bin:$PATH" \
  CODEX_HOME="$TEST_CODEX_HOME" \
  AGENTFLEET_INSTALLER_TEST_SCHEMA_HASH="$CODEX_FIXTURE_SCHEMA_HASH" \
  AGENTFLEET_INSTALLER_TEST_BWRAP_SHA256="$BWRAP_FIXTURE_SHA256" \
  sh "$REPO_DIR/packaging/install.sh" \
    --stage-only \
    --url "http://127.0.0.1:$PORT" \
    --data-dir "$INSTALLED_DATA/agentfleet" >/dev/null
test "$(readlink "$INSTALLED_HOME/.local/bin/agentfleet")" = "$INSTALLED_DATA/agentfleet/bin/$STAGED_VERSION/agentfleet"
test "$(readlink "$INSTALLED_HOME/.local/bin/agentfleet.previous")" = "$INSTALLED_DATA/agentfleet/bin/9.8.7/agentfleet"

if sh "$REPO_DIR/packaging/install.sh" --url http://example.invalid >/dev/null 2>"$TEMP_DIR/http-error"; then
  echo "installer accepted non-loopback HTTP" >&2
  exit 1
fi
grep -q -- '--url must use HTTPS' "$TEMP_DIR/http-error"
