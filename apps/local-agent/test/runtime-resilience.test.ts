import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AppServerCallbacks,
  AppServerClient,
  DiscoveredThreadSummary,
  ThreadHistorySnapshot,
  ThreadResumeResult,
  ThreadStartResult,
  TurnStartResult,
} from "../src/app-server.js";
import { AgentError } from "../src/errors.js";
import type { CodexSettings, CodexCatalog } from "../src/codex-settings.js";
import type { MachineIdentity } from "../src/identity.js";
import { discoverProjectFromCwd, resolveProject } from "../src/projects.js";
import {
  AgentRuntime,
  appServerRestartDelay,
  commandEnvelopeHash,
  type AppServerFactory,
} from "../src/runtime.js";
import { StateStore } from "../src/store.js";
import type {
  ApprovalRecord,
  FleetCommand,
  ManagedThread,
  PairingCredential,
  ProjectRecord,
  SupportReport,
} from "../src/types.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

class FakeAppServer implements AppServerClient {
  readonly appServerEpoch: string;
  readonly callbacks: AppServerCallbacks;
  startError: Error | undefined;
  createThreadHook: ((project: ProjectRecord) => void | Promise<void>) | undefined;
  listThreadsHook: (() => Promise<DiscoveredThreadSummary[]>) | undefined;
  startTurnHook: ((thread: ManagedThread, project: ProjectRecord) => Promise<TurnStartResult>) | undefined;
  startCount = 0;
  stopCount = 0;
  createThreadCount = 0;
  createdName: string | undefined;
  createdProfile: import("../src/permissions.js").PermissionProfile | undefined;
  startTurnCount = 0;
  interruptTurnCount = 0;
  steerTurnCount = 0;
  listCount = 0;
  readCount = 0;
  readIds: string[] = [];
  resumeCount = 0;
  unsubscribeCount = 0;
  histories = new Map<string, ThreadHistorySnapshot>();
  receivedSettings: CodexSettings | undefined;
  inputCalls: unknown[] = [];
  nativeCalls: string[] = [];
  async stopBackgroundTerminals(thread: ManagedThread): Promise<void> { this.nativeCalls.push(`stop:${thread.nativeThreadId}`); }
  async respondInput(_request: ApprovalRecord, answers: Record<string, { answers: string[] }>): Promise<void> { this.inputCalls.push(answers); }
  async threadAction(_thread: ManagedThread, _project: ProjectRecord, action: "rename" | "archive" | "unarchive" | "fork", name?: string): Promise<Record<string, unknown>> {
    this.nativeCalls.push(action);
    return action === "rename" ? { title: name } : { archived: action === "archive" };
  }
  async startNativeTurn(_thread: ManagedThread, action: "compact" | "review"): Promise<TurnStartResult> { this.nativeCalls.push(action); return { nativeTurnId: `native-${action}`, status: "inProgress" }; }
  getCodexCatalog(): CodexCatalog { return { models: [{ model: "host-model", displayName: "Host", efforts: ["low", "high"], defaultEffort: "low" }], modes: ["default"], fetchedAt: new Date().toISOString() }; }

  constructor(appServerEpoch: string, callbacks: AppServerCallbacks, startError?: Error) {
    this.appServerEpoch = appServerEpoch;
    this.callbacks = callbacks;
    this.startError = startError;
  }

  async start(): Promise<void> {
    this.startCount += 1;
    if (this.startError) throw this.startError;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
  }

  async createThread(project: ProjectRecord, profile?: import("../src/permissions.js").PermissionProfile, name?: string): Promise<ThreadStartResult> {
    this.createdProfile = profile; this.createdName = name;
    this.createThreadCount += 1;
    await this.createThreadHook?.(project);
    return {
      nativeThreadId: `thread-${this.appServerEpoch}-${this.createThreadCount}`,
      policyVerified: true,
      rawSummary: { cwd: project.root },
    };
  }

  async listThreads(): Promise<DiscoveredThreadSummary[]> {
    this.listCount += 1;
    if (this.listThreadsHook) return this.listThreadsHook();
    return [];
  }

  async readThread(threadId: string): Promise<ThreadHistorySnapshot> {
    this.readCount += 1;
    this.readIds.push(threadId);
    return this.histories.get(threadId) ?? {
      nativeThreadId: threadId,
      cwd: "/unknown",
      historyMode: "legacy",
      executionState: "idle",
      updatedAt: null,
      items: [],
    };
  }

  async resumeThread(threadId: string, project: ProjectRecord): Promise<ThreadResumeResult> {
    this.resumeCount += 1;
    const history = this.histories.get(threadId) ?? {
      nativeThreadId: threadId,
      cwd: project.root,
      historyMode: "legacy" as const,
      executionState: "idle" as const,
      updatedAt: null,
      items: [],
    };
    return {
      nativeThreadId: threadId,
      policyVerified: true,
      rawSummary: { cwd: project.root },
      history,
    };
  }

  async unsubscribeThread(_threadId: string): Promise<void> {
    this.unsubscribeCount += 1;
  }

  async startTurn(thread: ManagedThread, project: ProjectRecord, _prompt?: string, _messageId?: string, settings?: CodexSettings): Promise<TurnStartResult> {
    this.receivedSettings = settings;
    this.startTurnCount += 1;
    if (this.startTurnHook) return this.startTurnHook(thread, project);
    return { nativeTurnId: `turn-${this.appServerEpoch}-${this.startTurnCount}`, status: "inProgress" };
  }

  async interruptTurn(_threadId: string, _turnId: string): Promise<Record<string, unknown>> {
    this.interruptTurnCount += 1;
    return {};
  }

  async steerTurn(thread: ManagedThread, turnId: string): Promise<TurnStartResult> {
    this.steerTurnCount += 1;
    assert.equal(thread.activeTurnId, turnId);
    return { nativeTurnId: turnId, status: "inProgress" };
  }

  async respondApproval(_approval: ApprovalRecord, _decision: "accept" | "decline" | "cancel"): Promise<void> {}

  async exit(detail = "test exit"): Promise<void> {
    await this.callbacks.onExit(this.appServerEpoch, detail);
  }
}

const identity: MachineIdentity = {
  metadata: {
    algorithm: "Ed25519",
    publicKey: "test-public-key",
    fingerprint: "SHA256:test",
    verificationPhrase: "test-phrase",
    credentialProtectionLevel: "software_protected",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  sign: () => "test-signature",
};

const pairing: PairingCredential = {
  controlPlaneUrl: "https://fleet.invalid",
  machineId: "machine-1",
  agentToken: "test-token",
  pairedAt: "2026-01-01T00:00:00.000Z",
  machineName: "test-machine",
};

const support: SupportReport = {
  supported: true,
  writable: true,
  readOnlyReasons: [],
  platform: "linux",
  architecture: "x64",
  osId: "ubuntu",
  osVersion: "24.04",
  uid: 1000,
  nodeVersion: "v24.14.0",
  codexVersion: "0.153.2",
  codexSchemaHash: "test-schema",
  expectedCodexSchemaHash: "test-schema",
};

interface RuntimeFixture {
  directory: string;
  store: StateStore;
  projects: ProjectRecord[];
}

async function fixture(projectCount = 1): Promise<RuntimeFixture> {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-runtime-test-"));
  const store = new StateStore(join(directory, "state"));
  await store.initialize();
  const projects: ProjectRecord[] = [];
  for (let index = 1; index <= projectCount; index += 1) {
    const root = join(directory, `project-${index}`);
    await mkdir(root);
    const project = await resolveProject(root, `project-${index}`);
    await store.addProject(project);
    projects.push(project);
  }
  return { directory, store, projects };
}

function command(
  project: ProjectRecord,
  attemptId: string,
  commandId: string,
  logicalSessionId: string,
  appServerEpoch: string,
): FleetCommand {
  const executionSegmentId = `segment-${logicalSessionId}`;
  return {
    attemptId,
    commandId,
    type: "turn.start",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    projectId: project.id,
    logicalSessionId,
    executionSegmentId,
    contentEpoch: 1,
    payload: { prompt: `hello from ${logicalSessionId}` },
    precondition: {
      executionSegmentId,
      expectedActiveTurnId: null,
      projectLeaseVersion: project.identityVersion,
    },
    transportGeneration: 1,
    appServerEpoch,
  };
}

function claimCommand(
  project: ProjectRecord,
  nativeThreadId: string,
  logicalSessionId: string,
  appServerEpoch: string,
): FleetCommand {
  return {
    attemptId: `attempt-claim-${nativeThreadId}`,
    commandId: `command-claim-${nativeThreadId}`,
    type: "thread.claim",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    projectId: project.id,
    logicalSessionId,
    executionSegmentId: `segment-${logicalSessionId}`,
    contentEpoch: 1,
    payload: {},
    precondition: {
      nativeThreadId,
      expectedActiveTurnId: null,
      projectLeaseVersion: project.identityVersion,
    },
    transportGeneration: 1,
    appServerEpoch,
  };
}

function releaseCommand(
  project: ProjectRecord,
  nativeThreadId: string,
  logicalSessionId: string,
  appServerEpoch: string,
): FleetCommand {
  return {
    attemptId: `attempt-release-${nativeThreadId}`,
    commandId: `command-release-${nativeThreadId}`,
    type: "thread.release",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    projectId: project.id,
    logicalSessionId,
    executionSegmentId: `segment-${logicalSessionId}`,
    contentEpoch: 1,
    payload: {},
    precondition: {
      nativeThreadId,
      threadControlVersion: 2,
      expectedActiveTurnId: null,
      projectLeaseVersion: project.identityVersion,
    },
    transportGeneration: 1,
    appServerEpoch,
  };
}

function captureCallbacks(runtime: AgentRuntime): { acks: Record<string, unknown>[]; registryChanges: { count: number } } {
  const acks: Record<string, unknown>[] = [];
  const registryChanges = { count: 0 };
  runtime.setCallbacks({
    onOutboxChanged: () => undefined,
    onVolatile: () => undefined,
    onCommandAck: (ack) => acks.push(ack),
    onRegistryChanged: () => {
      registryChanges.count += 1;
    },
  });
  return { acks, registryChanges };
}

function ackStates(acks: Record<string, unknown>[], attemptId: string): unknown[] {
  return acks
    .filter((ack) => ack.dispatchAttemptId === attemptId)
    .map((ack) => ack.state);
}

test("structured answers are one-shot, session-bound and invalidated on native resolution", async (t) => {
  const { store, projects } = await fixture(); const project = projects[0]!;
  let server!: FakeAppServer;
  const runtime = new AgentRuntime({ store, identity, pairing, support, appServerFactory: (cb) => (server = new FakeAppServer("epoch-input", cb)) });
  runtime.setTransportGeneration(1); captureCallbacks(runtime); await runtime.initialize(); t.after(() => runtime.shutdown());
  await store.setManagedThread({ nativeThreadId: "thread-input", projectId: project.id, logicalSessionId: "session-input", executionSegmentId: "segment-session-input", appServerEpoch: server.appServerEpoch, policyVerified: true, policyVersion: "remote-restricted-v1", contentEpoch: 1, createdAt: new Date().toISOString() });
  const request: ApprovalRecord = { approvalId: "input-1", nativeRequestId: 10, method: "item/tool/requestUserInput", actionHash: "input-hash", appServerEpoch: server.appServerEpoch, projectId: project.id, nativeThreadId: "thread-input", expiresAt: new Date(Date.now() + 60_000).toISOString(), state: "pending", params: { kind: "user_input", questions: [{ id: "q", header: "选择", question: "怎么继续？", options: [] }] }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await server.callbacks.onApproval(request);
  const reply = { ...command(project, "input-attempt", "input-command", "session-input", server.appServerEpoch), type: "input.respond" as const, payload: { answers: { q: { answers: ["继续开发"] } } }, precondition: { approvalId: request.approvalId, approvalVersion: 1, actionHash: request.actionHash, appServerEpoch: request.appServerEpoch } };
  await runtime.handleCommand({ ...reply, logicalSessionId: "other", commandId: "cross-session", attemptId: "cross-session" }, 1);
  assert.equal(server.inputCalls.length, 0);
  await runtime.handleCommand({ ...reply, type: "approval.decide_once", payload: { decision: "approve" }, commandId: "wrong-kind", attemptId: "wrong-kind" }, 1);
  assert.equal(server.inputCalls.length, 0);
  await runtime.handleCommand(reply, 1); await runtime.handleCommand({ ...reply, attemptId: "input-retry" }, 1);
  assert.equal(server.inputCalls.length, 1);
  assert.equal(store.snapshot().approvals[request.approvalId]?.state, "decided");
  const second = { ...request, approvalId: "input-2", nativeRequestId: 11 };
  await server.callbacks.onApproval(second); await server.callbacks.onApprovalResolved(11, server.appServerEpoch);
  assert.equal(store.snapshot().approvals[second.approvalId]?.state, "invalidated");
  await runtime.handleCommand({ ...reply, attemptId: "input-stale", commandId: "input-stale", precondition: { ...reply.precondition, approvalId: second.approvalId } }, 1);
  assert.equal(server.inputCalls.length, 1);
});

test("native lifecycle actions persist metadata, replay once and block turns while archived", async (t) => {
  const { store, projects } = await fixture(); const project = projects[0]!;
  let server!: FakeAppServer;
  const runtime = new AgentRuntime({ store, identity, pairing, support, appServerFactory: (cb) => (server = new FakeAppServer("epoch-native", cb)) });
  runtime.setTransportGeneration(1); captureCallbacks(runtime); await runtime.initialize(); t.after(() => runtime.shutdown());
  await store.setManagedThread({ nativeThreadId: "thread-native", projectId: project.id, logicalSessionId: "session-native", executionSegmentId: "segment-session-native", appServerEpoch: server.appServerEpoch, policyVerified: true, policyVersion: "remote-restricted-v1", contentEpoch: 1, createdAt: new Date().toISOString(), sessionCwd: project.root });
  const base = { ...command(project, "native-rename", "native-rename", "session-native", server.appServerEpoch), type: "thread.rename" as const, payload: { name: "新的标题" }, precondition: { nativeThreadId: "thread-native", expectedActiveTurnId: null, projectLeaseVersion: project.identityVersion } };
  await runtime.handleCommand(base, 1); await runtime.handleCommand({ ...base, attemptId: "native-retry" }, 1);
  assert.deepEqual(server.nativeCalls, ["rename"]); assert.equal(store.snapshot().managedThreads["thread-native"]?.title, "新的标题");
  await runtime.handleCommand({ ...base, type: "thread.archive", payload: {}, commandId: "archive", attemptId: "archive" }, 1);
  assert.equal(store.snapshot().managedThreads["thread-native"]?.archived, true);
  await runtime.handleCommand(command(project, "blocked-start", "blocked-start", "session-native", server.appServerEpoch), 1);
  assert.equal(server.startTurnCount, 0);
  await runtime.handleCommand({ ...base, type: "thread.unarchive", payload: {}, commandId: "restore", attemptId: "restore" }, 1);
  assert.equal(store.snapshot().managedThreads["thread-native"]?.archived, false);
  const compact = { ...command(project, "compact", "compact", "session-native", server.appServerEpoch), type: "turn.compact" as const, payload: {} };
  await runtime.handleCommand(compact, 1); await runtime.handleCommand({ ...compact, attemptId: "compact-retry" }, 1);
  assert.deepEqual(server.nativeCalls, ["rename", "archive", "unarchive", "compact"]);
  assert.equal(store.snapshot().managedThreads["thread-native"]?.activeTurnId, "native-compact");
  assert.equal(server.startTurnCount, 0, "native compaction must never be sent as a prompt");
  const stop = { ...command(project, "stop-terminals", "stop-terminals", "session-native", server.appServerEpoch), type: "thread.terminals.stop" as const, payload: {}, precondition: { nativeThreadId: "thread-native", executionSegmentId: "segment-session-native", expectedActiveTurnId: "native-compact", projectLeaseVersion: project.identityVersion } };
  await runtime.handleCommand({ ...stop, commandId: "wrong-stop", attemptId: "wrong-stop", precondition: { ...stop.precondition, nativeThreadId: "other-thread" } }, 1);
  assert.equal(server.nativeCalls.some(c=>c.startsWith("stop:")), false);
  await runtime.handleCommand(stop, 1); await runtime.handleCommand({ ...stop, attemptId: "stop-terminals-retry" }, 1);
  assert.equal(server.nativeCalls.filter(c=>c === "stop:thread-native").length, 1);
  assert.equal(store.snapshot().managedThreads["thread-native"]?.activeTurnId, "native-compact", "stopping terminals is not canceling a turn");
});

test("immutable command hash ignores delivery binding but detects semantic mutation", () => {
  const project = {
    id: "project-1",
    alias: "project",
    root: "/tmp/project",
    device: "1",
    inode: "2",
    identityVersion: 1,
    addedAt: "2026-01-01T00:00:00.000Z",
  } satisfies ProjectRecord;
  const first = command(project, "attempt-1", "command-1", "session-1", "epoch-1");
  const retried = { ...first, attemptId: "attempt-2", transportGeneration: 99, appServerEpoch: "epoch-2" };
  assert.equal(commandEnvelopeHash(retried), commandEnvelopeHash(first));
  assert.notEqual(commandEnvelopeHash({ ...retried, payload: { prompt: "changed" } }), commandEnvelopeHash(first));
  assert.notEqual(
    commandEnvelopeHash({ ...retried, clientMutationId: "mutation-b" }),
    commandEnvelopeHash({ ...first, clientMutationId: "mutation-a" }),
  );
  assert.equal(
    commandEnvelopeHash({ ...retried, state: "dispatching", payloadState: "present" }),
    commandEnvelopeHash({ ...first, state: "accepted", payloadState: "present" }),
  );
});

test("readiness allows an empty catalog and never validates an unreadable update", async t => {
  for (const writable of [true, false]) {
    const { store } = await fixture(0);
    const runtime = new AgentRuntime({ store, identity, pairing, support: { ...support, writable, readable: writable },
      appServerFactory: callbacks => new FakeAppServer("epoch-preflight", callbacks) });
    t.after(() => runtime.shutdown());
    assert.equal(runtime.readyForHealthCheck(), false);
    await runtime.initialize();
    assert.equal(runtime.readyForHealthCheck(), writable);
    assert.equal(runtime.getDiscoveryStatus().readiness, writable ? "ready" : "action_required");
    assert.equal(runtime.heartbeatPayload().readOnly, !writable);
  }
});

test("read-only sandbox restrictions retain service health for online diagnosis", async t => {
  const { store } = await fixture(0);
  const runtime = new AgentRuntime({ store, identity, pairing, support: { ...support, writable: false, readable: true },
    appServerFactory: callbacks => new FakeAppServer("epoch-read-only-health", callbacks) });
  t.after(() => runtime.shutdown());
  await runtime.initialize();
  assert.equal(runtime.readyForHealthCheck(), true);
  assert.equal(runtime.isWritable(), false);
  assert.equal(runtime.heartbeatPayload().readOnly, true);
});

test("host validates model settings before creating a thread and journals accepted settings", async (t) => {
  const { directory, store, projects } = await fixture();
  let server!: FakeAppServer;
  const runtime = new AgentRuntime({ store, identity, pairing, support, appServerFactory: (callbacks) => (server = new FakeAppServer("epoch-settings", callbacks)) });
  runtime.setTransportGeneration(1); captureCallbacks(runtime);
  await runtime.initialize(); t.after(() => runtime.shutdown());
  const invalid = command(projects[0]!, "attempt-invalid-model", "command-invalid-model", "session-settings", "epoch-settings");
  invalid.payload.settings = { model: "model-from-another-host" };
  await runtime.handleCommand(invalid, 1);
  assert.equal(server.createThreadCount, 0); assert.equal(server.startTurnCount, 0);
  const valid = command(projects[0]!, "attempt-valid-model", "command-valid-model", "session-settings", "epoch-settings");
  valid.payload.settings = { model: "host-model", effort: "high", mode: "default" };
  valid.payload.permissionProfile = "network"; valid.payload.permissionSource = "machine"; valid.payload.sessionTitle = "Stable cloud name";
  await runtime.handleCommand(valid, 1);
  assert.deepEqual(server.receivedSettings, valid.payload.settings);
  assert.equal(server.createdName, "Stable cloud name"); assert.equal(server.createdProfile, "network");
  assert.deepEqual(server.nativeCalls, [], "first-turn naming must not use the release-and-resume lifecycle action");
  assert.equal(Object.values(store.snapshot().managedThreads)[0]?.acceptedPermissions?.profile, "network");
  assert.equal(Object.values(store.snapshot().managedThreads)[0]?.title, "Stable cloud name");
  assert.equal(Object.values(store.snapshot().managedThreads)[0]?.acceptedSettings?.model, "host-model");
  assert.equal(store.snapshot().commandJournal[valid.commandId]?.state, "applied");
  const reopened = new StateStore(join(directory, "state")); await reopened.initialize();
  assert.equal(Object.values(reopened.snapshot().managedThreads)[0]?.acceptedSettings?.effort, "high");
});

test("terminal command replays a legal new-attempt lifecycle after process reopen without invoking", async () => {
  const { directory, store, projects } = await fixture();
  const project = projects[0] as ProjectRecord;
  let firstServer!: FakeAppServer;
  const firstRuntime = new AgentRuntime({
    store,
    identity,
    pairing,
    support,
    appServerFactory: (callbacks) => {
      firstServer = new FakeAppServer("epoch-1", callbacks);
      return firstServer;
    },
  });
  firstRuntime.setTransportGeneration(1);
  captureCallbacks(firstRuntime);
  await firstRuntime.initialize();
  const original = command(project, "attempt-1", "command-1", "session-1", "epoch-1");
  await firstRuntime.handleCommand(original, 1);
  assert.equal(firstServer.createThreadCount, 1);
  assert.equal(firstServer.startTurnCount, 1);
  assert.equal(
    store.snapshot().outbox.find((event) => event.type === "turn.started")?.appServerEpoch,
    "epoch-1",
  );
  assert.equal(store.snapshot().commandJournal[original.commandId]?.state, "applied");
  await firstRuntime.shutdown();

  const reopened = new StateStore(join(directory, "state"));
  await reopened.initialize();
  let secondServer!: FakeAppServer;
  const secondRuntime = new AgentRuntime({
    store: reopened,
    identity,
    pairing,
    support,
    appServerFactory: (callbacks) => {
      secondServer = new FakeAppServer("epoch-2", callbacks);
      return secondServer;
    },
  });
  secondRuntime.setTransportGeneration(1);
  const { acks } = captureCallbacks(secondRuntime);
  await secondRuntime.initialize();
  const retry = { ...original, attemptId: "attempt-2", appServerEpoch: "epoch-2" };
  await secondRuntime.handleCommand(retry, 1);
  assert.deepEqual(ackStates(acks, retry.attemptId), ["claimed", "invoking", "responded", "applied"]);
  assert.equal(secondServer.createThreadCount, 0);
  assert.equal(secondServer.startTurnCount, 0);

  const mutated = { ...retry, attemptId: "attempt-3", payload: { prompt: "changed" } };
  await secondRuntime.handleCommand(mutated, 1);
  assert.deepEqual(ackStates(acks, mutated.attemptId), ["invalidated"]);
  assert.equal(secondServer.startTurnCount, 0);
  await secondRuntime.shutdown();
});

test("same-project reservation rejects a racing Session immediately without an RPC side effect", async () => {
  const { store, projects } = await fixture();
  const project = projects[0] as ProjectRecord;
  const turn = deferred<TurnStartResult>();
  const entered = deferred<void>();
  let server!: FakeAppServer;
  const runtime = new AgentRuntime({
    store,
    identity,
    pairing,
    support,
    appServerFactory: (callbacks) => {
      server = new FakeAppServer("epoch-1", callbacks);
      server.createThreadHook = async (target) => {
        const reservation = store.snapshot().projectReservations[target.id];
        assert.equal(reservation?.state, "starting");
        assert.equal(reservation?.appServerEpoch, server.appServerEpoch);
      };
      server.startTurnHook = async () => {
        entered.resolve();
        return turn.promise;
      };
      return server;
    },
  });
  runtime.setTransportGeneration(1);
  const { acks } = captureCallbacks(runtime);
  await runtime.initialize();
  const first = command(project, "attempt-1", "command-1", "session-1", "epoch-1");
  const second = command(project, "attempt-2", "command-2", "session-2", "epoch-1");
  const firstRun = runtime.handleCommand(first, 1);
  await entered.promise;
  await runtime.handleCommand(second, 1);
  assert.equal(server.createThreadCount, 1);
  assert.equal(server.startTurnCount, 1);
  assert.deepEqual(ackStates(acks, second.attemptId), ["claimed", "invalidated"]);
  assert.equal(
    (acks.find((ack) => ack.dispatchAttemptId === second.attemptId && ack.state === "invalidated")?.detail as { code?: unknown } | undefined)?.code,
    "PROJECT_BUSY",
  );
  turn.resolve({ nativeTurnId: "turn-1", status: "inProgress" });
  await firstRun;
  assert.equal(server.createThreadCount, 1, "the losing Session must not create an orphan thread");
  assert.equal(server.startTurnCount, 1);

  const afterActive = command(project, "attempt-3", "command-3", "session-3", "epoch-1");
  await runtime.handleCommand(afterActive, 1);
  assert.deepEqual(ackStates(acks, afterActive.attemptId), ["claimed", "invalidated"]);
  assert.equal(server.createThreadCount, 1, "active-turn rejection must happen before thread/start");
  assert.equal(server.startTurnCount, 1);
  assert.equal(store.snapshot().projectReservations[project.id], undefined);
  await runtime.shutdown();
});

test("detected external Codex activity blocks a remote turn before any App Server write", async (t) => {
  for (const executionState of ["running", "unknown"] as const) {
    await t.test(executionState, async () => {
      const { store, projects } = await fixture();
      const project = projects[0] as ProjectRecord;
      let server!: FakeAppServer;
      const runtime = new AgentRuntime({
        store,
        identity,
        pairing,
        support,
        appServerFactory: (callbacks) => {
          server = new FakeAppServer("epoch-1", callbacks);
          return server;
        },
      });
      runtime.setTransportGeneration(1);
      captureCallbacks(runtime);
      await runtime.initialize();
      await store.reconcileDiscoveredThreads(project.id, [{
        externalId: `external-${executionState}`,
        executionSegmentExternalId: `external-segment-${executionState}`,
        nativeThreadId: `native-external-${executionState}`,
        projectId: project.id,
        title: "Existing Codex work",
        archived: false,
        availability: "available",
        executionState,
        historyCompleteness: "unknown",
      }], server.appServerEpoch);

      const attempted = command(
        project,
        `attempt-external-${executionState}`,
        `command-external-${executionState}`,
        `session-external-${executionState}`,
        "epoch-1",
      );
      await runtime.handleCommand(attempted, 1);

      assert.equal(server.createThreadCount, 0);
      assert.equal(server.startTurnCount, 0);
      assert.equal(store.snapshot().commandJournal[attempted.commandId]?.state, "rejected");
      assert.deepEqual(store.snapshot().projectReservations, {});
      const rejection = store.snapshot().outbox.find(
        (event) =>
          event.type === "command.result" &&
          event.payload.commandId === attempted.commandId &&
          event.payload.state === "rejected",
      );
      assert.equal((rejection?.payload.detail as { code?: string } | undefined)?.code, "PROJECT_EXTERNAL_ACTIVITY");
      await runtime.shutdown();
    });
  }
});

for (const historyMode of ["legacy", "paginated"] as const) test(`an idle ${historyMode} host thread can be claimed, imported, and released for shared use`, async () => {
  const { store, projects } = await fixture();
  const project = projects[0] as ProjectRecord;
  const nativeThreadId = "thread-host-shared";
  let server!: FakeAppServer;
  const runtime = new AgentRuntime({
    store,
    identity,
    pairing,
    support,
    appServerFactory: (callbacks) => {
      server = new FakeAppServer("epoch-shared", callbacks);
      server.listThreadsHook = async () => [{
        nativeThreadId,
        cwd: project.root,
        title: "Host conversation",
        executionState: "idle",
        historyMode,
      }];
      server.histories.set(nativeThreadId, {
        nativeThreadId,
        cwd: project.root,
        historyMode,
        executionState: "idle",
        updatedAt: 1_777_777_777,
        items: [
          { nativeTurnId: "turn-host-1", nativeItemId: "item-user-1", item: { type: "userMessage", id: "item-user-1", content: [{ type: "text", text: "from host" }] } },
          { nativeTurnId: "turn-host-1", nativeItemId: "item-agent-1", item: { type: "agentMessage", id: "item-agent-1", text: "host reply" } },
        ],
      });
      return server;
    },
  });
  runtime.setTransportGeneration(1);
  const { acks } = captureCallbacks(runtime);
  await runtime.initialize();
  assert.equal(store.snapshot().discoveredThreads[nativeThreadId]?.projectId, project.id);

  const claim = claimCommand(project, nativeThreadId, "session-shared", server.appServerEpoch);
  await runtime.handleCommand(claim, 1);

  assert.equal(store.snapshot().commandJournal[claim.commandId]?.error, undefined);
  assert.deepEqual(ackStates(acks, claim.attemptId), ["claimed", "invoking", "responded", "applied"]);
  assert.equal(server.resumeCount, 1);
  assert.equal(server.unsubscribeCount, 1);
  const managed = store.snapshot().managedThreads[nativeThreadId];
  assert.equal(managed?.origin, "host_claimed");
  assert.equal(managed?.historyMode, historyMode);
  assert.equal(managed?.historyCursor, "item-agent-1");
  assert.equal(managed?.subscribed, false);
  assert.equal(store.snapshot().discoveredThreads[nativeThreadId], undefined);
  assert.equal(
    store.snapshot().outbox.filter((event) => event.type === "item.completed" && event.payload.synchronizedFromHost === true).length,
    2,
  );

  const release = releaseCommand(project, nativeThreadId, "session-shared", server.appServerEpoch);
  const unsubscribe = server.unsubscribeThread.bind(server);
  server.unsubscribeThread = async () => { throw new AgentError("THREAD_RELEASE_PENDING", "fixture writer still active"); };
  const blockedRelease = { ...release, commandId: "blocked-release", attemptId: "blocked-release" };
  await runtime.handleCommand(blockedRelease, 1);
  assert.equal(store.snapshot().commandJournal[blockedRelease.commandId]?.error?.code, "THREAD_RELEASE_PENDING");
  assert.ok(store.snapshot().managedThreads[nativeThreadId]);
  assert.equal(store.snapshot().outbox.some(event => event.type === "thread.released" && event.nativeThreadId === nativeThreadId), false);
  server.unsubscribeThread = unsubscribe;
  await runtime.handleCommand(release, 1);
  assert.equal(store.snapshot().commandJournal[release.commandId]?.error, undefined);
  assert.deepEqual(ackStates(acks, release.attemptId), ["claimed", "invoking", "responded", "applied"]);
  assert.equal(store.snapshot().managedThreads[nativeThreadId], undefined);
  assert.equal(
    store.snapshot().outbox.some((event) => event.type === "thread.released" && event.nativeThreadId === nativeThreadId),
    true,
  );
  assert.equal(server.unsubscribeCount, 2);
  const firstBinding = store.snapshot().nativeThreadBindings[nativeThreadId]!;
  assert.equal(firstBinding.managementRevision, 3);
  assert.equal(firstBinding.logicalSessionId, "session-shared");
  assert.equal(store.snapshot().discoveredThreads[nativeThreadId]?.externalId, "session-shared");
  assert.equal(store.snapshot().discoveredThreads[nativeThreadId]?.historyMode, historyMode);
  for (let index = 0; index < 10; index += 1) {
    await (runtime as unknown as { reconcileExistingThreads(): Promise<void> }).reconcileExistingThreads();
    assert.equal(store.snapshot().discoveredThreads[nativeThreadId]?.externalId, "session-shared");
    await runtime.handleCommand({ ...claim, commandId: `repeat-claim-${index}`, attemptId: `repeat-claim-${index}` }, 1);
    await runtime.handleCommand({ ...release, commandId: `repeat-release-${index}`, attemptId: `repeat-release-${index}` }, 1);
    assert.equal(store.snapshot().nativeThreadBindings[nativeThreadId]?.managementRevision, 5 + index * 2);
    assert.equal(store.snapshot().nativeThreadBindings[nativeThreadId]?.logicalSessionId, firstBinding.logicalSessionId);
  }
  const reopened = new StateStore(store.dataDir);
  await reopened.initialize();
  assert.equal(reopened.snapshot().nativeThreadBindings[nativeThreadId]?.managementRevision, 23);
  assert.equal(reopened.snapshot().managedThreads[nativeThreadId], undefined);
  reopened.close();
  await runtime.shutdown();
});

test("large claim imports release the writer first, yield to IO, and atomically checkpoint batches", async t => {
  const { store, projects } = await fixture();
  const project = projects[0]!;
  const nativeThreadId = "large-host-thread";
  let server!: FakeAppServer;
  const runtime = new AgentRuntime({ store, identity, pairing, support, appServerFactory: callbacks => {
    server = new FakeAppServer("epoch-large", callbacks);
    server.listThreadsHook = async () => [{ nativeThreadId, cwd: project.root, title: "Large", executionState: "idle", historyMode: "paginated" }];
    server.histories.set(nativeThreadId, { nativeThreadId, cwd: project.root, executionState: "idle", historyMode: "paginated", updatedAt: 1,
      items: Array.from({ length: 257 }, (_, index) => ({ nativeTurnId: "turn", nativeItemId: `item-${index}`,
        item: { type: "agentMessage", id: `item-${index}`, text: "history" } })) });
    return server;
  } });
  t.after(async () => { await runtime.shutdown(); store.close(); });
  runtime.setTransportGeneration(1);
  await runtime.initialize();
  const append = store.appendHistoryBatch.bind(store);
  let batches = 0;
  let ioRan = false;
  store.appendHistoryBatch = async (...args) => {
    assert.equal(server.unsubscribeCount, 1, "writer must be released before importing history");
    if (batches++ === 0) setImmediate(() => { ioRan = true; });
    else assert.equal(ioRan, true, "socket and timer callbacks must run between batches");
    const imported = await append(...args);
    assert.equal(store.snapshot().managedThreads[nativeThreadId]?.historyCursor, args[2]);
    return imported;
  };
  const claim = claimCommand(project, nativeThreadId, "large-session", server.appServerEpoch);
  await runtime.handleCommand(claim, 1);
  assert.equal(store.snapshot().commandJournal[claim.commandId]?.state, "applied");
  assert.equal(batches, 9);
  assert.equal(store.snapshot().outbox.filter(e => e.payload.synchronizedFromHost).length, 257);
  const thread = store.snapshot().managedThreads[nativeThreadId]!;
  const before = store.snapshot().outbox.length;
  await assert.rejects(append(nativeThreadId, [{ machineId: pairing.machineId, producerEpoch: runtime.producerEpoch,
    nativeThreadId, executionSegmentId: thread.executionSegmentId!, contentEpoch: 99, type: "item.completed", payload: {} }], "bad-cursor"));
  assert.equal(store.snapshot().outbox.length, before);
  assert.equal(store.snapshot().managedThreads[nativeThreadId]?.historyCursor, "item-256");
});

test("validated read-only discovery stays available without enabling writes", async () => {
  const { store, projects } = await fixture();
  const project = projects[0]!;
  const runtime = new AgentRuntime({ store, identity, pairing,
    support: { ...support, writable: false, supported: false, readable: true, readOnlyReasons: ["write sandbox not validated"] },
    appServerFactory: (callbacks) => {
      const server = new FakeAppServer("epoch-readonly", callbacks);
      server.listThreadsHook = async () => [{ nativeThreadId: "readable-thread", cwd: project.root, title: "existing", executionState: "idle" }];
      return server;
    },
  });
  await runtime.initialize();
  assert.ok(store.snapshot().discoveredThreads["readable-thread"]);
  assert.equal(runtime.isWritable(), false);
  assert.deepEqual((runtime.helloPayload().capabilities as { commandTypes: string[] }).commandTypes, []);
  await runtime.shutdown();
});

test("background discovery preserves a completed catalog but never conceals initial scans, failures or new epochs", async t => {
  const { store, projects } = await fixture();
  const threads: DiscoveredThreadSummary[] = [{ nativeThreadId: "background-thread", cwd: projects[0]!.root, title: "existing", executionState: "idle" }];
  let pending = deferred<DiscoveredThreadSummary[]>();
  let server!: FakeAppServer;
  let epoch = 0;
  const runtime = new AgentRuntime({ store, identity, pairing, support, appServerFactory: callbacks => {
    server = new FakeAppServer(`epoch-background-${++epoch}`, callbacks);
    server.listThreadsHook = () => pending.promise;
    return server;
  } });
  t.after(() => runtime.shutdown());
  const { registryChanges } = captureCallbacks(runtime);
  const initial = runtime.initialize();
  await waitFor(() => !!server && server.listCount === 1, "initial discovery did not start");
  assert.equal(runtime.getDiscoveryStatus().state, "scanning");
  assert.equal(runtime.getDiscoveryStatus().backgroundSync, false);
  pending.resolve(threads); await initial;
  const completed = runtime.getDiscoveryStatus();
  assert.equal(completed.state, "ready");
  assert.equal(completed.scannedPages, 1);
  pending = deferred();
  const refreshing = runtime.refreshCatalog();
  await waitFor(() => server.listCount === 2, "background discovery did not start");
  const inFlight = runtime.getDiscoveryStatus();
  assert.equal(runtime.readyForHealthCheck(), true, "A same-epoch background scan must not suppress a proven worker health acknowledgement");
  assert.equal(inFlight.state, "ready");
  assert.equal(inFlight.backgroundSync, true);
  assert.equal(inFlight.readiness, "ready");
  for (const key of ["scannedPages", "scannedCount", "discoveredSessions", "lastSuccessfulAt", "scanId"]) assert.equal(inFlight[key], completed[key]);
  pending.resolve(threads); await refreshing;
  assert.equal(runtime.getDiscoveryStatus().backgroundSync, false);
  server.listThreadsHook = async () => { throw new Error("scan unavailable"); };
  const beforeFailure = registryChanges.count;
  await assert.rejects(runtime.refreshCatalog(), { code: "CATALOG_REFRESH_FAILED" });
  assert.equal(runtime.getDiscoveryStatus().state, "error");
  assert.equal(runtime.getDiscoveryStatus().readiness, "action_required");
  assert.equal(runtime.readyForHealthCheck(), false, "A failed scan cannot validate an update");
  assert.ok(registryChanges.count > beforeFailure);
  pending = deferred(); server.listThreadsHook = () => pending.promise;
  const retry = runtime.refreshCatalog();
  assert.equal(runtime.getDiscoveryStatus().state, "scanning");
  assert.equal(runtime.getDiscoveryStatus().backgroundSync, false);
  pending.resolve(threads); await retry;
  pending = deferred();
  const reconnecting = runtime.reconnectRuntime();
  await waitFor(() => epoch === 2 && server.listCount === 1, "new epoch discovery did not start");
  assert.equal(runtime.readyForHealthCheck(), false, "A new runtime must complete its own initial scan");
  assert.equal(runtime.getDiscoveryStatus().state, "scanning");
  assert.equal(runtime.getDiscoveryStatus().backgroundSync, false);
  assert.equal(runtime.readyForHealthCheck(), false);
  pending.resolve(threads); await reconnecting;
  assert.equal(runtime.getDiscoveryStatus().state, "ready");
});

test("CLI file changes discover sessions and import shared history into the same binding; runtime events use index-only listing", async t => {
  const { store, projects } = await fixture(); const project = projects[0]!;
  const home = await mkdtemp(join(tmpdir(), "agentfleet-event-home-"));
  const day = join(home, "sessions/2026/09/06"); await mkdir(day, { recursive: true });
  const nativeThreadId = "event-shared-thread";
  await store.setManagedThread({ nativeThreadId, projectId: project.id,
    logicalSessionId: "same-cloud-session", executionSegmentId: "same-segment",
    appServerEpoch: "event-epoch", policyVersion: "remote-restricted-v1", policyVerified: false,
    contentEpoch: 1, createdAt: new Date().toISOString(), historySyncInitialized: true, historyItemCount: 0, subscribed: false });
  let server!: FakeAppServer; let indexOnly = false;
  let threads: DiscoveredThreadSummary[] = [];
  const runtime = new AgentRuntime({ store, identity, pairing, support, catalogHome: home,
    catalogSyncTiming: { debounceMs: 10, maxWaitMs: 30, minIntervalMs: 30 },
    appServerFactory: callbacks => {
      server = new FakeAppServer("event-epoch", callbacks);
      return Object.assign(server, { listThreadPage: async (_cursor: string | null, options?: { useStateDbOnly: boolean }) => {
        server.listCount++; indexOnly = options?.useStateDbOnly ?? false; return { threads, nextCursor: null };
      } });
    } });
  t.after(() => runtime.shutdown()); captureCallbacks(runtime); await runtime.initialize();
  assert.equal(runtime.getDiscoveryStatus().syncMode, "events");
  threads = [{ nativeThreadId: "new-cli-thread", cwd: project.root, title: "CLI-created", executionState: "idle", historyMode: "legacy" }];
  server.histories.set(nativeThreadId, { nativeThreadId, cwd: project.root, historyMode: "legacy", executionState: "idle", updatedAt: 1,
    items: [{ nativeTurnId: "host-turn", nativeItemId: "host-item", item: { id: "host-item", type: "agentMessage", text: "fixture reply" } }] });
  await writeFile(join(day, "rollout-fixture.jsonl"), "{}\n");
  await waitFor(() => !!store.snapshot().discoveredThreads["new-cli-thread"] && store.snapshot().managedThreads[nativeThreadId]?.historyCursor === "host-item", "file change did not import catalog and history");
  assert.equal(indexOnly, false);
  const imported = store.snapshot().outbox.filter(event => event.nativeItemId === "host-item");
  assert.equal(imported.length, 1);
  assert.equal(imported[0]?.logicalSessionId, "same-cloud-session");
  assert.equal(store.snapshot().managedThreads[nativeThreadId]?.nativeThreadId, nativeThreadId);
  const before = server.listCount;
  server.callbacks.onCatalogChanged?.("stale-epoch"); await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(server.listCount, before);
  server.callbacks.onCatalogChanged?.(server.appServerEpoch);
  await waitFor(() => server.listCount > before, "App Server notification did not refresh index");
  assert.equal(indexOnly, true);
  await waitFor(() => runtime.getDiscoveryStatus().backgroundSync === false, "sync incomplete");
  assert.equal(store.snapshot().outbox.filter(event => event.nativeItemId === "host-item").length, 1, "history not duplicated");
  assert.equal(server.resumeCount, 0, "watching must never take over or start a real session");
});

test("501 sessions discover incrementally without removing prior pages", async () => {
  const { store, projects } = await fixture();
  const project = projects[0]!;
  const runtime = new AgentRuntime({ store, identity, pairing, support,
    appServerFactory: (callbacks) => {
      const server = new FakeAppServer("epoch-pages", callbacks);
      return Object.assign(server, { listThreadPage: async (cursor: string | null) => {
        const start = Number(cursor ?? 0);
        const stop = Math.min(start + 100, 501);
        return { threads: Array.from({ length: stop - start }, (_, index) => ({ nativeThreadId: `paged-${start + index}`, cwd: project.root, title: "existing", executionState: "idle" as const })), nextCursor: stop === 501 ? null : String(stop) };
      } });
    },
  });
  await runtime.initialize();
  assert.equal(Object.keys(store.snapshot().discoveredThreads).length, 500);
  assert.equal(store.snapshot().projectDiscovery[project.id]?.state, "unavailable");
  await waitFor(() => Object.keys(store.snapshot().discoveredThreads).length === 501, "continuation did not discover session 501");
  assert.equal(store.snapshot().projectDiscovery[project.id]?.state, "healthy");
  assert.equal(store.snapshot().discoveredThreads["paged-0"]?.availability, "available");
  await runtime.shutdown();
});

test("shared history polling rotates beyond the first 25 managed sessions", async () => {
  const { store, projects } = await fixture();
  const project = projects[0]!;
  for (let index = 0; index < 30; index += 1) {
    await store.setManagedThread({ nativeThreadId: `history-${index}`, projectId: project.id,
      logicalSessionId: `history-session-${index}`, executionSegmentId: `history-segment-${index}`,
      appServerEpoch: "epoch-history", policyVersion: "remote-restricted-v1", policyVerified: false,
      contentEpoch: 1, createdAt: new Date().toISOString(), historySyncInitialized: true, subscribed: false,
    });
  }
  let server!: FakeAppServer;
  const runtime = new AgentRuntime({ store, identity, pairing, support,
    appServerFactory: (callbacks) => (server = new FakeAppServer("epoch-history", callbacks)),
  });
  await runtime.initialize();
  await (runtime as unknown as { reconcileExistingThreads(): Promise<void> }).reconcileExistingThreads();
  assert.equal(new Set(server.readIds).size, 30);
  await runtime.shutdown();
});

test("thread discovery is a current-epoch fail-closed Project write fence", async (t) => {
  await t.test("a successful empty scan permits a remote turn", async () => {
    const { store, projects } = await fixture();
    const project = projects[0] as ProjectRecord;
    let server!: FakeAppServer;
    const runtime = new AgentRuntime({
      store,
      identity,
      pairing,
      support,
      appServerFactory: (callbacks) => {
        server = new FakeAppServer("epoch-current", callbacks);
        return server;
      },
    });
    runtime.setTransportGeneration(1);
    captureCallbacks(runtime);
    await runtime.initialize();

    assert.equal(store.snapshot().projectDiscovery[project.id]?.state, "healthy");
    assert.equal(store.snapshot().projectDiscovery[project.id]?.appServerEpoch, server.appServerEpoch);
    const allowed = command(project, "attempt-discovery-ok", "command-discovery-ok", "session-discovery-ok", server.appServerEpoch);
    await runtime.handleCommand(allowed, 1);
    assert.equal(server.createThreadCount, 1);
    assert.equal(server.startTurnCount, 1);
    assert.equal(store.snapshot().commandJournal[allowed.commandId]?.state, "applied");
    await runtime.shutdown();
  });

  await t.test("a failed scan cannot reuse a healthy snapshot from an older epoch", async () => {
    const { store, projects } = await fixture();
    const project = projects[0] as ProjectRecord;
    await store.reconcileDiscoveredThreads(project.id, [], "epoch-old");
    const oldSuccess = store.snapshot().projectDiscovery[project.id]?.lastSuccessfulAt;
    let server!: FakeAppServer;
    const runtime = new AgentRuntime({
      store,
      identity,
      pairing,
      support,
      appServerFactory: (callbacks) => {
        server = new FakeAppServer("epoch-current", callbacks);
        server.listThreadsHook = async () => {
          throw new AgentError("APP_SERVER_RPC_ERROR", "thread/list failed");
        };
        return server;
      },
    });
    runtime.setTransportGeneration(1);
    const { acks } = captureCallbacks(runtime);
    await runtime.initialize();

    const discovery = store.snapshot().projectDiscovery[project.id];
    assert.equal(discovery?.state, "unavailable");
    assert.equal(discovery?.appServerEpoch, server.appServerEpoch);
    assert.equal(discovery?.lastSuccessfulAt, oldSuccess);
    const rejected = command(
      project,
      "attempt-discovery-failed",
      "command-discovery-failed",
      "session-discovery-failed",
      server.appServerEpoch,
    );
    await runtime.handleCommand(rejected, 1);

    assert.equal(server.createThreadCount, 0);
    assert.equal(server.startTurnCount, 0);
    assert.deepEqual(store.snapshot().projectReservations, {});
    assert.equal(store.snapshot().commandJournal[rejected.commandId]?.state, "rejected");
    assert.deepEqual(ackStates(acks, rejected.attemptId), ["claimed", "invalidated"]);
    assert.equal(
      (acks.find((ack) => ack.dispatchAttemptId === rejected.attemptId && ack.state === "invalidated")?.detail as { code?: unknown } | undefined)?.code,
      "PROJECT_DISCOVERY_UNAVAILABLE",
    );
    await runtime.shutdown();
  });
});

test("global Codex discovery registers projects outside the installer cwd and groups their sessions", async () => {
  const { directory, store, projects } = await fixture();
  const repository = join(directory, "other-workspace", "alpha");
  const nested = join(repository, "packages", "api");
  const scratch = join(directory, "scratch");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });
  await mkdir(scratch, { recursive: true });
  let server!: FakeAppServer;
  const runtime = new AgentRuntime({
    store,
    identity,
    pairing,
    support,
    appServerFactory: (callbacks) => {
      server = new FakeAppServer("epoch-global", callbacks);
      server.listThreadsHook = async () => [
        { nativeThreadId: "thread-alpha-root", cwd: repository, title: "Alpha root", executionState: "idle" },
        { nativeThreadId: "thread-alpha-nested", cwd: nested, title: "Alpha API", executionState: "running" },
        { nativeThreadId: "thread-scratch", cwd: scratch, title: "Scratch", executionState: "idle" },
      ];
      return server;
    },
  });
  captureCallbacks(runtime);
  await runtime.initialize();

  const state = store.snapshot();
  const alpha = state.projects.find((project) => project.root === repository);
  const expectedScratch = await discoverProjectFromCwd(scratch, state.projects);
  const scratchProject = state.projects.find((project) => project.root === expectedScratch.root);
  assert.ok(alpha);
  assert.ok(scratchProject);
  assert.equal(state.projects.length, projects.length + 2, "installer cwd is a seed, not a discovery boundary");
  assert.equal(state.discoveredThreads["thread-alpha-root"]?.projectId, alpha.id);
  assert.equal(state.discoveredThreads["thread-alpha-nested"]?.projectId, alpha.id);
  assert.equal(state.discoveredThreads["thread-scratch"]?.projectId, scratchProject.id);
  const hello = runtime.helloPayload() as { projects: Array<{ externalId: string }>; sessions: Array<{ projectExternalId: string }> };
  assert.ok(hello.projects.some((project) => project.externalId === alpha.id));
  assert.equal(hello.sessions.filter((session) => session.projectExternalId === alpha.id).length, 2);
  assert.equal(server.listCount, 1, "discovery must use one global thread/list scan");
  await runtime.shutdown();
});

test("different projects are not globally serialized", async () => {
  const { store, projects } = await fixture(2);
  const firstProject = projects[0] as ProjectRecord;
  const secondProject = projects[1] as ProjectRecord;
  const bothEntered = deferred<void>();
  const turns = new Map<string, Deferred<TurnStartResult>>();
  let entries = 0;
  let server!: FakeAppServer;
  const runtime = new AgentRuntime({
    store,
    identity,
    pairing,
    support,
    appServerFactory: (callbacks) => {
      server = new FakeAppServer("epoch-1", callbacks);
      server.startTurnHook = async (_thread, project) => {
        const pending = deferred<TurnStartResult>();
        turns.set(project.id, pending);
        entries += 1;
        if (entries === 2) bothEntered.resolve();
        return pending.promise;
      };
      return server;
    },
  });
  runtime.setTransportGeneration(1);
  captureCallbacks(runtime);
  await runtime.initialize();
  const firstRun = runtime.handleCommand(command(firstProject, "attempt-1", "command-1", "session-1", "epoch-1"), 1);
  const secondRun = runtime.handleCommand(command(secondProject, "attempt-2", "command-2", "session-2", "epoch-1"), 1);
  await Promise.race([
    bothEntered.promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("commands were globally serialized")), 1_000)),
  ]);
  turns.get(firstProject.id)?.resolve({ nativeTurnId: "turn-1", status: "inProgress" });
  turns.get(secondProject.id)?.resolve({ nativeTurnId: "turn-2", status: "inProgress" });
  await Promise.all([firstRun, secondRun]);
  assert.equal(server.startTurnCount, 2);
  await runtime.shutdown();
});

test("a completion notification preceding turn/start response cannot resurrect an active turn", async () => {
  const { store, projects } = await fixture();
  const project = projects[0] as ProjectRecord;
  let server!: FakeAppServer;
  const runtime = new AgentRuntime({
    store,
    identity,
    pairing,
    support,
    appServerFactory: (callbacks) => {
      server = new FakeAppServer("epoch-1", callbacks);
      server.startTurnHook = async (thread) => {
        await server.callbacks.onEvent(
          {
            type: "turn.completed",
            nativeThreadId: thread.nativeThreadId,
            nativeTurnId: "turn-early",
            payload: { turn: { id: "turn-early", status: "completed" } },
          },
          server.appServerEpoch,
        );
        return { nativeTurnId: "turn-early", status: "inProgress" };
      };
      return server;
    },
  });
  runtime.setTransportGeneration(1);
  captureCallbacks(runtime);
  await runtime.initialize();
  await runtime.handleCommand(command(project, "attempt-1", "command-1", "session-1", "epoch-1"), 1);
  const thread = Object.values(store.snapshot().managedThreads)[0];
  assert.equal(thread?.activeTurnId, undefined);
  assert.equal(thread?.lastTurnId, "turn-early");
  assert.equal(thread?.lastTurnStatus, "completed");
  assert.equal(
    store.snapshot().outbox.some((event) => event.type === "turn.started" && event.nativeTurnId === "turn-early"),
    false,
  );
  const appliedProof = store.snapshot().outbox.find(
    (event) => event.type === "command.result" && event.payload.commandId === "command-1" && event.payload.state === "applied",
  );
  assert.ok(appliedProof);
  assert.equal(appliedProof.appServerEpoch, "epoch-1");
  assert.equal(appliedProof.payload.commandType, "turn.start");
  assert.deepEqual(appliedProof.payload.detail, {
    nativeThreadId: thread?.nativeThreadId,
    nativeTurnId: "turn-early",
    status: "completed",
  });
  await runtime.shutdown();
});

test("a fresh App Server epoch safely resumes an idle thread but cannot cancel an old turn", async () => {
  const { store, projects } = await fixture();
  const project = projects[0] as ProjectRecord;
  const oldThread: ManagedThread = {
    nativeThreadId: "thread-old",
    projectId: project.id,
    logicalSessionId: "session-old",
    executionSegmentId: "segment-session-old",
    appServerEpoch: "epoch-old",
    policyVersion: "remote-restricted-v1",
    policyVerified: true,
    contentEpoch: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  await store.setManagedThread(oldThread);
  let server!: FakeAppServer;
  const runtime = new AgentRuntime({
    store,
    identity,
    pairing,
    support,
    appServerFactory: (callbacks) => {
      server = new FakeAppServer("epoch-new", callbacks);
      return server;
    },
  });
  runtime.setTransportGeneration(1);
  const { acks } = captureCallbacks(runtime);
  await runtime.initialize();

  const subsequent = command(project, "attempt-1", "command-1", "session-old", "epoch-new");
  await runtime.handleCommand(subsequent, 1);
  assert.deepEqual(ackStates(acks, subsequent.attemptId), ["claimed", "invoking", "responded", "applied"]);
  assert.equal(server.createThreadCount, 0);
  assert.equal(server.resumeCount, 1);
  assert.equal(server.startTurnCount, 1);

  await store.updateManagedThread(oldThread.nativeThreadId, (thread) => {
    thread.appServerEpoch = "epoch-old";
    thread.activeTurnId = "turn-old";
    thread.lastTurnId = "turn-old";
    thread.lastTurnStatus = "inProgress";
  });
  const cancel: FleetCommand = {
    ...command(project, "attempt-2", "command-2", "session-old", "epoch-new"),
    type: "turn.cancel",
    payload: {},
    precondition: { nativeTurnId: "turn-old", turnControlVersion: 1 },
  };
  await runtime.handleCommand(cancel, 1);
  assert.deepEqual(ackStates(acks, cancel.attemptId), ["claimed", "invalidated"]);
  assert.equal(
    (acks.find((ack) => ack.dispatchAttemptId === cancel.attemptId && ack.state === "invalidated")?.detail as { code?: unknown } | undefined)?.code,
    "THREAD_READ_ONLY",
  );
  assert.equal(server.interruptTurnCount, 0);
  await runtime.shutdown();
});

test("Steer targets only the exact active turn and emits an auditable result", async () => {
  const { store, projects } = await fixture();
  const project = projects[0] as ProjectRecord;
  let server!: FakeAppServer;
  const runtime = new AgentRuntime({
    store,
    identity,
    pairing,
    support,
    appServerFactory: (callbacks) => (server = new FakeAppServer("epoch-steer", callbacks)),
  });
  runtime.setTransportGeneration(1);
  const { acks } = captureCallbacks(runtime);
  await runtime.initialize();
  await runtime.handleCommand(command(project, "attempt-start", "command-start", "session-steer", "epoch-steer"), 1);
  const thread = Object.values(store.snapshot().managedThreads)[0];
  assert.ok(thread?.activeTurnId);
  const steer: FleetCommand = {
    ...command(project, "attempt-steer", "command-steer", "session-steer", "epoch-steer"),
    type: "turn.steer",
    payload: { prompt: "incorporate this constraint" },
    precondition: { nativeTurnId: thread.activeTurnId, turnControlVersion: 1 },
  };
  await runtime.handleCommand(steer, 1);
  assert.equal(server.steerTurnCount, 1);
  assert.deepEqual(ackStates(acks, steer.attemptId), ["claimed", "invoking", "responded", "applied"]);
  assert.ok(store.snapshot().outbox.some((event) => event.type === "turn.steered" && event.nativeTurnId === thread.activeTurnId));
  await runtime.shutdown();
});

test("uncertain invocation remains fenced across retry and App Server restart", async () => {
  const { store, projects } = await fixture();
  const project = projects[0] as ProjectRecord;
  const servers: FakeAppServer[] = [];
  const factory: AppServerFactory = (callbacks) => {
    const server = new FakeAppServer(`epoch-${servers.length + 1}`, callbacks);
    if (servers.length === 0) {
      server.startTurnHook = async () => {
        throw new AgentError("APP_SERVER_TIMEOUT", "turn/start outcome is uncertain");
      };
    }
    servers.push(server);
    return server;
  };
  const runtime = new AgentRuntime({
    store,
    identity,
    pairing,
    support,
    appServerFactory: factory,
    restartSleep: async () => undefined,
  });
  runtime.setTransportGeneration(1);
  const { acks } = captureCallbacks(runtime);
  await runtime.initialize();
  const first = command(project, "attempt-1", "command-1", "session-1", "epoch-1");
  await runtime.handleCommand(first, 1);
  assert.equal(store.snapshot().commandJournal[first.commandId]?.state, "unknown");
  assert.equal(store.snapshot().projectReservations[project.id]?.state, "unknown");
  assert.equal(servers[0]?.startTurnCount, 1);

  const retry = { ...first, attemptId: "attempt-2" };
  await runtime.handleCommand(retry, 1);
  assert.deepEqual(ackStates(acks, retry.attemptId), ["claimed", "unknown"]);
  assert.equal(servers[0]?.startTurnCount, 1);

  const unrelated = command(project, "attempt-3", "command-2", "session-2", "epoch-1");
  await runtime.handleCommand(unrelated, 1);
  assert.deepEqual(ackStates(acks, unrelated.attemptId), ["claimed", "invalidated"]);
  assert.equal(servers[0]?.createThreadCount, 1);

  await servers[0]?.exit();
  await waitFor(() => runtime.getAppServerEpoch() === "epoch-2", "App Server did not restart");
  assert.equal(store.snapshot().projectReservations[project.id]?.state, "unknown");
  const afterRestart = command(project, "attempt-4", "command-3", "session-3", "epoch-2");
  await runtime.handleCommand(afterRestart, 1);
  assert.deepEqual(ackStates(acks, afterRestart.attemptId), ["claimed", "invalidated"]);
  assert.equal(servers[1]?.createThreadCount, 0);
  await runtime.shutdown();
});

test("App Server restart supervisor is single-flight with capped exponential delays and discovery", async () => {
  const { store } = await fixture();
  const servers: FakeAppServer[] = [];
  const delays: number[] = [];
  const runtime = new AgentRuntime({
    store,
    identity,
    pairing,
    support,
    appServerFactory: (callbacks) => {
      const index = servers.length + 1;
      const server = new FakeAppServer(
        `epoch-${index}`,
        callbacks,
        index === 2 ? new AgentError("APP_SERVER_UNAVAILABLE", "restart failed") : undefined,
      );
      servers.push(server);
      return server;
    },
    restartSleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });
  const { registryChanges } = captureCallbacks(runtime);
  await runtime.initialize();
  await Promise.all([servers[0]?.exit() ?? Promise.resolve(), servers[0]?.exit("duplicate exit") ?? Promise.resolve()]);
  await waitFor(() => runtime.getAppServerEpoch() === "epoch-3", "restart supervisor did not recover");
  assert.equal(servers.length, 3, "duplicate exits must not create duplicate restart loops");
  assert.deepEqual(delays, [500, 1_000]);
  assert.equal(servers[2]?.listCount, 1, "fresh epoch must run discovery/reconciliation");
  assert.ok(registryChanges.count >= 2, "exit and successful restart must both refresh registry hello");
  await servers[0]?.exit("stale exit");
  assert.equal(servers.length, 3);
  assert.equal(appServerRestartDelay(1), 500);
  assert.equal(appServerRestartDelay(100), 30_000);
  await runtime.shutdown();
});

test("restart supervision survives exits during reconciliation and during its success callback", async () => {
  const { store } = await fixture();
  const servers: FakeAppServer[] = [];
  const delays: number[] = [];
  let exitDuringSuccessCallback = false;
  const runtime = new AgentRuntime({
    store,
    identity,
    pairing,
    support,
    appServerFactory: (callbacks) => {
      const index = servers.length + 1;
      const server = new FakeAppServer(`epoch-${index}`, callbacks);
      if (index === 2) {
        server.listThreadsHook = async () => {
          await server.exit("exit during reconciliation");
          return [];
        };
      }
      servers.push(server);
      return server;
    },
    restartSleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });
  runtime.setCallbacks({
    onOutboxChanged: () => undefined,
    onVolatile: () => undefined,
    onCommandAck: () => undefined,
    onRegistryChanged: () => {
      if (runtime.getAppServerEpoch() === "epoch-3" && !exitDuringSuccessCallback) {
        exitDuringSuccessCallback = true;
        void servers[2]?.exit("exit during supervisor success callback");
      }
    },
  });
  await runtime.initialize();
  await servers[0]?.exit();
  await waitFor(() => runtime.getAppServerEpoch() === "epoch-4", "restart supervision was lost during recovery");
  assert.equal(servers.length, 4);
  assert.deepEqual(delays, [500, 1_000, 500]);
  assert.equal(servers[1]?.listCount, 1);
  assert.equal(servers[3]?.listCount, 1);
  await runtime.shutdown();
});

test("shutdown aborts a pending App Server restart", async () => {
  const { store } = await fixture();
  const servers: FakeAppServer[] = [];
  const sleeping = deferred<void>();
  let restartSignal: AbortSignal | undefined;
  const runtime = new AgentRuntime({
    store,
    identity,
    pairing,
    support,
    appServerFactory: (callbacks) => {
      const server = new FakeAppServer(`epoch-${servers.length + 1}`, callbacks);
      servers.push(server);
      return server;
    },
    restartSleep: async (_milliseconds, signal) => {
      restartSignal = signal;
      sleeping.resolve();
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    },
  });
  captureCallbacks(runtime);
  await runtime.initialize();
  await servers[0]?.exit();
  await sleeping.promise;
  await runtime.shutdown();
  assert.equal(restartSignal?.aborted, true);
  assert.equal(servers.length, 1, "shutdown must not create a replacement App Server");
});

test("sending immediately after a rename resumes the same thread after writer release", async t => {
  const { store, projects } = await fixture(); const project = projects[0]!;
  let server!: FakeAppServer;
  const runtime = new AgentRuntime({ store, identity, pairing, support, appServerFactory: cb => (server = new FakeAppServer("epoch-rename-release", cb)) });
  runtime.setTransportGeneration(1); captureCallbacks(runtime); await runtime.initialize(); t.after(() => runtime.shutdown());
  const nativeThreadId = "original-thread";
  await store.setManagedThread({ nativeThreadId, projectId: project.id, logicalSessionId: "session-rename", executionSegmentId: "segment-session-rename", appServerEpoch: server.appServerEpoch, policyVerified: true, subscribed: true, policyVersion: "remote-restricted-v1", contentEpoch: 1, createdAt: new Date().toISOString(), sessionCwd: project.root });
  server.histories.set(nativeThreadId, { nativeThreadId, cwd: project.root, historyMode: "legacy", executionState: "idle", updatedAt: 1, items: [] });
  const base = command(project, "rename-before-send", "rename-before-send", "session-rename", server.appServerEpoch);
  await runtime.handleCommand({ ...base, type: "thread.rename", payload: { name: "New name" }, precondition: { nativeThreadId, expectedActiveTurnId: null, projectLeaseVersion: project.identityVersion } }, 1);
  await runtime.handleCommand(command(project, "send-after-rename", "send-after-rename", "session-rename", server.appServerEpoch), 1);
  assert.equal(server.resumeCount, 1, "The disposed writer cannot be reused");
  assert.equal(server.createThreadCount, 0);
  assert.equal(server.startTurnCount, 1);
  assert.equal(store.snapshot().managedThreads[nativeThreadId]?.logicalSessionId, "session-rename");
});

for (const mode of ["interrupted", "completed", "failed", "inProgress", "missing", "wrong-cwd", "changed-turn"] as const) test(`restart recovery requires exact persisted terminal evidence: ${mode}`, async t => {
  const { store, projects } = await fixture(); const project = projects[0]!;
  const old: ManagedThread = { nativeThreadId:"reboot-native", logicalSessionId:"reboot-session", executionSegmentId:"reboot-segment", projectId:project.id, sessionCwd:project.root, appServerEpoch:"old-runtime", policyVersion:"remote-restricted-v1", policyVerified:true, contentEpoch:1, createdAt:"2026-09-08T00:00:00Z", activeTurnId:"old-turn", lastTurnId:"old-turn", lastTurnStatus:"inProgress" };
  await store.setManagedThread(old);
  let reads = 0;
  const runtime = new AgentRuntime({store,identity,pairing,support,appServerFactory:cb=>Object.assign(new FakeAppServer("new-runtime",cb), {
    readTurnOutcome:async(id:string,turnId:string)=>{
      reads++; assert.equal(id,old.nativeThreadId); assert.equal(turnId,old.activeTurnId);
      if(mode==="changed-turn") await store.updateManagedThread(id,t=>{t.activeTurnId="new-turn";});
      return mode==="missing"?null:{cwd:mode==="wrong-cwd"?"/wrong":project.root,status:mode==="changed-turn"?"completed":mode};
    }
  })});
  captureCallbacks(runtime); await runtime.initialize(); t.after(()=>runtime.shutdown());
  assert.equal(reads,0,"Startup must preserve the freeze without user action");
  await runtime.refreshCatalog(); assert.equal(reads,0,"Catalog refresh must not unfreeze");
  await runtime.recoverFrozenSession({appServerEpoch:"new-runtime",nativeThreadId:old.nativeThreadId,logicalSessionId:old.logicalSessionId,executionSegmentId:old.executionSegmentId,contentEpoch:old.contentEpoch});
  assert.equal(reads,1);
  const recovered=["interrupted","completed","failed"].includes(mode);
  const thread=store.snapshot().managedThreads[old.nativeThreadId]!;
  assert.equal(thread.activeTurnId,recovered?undefined:mode==="changed-turn"?"new-turn":"old-turn");
  const events=store.snapshot().outbox.filter(e=>e.payload.recoveredFromHost===true);
  assert.equal(events.length,recovered?1:0);
  if(recovered){assert.equal(thread.lastTurnStatus,mode);assert.equal(thread.policyVerified,false);assert.equal(events[0]?.nativeTurnId,"old-turn");}
  assert.equal(Object.keys(store.snapshot().commandJournal).length,0,"Recovery never creates or replays a command");
});

test("paged history bounds each pass, checkpoints across reopen and deduplicates live or repeated tail items", async t => {
  const {store,projects}=await fixture();const project=projects[0]!;const id="paged-host";
  const reads:(string|null)[]=[];let server!:FakeAppServer;
  const items=Array.from({length:620},(_,i)=>({nativeTurnId:"original-turn",nativeItemId:`page-item-${i}`,item:{id:`page-item-${i}`,type:"agentMessage",text:`history ${i}`}}));
  const runtime=new AgentRuntime({store,identity,pairing,support,appServerFactory:callbacks=>{
    server=new FakeAppServer("epoch-pages",callbacks);
    server.listThreadsHook=async()=>[{nativeThreadId:id,cwd:project.root,title:"Paged",executionState:"idle",historyMode:"paginated"}];
    server.histories.set(id,{nativeThreadId:id,cwd:project.root,executionState:"idle",historyMode:"paginated",updatedAt:1,items:[],paged:true});
    return Object.assign(server,{readHistoryPage:async (_id:string,cursor:string|null)=>{
      reads.push(cursor);const offset=Number(cursor??0);return {items:items.slice(offset,offset+100),nextCursor:offset+100<items.length?String(offset+100):null};
    }});
  }});
  t.after(async()=>{await runtime.shutdown();store.close();});runtime.setTransportGeneration(1);await runtime.initialize();
  const claim=claimCommand(project,id,"paged-session",server.appServerEpoch);await runtime.handleCommand(claim,1);
  assert.equal(store.snapshot().commandJournal[claim.commandId]?.state,"applied");
  assert.equal(reads.length,5);assert.equal(store.snapshot().managedThreads[id]?.historyPage?.cursor,"500");
  const reopen=new StateStore(store.dataDir);await reopen.initialize();
  assert.equal(reopen.snapshot().managedThreads[id]?.historyPage?.cursor,"500");reopen.close();
  const thread=store.snapshot().managedThreads[id]!;
  await store.appendEvent({machineId:pairing.machineId,producerEpoch:runtime.producerEpoch,nativeThreadId:id,nativeTurnId:"original-turn",nativeItemId:"page-item-619",executionSegmentId:thread.executionSegmentId!,logicalSessionId:thread.logicalSessionId!,contentEpoch:1,type:"item.completed",payload:{item:items[619]!.item}});
  await (runtime as unknown as {reconcileExistingThreads():Promise<void>}).reconcileExistingThreads();
  const completed=store.snapshot();assert.equal(completed.managedThreads[id]?.historyPage?.complete,true);
  assert.equal(completed.outbox.filter(e=>e.type==="item.completed").length,620);
  await (runtime as unknown as {reconcileExistingThreads():Promise<void>}).reconcileExistingThreads();
  assert.equal(store.snapshot().outbox.filter(e=>e.type==="item.completed").length,620,"tail rereads cannot duplicate durable items");
  assert.equal(reads.at(-1),"600","incremental read resumes at bounded tail page");
});

for (const mode of ["skip-existing","legacy-anchor"] as const) test(`paged baseline never reimports skipped prefixes: ${mode}`,async t=>{
 const {store,projects}=await fixture();const project=projects[0]!;const id="baseline-pages";
 const items=Array.from({length:220},(_,i)=>({nativeTurnId:"turn",nativeItemId:`item-${i}`,item:{id:`item-${i}`,type:"agentMessage",text:`history ${i}`}}));
 const runtime=new AgentRuntime({store,identity,pairing,support,appServerFactory:callbacks=>Object.assign(new FakeAppServer("baseline-epoch",callbacks),{readHistoryPage:async(_id:string,cursor:string|null)=>{
   const offset=Number(cursor??0);return {items:items.slice(offset,offset+100),nextCursor:offset+100<items.length?String(offset+100):null};
 }})});
 t.after(async()=>{await runtime.shutdown();store.close();});await runtime.initialize();
 await store.setManagedThread({nativeThreadId:id,projectId:project.id,logicalSessionId:"baseline-session",executionSegmentId:"baseline-segment",appServerEpoch:"baseline-epoch",policyVersion:"remote-restricted-v1",policyVerified:false,contentEpoch:1,createdAt:new Date().toISOString(),...(mode==="legacy-anchor"?{historySyncInitialized:true,historyCursor:"item-215"}:{})});
 const sync=async()=>{const thread=store.snapshot().managedThreads[id]!;return (runtime as unknown as {syncPagedHistory(t:typeof thread,existing:boolean):Promise<number>}).syncPagedHistory(thread,false);};
 await sync();await sync();
 assert.equal(store.snapshot().outbox.filter(e=>e.type==="item.completed").length,mode==="legacy-anchor"?4:0);
 items.push({nativeTurnId:"turn",nativeItemId:"item-new",item:{id:"item-new",type:"agentMessage",text:"New host message"}});
 await sync();await sync();
 const events=store.snapshot().outbox.filter(e=>e.type==="item.completed");
 assert.equal(events.length,mode==="legacy-anchor"?5:1);assert.equal(events.filter(e=>e.nativeItemId==="item-new").length,1);
});

test("heartbeats relay cached quota without querying Codex; explicit host refresh queries once",async t=>{
 const {store}=await fixture(0);let reads=0;const snapshot={observedAt:"2026-09-10T00:00:00Z",windows:[]};
 const runtime=new AgentRuntime({store,identity,pairing,support,appServerFactory:callbacks=>Object.assign(new FakeAppServer("quota-epoch",callbacks),{refreshQuota:async()=>{reads++;},getQuotaSnapshot:()=>snapshot})});
 t.after(()=>runtime.shutdown());await runtime.initialize();
 for(let i=0;i<20;i++)assert.equal(runtime.heartbeatPayload().quota,snapshot);
 assert.equal(reads,0);await runtime.refreshCatalog();assert.equal(reads,1);
});
