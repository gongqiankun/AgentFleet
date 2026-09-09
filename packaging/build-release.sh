#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
set +e
"$SCRIPT_DIR/build-sea.sh" "$@"
SEA_STATUS=$?
set -e
if [ "$SEA_STATUS" -eq 0 ]; then
  exit 0
fi
if [ "$SEA_STATUS" -eq 73 ]; then
  echo "release version is immutable; refusing portable fallback" >&2
  exit 73
fi
echo "SEA build failed; producing the portable Node 24 runtime bundle" >&2
exec "$SCRIPT_DIR/build-portable.sh" "$@"
