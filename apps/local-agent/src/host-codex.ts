import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { requireRootControlledPath } from "./runtime-profile.js";

const exec = promisify(execFile);
type VersionSource = "command" | "package-record";
type Installation = { path: string; version: string; source: VersionSource; metadataPath?: string };
export interface HostCodexDetection {
  hostCodexPath: string | null;
  hostCodexVersion: string | null;
  hostCodexDefaultPath: string | null;
  hostCodexDefaultVersion: string | null;
  hostCodexCheckedAt: string;
  hostCodexDetection: "highest-detected";
  hostCodexVersionSource: VersionSource | null;
  hostCodexMetadataPath: string | null;
  hostCodexDefaultVersionSource: VersionSource | null;
}

/** Passive inventory only. Package records never authorize execution or runtime selection. */
async function installationRecord(canonical: string): Promise<{ version: string; metadataPath: string } | undefined> {
  const root = dirname(dirname(canonical));
  for (const filename of ["codex-package.json", "package.json"]) {
    const metadataPath = join(root, filename);
    let handle;
    try {
      handle = await open(metadataPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      const info = await handle.stat();
      if (!info.isFile() || info.size > 64 * 1024) continue;
      const buffer = Buffer.alloc(64 * 1024 + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 64 * 1024) continue;
      const record = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      if (!record || typeof record.version !== "string" || !/^\d+\.\d+\.\d+$/.test(record.version)) continue;
      const entrypoint = filename === "codex-package.json"
        ? record.layoutVersion === 1 && record.variant === "codex" ? record.entrypoint : undefined
        : record.name === "@openai/codex" ? record.bin?.codex : undefined;
      // Only the documented local bin layout, never execute or follow a metadata-provided command.
      if (!["bin/codex", "bin/codex.exe", "bin/codex.js"].includes(entrypoint)) continue;
      if (await realpath(join(root, entrypoint)) !== canonical) continue;
      return { version: record.version, metadataPath };
    } catch { /* Missing/malformed metadata is not a version claim. */ }
    finally { await handle?.close().catch(() => undefined); }
  }
  return undefined;
}

/** Inventory only: never selects/replaces the app-server runtime or runs shell profiles. */
export async function detectHostCodex(options: {
  home?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  uid?: number | null;
  runtimePath?: string | null;
  source?: "host" | "managed";
  probe?: (path: string) => Promise<string | null>;
  systemDirectories?: string[];
} = {}): Promise<HostCodexDetection> {
  const home = options.home ?? homedir();
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const uid = options.uid === undefined ? process.getuid?.() ?? null : options.uid;
  const names = platform === "win32" ? ["codex.exe"] : ["codex"];
  const paths = (environment.PATH ?? "").split(platform === "win32" ? ";" : ":").filter(isAbsolute);
  const candidates = new Map<string, boolean>();
  const add = (path: string, fromPath = false) => {
    if (isAbsolute(path) && candidates.size < 256) candidates.set(path, candidates.get(path) || fromPath);
  };
  for (const directory of paths.slice(0, 64)) for (const name of names) add(join(directory, name), true);
  if (options.source === "host" && options.runtimePath) add(options.runtimePath);
  for (const directory of [join(home, ".local/bin"), join(home, "bin"), join(home, ".npm-global/bin"), join(home, ".volta/bin"), ...(options.systemDirectories ?? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"])]) {
    for (const name of names) add(join(directory, name));
  }
  const children = async (path: string): Promise<string[]> => {
    try { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort().slice(-32); }
    catch { return []; }
  };
  for (const [root, suffix] of [
    [join(home, ".nvm/versions/node"), "bin"],
    [join(home, ".local/share/fnm/node-versions"), "installation/bin"],
    [join(home, ".fnm/node-versions"), "installation/bin"],
    [join(home, ".volta/tools/image/node"), "bin"],
  ]) {
    for (const child of await children(root!)) for (const name of names) add(join(root!, child, suffix!, name));
  }
  // Only known installation trees, never project/session directories or arbitrary home scans.
  let directories = 0;
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > 6 || directories++ >= 96 || candidates.size >= 256) return;
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.slice(0, 128)) {
      if (names.includes(entry.name) && !entry.isDirectory()) add(join(path, entry.name));
      else if (entry.isDirectory()) await walk(join(path, entry.name), depth + 1);
    }
  };
  const codexHome = environment.CODEX_HOME && isAbsolute(environment.CODEX_HOME) ? environment.CODEX_HOME : join(home, ".codex");
  const standalone = join(codexHome, "packages/standalone");
  for (const name of names) add(join(standalone, "current/bin", name));
  for (const root of [join(codexHome, "bin"), join(codexHome, "releases"), join(home, ".local/share/codex"), join(standalone, "releases")]) await walk(root, 0);
  const managed = options.source === "managed" && options.runtimePath ? await realpath(options.runtimePath).catch(() => options.runtimePath) : null;
  const seen = new Set<string>();
  let highest: Installation | undefined;
  let defaultInstallation: Installation | undefined;
  let unverifiedPath: string | undefined;
  const deadline = Date.now() + 12_000;
  const probe = options.probe ?? (async (path: string) => {
    const { stdout } = await exec(path, ["--version"], { timeout: Math.max(1, Math.min(2_000, deadline - Date.now())), maxBuffer: 16_384, encoding: "utf8",
      env: { ...environment, PATH: `${dirname(path)}${platform === "win32" ? ";" : ":"}${environment.PATH ?? ""}` } });
    return /^codex-cli\s+(\d+\.\d+\.\d+)\s*$/m.exec(stdout)?.[1] ?? null;
  });
  for (const [path, fromPath] of candidates) {
    if (Date.now() >= deadline || seen.size >= 32) break;
    try {
      const canonical = await realpath(path);
      if (canonical === managed || /[\\/]agentfleet[\\/]codex[\\/]/i.test(canonical) || seen.has(canonical)) continue;
      if (!(await stat(canonical)).isFile()) continue;
      await access(canonical, constants.X_OK);
      seen.add(canonical);
      unverifiedPath ??= path;
      let found: Installation | undefined;
      try {
        if (uid === 0 && platform !== "win32") await requireRootControlledPath(canonical);
        const version = await probe(path);
        if (version && /^\d+\.\d+\.\d+$/.test(version)) found = { path, version, source: "command" };
      } catch { /* Preserve the execution safety gate; fall back to passive records. */ }
      if (!found) {
        const record = await installationRecord(canonical);
        if (record) found = { path, ...record, source: "package-record" };
      }
      if (!found) continue;
      if (fromPath && !defaultInstallation) defaultInstallation = found;
      const parts = found.version.split(".").map(Number);
      const previous = highest?.version.split(".").map(Number);
      if (!previous || parts.some((part, index) => part > previous[index]! && parts.slice(0, index).every((value, i) => value === previous[i]))) highest = found;
    } catch { /* Missing/stale/inaccessible installs must not affect the running runtime. */ }
  }
  return { hostCodexPath: highest?.path ?? unverifiedPath ?? null, hostCodexVersion: highest?.version ?? null,
    hostCodexDefaultPath: defaultInstallation?.path ?? null, hostCodexDefaultVersion: defaultInstallation?.version ?? null,
    hostCodexCheckedAt: new Date().toISOString(), hostCodexDetection: "highest-detected",
    hostCodexVersionSource: highest?.source ?? null, hostCodexMetadataPath: highest?.metadataPath ?? null,
    hostCodexDefaultVersionSource: defaultInstallation?.source ?? null };
}
