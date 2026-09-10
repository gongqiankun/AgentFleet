import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";

// Archives are pinned by Docker ADD --checksum. Publish raw, content-addressed
// companions so every supported OS can install them without a system package.
const directory = process.argv[2];
const version = "0.154.0";
const platforms = { "linux-x64": "x86_64-unknown-linux-musl", "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin", "win32-x64": "x86_64-pc-windows-msvc.exe" };
const manifestPath = join(directory, "codex-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.version !== version) throw new Error("Code Mode baseline version mismatch");
manifest.codeModeHosts = {};
for (const [platform, triple] of Object.entries(platforms)) {
  const entry = `codex-code-mode-host-${triple}`;
  const archive = `/build/${entry}.tar.gz`;
  if (execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 8192 }).trim() !== entry) throw new Error("Unexpected Code Mode archive layout");
  const bytes = execFileSync("tar", ["-xOzf", archive, "--", entry], { maxBuffer: 192 * 1024 * 1024 });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = `codex-code-mode-host-${platform}-${version}-${sha256.slice(0, 16)}${platform === "win32-x64" ? ".exe" : ""}`;
  writeFileSync(join(directory, file), bytes, { mode: 0o755, flag: "wx" });
  manifest.codeModeHosts[platform] = { file, sha256, size: bytes.length, format: "raw" };
}
writeFileSync(manifestPath, JSON.stringify(manifest) + "\n");
