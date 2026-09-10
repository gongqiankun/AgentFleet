#!/bin/sh
set -eu

MODE=onboard
case "${1:-}" in
  --update-only) MODE=update; shift ;;
  --stage-only) MODE=stage; shift ;;
  --rollback) MODE=rollback; shift ;;
  --uninstall) MODE=uninstall; shift ;;
esac

: "${HOME:?installer: HOME is required}"
case "$HOME" in /*) ;; *) echo "installer: HOME must be absolute" >&2; exit 2 ;; esac
DATA_ROOT="$HOME/Library/Application Support/AgentFleet"
BIN_ROOT="$HOME/.local/share/agentfleet/bin"
USER_BIN="$HOME/.local/bin"
CURRENT_LINK="$USER_BIN/agentfleet"
PREVIOUS_LINK="$USER_BIN/agentfleet.previous"
RUNTIME_PROFILE="$DATA_ROOT/runtime-profile.json"

if [ "$MODE" = rollback ]; then
  [ -L "$CURRENT_LINK" ] && [ -x "$CURRENT_LINK" ] || { echo "installer: no managed installation to roll back" >&2; exit 1; }
  exec "$CURRENT_LINK" service rollback --data-dir "$DATA_ROOT"
fi

if [ "$MODE" = uninstall ]; then
  PURGE=no
  for value in "$@"; do case "$value" in --purge) PURGE=yes ;; *) echo "installer: unknown uninstall option: $value" >&2; exit 2 ;; esac; done
  if [ -x "$CURRENT_LINK" ]; then "$CURRENT_LINK" service uninstall || true; fi
  rm -f -- "$CURRENT_LINK" "$PREVIOUS_LINK"
  rm -rf -- "$BIN_ROOT"
  if [ "$PURGE" = yes ]; then rm -rf -- "$DATA_ROOT"; fi
  echo "Removed AgentFleet. Codex history and project files were not changed."
  exit 0
fi

CONTROL_URL=""
EXPECT_URL=no
for value in "$@"; do
  if [ "$EXPECT_URL" = yes ]; then CONTROL_URL=$value; EXPECT_URL=no; continue; fi
  case "$value" in --url) EXPECT_URL=yes ;; --url=*) CONTROL_URL=${value#--url=} ;; esac
done
if [ "$EXPECT_URL" = yes ] || [ -z "$CONTROL_URL" ]; then echo "installer: --url is required" >&2; exit 2; fi
case "$CONTROL_URL" in *\?*|*\#*|*@*) echo "installer: --url must not contain credentials, query, or fragment" >&2; exit 2 ;; esac
case "$CONTROL_URL" in
  https://*) ;;
  http://localhost|http://localhost:*|http://localhost/*|http://127.0.0.1|http://127.0.0.1:*|http://127.0.0.1/*) ;;
  *) echo "installer: --url must use HTTPS" >&2; exit 2 ;;
esac
CONTROL_URL=${CONTROL_URL%/}
case "$(uname -m)" in arm64) PLATFORM=darwin-arm64; CODEX_NAME=codex-aarch64-apple-darwin ;; x86_64) PLATFORM=darwin-x64; CODEX_NAME=codex-x86_64-apple-darwin ;; *) echo "installer: unsupported macOS architecture" >&2; exit 1 ;; esac

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agentfleet-install.XXXXXX")
trap 'rm -rf -- "$TEMP_DIR"' EXIT HUP INT TERM
mkdir -p "$DATA_ROOT"
chmod 700 "$DATA_ROOT"
[ ! -L "$DATA_ROOT" ] && [ ! -L "$RUNTIME_PROFILE" ] || { echo "installer: refusing a symlinked runtime profile" >&2; exit 1; }
PROFILE_EXISTED=no
CODEX_EXISTED=no
if [ -f "$RUNTIME_PROFILE" ] && [ ! -L "$RUNTIME_PROFILE" ]; then
  cp "$RUNTIME_PROFILE" "$TEMP_DIR/runtime-profile.previous"
  PROFILE_EXISTED=yes
  PROFILE_COMPACT=$(tr -d '\r\n' < "$RUNTIME_PROFILE")
  EXISTING_CODEX_EXECUTABLE=$(printf '%s' "$PROFILE_COMPACT" | sed -n 's/.*"codexExecutable":"\([^"\\]*\)".*/\1/p')
  EXISTING_CODEX_HOME=$(printf '%s' "$PROFILE_COMPACT" | sed -n 's/.*"codexHome":"\([^"\\]*\)".*/\1/p')
  EXISTING_CODEX_SOURCE=$(printf '%s' "$PROFILE_COMPACT" | sed -n 's/.*"source":"\(host\|managed\)".*/\1/p')
fi
if [ -f "$DATA_ROOT/codex/codex" ] && [ ! -L "$DATA_ROOT/codex/codex" ]; then cp "$DATA_ROOT/codex/codex" "$TEMP_DIR/codex.previous"; CODEX_EXISTED=yes; fi
download() { curl -fLsS --proto '=https' --tlsv1.2 "$1" -o "$2"; }
field() { printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"; }

MANIFEST="$TEMP_DIR/manifest.json"
download "$CONTROL_URL/downloads/manifest.json" "$MANIFEST"
COMPACT=$(tr -d '\r\n' < "$MANIFEST")
VERSION=$(field "$COMPACT" version)
BLOCK=$(printf '%s' "$COMPACT" | sed -n "s/.*\"$PLATFORM\":{\(\"file\":\"codex-$PLATFORM-[^}]*\)}.*/\1/p")
FILE=$(field "$BLOCK" file); SHA256=$(field "$BLOCK" sha256)
SIZE=$(printf '%s' "$BLOCK" | sed -n 's/.*"size":\([0-9]*\).*/\1/p')
case "$FILE" in "agentfleet-$PLATFORM-$VERSION.tar.gz") ;; *) echo "installer: invalid macOS release manifest" >&2; exit 1 ;; esac
test "${#SHA256}" -eq 64 && test -n "$SIZE" || { echo "installer: invalid release digest" >&2; exit 1; }
ARTIFACT="$TEMP_DIR/$FILE"
download "$CONTROL_URL/downloads/$FILE" "$ARTIFACT"
test "$(wc -c < "$ARTIFACT" | tr -d ' ')" = "$SIZE" || { echo "installer: release size mismatch" >&2; exit 1; }
test "$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')" = "$SHA256" || { echo "installer: release SHA-256 mismatch" >&2; exit 1; }
tar -tzf "$ARTIFACT" | awk '{ if ($0 !~ /^agentfleet\// || $0 ~ /(^|\/)\.\.?(\/|$)/) bad=1 } END { exit bad ? 1 : 0 }' || { echo "installer: unsafe release archive" >&2; exit 1; }
tar -tvzf "$ARTIFACT" | awk 'substr($1,1,1) != "-" && substr($1,1,1) != "d" { bad=1 } END { exit bad ? 1 : 0 }' || { echo "installer: release archive contains a link or special file" >&2; exit 1; }

TARGET="$BIN_ROOT/$VERSION"
mkdir -p "$BIN_ROOT" "$USER_BIN"
if [ ! -d "$TARGET" ]; then
  STAGE="$BIN_ROOT/.staging-$VERSION-$$"
  mkdir "$STAGE"
  tar -xzf "$ARTIFACT" -C "$STAGE" --strip-components=1
  test "$("$STAGE/agentfleet" --version)" = "$VERSION" || { echo "installer: release version mismatch" >&2; exit 1; }
  mv "$STAGE" "$TARGET"
else
  [ ! -L "$TARGET" ] && [ -f "$TARGET/agentfleet" ] && [ ! -L "$TARGET/agentfleet" ] && [ -x "$TARGET/agentfleet" ] && [ "$("$TARGET/agentfleet" --version)" = "$VERSION" ] || { echo "installer: existing release directory is invalid" >&2; exit 1; }
fi
OLD_TARGET=""
if [ -L "$CURRENT_LINK" ]; then OLD_TARGET=$(readlink "$CURRENT_LINK"); fi
HOST_CODEX=${EXISTING_CODEX_EXECUTABLE:-}
HOST_CODEX_VERSION=""
if [ -n "$HOST_CODEX" ] && [ "${EXISTING_CODEX_SOURCE:-}" = managed ]; then
  HOST_CODEX_VERSION=$("$TARGET/runtime/node" "$TARGET/lib/dist/src/verify-managed-runtime.js" "$HOST_CODEX" "$DATA_ROOT/codex" || true)
fi
if [ -n "$HOST_CODEX_VERSION" ] && awk -v version="$HOST_CODEX_VERSION" 'BEGIN { split(version,v,"."); exit !((v[1]+0)>0 || (v[2]+0)>153 || ((v[2]+0)==153 && (v[3]+0)>=2)) }'; then
  AGENTFLEET_CODEX_EXECUTABLE=$HOST_CODEX
  CODEX_VERSION=$HOST_CODEX_VERSION
  CODEX_SOURCE=managed
  echo "Reusing verified AgentFleet Codex $CODEX_VERSION. Your own Codex and session data remain unchanged."
else
  CODEX_MANIFEST="$TEMP_DIR/codex-manifest.json"
  download "$CONTROL_URL/downloads/codex-manifest.json" "$CODEX_MANIFEST"
  CODEX_COMPACT=$(tr -d '\r\n' < "$CODEX_MANIFEST")
  CODEX_VERSION=$(field "$CODEX_COMPACT" version)
  CODEX_BLOCK=$(printf '%s' "$CODEX_COMPACT" | sed -n "s/.*\"$PLATFORM\":{\(\"file\":\"codex-$PLATFORM-[^}]*\)}.*/\1/p")
  CODEX_FILE=$(field "$CODEX_BLOCK" file); CODEX_SHA=$(field "$CODEX_BLOCK" sha256)
  CODEX_SIZE=$(printf '%s' "$CODEX_BLOCK" | sed -n 's/.*"size":\([0-9]*\).*/\1/p')
  case "$CODEX_FILE" in "codex-$PLATFORM-$CODEX_VERSION.tar.gz") ;; *) echo "installer: invalid Codex manifest" >&2; exit 1 ;; esac
  CODEX_ARCHIVE="$TEMP_DIR/$CODEX_FILE"
  download "$CONTROL_URL/downloads/$CODEX_FILE" "$CODEX_ARCHIVE"
  test "$(wc -c < "$CODEX_ARCHIVE" | tr -d ' ')" = "$CODEX_SIZE" || { echo "installer: Codex size mismatch" >&2; exit 1; }
  test "$(shasum -a 256 "$CODEX_ARCHIVE" | awk '{print $1}')" = "$CODEX_SHA" || { echo "installer: Codex SHA-256 mismatch" >&2; exit 1; }
  mkdir -p "$DATA_ROOT/codex" "$TEMP_DIR/codex"
  tar -xzf "$CODEX_ARCHIVE" -C "$TEMP_DIR/codex"
  test -f "$TEMP_DIR/codex/$CODEX_NAME" || { echo "installer: invalid Codex archive" >&2; exit 1; }
  cp "$TEMP_DIR/codex/$CODEX_NAME" "$DATA_ROOT/codex/codex.new"
  chmod 755 "$DATA_ROOT/codex/codex.new"
  mv -f "$DATA_ROOT/codex/codex.new" "$DATA_ROOT/codex/codex"
  AGENTFLEET_CODEX_EXECUTABLE="$DATA_ROOT/codex/codex"
  CODEX_SOURCE=managed
fi
export AGENTFLEET_CODEX_EXECUTABLE

escape_json() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
PROFILE_EXECUTABLE=$(escape_json "$AGENTFLEET_CODEX_EXECUTABLE")
PROFILE_HOME=$(escape_json "${EXISTING_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}")
(umask 077; printf '{"schemaVersion":1,"codexExecutable":"%s","codexHome":"%s","source":"%s"}\n' \
  "$PROFILE_EXECUTABLE" "$PROFILE_HOME" "$CODEX_SOURCE" > "$RUNTIME_PROFILE.new")
mv -f "$RUNTIME_PROFILE.new" "$RUNTIME_PROFILE"

if [ -n "$OLD_TARGET" ] && [ "$OLD_TARGET" != "$TARGET/agentfleet" ]; then ln -sfn "$OLD_TARGET" "$PREVIOUS_LINK"; fi
ln -sfn "$TARGET/agentfleet" "$CURRENT_LINK"

echo "Installed AgentFleet $VERSION with Codex $CODEX_VERSION."
if [ "$MODE" = update ]; then
  if "$CURRENT_LINK" service update --executable "$CURRENT_LINK" --data-dir "$DATA_ROOT"; then exit 0; fi
  echo "installer: service update failed; restoring the previous binary" >&2
  if [ "$PROFILE_EXISTED" = yes ]; then cp "$TEMP_DIR/runtime-profile.previous" "$RUNTIME_PROFILE"; else rm -f "$RUNTIME_PROFILE"; fi
  if [ "$CODEX_EXISTED" = yes ]; then cp "$TEMP_DIR/codex.previous" "$DATA_ROOT/codex/codex"; chmod 755 "$DATA_ROOT/codex/codex"; fi
  if [ -n "$OLD_TARGET" ]; then ln -sfn "$OLD_TARGET" "$CURRENT_LINK"; "$CURRENT_LINK" service update --executable "$CURRENT_LINK" --data-dir "$DATA_ROOT" || true; fi
  exit 1
fi
if [ "$MODE" = stage ]; then echo "Staged AgentFleet $VERSION; launchd will restart into it."; exit 0; fi
exec "$CURRENT_LINK" onboard "$@" --data-dir "$DATA_ROOT" --executable "$CURRENT_LINK"
