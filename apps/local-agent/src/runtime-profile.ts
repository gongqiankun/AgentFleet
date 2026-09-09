import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { AgentError } from "./errors.js";

export interface RuntimeProfile {
  schemaVersion: 1;
  codexExecutable: string;
  codexHome: string;
  source: "host" | "managed";
}

export async function requireRootControlledPath(path: string): Promise<void> {
  let current = path;
  while (true) {
    const metadata = await lstat(current);
    if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      throw new AgentError("SERVICE_EXECUTABLE_UNSAFE", "system service executable and every parent directory must be root-owned and not group/world writable");
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function loadRuntimeProfile(dataDir: string, uid: number | null = typeof process.getuid === "function" ? process.getuid() : null): Promise<RuntimeProfile | undefined> {
  const path = join(dataDir, "runtime-profile.json");
  let metadata;
  try { metadata = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384 ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
    throw new AgentError("RUNTIME_PROFILE_UNSAFE", "runtime profile must be a private regular file");
  }
  const value = JSON.parse(await readFile(path, "utf8")) as Partial<RuntimeProfile>;
  if (value.schemaVersion !== 1 || (value.source !== "host" && value.source !== "managed") ||
    typeof value.codexExecutable !== "string" || !isAbsolute(value.codexExecutable) ||
    typeof value.codexHome !== "string" || !isAbsolute(value.codexHome) ||
    /[\0\r\n]/u.test(value.codexExecutable + value.codexHome)) {
    throw new AgentError("RUNTIME_PROFILE_INVALID", "runtime profile paths or version are invalid");
  }
  if (process.platform !== "win32" && uid !== null && metadata.uid !== uid) {
    throw new AgentError("RUNTIME_PROFILE_UNSAFE", "runtime profile belongs to a different OS account");
  }
  if (uid === 0 && process.platform !== "win32") {
    await requireRootControlledPath(await realpath(path));
    await requireRootControlledPath(await realpath(value.codexExecutable));
    await requireRootControlledPath(await realpath(value.codexHome));
  }
  return value as RuntimeProfile;
}

export async function configureRuntimeProfile(dataDir: string, environment: NodeJS.ProcessEnv = process.env): Promise<RuntimeProfile | undefined> {
  const profile = await loadRuntimeProfile(dataDir);
  if (profile) {
    environment.AGENTFLEET_CODEX_EXECUTABLE = profile.codexExecutable;
    environment.CODEX_HOME = profile.codexHome;
    environment.AGENTFLEET_RUNTIME_SOURCE = profile.source;
  }
  return profile;
}
