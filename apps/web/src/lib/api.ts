import type { UsageSummary } from "./usage";
import { t } from "../i18n";
import type {
  Approval,
  ClientSessionInfo,
  ControlLease,
  Dashboard,
  Enrollment,
  EnrollmentStatus,
  FleetSession,
  Machine,
  PairingPreview,
  Project,
  SessionDetail,
  TimelineEvent,
  QueuedTurn,
  CommandReceipt,
  Page,
  DiscoveryProgress,
  HostOperation,
  MaintenanceType,
} from "./types";
import { ApiError } from "./types";
import { isInlineImage } from "./image-drafts";

const CSRF_STORAGE_KEY = "agentfleet.csrf";
let csrfToken = localStorage.getItem(CSRF_STORAGE_KEY) ?? "";
let dashboardCache: Dashboard | undefined;

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function integer(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

function boolean(value: unknown): boolean {
  return value === true;
}

function timeoutSignal(signal: AbortSignal | undefined, milliseconds: number): AbortSignal {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) {
    headers.set("x-csrf-token", csrfToken);
  }

  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  let decoded: unknown;
  try {
    const text = await response.text();
    if (text.length === 0) throw new Error("empty response body");
    decoded = JSON.parse(text) as unknown;
  } catch {
    if (response.ok) {
      throw new ApiError(t("控制面返回了不完整的响应，请重试"), 502, "INVALID_RESPONSE");
    }
    throw new ApiError(t("请求未完成"), response.status, "INVALID_ERROR_RESPONSE");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new ApiError(t("控制面返回了无效响应，请重试"), 502, "INVALID_RESPONSE");
  }
  const body = decoded as JsonObject;

  if (!response.ok) {
    const error = record(body.error);
    throw new ApiError(
      string(error.message, string(body.message, t("请求未完成"))),
      response.status,
      string(error.code, string(body.code)) || undefined,
    );
  }
  if (typeof body.csrfToken === "string") {
    csrfToken = body.csrfToken;
    localStorage.setItem(CSRF_STORAGE_KEY, csrfToken);
  }
  return body as T;
}

function mapProject(rawValue: unknown): Project {
  const raw = record(rawValue);
  return {
    id: string(raw.projectId),
    machineId: string(raw.machineId),
    alias: string(raw.alias, t("未命名项目")),
    pathHint: string(raw.canonicalRoot, string(raw.repoRoot, t("路径未上报"))),
    gitBranch: typeof raw.branch === "string" ? raw.branch : null,
    gitDirty: typeof raw.dirty === "boolean" ? raw.dirty : null,
    identityVersion: integer(raw.leaseVersion),
    syncContent: raw.syncContent !== false,
    retentionDays: ([1, 3, 7, 14, 30].includes(integer(raw.retentionDays)) ? integer(raw.retentionDays) : 7) as Project["retentionDays"],
  };
}

function mapMachine(rawValue: unknown, projects: Project[]): Machine {
  const raw = record(rawValue);
  const securityDegraded = raw.securityState === "degraded_read_only";
  const rawCompatibility = string(raw.compatibility, "unknown");
  const compatibility = securityDegraded
    ? "degraded_read_only"
    : rawCompatibility === "compatible" || rawCompatibility === "incompatible"
      ? rawCompatibility
      : "unknown";
  const reachability = raw.reachability === "online"
    ? "live"
    : raw.reachability === "connecting" || raw.reachability === "reconnecting"
      ? "reconciling"
      : "unreachable";
  const capacity = ["idle", "busy", "saturated"].includes(string(raw.capacity))
    ? string(raw.capacity) as Machine["capacity"]
    : "unknown";
  const credentialProtectionLevel = raw.credentialProtectionLevel === "os_keychain"
    ? "os_protected"
    : raw.credentialProtectionLevel === "file_restricted" || raw.credentialProtectionLevel === "software_protected"
      ? "software_protected"
      : "unknown";

  return {
    id: string(raw.machineId),
    discovery: mapDiscovery(raw.discovery),
    maintenanceCapabilities: list(raw.maintenanceCapabilities).filter((item): item is string => typeof item === "string"),
    codexProfile: Object.keys(record(raw.codexProfile)).length ? record(raw.codexProfile) : undefined,
    codexCatalog: raw.codexCatalog as Machine["codexCatalog"],
    updateStatus: Object.keys(record(raw.updateStatus)).length ? record(raw.updateStatus) : undefined,
    name: string(raw.name, t("未命名主机")),
    hostname: string(raw.hostname, string(raw.name, t("未上报主机名"))),
    displayAlias: typeof raw.displayAlias === "string" ? raw.displayAlias : null,
    os: [string(raw.platform), string(raw.platformRelease)].filter(Boolean).join(" ") || t("未上报系统"),
    arch: string(raw.architecture, "unknown"),
    identity: raw.identityState === "revoked" ? "revoked" : "paired",
    reachability,
    compatibility,
    compatibilityReason: typeof raw.compatibilityReason === "string" ? raw.compatibilityReason : null,
    capacity,
    unreachableReason: typeof raw.unreachableReason === "string" ? "unknown" : null,
    credentialProtectionLevel,
    agentVersion: string(raw.agentVersion, "unknown"),
    codexVersion: string(raw.codexVersion, "unknown"),
    schemaHash: typeof raw.schemaHash === "string" ? raw.schemaHash : null,
    lastSeenAt: typeof raw.lastHeartbeatAt === "string" ? raw.lastHeartbeatAt : null,
    projects: projects.filter((project) => project.machineId === string(raw.machineId)),
  };
}

function mapDiscovery(rawValue: unknown): DiscoveryProgress | undefined {
  const raw = record(rawValue);
  if (!["scanning", "ready", "error"].includes(string(raw.state))) return undefined;
  return { scanId: string(raw.scanId) || undefined, state: raw.state as DiscoveryProgress["state"], discoveredProjects: integer(raw.discoveredProjects), discoveredSessions: integer(raw.discoveredSessions), scannedPages: integer(raw.scannedPages), scannedCount: integer(raw.scannedCount), lastSuccessfulAt: string(raw.lastSuccessfulAt) || null, error: string(raw.error) || null, errorCode: string(raw.errorCode) || null,
    skippedCount: integer(raw.skippedCount),
    readiness: ["ready", "checking", "read_only", "action_required"].includes(string(raw.readiness)) ? raw.readiness as DiscoveryProgress["readiness"] : undefined,
    backgroundSync: raw.backgroundSync === true,
    syncMode: raw.syncMode === "events" || raw.syncMode === "fallback" ? raw.syncMode : undefined,
    reconcileIntervalSeconds: integer(raw.reconcileIntervalSeconds),
    checks: list(raw.checks).flatMap(item => {
      const value = record(item);
      if (!["passed", "failed", "checking", "skipped"].includes(string(value.state)) || !string(value.id)) return [];
      return [{ id: string(value.id), state: value.state as NonNullable<DiscoveryProgress["checks"]>[number]["state"], code: string(value.code), message: string(value.message), checkedAt: string(value.checkedAt),
        action: ["catalog.refresh", "agent.update", "runtime.reconnect", "diagnostics.collect"].includes(string(value.action)) ? value.action as MaintenanceType : undefined }];
    }),
  };
}

function mapLease(rawValue: unknown, clientSessionId: string): ControlLease | null {
  if (!rawValue) return null;
  const raw = record(rawValue);
  const id = string(raw.leaseId);
  if (!id) return null;
  const holderClientSessionId = string(raw.holderClientSessionId);
  return {
    id,
    logicalSessionId: string(raw.logicalSessionId),
    holderClientSessionId,
    holderLabel: raw.isMine === true || holderClientSessionId === clientSessionId ? t("当前账号") : t("其他账号"),
    version: integer(raw.version),
    expiresAt: string(raw.expiresAt),
    isMine: typeof raw.isMine === "boolean" ? raw.isMine : holderClientSessionId === clientSessionId,
  };
}

function currentTurnState(executionState: string): FleetSession["state"]["currentTurn"] {
  if (executionState === "running" || executionState === "awaiting_approval") return "in_progress";
  if (executionState === "completed") return "completed";
  if (executionState === "interrupted") return "interrupted";
  if (executionState === "failed") return "failed";
  if (executionState === "idle") return "none";
  return "unknown";
}

function versionAtLeast(value: string | undefined, minimum: string): boolean {
  if (!value) return false;
  const parse = (version: string) => version.split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  const current = parse(value);
  const required = parse(minimum);
  if (current.length !== 3 || required.length !== 3 || current.some((part) => !Number.isSafeInteger(part)) || required.some((part) => !Number.isSafeInteger(part))) return false;
  for (let index = 0; index < 3; index += 1) {
    if (current[index]! > required[index]!) return true;
    if (current[index]! < required[index]!) return false;
  }
  return true;
}

function mapSession(
  rawValue: unknown,
  machines: Machine[],
  projects: Project[],
  clientSessionId: string,
): FleetSession {
  const raw = record(rawValue);
  const machineId = string(raw.machineId);
  const projectId = string(raw.projectId);
  const machine = machines.find((item) => item.id === machineId);
  const project = projects.find((item) => item.id === projectId);
  const executionState = string(raw.executionState, "unknown");
  const reachability = raw.reachability === "live"
    ? "live"
    : raw.reachability === "reconciling"
      ? "reconciling"
      : "unreachable";
  const historyCompleteness = string(raw.historyCompleteness, "unknown");
  const historyMode = raw.historyMode === "legacy" || raw.historyMode === "paginated" ? raw.historyMode : "unknown";
  const managed = boolean(raw.managed);
  const history = historyCompleteness === "complete"
    ? "complete"
    : historyCompleteness === "partial"
      ? "partial"
      : "metadata_only";

  return {
    weeklyTokens: typeof raw.weeklyTokens === "number" && Number.isSafeInteger(raw.weeklyTokens) && raw.weeklyTokens >= 0 ? raw.weeklyTokens : null,
    weeklyBoundaryIncomplete: raw.weeklyBoundaryIncomplete === true,
    recordedTokens: typeof raw.recordedTokens === "number" && Number.isSafeInteger(raw.recordedTokens) && raw.recordedTokens >= 0 ? raw.recordedTokens : null,
    id: string(raw.logicalSessionId),
    runtimeSettings: raw.runtimeSettings as FleetSession["runtimeSettings"],
    title: string(raw.title, t("未命名会话")),
    machineId,
    machineName: machine?.name ?? t("未知主机"),
    projectId,
    projectAlias: project?.alias ?? string(raw.projectAlias, t("未知项目")),
    nativeThreadId: typeof raw.nativeThreadId === "string" ? raw.nativeThreadId : null,
    historyMode,
    state: {
      ownership: managed ? "agentfleet_owned" : historyMode !== "unknown" ? "claimable" : "external_owned",
      threadRuntime: executionState === "unknown"
        ? "unknown"
        : executionState === "running" || executionState === "awaiting_approval"
          ? "active"
          : "idle",
      currentTurn: currentTurnState(executionState),
      waitReason: executionState === "awaiting_approval" ? "approval" : "none",
      reachability,
      history,
      unknownFreeze: executionState === "unknown" || machine?.compatibility === "degraded_read_only",
    },
    lastActivityAt: string(raw.updatedAt, new Date(0).toISOString()),
    sessionSeq: integer(raw.latestSessionSeq),
    projectionEpoch: integer(raw.projectionEpoch, 1),
    contentEpoch: integer(raw.contentEpoch, 1),
    executionSegmentId: string(raw.executionSegmentId),
    threadControlVersion: integer(raw.threadControlVersion),
    turnControlVersion: integer(raw.turnControlVersion),
    projectLeaseVersion: integer(raw.projectLeaseVersion),
    controlLeaseVersion: integer(raw.controlLeaseVersion),
    imageInputSupported: raw.imageInputSupported === true,
    cloudImageRevision: integer(raw.cloudImageRevision),
    queueVersion: integer(raw.queueVersion),
    activeTurnId: typeof raw.activeTurnId === "string" ? raw.activeTurnId : null,
    controlLease: mapLease(raw.controlLease, clientSessionId),
    ...(raw.actions && typeof raw.actions === "object" ? { actions: raw.actions as FleetSession["actions"] } : {}),
  };
}

export function mapCommandReceipt(rawValue: unknown): CommandReceipt {
  const raw = record(rawValue);
  const error = record(raw.error);
  return {
    id: string(raw.commandId), type: string(raw.type), state: string(raw.state, "unknown"),
    clientMutationId: string(raw.clientMutationId) || undefined,
    outcome: typeof raw.outcome === "string" ? raw.outcome : undefined,
    createdAt: string(raw.createdAt), updatedAt: string(raw.updatedAt) || undefined,
    message: string(error.message, string(raw.message)) || null,
    prompt: raw.payloadState === "deleted" ? null : string(record(raw.payload).prompt) || null,
    deletionPreview: raw.payloadState !== "deleted" && raw.type === "thread.delete.preview" ? record(raw.result).deletionPreview as CommandReceipt["deletionPreview"] : undefined,
    writerReleased: raw.type === "thread.release" && record(raw.result).writerReleased === true,
    inspection: raw.payloadState !== "deleted" && raw.type === "codex.inspect" ? record(raw.result).inspection as CommandReceipt["inspection"] : undefined,
  };
}

function mapHostOperation(value: unknown): HostOperation {
  const raw = record(value);
  return { id: string(raw.operationId), type: string(raw.type) as MaintenanceType, state: string(raw.state, "unknown") as HostOperation["state"], createdAt: string(raw.createdAt), updatedAt: string(raw.updatedAt), expiresAt: string(raw.expiresAt) || undefined, result: raw.result ? record(raw.result) : null, error: raw.error ? { code: string(record(raw.error).code), message: string(record(raw.error).message) } : null };
}

function eventBody(item: JsonObject, payload: JsonObject): string | null {
  if (item.type === "userMessage") {
    const body = list(item.content)
      .map((entry) => string(record(entry).text))
      .filter(Boolean)
      .join("\n");
    return body || null;
  }
  if (item.type === "agentMessage" || item.type === "plan") return string(item.text) || null;
  if (item.type === "reasoning") return list(item.summary).map((entry) => string(entry)).filter(Boolean).join("\n") || null;
  if (typeof payload.message === "string") return payload.message;
  return null;
}

function eventTitle(type: string, item: JsonObject): string {
  if (item.type === "userMessage") return t("你");
  if (item.type === "agentMessage") return "Codex";
  if (item.type === "plan") return t("计划");
  if (item.type === "reasoning") return t("推理摘要");
  if (item.type === "commandExecution") return t("命令执行");
  if (item.type === "fileChange") return t("文件变更");
  const titles: Record<string, string> = {
    "thread.started": t("受管 Thread 已创建"),
    "turn.started": t("Turn 开始"),
    "turn.completed": t("Turn 完成"),
    "turn.failed": t("Turn 失败"),
    "turn.interrupted": t("Turn 已取消"),
    "turn.error": t("Codex 错误"),
    "turn.diff.final": t("最终变更"),
    "approval.requested": t("等待一次性审批"),
    "approval.resolved": t("审批请求已结束"),
    "command.result": t("远端命令结果"),
    "agent.warning": t("Agent 警告"),
  };
  return titles[type] ?? type;
}

function diffSummary(diff: string): TimelineEvent["diff"] {
  if (!diff) return null;
  const lines = diff.split("\n");
  return {
    additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
    files: new Set(lines.filter((line) => line.startsWith("diff --git "))).size || 1,
  };
}

export function mapEvent(rawValue: unknown): TimelineEvent {
  const raw = record(rawValue);
  const payload = record(raw.payload);
  const item = record(payload.item);
  const type = string(raw.type, "unknown");
  const itemType = string(item.type);
  const actor = itemType === "userMessage"
    ? "user"
    : ["agentMessage", "plan", "reasoning"].includes(itemType)
      ? "agent"
      : "system";
  const diffText = string(payload.diff, string(payload.finalDiff));
  return {
    id: string(raw.eventId, `${integer(raw.sessionSeq)}-${type}`),
    nativeThreadId: string(raw.nativeThreadId) || undefined,
    nativeTurnId: string(raw.nativeTurnId) || undefined,
    nativeItemId: string(raw.nativeItemId, string(item.id)) || undefined,
    executionSegmentId: string(raw.executionSegmentId) || undefined,
    sessionSeq: integer(raw.sessionSeq),
    type,
    occurredAt: string(raw.occurredAt, new Date().toISOString()),
    actor,
    title: eventTitle(type, item),
    images: list(item.content).map(record).filter(entry => entry.type === "image" && isInlineImage(entry.url)).slice(0, 4).map(entry => entry.url as string),
    body: eventBody(item, payload),
    payloadState: raw.payloadState === "deleted" || raw.payloadState === "suppressed" ? raw.payloadState : "present",
    status: string(item.status, string(record(payload.turn).status)) || null,
    command: itemType === "commandExecution" ? string(item.command) || null : null,
    output: itemType === "commandExecution" ? string(item.aggregatedOutput) || null : null,
    diff: diffSummary(diffText),
  };
}

function commandText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => string(item)).filter(Boolean).join(" ") || null;
  return null;
}

function approvalPaths(action: JsonObject): string[] {
  const direct = list(action.paths).map((value) => string(value)).filter(Boolean);
  const changes = list(action.changes).map((value) => string(record(value).path)).filter(Boolean);
  const fileChanges = Array.isArray(action.fileChanges)
    ? action.fileChanges.map((value) => string(record(value).path)).filter(Boolean)
    : Object.keys(record(action.fileChanges));
  return [...new Set([...direct, ...changes, ...fileChanges, ...(typeof action.grantRoot === "string" ? [action.grantRoot] : [])])];
}

function mapApproval(rawValue: unknown, sessions: FleetSession[], machines: Machine[], projects: Project[]): Approval {
  const raw = record(rawValue);
  const context = record(raw.context);
  const action = record(context.action ?? context.context ?? context);
  const network = record(action.networkApprovalContext);
  const logicalSessionId = string(raw.logicalSessionId);
  const session = sessions.find((item) => item.id === logicalSessionId);
  const machine = machines.find((item) => item.id === session?.machineId);
  const project = projects.find((item) => item.id === session?.projectId);
  const command = commandText(action.command ?? action.cmd ?? action.parsedCmd);
  const paths = approvalPaths(action);
  const riskText = string(action.risk, string(action.reason)).toLowerCase();
  const risk = /high|danger|destructive|sudo|delete|outside|network/.test(riskText) || /(^|\s)(rm|sudo)\s/.test(command ?? "")
    ? "high"
    : /low|read.only|只读/.test(riskText)
      ? "low"
      : "medium";
  const rawState = string(raw.state, "pending");
  const status: Approval["status"] = rawState === "pending" ? "pending" : "decided";
  const expiresAt = string(context.expiresAt, new Date(Date.parse(string(raw.createdAt, new Date().toISOString())) + 5 * 60_000).toISOString());
  return {
    id: string(raw.approvalId),
    networkTarget: string(network.host) ? `${string(network.protocol, "network")} · ${string(network.host)}` : undefined,
    additionalPermissions: action.kind === "permissions" ? JSON.stringify(action.permissions, null, 2) : string(action.additionalPermissions) || undefined,
    grantScope: action.kind === "permissions" ? "turn" : undefined,
    logicalSessionId,
    approvalVersion: integer(raw.approvalVersion, 1),
    type: action.kind === "user_input" ? "user_input" : command ? "command" : "file_change",
    questions: action.kind === "user_input" ? list(action.questions).map((value) => {
      const question = record(value);
      return { id: string(question.id), header: string(question.header), question: string(question.question), options: list(question.options).map((v) => { const o = record(v); return { label: string(o.label), description: string(o.description) }; }) };
    }) : undefined,
    status,
    machineName: machine?.name ?? session?.machineName ?? t("未知主机"),
    projectAlias: project?.alias ?? session?.projectAlias ?? t("未知项目"),
    cwd: string(action.cwd, project?.pathHint ?? t("路径未上报")),
    summary: action.kind === "user_input" ? t("Codex 等待你的回答") : string(action.reason, command ? t("执行命令需要确认") : paths.length ? t("写入文件需要确认") : t("操作需要确认")),
    command,
    paths,
    risk,
    policyVersion: string(context.policyVersion, "remote-restricted-v1"),
    actionHash: string(raw.actionHash),
    appServerEpoch: string(raw.appServerEpoch),
    expiresAt,
  };
}

function mapPairing(rawValue: unknown): PairingPreview {
  const raw = record(rawValue);
  const machine = record(raw.machine);
  return {
    id: string(raw.pairingId),
    userCode: string(raw.userCode),
    machineName: string(machine.name, t("未命名主机")),
    os: [string(machine.platform), string(machine.platformRelease)].filter(Boolean).join(" ") || t("未上报系统"),
    arch: string(machine.architecture, "unknown"),
    fingerprint: string(raw.publicKeyFingerprint),
    verificationPhrase: string(raw.verificationPhrase),
    expiresAt: string(raw.expiresAt),
  };
}

export function mapEnrollment(rawValue: unknown): Enrollment {
  const envelope = record(rawValue);
  const raw = Object.keys(record(envelope.enrollment)).length > 0 ? record(envelope.enrollment) : envelope;
  const machine = record(raw.machine);
  const pairing = record(raw.pairing);
  const rawStatus = string(raw.status, string(raw.state));
  const statusAliases: Record<string, EnrollmentStatus> = {
    created: "pending",
    waiting: "pending",
    pending: "pending",
    claimed: "claimed",
    awaiting_confirmation: "claimed",
    confirmed: "confirmed",
    completed: "redeemed",
    redeemed: "redeemed",
    expired: "expired",
    cancelled: "cancelled",
    revoked: "cancelled",
  };
  const id = string(raw.enrollmentId, string(raw.id));
  const status = statusAliases[rawStatus];
  const expiresAt = string(raw.expiresAt);
  if (!id || status === undefined || !expiresAt || !Number.isFinite(Date.parse(expiresAt))) {
    throw new ApiError(t("控制面返回了不完整的配对状态，请重试"), 502, "INVALID_ENROLLMENT_RESPONSE");
  }
  const rawReachability = string(raw.machineReachability);
  const machineReachability = ["offline", "connecting", "online", "reconnecting"].includes(rawReachability)
    ? rawReachability as NonNullable<Enrollment["machineReachability"]>
    : undefined;
  return {
    id,
    bootstrapSecret: string(raw.bootstrapSecret) || undefined,
    claimUrl: string(raw.claimUrl) || undefined,
    status,
    machineName: string(machine.name, string(raw.machineName)) || undefined,
    os: [string(machine.platform, string(raw.platform)), string(machine.platformRelease, string(raw.platformRelease))].filter(Boolean).join(" ") || undefined,
    arch: string(machine.architecture, string(raw.architecture)) || undefined,
    fingerprint: string(raw.publicKeyFingerprint, string(pairing.publicKeyFingerprint, string(raw.fingerprint))) || undefined,
    verificationPhrase: string(raw.verificationPhrase, string(pairing.verificationPhrase)) || undefined,
    machineId: string(raw.machineId) || undefined,
    machineReady: raw.machineReady === true,
    discovery: mapDiscovery(raw.discovery),
    ...(machineReachability === undefined ? {} : { machineReachability }),
    ...(typeof raw.projectCount === "number" && Number.isSafeInteger(raw.projectCount) && raw.projectCount >= 0
      ? { projectCount: raw.projectCount }
      : {}),
    ...(typeof raw.recoveryExpiresAt === "string" && Number.isFinite(Date.parse(raw.recoveryExpiresAt))
      ? { recoveryExpiresAt: raw.recoveryExpiresAt }
      : {}),
    expiresAt,
  };
}

async function loadDashboard(): Promise<Dashboard> {
  const rawStatus = await request<JsonObject>("/api/auth/status");
  if (!boolean(rawStatus.authenticated)) {
    throw new ApiError("Authentication is required", 401, "AUTH_REQUIRED");
  }
  const [rawDashboard, rawProjects, rawSessions, rawApprovals] = await Promise.all([
    request<JsonObject>("/api/dashboard"),
    request<JsonObject>("/api/projects?limit=100"),
    request<JsonObject>("/api/sessions?limit=100"),
    request<JsonObject>("/api/approvals?state=pending"),
  ]);
  const me = record(rawStatus.user);
  const clientSessionId = string(rawStatus.clientSessionId);
  const projects = list(rawProjects.items ?? rawProjects.projects).map(mapProject);
  const machines = list(rawDashboard.machines).map((machine) => mapMachine(machine, projects));
  const sessions = list(rawSessions.items ?? rawSessions.sessions).map((session) => mapSession(session, machines, projects, clientSessionId));
  const approvals = list(rawApprovals.approvals).map((approval) => mapApproval(approval, sessions, machines, projects));
  const counts = record(rawDashboard.counts);
  const rawProfile = record(rawDashboard.compatibilityProfile);
  const email = string(me.email);
  const dashboard: Dashboard = {
    user: {
      id: string(me.userId),
      email,
      displayName: email.split("@")[0] || "Admin",
      clientSessionId,
    },
    machines,
    sessions,
    pendingApprovals: approvals,
    activitySessions: Array.isArray(rawDashboard.activitySessions) ? rawDashboard.activitySessions.map(session => mapSession(session, machines, projects, clientSessionId)) : sessions,
    compatibilityProfile: {
      profileVersion: string(rawProfile.profileVersion, t("未发布")),
      validationStatus: rawProfile.validationStatus === "verified" ? "verified" : "unknown",
      protocol: string(rawProfile.protocol, "codex-app-server-v2"),
      minimumCodexVersion: string(rawProfile.minimumCodexVersion, "unknown"),
      managedCodexVersion: string(rawProfile.managedCodexVersion, "unknown"),
      schemaHash: string(rawProfile.schemaHash),
      lastValidatedAt: string(rawProfile.lastValidatedAt),
      upgradePolicy: rawProfile.upgradePolicy === "when-promoted" ? "when-promoted" : "unknown",
    },
    stats: {
      liveMachines: integer(counts.onlineMachines, machines.filter((machine) => machine.reachability === "live").length),
      runningTurns: integer(counts.activeSessions, sessions.filter((session) => session.state.currentTurn === "in_progress").length),
      approvals: integer(counts.pendingApprovals, approvals.length),
    },
    serverTime: new Date().toISOString(),
  };
  dashboardCache = dashboard;
  return dashboard;
}

export interface RuntimeReleaseStatus {
  configured: boolean; paused: boolean; workerOnline: boolean; phase: string; message: string;
  latestVersion?: string; lastCheckedAt?: string; nextCheckAt?: string;
  target?: { version: string }; previous?: { version: string };
  checks: { name: string; state: string; detail: string }[];
  history: { at: string; version: string; result: string; message: string }[];
}

export const api = {
  usage: (scope: "session" | "project" | "machine", id: string, signal?: AbortSignal) => request<UsageSummary>(`/api/${scope === "session" ? "sessions" : scope === "project" ? "projects" : "machines"}/${encodeURIComponent(id)}/usage`, { signal }),
  imageSessions: (id: string, cursor = "", signal?: AbortSignal) => request<{sessions: import("./types").ImageSessionUsage[]; nextCursor: string | null}>(`/api/machines/${encodeURIComponent(id)}/images/sessions?cursor=${encodeURIComponent(cursor)}`, { signal }),
  async imageOperation(machineId: string, logicalSessionId: string, previewOperationId?: string): Promise<HostOperation> {
    const raw = await request<JsonObject>(`/api/machines/${encodeURIComponent(machineId)}/operations`, { method: "POST", body: JSON.stringify({type: previewOperationId ? "images.clean" : "images.preview", logicalSessionId, previewOperationId, clientMutationId: crypto.randomUUID()}) });
    return mapHostOperation(raw.operation);
  },
  async readImageOperation(operationId: string): Promise<HostOperation> {
    return mapHostOperation((await request<JsonObject>(`/api/operations/${encodeURIComponent(operationId)}`)).operation);
  },
  machineImages: (id: string, signal?: AbortSignal) => request<import("./types").CloudImageUsage>(`/api/machines/${encodeURIComponent(id)}/images`, { signal }),
  clearMachineImages: (id: string, revision: number) => request<import("./types").CloudImageUsage>(`/api/machines/${encodeURIComponent(id)}/images/clear`, { method: "POST", body: JSON.stringify({ revision, confirmCloudOnly: true }) }),
  runtimeRelease: (signal?: AbortSignal) => request<RuntimeReleaseStatus>("/api/runtime-release", { signal }),
  runtimeReleaseControl: (action: "check" | "pause" | "resume" | "rollback") => request<RuntimeReleaseStatus>("/api/runtime-release/control", { method: "POST", body: JSON.stringify({ action }) }),
  codexPreferences: (id: string, signal?: AbortSignal) => request<import("./codex-settings").CodexPreferences>(`/api/sessions/${encodeURIComponent(id)}/codex-settings`, { signal }),
  machineCodexPreferences: (id: string, signal?: AbortSignal) => request<import("./codex-settings").CodexPreferences>(`/api/machines/${encodeURIComponent(id)}/codex-settings`, { signal }),
  saveMachineCodexPreferences: (id: string, input: { settings: import("./codex-settings").CodexSettings | null; revision: number }) => request<import("./codex-settings").CodexPreferences>(`/api/machines/${encodeURIComponent(id)}/codex-settings`, { method: "PUT", body: JSON.stringify(input) }),
  saveCodexPreferences: (id: string, input: { scope: string; settings: import("./codex-settings").CodexSettings | null; revision: number }) => request<import("./codex-settings").CodexPreferences>(`/api/sessions/${encodeURIComponent(id)}/codex-settings`, { method: "PUT", body: JSON.stringify(input) }),
  async login(email: string, password: string) {
    await request<JsonObject>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    return { dashboard: await loadDashboard() };
  },
  async logout() {
    try {
      await request<JsonObject>("/api/auth/logout", { method: "POST" });
    } finally {
      csrfToken = "";
      dashboardCache = undefined;
      localStorage.removeItem(CSRF_STORAGE_KEY);
    }
  },
  dashboard: loadDashboard,
  permissions(kind: "machines" | "sessions", id: string, signal?: AbortSignal) {
    return request<import("./permissions").PermissionPreferences>(`/api/${kind}/${encodeURIComponent(id)}/permissions`, { signal });
  },
  savePermissions(kind: "machines" | "sessions", id: string, input: { scope: import("./permissions").PermissionScope; profile: import("./permissions").PermissionProfile | null; revision: number; confirmFullAccess?: boolean }) {
    return request<import("./permissions").PermissionPreferences>(`/api/${kind}/${encodeURIComponent(id)}/permissions`, { method: "PUT", body: JSON.stringify(input) });
  },
  async release() {
    const raw = await request<JsonObject>("/api/release");
    return { build: string(raw.controlPlaneBuild, t("未上报")), schema: integer(raw.dbSchemaVersion), agentVersion: string(raw.agentVersion, t("未发布")), manifestStatus: string(record(raw.agentManifest).status, "unavailable") };
  },
  async projects(options: { machineId?: string; cursor?: string | null; q?: string; limit?: number }, signal?: AbortSignal): Promise<Page<Project>> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 8) });
    for (const [key, value] of Object.entries(options)) if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    const raw = await request<JsonObject>(`/api/projects?${query}`, { signal });
    return { items: list(raw.items ?? raw.projects).map(mapProject), nextCursor: typeof raw.nextCursor === "string" ? raw.nextCursor : null };
  },
  async sessions(options: { machineId?: string; projectId?: string; cursor?: string | null; q?: string; executionState?: string; limit?: number }, signal?: AbortSignal): Promise<Page<FleetSession>> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 30) });
    for (const [key, value] of Object.entries(options)) if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    const raw = await request<JsonObject>(`/api/sessions?${query}`, { signal });
    const cached = dashboardCache;
    return { items: list(raw.items ?? raw.sessions).map((item) => mapSession(item, cached?.machines ?? [], cached?.machines.flatMap((machine) => machine.projects) ?? [], cached?.user.clientSessionId ?? "")), nextCursor: typeof raw.nextCursor === "string" ? raw.nextCursor : null };
  },
  async history(id: string, beforeSeq?: number | null, signal?: AbortSignal) {
    const query = new URLSearchParams({ limit: "100" });
    if (beforeSeq !== undefined && beforeSeq !== null) query.set("beforeSeq", String(beforeSeq));
    const raw = await request<JsonObject>(`/api/sessions/${encodeURIComponent(id)}/events?${query}`, { signal });
    return { events: list(raw.items ?? raw.events).map(mapEvent), nextBeforeSeq: typeof raw.nextBeforeSeq === "number" ? raw.nextBeforeSeq : null, projectionEpoch: integer(raw.projectionEpoch), contentEpoch: integer(raw.contentEpoch), throughSeq: integer(raw.throughSeq) };
  },
  async commandReceipts(id: string, signal?: AbortSignal): Promise<CommandReceipt[]> {
    const raw = await request<JsonObject>(`/api/sessions/${encodeURIComponent(id)}`, { signal: timeoutSignal(signal, 15_000) });
    return list(raw.commands).map(mapCommandReceipt);
  },
  async session(id: string, signal?: AbortSignal): Promise<SessionDetail> {
    const [rawDetail, rawApprovals, history] = await Promise.all([
      request<JsonObject>(`/api/sessions/${encodeURIComponent(id)}`, { signal }),
      request<JsonObject>("/api/approvals?state=pending", { signal }),
      api.history(id, undefined, signal),
    ]);
    const cached = dashboardCache;
    const machines = cached?.machines ?? [];
    const projects = machines.flatMap((machine) => machine.projects);
    const clientSessionId = cached?.user.clientSessionId ?? "";
    const session = mapSession(rawDetail.session, machines, projects, clientSessionId);
    const approvals = list(rawApprovals.approvals).map((approval) => mapApproval(approval, [session], machines, projects));
    const machine = machines.find((item) => item.id === session.machineId);
    const releaseManagementSupported = session.actions?.release?.reasonCode !== "UNSUPPORTED_COMMAND" && (session.actions?.release !== undefined || versionAtLeast(machine?.agentVersion, "0.16.2"));
    const commands = list(rawDetail.commands).map(record);
    const queue: QueuedTurn[] = list(rawDetail.queue).map((value) => {
      const item = record(value);
      const linked = commands.find((command) => string(command.commandId) === string(item.commandId));
      const payload = record(linked?.payload);
      const rawState = string(item.state, "invalidated");
      const state = ["queued", "dispatching", "cancelled", "expired", "invalidated", "applied", "unknown"].includes(rawState)
        ? rawState as QueuedTurn["state"]
        : "invalidated";
      return {
        id: string(item.queueItemId),
        commandId: string(item.commandId),
        position: integer(item.position),
        state,
        waitingForHost: state === "dispatching" && string(linked?.state) === "accepted",
        prompt: string(payload.prompt, t("正文已删除")),
        createdAt: string(item.createdAt),
        expiresAt: string(item.expiresAt),
        mine: string(item.actorClientSessionId) === clientSessionId,
      };
    });
    const writable = session.state.ownership === "agentfleet_owned"
      && session.state.reachability === "live"
      && machine?.identity === "paired"
      && machine.compatibility === "compatible"
      && !session.state.unknownFreeze;
    let writeBlockedReason: string | null = null;
    if (session.state.ownership === "claimable") writeBlockedReason = t("先接管并同步这个宿主机会话");
    else if (session.state.ownership !== "agentfleet_owned") writeBlockedReason = t("等待主机上报可恢复的历史模式");
    else if (machine?.compatibility === "degraded_read_only") writeBlockedReason = t("主机安全状态要求只读");
    else if (machine?.compatibility !== "compatible") writeBlockedReason = t("主机版本或平台不兼容");
    else if (session.state.reachability !== "live") writeBlockedReason = t("等待主机恢复在线并完成对账");
    else if (session.state.unknownFreeze) writeBlockedReason = t("结果待核验，写入已冻结");
    return {
      session,
      events: history.events,
      historyPage: { ...history, projectionEpoch: history.projectionEpoch || session.projectionEpoch, contentEpoch: history.contentEpoch || session.contentEpoch },
      approval: approvals.find((approval) => approval.logicalSessionId === id) ?? null,
      writable,
      writeBlockedReason,
      recoverySupported: Boolean(machine?.maintenanceCapabilities?.includes("session.reconcile")),
      commandRecoverySupported: machine?.maintenanceCapabilities?.includes("commands.reconcile") === true,
      releaseManagementSupported,
      releaseManagementBlockedReason: session.actions?.release?.message ?? (releaseManagementSupported ? null : t("当前 Agent 尚未支持取消接管，请在主机页面检查更新")),
      queue,
      commands: commands.map(mapCommandReceipt),
    };
  },
  async createSession(machineId: string, projectId: string, title: string) {
    const raw = await request<JsonObject>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ machineId, projectId, title }),
    });
    const cached = dashboardCache;
    const machines = cached?.machines ?? [];
    const projects = machines.flatMap((machine) => machine.projects);
    return { session: mapSession(raw, machines, projects, cached?.user.clientSessionId ?? "") };
  },
  async acquireLease(logicalSessionId: string, expectedVersion?: number) {
    const raw = await request<JsonObject>(`/api/sessions/${encodeURIComponent(logicalSessionId)}/control-lease`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion }),
    });
    const lease = mapLease(raw, dashboardCache?.user.clientSessionId ?? "");
    if (!lease) throw new ApiError(t("控制权响应无效"), 502, "INVALID_LEASE_RESPONSE");
    return { lease };
  },
  async renewLease(logicalSessionId: string, leaseId: string, expectedVersion: number) {
    const raw = await request<JsonObject>(
      `/api/sessions/${encodeURIComponent(logicalSessionId)}/control-lease/${encodeURIComponent(leaseId)}/renew`,
      {
        method: "POST",
        body: JSON.stringify({ expectedVersion }),
      },
    );
    const lease = mapLease(raw, dashboardCache?.user.clientSessionId ?? "");
    if (!lease) throw new ApiError(t("控制权续期响应无效"), 502, "INVALID_LEASE_RESPONSE");
    return { lease };
  },
  releaseLease(logicalSessionId: string, leaseId: string, expectedVersion: number) {
    return request<JsonObject>(`/api/sessions/${encodeURIComponent(logicalSessionId)}/control-lease/${encodeURIComponent(leaseId)}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedVersion }),
    });
  },
  removeMachine(machineId: string) {
    return request<{ ok: true }>(`/api/machines/${encodeURIComponent(machineId)}`, { method: "DELETE" });
  },
  updateMachineAlias(machineId: string, alias: string | null) {
    return request<{ machine: JsonObject }>(`/api/machines/${encodeURIComponent(machineId)}`, {
      method: "PATCH",
      body: JSON.stringify({ alias }),
    });
  },
  async hostOperations(machineId: string, signal?: AbortSignal): Promise<HostOperation[]> {
    const raw = await request<JsonObject>(`/api/machines/${encodeURIComponent(machineId)}/operations`, { signal });
    return list(raw.operations).map(mapHostOperation);
  },
  async hostOperation(machineId: string, type: MaintenanceType, clientMutationId: string, logicalSessionId?: string): Promise<HostOperation> {
    const raw = await request<JsonObject>(`/api/machines/${encodeURIComponent(machineId)}/operations`, { method: "POST", body: JSON.stringify({ type, clientMutationId, ...(logicalSessionId ? {logicalSessionId} : {}) }) });
    return mapHostOperation(raw.operation);
  },
  updateProjectContentPolicy(projectId: string, syncContent: boolean, retentionDays: Project["retentionDays"]) {
    return request<{ project: JsonObject }>(`/api/projects/${encodeURIComponent(projectId)}/content-policy`, {
      method: "PATCH",
      body: JSON.stringify({ syncContent, retentionDays }),
    });
  },
  async command(
    logicalSessionId: string,
    input: {
      type: "thread.delete.preview" | "thread.delete" | "thread.claim" | "thread.release" | "thread.rename" | "thread.archive" | "thread.unarchive" | "thread.fork" | "turn.start" | "turn.compact" | "turn.review" | "turn.queue" | "turn.steer" | "turn.cancel" | "input.respond" | "codex.inspect" | "thread.terminals.stop";
      payload: Record<string, unknown>;
      controlLeaseId?: string;
      precondition: Record<string, unknown>;
      clientMutationId: string;
      expiresInSeconds?: number;
    },
  ) {
    // Acquire/refresh just before an explicit action. Merely viewing a session
    // never holds or renews operation access, and another browser needs no handoff.
    if (["thread.claim", "thread.release", "thread.rename", "thread.archive", "thread.unarchive", "thread.fork", "thread.delete.preview", "thread.delete", "turn.start", "turn.compact", "turn.review", "turn.cancel", "thread.terminals.stop"].includes(input.type)) {
      const { lease } = await api.acquireLease(logicalSessionId);
      input = { ...input, controlLeaseId: lease.id };
    }
    const response = await request<JsonObject>(`/api/sessions/${encodeURIComponent(logicalSessionId)}/commands`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return { command: mapCommandReceipt(response.command) };
  },
  cancelQueuedTurn(logicalSessionId: string, queueItemId: string) {
    return request<JsonObject>(
      `/api/sessions/${encodeURIComponent(logicalSessionId)}/queue/${encodeURIComponent(queueItemId)}`,
      { method: "DELETE" },
    );
  },
  decideApproval(id: string, input: { decision: "accept" | "decline"; approvalVersion: number; actionHash: string }) {
    const approval = dashboardCache?.pendingApprovals.find((item) => item.id === id);
    return request<JsonObject>(`/api/approvals/${encodeURIComponent(id)}/decision`, {
      method: "POST",
      body: JSON.stringify({
        decision: input.decision === "accept" ? "approve" : "reject",
        approvalVersion: input.approvalVersion,
        actionHash: input.actionHash,
        appServerEpoch: approval?.appServerEpoch,
        scope: "once",
        clientMutationId: crypto.randomUUID(),
      }),
    });
  },
  async pairingPreview(userCode: string) {
    const raw = await request<JsonObject>(`/api/pairings/preview?userCode=${encodeURIComponent(userCode)}`);
    return { pairing: mapPairing(raw) };
  },
  confirmPairing(id: string, verificationPhrase: string) {
    return request<JsonObject>(`/api/pairings/${encodeURIComponent(id)}/confirm`, {
      method: "POST",
      body: JSON.stringify({ verificationPhrase }),
    });
  },
  async createEnrollment() {
    const raw = await request<JsonObject>("/api/enrollments", {
      method: "POST",
      body: JSON.stringify({ preauthorized: true }),
      signal: timeoutSignal(undefined, 10_000),
    });
    const enrollment = mapEnrollment(raw);
    if (!enrollment.bootstrapSecret) {
      throw new ApiError(t("控制面没有返回完整的一次性安装票据，请重试"), 502, "INVALID_ENROLLMENT_RESPONSE");
    }
    return { enrollment };
  },
  async enrollment(id: string, signal?: AbortSignal) {
    const raw = await request<JsonObject>(`/api/enrollments/${encodeURIComponent(id)}`, { signal: timeoutSignal(signal, 8_000) });
    return { enrollment: mapEnrollment(raw) };
  },
  async confirmEnrollment(id: string, verificationPhrase: string) {
    const raw = await request<JsonObject>(`/api/enrollments/${encodeURIComponent(id)}/confirm`, {
      method: "POST",
      body: JSON.stringify({ verificationPhrase }),
      signal: timeoutSignal(undefined, 10_000),
    });
    return { enrollment: mapEnrollment(raw) };
  },
  cancelEnrollment(id: string) {
    return request<JsonObject>(`/api/enrollments/${encodeURIComponent(id)}`, {
      method: "DELETE",
      signal: timeoutSignal(undefined, 8_000),
    });
  },
  async clientSessions() {
    const raw = await request<JsonObject>("/api/client-sessions");
    const sessions: ClientSessionInfo[] = list(raw.clientSessions).map((value) => {
      const item = record(value);
      return {
        id: string(item.clientSessionId),
        createdAt: string(item.createdAt),
        lastSeenAt: string(item.lastSeenAt),
        userAgent: string(item.userAgentHash) ? t("客户端 {0}", string(item.userAgentHash).slice(0, 10)) : t("浏览器会话"),
        ipHint: string(item.ipHash) ? `IP ${string(item.ipHash).slice(0, 10)}…` : t("IP 未记录"),
        current: boolean(item.current),
      };
    });
    return { sessions };
  },
  revokeClientSession(id: string) {
    return request<JsonObject>(`/api/client-sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
};

export interface VolatileUpdate {
  logicalSessionId: string;
  eventType: "agent_message.delta" | "command_output.delta" | "turn_diff.delta";
  nativeTurnId: string;
  nativeItemId?: string;
  payload: Record<string, unknown>;
}

export function subscribeToFleet(
  sessions: FleetSession[] | (() => FleetSession[]),
  onChange: () => void,
  onConnection: (connected: boolean) => void,
  onVolatile?: (update: VolatileUpdate) => void,
): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let retry = 500;
  let reconnectTimer: number | undefined;
  let pingTimer: number | undefined;
  let subscriptionTimer: number | undefined;
  const subscribed = new Set<string>();
  function syncSubscriptions() {
    if (socket?.readyState !== WebSocket.OPEN) return;
    for (const session of typeof sessions === "function" ? sessions() : sessions) {
      if (subscribed.has(session.id)) continue;
      socket.send(JSON.stringify({ type: "subscribe", logicalSessionId: session.id, lastAppliedSeq: session.sessionSeq, projectionEpoch: session.projectionEpoch }));
      subscribed.add(session.id);
    }
  }

  const connect = () => {
    if (stopped) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}/ws/client`);
    socket.addEventListener("open", () => {
      retry = 500;
      onConnection(true);
      subscribed.clear();
      syncSubscriptions();
      onChange();
      subscriptionTimer = window.setInterval(syncSubscriptions, 1_000);
      pingTimer = window.setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
      }, 25_000);
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = record(JSON.parse(String(event.data)));
        if (message.type === "volatile") {
          const eventType = string(message.eventType);
          const logicalSessionId = string(message.logicalSessionId);
          const nativeTurnId = string(message.nativeTurnId);
          if (
            logicalSessionId
            && nativeTurnId
            && ["agent_message.delta", "command_output.delta", "turn_diff.delta"].includes(eventType)
          ) {
            onVolatile?.({
              logicalSessionId,
              eventType: eventType as VolatileUpdate["eventType"],
              nativeTurnId,
              ...(typeof message.nativeItemId === "string" ? { nativeItemId: message.nativeItemId } : {}),
              payload: record(message.payload),
            });
          }
        } else if (["snapshot", "event", "lease.changed", "queue.changed", "machine.changed", "command.changed", "approval.changed", "content.deleted"].includes(string(message.type))) {
          onChange();
        }
      } catch {
        // Unknown frames never mutate UI state.
      }
    });
    socket.addEventListener("close", () => {
      onConnection(false);
      if (pingTimer) window.clearInterval(pingTimer);
      if (subscriptionTimer) window.clearInterval(subscriptionTimer);
      if (!stopped) {
        reconnectTimer = window.setTimeout(connect, retry);
        retry = Math.min(retry * 2, 15_000);
      }
    });
    socket.addEventListener("error", () => socket?.close());
  };

  connect();
  return () => {
    stopped = true;
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    if (pingTimer) window.clearInterval(pingTimer);
    if (subscriptionTimer) window.clearInterval(subscriptionTimer);
    socket?.close();
  };
}
