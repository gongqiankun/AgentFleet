import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineIdentity } from "../src/identity.js";
import { captureReconciliationStreams, RelayConnection } from "../src/relay.js";
import type { AgentRuntime, RuntimeCallbacks } from "../src/runtime.js";
import { selectDurableStreams } from "../src/stream-selection.js";
import { StateStore } from "../src/store.js";
import type { PairingCredential, ProjectRecord } from "../src/types.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeSocket {
  readyState: number = WebSocket.OPEN;
  readonly sent: Record<string, unknown>[] = [];
  closeCode: number | undefined;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number): void {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException("invalid code", "InvalidAccessError");
    }
    this.closeCode = code;
    this.readyState = WebSocket.CLOSED;
  }
}

class FakeRuntime {
  readonly producerEpoch = "producer-current";
  readonly commandCalls: Array<{ command: Record<string, unknown>; generation: number }> = [];
  callbacks: RuntimeCallbacks | undefined;
  appServerEpoch = "app-current";
  handleCommandHook: ((command: Record<string, unknown>, generation: number) => Promise<void>) | undefined;

  setCallbacks(callbacks: RuntimeCallbacks): void {
    this.callbacks = callbacks;
  }

  setTransportGeneration(_generation: number | undefined): void {}

  getAppServerEpoch(): string | undefined {
    return this.appServerEpoch;
  }

  helloPayload(): Record<string, unknown> {
    return {
      type: "hello",
      producerEpoch: this.producerEpoch,
      appServerEpoch: this.appServerEpoch,
      machineId: "machine-1",
      projects: [],
      sessions: [],
    };
  }

  heartbeatPayload(): Record<string, unknown> {
    return { type: "heartbeat", capacity: "idle", activeTurns: 0 };
  }

  async advanceContentEpoch(_logicalSessionId: string, _contentEpoch: number): Promise<void> {}

  async handleCommand(command: Record<string, unknown>, generation: number): Promise<void> {
    this.commandCalls.push({ command, generation });
    await this.handleCommandHook?.(command, generation);
  }
}

interface RelayAccess {
  socket: WebSocket | undefined;
  generation: number | undefined;
  inboundTail: Promise<void>;
  commandTail: Promise<void>;
  acknowledgementTask: Promise<void> | undefined;
  reconciliationReady: boolean;
  beginHelloCycle(): void;
  enqueueInbound(event: MessageEvent, sourceSocket: WebSocket): void;
}

const identity: MachineIdentity = {
  metadata: {
    algorithm: "Ed25519",
    publicKey: "test-key",
    fingerprint: "SHA256:test",
    verificationPhrase: "test-phrase",
    credentialProtectionLevel: "software_protected",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  sign: () => "signature",
};

const pairing: PairingCredential = {
  controlPlaneUrl: "https://fleet.invalid",
  machineId: "machine-1",
  agentToken: "token",
  pairedAt: "2026-01-01T00:00:00.000Z",
  machineName: "test-machine",
};

function frame(value: Record<string, unknown>): MessageEvent {
  return { data: JSON.stringify(value) } as MessageEvent;
}

test("maintenance reports wait for reconciliation and can be replayed once ready", async () => {
  const { store, relay, socket, access } = await setup();
  try {
    const result = { operationId: "self-check", state: "succeeded" };
    relay.reportMaintenance(result);
    assert.equal(socket.sent.length, 0);
    access.reconciliationReady = true;
    relay.reportMaintenance(result);
    assert.deepEqual(socket.sent, [{ type: "maintenance.result", ...result }]);
  } finally { store.close(); }
});

function offer(dispatchAttemptId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "command.offer",
    dispatchAttemptId,
    transportGeneration: 7,
    producerEpoch: "producer-current",
    appServerEpoch: "app-current",
    command: {
      commandId: `command-${dispatchAttemptId}`,
      type: "turn.start",
      projectExternalId: "project-local",
    },
    ...overrides,
  };
}

async function setup(): Promise<{
  store: StateStore;
  runtime: FakeRuntime;
  socket: FakeSocket;
  relay: RelayConnection;
  access: RelayAccess;
}> {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-relay-test-"));
  const store = new StateStore(directory);
  await store.initialize();
  await store.beginProducerEpoch("producer-current");
  const project: ProjectRecord = {
    id: "project-local",
    alias: "project",
    root: directory,
    device: "1",
    inode: "1",
    identityVersion: 1,
    addedAt: "2026-01-01T00:00:00.000Z",
  };
  await store.addProject(project);
  const runtime = new FakeRuntime();
  const relay = new RelayConnection({
    runtime: runtime as unknown as AgentRuntime,
    store,
    identity,
    pairing,
    requestedUrl: "https://fleet.invalid",
    logger: { info: () => undefined, warn: () => undefined },
  });
  const socket = new FakeSocket();
  const access = relay as unknown as RelayAccess;
  access.socket = socket as unknown as WebSocket;
  access.generation = 7;
  return { store, runtime, socket, relay, access };
}

async function enqueue(access: RelayAccess, socket: FakeSocket, value: Record<string, unknown>): Promise<void> {
  access.enqueueInbound(frame(value), socket as unknown as WebSocket);
  await access.inboundTail;
  await access.acknowledgementTask;
}

test("maintenance acknowledgements are informational and never execute commands or close the connection", async (t) => {
  const { store, runtime, socket, access } = await setup();
  t.after(() => store.close());
  await enqueue(access, socket, { type: "maintenance.ack", operationId: "op-test", state: "succeeded" });
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.equal(socket.closeCode, undefined);
  assert.equal(access.reconciliationReady, false, "acknowledgements cannot grant command admission");
  assert.equal(runtime.commandCalls.length, 0);
});

test("unknown or invalid frames close with a WHATWG-compatible code without rejecting the inbound queue", async (t) => {
  for (const data of [JSON.stringify({ type: "shell", command: "must not run" }), "invalid JSON", JSON.stringify({ type: "welcome", transportGeneration: 99 })]) {
    const { store, runtime, socket, access } = await setup();
    t.after(() => store.close());
    access.enqueueInbound({ data } as MessageEvent, socket as unknown as WebSocket);
    await assert.doesNotReject(access.inboundTail);
    assert.equal(socket.closeCode, 4008);
    assert.equal(runtime.commandCalls.length, 0);
  }
});

test("a failed socket send or close never crashes the maintenance reporter", async (t) => {
  const { store, socket, relay, access } = await setup();
  access.reconciliationReady = true;
  t.after(() => store.close());
  socket.send = () => { throw new Error("transport lost"); };
  assert.doesNotThrow(() => relay.reportMaintenance({ operationId: "op-test", state: "running" }));
  assert.equal(socket.closeCode, 4011);
  socket.readyState = WebSocket.OPEN;
  socket.close = () => { throw new Error("transport unavailable"); };
  assert.doesNotThrow(() => relay.reportMaintenance({ operationId: "op-test", state: "running" }));
});

test("an asynchronous frame handler failure closes safely instead of rejecting its error handler", async (t) => {
  const { store, runtime, socket, access } = await setup();
  t.after(() => store.close());
  runtime.advanceContentEpoch = async () => { throw new Error("state write failed"); };
  await assert.doesNotReject(enqueue(access, socket, { type: "content.epoch", logicalSessionId: "session", contentEpoch: 2 }));
  assert.equal(socket.closeCode, 4011);
  assert.equal(runtime.commandCalls.length, 0);
});

test("reconciliation drains the captured watermarks before commands are enabled", async () => {
  const { store, runtime, socket, access } = await setup();
  const first = await store.appendEvent({
    machineId: "machine-1",
    producerEpoch: "producer-current",
    projectId: "project-local",
    type: "command.result",
    payload: { sequence: 1 },
  });
  const second = await store.appendEvent({
    machineId: "machine-1",
    producerEpoch: "producer-current",
    projectId: "project-local",
    type: "command.result",
    payload: { sequence: 2 },
  });

  access.beginHelloCycle();
  assert.deepEqual(socket.sent[0]?.reconciliationStreams, [
    { producerEpoch: "producer-current", throughHostSeq: 2 },
  ]);

  await enqueue(access, socket, offer("attempt-before-hello"));
  assert.equal(runtime.commandCalls.length, 0);
  assert.equal(
    (socket.sent.at(-1)?.detail as { code?: unknown } | undefined)?.code,
    "RECONCILIATION_INCOMPLETE",
  );

  const afterWatermark = await store.appendEvent({
    machineId: "machine-1",
    producerEpoch: "producer-current",
    projectId: "project-local",
    type: "command.result",
    payload: { sequence: 3 },
  });
  await enqueue(access, socket, {
    type: "hello.ack",
    reconciliationId: "reconciliation-1",
    projects: { "project-local": "project-server" },
    sessionContentEpochs: {},
  });
  assert.equal(socket.sent.filter((message) => message.type === "event.append").length, 3);
  assert.equal(socket.sent.some((message) => message.type === "reconciliation.complete"), false);

  await enqueue(access, socket, { type: "event.ack", eventId: first.eventId });
  assert.equal(socket.sent.some((message) => message.type === "reconciliation.complete"), false);
  await enqueue(access, socket, { type: "event.ack", eventId: second.eventId });
  const complete = socket.sent.find((message) => message.type === "reconciliation.complete");
  assert.deepEqual(complete, {
    type: "reconciliation.complete",
    reconciliationId: "reconciliation-1",
    reconciliationStreams: [{ producerEpoch: "producer-current", throughHostSeq: 2 }],
  });
  assert.equal(store.snapshot().outbox.some((event) => event.eventId === afterWatermark.eventId), true);

  await enqueue(access, socket, offer("attempt-before-reconciliation-ack"));
  assert.equal(runtime.commandCalls.length, 0);
  await enqueue(access, socket, { type: "reconciliation.ack", reconciliationId: "reconciliation-1" });
  assert.equal(access.reconciliationReady, true);

  await enqueue(access, socket, offer("attempt-ready"));
  assert.equal(runtime.commandCalls.length, 1);
  assert.equal(runtime.commandCalls[0]?.generation, 7);
  assert.equal(runtime.commandCalls[0]?.command.attemptId, "attempt-ready");
  assert.equal(runtime.commandCalls[0]?.command.projectId, "project-local");
  assert.equal(runtime.commandCalls[0]?.command.transportGeneration, 7);
  assert.equal(runtime.commandCalls[0]?.command.appServerEpoch, "app-current");

  await enqueue(access, socket, offer("attempt-stale", { appServerEpoch: "app-old" }));
  assert.equal(runtime.commandCalls.length, 1);
  assert.equal((socket.sent.at(-1)?.detail as { code?: unknown } | undefined)?.code, "DISPATCH_TARGET_FENCED");
  await enqueue(access, socket, offer("attempt-missing", { producerEpoch: undefined }));
  assert.equal(runtime.commandCalls.length, 1);
  assert.equal((socket.sent.at(-1)?.detail as { code?: unknown } | undefined)?.code, "DISPATCH_BINDING_MISSING");
});

test("commands remain serial while history acknowledgements can pass an unfinished command", async () => {
  const { runtime, socket, access, store } = await setup();
  access.reconciliationReady = true;
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  runtime.handleCommandHook = async (command) => {
    if (command.attemptId !== "attempt-1") return;
    firstStarted.resolve();
    await releaseFirst.promise;
  };

  access.enqueueInbound(frame(offer("attempt-1")), socket as unknown as WebSocket);
  access.enqueueInbound(frame(offer("attempt-2")), socket as unknown as WebSocket);
  await firstStarted.promise;
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(runtime.commandCalls.map((call) => call.command.attemptId), ["attempt-1"]);
  const event = await store.appendEvent({ machineId: "machine-1", producerEpoch: "producer-current", type: "item.completed", payload: {} });
  await enqueue(access, socket, { type: "event.ack", eventId: event.eventId });
  assert.equal(store.snapshot().outbox.length, 0, "history can drain before the command completes");
  releaseFirst.resolve();
  await access.inboundTail;
  await access.commandTail;
  assert.deepEqual(runtime.commandCalls.map((call) => call.command.attemptId), ["attempt-1", "attempt-2"]);
  store.close();
});

test("fully acknowledged historical streams do not consume the 32-stream hello bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-relay-acked-history-"));
  const store = new StateStore(directory);
  await store.initialize();
  for (let index = 0; index < 40; index += 1) {
    const producerEpoch = `old-${String(index).padStart(2, "0")}`;
    await store.beginProducerEpoch(producerEpoch);
    const event = await store.appendEvent({
      machineId: "machine-1",
      producerEpoch,
      type: "agent.warning",
      payload: { index },
    });
    await store.acknowledge(producerEpoch, event.hostSeq);
  }
  await store.beginProducerEpoch("producer-current");

  assert.deepEqual(captureReconciliationStreams(store), [
    { producerEpoch: "producer-current", throughHostSeq: 0 },
  ]);
  assert.deepEqual(selectDurableStreams(store.snapshot(), "producer-current").resumeStreams, []);
  store.close();
});

test("a burst of historical acknowledgements is persisted once and unknown IDs cannot advance the watermark", async t => {
  const { store, socket, access } = await setup();
  t.after(() => store.close());
  const events = [];
  for (let index = 0; index < 100; index++) events.push(await store.appendEvent({
    machineId: "machine-1", producerEpoch: "producer-current", projectId: "project-local", type: "item.completed", payload: { index },
  }));
  let transactions = 0;
  const acknowledge = store.acknowledgeEvents.bind(store);
  store.acknowledgeEvents = async ids => { transactions++; await acknowledge(ids); };
  for (const event of events.slice(0, 99)) access.enqueueInbound(frame({ type: "event.ack", eventId: event.eventId }), socket as unknown as WebSocket);
  access.enqueueInbound(frame({ type: "event.ack", eventId: "unrecognized" }), socket as unknown as WebSocket);
  await access.inboundTail;
  await access.acknowledgementTask;
  assert.equal(transactions, 1);
  assert.deepEqual(store.snapshot().outbox.map(e => e.eventId), [events[99]!.eventId]);
  assert.equal(store.snapshot().producerStreams["producer-current"]!.lastAckedSeq, 99);
});

test("retained old streams are stable and overflow fails closed instead of slicing outbox", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-relay-stream-limit-"));
  const store = new StateStore(directory);
  await store.initialize();
  for (let index = 31; index >= 0; index -= 1) {
    const producerEpoch = `old-${String(index).padStart(2, "0")}`;
    await store.beginProducerEpoch(producerEpoch);
    await store.appendEvent({
      machineId: "machine-1",
      producerEpoch,
      type: "agent.warning",
      payload: { index },
    });
  }
  await store.beginProducerEpoch("producer-current");

  assert.throws(
    () => captureReconciliationStreams(store),
    /durable outbox spans 32 old producer epochs/,
  );
  await store.acknowledge("old-31", 1);
  const selected = selectDurableStreams(store.snapshot(), "producer-current");
  assert.equal(selected.reconciliationStreams.length, 32);
  assert.equal(selected.reconciliationStreams[0]?.producerEpoch, "producer-current");
  assert.deepEqual(
    selected.resumeStreams.map((stream) => stream.producerEpoch),
    Array.from({ length: 31 }, (_, index) => `old-${String(index).padStart(2, "0")}`),
  );
  assert.deepEqual(captureReconciliationStreams(store), selected.reconciliationStreams);
  store.close();
});
