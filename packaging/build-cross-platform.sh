#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
AGENT_DIR="$REPO_DIR/apps/local-agent"
OUTPUT_DIR=${AGENTFLEET_RELEASE_DIR:-"$REPO_DIR/release"}
VERSION=${1:-$(node -p "require('$AGENT_DIR/package.json').version")}
NODE_DARWIN_ARM64_ARCHIVE=${NODE_DARWIN_ARM64_ARCHIVE:-/build/node-v24.14.0-darwin-arm64.tar.gz}
NODE_DARWIN_X64_ARCHIVE=${NODE_DARWIN_X64_ARCHIVE:-/build/node-v24.14.0-darwin-x64.tar.gz}
NODE_WINDOWS_X64_EXE=${NODE_WINDOWS_X64_EXE:-/build/node-win-x64.exe}

for required in "$OUTPUT_DIR/manifest.json" "$NODE_DARWIN_ARM64_ARCHIVE" "$NODE_DARWIN_X64_ARCHIVE" "$NODE_WINDOWS_X64_EXE"; do
  test -f "$required" || { echo "cross-platform builder: missing $required" >&2; exit 1; }
done

cd "$AGENT_DIR"
npm run build
STAGE=$(mktemp -d "$SCRIPT_DIR/build/cross-$VERSION.XXXXXX")
trap 'rm -rf -- "$STAGE"' EXIT HUP INT TERM

build_darwin() {
  ARCH=$1
  NODE_ARCHIVE=$2
  NODE_FOLDER="node-v24.14.0-darwin-$ARCH"
  TARGET="$STAGE/darwin-$ARCH/agentfleet"
  ARTIFACT="$OUTPUT_DIR/agentfleet-darwin-$ARCH-$VERSION.tar.gz"
  test ! -e "$ARTIFACT" || { echo "immutable release exists: $ARTIFACT" >&2; exit 73; }
  mkdir -p "$TARGET/runtime" "$TARGET/lib"
  tar -xzf "$NODE_ARCHIVE" -C "$STAGE" "$NODE_FOLDER/bin/node"
  cp "$STAGE/$NODE_FOLDER/bin/node" "$TARGET/runtime/node"
  cp -R "$AGENT_DIR/dist" "$TARGET/lib/dist"
  cp "$AGENT_DIR/package.json" "$TARGET/lib/package.json"
  cp "$SCRIPT_DIR/portable-launcher.sh" "$TARGET/agentfleet"
  chmod 755 "$TARGET/agentfleet" "$TARGET/runtime/node"
  tar -czf "$ARTIFACT" -C "$STAGE/darwin-$ARCH" agentfleet
  sha256sum "$ARTIFACT" > "$ARTIFACT.sha256"
}

build_windows() {
  TARGET="$STAGE/win32-x64/agentfleet"
  ARTIFACT="$OUTPUT_DIR/agentfleet-win32-x64-$VERSION.tar.gz"
  test ! -e "$ARTIFACT" || { echo "immutable release exists: $ARTIFACT" >&2; exit 73; }
  mkdir -p "$TARGET/runtime" "$TARGET/lib"
  cp "$NODE_WINDOWS_X64_EXE" "$TARGET/runtime/node.exe"
  cp -R "$AGENT_DIR/dist" "$TARGET/lib/dist"
  cp "$AGENT_DIR/package.json" "$TARGET/lib/package.json"
  cp "$SCRIPT_DIR/windows-launcher.cmd" "$TARGET/agentfleet.cmd"
  tar -czf "$ARTIFACT" -C "$STAGE/win32-x64" agentfleet
  sha256sum "$ARTIFACT" > "$ARTIFACT.sha256"
}

build_darwin arm64 "$NODE_DARWIN_ARM64_ARCHIVE"
build_darwin x64 "$NODE_DARWIN_X64_ARCHIVE"
build_windows

node --input-type=module - "$OUTPUT_DIR" "$VERSION" <<'NODE'
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
const [directory, version] = process.argv.slice(2);
const manifestPath = join(directory, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.schemaVersion !== 1 || manifest.version !== version || !manifest.artifacts?.["linux-x64"]) {
  throw new Error("Linux manifest must be built before cross-platform artifacts");
}
for (const platform of ["darwin-arm64", "darwin-x64", "win32-x64"]) {
  const file = `agentfleet-${platform}-${version}.tar.gz`;
  const bytes = await readFile(join(directory, file));
  manifest.artifacts[platform] = {
    file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: (await stat(join(directory, file))).size,
    format: "portable",
  };
}
await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
NODE

echo "Built AgentFleet $VERSION for macOS arm64/x64 and Windows x64"
