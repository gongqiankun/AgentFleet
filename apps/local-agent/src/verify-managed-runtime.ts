// Installer entry point, invoked with the bundled Node before reusing a runtime.
// Its only output is a validated version; it never inspects Codex account data.
import { execFileSync } from "node:child_process";
import { realpathSync, statSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { isSupportedCodexVersion, REQUIRED_CODEX_SCHEMA_HASH } from "./constants.js";

let temp: string | undefined;
try {
  const executable = realpathSync(process.argv[2] ?? ""), root = realpathSync(process.argv[3] ?? "");
  if (!executable.startsWith(root + sep) || !statSync(executable).isFile()) throw new Error("not managed");
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    for (let path = executable; ; path = dirname(path)) {
      const info = statSync(path);
      if (info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error("unsafe runtime");
      if (path === dirname(path)) break;
    }
  }
  const output = execFileSync(executable, ["--version"], { timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16384 });
  const version = /^codex-cli\s+([\d.]+)\s*$/m.exec(output)?.[1];
  if (!version || !isSupportedCodexVersion(version)) throw new Error("unsupported version");
  temp = mkdtempSync(join(tmpdir(), "agentfleet-verify-runtime-"));
  execFileSync(executable, ["app-server", "generate-json-schema", "--out", temp], { timeout: 15000, stdio: "ignore" });
  const schema = join(temp, "codex_app_server_protocol.v2.schemas.json");
  if (statSync(schema).size > 32 * 1024 * 1024 || createHash("sha256").update(readFileSync(schema)).digest("hex") !== REQUIRED_CODEX_SCHEMA_HASH) throw new Error("schema mismatch");
  process.stdout.write(version);
} catch { process.exitCode = 1; }
finally { if (temp) rmSync(temp, { recursive: true, force: true }); }
