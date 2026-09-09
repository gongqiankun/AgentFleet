import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { AgentError } from "./errors.js";
import { loadRuntimeProfile } from "./runtime-profile.js";
import { probeCodeModeHost } from "./code-mode-probe.js";

export interface CodeModeArtifact { file: string; sha256: string; size: number; format: "raw" }
export const codeModeName = (platform = process.platform) => platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host";
export function validCodeModeArtifact(value: CodeModeArtifact, version: string, platform: string): boolean {
  return !!value && ["linux-x64", "darwin-arm64", "darwin-x64", "win32-x64"].includes(platform) && value.format === "raw"
    && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= 192 * 1024 * 1024
    && value.file === `codex-code-mode-host-${platform}-${version}-${value.sha256.slice(0, 16)}${platform === "win32-x64" ? ".exe" : ""}`;
}
async function digest(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function* bodyChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try { while (true) { const next = await reader.read(); if (next.done) return; yield next.value; } }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
async function boundedFetch(url: URL, maximum: number): Promise<Buffer> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Code Mode download HTTP ${response.status}`);
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of bodyChunks(response.body)) { size += chunk.length; if (size > maximum) throw new Error("Code Mode response exceeds limit"); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
/** Stages only into an owned candidate directory; never modifies self-installed Codex. */
export async function stageCodeModeHost(stage: string, version: string, url: string, artifact: CodeModeArtifact | undefined, baseline = false): Promise<void> {
  const platform = `${process.platform}-${process.arch}`;
  if (!artifact || !validCodeModeArtifact(artifact, version, platform)) throw new AgentError("CODE_MODE_UNAVAILABLE", "托管目标缺少经过验证的 Code Mode 执行程序，保留原运行时");
  const destination = join(stage, codeModeName());
  const response = await fetch(new URL(`/downloads/${baseline ? "" : "managed-codex/"}${artifact.file}`, url), { redirect: "error", signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new AgentError("CODE_MODE_UNAVAILABLE", `Code Mode 下载失败 HTTP ${response.status}`);
  let size = 0; const hash = createHash("sha256");
  const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) { size += chunk.length; if (size > artifact.size) callback(new Error("Code Mode size exceeded")); else { hash.update(chunk); callback(null, chunk); } } });
  await pipeline(bodyChunks(response.body), bounded, createWriteStream(destination, { flags: "wx", mode: 0o700 }));
  if (size !== artifact.size || hash.digest("hex") !== artifact.sha256) throw new AgentError("CODE_MODE_CHECKSUM_FAILED", "Code Mode 执行程序摘要不一致，未启用");
  await chmod(destination, 0o700);
  await probeCodeModeHost(destination);
  await writeFile(join(stage, "code-mode-artifact.json"), JSON.stringify({ version, platform, artifact }), { flag: "wx", mode: 0o600 });
}
/** Runs only during exclusive worker startup or onboarding, never from status.
 * Existing verified helpers remain usable offline. Repair replaces only the
 * managed companion, not Codex, CODEX_HOME, sessions or account settings.
 */
export async function repairManagedCodeMode(dataDir: string, url: string): Promise<void> {
  const profile = await loadRuntimeProfile(dataDir);
  if (!profile || profile.source !== "managed") return;
  const root = resolve(dataDir, "codex");
  const directory = dirname(resolve(profile.codexExecutable));
  if (directory !== root && !directory.startsWith(root + sep)) throw new AgentError("CODE_MODE_PATH_INVALID", "托管运行时路径不在 AgentFleet 数据目录内");
  const versionOutput = await promisify(execFile)(profile.codexExecutable, ["--version"], { timeout: 10_000, maxBuffer: 8192 });
  const version = /^codex-cli (\d+\.\d+\.\d+)\s*$/.exec(versionOutput.stdout)?.[1];
  if (!version) throw new AgentError("CODE_MODE_UNAVAILABLE", "无法确定托管执行程序对应版本");
  const platform = `${process.platform}-${process.arch}`;
  const executable = join(directory, codeModeName());
  try {
    const file = await lstat(executable), metadata = await lstat(join(directory, "code-mode-artifact.json"));
    if (!file.isFile() || !metadata.isFile() || metadata.size > 8192) throw new Error("invalid cache");
    const cached = JSON.parse(await readFile(join(directory, "code-mode-artifact.json"), "utf8"));
    if (cached.version === version && cached.platform === platform && validCodeModeArtifact(cached.artifact, version, platform) && file.size === cached.artifact.size && await digest(executable) === cached.artifact.sha256) {
      await probeCodeModeHost(executable); return;
    }
  } catch { /* A missing/unverified companion needs a verified download. */ }
  const target = JSON.parse((await boundedFetch(new URL("/api/runtime-release/target", url), 256_000)).toString()).target;
  let artifact = target?.version === version ? target.codeModeHosts?.[platform] as CodeModeArtifact | undefined : undefined;
  let baseline = false;
  if (!artifact && version === "0.153.2") {
    const manifest = JSON.parse((await boundedFetch(new URL("/downloads/codex-manifest.json", url), 256_000)).toString());
    if (manifest.version === version) { artifact = manifest.codeModeHosts?.[platform]; baseline = true; }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(directory, "code-mode-repair-"));
  try {
    await stageCodeModeHost(stage, version, url, artifact, baseline);
    // Atomic replacement after digest and execution checks; worker has no writers yet.
    await rename(join(stage, codeModeName()), executable);
    await rename(join(stage, "code-mode-artifact.json"), join(directory, "code-mode-artifact.json"));
  } finally { await rm(stage, { recursive: true, force: true }); }
}
