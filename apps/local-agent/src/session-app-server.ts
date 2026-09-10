import { randomUUID } from "node:crypto";
import { CodexAppServer, type AppServerCallbacks, type AppServerClient, type ThreadStartResult } from "./app-server.js";
import { AgentError } from "./errors.js";
import type { ApprovalRecord, ManagedThread, ProjectRecord } from "./types.js";
import type { CodexSettings } from "./codex-settings.js";
import type { InputAnswers } from "./user-input.js";

type Writer = { client: AppServerClient; token: string; threadId?: string; live: boolean };
type Factory = (callbacks: AppServerCallbacks, epoch: string) => AppServerClient;

/** One read-only catalog connection and disposable, isolated session writers.
 * The public epoch fences the facade; writer tokens additionally fence delayed
 * callbacks and overlapping native approval request IDs from child processes.
 */
export class SessionAppServer implements AppServerClient {
  readonly appServerEpoch = randomUUID();
  private readonly catalog: AppServerClient;
  private readonly writers = new Map<string, Writer>();
  private readonly allWriters = new Set<Writer>();
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly approvals = new Map<string, { writer: Writer; original: ApprovalRecord }>();
  private stopped = false;

  constructor(private readonly callbacks: AppServerCallbacks, private readonly factory: Factory = (cb, epoch) => new CodexAppServer(cb, epoch)) {
    this.catalog = factory({ ...callbacks,
      findManagedThread: () => undefined,
      onEvent: async () => undefined, onVolatile: () => undefined,
      onApproval: async () => { throw new AgentError("THREAD_READ_ONLY", "Catalog cannot approve execution"); },
      onApprovalResolved: async () => undefined,
      onExit: async (epoch, detail) => {
        if (this.stopped) return;
        await this.stop();
        await callbacks.onExit(epoch, detail);
      },
    }, this.appServerEpoch);
  }

  start() { return this.catalog.start(); }
  async stop() {
    this.stopped = true;
    for (const writer of this.allWriters) writer.live = false;
    await Promise.all([this.catalog.stop(), ...[...this.allWriters].map(w => w.client.stop())]);
    this.writers.clear(); this.allWriters.clear(); this.approvals.clear();
  }
  async refreshQuota() { await this.catalog.refreshQuota?.(); }
  getQuotaSnapshot() { return this.catalog.getQuotaSnapshot?.(); }
  getCodexCatalog() { return this.catalog.getCodexCatalog!(); }
  listThreads() { return this.catalog.listThreads(); }
  listThreadPage(cursor: string | null, options?: { useStateDbOnly: boolean }) { return this.catalog.listThreadPage!(cursor, options); }
  readTurnOutcome(id: string, turnId: string) { return this.catalog.readTurnOutcome!(id, turnId); }
  readThread(id: string, metadataOnly?: boolean) { return (this.writers.get(id)?.client ?? this.catalog).readThread(id, metadataOnly); }
  readHistoryPage(id: string, cursor: string | null) {
    const client = this.writers.get(id)?.client ?? this.catalog;
    if (!client.readHistoryPage) throw new AgentError("HISTORY_PAGING_UNAVAILABLE", "Native history pagination is unavailable");
    return client.readHistoryPage(id,cursor);
  }
  inspectEnvironment(cwd: string, id?: string) { return (id ? this.writers.get(id)?.client ?? this.catalog : this.catalog).inspectEnvironment!(cwd, id); }

  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.lanes.set(id, next);
    void next.finally(() => { if (this.lanes.get(id) === next) this.lanes.delete(id); }).catch(() => undefined);
    return next;
  }

  private async newWriter(threadId?: string): Promise<Writer> {
    if (this.stopped) throw new AgentError("APP_SERVER_UNAVAILABLE", "Session service is stopping");
    // Bound private processes, including pending startups and failed handoffs.
    if (this.allWriters.size >= 16) throw new AgentError("PROJECT_BUSY", "Too many active session writers; finish or release an existing session first");
    const writer = { token: randomUUID(), live: true, ...(threadId ? { threadId } : {}) } as Writer;
    const current = () => writer.live && !this.stopped;
    const scope = (id: string | number) => `${writer.token}:${JSON.stringify(id)}`;
    writer.client = this.factory({
      findManagedThread: id => current() && id === writer.threadId ? this.callbacks.findManagedThread(id) : undefined,
      findProject: id => this.callbacks.findProject(id),
      onEvent: async (event, epoch) => { if (current() && event.nativeThreadId === writer.threadId) await this.callbacks.onEvent(event, epoch); },
      onVolatile: (event, epoch) => { if (current() && event.nativeThreadId === writer.threadId) this.callbacks.onVolatile(event, epoch); },
      onCatalogChanged: epoch => { if (current()) this.callbacks.onCatalogChanged?.(epoch); },
      onApproval: async approval => {
        if (!current() || approval.nativeThreadId !== writer.threadId) throw new AgentError("APPROVAL_PRECONDITION_FAILED", "Stale writer approval");
        this.approvals.set(approval.approvalId, { writer, original: approval });
        await this.callbacks.onApproval({ ...approval, nativeRequestId: scope(approval.nativeRequestId) });
      },
      onApprovalResolved: async (id, epoch) => { if (current()) await this.callbacks.onApprovalResolved(scope(id), epoch); },
      onExit: async (epoch, detail) => {
        if (!current()) return;
        this.forget(writer);
        if (writer.threadId) await this.callbacks.onThreadExit?.(writer.threadId, epoch, detail);
      },
    }, this.appServerEpoch);
    this.allWriters.add(writer);
    if (threadId) this.writers.set(threadId, writer);
    try { await writer.client.start(); return writer; }
    catch (error) { this.forget(writer); await writer.client.stop(); throw error; }
  }

  private forget(writer: Writer) {
    writer.live = false;
    if (writer.threadId && this.writers.get(writer.threadId) === writer) this.writers.delete(writer.threadId);
    this.allWriters.delete(writer);
    for (const [id, entry] of this.approvals) if (entry.writer === writer) this.approvals.delete(id);
  }
  private writer(id: string) {
    const writer = this.writers.get(id);
    if (!writer?.live) throw new AgentError("THREAD_READ_ONLY", "会话执行连接已释放，请重新发送以恢复连接");
    return writer;
  }
  private async release(writer: Writer) {
    if (!writer.client.releaseWriter) throw new AgentError("THREAD_RELEASE_PENDING", "Runtime cannot confirm writer release");
    await writer.client.releaseWriter();
    this.forget(writer);
  }

  async createThread(project: ProjectRecord, profile?: import("./permissions.js").PermissionProfile, name?: string): Promise<ThreadStartResult> {
    const writer = await this.newWriter();
    try {
      const result = await writer.client.createThread(project, profile, name);
      writer.threadId = result.nativeThreadId;
      this.writers.set(result.nativeThreadId, writer);
      return result;
    } catch (error) { await this.release(writer).catch(() => undefined); throw error; }
  }
  resumeThread(id: string, project: ProjectRecord, cwd?: string, profile?: import("./permissions.js").PermissionProfile) {
    return this.serial(id, async () => {
      const writer = this.writers.get(id) ?? await this.newWriter(id);
      try { return await writer.client.resumeThread(id, project, cwd, profile); }
      catch (error) { await this.release(writer).catch(() => undefined); throw error; }
    });
  }
  unsubscribeThread(id: string) {
    return this.serial(id, async () => {
      const writer = this.writers.get(id);
      if (writer) await this.release(writer);
      // No writer in this facade means it never acquired, or confirmed exit.
      // It makes no assertion about another CLI/desktop process's ownership.
    });
  }
  startTurn(thread: ManagedThread, project: ProjectRecord, prompt: string, messageId?: string, settings?: CodexSettings, images?: string[]) {
    return this.serial(thread.nativeThreadId, () => this.writer(thread.nativeThreadId).client.startTurn(thread, project, prompt, messageId, settings, images));
  }
  startNativeTurn(thread: ManagedThread, action: "compact" | "review", target?: Record<string, unknown>) {
    return this.serial(thread.nativeThreadId, () => this.writer(thread.nativeThreadId).client.startNativeTurn!(thread, action, target));
  }
  steerTurn(thread: ManagedThread, turnId: string, prompt: string, messageId?: string, images?: string[]) { return this.writer(thread.nativeThreadId).client.steerTurn(thread, turnId, prompt, messageId, images); }
  interruptTurn(id: string, turnId: string) { return this.writer(id).client.interruptTurn(id, turnId); }
  async stopBackgroundTerminals(thread: ManagedThread, project: ProjectRecord) {
    await this.writer(thread.nativeThreadId).client.stopBackgroundTerminals!(thread, project);
  }
  previewDeletion(thread:ManagedThread,project:ProjectRecord) {
    if(!this.catalog.previewDeletion)throw new AgentError("DELETE_UNAVAILABLE","Runtime does not support deletion preview");
    return this.catalog.previewDeletion(thread,project);
  }
  deleteThread(thread:ManagedThread,project:ProjectRecord,preview:import("./native-deletion.js").DeletionPreview) {
    return this.serial(thread.nativeThreadId,async()=>{
      const writer=this.writers.get(thread.nativeThreadId)??await this.newWriter(thread.nativeThreadId);
      try {
        if(!writer.client.deleteThread)throw new AgentError("DELETE_UNAVAILABLE","Runtime does not support deletion");
        await writer.client.deleteThread(thread,project,preview);
      } catch (error) {
        await this.release(writer).catch(() => undefined);
        throw error;
      }
      // Once native deletion is confirmed, cleanup failure must not erase its receipt.
      try { await this.release(writer); }
      catch {
        try { await writer.client.stop(); this.forget(writer); } catch { /* Keep tracking an unconfirmed process. */ }
        process.stderr.write("warning: native deletion confirmed; writer release needed fallback cleanup\n");
      }
    });
  }
  threadAction(thread: ManagedThread, project: ProjectRecord, action: "rename" | "archive" | "unarchive" | "fork", name?: string, expectedTitle?: string) {
    return this.serial(thread.nativeThreadId, async () => {
      const writer = this.writers.get(thread.nativeThreadId) ?? await this.newWriter(thread.nativeThreadId);
      try { return await writer.client.threadAction!(thread, project, action, name, expectedTitle); }
      finally { await this.release(writer); }
    });
  }
  private approval(approval: ApprovalRecord) {
    const entry = this.approvals.get(approval.approvalId);
    if (!entry?.writer.live || entry.original.actionHash !== approval.actionHash) throw new AgentError("APPROVAL_PRECONDITION_FAILED", "Approval belongs to a released writer");
    return entry;
  }
  async respondApproval(approval: ApprovalRecord, decision: "accept" | "decline" | "cancel") {
    const entry = this.approval(approval);
    await entry.writer.client.respondApproval(entry.original, decision);
    this.approvals.delete(approval.approvalId);
  }
  async respondInput(approval: ApprovalRecord, answers: InputAnswers) {
    const entry = this.approval(approval);
    await entry.writer.client.respondInput!(entry.original, answers);
    this.approvals.delete(approval.approvalId);
  }
}
