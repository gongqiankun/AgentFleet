import { quotaSnapshot, tokenUsage } from "./usage.js";
import { previewNativeDeletion, type DeletionPreview } from "./native-deletion.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseImages, validImageUrl, MAX_IMAGES } from "./images.js";
import { createInterface } from "node:readline";
import { AgentError, errorMessage } from "./errors.js";
import {
  AGENT_VERSION,
  DEFAULT_APPROVAL_TTL_MS,
  MAX_CONTENT_BYTES,
  MAX_DELTA_BYTES,
  POLICY_VERSION,
} from "./constants.js";
import type { ApprovalRecord, ManagedThread, ProjectRecord } from "./types.js";
import { inputAnswers, inputQuestions, type InputAnswers } from "./user-input.js";
import { inspectCodex, type CodexInspection } from "./codex-inspection.js";
import { resolveCodexExecutable } from "./service.js";
import { verifySessionCwd } from "./projects.js";
import { requestedPermissions, threadPermissionParams, turnPermissionPolicy, type PermissionProfile } from "./permissions.js";
import { parseModels, readObservedSettings, turnSettingsParams, validateSettings, type CodexCatalog, type CodexSettings, type CodexObservedSettings } from "./codex-settings.js";
import {
  canonicalJson,
  identifier,
  isPathInside,
  isRecord,
  nowIso,
  redact,
  requireString,
  sha256,
  truncateUtf8,
} from "./util.js";

const APP_SERVER_METHODS = new Set([
  "initialize",
  "model/list",
  "collaborationMode/list",
  "thread/list",
  "thread/read",
  "thread/turns/list",
  "thread/items/list",
  "thread/resume",
  "thread/unsubscribe",
  "thread/loaded/list",
  "thread/start",
  "thread/name/set",
  "thread/archive",
  "thread/delete",
  "thread/unarchive",
  "thread/fork",
  "turn/start",
  "thread/compact/start",
  "review/start",
  "account/read", "account/rateLimits/read", "config/read", "skills/list", "hooks/list", "mcpServerStatus/list", "app/list", "plugin/list",
  "permissionProfile/list", "experimentalFeature/list", "thread/goal/get", "thread/backgroundTerminals/list", "thread/backgroundTerminals/clean",
  "turn/steer",
  "turn/interrupt",
]);
const APPROVAL_METHODS = new Set([
  "item/permissions/requestApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "execCommandApproval",
  "applyPatchApproval",
  "item/tool/requestUserInput",
]);

type JsonId = string | number;

interface PendingRpc {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface AppEvent {
  type: string;
  payload: Record<string, unknown>;
  nativeThreadId?: string;
  nativeTurnId?: string;
  nativeItemId?: string;
}

export interface VolatileAppEvent {
  type: "agent_message.delta" | "command_output.delta" | "turn_diff.delta";
  payload: Record<string, unknown>;
  nativeThreadId: string;
  nativeTurnId: string;
  nativeItemId?: string;
}

export interface AppServerCallbacks {
  findManagedThread(threadId: string): ManagedThread | undefined;
  findProject(projectId: string): ProjectRecord | undefined;
  onEvent(event: AppEvent, appServerEpoch: string): Promise<void>;
  onVolatile(event: VolatileAppEvent, appServerEpoch: string): void;
  onApproval(approval: ApprovalRecord): Promise<void>;
  onApprovalResolved(nativeRequestId: JsonId, appServerEpoch: string): Promise<void>;
  onExit(appServerEpoch: string, detail: string): Promise<void>;
  onThreadExit?(threadId: string, appServerEpoch: string, detail: string): Promise<void>;
  onCatalogChanged?(appServerEpoch: string): void;
  onQuotaChanged?(): void;
}

export interface ThreadStartResult {
  historyMode?: "legacy" | "paginated";
  observedSettings?: CodexObservedSettings | undefined;
  nativeThreadId: string;
  policyVerified: boolean;
  policyFailure?: string;
  rawSummary: Record<string, unknown>;
}

export interface TurnStartResult {
  nativeTurnId: string;
  status: string;
}

export interface DiscoveredThreadSummary {
  rolloutPath?: string;
  archived?: boolean;
  nativeThreadId: string;
  cwd: string;
  title: string;
  titleSource?: "name" | "preview";
  executionState: "idle" | "running" | "failed" | "unknown";
  historyMode?: "legacy" | "paginated";
}

export interface ThreadListPage {
  threads: DiscoveredThreadSummary[];
  nextCursor: string | null;
}

export interface ThreadHistoryItem {
  nativeTurnId: string;
  nativeItemId: string;
  item: Record<string, unknown> | null;
}

export interface ThreadHistoryPage { items: ThreadHistoryItem[]; nextCursor: string | null; }

export interface ThreadHistorySnapshot {
  rolloutPath?: string;
  paged?: boolean;
  nativeThreadId: string;
  cwd: string;
  historyMode: "legacy" | "paginated";
  executionState: "idle" | "running" | "failed" | "unknown";
  updatedAt: number | null;
  items: ThreadHistoryItem[];
}

export interface ThreadResumeResult extends ThreadStartResult {
  history: ThreadHistorySnapshot;
}

/** The small, allow-listed App Server surface used by the runtime. */
export interface AppServerClient {
  refreshQuota?(): Promise<void>;
  getQuotaSnapshot?(): Record<string, unknown> | undefined;
  previewDeletion?(thread:ManagedThread,project:ProjectRecord):Promise<DeletionPreview>;
  deleteThread?(thread:ManagedThread,project:ProjectRecord,preview:DeletionPreview):Promise<void>;
  getCodexCatalog?(): CodexCatalog;
  inspectEnvironment?(cwd: string, threadId?: string): Promise<CodexInspection>;
  threadAction?(thread: ManagedThread, project: ProjectRecord, action: "rename" | "archive" | "unarchive" | "fork", name?: string, expectedTitle?: string): Promise<Record<string, unknown>>;
  startNativeTurn?(thread: ManagedThread, action: "compact" | "review", target?: Record<string, unknown>): Promise<TurnStartResult>;
  readonly appServerEpoch: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  createThread(project: ProjectRecord, profile?: PermissionProfile, name?: string): Promise<ThreadStartResult>;
  listThreads(): Promise<DiscoveredThreadSummary[]>;
  listThreadPage?(cursor: string | null, options?: { useStateDbOnly: boolean }): Promise<ThreadListPage>;
  readThread(threadId: string, metadataOnly?: boolean): Promise<ThreadHistorySnapshot>;
  readHistoryPage?(threadId: string, cursor: string | null): Promise<ThreadHistoryPage>;
  readTurnOutcome?(threadId: string, turnId: string): Promise<{ cwd: string; status: string } | null>;
  resumeThread(threadId: string, project: ProjectRecord, sessionCwd?: string, profile?: PermissionProfile): Promise<ThreadResumeResult>;
  unsubscribeThread(threadId: string): Promise<void>;
  releaseWriter?(): Promise<void>;
  startTurn(
    thread: ManagedThread,
    project: ProjectRecord,
    prompt: string,
    clientUserMessageId?: string,
    settings?: CodexSettings,
    images?: string[],
  ): Promise<TurnStartResult>;
  steerTurn(
    thread: ManagedThread,
    turnId: string,
    prompt: string,
    clientUserMessageId?: string,
    images?: string[],
  ): Promise<TurnStartResult>;
  interruptTurn(threadId: string, turnId: string): Promise<Record<string, unknown>>;
  stopBackgroundTerminals?(thread: ManagedThread, project: ProjectRecord): Promise<void>;
  respondApproval(approval: ApprovalRecord, decision: "accept" | "decline" | "cancel"): Promise<void>;
  respondInput?(request: ApprovalRecord, answers: InputAnswers): Promise<void>;
}

function readId(value: unknown, name: string): JsonId {
  if (typeof value !== "string" && typeof value !== "number") throw new AgentError("APP_SERVER_PROTOCOL", `${name} is invalid`);
  return value;
}

function threadIdFromParams(params: Record<string, unknown>): string | undefined {
  return typeof params.threadId === "string"
    ? params.threadId
    : typeof params.conversationId === "string"
      ? params.conversationId
      : undefined;
}

function turnIdFromParams(params: Record<string, unknown>): string | undefined {
  return typeof params.turnId === "string" ? params.turnId : undefined;
}

function itemIdFromParams(params: Record<string, unknown>): string | undefined {
  return typeof params.itemId === "string"
    ? params.itemId
    : typeof params.callId === "string"
      ? params.callId
      : undefined;
}

function safeText(value: unknown, maxBytes = MAX_CONTENT_BYTES): { text: string; truncated: boolean } | undefined {
  if (typeof value !== "string") return undefined;
  const limited = truncateUtf8(redact(value), maxBytes);
  return { text: limited.value, truncated: limited.truncated };
}

export function sanitizeThreadItem(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.type !== "string" || typeof value.id !== "string") return null;
  switch (value.type) {
    case "userMessage": {
      if (!Array.isArray(value.content)) return null;
      let images = 0;
      const content: Record<string, unknown>[] = value.content.flatMap((entry): Record<string, unknown>[] => {
        if (!isRecord(entry)) return [];
        if (entry.type === "image" || entry.type === "localImage") {
          if (images++ < MAX_IMAGES && validImageUrl(entry.url)) return [{ type: "image", url: entry.url }];
          return [{ type: "text", text: "[图片未同步：原图不可用或超出同步大小限制]" }];
        }
        if (entry.type !== "text") return [];
        const text = safeText(entry.text);
        return text ? [{ type: "text", ...text }] : [];
      });
      return { type: value.type, id: value.id, content };
    }
    case "agentMessage": {
      const text = safeText(value.text);
      return text ? { type: value.type, id: value.id, ...text, phase: value.phase ?? null } : null;
    }
    case "plan": {
      const text = safeText(value.text);
      return text ? { type: value.type, id: value.id, ...text } : null;
    }
    case "reasoning": {
      const summaries = Array.isArray(value.summary)
        ? value.summary.flatMap((entry) => {
            const text = safeText(entry, 32_000);
            return text ? [text.text] : [];
          })
        : [];
      return { type: value.type, id: value.id, summary: summaries };
    }
    case "commandExecution": {
      const command = safeText(value.command, 32_000);
      const output = safeText(value.aggregatedOutput);
      if (!command || typeof value.cwd !== "string") return null;
      return {
        type: value.type,
        id: value.id,
        command: command.text,
        commandTruncated: command.truncated,
        cwd: value.cwd,
        status: value.status,
        exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
        ...(output ? { aggregatedOutput: output.text, outputTruncated: output.truncated } : {}),
      };
    }
    case "fileChange": {
      if (!Array.isArray(value.changes)) return null;
      const changes = value.changes.slice(0, 1_000).flatMap((change) => {
        if (!isRecord(change) || typeof change.path !== "string") return [];
        const diff = safeText(change.diff);
        return [{ path: change.path, kind: change.kind, ...(diff ? { diff: diff.text, truncated: diff.truncated } : {}) }];
      });
      return { type: value.type, id: value.id, status: value.status, changes };
    }
    default:
      return null;
  }
}

function summarizeTurn(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    status: typeof value.status === "string" ? value.status : "unknown",
    startedAt: typeof value.startedAt === "number" ? value.startedAt : null,
    completedAt: typeof value.completedAt === "number" ? value.completedAt : null,
    ...(isRecord(value.error)
      ? { error: { message: safeText(value.error.message, 32_000)?.text ?? "Codex turn failed" } }
      : {}),
  };
}

export function verifyEffectiveThreadPolicy(result: unknown, projectRoot: string, sessionCwd = projectRoot, profile: PermissionProfile = "project"): { ok: boolean; reason?: string } {
  if (!isRecord(result)) return { ok: false, reason: "thread/start response is not an object" };
  if (result.cwd !== sessionCwd || !isPathInside(projectRoot, sessionCwd)) return { ok: false, reason: "effective cwd differs from the registered session directory" };
  if (result.approvalPolicy !== (profile === "full" ? "never" : "on-request")) return { ok: false, reason: "effective approval policy does not match the selected profile" };
  if (profile === "full") return isRecord(result.sandbox) && result.sandbox.type === "dangerFullAccess" ? { ok: true } : { ok: false, reason: "effective sandbox is not full access" };
  if (!isRecord(result.sandbox) || result.sandbox.type !== "workspaceWrite") {
    return { ok: false, reason: "effective sandbox is not workspace-write" };
  }
  if (result.sandbox.networkAccess !== (profile === "network")) return { ok: false, reason: "sandbox network access does not match the selected profile" };
  if (result.sandbox.excludeTmpdirEnvVar !== true || result.sandbox.excludeSlashTmp !== true) {
    return { ok: false, reason: "ambient temporary-directory writable roots are not disabled" };
  }
  if (!Array.isArray(result.sandbox.writableRoots)) return { ok: false, reason: "sandbox writableRoots are not observable" };
  for (const writableRoot of result.sandbox.writableRoots) {
    if (typeof writableRoot !== "string" || !isPathInside(projectRoot, writableRoot)) {
      return { ok: false, reason: "sandbox exposes a writable root outside the authorized project" };
    }
  }
  return { ok: true };
}

function resultObject(value: unknown, operation: string): Record<string, unknown> {
  if (!isRecord(value)) throw new AgentError("APP_SERVER_PROTOCOL", `${operation} returned an invalid result`);
  return value;
}

function historySnapshot(value: unknown, operation: string): ThreadHistorySnapshot {
  const thread = resultObject(value, `${operation} thread`);
  const nativeThreadId = requireString(thread.id, "thread.id", { maxLength: 256 });
  const cwd = requireString(thread.cwd, "thread.cwd", { maxLength: 8_192 });
  const historyMode = thread.historyMode === "paginated" ? "paginated" : "legacy";
  const status = isRecord(thread.status) && typeof thread.status.type === "string" ? thread.status.type : "unknown";
  const executionState = status === "active"
    ? "running"
    : status === "idle" || status === "notLoaded"
      ? "idle"
      : status === "systemError"
        ? "failed"
        : "unknown";
  const items: ThreadHistoryItem[] = [];
  for (const turnValue of Array.isArray(thread.turns) ? thread.turns : []) {
    if (!isRecord(turnValue) || typeof turnValue.id !== "string" || !Array.isArray(turnValue.items)) continue;
    for (const itemValue of turnValue.items) {
      if (!isRecord(itemValue) || typeof itemValue.id !== "string") continue;
      items.push({
        nativeTurnId: turnValue.id,
        nativeItemId: itemValue.id,
        item: sanitizeThreadItem(itemValue),
      });
    }
  }
  return {
    nativeThreadId,
    ...(typeof thread.path === "string" ? { rolloutPath: thread.path } : {}),
    cwd,
    historyMode,
    executionState,
    updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : null,
    items,
  };
}

export function appServerLaunchArgs(): string[] {
  // Codex Desktop shares this home and stores additional UI/computer-use keys.
  // Use native tolerant parsing; remote permissions remain explicit here and
  // are verified against the effective policy of every managed thread.
  return ["app-server", "--stdio",
    "-c", 'approval_policy="on-request"',
    "-c", 'sandbox_mode="workspace-write"',
    "-c", "sandbox_workspace_write.network_access=false",
    "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
    "-c", "sandbox_workspace_write.exclude_slash_tmp=true"];
}

export class CodexAppServer implements AppServerClient {
  readonly appServerEpoch: string;
  private readonly callbacks: AppServerCallbacks;
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextRequestId = 1;
  private initialized = false;
  private codexCatalog: CodexCatalog = { models: [], modes: [], fetchedAt: nowIso(), error: "尚未读取模型列表" };
  getCodexCatalog(): CodexCatalog { return { ...structuredClone(this.codexCatalog), imageInput: true }; }
  private stopping = false;
  private pending = new Map<JsonId, PendingRpc>();
  private approvalTimers = new Map<string, NodeJS.Timeout>();
  private inputRegistrations = new Map<JsonId, Promise<void>>();
  private requestApprovals = new Map<JsonId, string>();
  private finalDiffs = new Map<string, string>();
  private compactStarts = new Map<string, { resolve: (turn: TurnStartResult) => void; reject: (error: Error) => void }>();
  private exitHandled = false;

  constructor(callbacks: AppServerCallbacks, epoch: string = randomUUID(), private readonly environment: NodeJS.ProcessEnv = process.env) {
    this.callbacks = callbacks;
    this.appServerEpoch = epoch;
  }

  private quota: Record<string, unknown> | undefined;
  private quotaPending = false;
  private quotaGeneration = 0;
  getQuotaSnapshot(): Record<string, unknown> | undefined { return this.quota; }
  async refreshQuota(): Promise<void> {
    if (!this.initialized || this.quotaPending) return;
    this.quotaPending = true;
    const generation = this.quotaGeneration;
    try {
      const identity = await this.request("account/read", { refreshToken: false });
      const value = await this.request("account/rateLimits/read", null);
      if (generation === this.quotaGeneration) this.quota = quotaSnapshot(value, identity);
    } catch { /* Optional telemetry must never interrupt execution. Keep the old timestamp visible. */ }
    finally { this.quotaPending = false; }
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.stopping = false;
    const codexExecutable = await resolveCodexExecutable(undefined, this.environment);
    const child = spawn(
      codexExecutable,
      appServerLaunchArgs(),
      { stdio: ["pipe", "pipe", "pipe"], shell: false, env: this.environment },
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => void this.handleLine(line));
    // stderr can contain user or tool content. Drain it, but never relay or persist it.
    child.stderr.on("data", () => undefined);
    child.once("error", (error) => this.handleExit(`spawn failed: ${error.message}`));
    child.once("exit", (code, signal) => this.handleExit(`exited (${code ?? "null"}, ${signal ?? "no-signal"})`));
    const initialized = resultObject(
      await this.request("initialize", {
        clientInfo: { name: "agentfleet-local", title: "AgentFleet Local Agent", version: AGENT_VERSION },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: [
            "item/reasoning/textDelta",
            "rawResponseItem/completed",
            "rawResponse/completed",
          ],
        },
      }),
      "initialize",
    );
    const expectedPlatform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
    if (initialized.platformOs !== expectedPlatform) {
      throw new AgentError(
        "APP_SERVER_INCOMPATIBLE",
        `app-server platform ${String(initialized.platformOs)} does not match host ${expectedPlatform}`,
      );
    }
    await this.writeLine({ method: "initialized" });
    this.initialized = true;
    await this.refreshCodexCatalog();
  }

  private async refreshCodexCatalog(): Promise<void> {
    try {
      const models = new Map<string, CodexCatalog["models"][number]>();
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const raw = resultObject(await this.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }), "model/list");
        for (const model of parseModels(raw)) models.set(model.model, model);
        cursor = typeof raw.nextCursor === "string" && raw.nextCursor ? raw.nextCursor : null;
        if (cursor && (seen.has(cursor) || seen.size >= 5 || models.size > 500)) throw new AgentError("CODEX_CATALOG_INVALID", "Model pagination exceeded its safety bound");
        if (cursor) seen.add(cursor);
      } while (cursor);
      let modes: string[] = [];
      try {
        const raw = resultObject(await this.request("collaborationMode/list", {}), "collaborationMode/list");
        if (Array.isArray(raw.data)) modes = [...new Set(raw.data.filter(isRecord).map((item) => item.mode).filter((mode): mode is string => mode === "default" || mode === "plan"))];
      } catch { /* Experimental mode support is independently optional. */ }
      this.codexCatalog = { models: [...models.values()], modes, fetchedAt: nowIso() };
    } catch (error) {
      this.codexCatalog = { models: [], modes: [], fetchedAt: nowIso(), error: errorMessage(error).slice(0, 500) };
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.approvalTimers.values()) clearTimeout(timer);
    this.approvalTimers.clear();
    this.requestApprovals.clear();
    if (!this.child) return;
    const child = this.child;
    this.child = undefined;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async createThread(project: ProjectRecord, profile: PermissionProfile = "project", name?: string): Promise<ThreadStartResult> {
    this.assertInitialized();
    const raw = resultObject(
      await this.request("thread/start", {
        cwd: project.root,
        ...threadPermissionParams(project.root, profile),
        serviceName: "agentfleet",
        ephemeral: false,
        threadSource: "agentfleet",
      }),
      "thread/start",
    );
    const thread = resultObject(raw.thread, "thread/start thread");
    const nativeThreadId = requireString(thread.id, "thread.id", { maxLength: 256 });
    const verified = verifyEffectiveThreadPolicy(raw, project.root, project.root, profile);
    // A brand-new thread may not have a rollout until its first turn. Name it
    // on this exact loaded connection; do not read/resume/release it here.
    if (verified.ok && name) await this.request("thread/name/set", { threadId: nativeThreadId, name: requireString(name, "sessionTitle", { maxLength: 200 }) });
    return {
      nativeThreadId,
      historyMode: thread.historyMode === "paginated" ? "paginated" : "legacy",
      observedSettings: readObservedSettings(raw),
      policyVerified: verified.ok,
      ...(verified.reason === undefined ? {} : { policyFailure: verified.reason }),
      rawSummary: {
        cwd: raw.cwd,
        approvalPolicy: raw.approvalPolicy,
        sandbox: raw.sandbox,
      },
    };
  }

  async listThreads(): Promise<DiscoveredThreadSummary[]> {
    const discovered: DiscoveredThreadSummary[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    while (true) {
      const page = await this.listThreadPage(cursor);
      discovered.push(...page.threads);
      cursor = page.nextCursor;
      if (!cursor) return discovered;
      if (seen.has(cursor)) throw new AgentError("THREAD_DISCOVERY_CURSOR", "thread listing repeated a pagination cursor");
      seen.add(cursor);
    }
  }

  previewDeletion(thread:ManagedThread,project:ProjectRecord):Promise<DeletionPreview> {
    return previewNativeDeletion((method,params)=>this.request(method,params),thread,project);
  }

  async deleteThread(thread:ManagedThread,project:ProjectRecord,preview:DeletionPreview):Promise<void> {
    if (preview.nativeThreadId!==thread.nativeThreadId || !Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt)<=Date.now()) throw new AgentError("DELETE_PREVIEW_EXPIRED","删除预览已过期，请重新预览");
    const current=await this.previewDeletion(thread,project);
    if(current.fingerprint!==preview.fingerprint)throw new AgentError("DELETE_PREVIEW_CHANGED","会话或后代已改变，请重新预览确认");
    // Acquire each native writer before deletion. External CLI ownership is never stolen.
    for(const entry of current.threads.sort((a,b)=>a.id===thread.nativeThreadId?-1:b.id===thread.nativeThreadId?1:a.id.localeCompare(b.id))) {
      // Archived threads cannot be resumed. Keep their archive state intact;
      // native delete acquires the subtree's writer locks before removing files.
      if (entry.archived) continue;
      const resumed=await this.resumeThread(entry.id,project,entry.cwd,thread.permissionProfile);
      if(!resumed.policyVerified)throw new AgentError("POLICY_NOT_PROVEN","无法确认删除目标的原生权限");
      const terminals=await this.request("thread/backgroundTerminals/list",{threadId:entry.id,limit:1});
      if(!isRecord(terminals)||!Array.isArray(terminals.data)||terminals.data.length||terminals.nextCursor)throw new AgentError("THREAD_BUSY","请先结束会话及后代的后台终端，再删除");
    }
    const locked=await this.previewDeletion(thread,project);
    if(canonicalJson(locked.threads.map(({updatedAt,...t})=>t).sort((a,b)=>a.id.localeCompare(b.id)))!==canonicalJson(preview.threads.map(({updatedAt,...t})=>t).sort((a,b)=>a.id.localeCompare(b.id))))throw new AgentError("DELETE_PREVIEW_CHANGED","删除范围在确认期间改变，请重新预览");
    await this.request("thread/delete",{threadId:thread.nativeThreadId});
  }

  async threadAction(thread: ManagedThread, project: ProjectRecord, action: "rename" | "archive" | "unarchive" | "fork", name?: string, expectedTitle?: string): Promise<Record<string, unknown>> {
    this.assertInitialized();
    const metadata = resultObject(await this.request("thread/read", { threadId: thread.nativeThreadId, includeTurns: false }), "thread/read");
    const before = historySnapshot(metadata.thread, "thread/read");
    if (before.nativeThreadId !== thread.nativeThreadId) throw new AgentError("THREAD_ID_MISMATCH", "Native thread identity changed");
    const cwd = await verifySessionCwd(project, thread.sessionCwd ?? project.root);
    if (before.cwd !== cwd) throw new AgentError("THREAD_PROJECT_MISMATCH", "Native thread moved outside the registered session directory");
    if (before.executionState !== "idle") throw new AgentError("THREAD_BUSY", "Native thread must be idle");
    const threadId = thread.nativeThreadId;
    if (action === "rename") {
      const nativeName = safeText(resultObject(metadata.thread, "thread").name, 200)?.text?.trim();
      if (expectedTitle !== undefined && nativeName && nativeName !== expectedTitle) throw new AgentError("THREAD_NAME_CONFLICT", "宿主机标题已经改变，请刷新会话后重试；本次没有覆盖新标题");
      await this.request("thread/name/set", { threadId, name });
      return { title: name };
    }
    if (action === "archive" || action === "unarchive") {
      await this.request(action === "archive" ? "thread/archive" : "thread/unarchive", { threadId });
      return { archived: action === "archive" };
    }
    const raw = resultObject(await this.request("thread/fork", { threadId, cwd, excludeTurns: true, approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: "workspace-write",
      config: { approval_policy: "on-request", sandbox_mode: "workspace-write", sandbox_workspace_write: { network_access: false, writable_roots: [project.root], exclude_tmpdir_env_var: true, exclude_slash_tmp: true } } }), "thread/fork");
    const fork = resultObject(raw.thread, "thread/fork thread");
    const nativeThreadId = requireString(fork.id, "fork.id", { maxLength: 256 });
    if (nativeThreadId === threadId || fork.cwd !== cwd) throw new AgentError("APP_SERVER_PROTOCOL", "Fork identity or project does not match");
    await this.unsubscribeThread(nativeThreadId);
    return { forkedNativeThreadId: nativeThreadId, sourceNativeThreadId: threadId };
  }

  async startNativeTurn(thread: ManagedThread, action: "compact" | "review", target?: Record<string, unknown>): Promise<TurnStartResult> {
    this.assertInitialized();
    if (action === "review") {
      const raw = resultObject(await this.request("review/start", { threadId: thread.nativeThreadId, target, delivery: "inline" }), "review/start");
      const turn = resultObject(raw.turn, "review/start turn");
      return { nativeTurnId: requireString(turn.id, "turn.id", { maxLength: 256 }), status: typeof turn.status === "string" ? turn.status : "inProgress" };
    }
    const threadId = thread.nativeThreadId;
    if (this.compactStarts.has(threadId)) throw new AgentError("THREAD_BUSY", "Compaction already starting");
    const started = new Promise<TurnStartResult>((resolve, reject) => this.compactStarts.set(threadId, { resolve, reject }));
    // Attach a rejection observer before the RPC await: exits can reject both promises.
    void started.catch(() => undefined);
    const timer = setTimeout(() => this.compactStarts.get(threadId)?.reject(new AgentError("APP_SERVER_TIMEOUT", "Compaction was accepted but its turn was not observed; do not retry blindly")), 60_000);
    try { await this.request("thread/compact/start", { threadId }); return await started; }
    finally { clearTimeout(timer); this.compactStarts.delete(threadId); }
  }

  async inspectEnvironment(cwd: string, threadId?: string): Promise<CodexInspection> {
    this.assertInitialized();
    return inspectCodex((method, params) => this.request(method, params), cwd, threadId);
  }

  async stopBackgroundTerminals(thread: ManagedThread, project: ProjectRecord): Promise<void> {
    this.assertInitialized();
    if (thread.appServerEpoch !== this.appServerEpoch || !thread.policyVerified) throw new AgentError("THREAD_READ_ONLY", "Background terminals belong to another runtime");
    const raw = resultObject(await this.request("thread/read", { threadId: thread.nativeThreadId, includeTurns: false }), "thread/read");
    const metadata = resultObject(raw.thread, "thread");
    const cwd = await verifySessionCwd(project, thread.sessionCwd ?? project.root);
    if (metadata.id !== thread.nativeThreadId || metadata.cwd !== cwd) throw new AgentError("THREAD_PROJECT_MISMATCH", "Native terminal target changed");
    await this.request("thread/backgroundTerminals/clean", { threadId: thread.nativeThreadId });
  }

  async listThreadPage(cursor: string | null, options?: { useStateDbOnly: boolean }): Promise<ThreadListPage> {
    this.assertInitialized();
    const discovered: DiscoveredThreadSummary[] = [];
    // The catalog has two independently paginated collections. Keep their
    // native cursors scoped so a completed active scan also visits archives.
    const page = cursor === null ? { archived: false, cursor: null } : JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { archived: boolean; cursor: string | null };
    if (typeof page.archived !== "boolean" || (page.cursor !== null && typeof page.cursor !== "string")) throw new AgentError("THREAD_DISCOVERY_CURSOR", "Invalid catalog cursor");
    const raw = resultObject(
        await this.request("thread/list", {
          archived: page.archived,
          cursor: page.cursor,
          limit: 100,
          sortKey: "updated_at",
          sortDirection: "desc",
          useStateDbOnly: options?.useStateDbOnly ?? false,
        }),
        "thread/list",
      );
      if (!Array.isArray(raw.data)) throw new AgentError("APP_SERVER_PROTOCOL", "thread/list data is not an array");
      for (const value of raw.data) {
        if (!isRecord(value) || typeof value.cwd !== "string" || typeof value.id !== "string") continue;
        const status = isRecord(value.status) && typeof value.status.type === "string" ? value.status.type : "unknown";
        const executionState = status === "active"
          ? "running"
          : status === "idle" || status === "notLoaded"
            ? "idle"
            : status === "systemError"
              ? "failed"
              : "unknown";
        const explicitName = safeText(value.name, 200)?.text?.trim();
        const safeName = explicitName || safeText(value.preview, 200)?.text;
        const historyMode = value.historyMode === "legacy" || value.historyMode === "paginated" ? value.historyMode : undefined;
        discovered.push({
          nativeThreadId: value.id,
          ...(typeof value.path === "string" ? { rolloutPath: value.path } : {}),
          archived: page.archived,
          cwd: value.cwd,
          title: safeName || `Existing Codex thread ${value.id.slice(0, 8)}`,
          titleSource: explicitName ? "name" : "preview",
          executionState,
          ...(historyMode === undefined ? {} : { historyMode }),
        });
      }
    const next = typeof raw.nextCursor === "string" ? { archived: page.archived, cursor: raw.nextCursor }
      : !page.archived ? { archived: true, cursor: null } : null;
    return { threads: discovered, nextCursor: next ? Buffer.from(JSON.stringify(next)).toString("base64url") : null };
  }

  /** Bounded read-only evidence for a turn owned by a previous runtime. */
  async readTurnOutcome(threadId: string, turnId: string): Promise<{ cwd: string; status: string } | null> {
    this.assertInitialized();
    const metadata = resultObject(resultObject(await this.request("thread/read", { threadId, includeTurns: false }), "thread/read").thread, "thread");
    if (metadata.id !== threadId) throw new AgentError("THREAD_ID_MISMATCH", "Recovery thread identity changed");
    const cwd = requireString(metadata.cwd, "thread.cwd", { maxLength: 8192 });
    if (metadata.historyMode !== "paginated") {
      const thread = resultObject(resultObject(await this.request("thread/read", { threadId, includeTurns: true }), "thread/read").thread, "thread");
      if (thread.id !== threadId || thread.cwd !== cwd || !Array.isArray(thread.turns)) return null;
      const turn = thread.turns.find(t => isRecord(t) && t.id === turnId);
      return isRecord(turn) && typeof turn.status === "string" ? { cwd, status: turn.status } : null;
    }
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 5; page++) {
      const result = resultObject(await this.request("thread/turns/list", { threadId, cursor, limit: 100, sortDirection: "desc", itemsView: "notLoaded" }), "thread/turns/list");
      if (!Array.isArray(result.data) || result.data.length > 100) throw new AgentError("TURN_PAGE_INVALID", "Invalid native turn page");
      const turn = result.data.find(t => isRecord(t) && t.id === turnId);
      if (isRecord(turn) && typeof turn.status === "string") return { cwd, status: turn.status };
      if (result.nextCursor == null) return null;
      if (typeof result.nextCursor !== "string" || !result.nextCursor || result.nextCursor.length > 8192 || seen.has(result.nextCursor)) throw new AgentError("TURN_PAGE_INVALID", "Invalid native turn cursor");
      cursor = result.nextCursor; seen.add(cursor);
    }
    return null;
  }

  async readThread(threadId: string, metadataOnly = false): Promise<ThreadHistorySnapshot> {
    this.assertInitialized();
    const raw = resultObject(
      await this.request("thread/read", { threadId, includeTurns: !metadataOnly }),
      "thread/read",
    );
    const snapshot = historySnapshot(raw.thread, "thread/read");
    if (snapshot.nativeThreadId !== threadId) {
      throw new AgentError("THREAD_ID_MISMATCH", "thread/read returned a different thread id");
    }
    if (metadataOnly && snapshot.historyMode === "legacy") return this.readThread(threadId,false);
    return {...snapshot, ...(metadataOnly ? {paged:true} : {})};
  }

  async readHistoryPage(threadId: string, cursor: string | null): Promise<ThreadHistoryPage> {
    this.assertInitialized();
    const raw = resultObject(await this.request("thread/items/list", {threadId,cursor,limit:100,sortDirection:"asc"}),"thread/items/list");
    if (!Array.isArray(raw.data) || raw.data.length > 100 || (raw.nextCursor != null && (typeof raw.nextCursor !== "string" || !raw.nextCursor || raw.nextCursor.length > 8192))) throw new AgentError("HISTORY_PAGE_INVALID","Invalid native history page");
    const items = raw.data.map(entry => {
      if (!isRecord(entry) || !isRecord(entry.item)) throw new AgentError("HISTORY_PAGE_INVALID","Invalid native history item");
      return {nativeTurnId:requireString(entry.turnId,"turnId",{maxLength:256}),nativeItemId:requireString(entry.item.id,"item.id",{maxLength:256}),item:sanitizeThreadItem(entry.item)};
    });
    if (raw.nextCursor && (raw.nextCursor === cursor || items.length === 0)) throw new AgentError("HISTORY_CURSOR_STALLED","Native history cursor did not advance");
    return {items,nextCursor:typeof raw.nextCursor === "string" ? raw.nextCursor : null};
  }

  async resumeThread(threadId: string, project: ProjectRecord, sessionCwd?: string, profile: PermissionProfile = "project"): Promise<ThreadResumeResult> {
    this.assertInitialized();
    const before = await this.readThread(threadId, true);
    const cwd = await verifySessionCwd(project, sessionCwd ?? before.cwd);
    if (before.cwd !== cwd) {
      throw new AgentError("THREAD_PROJECT_MISMATCH", "thread cwd differs from the registered session directory");
    }
    if (before.executionState !== "idle") {
      throw new AgentError("THREAD_BUSY", "thread is active or its runtime state cannot be proven idle");
    }
    const raw = resultObject(
      await this.request("thread/resume", {
        threadId,
        excludeTurns: true,
        cwd,
        ...threadPermissionParams(project.root, profile),
      }),
      "thread/resume",
    );
    const metadata = historySnapshot(raw.thread, "thread/resume");
    const history = metadata.historyMode === "paginated" ? {...metadata,paged:true} : {...metadata,items:before.items};
    if (history.nativeThreadId !== threadId || history.cwd !== cwd || history.historyMode !== before.historyMode) {
      throw new AgentError("THREAD_RESUME_MISMATCH", "resumed thread identity, cwd, or history mode changed");
    }
    const verified = verifyEffectiveThreadPolicy(raw, project.root, cwd, profile);
    return {
      nativeThreadId: history.nativeThreadId,
      historyMode: history.historyMode,
      observedSettings: readObservedSettings(raw),
      policyVerified: verified.ok,
      ...(verified.reason === undefined ? {} : { policyFailure: verified.reason }),
      rawSummary: {
        cwd: raw.cwd,
        approvalPolicy: raw.approvalPolicy,
        sandbox: raw.sandbox,
      },
      history,
    };
  }

  async unsubscribeThread(threadId: string): Promise<void> {
    this.assertInitialized();
    await this.request("thread/unsubscribe", { threadId });
  }

  /** Only used for a dedicated writer process, never the catalog connection.
   * Unsubscribe is NOT an unload acknowledgement. Prove all loaded work idle,
   * close stdin, and wait for actual process exit before confirming handoff.
   * Do not kill a process on timeout or clean user background terminals here.
   */
  async releaseWriter(): Promise<void> {
    if (this.exitHandled) return;
    if (!this.stopping) await this.verifyWriterIdle();
    const child = this.child;
    if (!child) throw new AgentError("THREAD_RELEASE_PENDING", "Writer exit has not been confirmed");
    this.stopping = true;
    await new Promise<void>((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const exited = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        child.off("exit", exited);
        reject(new AgentError("THREAD_RELEASE_PENDING", "正在等待会话进程退出，尚未确认写入权释放，请稍后重试"));
      }, 10_000);
      child.once("exit", exited);
      if (!child.stdin.writableEnded) child.stdin.end();
    });
  }

  private async verifyWriterIdle(): Promise<void> {
    this.assertInitialized();
    const loaded = resultObject(await this.request("thread/loaded/list", {}), "thread/loaded/list");
    if (!Array.isArray(loaded.data) || loaded.data.some(id => typeof id !== "string") || loaded.nextCursor) {
      throw new AgentError("THREAD_RELEASE_PENDING", "Cannot verify all loaded sessions before releasing the writer");
    }
    for (const threadId of loaded.data as string[]) {
      const raw = resultObject(await this.request("thread/read", { threadId, includeTurns: false }), "thread/read");
      const thread = resultObject(raw.thread, "thread");
      const status = resultObject(thread.status, "thread.status");
      if (thread.id !== threadId || !["idle", "notLoaded"].includes(String(status.type))) {
        throw new AgentError("THREAD_RELEASE_PENDING", "会话或子任务仍在运行，尚未释放写入权");
      }
      const terminals = resultObject(await this.request("thread/backgroundTerminals/list", { threadId, limit: 1 }), "thread/backgroundTerminals/list");
      if (!Array.isArray(terminals.data) || terminals.data.length || terminals.nextCursor) {
        throw new AgentError("THREAD_RELEASE_PENDING", "会话仍有后台终端，停止后台终端后才能交接");
      }
    }
  }

  private imageInputs(prompt: string, value: unknown, modelName?: string): Record<string, unknown>[] {
    const images = parseImages(value);
    const model = this.codexCatalog.models.find(entry => entry.model === modelName);
    if (images.length && model?.inputModalities && !model.inputModalities.includes("image"))
      throw new AgentError("MODEL_IMAGE_UNSUPPORTED", "当前模型不支持图片，请选择支持图片的模型后重试");
    if (!prompt.trim() && !images.length) throw new AgentError("EMPTY_INPUT", "请填写消息或粘贴图片");
    return [...(prompt ? [{ type: "text", text: prompt, text_elements: [] }] : []), ...images.map(url => ({ type: "image", url }))];
  }

  async startTurn(thread: ManagedThread, project: ProjectRecord, prompt: string, clientUserMessageId?: string, settings?: CodexSettings, images?: string[]): Promise<TurnStartResult> {
    this.assertInitialized();
    if (thread.appServerEpoch !== this.appServerEpoch || !thread.policyVerified) {
      throw new AgentError("THREAD_READ_ONLY", "thread policy or app-server ownership cannot be proven");
    }
    const cwd = await verifySessionCwd(project, thread.sessionCwd ?? project.root);
    const result = resultObject(
      await this.request("turn/start", {
        ...turnSettingsParams(validateSettings(settings, this.codexCatalog)),
        threadId: thread.nativeThreadId,
        ...(clientUserMessageId === undefined ? {} : { clientUserMessageId }),
        input: this.imageInputs(prompt, images, settings?.model ?? thread.observedSettings?.model),
        cwd,
        approvalPolicy: thread.permissionProfile === "full" ? "never" : "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: turnPermissionPolicy(project.root, thread.permissionProfile ?? "project"),
      }),
      "turn/start",
    );
    const turn = resultObject(result.turn, "turn/start turn");
    return {
      nativeTurnId: requireString(turn.id, "turn.id", { maxLength: 256 }),
      status: typeof turn.status === "string" ? turn.status : "inProgress",
    };
  }

  async steerTurn(
    thread: ManagedThread,
    turnId: string,
    prompt: string,
    clientUserMessageId?: string,
    images?: string[],
  ): Promise<TurnStartResult> {
    this.assertInitialized();
    if (thread.activeTurnId !== turnId) {
      throw new AgentError("TURN_PRECONDITION_FAILED", "the expected active turn is no longer current");
    }
    const result = resultObject(
      await this.request("turn/steer", {
        threadId: thread.nativeThreadId,
        expectedTurnId: turnId,
        input: this.imageInputs(prompt, images, thread.acceptedSettings?.model ?? thread.observedSettings?.model),
        clientUserMessageId: clientUserMessageId ?? null,
      }),
      "turn/steer",
    );
    const nativeTurnId = requireString(result.turnId, "turn/steer.turnId", { maxLength: 256 });
    if (nativeTurnId !== turnId) {
      throw new AgentError("TURN_RESUME_MISMATCH", "turn/steer returned a different active turn");
    }
    return { nativeTurnId, status: "inProgress" };
  }

  async interruptTurn(threadId: string, turnId: string): Promise<Record<string, unknown>> {
    this.assertInitialized();
    const result = await this.request("turn/interrupt", { threadId, turnId });
    return isRecord(result) ? result : {};
  }

  async respondApproval(approval: ApprovalRecord, decision: "accept" | "decline" | "cancel"): Promise<void> {
    this.assertInitialized();
    if (approval.method === "item/tool/requestUserInput") throw new AgentError("INPUT_RESPONSE_REQUIRED", "A question requires answers, not permission approval");
    if (approval.appServerEpoch !== this.appServerEpoch) {
      throw new AgentError("APPROVAL_EPOCH_STALE", "approval belongs to an exited app-server instance");
    }
    const response = approval.method === "item/permissions/requestApproval" && decision === "accept"
      ? { permissions: requestedPermissions(approval.params.permissions), scope: "turn" }
      : this.approvalResponse(approval.method, decision);
    await this.writeLine({ id: approval.nativeRequestId, result: response });
    const timer = this.approvalTimers.get(approval.approvalId);
    if (timer) clearTimeout(timer);
    this.approvalTimers.delete(approval.approvalId);
  }

  async respondInput(request: ApprovalRecord, answers: InputAnswers): Promise<void> {
    this.assertInitialized();
    if (request.method !== "item/tool/requestUserInput" || request.appServerEpoch !== this.appServerEpoch) {
      throw new AgentError("APPROVAL_EPOCH_STALE", "Input request belongs to another app-server or request kind");
    }
    const validated = inputAnswers(answers, inputQuestions(request.params.questions));
    await this.writeLine({ id: request.nativeRequestId, result: { answers: validated } });
    const timer = this.approvalTimers.get(request.approvalId);
    if (timer) clearTimeout(timer);
    this.approvalTimers.delete(request.approvalId);
  }

  private assertInitialized(): void {
    if (this.stopping) throw new AgentError("THREAD_RELEASE_PENDING", "会话执行连接正在释放，请等待交接完成后重试");
    if (!this.child || !this.initialized) throw new AgentError("APP_SERVER_UNAVAILABLE", "codex app-server is not initialized");
  }

  private async request(method: string, params: Record<string, unknown> | null): Promise<unknown> {
    if (!APP_SERVER_METHODS.has(method)) throw new AgentError("RPC_FORBIDDEN", `app-server RPC '${method}' is not allowed`);
    const id = this.nextRequestId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentError("APP_SERVER_TIMEOUT", `${method} did not respond in time`));
      }, method === "initialize" ? 15_000 : ["model/list", "collaborationMode/list"].includes(method) ? 5_000 : ["account/read", "account/rateLimits/read", "config/read", "skills/list", "hooks/list", "mcpServerStatus/list", "app/list", "plugin/list", "permissionProfile/list", "experimentalFeature/list", "thread/goal/get", "thread/backgroundTerminals/list"].includes(method) ? 10_000 : 60_000);
      this.pending.set(id, { method, resolve, reject, timer });
    });
    try {
      await this.writeLine({ id, method, params });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) clearTimeout(pending.timer);
      this.pending.delete(id);
      throw error;
    }
    return promise;
  }

  private async writeLine(message: Record<string, unknown>): Promise<void> {
    const child = this.child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) {
      throw new AgentError("APP_SERVER_UNAVAILABLE", "app-server stdin is unavailable");
    }
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(line, "utf8", (error) => (error ? reject(error) : resolve()));
    });
  }

  private async handleLine(line: string): Promise<void> {
    if (Buffer.byteLength(line, "utf8") > 64 * 1024 * 1024) throw new AgentError("APP_SERVER_RESPONSE_TOO_LARGE", "会话历史超过读取上限，请减少单次历史范围");
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      await this.callbacks.onEvent({ type: "app_server.protocol_error", payload: { reason: "invalid_json" } }, this.appServerEpoch);
      return;
    }
    if (!isRecord(message)) return;
    if ((typeof message.id === "string" || typeof message.id === "number") && typeof message.method !== "string") {
      this.handleResponse(message);
      return;
    }
    if (typeof message.method !== "string") return;
    const params = isRecord(message.params) ? message.params : {};
    if (message.id !== undefined) {
      const requestId = readId(message.id, "server request id");
      if (!APPROVAL_METHODS.has(message.method)) {
        await this.writeLine({
          id: requestId,
          error: { code: -32601, message: "server request is not supported by AgentFleet" },
        }).catch(() => undefined);
        return;
      }
      const registration = this.handleApprovalRequest(requestId, message.method, params);
      this.inputRegistrations.set(requestId, registration);
      try { await registration; } finally { this.inputRegistrations.delete(requestId); }
      return;
    }
    await this.handleNotification(message.method, params);
  }

  private handleResponse(message: Record<string, unknown>): void {
    const id = message.id as JsonId;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (isRecord(message.error)) {
      const detail = typeof message.error.message === "string" ? message.error.message : "unknown app-server error";
      if (pending.method === "thread/resume" && detail.includes("already has an active writer")) {
        pending.reject(new AgentError("THREAD_WRITER_BUSY", "会话正在被本机 Codex 或其他客户端占用，请退出该会话后重试（active writer）"));
        return;
      }
      pending.reject(new AgentError("APP_SERVER_RPC_ERROR", `${pending.method}: ${detail}`));
      return;
    }
    pending.resolve(message.result);
  }

  private async handleApprovalRequest(requestId: JsonId, method: string, params: Record<string, unknown>): Promise<void> {
    const threadId = threadIdFromParams(params);
    const thread = threadId ? this.callbacks.findManagedThread(threadId) : undefined;
    const project = thread ? this.callbacks.findProject(thread.projectId) : undefined;
    if (!thread || !project || thread.appServerEpoch !== this.appServerEpoch || !thread.policyVerified) {
      await this.writeLine({ id: requestId, result: this.approvalResponse(method, "decline") }).catch(() => undefined);
      return;
    }
    // Older persisted bindings retain the strict legacy behavior until resumed.
    // For an explicitly resolved profile, escalation is an approval request,
    // never an automatic grant (including network and file-root requests).
    if (thread.permissionProfile === undefined && this.approvalExpandsPolicy(method, params, project)) {
      await this.writeLine({ id: requestId, result: this.approvalResponse(method, "decline") }).catch(() => undefined);
      const nativeTurnId = turnIdFromParams(params);
      const nativeItemId = itemIdFromParams(params);
      await this.callbacks.onEvent(
        {
          type: "approval.auto_declined",
          nativeThreadId: thread.nativeThreadId,
          ...(nativeTurnId === undefined ? {} : { nativeTurnId }),
          ...(nativeItemId === undefined ? {} : { nativeItemId }),
          payload: { reason: "requested action would expand remote-restricted-v1" },
        },
        this.appServerEpoch,
      );
      return;
    }
    const now = nowIso();
    const expiresAt = new Date(Date.now() + DEFAULT_APPROVAL_TTL_MS).toISOString();
    let safeParams: Record<string, unknown>;
    try {
      safeParams = method === "item/tool/requestUserInput"
        ? { kind: "user_input", questions: inputQuestions(params.questions), isBlocking: params.isBlocking === true }
        : this.sanitizeApprovalParams(method, params);
    } catch {
      await this.writeLine({ id: requestId, result: this.approvalResponse(method, "decline") });
      await this.callbacks.onEvent({ type: "agent.warning", nativeThreadId: thread.nativeThreadId,
        payload: { code: "INPUT_REQUEST_UNSUPPORTED", detail: "此请求包含敏感输入或不支持的权限格式，已拒绝；请检查执行权限配置。" } }, this.appServerEpoch);
      return;
    }
    const actionHash = sha256(
      canonicalJson({
        method,
        params: safeParams,
        appServerEpoch: this.appServerEpoch,
        projectId: project.id,
        projectRoot: project.root,
        projectIdentityVersion: project.identityVersion,
        policyVersion: POLICY_VERSION,
      }),
    );
    const approvalId = identifier("apr");
    const nativeTurnId = turnIdFromParams(params);
    const nativeItemId = itemIdFromParams(params);
    const approval: ApprovalRecord = {
      approvalId,
      nativeRequestId: requestId,
      method: method as ApprovalRecord["method"],
      actionHash,
      appServerEpoch: this.appServerEpoch,
      projectId: project.id,
      nativeThreadId: thread.nativeThreadId,
      ...(nativeTurnId === undefined ? {} : { nativeTurnId }),
      ...(nativeItemId === undefined ? {} : { nativeItemId }),
      expiresAt,
      state: "pending",
      params: safeParams,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.callbacks.onApproval(approval);
      const timer = setTimeout(() => {
        this.approvalTimers.delete(approvalId);
        void this.writeLine({ id: requestId, result: this.approvalResponse(method, "cancel") }).catch(() => undefined);
        void this.callbacks.onApprovalResolved(requestId, this.appServerEpoch).catch(() => undefined);
      }, DEFAULT_APPROVAL_TTL_MS);
      timer.unref();
      this.approvalTimers.set(approvalId, timer);
      this.requestApprovals.set(requestId, approvalId);
    } catch {
      await this.writeLine({ id: requestId, result: this.approvalResponse(method, "decline") }).catch(() => undefined);
    }
  }

  private approvalExpandsPolicy(method: string, params: Record<string, unknown>, project: ProjectRecord): boolean {
    if (method === "item/commandExecution/requestApproval") {
      if (params.kind === "writeStdin") return true;
      if (params.networkApprovalContext !== null && params.networkApprovalContext !== undefined) return true;
      if (Array.isArray(params.proposedNetworkPolicyAmendments) && params.proposedNetworkPolicyAmendments.length > 0) return true;
      if (params.proposedExecpolicyAmendment !== null && params.proposedExecpolicyAmendment !== undefined) return true;
    }
    if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
      if (params.grantRoot !== null && params.grantRoot !== undefined) return true;
    }
    const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
    return cwd !== undefined && !isPathInside(project.root, cwd);
  }

  private sanitizeApprovalParams(method: string, params: Record<string, unknown>): Record<string, unknown> {
    if (method === "item/permissions/requestApproval") return {
      kind: "permissions", threadId: params.threadId, turnId: params.turnId, itemId: params.itemId,
      cwd: safeText(params.cwd, 8_192)?.text ?? null, reason: safeText(params.reason, 16_000)?.text ?? null,
      permissions: requestedPermissions(params.permissions), grantScope: "turn",
    };
    if (method === "item/commandExecution/requestApproval") {
      return {
        kind: params.kind,
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        startedAtMs: params.startedAtMs,
        approvalId: params.approvalId ?? null,
        reason: safeText(params.reason, 16_000)?.text ?? null,
        command: safeText(params.command, 32_000)?.text ?? null,
        cwd: params.cwd ?? null,
        networkApprovalContext: isRecord(params.networkApprovalContext) ? {
          host: safeText(params.networkApprovalContext.host, 2_000)?.text ?? null,
          protocol: safeText(params.networkApprovalContext.protocol, 100)?.text ?? null,
        } : null,
        // Proposals are context only: accept-once never persists a rule.
        proposedExecpolicyAmendment: Array.isArray(params.proposedExecpolicyAmendment)
          ? params.proposedExecpolicyAmendment.slice(0, 256).map(value => safeText(value, 8_000)?.text ?? "") : null,
        additionalPermissions: isRecord(params.additionalPermissions) ? safeText(JSON.stringify(params.additionalPermissions), 32_000)?.text ?? null : null,
      };
    }
    if (method === "item/fileChange/requestApproval") {
      return {
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        startedAtMs: params.startedAtMs,
        reason: safeText(params.reason, 16_000)?.text ?? null,
        grantRoot: params.grantRoot ?? null,
      };
    }
    if (method === "execCommandApproval") {
      return {
        conversationId: params.conversationId,
        callId: params.callId,
        approvalId: params.approvalId ?? null,
        command: Array.isArray(params.command)
          ? params.command.slice(0, 256).map((entry) => safeText(entry, 8_000)?.text ?? "")
          : [],
        cwd: params.cwd,
        reason: safeText(params.reason, 16_000)?.text ?? null,
      };
    }
    return {
      conversationId: params.conversationId,
      callId: params.callId,
      reason: safeText(params.reason, 16_000)?.text ?? null,
      grantRoot: params.grantRoot ?? null,
      fileChanges: isRecord(params.fileChanges)
        ? Object.fromEntries(
            Object.entries(params.fileChanges)
              .slice(0, 1_000)
              .map(([path, change]) => [path, isRecord(change) ? { type: change.type } : {}]),
          )
        : {},
    };
  }

  private approvalResponse(method: string, decision: "accept" | "decline" | "cancel"): Record<string, unknown> {
    if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
    if (method === "item/tool/requestUserInput") return { answers: {} };
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      return { decision };
    }
    if (decision === "accept") return { decision: "approved" };
    if (decision === "cancel") return { decision: "abort" };
    return { decision: { denied: { rejection: "Declined by remote reviewer" } } };
  }

  private async handleNotification(method: string, params: Record<string, unknown>): Promise<void> {
    if (["thread/started", "thread/archived", "thread/unarchived", "thread/name/updated", "thread/status/changed", "turn/started", "turn/completed"].includes(method)) {
      this.callbacks.onCatalogChanged?.(this.appServerEpoch);
    }
    const threadId = threadIdFromParams(params);
    if (threadId && !this.callbacks.findManagedThread(threadId)) return;
    if (method === "turn/started" && threadId && isRecord(params.turn) && typeof params.turn.id === "string") {
      this.compactStarts.get(threadId)?.resolve({ nativeTurnId: params.turn.id, status: typeof params.turn.status === "string" ? params.turn.status : "inProgress" });
    }
    if (method === "item/agentMessage/delta" || method === "item/commandExecution/outputDelta") {
      const thread = typeof params.threadId === "string" ? params.threadId : undefined;
      const turn = typeof params.turnId === "string" ? params.turnId : undefined;
      const item = typeof params.itemId === "string" ? params.itemId : undefined;
      const delta = safeText(params.delta, MAX_DELTA_BYTES);
      if (thread && turn && item && delta) {
        this.callbacks.onVolatile(
          {
            type: method === "item/agentMessage/delta" ? "agent_message.delta" : "command_output.delta",
            nativeThreadId: thread,
            nativeTurnId: turn,
            nativeItemId: item,
            payload: { delta: delta.text, truncated: delta.truncated },
          },
          this.appServerEpoch,
        );
      }
      return;
    }
    if (method === "turn/diff/updated") {
      const thread = typeof params.threadId === "string" ? params.threadId : undefined;
      const turn = typeof params.turnId === "string" ? params.turnId : undefined;
      const diff = safeText(params.diff);
      if (thread && turn && diff) {
        this.finalDiffs.set(`${thread}\0${turn}`, diff.text);
        this.callbacks.onVolatile(
          {
            type: "turn_diff.delta",
            nativeThreadId: thread,
            nativeTurnId: turn,
            payload: { diff: diff.text, truncated: diff.truncated },
          },
          this.appServerEpoch,
        );
      }
      return;
    }
    if (method === "serverRequest/resolved") {
      if (params.requestId !== undefined) {
        const requestId = readId(params.requestId, "requestId");
        await this.inputRegistrations.get(requestId);
        const approvalId = this.requestApprovals.get(requestId);
        if (approvalId) {
          const timer = this.approvalTimers.get(approvalId);
          if (timer) clearTimeout(timer);
          this.approvalTimers.delete(approvalId);
          this.requestApprovals.delete(requestId);
        }
        await this.callbacks.onApprovalResolved(requestId, this.appServerEpoch);
      }
      return;
    }

    if (method === "account/updated") { this.quota = undefined; this.quotaGeneration++; this.callbacks.onQuotaChanged?.(); return; }
    if (method === "account/rateLimits/updated") { this.callbacks.onQuotaChanged?.(); return; }
    let event: AppEvent | null = null;
    if (method === "thread/tokenUsage/updated" && typeof params.threadId === "string" && typeof params.turnId === "string") {
      const usage = tokenUsage(params.tokenUsage);
      if (usage) await this.callbacks.onEvent({ type: "thread.usage", nativeThreadId: params.threadId, nativeTurnId: params.turnId, payload: { usage } }, this.appServerEpoch);
      return;
    }
    if (method === "thread/status/changed" && typeof params.threadId === "string" && isRecord(params.status)) {
      event = {
        type: "thread.status_changed",
        nativeThreadId: params.threadId,
        payload: { status: params.status },
      };
    } else if ((method === "item/started" || method === "item/completed") && isRecord(params.item)) {
      const item = sanitizeThreadItem(params.item);
      if (item && typeof params.threadId === "string" && typeof params.turnId === "string") {
        const nativeItemId = typeof params.item.id === "string" ? params.item.id : undefined;
        event = {
          type: method === "item/started" ? "item.started" : "item.completed",
          nativeThreadId: params.threadId,
          nativeTurnId: params.turnId,
          ...(nativeItemId === undefined ? {} : { nativeItemId }),
          payload: { item },
        };
      }
    } else if (method === "turn/completed" && typeof params.threadId === "string") {
      const turn = summarizeTurn(params.turn);
      if (turn && typeof turn.id === "string") {
        const finalDiff = this.finalDiffs.get(`${params.threadId}\0${turn.id}`);
        this.finalDiffs.delete(`${params.threadId}\0${turn.id}`);
        event = {
          type: "turn.completed",
          nativeThreadId: params.threadId,
          nativeTurnId: turn.id,
          payload: { turn, ...(finalDiff === undefined ? {} : { finalDiff }) },
        };
      }
    } else if (method === "error" && typeof params.threadId === "string" && typeof params.turnId === "string") {
      const error = isRecord(params.error) ? safeText(params.error.message, 32_000)?.text : undefined;
      event = {
        type: "turn.error",
        nativeThreadId: params.threadId,
        nativeTurnId: params.turnId,
        payload: { message: error ?? "Codex reported an error", willRetry: params.willRetry === true },
      };
    }
    if (event) await this.callbacks.onEvent(event, this.appServerEpoch);
  }

  private handleExit(detail: string): void {
    if (this.exitHandled) return;
    this.exitHandled = true;
    this.child = undefined;
    this.initialized = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AgentError("APP_SERVER_EXITED", `${pending.method}: ${detail}`));
    }
    this.pending.clear();
    for (const pending of this.compactStarts.values()) pending.reject(new AgentError("APP_SERVER_EXITED", "App Server exited during compaction"));
    this.compactStarts.clear();
    for (const timer of this.approvalTimers.values()) clearTimeout(timer);
    this.approvalTimers.clear();
    this.requestApprovals.clear();
    if (!this.stopping) void this.callbacks.onExit(this.appServerEpoch, redact(errorMessage(detail)));
  }
}
