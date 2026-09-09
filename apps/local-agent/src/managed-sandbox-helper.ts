import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentError } from "./errors.js";

// Verified official static Linux x64 helper, shipped alongside the installer.
// Preserve it when a promotion creates a new versioned Codex directory.
export const MANAGED_BWRAP_SHA256 = "77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c";
export interface SandboxHelperArtifact { file: string; sha256: string; size: number; format: "raw" }
export function validSandboxHelper(value: SandboxHelperArtifact, version: string): boolean {
  return !!value && value.format === "raw" && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= 1024 * 1024
    && value.file === `codex-bwrap-linux-x64-${version}-${value.sha256.slice(0, 16)}`;
}
export async function stageSandboxHelper(dataDir: string, stage: string, platform = process.platform, architecture = process.arch, version = "0.153.4", controlPlaneUrl?: string, artifact?: SandboxHelperArtifact): Promise<string | undefined> {
  if (platform !== "linux") return;
  if (architecture !== "x64") throw new AgentError("RUNTIME_HELPER_UNAVAILABLE", "本机架构尚无验证过的隔离辅助程序");
  if (artifact && !validSandboxHelper(artifact, version)) throw new AgentError("RUNTIME_HELPER_UNAVAILABLE", "托管隔离辅助程序发布信息无效");
  const hash = artifact?.sha256 ?? (version === "0.153.2" ? "01fb705f067bd5365b63d8ad2323a61c8d007733ca5e649437e086f3fb9935d8" : version === "0.153.4" ? MANAGED_BWRAP_SHA256 : undefined);
  if (!hash) throw new AgentError("RUNTIME_HELPER_UNAVAILABLE", "目标版本缺少已验证的隔离依赖，请更新控制面板验证服务");
  const source = join(dataDir, "codex", "codex-resources", "bwrap");
  try {
    let bytes: Buffer | undefined;
    try {
      const stat = await lstat(source);
      if (stat.isFile() && stat.size <= 1024 * 1024) {
        const local = await readFile(source);
        if (createHash("sha256").update(local).digest("hex") === hash && (!artifact || local.length === artifact.size)) bytes = local;
      }
    } catch { /* Fetch the verified version-specific helper if not cached. */ }
    if (!bytes && controlPlaneUrl) {
      const path = artifact ? `/downloads/managed-codex/${artifact.file}` : `/downloads/codex-bwrap-linux-x64-${version}`;
      const response = await fetch(new URL(path, controlPlaneUrl), { redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok || !response.body) throw new Error("helper download failed");
      const chunks: Uint8Array[] = []; let size = 0; const reader = response.body.getReader();
      try {
        while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > (artifact?.size ?? 1024 * 1024)) throw new Error("helper size exceeded"); chunks.push(next.value); }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      bytes = Buffer.concat(chunks);
      if ((artifact && bytes.length !== artifact.size) || createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("helper checksum mismatch");
    }
    if (!bytes) throw new Error("helper not available");
    const destination = join(stage, "codex-resources");
    await mkdir(destination, { mode: 0o700 });
    await writeFile(join(destination, "bwrap"), bytes, { flag: "wx", mode: 0o700 });
    return hash;
  } catch {
    throw new AgentError("RUNTIME_HELPER_UNAVAILABLE", "托管隔离辅助程序缺失或校验失败，请先更新连接服务；已保留原运行时");
  }
}
