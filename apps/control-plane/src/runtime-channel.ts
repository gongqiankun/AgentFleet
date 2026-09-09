import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CODEX_COMPATIBILITY_PROFILE } from "./api-schema.js";

export interface RuntimeArtifact { file: string; sha256: string; size: number; format: "raw" }
export interface RuntimeTarget {
  schemaVersion: 1; revision: string; version: string; schemaHash: string; validatedAt: string;
  artifacts: Record<string, RuntimeArtifact>;
  sandboxHelper?: RuntimeArtifact;
  codeModeHosts?: Record<string, RuntimeArtifact>;
  rollback?: boolean;
}
export interface RuntimeChannelState {
  phase: "idle" | "checking" | "downloading" | "validating" | "promoted" | "blocked" | "failed" | "paused";
  latestVersion?: string; lastCheckedAt?: string; nextCheckAt?: string; workerHeartbeatAt?: string;
  message: string; checks: { name: string; state: "passed" | "failed"; detail: string }[];
  target?: RuntimeTarget; previous?: RuntimeTarget;
  history: { at: string; version: string; result: string; message: string }[];
  handledCheck?: string; handledRollback?: string;
}
export interface RuntimeChannelControl { paused: boolean; checkId: string; rollbackId?: string }
export const RUNTIME_ARTIFACT_NAME = /^codex-(linux-x64|darwin-arm64|darwin-x64|win32-x64|bwrap-linux-x64|code-mode-host-(?:linux-x64|darwin-arm64|darwin-x64|win32-x64))-\d+\.\d+\.\d+-[a-f0-9]{16}(?:\.exe)?$/;
export function readChannelJson<T>(directory: string, file: string, fallback: T): T {
  try { const contents = readFileSync(join(directory, file), "utf8"); if (contents.length > 256_000) throw new Error("channel file too large"); return JSON.parse(contents) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
export function writeChannelJson(directory: string, file: string, value: unknown): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `${file}.${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  renameSync(temporary, join(directory, file));
}
export const emptyChannel = (): RuntimeChannelState => ({ phase: "idle", message: "等待自动验证服务检查官方稳定版", checks: [], history: [] });
export const channelControl = (directory: string) => readChannelJson<RuntimeChannelControl>(directory, "control.json", { paused: false, checkId: "initial" });
export const channelState = (directory: string) => readChannelJson<RuntimeChannelState>(directory, "state.json", emptyChannel());
export function channelProfile(directory?: string) {
  const target = directory ? channelState(directory).target : undefined;
  return target ? { ...CODEX_COMPATIBILITY_PROFILE, managedCodexVersion: target.version, lastValidatedAt: target.validatedAt, profileVersion: `auto-${target.revision}` } : CODEX_COMPATIBILITY_PROFILE;
}
export function channelStatus(directory?: string) {
  if (!directory) return { configured: false, ...emptyChannel(), paused: true, workerOnline: false };
  const state = channelState(directory);
  return { configured: true, ...state, paused: channelControl(directory).paused,
    workerOnline: Boolean(state.workerHeartbeatAt && Date.now() - Date.parse(state.workerHeartbeatAt) < 90_000) };
}
