import { readNativeUsage } from "./native-usage.js";
import { nativeImageCleanup } from "./native-image-cleanup.js";
import { randomUUID } from "node:crypto";
import { setImmediate as yieldToIO } from "node:timers/promises";
import { parseImages } from "./images.js";
import { permissionProfile } from "./permissions.js";
import {
  AGENT_VERSION,
  ALLOWED_COMMAND_TYPES,
  APP_SERVER_RESTART_BASE_MS,
  APP_SERVER_RESTART_MAX_MS,
  FLEET_PROTOCOL_VERSION,
  POLICY_VERSION,
} from "./constants.js";
import {
  type AppEvent,
  type AppServerCallbacks,
  type AppServerClient,
  type ThreadHistorySnapshot,
  type VolatileAppEvent,
} from "./app-server.js";
import { SessionAppServer } from "./session-app-server.js";
import { AgentError, publicError } from "./errors.js";
import { CatalogSyncScheduler, CodexCatalogWatcher, CATALOG_RECONCILE_MS } from "./catalog-sync.js";
import { detectHostCodex } from "./host-codex.js";
import { refreshEnvironmentChecks } from "./platform.js";
import { check } from "./preflight.js";
import { validateSettings } from "./codex-settings.js";
import { inputAnswers, inputQuestions } from "./user-input.js";
import type { MachineIdentity } from "./identity.js";
import { discoverProjectFromCwd, projectById, verifyProjectIdentity, verifySessionCwd } from "./projects.js";
import type { EventInput, StateStore } from "./store.js";
import { selectDurableStreams } from "./stream-selection.js";
import type {
  ApprovalRecord,
  DiscoveredThread,
  DurableAgentEvent,
  FleetCommand,
  ManagedThread,
  PairingCredential,
  ProjectCommandReservation,
  ProjectRecord,
  SupportReport,
} from "./types.js";
import { canonicalJson, delay, isRecord, nowIso, requireString, sha256 } from "./util.js";

export interface RuntimeCallbacks {
  onOutboxChanged(): void;
  onVolatile(event: Record<string, unknown>): void;
  onCommandAck(ack: Record<string, unknown>): void;
  onRegistryChanged(): void;
}

function optionalString(value: unknown, name: string, maxLength = 256): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, name, { maxLength });
}

function parseCommand(value: unknown): FleetCommand {
  if (!isRecord(value)) throw new AgentError("COMMAND_INVALID", "command must be an object");
  const type = requireString(value.type, "command.type", { maxLength: 64 });
  if (!ALLOWED_COMMAND_TYPES.includes(type as (typeof ALLOWED_COMMAND_TYPES)[number])) {
    throw new AgentError("COMMAND_FORBIDDEN", `command type '${type}' is not in the AgentFleet allowlist`);
  }
  if (!isRecord(value.payload) || !isRecord(value.precondition)) {
    throw new AgentError("COMMAND_INVALID", "command payload and precondition must be objects");
  }
  const expiresAt = requireString(value.expiresAt, "command.expiresAt", { maxLength: 128 });
  if (!Number.isFinite(Date.parse(expiresAt))) throw new AgentError("COMMAND_INVALID", "command expiry is invalid");
  const transportGeneration = value.transportGeneration;
  const appServerEpoch = optionalString(value.appServerEpoch, "command.appServerEpoch");
  const contentEpoch = value.contentEpoch === undefined ? 1 : value.contentEpoch;
  if (!Number.isSafeInteger(contentEpoch) || Number(contentEpoch) < 1) {
    throw new AgentError("COMMAND_INVALID", "command contentEpoch must be a positive integer");
  }
  return {
    attemptId: requireString(value.attemptId, "command.attemptId", { maxLength: 256 }),
    commandId: requireString(value.commandId, "command.commandId", { maxLength: 256 }),
    type: type as FleetCommand["type"],
    expiresAt,
    projectId: requireString(value.projectId, "command.projectId", { maxLength: 256 }),
    logicalSessionId: requireString(value.logicalSessionId, "command.logicalSessionId", { maxLength: 256 }),
    executionSegmentId: requireString(value.executionSegmentId, "command.executionSegmentId", { maxLength: 256 }),
    contentEpoch: Number(contentEpoch),
    payload: structuredClone(value.payload),
    precondition: structuredClone(value.precondition),
    ...(transportGeneration === undefined
      ? {}
      : Number.isSafeInteger(transportGeneration)
        ? { transportGeneration: Number(transportGeneration) }
        : (() => {
            throw new AgentError("COMMAND_INVALID", "command transportGeneration is invalid");
          })()),
    ...(appServerEpoch === undefined ? {} : { appServerEpoch }),
  };
}

const KNOWN_FAILED_INVOCATION_CODES = new Set([
  "INPUT_ANSWERS_INVALID", "INPUT_QUESTIONS_INVALID", "INPUT_RESPONSE_REQUIRED",
  "CODEX_SETTINGS_INVALID", "CODEX_MODEL_UNAVAILABLE", "CODEX_EFFORT_UNAVAILABLE", "CODEX_MODE_UNAVAILABLE",
  "APP_SERVER_RPC_ERROR",
  "APP_SERVER_EPOCH_STALE",
  "APPROVAL_ALREADY_RESOLVED",
  "APPROVAL_DECISION_INVALID",
  "APPROVAL_EXPIRED",
  "PROJECT_DISCOVERY_UNAVAILABLE",
  "PROJECT_EXTERNAL_ACTIVITY",
  "APPROVAL_NOT_FOUND",
  "APPROVAL_PRECONDITION_FAILED",
  "CONTENT_EPOCH_STALE",
  "POLICY_NOT_PROVEN",
  "PRECONDITION_INVALID",
  "PROJECT_BUSY",
  "PROJECT_VERSION_CONFLICT",
  "THREAD_BUSY",
  "THREAD_RELEASE_PENDING",
  "THREAD_WRITER_BUSY",
  "THREAD_HISTORY_UNSUPPORTED",
  "THREAD_ID_MISMATCH",
  "THREAD_NOT_MANAGED",
  "THREAD_NOT_CLAIMABLE",
  "THREAD_PROJECT_MISMATCH",
  "THREAD_READ_ONLY",
  "THREAD_RESUME_MISMATCH",
  "TURN_PRECONDITION_FAILED",
]);

function isKnownFailedInvocation(error: unknown): boolean {
  return error instanceof AgentError && KNOWN_FAILED_INVOCATION_CODES.has(error.code);
}

export function commandEnvelopeHash(command: FleetCommand | Record<string, unknown>): string {
  const immutable = structuredClone(command) as Record<string, unknown>;
  delete immutable.attemptId;
  delete immutable.transportGeneration;
  delete immutable.appServerEpoch;
  delete immutable.state;
  delete immutable.payloadState;
  return sha256(canonicalJson(immutable));
}

export function appServerRestartDelay(attempt: number): number {
  const exponent = Math.max(0, Math.min(30, attempt - 1));
  return Math.min(APP_SERVER_RESTART_MAX_MS, APP_SERVER_RESTART_BASE_MS * (2 ** exponent));
}

export type AppServerFactory = (callbacks: AppServerCallbacks) => AppServerClient;

export interface AgentRuntimeOptions {
  store: StateStore;
  identity: MachineIdentity;
  pairing: PairingCredential;
  support: SupportReport;
  appServerFactory?: AppServerFactory;
  restartSleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  restartDelay?: (attempt: number) => number;
  catalogHome?: string;
  catalogSyncTiming?: { debounceMs?: number; maxWaitMs?: number; minIntervalMs?: number; fallbackMs?: number; retryMs?: number };
}

export class AgentRuntime {
  readonly producerEpoch = randomUUID();
  readonly store: StateStore;
  readonly identity: MachineIdentity;
  readonly pairing: PairingCredential;
  readonly support: SupportReport;
  private callbacks: RuntimeCallbacks = {
    onOutboxChanged: () => undefined,
    onVolatile: () => undefined,
    onCommandAck: () => undefined,
    onRegistryChanged: () => undefined,
  };
  private appServer: AppServerClient | undefined;
  private startingAppServer: AppServerClient | undefined;
  private appServerFailure: string | undefined;
  private transportGeneration: number | undefined;
  private readonly catalogSync: CatalogSyncScheduler;
  private readonly catalogWatcher: CodexCatalogWatcher | undefined;
  private discoveryRequested = false;
  private discoveryIndexOnly = false;
  private discoveryRunning = false;
  private discoveryContinuation: NodeJS.Timeout | undefined;
  private discoveryCursor: string | null = null;
  private readonly discoverySeen = new Set<string>();
  private readonly discoveryCursors = new Set<string>();
  private historySyncOffset = 0;
  private discoveryScanId = randomUUID();
  private discoveryScannedPages = 0;
  private discoverySkippedCount = 0;
  private completedDiscovery: { epoch: string; scanId: string; scannedPages: number; skippedCount: number; scannedCount: number; discoveredCount: number; lastSuccessfulAt: string } | undefined;
  private discoveryStatus: { state: "scanning" | "ready" | "error"; scannedCount: number; discoveredCount: number; lastSuccessfulAt?: string; error?: string } = {
    state: "scanning", scannedCount: 0, discoveredCount: 0,
  };
  private readonly appServerFactory: AppServerFactory;
  private readonly restartSleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly restartDelay: (attempt: number) => number;
  private restartController: AbortController | undefined;
  private restartLoop: Promise<void> | undefined;
  private shuttingDown = false;
  private hostCodexRefresh: Promise<void> | undefined;
  private hostCodexLastAttempt = Date.now();
  private readonly exitedAppServerEpochs = new Set<string>();

  getDiscoveryStatus(): Record<string, unknown> {
    // Periodic checks in the same App Server epoch do not invalidate a completed
    // catalog. Keep its visible counters while the next scan is in flight.
    // A restart or an actual scan failure must still be shown explicitly.
    const backgroundSync = this.discoveryStatus.state === "scanning" && this.completedDiscovery?.epoch === this.appServer?.appServerEpoch && !!this.appServer;
    const completed = backgroundSync ? this.completedDiscovery : undefined;
    const serverUnavailable = !this.appServer && !!this.appServerFailure;
    const visibleState = serverUnavailable ? "error" : completed ? "ready" : this.discoveryStatus.state;
    const checks = [...(this.support.checks ?? []),
      check("server", this.appServer && !this.appServerFailure ? "passed" : this.appServerFailure || !this.canRead() ? "failed" : "checking",
        this.appServer ? "APP_SERVER_CONNECTED" : "APP_SERVER_UNAVAILABLE",
        this.appServer && !this.appServerFailure ? "Codex 会话服务已连接" : "Codex 会话服务尚未连接，可尝试重新连接 Codex", "runtime.reconnect"),
      check("catalog", visibleState === "ready" ? "passed" : visibleState === "error" ? "failed" : "checking",
        visibleState === "ready" ? "CATALOG_READY" : visibleState === "error" ? "CATALOG_FAILED" : "CATALOG_SCANNING",
        visibleState === "ready" ? "项目和会话已同步，后续变化会在后台同步" : visibleState === "error" ? "会话扫描失败，已有连接会保留，可重新扫描" : "正在读取现有项目和会话", "catalog.refresh"),
    ];
    const readiness = checks.some(item => item.state === "failed") ? "action_required"
      : visibleState !== "ready" ? "checking" : this.isWritable() ? "ready" : "read_only";
    return { ...this.discoveryStatus, state: visibleState, backgroundSync,
      ...(serverUnavailable ? { error: "Codex 会话服务启动失败，项目和会话扫描暂不可用。连接服务会自动重试。" } : {}),
      syncMode: this.catalogWatcher?.mode ?? "fallback", reconcileIntervalSeconds: CATALOG_RECONCILE_MS / 1000,
      ...(completed ? { scannedCount: completed.scannedCount, discoveredCount: completed.discoveredCount, lastSuccessfulAt: completed.lastSuccessfulAt } : {}),
      scanId: completed?.scanId ?? this.discoveryScanId, discoveredProjects: this.store.snapshot().projects.length,
      discoveredSessions: completed?.discoveredCount ?? this.discoveryStatus.discoveredCount, scannedPages: completed?.scannedPages ?? this.discoveryScannedPages,
      skippedCount: completed?.skippedCount ?? this.discoverySkippedCount, readiness, checks };
  }

  readyForHealthCheck(): boolean {
    // Service health is distinct from write eligibility: a readable, connected
    // Agent must remain available to diagnose an OS sandbox restriction.
    return this.canRead() && this.appServer !== undefined && !this.appServerFailure &&
      (this.discoveryStatus.state === "ready" || (this.discoveryStatus.state === "scanning" && this.completedDiscovery?.epoch === this.appServer.appServerEpoch));
  }

  async refreshDiagnostics(): Promise<void> {
    await Promise.all([this.refreshHostCodex(true), refreshEnvironmentChecks(this.support)]);
    this.notifyRegistryChanged();
  }

  private readonly historySyncJobs = new Set<string>();
  private readonly imageMaintenanceSessions = new Set<string>();

  async manageSessionImages(target: Record<string, unknown>, clean: boolean): Promise<Record<string, unknown>> {
    const server = this.appServer;
    const id = requireString(target.nativeThreadId, "nativeThreadId", { maxLength: 256 });
    const state = this.store.snapshot();
    if (state.maintenanceDrain) throw new AgentError("MACHINE_DRAINING", "主机正在维护，请结束后再预览图片");
    const thread = state.managedThreads[id];
    const binding = state.nativeThreadBindings[id];
    if (!server || !binding || binding.codexProfileId !== this.support.codexProfile?.id || binding.logicalSessionId !== target.logicalSessionId || binding.executionSegmentId !== target.executionSegmentId || binding.contentEpoch !== target.contentEpoch) throw new AgentError("IMAGE_TARGET_CHANGED", "会话身份已变化，请重新预览");
    if (thread?.activeTurnId || state.projectReservations[binding.projectId] || Object.values(state.approvals).some(a => a.nativeThreadId === id && a.state === "pending")) throw new AgentError("THREAD_BUSY", "会话仍在运行、冻结或等待回复，请结束后清理");
    if (!Array.isArray(target.uploads) || !target.uploads.length || target.uploads.length > 100) throw new AgentError("IMAGE_SCOPE_INVALID", "图片来源记录不完整");
    if (this.historySyncJobs.has(id) || this.imageMaintenanceSessions.has(String(target.logicalSessionId)) || Object.values(state.inbox).some(e => ["received", "invoking"].includes(e.state))) throw new AgentError("THREAD_BUSY", "主机正在派发操作，请稍后预览");
    this.imageMaintenanceSessions.add(String(target.logicalSessionId));
    try {
    const turns = new Map<string, Set<string>>();
    for (const value of target.uploads) {
      if (!isRecord(value) || typeof value.commandId !== "string" || !Array.isArray(value.hashes) || value.hashes.some(h => typeof h !== "string" || !/^[a-f0-9]{64}$/.test(h))) throw new AgentError("IMAGE_SCOPE_INVALID", "图片标识不完整");
      const journal = state.commandJournal[value.commandId];
      if (journal?.state !== "applied" || !["turn.start", "turn.queue", "turn.steer"].includes(journal.commandType) || !isRecord(journal.response) || journal.response.nativeThreadId !== id || typeof journal.response.nativeTurnId !== "string") throw new AgentError("IMAGE_ORIGIN_UNPROVEN", "缺少宿主机发送回执，不能可靠定位图片所属轮次");
      const hashes = turns.get(journal.response.nativeTurnId) ?? new Set<string>();
      for (const hash of value.hashes) hashes.add(String(hash));
      turns.set(journal.response.nativeTurnId, hashes);
    }
    // Stop only this idle panel writer. External CLI writers are fenced by native flock.
    await server.unsubscribeThread(id);
    if (thread) await this.store.updateManagedThread(id, t => { t.subscribed = false; t.policyVerified = false; t.metadataRevision = (t.metadataRevision ?? 0) + 1; });
    const snapshot = await server.readThread(id, true);
    if (snapshot.nativeThreadId !== id || !snapshot.rolloutPath || snapshot.executionState === "running") throw new AgentError("IMAGE_HISTORY_UNAVAILABLE", "原生历史路径或运行状态无法核验");
    // Pending durable payloads may still contain these bytes. Wait for acknowledgement instead of changing event hashes.
    if (this.store.snapshot().outbox.some(e => e.nativeThreadId === id)) throw new AgentError("IMAGE_SYNC_PENDING", "此会话仍有历史等待同步，请稍后重新预览");
    const targets = [...turns].map(([turnId, hashes]) => ({ turnId, hashes: [...hashes] }));
    const result = await nativeImageCleanup({ home: this.support.codexProfile?.codexHome, version: this.support.codexVersion?.replace(/^codex(?:-cli)?\s+/, ""), rollout: snapshot.rolloutPath,
      threadId: id, targets, preview: !clean, expectedDigest: target.expectedDigest });
    return { ...result, logicalSessionId: target.logicalSessionId, targets, cleaned: clean };
    } finally { this.imageMaintenanceSessions.delete(String(target.logicalSessionId)); }
  }

  /** Invoked only by an explicit session.reconcile maintenance request. */
  async recoverFrozenSession(target: Record<string, unknown>): Promise<Record<string, unknown>> {
    const server = this.appServer;
    const thread = typeof target.nativeThreadId === "string" ? this.store.snapshot().managedThreads[target.nativeThreadId] : undefined;
    if (server && server.appServerEpoch !== target.appServerEpoch) throw new AgentError("RECOVERY_RUNTIME_CHANGED", "主机刚刚重连，请重新点击解除冻结");
    if (!server?.readTurnOutcome || !thread) throw new AgentError("RECOVERY_UNAVAILABLE", "主机暂时无法核验此会话");
    if (thread.logicalSessionId !== target.logicalSessionId || thread.executionSegmentId !== target.executionSegmentId || thread.contentEpoch !== target.contentEpoch) throw new AgentError("RECOVERY_TARGET_CHANGED", "会话已变化，请刷新后重新解除冻结");
    if (!thread.activeTurnId) return { recovered: false, reason: "没有待核验的旧轮次；请继续核对未知操作的主机回执" };
    if (thread.appServerEpoch === server.appServerEpoch) return { recovered: false, reason: "此轮任务仍属于当前执行进程，请等待它结束" };
    if (this.store.snapshot().projectReservations[thread.projectId]) return { recovered: false, reason: "项目仍有结果未知的操作，尚不能解除冻结" };
    const outcome = await server.readTurnOutcome(thread.nativeThreadId, thread.activeTurnId);
    const project = this.store.snapshot().projects.find(p => p.id === thread.projectId);
    if (!outcome || !project || outcome.cwd !== (thread.sessionCwd ?? project.root) || !["completed", "failed", "interrupted"].includes(outcome.status) || this.appServer !== server) return { recovered: false, reason: "主机尚未提供该轮任务的明确结束记录，继续保持冻结" };
    const recovered = await this.store.recoverPreviousRuntimeTurn(thread, {
      machineId: this.pairing.machineId, producerEpoch: this.producerEpoch, appServerEpoch: server.appServerEpoch,
      projectId: thread.projectId, logicalSessionId: thread.logicalSessionId!, executionSegmentId: thread.executionSegmentId!,
      contentEpoch: thread.contentEpoch, nativeThreadId: thread.nativeThreadId, nativeTurnId: thread.activeTurnId,
      type: outcome.status === "completed" ? "turn.completed" : outcome.status === "failed" ? "turn.failed" : "turn.interrupted",
      payload: { turn: { id: thread.activeTurnId, status: outcome.status }, recoveredFromHost: true, previousAppServerEpoch: thread.appServerEpoch },
    }, outcome.status);
    if (recovered) { this.callbacks.onOutboxChanged(); this.notifyRegistryChanged(); }
    return { recovered, previousAppServerEpoch: thread.appServerEpoch, nativeThreadId: thread.nativeThreadId, nativeTurnId: thread.activeTurnId, status: outcome.status,
      reason: recovered ? "已核验结束记录并解除冻结；原命令没有重发" : "核验期间会话状态发生变化，请刷新后重试" };
  }

  async refreshQuota(): Promise<void> { await this.appServer?.refreshQuota?.(); }

  async refreshCatalog(): Promise<Record<string, unknown>> {
    void this.appServer?.refreshQuota?.();
    if (!this.canRead()) throw new AgentError("CATALOG_READ_UNSUPPORTED", this.support.readCompatibilityReason ?? this.readOnlyReasons().join("; "));
    await this.reconcileExistingThreads();
    if (this.discoveryStatus.state === "error") throw new AgentError("CATALOG_REFRESH_FAILED", this.discoveryStatus.error ?? "catalog refresh failed");
    return this.getDiscoveryStatus();
  }

  async reconnectRuntime(): Promise<void> {
    if (!this.store.canSafelyRestart()) throw new AgentError("MACHINE_BUSY", "wait for active and uncertain work before reconnecting Codex");
    const server = this.appServer;
    this.appServer = undefined;
    await server?.stop();
    await this.startAppServerOnce();
    await this.reconcileExistingThreads();
    this.notifyRegistryChanged();
  }

  constructor(options: AgentRuntimeOptions) {
    this.store = options.store;
    this.identity = options.identity;
    this.pairing = options.pairing;
    this.support = options.support;
    this.appServerFactory = options.appServerFactory ?? ((callbacks) => new SessionAppServer(callbacks));
    this.restartSleep = options.restartSleep ?? ((milliseconds, signal) => delay(milliseconds, signal));
    this.restartDelay = options.restartDelay ?? appServerRestartDelay;
    this.catalogSync = new CatalogSyncScheduler(async change => {
      if (this.discoveryRunning || this.discoveryCursor !== null) { this.discoveryRequested = true; return; }
      if (!this.appServer || this.shuttingDown) return;
      await this.reconcileExistingThreads(change === "index");
      if (this.discoveryStatus.state === "error") throw new AgentError("CATALOG_REFRESH_FAILED", "catalog refresh failed");
    }, { ...options.catalogSyncTiming, repair: async () => { await this.catalogWatcher?.refresh(); } });
    const home = options.catalogHome ?? this.support.codexProfile?.codexHome;
    this.catalogWatcher = home ? new CodexCatalogWatcher(home, change => this.catalogSync.request(change), () => this.notifyRegistryChanged()) : undefined;
  }

  async initialize(): Promise<void> {
    await this.store.reconcileInterruptedWork();
    await this.store.beginProducerEpoch(this.producerEpoch);
    if (!this.canRead()) {
      this.discoveryStatus = { state: "error", scannedCount: 0, discoveredCount: 0,
        error: this.support.readCompatibilityReason ?? this.readOnlyReasons().join("; ") };
    }
    if (this.canRead()) {
      await this.catalogWatcher?.refresh();
      this.catalogSync.start();
      try {
        await this.startAppServerOnce();
        await this.reconcileExistingThreads();
      } catch (error) {
        this.appServerFailure = publicError(error).message;
        this.ensureRestartSupervisor();
      }
    }
  }

  setCallbacks(callbacks: RuntimeCallbacks): void {
    this.callbacks = callbacks;
  }

  setTransportGeneration(generation: number | undefined): void {
    this.transportGeneration = generation;
  }

  getAppServerEpoch(): string | undefined {
    return this.appServer?.appServerEpoch;
  }

  isWritable(): boolean {
    return this.support.writable && this.appServer !== undefined && this.appServerFailure === undefined;
  }

  private canRead(): boolean {
    return this.support.readable ?? this.support.writable;
  }

  readOnlyReasons(): string[] {
    return [
      ...this.support.readOnlyReasons,
      ...(this.appServerFailure === undefined ? [] : [`codex app-server unavailable: ${this.appServerFailure}`]),
    ];
  }

  helloPayload(): Record<string, unknown> {
    const state = this.store.snapshot();
    const { resumeStreams } = selectDurableStreams(state, this.producerEpoch);
    return {
      type: "hello",
      protocolVersion: FLEET_PROTOCOL_VERSION,
      agentVersion: AGENT_VERSION,
      machineId: this.pairing.machineId,
      producerEpoch: this.producerEpoch,
      appServerEpoch: this.getAppServerEpoch() ?? `unavailable-${this.producerEpoch}`,
      transportGeneration: this.transportGeneration ?? null,
      credentialProtectionLevel: this.identity.metadata.credentialProtectionLevel,
      policy: {
        version: POLICY_VERSION,
        cwd: "project-root",
        sandbox: "workspace-write",
        writableRoots: "selected-project-only",
        network: "disabled",
        approval: "on-request-once-only",
      },
      readOnly: !this.isWritable(),
      readOnlyReasons: this.readOnlyReasons(),
      compatibility: this.support,
      ...(this.support.codexProfile ? { codexProfile: this.support.codexProfile } : {}),
      codexCatalog: this.appServer?.getCodexCatalog?.() ?? null,
      platform: this.support.platform,
      platformRelease: this.support.osVersion,
      architecture: this.support.architecture,
      codexVersion: this.support.codexVersion,
      schemaHash: this.support.codexSchemaHash,
      capabilities: {
        paginatedHistory: this.isWritable(),
        permissionProfiles: this.isWritable(),
        methods: this.isWritable()
          ? ["thread/list", "thread/read", "thread/resume", "thread/unsubscribe", "thread/start", "turn/start", "turn/steer", "turn/interrupt", "approval/reply-once"]
          : this.canRead() && this.appServer ? ["thread/list", "thread/read"] : [],
        commandTypes: this.isWritable() ? [...ALLOWED_COMMAND_TYPES] : [],
        maintenanceTypes: ["catalog.refresh", "agent.update", "runtime.reconnect", "diagnostics.collect", "session.reconcile", "commands.reconcile", "images.preview", "images.clean"],
        queue: this.isWritable(),
        steer: this.isWritable(),
        shell: false,
        arbitraryRpc: false,
      },
      resumeStreams,
      capacity: this.capacityState(),
      discovery: this.getDiscoveryStatus(),
      maintenance: state.maintenanceDrain ?? null,
      projects: this.projectSummaries(),
      sessions: [...Object.values(state.managedThreads).flatMap((thread) => {
        if (thread.logicalSessionId === undefined || thread.executionSegmentId === undefined) return [];
        const belongsToCurrentAppServer = thread.appServerEpoch === this.getAppServerEpoch();
        return [{
          externalId: thread.logicalSessionId,
          projectExternalId: thread.projectId,
          executionSegmentExternalId: thread.executionSegmentId,
          nativeThreadId: thread.nativeThreadId,
          managed: true,
          ...(state.projectContentPolicies[thread.projectId]?.syncContent === false ? {} : thread.nativeUsage ? { nativeUsage: thread.nativeUsage } : {}),
          ...(thread.title ? { title: thread.title } : {}),
          titleSource: thread.titleSource ?? "preview",
          runtimeSettings: { observed: thread.observedSettings ?? null, accepted: thread.acceptedSettings ?? null, permissions: thread.acceptedPermissions ?? null, archived: thread.archived ?? false },
          managementRevision: state.nativeThreadBindings[thread.nativeThreadId]?.managementRevision ?? 1,
          codexProfileId: thread.codexProfileId ?? "default",
          sessionCwd: thread.sessionCwd ?? state.projects.find((project) => project.id === thread.projectId)?.root,
          executionState: !belongsToCurrentAppServer
            ? "unknown"
            : thread.activeTurnId !== undefined
              ? "running"
              : ["completed", "interrupted", "failed"].includes(thread.lastTurnStatus ?? "")
                ? thread.lastTurnStatus
                : "idle",
          threadControlVersion: 1,
          turnControlVersion: 1,
          activeTurnId: belongsToCurrentAppServer ? thread.activeTurnId ?? null : null,
          historyCompleteness: thread.historySyncInitialized ? "partial" : "unknown",
          historyMode: thread.historyMode ?? "legacy",
          contentEpoch: thread.contentEpoch ?? 1,
        }];
      }), ...Object.values(state.discoveredThreads).flatMap((thread) => thread.availability === "available" ? [{
        ...(state.projectContentPolicies[thread.projectId]?.syncContent === false ? {} : thread.nativeUsage ? { nativeUsage: thread.nativeUsage } : {}),
        externalId: thread.externalId,
        projectExternalId: thread.projectId,
        executionSegmentExternalId: thread.executionSegmentExternalId,
        title: thread.title,
        titleSource: thread.titleSource ?? "preview",
        runtimeSettings: { archived: thread.archived },
        nativeThreadId: thread.nativeThreadId,
        managed: false,
        managementRevision: state.nativeThreadBindings[thread.nativeThreadId]?.managementRevision ?? thread.managementRevision ?? 1,
        codexProfileId: thread.codexProfileId ?? "default",
        sessionCwd: thread.sessionCwd ?? state.projects.find((project) => project.id === thread.projectId)?.root,
        executionState: thread.executionState,
        threadControlVersion: 1,
        turnControlVersion: 1,
        activeTurnId: null,
        historyCompleteness: thread.historyCompleteness,
        historyMode: thread.historyMode ?? "legacy",
        contentEpoch: state.nativeThreadBindings[thread.nativeThreadId]?.contentEpoch ?? 1,
      }] : [])],
    };
  }

  projectsPayload(): Record<string, unknown> {
    return {
      type: "projects",
      machineId: this.pairing.machineId,
      producerEpoch: this.producerEpoch,
      projects: this.projectSummaries(),
    };
  }

  async advanceContentEpoch(logicalSessionId: string, contentEpoch: number): Promise<void> {
    if (!Number.isSafeInteger(contentEpoch) || contentEpoch < 1) {
      throw new AgentError("CONTENT_EPOCH_INVALID", "contentEpoch must be a positive integer");
    }
    const thread = Object.values(this.store.snapshot().managedThreads).find(
      (candidate) => candidate.logicalSessionId === logicalSessionId,
    );
    if (!thread || contentEpoch <= (thread.contentEpoch ?? 1)) return;
    await this.store.updateManagedThread(thread.nativeThreadId, (candidate) => {
      candidate.contentEpoch = contentEpoch;
    });
  }

  async setProjectContentPolicy(projectId: string, syncContent: boolean, retentionDays: number): Promise<void> {
    if (![1, 3, 7, 14, 30].includes(retentionDays)) throw new AgentError("PROJECT_POLICY_INVALID", "retentionDays is invalid");
    await this.store.setProjectContentPolicy(projectId, syncContent, retentionDays);
  }

  heartbeatPayload(): Record<string, unknown> {
    if (!this.shuttingDown) void this.refreshHostCodex().catch(() => undefined);
    const state = this.store.snapshot();
    return {
      type: "heartbeat",
      quota: this.appServer?.getQuotaSnapshot?.() ?? null,
      capacity: this.capacityState(),
      activeTurns: Object.values(state.managedThreads).filter((thread) => thread.activeTurnId !== undefined).length,
      readOnly: !this.isWritable(),
      readOnlyReasons: this.readOnlyReasons(),
      discovery: this.getDiscoveryStatus(),
      maintenance: state.maintenanceDrain ?? null,
      ...(this.support.codexProfile ? { codexProfile: this.support.codexProfile } : {}),
      ...(this.isWritable() ? {} : { unreachableReason: this.readOnlyReasons().join("; ") }),
    };
  }

  async refreshHostCodex(force = false): Promise<void> {
    if (this.hostCodexRefresh) return this.hostCodexRefresh;
    const profile = this.support.codexProfile;
    if (!profile || (!force && Date.now() - this.hostCodexLastAttempt < 300_000)) return;
    this.hostCodexLastAttempt = Date.now();
    this.hostCodexRefresh = detectHostCodex({ runtimePath: profile.runtimePath, source: profile.source }).then((detected) => {
      if (!this.shuttingDown) this.support.codexProfile = { ...profile, ...detected };
    }).finally(() => { this.hostCodexRefresh = undefined; });
    return this.hostCodexRefresh;
  }

  private projectSummaries(): Record<string, unknown>[] {
    const state = this.store.snapshot();
    return state.projects.map((project) => ({
      externalId: project.id,
      alias: project.alias,
      canonicalRoot: project.root,
      identityHash: sha256(canonicalJson({ device: project.device, inode: project.inode, root: project.root })),
      leaseVersion: project.identityVersion,
    }));
  }

  private capacityState(): "unknown" | "idle" | "busy" | "saturated" {
    if (!this.isWritable()) return "unknown";
    return Object.values(this.store.snapshot().managedThreads).some((thread) => thread.activeTurnId !== undefined)
      ? "busy"
      : "idle";
  }

  private notifyRegistryChanged(): void {
    try {
      this.callbacks.onRegistryChanged();
    } catch {
      // The relay will send the authoritative registry on its next connection;
      // a transient transport write must never stop local recovery.
    }
  }

  async handleCommand(value: unknown, deliveryGeneration: number): Promise<void> {
    let command: FleetCommand;
    try {
      command = parseCommand(value);
    } catch (error) {
      if (isRecord(value) && typeof value.attemptId === "string") {
        this.callbacks.onCommandAck({
          type: "command.ack",
          dispatchAttemptId: value.attemptId,
          state: "invalidated",
          detail: publicError(error),
        });
      }
      return;
    }
    const immutableHash = commandEnvelopeHash(value as Record<string, unknown>);
    await this.handleParsedCommand(command, deliveryGeneration, immutableHash);
  }

  private async handleParsedCommand(
    command: FleetCommand,
    deliveryGeneration: number,
    immutableHash: string,
  ): Promise<void> {
    let claimed: Awaited<ReturnType<StateStore["claimCommand"]>>;
    try {
      claimed = await this.store.claimCommand(command, immutableHash);
    } catch (error) {
      await this.emitCommandState(command, "rejected", publicError(error));
      this.ackCommand(command, "invalidated", publicError(error));
      return;
    }

    if (!claimed.isNew) {
      await this.replayCommand(command, claimed.entry);
      return;
    }

    await this.emitCommandState(command, "claimed");
    this.ackCommand(command, "claimed");
    let reservationOwner: Omit<ProjectCommandReservation, "state" | "createdAt" | "updatedAt"> | undefined;
    try {
      this.validateCommandEnvelope(command, deliveryGeneration);
      if (this.store.snapshot().maintenanceDrain && ["thread.claim", "thread.rename", "thread.archive", "thread.unarchive", "thread.fork", "thread.delete.preview", "thread.delete", "turn.start", "turn.compact", "turn.review", "turn.queue", "turn.steer"].includes(command.type)) {
        throw new AgentError("MACHINE_DRAINING", "the agent is waiting for a safe maintenance restart");
      }
      const project = projectById(this.store, command.projectId);
      await verifyProjectIdentity(project);
      if (!this.isWritable()) throw new AgentError("MACHINE_READ_ONLY", this.readOnlyReasons().join("; "));
      const server = this.appServer;
      if (!server) throw new AgentError("APP_SERVER_UNAVAILABLE", "codex app-server is not available");
      if (command.appServerEpoch !== undefined && command.appServerEpoch !== server.appServerEpoch) {
        throw new AgentError("APP_SERVER_EPOCH_STALE", "command targets a stale app-server epoch");
      }
      if (command.type === "turn.cancel") {
        const managed = Object.values(this.store.snapshot().managedThreads).find(
          (thread) => thread.logicalSessionId === command.logicalSessionId,
        );
        if (managed && (managed.appServerEpoch !== server.appServerEpoch || !managed.policyVerified)) {
          throw new AgentError("THREAD_READ_ONLY", "managed thread belongs to an exited App Server epoch");
        }
      }

      const owner = {
        projectId: project.id,
        commandId: command.commandId,
        attemptId: command.attemptId,
        envelopeHash: immutableHash,
        appServerEpoch: server.appServerEpoch,
      };
      await this.store.reserveProjectCommand(owner, ["turn.start", "turn.compact", "turn.review", "turn.queue", "thread.rename", "thread.archive", "thread.unarchive", "thread.fork", "thread.delete.preview", "thread.delete"].includes(command.type));
      reservationOwner = owner;
      await this.store.transitionCommand(command.attemptId, "claimed", "invoking");
      await this.emitCommandState(command, "invoking");
      this.ackCommand(command, "invoking");
      const response = await this.invoke(command, project, server);
      const atomicallyApplied = this.store.snapshot().inbox[command.attemptId]?.state === "applied";
      if (!atomicallyApplied) await this.store.transitionCommand(command.attemptId, "invoking", "responded", { response });
      await this.emitCommandState(command, "responded", response);
      this.ackCommand(command, "responded", { response });
      if (!atomicallyApplied) await this.store.transitionCommand(command.attemptId, "responded", "applied", { response });
      await this.store.releaseProjectCommand(reservationOwner);
      reservationOwner = undefined;
      await this.emitCommandState(command, "applied", response);
      this.ackCommand(command, "applied", { response });
      if (command.type === "thread.release") this.notifyRegistryChanged();
    } catch (error) {
      const publicFailure = publicError(error);
      const current = this.store.snapshot().inbox[command.attemptId];
      if (!current) return;
      try {
        if (current.state === "applied") {
          if (reservationOwner) await this.store.releaseProjectCommand(reservationOwner);
          reservationOwner = undefined;
          const appliedDetail = current.error ?? current.response;
          await this.emitCommandState(command, "applied", appliedDetail);
          this.ackCommand(
            command,
            "applied",
            current.error === undefined ? { response: current.response } : { ok: false, error: current.error },
          );
          return;
        }
        if (current.state === "unknown") {
          await this.emitCommandState(command, "unknown", current.error ?? publicFailure);
          this.ackCommand(command, "unknown", current.error ?? publicFailure);
          return;
        }
        if (current.state === "invoking" && isKnownFailedInvocation(error)) {
          await this.store.transitionCommand(command.attemptId, "invoking", "responded", { error: publicFailure });
          await this.emitCommandState(command, "responded", publicFailure);
          this.ackCommand(command, "responded", { error: publicFailure });
          await this.store.transitionCommand(command.attemptId, "responded", "applied", { error: publicFailure });
          if (reservationOwner) await this.store.releaseProjectCommand(reservationOwner);
          reservationOwner = undefined;
          await this.emitCommandState(command, "applied", publicFailure);
          this.ackCommand(command, "applied", { ok: false, error: publicFailure });
          return;
        }
        if (current.state === "invoking" || current.state === "responded") {
          const unknown = await this.store.markCommandUnknown(command.attemptId, publicFailure);
          await this.emitCommandState(command, "unknown", unknown.error);
          this.ackCommand(command, "unknown", unknown.error);
          return;
        }
        if (reservationOwner) await this.store.releaseProjectCommand(reservationOwner);
        reservationOwner = undefined;
        const target = "rejected";
        await this.store.transitionCommand(command.attemptId, current.state, target, { error: publicFailure });
        await this.emitCommandState(command, target, publicFailure);
        this.ackCommand(command, "invalidated", publicFailure);
      } catch {
        return;
      }
    }
  }

  private async replayCommand(command: FleetCommand, entry: Awaited<ReturnType<StateStore["claimCommand"]>>["entry"]): Promise<void> {
    const detail = entry.state === "unknown" || entry.state === "rejected"
      ? entry.error ?? entry.response
      : entry.response ?? entry.error;
    if (entry.state === "applied") {
      // A replacement Dispatch Attempt starts in `offered`; replay the complete
      // legal lifecycle without ever invoking App Server again. Replaying the
      // same attempt is harmless: Control Plane treats matching states as
      // duplicates and later phases let it catch up after a lost ACK.
      for (const state of ["claimed", "invoking"] as const) {
        await this.emitCommandState(command, state);
        this.ackCommand(command, state);
      }
      await this.emitCommandState(command, "responded", detail);
      this.ackCommand(
        command,
        "responded",
        entry.error === undefined ? { response: entry.response } : { error: entry.error },
      );
      await this.emitCommandState(command, "applied", detail);
      this.ackCommand(
        command,
        "applied",
        entry.error === undefined ? { response: entry.response } : { ok: false, error: entry.error },
      );
      return;
    }
    if (entry.state === "unknown") {
      await this.emitCommandState(command, "claimed");
      this.ackCommand(command, "claimed");
      await this.emitCommandState(command, "unknown", detail);
      this.ackCommand(command, "unknown", detail);
      return;
    }
    await this.emitCommandState(command, entry.state, detail);
    this.ackCommand(command, entry.state === "rejected" ? "invalidated" : entry.state, detail);
  }

  private ackCommand(command: FleetCommand, state: string, detail?: unknown): void {
    this.callbacks.onCommandAck({
      type: "command.ack",
      dispatchAttemptId: command.attemptId,
      state,
      ...(detail === undefined ? {} : { detail: isRecord(detail) ? detail : { value: detail } }),
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.catalogSync.close();
    this.catalogWatcher?.close();
    if (this.discoveryContinuation) clearTimeout(this.discoveryContinuation);
    this.discoveryContinuation = undefined;
    this.restartController?.abort(new AgentError("AGENT_SHUTDOWN", "agent is shutting down"));
    const servers = new Set(
      [this.appServer, this.startingAppServer].filter((server): server is AppServerClient => server !== undefined),
    );
    this.appServer = undefined;
    this.startingAppServer = undefined;
    await Promise.all([...servers].map((server) => server.stop()));
    await this.restartLoop?.catch(() => undefined);
  }

  private async syncPagedHistory(thread: ManagedThread, importExisting: boolean): Promise<number> {
    const server = this.appServer;
    if (!server?.readHistoryPage) throw new AgentError("HISTORY_PAGING_UNAVAILABLE","Native history pagination is unavailable");
    if (importExisting && !thread.historySyncInitialized) await this.store.updateManagedThread(thread.nativeThreadId,candidate => { candidate.historySyncInitialized = true; });
    let imported = 0;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
      const state = this.store.snapshot();
      const current = state.managedThreads[thread.nativeThreadId];
      if (!current || current.logicalSessionId !== thread.logicalSessionId || current.executionSegmentId !== thread.executionSegmentId || current.contentEpoch !== thread.contentEpoch || current.activeTurnId) break;
      // Bound pending body data while the relay drains it to the control plane.
      if (state.outbox.length >= 1000) break;
      const checkpoint = current.historyPage ?? {cursor:null,complete:false,...(current.historyCursor ? {legacyAnchor:current.historyCursor} : {})};
      const cursor = checkpoint.cursor;
      if (cursor && seen.has(cursor)) throw new AgentError("HISTORY_CURSOR_STALLED","Native history cursor repeated");
      if (cursor) seen.add(cursor);
      const page = await server.readHistoryPage(current.nativeThreadId,cursor);
      const latest = this.store.snapshot().managedThreads[current.nativeThreadId];
      if (this.appServer !== server || !latest || latest.activeTurnId || latest.logicalSessionId !== current.logicalSessionId || latest.executionSegmentId !== current.executionSegmentId || latest.contentEpoch !== current.contentEpoch || canonicalJson(latest.historyPage ?? null) !== canonicalJson(current.historyPage ?? null)) break;
      let anchor = checkpoint.legacyAnchor;
      let start = 0;
      if (anchor) {
        const index = page.items.findIndex(item => item.nativeItemId === anchor);
        start = index < 0 ? page.items.length : index + 1;
        if (index >= 0) anchor = undefined;
      } else if (!current.historySyncInitialized && !importExisting) start = page.items.length;
      const events: EventInput[] = page.items.slice(start).flatMap(entry => entry.item ? [{
        machineId:this.pairing.machineId,producerEpoch:this.producerEpoch,appServerEpoch:current.appServerEpoch,
        projectId:current.projectId,logicalSessionId:current.logicalSessionId!,executionSegmentId:current.executionSegmentId!,contentEpoch:current.contentEpoch ?? 1,
        type:"item.completed",nativeThreadId:current.nativeThreadId,nativeTurnId:entry.nativeTurnId,nativeItemId:entry.nativeItemId,
        payload:{item:entry.item,synchronizedFromHost:true},
      }] : []);
      const next = {cursor:page.nextCursor ?? cursor,complete:page.nextCursor === null,...(anchor ? {legacyAnchor:anchor} : {})};
      imported += await this.store.appendHistoryBatch(current.nativeThreadId,events,anchor ?? page.items.at(-1)?.nativeItemId ?? current.historyCursor ?? "",next,page.items.slice(0,start));
      this.callbacks.onOutboxChanged();
      await yieldToIO();
      if (!page.nextCursor) {
        if (anchor) await this.emitForThread(current,{type:"agent.warning",nativeThreadId:current.nativeThreadId,payload:{code:"HISTORY_CURSOR_UNRESOLVED",detail:"原生历史中未找到之前的同步位置；已保留已有记录，未重复导入。"}});
        break;
      }
    }
    return imported;
  }

  private async syncNativeUsage(thread: ManagedThread, snapshot: ThreadHistorySnapshot): Promise<void> {
    if (snapshot.nativeThreadId !== thread.nativeThreadId || this.imageMaintenanceSessions.has(thread.logicalSessionId ?? "")) return;
    const nativeUsage = this.store.snapshot().projectContentPolicies[thread.projectId]?.syncContent === false ? undefined : await readNativeUsage(this.support.codexProfile?.codexHome, snapshot.rolloutPath, thread.nativeThreadId);
    if (nativeUsage && thread.logicalSessionId && thread.executionSegmentId && (!thread.usageObservedAt || nativeUsage.occurredAt >= thread.usageObservedAt)) {
      const digest = sha256(canonicalJson(nativeUsage));
      if (this.store.snapshot().managedThreads[thread.nativeThreadId]?.nativeUsageDigest !== digest) {
        await this.emitForThread(thread, { type: "thread.usage", nativeThreadId: thread.nativeThreadId,
          occurredAt: nativeUsage.occurredAt, payload: { usage: nativeUsage.usage, synchronizedFromHost: true } });
        await this.store.updateManagedThread(thread.nativeThreadId, candidate => { candidate.nativeUsageDigest = digest; candidate.usageObservedAt = nativeUsage.occurredAt; });
      }
    }

  }

  private async syncManagedHistory(thread: ManagedThread, snapshot: ThreadHistorySnapshot, importExisting: boolean): Promise<number> {
    if (this.imageMaintenanceSessions.has(thread.logicalSessionId ?? "") || this.historySyncJobs.has(thread.nativeThreadId)) return 0;
    this.historySyncJobs.add(thread.nativeThreadId);
    try { return await this.syncManagedHistoryUnfenced(thread, snapshot, importExisting); }
    finally { this.historySyncJobs.delete(thread.nativeThreadId); }
  }

  private async syncManagedHistoryUnfenced(
    thread: ManagedThread,
    snapshot: ThreadHistorySnapshot,
    importExisting: boolean,
  ): Promise<number> {
    if (snapshot.nativeThreadId !== thread.nativeThreadId) return 0;
    await this.syncNativeUsage(thread, snapshot);
    if (snapshot.paged && this.appServer?.readHistoryPage) return this.syncPagedHistory(thread,importExisting);
    const current = this.store.snapshot().managedThreads[thread.nativeThreadId];
    if (!current) return 0;
    const { logicalSessionId, executionSegmentId } = current;
    if (!logicalSessionId || !executionSegmentId) throw new AgentError("SESSION_BINDING_UNKNOWN", "History target lacks a session binding");
    let startIndex = snapshot.items.length;
    if (current.historyCursor) {
      const cursorIndex = snapshot.items.findIndex((entry) => entry.nativeItemId === current.historyCursor);
      if (cursorIndex >= 0) {
        startIndex = cursorIndex + 1;
      } else if (snapshot.items.length > 0) {
        await this.emitForThread(current, {
          type: "agent.warning",
          nativeThreadId: current.nativeThreadId,
          payload: {
            code: "HISTORY_CURSOR_REBASED",
            detail: "宿主机历史发生压缩或重写；已重新建立同步游标，旧内容不会重复导入",
          },
        });
      }
    } else if (!current.historySyncInitialized) {
      startIndex = importExisting ? 0 : snapshot.items.length;
    } else if ((current.historyItemCount ?? 0) === 0) {
      startIndex = 0;
    }

    let imported = 0;
    for (let index = startIndex; index < snapshot.items.length; index += 32) {
      const batch = snapshot.items.slice(index, index + 32);
      const events: EventInput[] = batch.flatMap(entry => entry.item ? [{
          machineId: this.pairing.machineId,
          producerEpoch: this.producerEpoch,
          appServerEpoch: current.appServerEpoch,
          projectId: current.projectId,
          logicalSessionId,
          executionSegmentId,
          contentEpoch: current.contentEpoch ?? 1,
          type: "item.completed",
          nativeThreadId: current.nativeThreadId,
          nativeTurnId: entry.nativeTurnId,
          nativeItemId: entry.nativeItemId,
          payload: { item: entry.item, synchronizedFromHost: true },
        }] : []);
      await this.store.appendHistoryBatch(current.nativeThreadId, events, batch.at(-1)!.nativeItemId);
      imported += events.length;
      this.callbacks.onOutboxChanged();
      // SQLite updates resolve synchronously; awaiting them alone starves timers
      // and sockets for the entire history import.
      await yieldToIO();
    }
    const lastItem = snapshot.items.at(-1);
    await this.store.updateManagedThread(current.nativeThreadId, (candidate) => {
      candidate.historyMode = snapshot.historyMode;
      candidate.historySyncInitialized = true;
      candidate.historyItemCount = snapshot.items.length;
      if (snapshot.updatedAt === null) delete candidate.lastHistoryUpdatedAt;
      else candidate.lastHistoryUpdatedAt = snapshot.updatedAt;
      if (lastItem) candidate.historyCursor = lastItem.nativeItemId;
    });
    return imported;
  }

  private async reconcileExistingThreads(indexOnly = false): Promise<void> {
    const server = this.appServer;
    if (!server || this.discoveryRunning) return;
    const previousVisibleState = this.getDiscoveryStatus().state;
    this.discoveryRunning = true;
    let changed = false;
    try {
      try {
        const threads = [];
        const metadataRevisions = Object.fromEntries(Object.values(this.store.snapshot().managedThreads).map(thread => [thread.nativeThreadId, thread.metadataRevision ?? 0]));
        if (this.discoveryCursor === null) {
          this.discoveryIndexOnly = indexOnly;
          this.discoveryScanId = randomUUID();
          this.discoveryScannedPages = 0;
          this.discoverySkippedCount = 0;
          this.discoverySeen.clear();
          this.discoveryCursors.clear();
          this.discoveryStatus = { ...this.discoveryStatus, state: "scanning", scannedCount: 0 };
        }
        if (server.listThreadPage) {
          for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
            const page = await server.listThreadPage(this.discoveryCursor, { useStateDbOnly: this.discoveryIndexOnly });
            this.discoveryScannedPages += 1;
            threads.push(...page.threads);
            this.discoveryCursor = page.nextCursor;
            if (!this.discoveryCursor) break;
            if (this.discoveryCursors.has(this.discoveryCursor)) throw new AgentError("THREAD_DISCOVERY_CURSOR", "thread listing repeated a pagination cursor");
            this.discoveryCursors.add(this.discoveryCursor);
          }
        } else {
          threads.push(...await server.listThreads());
          this.discoveryScannedPages += 1;
        }
        const complete = this.discoveryCursor === null;
        this.discoveryStatus.scannedCount += threads.length;
        const knownProjects = [...this.store.snapshot().projects];
        const discoveredProjects = new Map<string, ProjectRecord>();
        const observed: Array<Omit<DiscoveredThread, "firstSeenAt" | "lastSeenAt" | "lastReconciledAt">> = [];
        for (const thread of threads) {
          this.discoverySeen.add(thread.nativeThreadId);
          try {
            const project = await discoverProjectFromCwd(
              thread.cwd,
              [...knownProjects, ...discoveredProjects.values()],
            );
            discoveredProjects.set(project.root, project);
            const priorUsage = this.store.snapshot().managedThreads[thread.nativeThreadId]?.nativeUsage ?? this.store.snapshot().discoveredThreads[thread.nativeThreadId]?.nativeUsage;
            const nativeUsage = this.store.snapshot().projectContentPolicies[project.id]?.syncContent === false
              ? undefined : await readNativeUsage(this.support.codexProfile?.codexHome, thread.rolloutPath, thread.nativeThreadId) ?? priorUsage;
            observed.push({
              ...(nativeUsage ? { nativeUsage } : {}),
              externalId: thread.nativeThreadId,
              executionSegmentExternalId: thread.nativeThreadId,
              nativeThreadId: thread.nativeThreadId,
              projectId: project.id,
              sessionCwd: thread.cwd,
              codexProfileId: "default",
              title: thread.title,
              ...(thread.titleSource ? { titleSource: thread.titleSource } : {}),
              archived: thread.archived ?? false,
              availability: "available",
              executionState: thread.executionState,
              historyCompleteness: "unknown",
              ...(thread.historyMode === undefined ? {} : { historyMode: thread.historyMode }),
            });
          } catch {
            // A stale or inaccessible cwd cannot safely become a writable project.
            this.discoverySkippedCount += 1;
          }
        }
        changed = await this.store.reconcileDiscoveredCatalog(
          [...discoveredProjects.values()],
          observed,
          server.appServerEpoch,
          { complete, seenNativeThreadIds: [...this.discoverySeen], metadataRevisions },
        );
        this.discoveryStatus = {
          state: complete ? "ready" : "scanning",
          scannedCount: this.discoveryStatus.scannedCount,
          discoveredCount: Object.keys(this.store.snapshot().discoveredThreads).length + Object.keys(this.store.snapshot().managedThreads).length,
          ...(complete ? { lastSuccessfulAt: nowIso() } : this.discoveryStatus.lastSuccessfulAt ? { lastSuccessfulAt: this.discoveryStatus.lastSuccessfulAt } : {}),
        };
        if (complete) this.completedDiscovery = { epoch: server.appServerEpoch, scanId: this.discoveryScanId,
          scannedPages: this.discoveryScannedPages, skippedCount: this.discoverySkippedCount,
          scannedCount: this.discoveryStatus.scannedCount, discoveredCount: this.discoveryStatus.discoveredCount,
          lastSuccessfulAt: this.discoveryStatus.lastSuccessfulAt! };
        const eligibleThreads = Object.values(this.store.snapshot().managedThreads)
          .filter((thread) => thread.historySyncInitialized === true && thread.activeTurnId === undefined && !this.store.snapshot().projectReservations[thread.projectId])
          .sort((left, right) => left.nativeThreadId.localeCompare(right.nativeThreadId));
        const offset = this.historySyncOffset % Math.max(eligibleThreads.length, 1);
        const sharedThreads = [...eligibleThreads.slice(offset), ...eligibleThreads.slice(0, offset)].slice(0, 25);
        this.historySyncOffset = (offset + sharedThreads.length) % Math.max(eligibleThreads.length, 1);
        for (const thread of sharedThreads) {
          try {
            const snapshot = await server.readThread(thread.nativeThreadId, true);
            const project = knownProjects.find((candidate) => candidate.id === thread.projectId);
            if (!project || snapshot.cwd !== (thread.sessionCwd ?? project.root)) continue;
            if (snapshot.executionState === "running") {
              if (thread.appServerEpoch === server.appServerEpoch) await this.syncNativeUsage(thread, snapshot);
              continue;
            }
            if (this.store.snapshot().projectReservations[thread.projectId] || this.store.snapshot().managedThreads[thread.nativeThreadId]?.activeTurnId) continue;
            if (thread.subscribed && thread.appServerEpoch === server.appServerEpoch) {
              await server.unsubscribeThread(thread.nativeThreadId);
            }
            if (thread.appServerEpoch !== server.appServerEpoch || thread.subscribed) {
              await this.store.updateManagedThread(thread.nativeThreadId, (candidate) => {
                candidate.appServerEpoch = server.appServerEpoch;
                candidate.policyVerified = false;
                candidate.subscribed = false;
              });
            }
            const refreshed = this.store.snapshot().managedThreads[thread.nativeThreadId];
            if (refreshed && (refreshed.metadataRevision ?? 0) === (thread.metadataRevision ?? 0)) await this.syncManagedHistory(refreshed, snapshot, false);
          } catch {
            // A single unreadable managed thread must not disable global discovery.
          }
        }
      } catch (error) {
        this.completedDiscovery = undefined;
        changed = await this.store.markAllDiscoveryUnavailable(server.appServerEpoch);
        this.discoveryCursor = null;
        this.discoveryStatus = { ...this.discoveryStatus, state: "error", error: publicError(error).message };
      }
    } finally {
      this.discoveryRunning = false;
    }
    // Recovery already publishes after checking that the new server survived.
    // Do not insert an extra completion callback inside that recovery sequence.
    if (changed || (!this.restartLoop && previousVisibleState !== this.getDiscoveryStatus().state)) this.notifyRegistryChanged();
    if (this.discoveryStatus.state === "error") this.catalogSync.request("full");
    if (this.discoveryCursor === null && this.discoveryRequested) {
      this.discoveryRequested = false;
      this.catalogSync.request("full");
    }
    if (!this.shuttingDown && this.discoveryCursor !== null && !this.discoveryContinuation) {
      this.discoveryContinuation = setTimeout(() => {
        this.discoveryContinuation = undefined;
        void this.reconcileExistingThreads();
      }, 100);
      this.discoveryContinuation.unref();
    }
  }

  private async startAppServerOnce(): Promise<void> {
    if (this.shuttingDown) throw new AgentError("AGENT_SHUTDOWN", "agent is shutting down");
    if (this.appServer) return;
    this.discoveryCursor = null;
    this.completedDiscovery = undefined;
    this.discoveryStatus = { ...this.discoveryStatus, state: "scanning" };
    const server = this.appServerFactory({
      findManagedThread: (threadId) => this.store.snapshot().managedThreads[threadId],
      findProject: (projectId) => this.store.snapshot().projects.find((project) => project.id === projectId),
      onEvent: (event, epoch) => this.handleAppEvent(event, epoch),
      onVolatile: (event, epoch) => this.handleVolatile(event, epoch),
      onApproval: (approval) => this.handleApproval(approval),
      onApprovalResolved: (requestId, epoch) => this.handleApprovalResolved(requestId, epoch),
      onExit: (epoch, detail) => this.handleAppExit(epoch, detail),
      onThreadExit: (id, epoch, detail) => this.handleThreadExit(id, epoch, detail),
      onCatalogChanged: epoch => {
        if (epoch === this.appServer?.appServerEpoch && !this.shuttingDown) this.catalogSync.request("index");
      },
    });
    this.startingAppServer = server;
    try {
      await server.start();
    } catch (error) {
      if (this.startingAppServer === server) this.startingAppServer = undefined;
      await server.stop().catch(() => undefined);
      throw error;
    }
    if (this.shuttingDown || this.exitedAppServerEpochs.has(server.appServerEpoch)) {
      if (this.startingAppServer === server) this.startingAppServer = undefined;
      await server.stop().catch(() => undefined);
      throw new AgentError(
        this.shuttingDown ? "AGENT_SHUTDOWN" : "APP_SERVER_EXITED",
        this.shuttingDown ? "agent is shutting down" : "app-server exited while starting",
      );
    }
    this.startingAppServer = undefined;
    this.appServer = server;
    this.appServerFailure = undefined;
  }

  private ensureRestartSupervisor(): void {
    if (this.shuttingDown || !this.canRead() || this.appServer || this.restartLoop) return;
    const controller = new AbortController();
    this.restartController = controller;
    this.restartLoop = this.runRestartSupervisor(controller.signal).finally(() => {
      if (this.restartController === controller) {
        this.restartController = undefined;
        this.restartLoop = undefined;
        if (!this.shuttingDown && !this.appServer) this.ensureRestartSupervisor();
      }
    });
  }

  private async runRestartSupervisor(signal: AbortSignal): Promise<void> {
    let attempt = 1;
    while (!this.shuttingDown && !signal.aborted && !this.appServer) {
      try {
        await this.restartSleep(this.restartDelay(attempt), signal);
      } catch {
        return;
      }
      if (this.shuttingDown || signal.aborted || this.appServer) return;
      try {
        await this.startAppServerOnce();
        const recoveredServer = this.appServer;
        if (!recoveredServer) {
          attempt += 1;
          continue;
        }
        await this.reconcileExistingThreads();
        if (this.appServer !== recoveredServer) {
          attempt += 1;
          continue;
        }
        this.notifyRegistryChanged();
        return;
      } catch (error) {
        if (this.shuttingDown || signal.aborted) return;
        this.appServerFailure = publicError(error).message;
        this.notifyRegistryChanged();
        attempt += 1;
      }
    }
  }

  private validateCommandEnvelope(command: FleetCommand, deliveryGeneration: number): void {
    if (Date.parse(command.expiresAt) <= Date.now()) throw new AgentError("COMMAND_EXPIRED", "command has expired");
    if (this.transportGeneration !== deliveryGeneration) {
      throw new AgentError("TRANSPORT_FENCED", "command arrived on a non-current transport generation");
    }
    if (command.transportGeneration !== undefined && command.transportGeneration !== deliveryGeneration) {
      throw new AgentError("TRANSPORT_FENCED", "command target generation does not match this connection");
    }
  }

  private async invoke(
    command: FleetCommand,
    project: ProjectRecord,
    server: AppServerClient,
  ): Promise<Record<string, unknown>> {
    if (this.imageMaintenanceSessions.has(command.logicalSessionId)) throw new AgentError("THREAD_BUSY", "此会话正在核验或清理图片，请完成后发送");
    const boundThread = Object.values(this.store.snapshot().managedThreads).find(
      (candidate) => candidate.logicalSessionId === command.logicalSessionId,
    );
    if (boundThread) {
      const currentContentEpoch = boundThread.contentEpoch ?? 1;
      if (command.contentEpoch < currentContentEpoch) {
        throw new AgentError("CONTENT_EPOCH_STALE", "command belongs to a deleted content epoch");
      }
      if (command.contentEpoch > currentContentEpoch) {
        await this.store.updateManagedThread(boundThread.nativeThreadId, (candidate) => {
          candidate.contentEpoch = command.contentEpoch;
        });
      }
    }
    switch (command.type) {
      case "thread.terminals.stop": {
        if (!boundThread || boundThread.projectId !== project.id || boundThread.executionSegmentId !== command.executionSegmentId || boundThread.nativeThreadId !== command.precondition.nativeThreadId) throw new AgentError("THREAD_NOT_MANAGED", "Terminal target binding changed");
        if (command.precondition.executionSegmentId !== command.executionSegmentId || command.precondition.projectLeaseVersion !== project.identityVersion || command.precondition.expectedActiveTurnId !== (boundThread.activeTurnId ?? null)) throw new AgentError("PRECONDITION_INVALID", "Terminal target changed; refresh first");
        if (boundThread.appServerEpoch !== server.appServerEpoch || !boundThread.policyVerified || !server.stopBackgroundTerminals || Object.keys(command.payload).length) throw new AgentError("THREAD_READ_ONLY", "Cannot control terminals of this runtime");
        await server.stopBackgroundTerminals(boundThread, project);
        return { nativeThreadId: boundThread.nativeThreadId, backgroundTerminalsStopped: true };
      }
      case "codex.inspect": {
        if (!server.inspectEnvironment || Object.keys(command.payload).length || command.precondition.executionSegmentId !== command.executionSegmentId || command.precondition.projectLeaseVersion !== project.identityVersion) throw new AgentError("PRECONDITION_INVALID", "Invalid inspection target or unsupported runtime");
        if (boundThread && (boundThread.projectId !== project.id || boundThread.executionSegmentId !== command.executionSegmentId)) throw new AgentError("THREAD_PROJECT_MISMATCH", "Inspection session belongs to another project");
        const cwd = await verifySessionCwd(project, boundThread?.sessionCwd ?? project.root);
        return { inspection: await server.inspectEnvironment(cwd, boundThread?.nativeThreadId) };
      }
      case "thread.delete.preview":
      case "thread.delete": {
        if(!boundThread || boundThread.projectId!==project.id || boundThread.executionSegmentId!==command.executionSegmentId || boundThread.nativeThreadId!==command.precondition.nativeThreadId || command.precondition.projectLeaseVersion!==project.identityVersion || command.precondition.expectedActiveTurnId!==null || boundThread.activeTurnId)throw new AgentError("DELETE_TARGET_CHANGED","删除目标或运行状态已改变");
        if(!server.previewDeletion || !server.deleteThread)throw new AgentError("DELETE_UNAVAILABLE","主机尚不支持删除");
        if(command.type==="thread.delete.preview")return {deletionPreview:await server.previewDeletion(boundThread,project)};
        const previewId=requireString(command.payload.previewCommandId,"previewCommandId",{maxLength:128});
        const journal=this.store.snapshot().commandJournal[previewId];
        const response=journal?.response;
        if(journal?.state!=="applied" || journal.commandType!=="thread.delete.preview" || !isRecord(response) || !isRecord(response.deletionPreview))throw new AgentError("DELETE_CONFIRMATION_REQUIRED","主机缺少已确认的删除预览");
        const preview=response.deletionPreview as unknown as import("./native-deletion.js").DeletionPreview;
        if(preview.fingerprint!==command.payload.fingerprint || preview.nativeThreadId!==boundThread.nativeThreadId)throw new AgentError("DELETE_TARGET_CHANGED","删除预览与目标不符");
        const ids=preview.threads.map(t=>t.id);const state=this.store.snapshot();
        if(ids.some(id=>state.managedThreads[id]?.activeTurnId || Object.values(state.approvals).some(a=>a.nativeThreadId===id&&a.state==="pending")))throw new AgentError("THREAD_BUSY","目标或后代仍有任务、问题或审批未完成");
        await server.deleteThread(boundThread,project,preview);
        return this.store.commitNativeDeletion(command,ids);
      }
      case "thread.rename":
      case "thread.archive":
      case "thread.unarchive":
      case "thread.fork": {
        if (!boundThread || boundThread.projectId !== project.id || boundThread.executionSegmentId !== command.executionSegmentId || boundThread.nativeThreadId !== command.precondition.nativeThreadId) throw new AgentError("THREAD_NOT_MANAGED", "Thread binding changed");
        if (boundThread.activeTurnId || command.precondition.expectedActiveTurnId !== null) throw new AgentError("THREAD_BUSY", "Thread must be idle");
        if (command.precondition.projectLeaseVersion !== project.identityVersion) throw new AgentError("PROJECT_VERSION_CONFLICT", "Project changed");
        if (Object.values(this.store.snapshot().approvals).some((a) => a.nativeThreadId === boundThread.nativeThreadId && a.state === "pending")) throw new AgentError("THREAD_BUSY", "Resolve pending requests first");
        if (!server.threadAction) throw new AgentError("PRECONDITION_INVALID", "Runtime does not support native session operations");
        const action = command.type.slice(7) as "rename" | "archive" | "unarchive" | "fork";
        const name = action === "rename" ? requireString(command.payload.name, "name", { maxLength: 200 }).trim() : undefined;
        if (action === "rename" && !name) throw new AgentError("PRECONDITION_INVALID", "Name must not be empty");
        const result = await server.threadAction(boundThread, project, action, name, typeof command.precondition.expectedTitle === "string" ? command.precondition.expectedTitle : undefined);
        const updated = await this.store.updateManagedThread(boundThread.nativeThreadId, (thread) => {
          thread.metadataRevision = (thread.metadataRevision ?? 0) + 1;
          // Native operations use disposable writers; the next turn must resume
          // and verify the original thread after that writer has exited.
          thread.subscribed = false;
          thread.policyVerified = false;
          if (name) { thread.title = name; thread.titleSource = "name"; }
          if (action === "archive" || action === "unarchive") { thread.archived = action === "archive"; thread.subscribed = false; }
        });
        await this.emitForThread(updated, { type: "thread.updated", nativeThreadId: updated.nativeThreadId, payload: { commandId: command.commandId, operation: action, ...result } });
        if (action === "fork") await this.reconcileExistingThreads();
        this.notifyRegistryChanged();
        return { nativeThreadId: updated.nativeThreadId, ...result };
      }
      case "thread.claim": {
        const nativeThreadId = requireString(command.precondition.nativeThreadId, "precondition.nativeThreadId", { maxLength: 256 });
        if (command.precondition.expectedActiveTurnId !== null) {
          throw new AgentError("PRECONDITION_INVALID", "thread.claim requires expectedActiveTurnId=null");
        }
        if (command.precondition.projectLeaseVersion !== project.identityVersion) {
          throw new AgentError("PROJECT_VERSION_CONFLICT", "project identity version changed; refresh before claiming");
        }
        if (Object.values(this.store.snapshot().managedThreads).some(
          (candidate) => candidate.projectId === project.id && candidate.activeTurnId !== undefined,
        )) {
          throw new AgentError("PROJECT_BUSY", "project already has an active AgentFleet turn");
        }
        const discovered = this.store.snapshot().discoveredThreads[nativeThreadId];
        if (
          !discovered ||
          discovered.projectId !== project.id ||
          discovered.availability !== "available" ||
          discovered.executionState !== "idle"
        ) {
          throw new AgentError("THREAD_NOT_CLAIMABLE", "thread is missing, unavailable, or currently active on the host");
        }
        if (discovered.archived) throw new AgentError("THREAD_ARCHIVED", "请先在宿主机恢复归档，再接管原会话");
        const sessionCwd = await verifySessionCwd(project, discovered.sessionCwd ?? project.root);
        const profile = permissionProfile(command.payload.permissionProfile);
        const resumed = await server.resumeThread(nativeThreadId, project, sessionCwd, profile);
        if (!resumed.policyVerified) {
          await server.unsubscribeThread(nativeThreadId).catch(() => undefined);
          throw new AgentError("POLICY_NOT_PROVEN", resumed.policyFailure ?? "effective thread policy could not be proven");
        }
        // Release the OS writer before importing history; paged reads use the
        // catalog connection and do not retain the session writer.
        await server.unsubscribeThread(nativeThreadId);
        let thread: ManagedThread = {
          nativeThreadId,
          projectId: project.id,
          logicalSessionId: command.logicalSessionId,
          executionSegmentId: command.executionSegmentId,
          appServerEpoch: server.appServerEpoch,
          policyVersion: POLICY_VERSION,
          policyVerified: true,
          contentEpoch: command.contentEpoch,
          createdAt: nowIso(),
          origin: "host_claimed",
          permissionProfile: profile,
          title: discovered.title,
          ...(discovered.titleSource ? { titleSource: discovered.titleSource } : {}),
          ...(resumed.observedSettings ? { observedSettings: resumed.observedSettings } : {}),
          historyMode: resumed.history.historyMode,
          historySyncInitialized: false,
          subscribed: false,
          sessionCwd,
          codexProfileId: discovered.codexProfileId ?? "default",
        };
        thread = await this.store.setManagedThread(thread);
        await this.emitForThread(thread, {
          type: "thread.claimed",
          nativeThreadId,
          payload: {
            commandId: command.commandId,
            historyMode: resumed.history.historyMode,
            historyCompleteness: "partial",
            policyVersion: POLICY_VERSION,
            policyVerified: true,
            managementRevision: thread.managementRevision,
            codexProfileId: thread.codexProfileId,
            sessionCwd,
          },
        });
        const importedItems = await this.syncManagedHistory(thread, resumed.history, true);
        this.notifyRegistryChanged();
        return { nativeThreadId, claimed: true, importedItems, historyCompleteness: "partial" };
      }
      case "thread.release": {
        if (boundThread?.archived) throw new AgentError("PRECONDITION_INVALID", "Restore the archived thread before releasing management");
        const nativeThreadId = requireString(command.precondition.nativeThreadId, "precondition.nativeThreadId", { maxLength: 256 });
        if (command.precondition.expectedActiveTurnId !== null) {
          throw new AgentError("PRECONDITION_INVALID", "thread.release requires expectedActiveTurnId=null");
        }
        if (command.precondition.projectLeaseVersion !== project.identityVersion) {
          throw new AgentError("PROJECT_VERSION_CONFLICT", "project identity version changed; refresh before releasing");
        }
        const thread = Object.values(this.store.snapshot().managedThreads).find(
          (candidate) => candidate.logicalSessionId === command.logicalSessionId,
        );
        if (!thread || thread.nativeThreadId !== nativeThreadId || thread.projectId !== project.id) {
          throw new AgentError("THREAD_NOT_MANAGED", "thread is not managed by this project");
        }
        if (thread.activeTurnId !== undefined) {
          throw new AgentError("THREAD_BUSY", "the active turn must finish before releasing management");
        }
        // Always confirm writer release; persisted subscription state is not
        // evidence that Codex released its OS-level writer lock.
        await server.unsubscribeThread(nativeThreadId);
        const response = await this.store.releaseManagedThread(nativeThreadId, {
          type: "thread.released",
          nativeThreadId,
          machineId: this.pairing.machineId,
          producerEpoch: this.producerEpoch,
          appServerEpoch: server.appServerEpoch,
          projectId: thread.projectId,
          logicalSessionId: command.logicalSessionId,
          executionSegmentId: command.executionSegmentId,
          contentEpoch: thread.contentEpoch,
          payload: {
            commandId: command.commandId,
            hostThreadPreserved: true,
            hostHistoryPreserved: true,
            writerReleased: true,
          },
        }, command);
        this.callbacks.onOutboxChanged();
        return response;
      }
      case "turn.start":
      case "turn.compact":
      case "turn.review":
      case "turn.queue": {
        if (boundThread?.archived) throw new AgentError("PRECONDITION_INVALID", "Restore the archived thread before starting a turn");
        if (command.type !== "turn.queue" && command.precondition.expectedActiveTurnId !== null) {
          throw new AgentError("PRECONDITION_INVALID", "turn.start requires expectedActiveTurnId=null");
        }
        if (command.type === "turn.queue" && !Number.isSafeInteger(command.precondition.queueVersion)) {
          throw new AgentError("PRECONDITION_INVALID", "turn.queue requires queueVersion");
        }
        const nativeAction = command.type === "turn.compact" ? "compact" : command.type === "turn.review" ? "review" : undefined;
        if (nativeAction && (!boundThread || !server.startNativeTurn || Object.keys(command.payload).length !== 0)) throw new AgentError("PRECONDITION_INVALID", "Native turn requires an existing thread and an empty payload");
        const images = parseImages(command.payload.images);
        const prompt = nativeAction ? "" : requireString(command.payload.prompt, "payload.prompt", { allowEmpty: images.length > 0, maxLength: 200_000 });
        const settings = validateSettings(command.payload.settings, server.getCodexCatalog?.());
        const profile = permissionProfile(command.payload.permissionProfile);
        if (command.precondition.executionSegmentId !== command.executionSegmentId) {
          throw new AgentError("PRECONDITION_INVALID", "execution segment precondition does not match the command");
        }
        if (command.precondition.projectLeaseVersion !== project.identityVersion) {
          throw new AgentError("PROJECT_VERSION_CONFLICT", "project identity version changed; refresh before sending");
        }
        if (Object.values(this.store.snapshot().managedThreads).some(
          (candidate) => candidate.projectId === project.id && candidate.activeTurnId !== undefined,
        )) {
          throw new AgentError("PROJECT_BUSY", "project already has an active AgentFleet turn");
        }
        const externalActivity = this.store.externalProjectActivity(project.id, server.appServerEpoch);
        if (externalActivity) {
          throw new AgentError(
            "PROJECT_EXTERNAL_ACTIVITY",
            `existing Codex thread ${externalActivity.nativeThreadId} is ${externalActivity.executionState} on this project`,
          );
        }
        let thread = Object.values(this.store.snapshot().managedThreads).find(
          (candidate) => candidate.logicalSessionId === command.logicalSessionId,
        );
        if (!thread) {
          const name = command.payload.sessionTitle === undefined ? undefined : requireString(command.payload.sessionTitle, "sessionTitle", { maxLength: 200 });
          const created = await server.createThread(project, profile, name);
          thread = {
            nativeThreadId: created.nativeThreadId,
            projectId: project.id,
            logicalSessionId: command.logicalSessionId,
            executionSegmentId: command.executionSegmentId,
            appServerEpoch: server.appServerEpoch,
            policyVersion: POLICY_VERSION,
            policyVerified: created.policyVerified,
            contentEpoch: command.contentEpoch,
            createdAt: nowIso(),
            origin: "agentfleet",
            permissionProfile: profile,
            ...(name ? { title: name, titleSource: "name" as const } : {}),
            ...(created.observedSettings ? { observedSettings: created.observedSettings } : {}),
            historyMode: created.historyMode ?? "legacy",
            historySyncInitialized: true,
            historyItemCount: 0,
            subscribed: true,
            sessionCwd: project.root,
            codexProfileId: "default",
          };
          thread = await this.store.setManagedThread(thread);
          await this.emitForThread(thread, {
            type: "thread.started",
            nativeThreadId: thread.nativeThreadId,
            payload: {
              commandId: command.commandId,
              policyVersion: POLICY_VERSION,
              policyVerified: created.policyVerified,
              managementRevision: thread.managementRevision,
              codexProfileId: thread.codexProfileId,
              sessionCwd: thread.sessionCwd,
              ...(created.policyFailure === undefined ? {} : { policyFailure: created.policyFailure }),
              effectivePolicy: created.rawSummary,
            },
          });
          if (!created.policyVerified) {
            throw new AgentError("POLICY_NOT_PROVEN", created.policyFailure ?? "effective thread policy could not be proven");
          }
        }
        if (thread.projectId !== project.id) throw new AgentError("THREAD_NOT_MANAGED", "thread is not owned by this project");
        if (thread.activeTurnId !== undefined) throw new AgentError("THREAD_BUSY", "thread still has an active turn");
        if ((thread.permissionProfile ?? "project") !== profile && thread.subscribed) {
          await server.unsubscribeThread(thread.nativeThreadId);
          thread = await this.store.updateManagedThread(thread.nativeThreadId, candidate => { candidate.subscribed = false; });
        }
        if (thread.appServerEpoch !== server.appServerEpoch || !thread.policyVerified || !thread.subscribed) {
          const resumed = await server.resumeThread(thread.nativeThreadId, project, thread.sessionCwd ?? project.root, profile);
          if (!resumed.policyVerified) {
            throw new AgentError("POLICY_NOT_PROVEN", resumed.policyFailure ?? "effective thread policy could not be proven");
          }
          thread = await this.store.updateManagedThread(thread.nativeThreadId, (candidate) => {
            candidate.appServerEpoch = server.appServerEpoch;
            candidate.policyVerified = true;
            candidate.subscribed = true;
            candidate.permissionProfile = profile;
            candidate.historyMode = resumed.history.historyMode;
            if (resumed.observedSettings) candidate.observedSettings = resumed.observedSettings;
          });
          await this.syncManagedHistory(thread, resumed.history, false);
        }
        if (thread.activeTurnId !== undefined) throw new AgentError("THREAD_BUSY", "thread still has an active turn");
        const clientUserMessageId = optionalString(command.payload.clientUserMessageId, "payload.clientUserMessageId");
        const result = nativeAction
          ? await server.startNativeTurn!(thread, nativeAction, { type: "uncommittedChanges" })
          : await server.startTurn(thread, project, prompt, clientUserMessageId, settings, images);
        let completedBeforeResponse = false;
        const updated = await this.store.updateManagedThread(thread.nativeThreadId, (candidate) => {
          candidate.acceptedPermissions = { profile, source: typeof command.payload.permissionSource === "string" ? command.payload.permissionSource : "default", acceptedAt: nowIso(), nativeTurnId: result.nativeTurnId };
          if (settings) candidate.acceptedSettings = { ...settings, acceptedAt: nowIso(), nativeTurnId: result.nativeTurnId };
          if (
            candidate.lastTurnId === result.nativeTurnId &&
            ["completed", "interrupted", "failed"].includes(candidate.lastTurnStatus ?? "")
          ) {
            completedBeforeResponse = true;
            return;
          }
          candidate.activeTurnId = result.nativeTurnId;
          candidate.lastTurnId = result.nativeTurnId;
          candidate.lastTurnStatus = result.status;
        });
        if (!completedBeforeResponse) {
          await this.emitForThread(updated, {
            type: "turn.started",
            nativeThreadId: thread.nativeThreadId,
            nativeTurnId: result.nativeTurnId,
            payload: { commandId: command.commandId, status: result.status, queued: command.type === "turn.queue", settings: settings ?? null },
          });
        }
        this.notifyRegistryChanged();
        return {
          nativeThreadId: thread.nativeThreadId,
          nativeTurnId: result.nativeTurnId,
          status: completedBeforeResponse ? updated.lastTurnStatus ?? result.status : result.status,
          ...(settings && updated.acceptedSettings ? { acceptedSettings: updated.acceptedSettings } : {}),
        };
      }
      case "turn.cancel": {
        const turnId = requireString(command.precondition.nativeTurnId, "precondition.nativeTurnId", { maxLength: 256 });
        const thread = Object.values(this.store.snapshot().managedThreads).find(
          (candidate) => candidate.logicalSessionId === command.logicalSessionId,
        );
        if (!thread || thread.projectId !== project.id) throw new AgentError("THREAD_NOT_MANAGED", "thread is not owned by this project");
        if (thread.appServerEpoch !== server.appServerEpoch || !thread.policyVerified) {
          throw new AgentError("THREAD_READ_ONLY", "managed thread belongs to an exited App Server epoch");
        }
        if (thread.activeTurnId !== turnId) throw new AgentError("TURN_PRECONDITION_FAILED", "interrupt must target the exact active turn");
        if (command.precondition.nativeTurnId !== turnId || !Number.isSafeInteger(command.precondition.turnControlVersion)) {
          throw new AgentError("PRECONDITION_INVALID", "interrupt requires nativeTurnId and turnControlVersion");
        }
        await server.interruptTurn(thread.nativeThreadId, turnId);
        await this.emitForThread(thread, {
          type: "command.result",
          nativeThreadId: thread.nativeThreadId,
          nativeTurnId: turnId,
          payload: { commandId: command.commandId, operation: "turn.cancel", acknowledged: true },
        });
        return { nativeThreadId: thread.nativeThreadId, nativeTurnId: turnId, acknowledged: true };
      }
      case "turn.steer": {
        const turnId = requireString(command.precondition.nativeTurnId, "precondition.nativeTurnId", { maxLength: 256 });
        const images = parseImages(command.payload.images);
        const prompt = requireString(command.payload.prompt, "payload.prompt", { allowEmpty: images.length > 0, maxLength: 200_000 });
        const thread = Object.values(this.store.snapshot().managedThreads).find(
          (candidate) => candidate.logicalSessionId === command.logicalSessionId,
        );
        if (!thread || thread.projectId !== project.id) {
          throw new AgentError("THREAD_NOT_MANAGED", "thread is not managed by this project");
        }
        if (thread.appServerEpoch !== server.appServerEpoch || !thread.policyVerified || !thread.subscribed) {
          throw new AgentError("THREAD_READ_ONLY", "active thread ownership or policy cannot be proven");
        }
        if (thread.activeTurnId !== turnId || command.precondition.nativeTurnId !== turnId) {
          throw new AgentError("TURN_PRECONDITION_FAILED", "steer must target the exact active turn");
        }
        if (!Number.isSafeInteger(command.precondition.turnControlVersion)) {
          throw new AgentError("PRECONDITION_INVALID", "steer requires turnControlVersion");
        }
        const clientUserMessageId = optionalString(command.payload.clientUserMessageId, "payload.clientUserMessageId");
        const result = await server.steerTurn(thread, turnId, prompt, clientUserMessageId, images);
        await this.emitForThread(thread, {
          type: "turn.steered",
          nativeThreadId: thread.nativeThreadId,
          nativeTurnId: turnId,
          payload: { commandId: command.commandId, status: result.status },
        });
        return { nativeThreadId: thread.nativeThreadId, nativeTurnId: turnId, status: result.status };
      }
      case "input.respond":
      case "approval.decide_once": {
        const approvalId = requireString(command.precondition.approvalId, "precondition.approvalId", { maxLength: 256 });
        const answering = command.type === "input.respond";
        const fleetDecision = answering ? "approve" : requireString(command.payload.decision, "payload.decision", { maxLength: 16 });
        if (fleetDecision !== "approve" && fleetDecision !== "reject") {
          throw new AgentError("APPROVAL_DECISION_INVALID", "only approve or reject once are supported");
        }
        const decision = fleetDecision === "approve" ? "accept" : "decline";
        const approval = this.store.snapshot().approvals[approvalId];
        if (!approval || approval.projectId !== project.id) throw new AgentError("APPROVAL_NOT_FOUND", "approval is not pending for this project");
        const requestThread = this.store.snapshot().managedThreads[approval.nativeThreadId];
        if (!requestThread || requestThread.logicalSessionId !== command.logicalSessionId || requestThread.executionSegmentId !== command.executionSegmentId) {
          throw new AgentError("APPROVAL_PRECONDITION_FAILED", "Request belongs to another session or execution segment");
        }
        if (answering !== (approval.method === "item/tool/requestUserInput")) throw new AgentError("INPUT_RESPONSE_REQUIRED", "Question answers and permission decisions cannot be interchanged");
        const answers = answering ? inputAnswers(command.payload.answers, inputQuestions(approval.params.questions)) : undefined;
        if (answering && !server.respondInput) throw new AgentError("INPUT_RESPONSE_REQUIRED", "Runtime does not support answering questions");
        if (approval.state !== "pending") throw new AgentError("APPROVAL_ALREADY_RESOLVED", "approval is no longer pending");
        if (Date.parse(approval.expiresAt) <= Date.now()) throw new AgentError("APPROVAL_EXPIRED", "approval has expired");
        if (
          command.precondition.actionHash !== approval.actionHash ||
          command.precondition.appServerEpoch !== approval.appServerEpoch ||
          command.precondition.approvalId !== approvalId ||
          command.precondition.approvalVersion !== 1
        ) {
          throw new AgentError("APPROVAL_PRECONDITION_FAILED", "approval identity, hash, epoch, or version does not match");
        }
        const decided = await this.store.decideApproval(approvalId, decision);
        try {
          if (answers) await server.respondInput!(decided, answers);
          else await server.respondApproval(decided, decision);
        } catch (error) {
          await this.store.setApprovalState(approvalId, "delivery_unknown");
          throw error;
        }
        await this.emitForThread(
          this.store.snapshot().managedThreads[approval.nativeThreadId] ?? {
            nativeThreadId: approval.nativeThreadId,
            projectId: project.id,
            appServerEpoch: approval.appServerEpoch,
            policyVersion: POLICY_VERSION,
            policyVerified: false,
            contentEpoch: command.contentEpoch,
            createdAt: approval.createdAt,
          },
          {
            type: "command.result",
            nativeThreadId: approval.nativeThreadId,
            ...(approval.nativeTurnId === undefined ? {} : { nativeTurnId: approval.nativeTurnId }),
            ...(approval.nativeItemId === undefined ? {} : { nativeItemId: approval.nativeItemId }),
            payload: {
              commandId: command.commandId,
              operation: command.type,
              approvalId,
              decision: fleetDecision,
              delivered: true,
              scope: "once",
              actionHash: approval.actionHash,
            },
          },
        );
        return { approvalId, decision: fleetDecision, delivered: true, scope: "once" };
      }
    }
  }

  private async handleAppEvent(event: AppEvent, epoch: string): Promise<void> {
    if (event.nativeThreadId === undefined) return;
    const thread = this.store.snapshot().managedThreads[event.nativeThreadId];
    if (!thread || thread.appServerEpoch !== epoch) return;
    if (event.type === "thread.usage") {
      await this.store.updateManagedThread(thread.nativeThreadId, candidate => { candidate.usageObservedAt = nowIso(); });
    }
    let mappedEvent = event;
    if (event.type === "turn.completed" && event.nativeTurnId !== undefined) {
      const completedTurnId = event.nativeTurnId;
      const turn = isRecord(event.payload.turn) ? event.payload.turn : undefined;
      const status = typeof turn?.status === "string" ? turn.status : "completed";
      await this.store.updateManagedThread(thread.nativeThreadId, (candidate) => {
        if (candidate.activeTurnId === completedTurnId) delete candidate.activeTurnId;
        candidate.lastTurnId = completedTurnId;
        candidate.lastTurnStatus = status;
      });
      if (typeof event.payload.finalDiff === "string") {
        await this.emitForThread(thread, {
          type: "turn.diff.final",
          appServerEpoch: epoch,
          nativeThreadId: event.nativeThreadId,
          nativeTurnId: event.nativeTurnId,
          payload: { diff: event.payload.finalDiff },
        });
      }
      const { finalDiff: _discardedFinalDiff, ...payload } = event.payload;
      mappedEvent = {
        ...event,
        type: status === "failed" ? "turn.failed" : status === "interrupted" ? "turn.interrupted" : "turn.completed",
        payload,
      };
    }
    // Complete handoff before advertising a terminal turn (which may dispatch
    // the next queued turn). Failed release preserves the execution connection.
    if (["turn.completed", "turn.failed", "turn.interrupted"].includes(mappedEvent.type)) {
      const server = this.appServer;
      if (server?.appServerEpoch === epoch) {
        try {
          await server.unsubscribeThread(thread.nativeThreadId);
          await this.store.updateManagedThread(thread.nativeThreadId, (candidate) => { candidate.subscribed = false; });
        } catch (error) {
          await this.emitForThread(thread, { type: "agent.warning", appServerEpoch: epoch, nativeThreadId: thread.nativeThreadId,
            payload: { code: "THREAD_RELEASE_PENDING", detail: publicError(error).message } });
        }
      }
    }
    await this.emitForThread(thread, { ...mappedEvent, appServerEpoch: epoch });
    if (mappedEvent.type === "item.completed" && mappedEvent.nativeItemId) {
      const historyCursor = mappedEvent.nativeItemId;
      await this.store.updateManagedThread(thread.nativeThreadId, (candidate) => {
        candidate.historySyncInitialized = true;
        candidate.historyCursor = historyCursor;
        candidate.historyItemCount = (candidate.historyItemCount ?? 0) + 1;
        candidate.lastHistoryUpdatedAt = Math.floor(Date.now() / 1_000);
      });
    }
    if (["turn.completed", "turn.failed", "turn.interrupted"].includes(mappedEvent.type)) {
      this.notifyRegistryChanged();
    }
  }

  private handleVolatile(event: VolatileAppEvent, epoch: string): void {
    const thread = this.store.snapshot().managedThreads[event.nativeThreadId];
    if (!thread || thread.appServerEpoch !== epoch) return;
    this.callbacks.onVolatile({
      type: "volatile",
      eventType: event.type,
      producerEpoch: this.producerEpoch,
      appServerEpoch: epoch,
      projectId: thread.projectId,
      logicalSessionId: thread.logicalSessionId ?? null,
      executionSegmentId: thread.executionSegmentId ?? null,
      nativeThreadId: event.nativeThreadId,
      nativeTurnId: event.nativeTurnId,
      ...(event.nativeItemId === undefined ? {} : { nativeItemId: event.nativeItemId }),
      payload: event.payload,
    });
  }

  private async handleApproval(approval: ApprovalRecord): Promise<void> {
    await this.store.upsertApproval(approval);
    const thread = this.store.snapshot().managedThreads[approval.nativeThreadId];
    if (!thread) throw new AgentError("THREAD_NOT_MANAGED", "approval did not originate from an AgentFleet thread");
    await this.emitForThread(thread, {
      type: "approval.requested",
      nativeThreadId: approval.nativeThreadId,
      ...(approval.nativeTurnId === undefined ? {} : { nativeTurnId: approval.nativeTurnId }),
      ...(approval.nativeItemId === undefined ? {} : { nativeItemId: approval.nativeItemId }),
      payload: {
        approvalId: approval.approvalId,
        approvalVersion: 1,
        actionHash: approval.actionHash,
        appServerEpoch: approval.appServerEpoch,
        expiresAt: approval.expiresAt,
        scope: "once",
        policyVersion: POLICY_VERSION,
        action: approval.params,
      },
    });
  }

  private async handleApprovalResolved(nativeRequestId: string | number, epoch: string): Promise<void> {
    const approval = Object.values(this.store.snapshot().approvals).find(
      (entry) => entry.nativeRequestId === nativeRequestId && entry.appServerEpoch === epoch,
    );
    if (!approval) return;
    if (approval.state === "pending") await this.store.setApprovalState(approval.approvalId, "invalidated");
    const thread = this.store.snapshot().managedThreads[approval.nativeThreadId];
    if (!thread) return;
    await this.emitForThread(thread, {
      type: "approval.resolved",
      nativeThreadId: approval.nativeThreadId,
      ...(approval.nativeTurnId === undefined ? {} : { nativeTurnId: approval.nativeTurnId }),
      ...(approval.nativeItemId === undefined ? {} : { nativeItemId: approval.nativeItemId }),
      payload: { approvalId: approval.approvalId, actionHash: approval.actionHash },
    });
  }

  private async handleThreadExit(id: string, epoch: string, detail: string): Promise<void> {
    const thread = this.store.snapshot().managedThreads[id];
    if (!thread || thread.appServerEpoch !== epoch || this.appServer?.appServerEpoch !== epoch || this.shuttingDown) return;
    await this.store.handleAppServerExit(epoch, thread.projectId);
    const invalidated = await this.store.invalidateApprovals(epoch, id);
    await this.store.updateManagedThread(id, candidate => {
      candidate.policyVerified = false;
      candidate.subscribed = false;
      // Preserve active turn IDs as unknown, never announce a fabricated result.
      if (candidate.activeTurnId) candidate.appServerEpoch = `exited-${randomUUID()}`;
    });
    await this.emitForThread(thread, { type: "agent.warning", appServerEpoch: epoch, nativeThreadId: id,
      payload: { code: "APP_SERVER_EXITED", detail, invalidatedApprovalIds: invalidated.map(a => a.approvalId) } });
    this.notifyRegistryChanged();
  }

  private async handleAppExit(epoch: string, detail: string): Promise<void> {
    const isCurrent = this.appServer?.appServerEpoch === epoch;
    const isStarting = this.startingAppServer?.appServerEpoch === epoch;
    if ((!isCurrent && !isStarting) || this.exitedAppServerEpochs.has(epoch) || this.shuttingDown) return;
    this.exitedAppServerEpochs.add(epoch);
    if (isCurrent) this.appServer = undefined;
    if (isStarting) this.startingAppServer = undefined;
    this.appServerFailure = detail;
    try {
      await this.store.handleAppServerExit(epoch);
      const invalidated = await this.store.invalidateApprovals(epoch);
      for (const thread of Object.values(this.store.snapshot().managedThreads)) {
        if (thread.appServerEpoch !== epoch || thread.logicalSessionId === undefined || thread.executionSegmentId === undefined) continue;
        await this.emitForThread(thread, {
          type: "agent.warning",
          appServerEpoch: epoch,
          nativeThreadId: thread.nativeThreadId,
          payload: { code: "APP_SERVER_EXITED", detail, invalidatedApprovalIds: invalidated.map((approval) => approval.approvalId) },
        });
      }
    } catch (error) {
      this.appServerFailure = `${detail}; local reconciliation failed: ${publicError(error).message}`;
    } finally {
      this.ensureRestartSupervisor();
      this.notifyRegistryChanged();
    }
  }

  private async emitCommandState(command: FleetCommand, state: string, detail?: unknown): Promise<void> {
    const payload: Record<string, unknown> = {
      commandId: command.commandId,
      attemptId: command.attemptId,
      commandType: command.type,
      state,
      ...(detail === undefined ? {} : { detail }),
    };
    const managed = Object.values(this.store.snapshot().managedThreads).find(
      (thread) => thread.logicalSessionId === command.logicalSessionId,
    );
    await this.emit({
      type: "command.result",
      ...(command.appServerEpoch === undefined ? {} : { appServerEpoch: command.appServerEpoch }),
      projectId: command.projectId,
      logicalSessionId: command.logicalSessionId,
      executionSegmentId: command.executionSegmentId,
      contentEpoch: command.contentEpoch,
      ...(managed === undefined ? {} : { nativeThreadId: managed.nativeThreadId }),
      payload,
    });
  }

  private async emitForThread(thread: ManagedThread, event: Omit<EventInput, "machineId" | "producerEpoch">): Promise<void> {
    if (thread.logicalSessionId === undefined || thread.executionSegmentId === undefined) {
      throw new AgentError("SESSION_BINDING_UNKNOWN", "managed thread lacks a durable session binding");
    }
    await this.emit({
      ...event,
      appServerEpoch: event.appServerEpoch ?? thread.appServerEpoch,
      projectId: thread.projectId,
      logicalSessionId: thread.logicalSessionId,
      executionSegmentId: thread.executionSegmentId,
      contentEpoch: thread.contentEpoch ?? 1,
    });
  }

  private async emit(event: Omit<EventInput, "machineId" | "producerEpoch">): Promise<DurableAgentEvent> {
    const durable = await this.store.appendEvent({
      ...event,
      machineId: this.pairing.machineId,
      producerEpoch: this.producerEpoch,
    });
    this.callbacks.onOutboxChanged();
    return durable;
  }
}
