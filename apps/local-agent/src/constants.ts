export const AGENT_VERSION = "0.30.12";
export const FLEET_PROTOCOL_VERSION = "1.0";
export const STATE_SCHEMA_VERSION = 2;
export const POLICY_VERSION = "remote-restricted-v1";
export const REQUIRED_NODE_MAJOR = 24;
export const MINIMUM_CODEX_VERSION = "0.153.2";
export const REQUIRED_CODEX_SCHEMA_HASH = "d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a";
export const MINIMUM_MACOS_MAJOR = 13;
export const MINIMUM_WINDOWS_BUILD = 19_041;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const MAX_PROJECTS = 500;
export const MAX_DISCOVERED_THREADS = 500;
export const MAX_WS_FRAME_BYTES = 8_388_608;
export const MAX_CONTENT_BYTES = 256_000;
export const MAX_DELTA_BYTES = 32_000;
export const DEFAULT_APPROVAL_TTL_MS = 5 * 60_000;
export const APP_SERVER_RESTART_BASE_MS = 500;
export const APP_SERVER_RESTART_MAX_MS = 30_000;

export const ALLOWED_COMMAND_TYPES = [
  "thread.claim",
  "thread.release",
  "thread.rename",
  "thread.delete.preview",
  "thread.delete",
  "thread.archive",
  "thread.unarchive",
  "thread.fork",
  "turn.start",
  "turn.compact",
  "turn.review",
  "turn.queue",
  "turn.steer",
  "turn.cancel",
  "approval.decide_once",
  "input.respond",
  "codex.inspect",
  "thread.terminals.stop",
] as const;

export type AllowedCommandType = (typeof ALLOWED_COMMAND_TYPES)[number];

export function expectedCodexSchemaHash(version?: string | null): string {
  const developmentOverride = process.env.AGENTFLEET_CODEX_SCHEMA_HASH;
  if (developmentOverride && process.env.NODE_ENV !== "production") return developmentOverride;
  return version === "0.154.0" ? "f3487938786b729cb6773dbc9e83a7efab9c78c845db7094e8f539f373cbacc9" : REQUIRED_CODEX_SCHEMA_HASH;
}

export function isSupportedCodexVersion(value: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return false;
  const version = match.slice(1).map((part) => Number.parseInt(part, 10));
  const minimum = MINIMUM_CODEX_VERSION.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < 3; index += 1) {
    if ((version[index] ?? 0) > (minimum[index] ?? 0)) return true;
    if ((version[index] ?? 0) < (minimum[index] ?? 0)) return false;
  }
  return true;
}
