#!/bin/sh
set -eu

MODE=onboard
case "${1:-}" in
  --update-only) MODE=update; shift ;;
  --stage-only) MODE=stage; shift ;;
  --rollback) MODE=rollback; shift ;;
  --uninstall) MODE=uninstall; shift ;;
  --self-test) MODE=self-test; shift ;;
esac

validate_archive_list() {
  awk '
    BEGIN { bad=0 }
    {
      path=$0
      if (path ~ /^\// || (path != "agentfleet" && path !~ /^agentfleet\//)) bad=1
      count=split(path, component, "/")
      for (i=1; i<=count; i++) {
        if (component[i] == ".." || component[i] == ".") bad=1
      }
    }
    END { exit bad ? 1 : 0 }
  ' "$1"
}

artifact_metadata_record() {
  printf '%s\n' \
    agentfleet-artifact-v1 \
    "file=$1" \
    "format=$2" \
    "sha256=$3" \
    "size=$4"
}

if [ "$MODE" = "self-test" ]; then
  SELF_TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agentfleet-installer-test.XXXXXX")
  trap 'rm -rf -- "$SELF_TEST_DIR"' EXIT HUP INT TERM
  printf '%s\n' agentfleet agentfleet/agentfleet agentfleet/runtime/node > "$SELF_TEST_DIR/safe"
  validate_archive_list "$SELF_TEST_DIR/safe"
  printf '%s\n' agentfleet/../outside > "$SELF_TEST_DIR/unsafe"
  if validate_archive_list "$SELF_TEST_DIR/unsafe"; then
    echo "installer self-test: traversal was accepted" >&2
    exit 1
  fi
  FIXTURE='{"schemaVersion":1,"version":"1.2.3","artifacts":{"linux-x64":{"file":"agentfleet-linux-x64-1.2.3","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":123,"format":"sea"}}}'
  FIXTURE_VERSION=$(printf '%s' "$FIXTURE" | sed -n 's/.*"version":"\([0-9A-Za-z.+-]*\)".*/\1/p')
  FIXTURE_FILE=$(printf '%s' "$FIXTURE" | sed -n 's/.*"file":"\([A-Za-z0-9.+-]*\)".*/\1/p')
  if [ "$FIXTURE_VERSION" != "1.2.3" ] || [ "$FIXTURE_FILE" != "agentfleet-linux-x64-1.2.3" ]; then
    echo "installer self-test: manifest fields were not parsed" >&2
    exit 1
  fi
  FIXTURE_METADATA=$(artifact_metadata_record \
    agentfleet-linux-x64-1.2.3 sea \
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 123)
  if [ "$FIXTURE_METADATA" != "$(printf '%s\n' agentfleet-artifact-v1 file=agentfleet-linux-x64-1.2.3 format=sea sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa size=123)" ]; then
    echo "installer self-test: immutable artifact metadata was not canonical" >&2
    exit 1
  fi
  echo "installer self-test passed"
  exit 0
fi

INHERITED_INSTALL_PATH=${PATH:-}
INHERITED_CODEX_HOME=${CODEX_HOME:-}
INHERITED_CODEX_EXECUTABLE=${AGENTFLEET_CODEX_EXECUTABLE:-}
INSTALL_UID=$(/usr/bin/id -u)
if [ "$INSTALL_UID" = "0" ]; then
  HOME=/root
  XDG_DATA_HOME=/root/.local/share
  XDG_CONFIG_HOME=/root/.config
  CODEX_HOME=/root/.codex
  PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  TMPDIR=/tmp
  unset AGENTFLEET_HOME AGENTFLEET_CODEX_SCHEMA_HASH AGENTFLEET_SYSTEMD_UNIT_DIR \
    AGENTFLEET_CODEX_EXECUTABLE NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH \
    XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS
  export HOME XDG_DATA_HOME XDG_CONFIG_HOME CODEX_HOME PATH TMPDIR
else
  : "${HOME:?installer: HOME is required}"
  case "$HOME" in
    /*) ;;
    *) echo "installer: HOME must be absolute" >&2; exit 2 ;;
  esac
fi
DATA_ROOT=${XDG_DATA_HOME:-"$HOME/.local/share"}
case "$DATA_ROOT" in
  /*) ;;
  *) echo "installer: XDG_DATA_HOME must be absolute" >&2; exit 2 ;;
esac
if [ "$DATA_ROOT" = "/" ]; then
  echo "installer: refusing unsafe XDG_DATA_HOME" >&2
  exit 2
fi
case "$HOME/" in */../*|*/./*) echo "installer: HOME must not contain dot path components" >&2; exit 2 ;; esac
case "$DATA_ROOT/" in */../*|*/./*) echo "installer: XDG_DATA_HOME must not contain dot path components" >&2; exit 2 ;; esac
BIN_ROOT="$DATA_ROOT/agentfleet/bin"
CODEX_CACHE_DIR="$DATA_ROOT/agentfleet/codex"
CODEX_CACHE_EXECUTABLE="$CODEX_CACHE_DIR/codex"
USER_BIN="$HOME/.local/bin"
CURRENT_LINK="$USER_BIN/agentfleet"
PREVIOUS_LINK="$USER_BIN/agentfleet.previous"
MANAGED_MARKER="$BIN_ROOT/.managed-by-agentfleet"
INSTALL_LOCK="$DATA_ROOT/agentfleet/.installer-lock"
INSTALL_LOCK_ACQUIRED=no
TEMP_DIR=""
STAGED_TARGET=""
CODEX_TEMP=""
ACTIVATION_PENDING=no
PROFILE_TARGET=""
PROFILE_EXISTED=no
CODEX_EXISTED=no
HELPER_EXISTED=no
SELECTED_CODEX_SOURCE_KIND=managed
release_install_lock() {
  if [ "$INSTALL_LOCK_ACQUIRED" = yes ]; then
    rmdir -- "$INSTALL_LOCK" 2>/dev/null || true
    INSTALL_LOCK_ACQUIRED=no
  fi
}
cleanup() {
  CLEANUP_STATUS=$?
  if [ "$CLEANUP_STATUS" -ne 0 ] && [ "$ACTIVATION_PENDING" = yes ]; then
    # Downloads and runtime setup are part of activation, not a successful
    # installation on their own. Restore the previous local configuration too.
    if [ -n "${OLD_TARGET:-}" ]; then atomic_link "$CURRENT_LINK" "$OLD_TARGET"; fi
    if [ "$PROFILE_EXISTED" = yes ]; then
      cp "$TEMP_DIR/runtime-profile.previous" "$PROFILE_TARGET"
      chmod 600 "$PROFILE_TARGET"
    elif [ -n "$PROFILE_TARGET" ]; then
      rm -f -- "$PROFILE_TARGET"
    fi
    if [ "$CODEX_EXISTED" = yes ]; then
      cp "$TEMP_DIR/codex.previous" "$CODEX_CACHE_EXECUTABLE.restore-$$"
      chmod 755 "$CODEX_CACHE_EXECUTABLE.restore-$$"
      mv -f "$CODEX_CACHE_EXECUTABLE.restore-$$" "$CODEX_CACHE_EXECUTABLE"
    fi
    if [ "$HELPER_EXISTED" = yes ]; then
      cp "$TEMP_DIR/bwrap.previous" "$CODEX_CACHE_DIR/codex-resources/.bwrap-restore-$$"
      chmod 755 "$CODEX_CACHE_DIR/codex-resources/.bwrap-restore-$$"
      mv -f "$CODEX_CACHE_DIR/codex-resources/.bwrap-restore-$$" "$CODEX_CACHE_DIR/codex-resources/bwrap"
    fi
  fi
  if [ -n "$TEMP_DIR" ]; then
    rm -rf -- "$TEMP_DIR"
    TEMP_DIR=""
  fi
  if [ -n "$STAGED_TARGET" ]; then
    rm -rf -- "$STAGED_TARGET"
    STAGED_TARGET=""
  fi
  if [ -n "$CODEX_TEMP" ]; then
    rm -f -- "$CODEX_TEMP"
    CODEX_TEMP=""
  fi
  release_install_lock
}
acquire_install_lock() {
  mkdir -p "$DATA_ROOT/agentfleet"
  if ! mkdir "$INSTALL_LOCK"; then
    echo "installer: another AgentFleet install/update/rollback/uninstall is already running" >&2
    exit 1
  fi
  INSTALL_LOCK_ACQUIRED=yes
}
prepare_managed_sandbox_helper() {
  HELPER_DIR="$CODEX_CACHE_DIR/codex-resources"
  HELPER_TARGET="$HELPER_DIR/bwrap"
  if [ -L "$HELPER_DIR" ] || [ -L "$HELPER_TARGET" ] || { [ -e "$HELPER_DIR" ] && [ ! -d "$HELPER_DIR" ]; }; then
    echo "installer: refusing an unsafe managed sandbox helper path" >&2
    exit 1
  fi
  mkdir -p "$HELPER_DIR"
  chmod 700 "$HELPER_DIR"
  if [ -f "$HELPER_TARGET" ] && [ "$(sha256sum "$HELPER_TARGET" | awk '{print $1}')" = "$CODEX_BWRAP_SHA256" ]; then
    chmod 755 "$HELPER_TARGET"
    return 0
  fi
  if [ -n "${EXISTING_HELPER_SOURCE:-}" ]; then
    cp -- "$EXISTING_HELPER_SOURCE" "$TEMP_DIR/bwrap.download"
  else
    download "$CONTROL_URL/downloads/codex-bwrap-linux-x64-${CODEX_BWRAP_VERSION:-0.153.4}" "$TEMP_DIR/bwrap.download"
  fi
  if [ "$(sha256sum "$TEMP_DIR/bwrap.download" | awk '{print $1}')" != "$CODEX_BWRAP_SHA256" ]; then
    echo "installer: managed sandbox helper SHA-256 verification failed" >&2
    exit 1
  fi
  CODEX_TEMP="$HELPER_DIR/.bwrap-$$"
  if [ -e "$CODEX_TEMP" ] || [ -L "$CODEX_TEMP" ]; then
    echo "installer: temporary sandbox helper path already exists" >&2
    exit 1
  fi
  cp -- "$TEMP_DIR/bwrap.download" "$CODEX_TEMP"
  if [ "$INSTALL_UID" = "0" ]; then chown 0:0 "$CODEX_TEMP"; fi
  chmod 755 "$CODEX_TEMP"
  mv -f "$CODEX_TEMP" "$HELPER_TARGET"
  CODEX_TEMP=""
}
prepare_managed_codex() {
  if [ -L "$CODEX_CACHE_DIR" ] || { [ -e "$CODEX_CACHE_DIR" ] && [ ! -d "$CODEX_CACHE_DIR" ]; }; then
    echo "installer: refusing an unsafe managed Codex directory" >&2
    exit 1
  fi
  mkdir -p "$CODEX_CACHE_DIR"
  chmod 700 "$CODEX_CACHE_DIR"

  BEST_COMPATIBLE_VERSION=""
  BEST_COMPATIBLE_COPY=""
  BEST_COMPATIBLE_SOURCE=""
  BEST_FALLBACK_VERSION=""
  BEST_FALLBACK_COPY=""
  BEST_FALLBACK_SOURCE=""

  version_is_newer() {
    CANDIDATE_VERSION=$1
    CURRENT_VERSION=$2
    [ -z "$CURRENT_VERSION" ] || \
      [ "$(printf '%s\n%s\n' "$CURRENT_VERSION" "$CANDIDATE_VERSION" | sort -V | tail -n 1)" = "$CANDIDATE_VERSION" ]
  }

  version_is_at_least() {
    VERSION_TO_CHECK=$1
    MINIMUM_VERSION=$2
    [ "$VERSION_TO_CHECK" = "$MINIMUM_VERSION" ] || version_is_newer "$VERSION_TO_CHECK" "$MINIMUM_VERSION"
  }

  root_path_is_safe() {
    ROOT_PATH_COMPONENT=$1
    while :; do
      [ "$(stat -c %u "$ROOT_PATH_COMPONENT" 2>/dev/null || printf invalid)" = "0" ] || return 1
      if find "$ROOT_PATH_COMPONENT" -maxdepth 0 -perm /022 -print -quit | grep -q .; then return 1; fi
      [ "$ROOT_PATH_COMPONENT" = "/" ] && return 0
      ROOT_PATH_COMPONENT=$(dirname "$ROOT_PATH_COMPONENT")
    done
  }

  consider_codex_candidate() {
    CODEX_COMMAND=$1
    CODEX_SOURCE=$(readlink -f -- "$CODEX_COMMAND" 2>/dev/null || true)
    # Only reuse our isolated runtime, never a PATH/NVM/npm executable.
    case "$CODEX_SOURCE" in "$CODEX_CACHE_DIR"/*) ;; *) return 0 ;; esac
    if [ -z "$CODEX_SOURCE" ] || [ ! -f "$CODEX_SOURCE" ] || [ -L "$CODEX_SOURCE" ] || [ ! -x "$CODEX_SOURCE" ]; then
      return 0
    fi
    if find "$CODEX_SOURCE" -maxdepth 0 -perm /022 -print -quit | grep -q .; then
      return 0
    fi
    if [ "$INSTALL_UID" = "0" ] && ! root_path_is_safe "$CODEX_SOURCE"; then
      return 0
    fi

    CODEX_TEMP="$CODEX_CACHE_DIR/.candidate-$$"
    rm -f -- "$CODEX_TEMP"
    cp -- "$CODEX_SOURCE" "$CODEX_TEMP"
    chmod 700 "$CODEX_TEMP"
    CODEX_VERSION_OUTPUT=$(timeout 5s "$CODEX_TEMP" --version 2>/dev/null || true)
    CODEX_VERSION=$(printf '%s\n' "$CODEX_VERSION_OUTPUT" | sed -n 's/^codex-cli \([^[:space:]]*\)$/\1/p')
    if [ -z "$CODEX_VERSION" ]; then
      rm -f -- "$CODEX_TEMP"
      CODEX_TEMP=""
      return 0
    fi

    if version_is_newer "$CODEX_VERSION" "$BEST_FALLBACK_VERSION"; then
      BEST_FALLBACK_COPY="$TEMP_DIR/codex-fallback"
      cp -- "$CODEX_TEMP" "$BEST_FALLBACK_COPY"
      BEST_FALLBACK_VERSION=$CODEX_VERSION
      BEST_FALLBACK_SOURCE=$CODEX_SOURCE
    fi
    CODEX_SCHEMA_DIR="$TEMP_DIR/codex-schema-$$"
    rm -rf -- "$CODEX_SCHEMA_DIR"
    mkdir "$CODEX_SCHEMA_DIR"
    CODEX_SCHEMA_HASH=""
    if timeout 20s "$CODEX_TEMP" app-server generate-json-schema --out "$CODEX_SCHEMA_DIR" >/dev/null 2>&1 && \
      [ -f "$CODEX_SCHEMA_DIR/codex_app_server_protocol.v2.schemas.json" ]; then
      CODEX_SCHEMA_HASH=$(sha256sum "$CODEX_SCHEMA_DIR/codex_app_server_protocol.v2.schemas.json" | awk '{print $1}')
    fi
    rm -rf -- "$CODEX_SCHEMA_DIR"
    if printf '%s\n' "$CODEX_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' && \
      version_is_at_least "$CODEX_VERSION" "0.153.2" && \
      [ "$CODEX_SCHEMA_HASH" = "$CODEX_COMPAT_SCHEMA_HASH" ] && \
      version_is_newer "$CODEX_VERSION" "$BEST_COMPATIBLE_VERSION"; then
      BEST_COMPATIBLE_COPY="$TEMP_DIR/codex-compatible"
      cp -- "$CODEX_TEMP" "$BEST_COMPATIBLE_COPY"
      BEST_COMPATIBLE_VERSION=$CODEX_VERSION
      BEST_COMPATIBLE_SOURCE=$CODEX_SOURCE
    fi
    rm -f -- "$CODEX_TEMP"
    CODEX_TEMP=""
  }

  if [ -x "$CODEX_CACHE_EXECUTABLE" ]; then
    consider_codex_candidate "$CODEX_CACHE_EXECUTABLE"
  fi
  if [ -n "${EXISTING_PROFILE_CODEX_EXECUTABLE:-}" ]; then
    consider_codex_candidate "$EXISTING_PROFILE_CODEX_EXECUTABLE"
  fi

  if [ -z "$BEST_COMPATIBLE_COPY" ]; then
    echo "Preparing the independent AgentFleet Codex runtime. Your own Codex installation and session data will not be replaced."
    BUNDLED_CODEX_MANIFEST="$TEMP_DIR/codex-manifest.json"
    download "$CONTROL_URL/downloads/codex-manifest.json" "$BUNDLED_CODEX_MANIFEST"
    BUNDLED_COMPACT=$(tr -d '\r\n' < "$BUNDLED_CODEX_MANIFEST")
    BUNDLED_SCHEMA_VERSION=$(printf '%s' "$BUNDLED_COMPACT" | sed -n 's/.*"schemaVersion":\([0-9]*\).*/\1/p')
    BUNDLED_VERSION=$(printf '%s' "$BUNDLED_COMPACT" | sed -n 's/.*"version":"\([0-9.]*\)".*/\1/p')
    BUNDLED_BLOCK=$(printf '%s' "$BUNDLED_COMPACT" | sed -n 's/.*"linux-x64":{\([^}]*\)}.*/\1/p')
    BUNDLED_FILE=$(printf '%s' "$BUNDLED_BLOCK" | sed -n 's/.*"file":"\([A-Za-z0-9.+-]*\)".*/\1/p')
    BUNDLED_SHA256=$(printf '%s' "$BUNDLED_BLOCK" | sed -n 's/.*"sha256":"\([0-9a-f]*\)".*/\1/p')
    BUNDLED_SIZE=$(printf '%s' "$BUNDLED_BLOCK" | sed -n 's/.*"size":\([0-9]*\).*/\1/p')
    BUNDLED_FORMAT=$(printf '%s' "$BUNDLED_BLOCK" | sed -n 's/.*"format":"\([A-Za-z0-9.]*\)".*/\1/p')
    if [ "$BUNDLED_SCHEMA_VERSION" != "1" ] || \
      ! printf '%s\n' "$BUNDLED_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || \
      [ "$BUNDLED_FILE" != "codex-linux-x64-$BUNDLED_VERSION.tar.gz" ] || [ "${#BUNDLED_SHA256}" -ne 64 ] || \
      [ -z "$BUNDLED_SIZE" ] || [ "$BUNDLED_FORMAT" != "tar.gz" ]; then
      echo "installer: bundled Codex manifest is invalid" >&2
      exit 1
    fi
    BUNDLED_ARCHIVE="$TEMP_DIR/$BUNDLED_FILE"
    download "$CONTROL_URL/downloads/$BUNDLED_FILE" "$BUNDLED_ARCHIVE"
    BUNDLED_ACTUAL_SIZE=$(wc -c < "$BUNDLED_ARCHIVE" | tr -d ' ')
    if [ "$BUNDLED_ACTUAL_SIZE" != "$BUNDLED_SIZE" ]; then
      echo "installer: bundled Codex size does not match its manifest" >&2
      exit 1
    fi
    printf '%s  %s\n' "$BUNDLED_SHA256" "$BUNDLED_ARCHIVE" | sha256sum -c - >/dev/null
    BUNDLED_ARCHIVE_LIST="$TEMP_DIR/codex-archive-list"
    tar -tzf "$BUNDLED_ARCHIVE" > "$BUNDLED_ARCHIVE_LIST"
    if [ "$(wc -l < "$BUNDLED_ARCHIVE_LIST" | tr -d ' ')" != "1" ] || \
      [ "$(sed -n '1p' "$BUNDLED_ARCHIVE_LIST")" != "codex-x86_64-unknown-linux-musl" ]; then
      echo "installer: bundled Codex archive layout is invalid" >&2
      exit 1
    fi
    if ! tar -tvzf "$BUNDLED_ARCHIVE" | awk 'NR == 1 && substr($1,1,1) == "-" { ok=1 } END { exit ok ? 0 : 1 }'; then
      echo "installer: bundled Codex archive contains an invalid file type" >&2
      exit 1
    fi
    BUNDLED_EXTRACT_DIR="$TEMP_DIR/codex-extract"
    mkdir "$BUNDLED_EXTRACT_DIR"
    tar -xzf "$BUNDLED_ARCHIVE" -C "$BUNDLED_EXTRACT_DIR" --no-same-owner --no-same-permissions
    BUNDLED_SAFE_CANDIDATE="$CODEX_CACHE_DIR/.bundled-candidate-$$"
    cp -- "$BUNDLED_EXTRACT_DIR/codex-x86_64-unknown-linux-musl" "$BUNDLED_SAFE_CANDIDATE"
    if [ "$INSTALL_UID" = "0" ]; then chown 0:0 "$BUNDLED_SAFE_CANDIDATE"; fi
    chmod 700 "$BUNDLED_SAFE_CANDIDATE"
    consider_codex_candidate "$BUNDLED_SAFE_CANDIDATE"
    rm -f -- "$BUNDLED_SAFE_CANDIDATE"
    if [ -z "$BEST_COMPATIBLE_COPY" ]; then
      echo "installer: bundled Codex failed version or schema verification" >&2
      exit 1
    fi
  fi

  if [ -n "$BEST_COMPATIBLE_COPY" ]; then
    SELECTED_CODEX_COPY=$BEST_COMPATIBLE_COPY
    SELECTED_CODEX_VERSION=$BEST_COMPATIBLE_VERSION
    SELECTED_CODEX_SOURCE=$BEST_COMPATIBLE_SOURCE
  elif [ -n "$BEST_FALLBACK_COPY" ]; then
    SELECTED_CODEX_COPY=$BEST_FALLBACK_COPY
    SELECTED_CODEX_VERSION=$BEST_FALLBACK_VERSION
    SELECTED_CODEX_SOURCE=$BEST_FALLBACK_SOURCE
  else
    echo "installer: no self-contained Codex executable was found for this user; AgentFleet will remain read-only" >&2
    return 0
  fi

  CODEX_TEMP="$CODEX_CACHE_DIR/.codex-$$"
  if [ -e "$CODEX_TEMP" ] || [ -L "$CODEX_TEMP" ]; then
    echo "installer: temporary managed Codex path already exists" >&2
    exit 1
  fi
  cp -- "$SELECTED_CODEX_COPY" "$CODEX_TEMP"
  if [ "$INSTALL_UID" = "0" ]; then chown 0:0 "$CODEX_TEMP"; fi
  chmod 755 "$CODEX_TEMP"
  if [ "$("$CODEX_TEMP" --version 2>/dev/null)" != "codex-cli $SELECTED_CODEX_VERSION" ]; then
    echo "installer: managed Codex verification failed" >&2
    exit 1
  fi
  mv -f "$CODEX_TEMP" "$CODEX_CACHE_EXECUTABLE"
  CODEX_TEMP=""
  AGENTFLEET_CODEX_EXECUTABLE=$CODEX_CACHE_EXECUTABLE
  export AGENTFLEET_CODEX_EXECUTABLE
  echo "Prepared codex-cli $SELECTED_CODEX_VERSION for the AgentFleet service from $SELECTED_CODEX_SOURCE."
}
trap cleanup EXIT HUP INT TERM
if [ -L "$BIN_ROOT" ]; then
  echo "installer: refusing a symlinked managed binary directory" >&2
  exit 1
fi
validate_managed_target() {
  if [ -z "$1" ]; then return 0; fi
  case "$1" in "$BIN_ROOT"/*/agentfleet) ;; *) return 1 ;; esac
  TARGET_VERSION=${1#"$BIN_ROOT"/}
  TARGET_VERSION=${TARGET_VERSION%/agentfleet}
  case "$TARGET_VERSION" in ""|*/*|.|..) return 1 ;; esac
  [ -f "$1" ] && [ ! -L "$1" ] && [ -x "$1" ]
}

if [ "$MODE" = "rollback" ]; then
  if [ ! -L "$CURRENT_LINK" ]; then
    echo "installer: no managed AgentFleet installation to roll back" >&2
    exit 1
  fi
  if ! validate_managed_target "$(readlink "$CURRENT_LINK")"; then
    echo "installer: current link is not managed by this installation" >&2
    exit 1
  fi
  acquire_install_lock
  "$CURRENT_LINK" service rollback "$@"
  exit 0
fi

if [ "$MODE" = "uninstall" ]; then
  if [ ! -L "$CURRENT_LINK" ]; then
    echo "installer: no managed AgentFleet installation to uninstall" >&2
    exit 1
  fi
  if ! validate_managed_target "$(readlink "$CURRENT_LINK")"; then
    echo "installer: current link is not managed by this installation" >&2
    exit 1
  fi
  if [ -L "$MANAGED_MARKER" ] || [ ! -f "$MANAGED_MARKER" ] || [ "$(sed -n '1p' "$MANAGED_MARKER")" != "agentfleet-binaries-v1" ]; then
    echo "installer: refusing to remove an unmarked binary directory" >&2
    exit 1
  fi
  PURGE_STATE=no
  UNINSTALL_DATA_DIR=""
  EXPECT_UNINSTALL_DATA_DIR=no
  for value in "$@"; do
    if [ "$EXPECT_UNINSTALL_DATA_DIR" = yes ]; then
      UNINSTALL_DATA_DIR=$value
      EXPECT_UNINSTALL_DATA_DIR=no
    else
      case "$value" in
        --purge) PURGE_STATE=yes ;;
        --data-dir) EXPECT_UNINSTALL_DATA_DIR=yes ;;
        --data-dir=*) UNINSTALL_DATA_DIR=${value#--data-dir=} ;;
        *) echo "installer: unknown uninstall option: $value" >&2; exit 2 ;;
      esac
    fi
  done
  if [ "$EXPECT_UNINSTALL_DATA_DIR" = yes ]; then
    echo "installer: --data-dir requires a value" >&2
    exit 2
  fi
  DEFAULT_STATE_DIR="$DATA_ROOT/agentfleet"
  if [ "$PURGE_STATE" = yes ] && [ -n "$UNINSTALL_DATA_DIR" ] && [ "$UNINSTALL_DATA_DIR" != "$DEFAULT_STATE_DIR" ]; then
    echo "installer: --purge only removes the default AgentFleet state directory" >&2
    exit 2
  fi
  if [ "$PURGE_STATE" = yes ] && [ -L "$DEFAULT_STATE_DIR" ]; then
    echo "installer: refusing to purge a symlinked AgentFleet state directory" >&2
    exit 1
  fi
  acquire_install_lock
  if [ -n "$UNINSTALL_DATA_DIR" ]; then
    "$CURRENT_LINK" service uninstall --data-dir "$UNINSTALL_DATA_DIR"
  else
    "$CURRENT_LINK" service uninstall
  fi
  if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
    echo "installer: refusing to remove non-symlink $CURRENT_LINK" >&2
    exit 1
  fi
  if [ -e "$PREVIOUS_LINK" ] && [ ! -L "$PREVIOUS_LINK" ]; then
    echo "installer: refusing to remove non-symlink $PREVIOUS_LINK" >&2
    exit 1
  fi
  unlink "$CURRENT_LINK" 2>/dev/null || true
  unlink "$PREVIOUS_LINK" 2>/dev/null || true
  rm -rf -- "$BIN_ROOT"
  if [ "$PURGE_STATE" = yes ]; then
    rm -rf -- "$DEFAULT_STATE_DIR"
    echo "Removed AgentFleet service, program files, local identity, and connection state. Codex data and project files were not changed."
  else
    echo "Removed AgentFleet program files. Local identity and state were preserved in $DEFAULT_STATE_DIR."
  fi
  exit 0
fi

CONTROL_URL=""
EXPECT_URL=no
EXPECT_DATA_DIR=no
SERVICE_DATA_DIR=""
for value in "$@"; do
  if [ "$EXPECT_URL" = yes ]; then
    CONTROL_URL=$value
    EXPECT_URL=no
  elif [ "$EXPECT_DATA_DIR" = yes ]; then
    SERVICE_DATA_DIR=$value
    EXPECT_DATA_DIR=no
  else
    case "$value" in
      --url) EXPECT_URL=yes ;;
      --url=*) CONTROL_URL=${value#--url=} ;;
      --data-dir) EXPECT_DATA_DIR=yes ;;
      --data-dir=*) SERVICE_DATA_DIR=${value#--data-dir=} ;;
    esac
  fi
done
if [ "$EXPECT_URL" = yes ] || [ "$EXPECT_DATA_DIR" = yes ] || [ -z "$CONTROL_URL" ]; then
  echo "installer: --url is required" >&2
  exit 2
fi
case "$CONTROL_URL" in
  *\?*|*\#*|*@*) echo "installer: --url must not contain credentials, query, or fragment" >&2; exit 2 ;;
  https://*) ;;
  http://localhost|http://localhost:*|http://localhost/*|http://127.0.0.1|http://127.0.0.1:*|http://127.0.0.1/*) ;;
  *) echo "installer: --url must use HTTPS" >&2; exit 2 ;;
esac
CONTROL_URL=${CONTROL_URL%/}
CODEX_COMPAT_SCHEMA_HASH=d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a
CODEX_BWRAP_SHA256=77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c
case "$CONTROL_URL" in
  http://localhost|http://localhost:*|http://localhost/*|http://127.0.0.1|http://127.0.0.1:*|http://127.0.0.1/*)
    if printf '%s\n' "${AGENTFLEET_INSTALLER_TEST_SCHEMA_HASH:-}" | grep -Eq '^[0-9a-f]{64}$'; then
      CODEX_COMPAT_SCHEMA_HASH=$AGENTFLEET_INSTALLER_TEST_SCHEMA_HASH
    fi
    if printf '%s\n' "${AGENTFLEET_INSTALLER_TEST_BWRAP_SHA256:-}" | grep -Eq '^[0-9a-f]{64}$'; then
      CODEX_BWRAP_SHA256=$AGENTFLEET_INSTALLER_TEST_BWRAP_SHA256
    fi
    ;;
esac

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) PLATFORM=linux-x64 ;;
  *) echo "installer: this download supports Linux x86_64; select the macOS or Windows installer for those systems" >&2; exit 1 ;;
esac

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agentfleet-install.XXXXXX")

download() {
  if [ "${CONTROL_URL#https://}" != "$CONTROL_URL" ]; then
    curl -fLsS --proto '=https' --tlsv1.2 "$1" -o "$2"
  else
    curl -fLsS --proto '=http' "$1" -o "$2"
  fi
}

MANIFEST="$TEMP_DIR/manifest.json"
download "$CONTROL_URL/downloads/manifest.json" "$MANIFEST"
COMPACT=$(tr -d '\r\n' < "$MANIFEST")
SCHEMA_VERSION=$(printf '%s' "$COMPACT" | sed -n 's/.*"schemaVersion":\([0-9]*\).*/\1/p')
VERSION=$(printf '%s' "$COMPACT" | sed -n 's/.*"version":"\([0-9A-Za-z.+-]*\)".*/\1/p')
PLATFORM_BLOCK=$(printf '%s' "$COMPACT" | sed -n "s/.*\"$PLATFORM\":{\([^}]*\)}.*/\1/p")
FILE=$(printf '%s' "$PLATFORM_BLOCK" | sed -n 's/.*"file":"\([A-Za-z0-9.+-]*\)".*/\1/p')
SHA256=$(printf '%s' "$PLATFORM_BLOCK" | sed -n 's/.*"sha256":"\([0-9a-f]*\)".*/\1/p')
SIZE=$(printf '%s' "$PLATFORM_BLOCK" | sed -n 's/.*"size":\([0-9]*\).*/\1/p')
FORMAT=$(printf '%s' "$PLATFORM_BLOCK" | sed -n 's/.*"format":"\(sea\|portable\)".*/\1/p')
if [ "$SCHEMA_VERSION" != "1" ] || [ -z "$VERSION" ] || [ "${#SHA256}" -ne 64 ] || [ -z "$SIZE" ]; then
  echo "installer: release manifest is invalid" >&2
  exit 1
fi
if ! printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$'; then
  echo "installer: release version is invalid" >&2
  exit 1
fi
case "$FORMAT:$FILE" in
  "sea:agentfleet-linux-x64-$VERSION") ;;
  "portable:agentfleet-linux-x64-$VERSION.tar.gz") ;;
  *) echo "installer: artifact name does not match manifest version and format" >&2; exit 1 ;;
esac
EXPECTED_ARTIFACT_METADATA="$TEMP_DIR/artifact-metadata.expected"
artifact_metadata_record "$FILE" "$FORMAT" "$SHA256" "$SIZE" > "$EXPECTED_ARTIFACT_METADATA"

ARTIFACT="$TEMP_DIR/$FILE"
download "$CONTROL_URL/downloads/$FILE" "$ARTIFACT"
ACTUAL_SIZE=$(wc -c < "$ARTIFACT" | tr -d ' ')
if [ "$ACTUAL_SIZE" != "$SIZE" ]; then
  echo "installer: artifact size does not match manifest" >&2
  exit 1
fi
printf '%s  %s\n' "$SHA256" "$ARTIFACT" | sha256sum -c - >/dev/null

acquire_install_lock
mkdir -p "$BIN_ROOT" "$USER_BIN"
if [ -e "$MANAGED_MARKER" ]; then
  if [ -L "$MANAGED_MARKER" ] || [ ! -f "$MANAGED_MARKER" ] || [ "$(sed -n '1p' "$MANAGED_MARKER")" != "agentfleet-binaries-v1" ]; then
    echo "installer: managed binary directory marker is invalid" >&2
    exit 1
  fi
else
  printf '%s\n' agentfleet-binaries-v1 > "$MANAGED_MARKER"
  chmod 600 "$MANAGED_MARKER"
fi
TARGET="$BIN_ROOT/$VERSION"
if [ -e "$TARGET" ]; then
  ARTIFACT_METADATA="$TARGET/.artifact-metadata"
  if [ -L "$TARGET" ] || [ ! -d "$TARGET" ] || [ -L "$ARTIFACT_METADATA" ] || [ ! -f "$ARTIFACT_METADATA" ]; then
    echo "installer: existing version lacks valid immutable artifact metadata: $TARGET" >&2
    exit 1
  fi
  if ! cmp -s "$ARTIFACT_METADATA" "$EXPECTED_ARTIFACT_METADATA"; then
    echo "installer: immutable artifact mismatch for existing version $VERSION; publish a new version instead" >&2
    exit 1
  fi
  if [ -L "$TARGET/agentfleet" ] || [ ! -f "$TARGET/agentfleet" ] || [ ! -x "$TARGET/agentfleet" ]; then
    echo "installer: existing version directory failed validation: $TARGET" >&2
    exit 1
  fi
  # A SEA is the downloaded artifact itself, so verify its pinned bytes before
  # invoking even --version. This prevents a locally replaced executable from
  # running during installer validation.
  if [ "$FORMAT" = sea ] && [ "$(sha256sum "$TARGET/agentfleet" | awk '{print $1}')" != "$SHA256" ]; then
    echo "installer: installed SEA content does not match its immutable artifact SHA-256" >&2
    exit 1
  fi
  if [ "$("$TARGET/agentfleet" --version)" != "$VERSION" ]; then
    echo "installer: existing version directory failed validation: $TARGET" >&2
    exit 1
  fi
  echo "installer: validated existing AgentFleet $VERSION"
else
  STAGED_TARGET="$BIN_ROOT/.staging-$VERSION-$$"
  if [ -e "$STAGED_TARGET" ]; then
    echo "installer: staging path already exists" >&2
    exit 1
  fi
  mkdir "$STAGED_TARGET"
  if [ "$FORMAT" = "sea" ]; then
    cp "$ARTIFACT" "$STAGED_TARGET/agentfleet"
    chmod 755 "$STAGED_TARGET/agentfleet"
  else
    ARCHIVE_LIST="$TEMP_DIR/archive-list.txt"
    tar -tzf "$ARTIFACT" > "$ARCHIVE_LIST"
    if ! validate_archive_list "$ARCHIVE_LIST"; then
      echo "installer: portable archive contains an unsafe path" >&2
      exit 1
    fi
    if ! tar -tvzf "$ARTIFACT" | awk 'substr($1,1,1) != "-" && substr($1,1,1) != "d" { bad=1 } END { exit bad ? 1 : 0 }'; then
      echo "installer: portable archive contains a link or special file" >&2
      exit 1
    fi
    tar -xzf "$ARTIFACT" -C "$STAGED_TARGET" --strip-components=1 --no-same-owner --no-same-permissions
  fi
  ACTUAL_VERSION=$("$STAGED_TARGET/agentfleet" --version)
  if [ "$ACTUAL_VERSION" != "$VERSION" ]; then
    echo "installer: artifact reported version '$ACTUAL_VERSION', expected '$VERSION'" >&2
    exit 1
  fi
  cp "$EXPECTED_ARTIFACT_METADATA" "$STAGED_TARGET/.artifact-metadata"
  chmod 600 "$STAGED_TARGET/.artifact-metadata"
  mv -T -n "$STAGED_TARGET" "$TARGET"
  if [ -e "$STAGED_TARGET" ]; then
    echo "installer: version directory appeared concurrently; refusing to reuse it" >&2
    exit 1
  fi
  STAGED_TARGET=""
fi

if [ -e "$CURRENT_LINK" ] && [ ! -L "$CURRENT_LINK" ]; then
  echo "installer: refusing to overwrite non-symlink $CURRENT_LINK" >&2
  exit 1
fi
if [ -e "$PREVIOUS_LINK" ] && [ ! -L "$PREVIOUS_LINK" ]; then
  echo "installer: refusing to overwrite non-symlink $PREVIOUS_LINK" >&2
  exit 1
fi
OLD_TARGET=""
OLDER_TARGET=""
if [ -L "$CURRENT_LINK" ]; then OLD_TARGET=$(readlink "$CURRENT_LINK"); fi
if [ -L "$PREVIOUS_LINK" ]; then OLDER_TARGET=$(readlink "$PREVIOUS_LINK"); fi
if ! validate_managed_target "$OLD_TARGET"; then
  echo "installer: current link is not managed by this installation" >&2
  exit 1
fi
if ! validate_managed_target "$OLDER_TARGET"; then
  echo "installer: previous link is not managed by this installation" >&2
  exit 1
fi
if { [ "$MODE" = "update" ] || [ "$MODE" = "stage" ]; } && [ -z "$OLD_TARGET" ]; then
  echo "installer: update requires an existing managed installation" >&2
  exit 1
fi

atomic_link() {
  LINK_TEMP="$1.tmp-$$"
  if [ -e "$LINK_TEMP" ] || [ -L "$LINK_TEMP" ]; then
    echo "installer: temporary link already exists: $LINK_TEMP" >&2
    exit 1
  fi
  ln -s "$2" "$LINK_TEMP"
  mv -f "$LINK_TEMP" "$1"
}

# Prepare every dependency before changing the executable used by the service.
PROFILE_DIRECTORY=${SERVICE_DATA_DIR:-"$DATA_ROOT/agentfleet"}
PROFILE_TARGET="$PROFILE_DIRECTORY/runtime-profile.json"
if [ -L "$PROFILE_DIRECTORY" ] || [ -L "$PROFILE_TARGET" ]; then
  echo "installer: refusing a symlinked runtime profile" >&2
  exit 1
fi
mkdir -p "$PROFILE_DIRECTORY"
if [ -f "$PROFILE_TARGET" ]; then
  cp "$PROFILE_TARGET" "$TEMP_DIR/runtime-profile.previous"
  PROFILE_EXISTED=yes
  PROFILE_COMPACT=$(tr -d '\r\n' < "$PROFILE_TARGET")
  EXISTING_PROFILE_CODEX_EXECUTABLE=$(printf '%s' "$PROFILE_COMPACT" | sed -n 's/.*"codexExecutable":"\([^"\\]*\)".*/\1/p')
  EXISTING_PROFILE_CODEX_HOME=$(printf '%s' "$PROFILE_COMPACT" | sed -n 's/.*"codexHome":"\([^"\\]*\)".*/\1/p')
  EXISTING_HELPER_HASH=$(printf '%s' "$PROFILE_COMPACT" | sed -n 's/.*"managedSandboxHelperSha256":"\([0-9a-f]*\)".*/\1/p')
fi
if [ -f "$CODEX_CACHE_EXECUTABLE" ]; then
  cp "$CODEX_CACHE_EXECUTABLE" "$TEMP_DIR/codex.previous"
  CODEX_EXISTED=yes
fi
if [ -f "$CODEX_CACHE_DIR/codex-resources/bwrap" ] && [ ! -L "$CODEX_CACHE_DIR/codex-resources" ] && [ ! -L "$CODEX_CACHE_DIR/codex-resources/bwrap" ]; then
  cp "$CODEX_CACHE_DIR/codex-resources/bwrap" "$TEMP_DIR/bwrap.previous"
  HELPER_EXISTED=yes
fi
ACTIVATION_PENDING=yes
prepare_managed_codex
CODEX_BWRAP_VERSION=0.153.4
if [ "$SELECTED_CODEX_VERSION" = 0.153.2 ]; then
  CODEX_BWRAP_VERSION=0.153.2
  # The local fixture override is only admitted above for loopback HTTP.
  if [ "$CODEX_BWRAP_SHA256" = 77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c ]; then
    CODEX_BWRAP_SHA256=01fb705f067bd5365b63d8ad2323a61c8d007733ca5e649437e086f3fb9935d8
  fi
fi
case "$SELECTED_CODEX_VERSION" in
  0.153.2|0.153.4) ;;
  *)
    if ! printf '%s\n' "${EXISTING_HELPER_HASH:-}" | grep -Eq '^[0-9a-f]{64}$'; then
      echo "installer: this managed Codex version has no verified sandbox helper record; update the runtime validator first" >&2
      exit 1
    fi
    CODEX_BWRAP_SHA256=$EXISTING_HELPER_HASH
    EXISTING_HELPER_SOURCE="$(dirname -- "$SELECTED_CODEX_SOURCE")/codex-resources/bwrap"
    ;;
esac
prepare_managed_sandbox_helper
SELECTED_CODEX_HOME=${EXISTING_PROFILE_CODEX_HOME:-${CODEX_HOME:-"$HOME/.codex"}}
if [ -z "${EXISTING_PROFILE_CODEX_HOME:-}" ] && [ -n "$INHERITED_CODEX_HOME" ]; then
  if [ "$INSTALL_UID" != 0 ] || { [ -d "$INHERITED_CODEX_HOME" ] && root_path_is_safe "$INHERITED_CODEX_HOME"; }; then
    SELECTED_CODEX_HOME=$INHERITED_CODEX_HOME
  fi
fi
case "$SELECTED_CODEX_HOME" in /*) ;; *) echo "installer: Codex home must be absolute" >&2; exit 1 ;; esac
json_path() {
  if [ "$(printf '%s' "$1" | tr -d '\r\n')" != "$1" ]; then
    echo "installer: runtime paths must be single-line strings" >&2
    return 1
  fi
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}
PROFILE_CODEX_PATH=$(json_path "${AGENTFLEET_CODEX_EXECUTABLE:-codex}")
PROFILE_CODEX_HOME=$(json_path "$SELECTED_CODEX_HOME")
(umask 077; printf '{"schemaVersion":1,"codexExecutable":"%s","codexHome":"%s","source":"%s","managedSandboxHelperSha256":"%s"}\n' \
  "$PROFILE_CODEX_PATH" "$PROFILE_CODEX_HOME" "$SELECTED_CODEX_SOURCE_KIND" "$CODEX_BWRAP_SHA256" > "$PROFILE_TARGET.new-$$")
mv -f "$PROFILE_TARGET.new-$$" "$PROFILE_TARGET"

if [ -n "$OLD_TARGET" ] && [ "$OLD_TARGET" != "$TARGET/agentfleet" ]; then
  atomic_link "$PREVIOUS_LINK" "$OLD_TARGET"
fi
atomic_link "$CURRENT_LINK" "$TARGET/agentfleet"

echo "Installed AgentFleet $VERSION at $CURRENT_LINK"
case ":${PATH:-}:" in
  *":$USER_BIN:"*) ;;
  *) echo "warning: add $USER_BIN to PATH" >&2 ;;
esac

if [ "$MODE" = "update" ]; then
  if [ -n "$SERVICE_DATA_DIR" ]; then
    UPDATE_RESULT=failed
    if "$CURRENT_LINK" service update --executable "$CURRENT_LINK" --data-dir "$SERVICE_DATA_DIR"; then UPDATE_RESULT=ok; fi
  else
    UPDATE_RESULT=failed
    if "$CURRENT_LINK" service update --executable "$CURRENT_LINK"; then UPDATE_RESULT=ok; fi
  fi
  if [ "$UPDATE_RESULT" = ok ]; then
    ACTIVATION_PENDING=no
    echo "Updated and restarted the AgentFleet background service."
    exit 0
  fi
  echo "installer: service update failed; restoring the previous binary" >&2
  atomic_link "$CURRENT_LINK" "$OLD_TARGET"
  if [ -n "$OLDER_TARGET" ]; then atomic_link "$PREVIOUS_LINK" "$OLDER_TARGET"; else unlink "$PREVIOUS_LINK" 2>/dev/null || true; fi
  if [ -n "$SERVICE_DATA_DIR" ]; then
    "$CURRENT_LINK" service update --executable "$CURRENT_LINK" --data-dir "$SERVICE_DATA_DIR" || true
  else
    "$CURRENT_LINK" service update --executable "$CURRENT_LINK" || true
  fi
  exit 1
fi

if [ "$MODE" = "stage" ]; then
  ACTIVATION_PENDING=no
  echo "Staged AgentFleet $VERSION; the service will restart into this version."
  exit 0
fi

ACTIVATION_PENDING=no
cleanup
trap - EXIT HUP INT TERM
exec "$CURRENT_LINK" onboard "$@" --executable "$CURRENT_LINK"
