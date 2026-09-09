import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_VERSION } from "./constants.js";
import { AgentError } from "./errors.js";
import { isPathInside } from "./util.js";

export interface UpdateTransaction {
  updateId: string;
  phase: "preparing" | "staged" | "verifying" | "succeeded" | "rolled_back" | "failed";
  previousVersion: string;
  targetVersion?: string;
  targetRuntimeVersion?: string;
  targetRuntimeRevision?: string;
  backupDir: string;
  launcher: string;
  previousTarget: string;
  profilePresent: boolean;
  codexPresent: boolean;
  sandboxHelperPresent?: boolean;
  startedAt: string;
  error?: string;
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new AgentError("UPDATE_PATH_UNSAFE", "update file is not a regular file");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function stableAgentExecutable(dataDir: string): string {
  return process.platform === "win32" ? join(dataDir, "agentfleet.cmd") : join(homedir(), ".local", "bin", "agentfleet");
}

export async function readUpdateTransaction(dataDir: string): Promise<UpdateTransaction | undefined> {
  const path = join(dataDir, "update-state.json");
  if (!await regularFile(path)) return undefined;
  const value = JSON.parse(await readFile(path, "utf8")) as UpdateTransaction;
  if (typeof value.updateId !== "string" || typeof value.backupDir !== "string" || !isPathInside(join(dataDir, "updates"), value.backupDir) ||
    !["preparing", "staged", "verifying", "succeeded", "rolled_back", "failed"].includes(value.phase)) {
    throw new AgentError("UPDATE_STATE_INVALID", "persistent update transaction is invalid");
  }
  return value;
}

export async function writeUpdateTransaction(dataDir: string, value: UpdateTransaction): Promise<void> {
  const path = join(dataDir, "update-state.json");
  await regularFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

export async function prepareUpdateTransaction(dataDir: string, targetVersion: string, launcher = stableAgentExecutable(dataDir)): Promise<UpdateTransaction> {
  await mkdir(join(dataDir, "updates"), { recursive: true, mode: 0o700 });
  const metadata = await lstat(join(dataDir, "updates"));
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new AgentError("UPDATE_PATH_UNSAFE", "updates directory is not a regular directory");
  const backupDir = await mkdtemp(join(dataDir, "updates", "release-"));
  const profilePath = join(dataDir, "runtime-profile.json");
  const codexPath = join(dataDir, "codex", process.platform === "win32" ? "codex.exe" : "codex");
  const profilePresent = await regularFile(profilePath);
  const codexPresent = await regularFile(codexPath);
  const helperPath = join(dataDir, "codex", "codex-resources", "bwrap");
  const sandboxHelperPresent = process.platform === "linux" ? await regularFile(helperPath) : undefined;
  if (profilePresent) await copyFile(profilePath, join(backupDir, "runtime-profile.json"));
  if (codexPresent) await copyFile(codexPath, join(backupDir, "codex"));
  if (sandboxHelperPresent) await copyFile(helperPath, join(backupDir, "bwrap"));
  const previousTarget = process.platform === "win32"
    ? (await readFile(join(dataDir, "bin", "current.txt"), "utf8")).trim()
    : await readlink(launcher);
  if (process.platform === "win32" && !/^\d+\.\d+\.\d+$/.test(previousTarget)) throw new AgentError("UPDATE_STATE_INVALID", "Windows release pointer must contain a version");
  if (process.platform !== "win32" && !isPathInside(join(dirname(dataDir), "agentfleet", "bin"), previousTarget) &&
    !isPathInside(join(homedir(), ".local", "share", "agentfleet", "bin"), previousTarget)) {
    throw new AgentError("UPDATE_PATH_UNSAFE", "current launcher does not target an AgentFleet release");
  }
  const transaction: UpdateTransaction = { updateId: randomUUID(), phase: "preparing", previousVersion: AGENT_VERSION,
    targetVersion, backupDir, launcher, previousTarget, profilePresent, codexPresent, ...(sandboxHelperPresent !== undefined ? { sandboxHelperPresent } : {}), startedAt: new Date().toISOString() };
  await writeUpdateTransaction(dataDir, transaction);
  return transaction;
}

export async function restoreUpdateTransaction(dataDir: string, transaction: UpdateTransaction, reason: string): Promise<void> {
  if (!isPathInside(join(dataDir, "updates"), transaction.backupDir) || transaction.launcher !== stableAgentExecutable(dataDir)) {
    throw new AgentError("UPDATE_PATH_UNSAFE", "rollback transaction does not belong to this installation");
  }
  for (const [present, source, destination] of [
    [transaction.profilePresent, join(transaction.backupDir, "runtime-profile.json"), join(dataDir, "runtime-profile.json")],
    [transaction.codexPresent, join(transaction.backupDir, "codex"), join(dataDir, "codex", process.platform === "win32" ? "codex.exe" : "codex")],
    ...((transaction.sandboxHelperPresent !== undefined && process.platform === "linux") ? [[transaction.sandboxHelperPresent, join(transaction.backupDir, "bwrap"), join(dataDir, "codex", "codex-resources", "bwrap")] as const] : []),
  ] as const) {
    const exists = await regularFile(destination);
    if (present) {
      if (!await regularFile(source)) throw new AgentError("ROLLBACK_BACKUP_MISSING", "update rollback backup is missing");
      const temporary = `${destination}.${randomUUID()}.restore`;
      await copyFile(source, temporary);
      await rename(temporary, destination);
    } else if (exists) await unlink(destination);
  }
  if (process.platform === "win32") {
    if (!/^\d+\.\d+\.\d+$/.test(transaction.previousTarget)) throw new AgentError("UPDATE_STATE_INVALID", "Windows rollback pointer is invalid");
    await writeFile(join(dataDir, "bin", "current.txt"), transaction.previousTarget, { mode: 0o600 });
  } else {
    const binaryRoot = join(homedir(), ".local", "share", "agentfleet", "bin");
    const otherRoot = join(dataDir, "bin");
    if (!isPathInside(binaryRoot, transaction.previousTarget) && !isPathInside(otherRoot, transaction.previousTarget)) throw new AgentError("UPDATE_PATH_UNSAFE", "rollback target is outside managed releases");
    const temporary = `${transaction.launcher}.${randomUUID()}.restore`;
    await symlink(transaction.previousTarget, temporary);
    await rename(temporary, transaction.launcher);
  }
  await writeUpdateTransaction(dataDir, { ...transaction, phase: "rolled_back", error: reason.slice(0, 500) });
}

/** Read only this worker's acknowledgement; never publish the supervisor token. */
export async function workerHealthDiagnostics(dataDir: string): Promise<Record<string, unknown>> {
  const token = process.env.AGENTFLEET_SUPERVISOR_TOKEN;
  const supervised = process.env.AGENTFLEET_SUPERVISED === "1";
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) return { supervised, tokenPresent: false, acknowledgement: "missing_token" };
  const path = join(dataDir, `worker-health-${token}.json`);
  try {
    if (!await regularFile(path)) return { supervised, tokenPresent: true, acknowledgement: "missing" };
    const health = JSON.parse(await readFile(path, "utf8")) as { token?: unknown; version?: unknown; runtimeVersion?: unknown };
    return { supervised, tokenPresent: true, acknowledgement: health.token === token ? "written" : "token_mismatch",
      version: typeof health.version === "string" ? health.version.slice(0, 32) : null,
      runtimeVersion: typeof health.runtimeVersion === "string" ? health.runtimeVersion.slice(0, 32) : null };
  } catch (error) { return { supervised, tokenPresent: true, acknowledgement: "unreadable", errorCode: error instanceof AgentError ? error.code : "HEALTH_ACK_READ_FAILED" }; }
}

export async function writeWorkerHealth(dataDir: string, runtimeVersion?: string): Promise<void> {
  const token = process.env.AGENTFLEET_SUPERVISOR_TOKEN;
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) return;
  await writeFile(join(dataDir, `worker-health-${token}.json`), JSON.stringify({ token, version: AGENT_VERSION, runtimeVersion }), { mode: 0o600 });
}

/** This parent uses its already-running version even when the child launcher is upgraded. */
export function shouldRestartWorker(exitCode: number | null, rolledBack: boolean): boolean {
  // A timed-out worker handles SIGTERM gracefully and commonly returns zero.
  // That must not stop the service after we have restored its previous release.
  return rolledBack || exitCode !== 0;
}

export function workerStopExitCode(supervised: boolean): number {
  // Older supervisors stop on zero even after rollback. A supervised child
  // requests a restart; the parent's abort signal still wins on service stop.
  return supervised ? 75 : 0;
}

export async function superviseAgent(dataDir: string, signal: AbortSignal): Promise<void> {
  const launcher = stableAgentExecutable(dataDir);
  while (!signal.aborted) {
    let transaction = await readUpdateTransaction(dataDir);
    if (transaction?.phase === "preparing") {
      await restoreUpdateTransaction(dataDir, transaction, "update process stopped before activation completed");
      transaction = await readUpdateTransaction(dataDir);
    }
    const verifying = transaction?.phase === "staged" || transaction?.phase === "verifying";
    if (verifying && transaction) await writeUpdateTransaction(dataDir, { ...transaction, phase: "verifying" });
    const token = randomUUID();
    const healthPath = join(dataDir, `worker-health-${token}.json`);
    const environment = { ...process.env, AGENTFLEET_SUPERVISED: "1", AGENTFLEET_SUPERVISOR_TOKEN: token,
      AGENTFLEET_WORKER_EXECUTABLE: launcher, AGENTFLEET_WORKER_DATA_DIR: dataDir };
    const child = process.platform === "win32"
      ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "& $env:AGENTFLEET_WORKER_EXECUTABLE run --data-dir $env:AGENTFLEET_WORKER_DATA_DIR; exit $LASTEXITCODE"], { env: environment, stdio: "inherit", windowsHide: true })
      : spawn(launcher, ["run", "--data-dir", dataDir], { env: environment, stdio: "inherit", detached: true });
    let healthy = false;
    let timedOut = false;
    const terminate = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch { /* child already exited */ }
    };
    signal.addEventListener("abort", terminate, { once: true });
    const timeout = verifying ? setTimeout(() => { timedOut = true; terminate(); }, 90_000) : undefined;
    let checking = false;
    const healthCheck = setInterval(() => {
      if (checking || healthy) return;
      checking = true;
      void (async () => {
        if (!await regularFile(healthPath)) return;
        const health = JSON.parse(await readFile(healthPath, "utf8")) as { token?: string; version?: string; runtimeVersion?: string };
        if (health.token !== token || (verifying && health.version !== transaction?.targetVersion)) return;
        if (verifying && transaction?.targetRuntimeVersion && health.runtimeVersion !== transaction.targetRuntimeVersion) return;
        healthy = true;
        if (timeout) clearTimeout(timeout);
        if (verifying && transaction) await writeUpdateTransaction(dataDir, { ...transaction, phase: "succeeded" });
      })().catch(() => undefined).finally(() => { checking = false; });
    }, 1_000);
    const code = await new Promise<number | null>((finish) => {
      child.once("error", () => finish(null));
      child.once("exit", (exitCode) => finish(exitCode));
    });
    clearInterval(healthCheck);
    if (timeout) clearTimeout(timeout);
    signal.removeEventListener("abort", terminate);
    await unlink(healthPath).catch(() => undefined);
    if (signal.aborted) return;
    const rolledBack = Boolean(verifying && !healthy && transaction);
    if (rolledBack && transaction) {
      await restoreUpdateTransaction(dataDir, transaction, timedOut ? "new agent did not become healthy within 90 seconds" : `new agent exited before health confirmation (${code ?? "spawn error"})`);
    }
    if (!shouldRestartWorker(code, rolledBack)) return;
    if (code !== 75) await new Promise<void>((finish) => { const timer = setTimeout(finish, 5_000); signal.addEventListener("abort", () => { clearTimeout(timer); finish(); }, { once: true }); });
  }
}
