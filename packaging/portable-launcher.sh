#!/bin/sh
set -eu

# The installer exposes this launcher through ~/.local/bin/agentfleet. Resolve
# that link before locating the bundled runtime; dirname($0) would otherwise
# incorrectly point at ~/.local/bin instead of the immutable release folder.
LAUNCHER_PATH=$0
LINK_HOPS=0
while [ -L "$LAUNCHER_PATH" ]; do
  LINK_HOPS=$((LINK_HOPS + 1))
  if [ "$LINK_HOPS" -gt 32 ]; then
    echo "agentfleet: launcher symlink chain is too deep" >&2
    exit 126
  fi
  LINK_DIR=$(CDPATH= cd -- "$(dirname -- "$LAUNCHER_PATH")" && pwd)
  LINK_TARGET=$(readlink "$LAUNCHER_PATH")
  case "$LINK_TARGET" in
    /*) LAUNCHER_PATH=$LINK_TARGET ;;
    *) LAUNCHER_PATH=$LINK_DIR/$LINK_TARGET ;;
  esac
done
RUNTIME_DIR=$(CDPATH= cd -- "$(dirname -- "$LAUNCHER_PATH")" && pwd)
export NODE_NO_WARNINGS=1
exec "$RUNTIME_DIR/runtime/node" "$RUNTIME_DIR/lib/dist/src/cli.js" "$@"
