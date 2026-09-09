import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentError } from "./errors.js";
import type { StateStore } from "./store.js";
import { prepareUpdateTransaction, readUpdateTransaction, restoreUpdateTransaction, writeUpdateTransaction } from "./supervisor.js";
import { parseManagedRuntimeTarget, prepareManagedRuntime } from "./managed-runtime-update.js";

const MAX_MANIFEST_BYTES = 64 * 1_024;
const MAX_INSTALLER_BYTES = 512 * 1_024;
const UPDATE_TIMEOUT_MS = 10 * 60_000;

type FetchLike = typeof fetch;

export type UpdateCheckResult = "current" | "busy" | "staged";

export function compareReleaseVersions(left: string, right: string): number {
  const parse = (value: string): number[] => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) {
      throw new AgentError("UPDATE_VERSION_INVALID", `invalid AgentFleet release version: ${value}`);
    }
    return value.split(".").map((part) => Number.parseInt(part, 10));
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function fetchBoundedText(
  fetchImpl: FetchLike,
  url: string,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchImpl(url, {
    ...(signal === undefined ? {} : { signal }),
    redirect: "error",
    headers: { accept: "application/json, text/plain;q=0.9" },
  });
  if (!response.ok) throw new AgentError("UPDATE_DOWNLOAD_FAILED", `update download returned HTTP ${response.status}`);
  const contents = await response.text();
  if (Buffer.byteLength(contents, "utf8") > maximumBytes) {
    throw new AgentError("UPDATE_DOWNLOAD_INVALID", "update response exceeded its size limit");
  }
  return contents;
}

function releaseVersionFromManifest(contents: string): string {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw new AgentError("UPDATE_MANIFEST_INVALID", "release manifest is not valid JSON");
  }
  if (
    typeof value !== "object" || value === null ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (value as { version?: unknown }).version !== "string"
  ) {
    throw new AgentError("UPDATE_MANIFEST_INVALID", "release manifest has an unsupported shape");
  }
  const version = (value as { version: string }).version;
  compareReleaseVersions(version, version);
  return version;
}

export async function stageAgentUpdate(options: {
  installer: string;
  controlPlaneUrl: string;
  dataDir: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (process.platform === "win32") {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "agentfleet-update-"));
    const installerPath = join(temporaryDirectory, "install.ps1");
    try {
      await writeFile(installerPath, options.installer, { encoding: "utf8", mode: 0o600 });
      await runInstaller("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", installerPath, "-Mode", "Stage", "-Url", options.controlPlaneUrl,
      ], undefined, options.signal);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    return;
  }
  await runInstaller("/bin/sh", [
    "-s", "--", "--stage-only", "--url", options.controlPlaneUrl, "--data-dir", options.dataDir,
  ], options.installer, options.signal);
}

async function runInstaller(
  executable: string,
  args: string[],
  stdin: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      env: process.env,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let output = "";
    const capture = (chunk: Buffer) => {
      if (output.length < 64 * 1_024) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.stdin?.on("error", () => undefined);
    const timeout = setTimeout(() => child.kill("SIGKILL"), UPDATE_TIMEOUT_MS);
    timeout.unref();
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code, closeSignal) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        reject(signal.reason);
      } else if (code === 0) {
        resolve();
      } else {
        reject(new AgentError(
          "UPDATE_INSTALL_FAILED",
          `AgentFleet update installer failed (${closeSignal ?? `exit ${code ?? "unknown"}`}): ${output.trim().slice(-2_000)}`,
        ));
      }
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

export interface AgentAutoUpdaterOptions {
  currentVersion: string;
  controlPlaneUrl: string;
  dataDir: string;
  canUpdate(): boolean;
  onStaged(version: string): void;
  logger: { info(message: string): void; warn(message: string): void };
  initialDelayMs?: number;
  intervalMs?: number;
  fetchImpl?: FetchLike;
  stageUpdate?: typeof stageAgentUpdate;
  store?: StateStore;
  onPhase?: (phase: string, version: string) => void;
  runtimeSource?: "managed" | "host";
  currentRuntimeVersion?: string;
  needsRuntimeRepair?: () => boolean;
  prepareRuntime?: typeof prepareManagedRuntime;
  onError?: (message: string) => void;
}

export class AgentAutoUpdater {
  private readonly options: AgentAutoUpdaterOptions;
  private readonly fetchImpl: FetchLike;
  private readonly stageUpdate: typeof stageAgentUpdate;
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private stopped = false;
  private checkActive: Promise<UpdateCheckResult> | undefined;

  constructor(options: AgentAutoUpdaterOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.stageUpdate = options.stageUpdate ?? stageAgentUpdate;
  }

  start(): void {
    if (this.stopped || this.timer || this.active) return;
    this.schedule(this.options.initialDelayMs ?? 30_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort(new AgentError("UPDATE_STOPPED", "automatic updater stopped"));
    await this.active?.catch(() => undefined);
  }

  async checkNow(signal?: AbortSignal): Promise<UpdateCheckResult> {
    if (this.checkActive) return this.checkActive;
    this.checkActive = this.performCheck(signal).catch(async (error) => {
      this.options.onError?.(error instanceof Error ? error.message.slice(0, 500) : "更新失败");
      await this.options.store?.setMaintenanceDrain(undefined);
      throw error;
    }).finally(() => { this.checkActive = undefined; });
    return this.checkActive;
  }

  private async performCheck(signal?: AbortSignal): Promise<UpdateCheckResult> {
    const baseUrl = this.options.controlPlaneUrl.replace(/\/$/, "");
    const manifest = await fetchBoundedText(
      this.fetchImpl,
      `${baseUrl}/downloads/manifest.json`,
      MAX_MANIFEST_BYTES,
      signal,
    );
    const availableVersion = releaseVersionFromManifest(manifest);
    if (compareReleaseVersions(availableVersion, this.options.currentVersion) <= 0) return this.performRuntimeCheck(signal);
    const failed = this.options.store ? await readUpdateTransaction(this.options.dataDir) : undefined;
    if (failed && ["rolled_back", "failed"].includes(failed.phase) && failed.targetVersion === availableVersion) {
      throw new AgentError("UPDATE_ROLLOUT_PAUSED", "this release previously failed on this host; waiting for a corrected release");
    }
    if (this.options.store) {
      const drain = this.options.store.snapshot().maintenanceDrain;
      await this.options.store.setMaintenanceDrain(drain?.operationId ?? `agent-update-${availableVersion}`);
    }
    this.options.onPhase?.("waiting_for_idle", availableVersion);
    if (!this.options.canUpdate()) return "busy";
    const installerPath = process.platform === "darwin" ? "/install-macos" : process.platform === "win32" ? "/install.ps1" : "/install";
    const installer = await fetchBoundedText(
      this.fetchImpl,
      `${baseUrl}${installerPath}`,
      MAX_INSTALLER_BYTES,
      signal,
    );
    if (process.platform === "win32" ? !installer.startsWith("param(") : !installer.startsWith("#!/bin/sh\n")) {
      throw new AgentError("UPDATE_INSTALLER_INVALID", "downloaded installer is not an AgentFleet platform installer");
    }
    if (!this.options.canUpdate()) return "busy";
    const transaction = this.options.store ? await prepareUpdateTransaction(this.options.dataDir, availableVersion) : undefined;
    try {
      this.options.onPhase?.("installing", availableVersion);
      await this.stageUpdate({
        installer,
        controlPlaneUrl: baseUrl,
        dataDir: this.options.dataDir,
        ...(signal === undefined ? {} : { signal }),
      });
      if (transaction) await writeUpdateTransaction(this.options.dataDir, { ...transaction, phase: "staged" });
      this.options.onPhase?.("restarting", availableVersion);
    } catch (error) {
      if (transaction) await restoreUpdateTransaction(this.options.dataDir, transaction, error instanceof Error ? error.message : String(error));
      await this.options.store?.setMaintenanceDrain(undefined);
      throw error;
    }
    this.options.onStaged(availableVersion);
    return "staged";
  }

  private async performRuntimeCheck(signal?: AbortSignal): Promise<UpdateCheckResult> {
    if (this.options.runtimeSource !== "managed" || !this.options.currentRuntimeVersion || !this.options.store) return "current";
    const response = await this.fetchImpl(`${this.options.controlPlaneUrl.replace(/\/$/, "")}/api/runtime-release/target`, { redirect: "error", signal: signal ?? AbortSignal.timeout(15_000) });
    if (response.status === 404) return "current";
    if (!response.ok) throw new AgentError("RUNTIME_TARGET_UNAVAILABLE", `托管目标检查失败 HTTP ${response.status}`);
    const contents = await response.text(); if (contents.length > MAX_MANIFEST_BYTES) throw new AgentError("RUNTIME_TARGET_INVALID", "托管目标信息超限");
    const target = parseManagedRuntimeTarget(JSON.parse(contents).target);
    if (!target || (target.version === this.options.currentRuntimeVersion && !this.options.needsRuntimeRepair?.()) || (!target.rollback && compareReleaseVersions(target.version, this.options.currentRuntimeVersion) < 0)) {
      if (this.options.store.snapshot().maintenanceDrain?.operationId.startsWith("runtime-update-")) await this.options.store.setMaintenanceDrain(undefined);
      return "current";
    }
    const failed = await readUpdateTransaction(this.options.dataDir);
    if (failed && ["rolled_back", "failed"].includes(failed.phase) && failed.targetRuntimeRevision === target.revision) throw new AgentError("RUNTIME_ROLLOUT_PAUSED", "这个托管版本在本机更新失败并已回退，等待新的验证目标");
    const drain = this.options.store.snapshot().maintenanceDrain;
    await this.options.store.setMaintenanceDrain(drain?.operationId ?? `runtime-update-${target.revision}`);
    this.options.onPhase?.("waiting_for_idle", target.version);
    if (!this.options.canUpdate()) return "busy";
    this.options.onPhase?.("validating_runtime", target.version);
    const activate = await (this.options.prepareRuntime ?? prepareManagedRuntime)({ dataDir: this.options.dataDir, controlPlaneUrl: this.options.controlPlaneUrl, target, ...(signal ? { signal } : {}) });
    if (signal?.aborted) throw signal.reason;
    if (!this.options.canUpdate()) return "busy";
    const transaction = { ...await prepareUpdateTransaction(this.options.dataDir, this.options.currentVersion), targetRuntimeVersion: target.version, targetRuntimeRevision: target.revision };
    try {
      await writeUpdateTransaction(this.options.dataDir, transaction);
      await activate();
      await writeUpdateTransaction(this.options.dataDir, { ...transaction, phase: "staged" });
    } catch (error) {
      await restoreUpdateTransaction(this.options.dataDir, transaction, error instanceof Error ? error.message : "托管切换失败");
      throw error;
    }
    this.options.onStaged(this.options.currentVersion);
    return "staged";
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.controller = new AbortController();
      this.active = this.runCheck(this.controller.signal).finally(() => {
        this.active = undefined;
        this.controller = undefined;
      });
    }, delayMs);
    this.timer.unref();
  }

  private async runCheck(signal: AbortSignal): Promise<void> {
    let result: UpdateCheckResult = "current";
    try {
      result = await this.checkNow(signal);
      if (result === "staged") return;
    } catch (error) {
      if (!signal.aborted) {
        this.options.logger.warn(`automatic update check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (this.stopped || signal.aborted) return;
    this.schedule(result === "busy" ? 60_000 : this.options.intervalMs ?? (this.options.runtimeSource === "managed" ? 15 * 60_000 : 6 * 60 * 60_000));
  }
}
