import { AGENT_VERSION } from "./constants.js";
import { AgentError, publicError } from "./errors.js";
import type { AgentRuntime } from "./runtime.js";
import type { StateStore } from "./store.js";
import type { MaintenanceOperation, MaintenanceType } from "./types.js";
import type { AgentAutoUpdater } from "./updater.js";
import { readUpdateTransaction, workerHealthDiagnostics } from "./supervisor.js";
import { collectServiceDiagnostics } from "./service-diagnostics.js";
import { delay } from "./util.js";

const TYPES: readonly MaintenanceType[] = ["catalog.refresh", "agent.update", "runtime.reconnect", "diagnostics.collect", "session.reconcile", "commands.reconcile", "images.preview", "images.clean"];

export class AgentMaintenance {
  private readonly active = new Set<string>();
  constructor(private readonly options: {
    store: StateStore; runtime: AgentRuntime; updater?: AgentAutoUpdater;
    report(result: Record<string, unknown>): void; signal: AbortSignal;
  }) {}

  private report(operation: MaintenanceOperation): void {
    this.options.report({ operationId: operation.operationId, state: operation.state,
      ...(operation.result ? { result: operation.result } : {}), ...(operation.error ? { error: operation.error } : {}) });
  }

  private async reconcileUpdate(operation: MaintenanceOperation): Promise<boolean> {
    if (operation.state !== "running" || operation.operationType !== "agent.update") return false;
    const transaction = await readUpdateTransaction(this.options.store.dataDir);
    if (!transaction || transaction.startedAt < operation.createdAt) return false;
    if (["preparing", "staged", "verifying"].includes(transaction.phase)) {
      this.report({ ...operation, result: { phase: transaction.phase,
        health: await workerHealthDiagnostics(this.options.store.dataDir),
        readiness: this.options.runtime.getDiscoveryStatus?.(),
        targetVersion: transaction.targetVersion, targetRuntimeVersion: transaction.targetRuntimeVersion,
      } });
      return true;
    }
    const succeeded = transaction.phase === "succeeded" && transaction.targetVersion === AGENT_VERSION;
    const completed: MaintenanceOperation = { ...operation, state: succeeded ? "succeeded" : "failed", updatedAt: new Date().toISOString(),
      result: { version: AGENT_VERSION, phase: transaction.phase },
      ...(succeeded ? {} : { error: { code: "UPDATE_ROLLED_BACK", message: transaction.error ?? "the update was rolled back" } }) };
    await this.options.store.recordMaintenance(completed);
    if (this.options.store.snapshot().maintenanceDrain?.operationId === operation.operationId) await this.options.store.setMaintenanceDrain(undefined);
    this.report(completed);
    return true;
  }

  async replay(): Promise<void> {
    for (const operation of Object.values(this.options.store.snapshot().maintenanceOperations)) {
      if (operation.state === "running" && ["images.preview", "images.clean"].includes(operation.operationType) && !this.active.has(operation.operationId) && (operation.operationType === "images.clean" || operation.expiresAt && Date.parse(operation.expiresAt) <= Date.now())) {
        const stopped: MaintenanceOperation = { ...operation, state: "failed", updatedAt: new Date().toISOString(), error: { code: "IMAGE_CLEANUP_UNCONFIRMED", message: "图片操作已中断或过期，请重新预览核验；不会自动重试清理" } };
        await this.options.store.recordMaintenance(stopped); this.report(stopped); continue;
      }
      if (!await this.reconcileUpdate(operation)) {
        this.report(operation);
        if (operation.state === "running" && !this.active.has(operation.operationId)) {
          void this.handle({ operationId: operation.operationId, operationType: operation.operationType, expiresAt: operation.expiresAt, recoveryTarget: operation.recoveryTarget, commands: operation.commands }).catch(() => undefined);
        }
      }
    }
  }

  async handle(offer: Record<string, unknown>): Promise<void> {
    if (typeof offer.operationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(offer.operationId) ||
      typeof offer.operationType !== "string" || !TYPES.includes(offer.operationType as MaintenanceType)) {
      throw new AgentError("MAINTENANCE_INVALID", "host operation is not in the maintenance allowlist");
    }
    const operationId = offer.operationId;
    const operationType = offer.operationType as MaintenanceType;
    const previous = this.options.store.snapshot().maintenanceOperations[operationId];
    const expiresAt = typeof offer.expiresAt === "string" ? offer.expiresAt : previous?.expiresAt;
    if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
      throw new AgentError("OPERATION_EXPIRED", "host operation has expired and will not be executed");
    }
    if (previous && previous.operationType !== operationType) throw new AgentError("MAINTENANCE_CONFLICT", "operation id already identifies a different action");
    if (previous?.state === "succeeded" || previous?.state === "failed" || this.active.has(operationId)) {
      if (previous) this.report(previous);
      return;
    }
    if (previous && operationType === "images.clean") {
      const stopped: MaintenanceOperation = { ...previous, state: "failed", error: { code: "IMAGE_CLEANUP_UNCONFIRMED", message: "清理曾启动但未收到完整回执，请重新预览核验；不会自动重试" }, updatedAt: new Date().toISOString() };
      await this.options.store.recordMaintenance(stopped); this.report(stopped); return;
    }
    if (previous && await this.reconcileUpdate(previous)) return;
    this.active.add(operationId);
    const timestamp = new Date().toISOString();
    let operation: MaintenanceOperation = { operationId, operationType, state: "running", createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp, ...(expiresAt ? { expiresAt } : {}) };
    const progress = async (result: Record<string, unknown>) => {
      operation = { ...operation, result, updatedAt: new Date().toISOString() };
      await this.options.store.recordMaintenance(operation);
      this.report(operation);
    };
    if (["session.reconcile", "images.preview", "images.clean"].includes(operationType)) operation.recoveryTarget = previous?.recoveryTarget ?? (offer.recoveryTarget as Record<string, unknown>);
    if (operationType === "commands.reconcile" && Array.isArray(offer.commands) && offer.commands.length <= 20 && offer.commands.every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id))) operation.commands = offer.commands;
    await progress({ phase: "running" });
    let staged = false;
    try {
      let result: Record<string, unknown>;
      if (operationType === "images.preview" || operationType === "images.clean") {
        if (!operation.recoveryTarget) throw new AgentError("IMAGE_SCOPE_INVALID", "缺少会话清理目标");
        result = await this.options.runtime.manageSessionImages(operation.recoveryTarget, operationType === "images.clean");
      } else if (operationType === "session.reconcile") {
        if (!operation.recoveryTarget || typeof operation.recoveryTarget !== "object" || Array.isArray(operation.recoveryTarget)) throw new AgentError("RECOVERY_TARGET_INVALID", "缺少会话核验目标");
        result = await this.options.runtime.recoverFrozenSession(operation.recoveryTarget);
      } else if (operationType === "commands.reconcile") {
        // Read journal evidence only. Never pass these IDs into command execution.
        const requests = offer.commands ?? previous?.commands;
        if (!Array.isArray(requests) || requests.length > 20 || requests.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id))) {
          throw new AgentError("RECOVERY_REQUEST_INVALID", "请重新发起主机回执核验");
        }
        const state = this.options.store.snapshot();
        const commands = requests.map(commandId => {
          const journal = state.commandJournal[commandId];
          if (!journal) return { commandId, state: "missing" };
          const inbox = state.inbox[journal.canonicalAttemptId];
          if (!inbox || inbox.commandId !== commandId || inbox.envelopeHash !== journal.envelopeHash || inbox.state !== journal.state) return { commandId, state: "conflict" };
          const response = journal.response && typeof journal.response === "object" ? journal.response as Record<string, unknown> : {};
          const safeResponse = Object.fromEntries(["nativeThreadId", "nativeTurnId", "status", "claimed", "released", "writerReleased", "hostThreadPreserved", "title", "archived", "forkedNativeThreadId"]
            .filter(key => ["string", "number", "boolean"].includes(typeof response[key]) && String(response[key]).length <= 1000).map(key => [key, response[key]]));
          if (Array.isArray(response.deletedNativeThreadIds) && response.deletedNativeThreadIds.length <= 50 && response.deletedNativeThreadIds.every(id=>typeof id==="string"&&id.length<=256)) safeResponse.deletedNativeThreadIds=response.deletedNativeThreadIds;
          const thread = typeof response.nativeThreadId === "string" ? state.managedThreads[response.nativeThreadId] : undefined;
          const terminal = thread && thread.lastTurnId === response.nativeTurnId && thread.activeTurnId !== response.nativeTurnId && ["completed", "failed", "interrupted"].includes(thread.lastTurnStatus ?? "") ? thread.lastTurnStatus : undefined;
          return { commandId, attemptId: journal.canonicalAttemptId, state: journal.state, commandType: journal.commandType,
            response: safeResponse, ...(journal.error ? { error: { code: journal.error.code.slice(0,100), message: journal.error.message.slice(0,1000) } } : {}),
            ...(terminal ? { terminalStatus: terminal } : {}) };
        });
        result = { commands, readOnly: true };
      } else if (operationType === "diagnostics.collect") {
        await this.options.runtime.refreshDiagnostics();
        const state = this.options.store.snapshot();
        result = { serviceDiagnostics: await collectServiceDiagnostics(this.options.store.dataDir), agentVersion: AGENT_VERSION, support: this.options.runtime.support,
          discovery: this.options.runtime.getDiscoveryStatus(), outboxDepth: state.outbox.length,
          pendingApprovals: Object.values(state.approvals).filter((entry) => entry.state === "pending").length,
          canRestart: this.options.store.canSafelyRestart() };
      } else if (operationType === "catalog.refresh") {
        const deadline = Date.now() + 120_000;
        do {
          result = await this.options.runtime.refreshCatalog();
          if (result.state === "ready") break;
          await progress(result);
          if (Date.now() > deadline) throw new AgentError("CATALOG_REFRESH_TIMEOUT", "catalog is still scanning; inspect the host discovery progress");
          await delay(250, this.options.signal);
        } while (!this.options.signal.aborted);
      } else if (operationType === "runtime.reconnect") {
        await this.options.store.setMaintenanceDrain(operationId);
        await this.options.runtime.reconnectRuntime();
        result = { reconnected: true, discovery: this.options.runtime.getDiscoveryStatus() };
      } else {
        if (!this.options.updater) throw new AgentError("UPDATE_SERVICE_REQUIRED", "automatic updates require an installed AgentFleet service");
        await this.options.store.setMaintenanceDrain(operationId);
        while (true) {
          if (expiresAt && Date.parse(expiresAt) <= Date.now()) throw new AgentError("OPERATION_EXPIRED", "update expired while waiting for idle");
          await progress({ phase: this.options.store.canSafelyRestart() ? "installing" : "waiting_for_idle" });
          const outcome = await this.options.updater.checkNow(this.options.signal);
          if (outcome === "staged") {
            staged = true;
            await progress({ phase: "restarting" });
            return;
          }
          if (outcome === "current") { result = { version: AGENT_VERSION, phase: "current" }; break; }
          await delay(5_000, this.options.signal);
        }
      }
      operation = { ...operation, state: "succeeded", result: result!, updatedAt: new Date().toISOString() };
      await this.options.store.recordMaintenance(operation);
      this.report(operation);
    } catch (error) {
      if (!this.options.signal.aborted) {
        operation = { ...operation, state: "failed", error: publicError(error), updatedAt: new Date().toISOString() };
        await this.options.store.recordMaintenance(operation);
        this.report(operation);
      }
    } finally {
      this.active.delete(operationId);
      if (!staged && this.options.store.snapshot().maintenanceDrain?.operationId === operationId) await this.options.store.setMaintenanceDrain(undefined);
    }
  }
}
