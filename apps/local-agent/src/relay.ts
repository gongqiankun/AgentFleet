import { HEARTBEAT_INTERVAL_MS, MAX_WS_FRAME_BYTES } from "./constants.js";
import { setImmediate as yieldToIO } from "node:timers/promises";
import { AgentError, errorMessage } from "./errors.js";
import type { MachineIdentity } from "./identity.js";
import type { AgentRuntime } from "./runtime.js";
import type { StateStore } from "./store.js";
import { selectDurableStreams, type ReconciliationStreamWatermark } from "./stream-selection.js";
import type { PairingCredential } from "./types.js";
import { obtainConnectionTicket } from "./ticket.js";
import { delay, isRecord } from "./util.js";
import { renewCredential, shouldRenewCredential } from "./credentials.js";

// The WHATWG client (Node's global WebSocket) accepts only 1000 or
// application codes 3000–4999. Server-only 1008/1009/1011 throw synchronously.
function closeRelaySocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
  try { socket.close(code, reason); }
  catch {
    // Never turn transport error handling into an unhandled rejection/crash.
    try { socket.close(); } catch { /* transport already unusable */ }
  }
}

function openSocket(url: string, signal: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const abort = () => {
      closeRelaySocket(socket, 1000, "agent stopping");
      reject(signal.reason);
    };
    const onOpen = () => {
      cleanup();
      resolve(socket);
    };
    const onError = () => {
      cleanup();
      reject(new AgentError("WEBSOCKET_FAILED", "failed to establish outbound relay connection"));
    };
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

function waitForClose(socket: WebSocket, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      closeRelaySocket(socket, 1000, "agent stopping");
      finish();
    };
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    socket.addEventListener("close", finish, { once: true });
  });
}

export interface RelayLogger {
  info(message: string): void;
  warn(message: string): void;
}

interface PendingReconciliation {
  reconciliationId: string | undefined;
  reconciliationStreams: ReconciliationStreamWatermark[];
  completeSent: boolean;
}

export function captureReconciliationStreams(store: StateStore): ReconciliationStreamWatermark[] {
  const state = store.snapshot();
  if (!state.activeProducerEpoch) {
    throw new AgentError("CURRENT_PRODUCER_STREAM_MISSING", "the active producer epoch is not initialized");
  }
  return selectDurableStreams(state, state.activeProducerEpoch).reconciliationStreams;
}

export class RelayConnection {
  private readonly runtime: AgentRuntime;
  private readonly store: StateStore;
  private readonly identity: MachineIdentity;
  private readonly pairing: PairingCredential;
  private readonly requestedUrl: string;
  private readonly logger: RelayLogger;
  private socket: WebSocket | undefined;
  private generation: number | undefined;
  private flushing = false;
  private flushAgain = false;
  private helloAcknowledged = false;
  private reconciliationReady = false;
  private helloCycleActive = false;
  private helloAgain = false;
  private pendingReconciliation: PendingReconciliation | undefined;
  private inboundTail: Promise<void> = Promise.resolve();
  private commandTail: Promise<void> = Promise.resolve();
  private pendingEventAcks = new Set<string>();
  private acknowledgementTask: Promise<void> | undefined;
  private sentEvents = new Set<string>();
  private projectMappings = new Map<string, string>();
  private readonly onMaintenance: ((offer: Record<string, unknown>) => Promise<void>) | undefined;
  private readonly onReady: (() => void) | undefined;
  private renewing = false;

  constructor(options: {
    runtime: AgentRuntime;
    store: StateStore;
    identity: MachineIdentity;
    pairing: PairingCredential;
    requestedUrl: string;
    logger: RelayLogger;
    onMaintenance?: (offer: Record<string, unknown>) => Promise<void>;
    onReady?: () => void;
  }) {
    this.runtime = options.runtime;
    this.store = options.store;
    this.identity = options.identity;
    this.pairing = options.pairing;
    this.requestedUrl = options.requestedUrl;
    this.logger = options.logger;
    this.onMaintenance = options.onMaintenance;
    this.onReady = options.onReady;
    this.runtime.setCallbacks({
      onOutboxChanged: () => void this.flushOutbox(),
      onVolatile: (event) => this.sendVolatile(event),
      onCommandAck: (ack) => this.send(ack),
      onRegistryChanged: () => this.requestRegistryHello(),
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      try {
        await this.connectOnce(signal);
        attempt = 0;
      } catch (error) {
        if (signal.aborted) break;
        this.logger.warn(`relay disconnected: ${errorMessage(error)}`);
        attempt += 1;
      } finally {
        this.socket = undefined;
        this.generation = undefined;
        this.helloAcknowledged = false;
        this.reconciliationReady = false;
        this.helloCycleActive = false;
        this.helloAgain = false;
        this.pendingReconciliation = undefined;
        this.projectMappings.clear();
        this.runtime.setTransportGeneration(undefined);
      }
      if (!signal.aborted) {
        const ceiling = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
        const backoff = Math.round(ceiling * (0.5 + Math.random() * 0.5));
        await delay(backoff, signal).catch(() => undefined);
      }
    }
  }

  private async connectOnce(signal: AbortSignal): Promise<void> {
    await this.refreshCredential(signal);
    const transportGeneration = await this.store.reserveTransportGeneration();
    const ticket = await obtainConnectionTicket({
      pairing: this.store.snapshot().pairing ?? this.pairing,
      identity: this.identity,
      producerEpoch: this.runtime.producerEpoch,
      requestedUrl: this.requestedUrl,
      transportGeneration,
      signal,
    });
    const socket = await openSocket(ticket.wsUrl, signal);
    this.socket = socket;
    this.sentEvents.clear();
    this.generation = ticket.transportGeneration;
    this.inboundTail = Promise.resolve();
    this.runtime.setTransportGeneration(ticket.transportGeneration);
    socket.addEventListener("message", (event) => this.enqueueInbound(event, socket));
    socket.addEventListener("error", () => closeRelaySocket(socket, 4011, "relay transport error"));
    this.beginHelloCycle();
    const heartbeat = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN || !this.reconciliationReady) return;
      this.send(this.runtime.heartbeatPayload());
      void this.refreshCredential(signal);
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
    this.logger.info(`machine ${this.pairing.machineId} connected (generation ${ticket.transportGeneration})`);
    try {
      await waitForClose(socket, signal);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private enqueueInbound(event: MessageEvent, sourceSocket: WebSocket): void {
    this.inboundTail = this.inboundTail
      .catch(() => undefined)
      .then(async () => {
        if (this.socket !== sourceSocket) return;
        await this.handleMessage(event);
      })
      .catch((error) => {
        this.logger.warn(`relay frame handling failed: ${errorMessage(error)}`);
        if (this.socket === sourceSocket) closeRelaySocket(sourceSocket, 4011, "relay frame handling failed");
      });
  }

  private requestRegistryHello(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.reconciliationReady = false;
    if (this.helloCycleActive) {
      this.helloAgain = true;
      return;
    }
    this.beginHelloCycle();
  }

  private beginHelloCycle(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    let reconciliationStreams: ReconciliationStreamWatermark[];
    try {
      reconciliationStreams = captureReconciliationStreams(this.store);
    } catch (error) {
      this.logger.warn(`cannot start reconciliation: ${errorMessage(error)}`);
      closeRelaySocket(this.socket, 4011, "reconciliation stream set is unsafe");
      return;
    }
    this.helloCycleActive = true;
    this.helloAcknowledged = false;
    this.reconciliationReady = false;
    this.pendingReconciliation = {
      reconciliationId: undefined,
      reconciliationStreams,
      completeSent: false,
    };
    this.projectMappings.clear();
    this.send({ ...this.runtime.helloPayload(), reconciliationStreams });
  }

  private async maybeCompleteReconciliation(): Promise<void> {
    const pending = this.pendingReconciliation;
    if (!this.helloAcknowledged || !pending?.reconciliationId || pending.completeSent) return;
    const streams = this.store.snapshot().producerStreams;
    if (!pending.reconciliationStreams.every((watermark) => {
      const stream = streams[watermark.producerEpoch];
      return stream !== undefined && stream.lastAckedSeq >= watermark.throughHostSeq;
    })) return;
    if (this.send({
      type: "reconciliation.complete",
      reconciliationId: pending.reconciliationId,
      reconciliationStreams: pending.reconciliationStreams,
    })) {
      pending.completeSent = true;
    }
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    if (typeof event.data !== "string") {
      this.protocolError("binary frames are not accepted");
      return;
    }
    if (Buffer.byteLength(event.data, "utf8") > MAX_WS_FRAME_BYTES) {
      if (this.socket) closeRelaySocket(this.socket, 4009, "frame too large");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(event.data) as unknown;
    } catch {
      this.protocolError("invalid JSON frame");
      return;
    }
    if (!isRecord(value) || typeof value.type !== "string") {
      this.protocolError("frame must have a type");
      return;
    }
    switch (value.type) {
      case "welcome":
        if (typeof value.transportGeneration === "number" && value.transportGeneration !== this.generation) {
          if (this.socket) closeRelaySocket(this.socket, 4008, "transport generation mismatch");
        }
        return;
      case "hello.ack": {
        if (!this.helloCycleActive || !this.pendingReconciliation) {
          this.protocolError("unexpected hello acknowledgement");
          return;
        }
        if (typeof value.reconciliationId !== "string" || value.reconciliationId.length === 0 || value.reconciliationId.length > 256) {
          this.protocolError("hello acknowledgement is missing reconciliationId");
          return;
        }
        if (
          this.pendingReconciliation.reconciliationId !== undefined &&
          this.pendingReconciliation.reconciliationId !== value.reconciliationId
        ) {
          this.protocolError("hello acknowledgement changed reconciliationId");
          return;
        }
        this.pendingReconciliation.reconciliationId = value.reconciliationId;
        this.helloAcknowledged = true;
        this.projectMappings.clear();
        if (isRecord(value.projects)) {
          for (const [externalId, serverId] of Object.entries(value.projects)) {
            if (typeof serverId === "string") this.projectMappings.set(externalId, serverId);
          }
        }
        if (isRecord(value.projectContentPolicies)) {
          for (const [externalId, policyValue] of Object.entries(value.projectContentPolicies)) {
            if (!isRecord(policyValue) || typeof policyValue.syncContent !== "boolean" || !Number.isSafeInteger(policyValue.retentionDays)) continue;
            await this.runtime.setProjectContentPolicy(externalId, policyValue.syncContent, Number(policyValue.retentionDays));
          }
        }
        if (isRecord(value.sessionContentEpochs)) {
          for (const [logicalSessionId, contentEpoch] of Object.entries(value.sessionContentEpochs)) {
            if (Number.isSafeInteger(contentEpoch) && Number(contentEpoch) >= 1) {
              await this.runtime.advanceContentEpoch(logicalSessionId, Number(contentEpoch));
            }
          }
        }
        await this.flushOutbox();
        await this.maybeCompleteReconciliation();
        return;
      }
      case "content.epoch":
        if (typeof value.logicalSessionId !== "string" || !Number.isSafeInteger(value.contentEpoch)) {
          this.protocolError("content epoch frame is malformed");
          return;
        }
        await this.runtime.advanceContentEpoch(value.logicalSessionId, Number(value.contentEpoch));
        return;
      case "project.policy":
        if (typeof value.projectExternalId !== "string" || typeof value.syncContent !== "boolean" || !Number.isSafeInteger(value.retentionDays)) {
          this.protocolError("project policy frame is malformed");
          return;
        }
        await this.runtime.setProjectContentPolicy(value.projectExternalId, value.syncContent, Number(value.retentionDays));
        return;
      case "heartbeat.ack":
      case "maintenance.ack":
      case "command.ack.confirmed":
      case "pong":
        return;
      case "reconciliation.ack": {
        const pending = this.pendingReconciliation;
        if (
          !pending?.completeSent ||
          typeof value.reconciliationId !== "string" ||
          value.reconciliationId !== pending.reconciliationId
        ) {
          this.protocolError("reconciliation acknowledgement is missing, premature, or stale");
          return;
        }
        this.helloCycleActive = false;
        this.pendingReconciliation = undefined;
        if (this.helloAgain) {
          this.helloAgain = false;
          this.beginHelloCycle();
        } else {
          this.reconciliationReady = true;
          this.onReady?.();
        }
        return;
      }
      case "ping":
        this.send({ type: "ping" });
        return;
      case "event.ack": {
        if (typeof value.eventId !== "string") {
          this.protocolError("outbox ack is malformed");
          return;
        }
        this.pendingEventAcks.add(value.eventId);
        this.scheduleAcknowledgements();
        return;
      }
      case "event.nack":
        this.logger.warn(`event rejected by control plane: ${typeof value.message === "string" ? value.message : "unspecified"}`);
        return;
      case "command.offer": {
        const generation = this.generation;
        if (generation === undefined) return;
        if (typeof value.dispatchAttemptId !== "string" || !isRecord(value.command)) {
          this.protocolError("command offer is malformed");
          return;
        }
        if (
          !Number.isSafeInteger(value.transportGeneration) ||
          typeof value.producerEpoch !== "string" ||
          typeof value.appServerEpoch !== "string"
        ) {
          this.invalidateOffer(value.dispatchAttemptId, "DISPATCH_BINDING_MISSING", "command offer is missing its immutable dispatch binding");
          return;
        }
        const appServerEpoch = this.runtime.getAppServerEpoch();
        if (
          value.transportGeneration !== generation ||
          value.producerEpoch !== this.runtime.producerEpoch ||
          appServerEpoch === undefined ||
          value.appServerEpoch !== appServerEpoch
        ) {
          this.invalidateOffer(value.dispatchAttemptId, "DISPATCH_TARGET_FENCED", "command offer targets a stale transport, producer, or App Server epoch");
          return;
        }
        if (!this.reconciliationReady) {
          this.invalidateOffer(value.dispatchAttemptId, "RECONCILIATION_INCOMPLETE", "command delivery is frozen until reconciliation is acknowledged");
          return;
        }
        let command: Record<string, unknown>;
        try {
          command = this.bindCommand(value.command, value.dispatchAttemptId, {
            transportGeneration: value.transportGeneration as number,
            appServerEpoch: value.appServerEpoch,
          });
        } catch (error) {
          this.send({
            type: "command.ack",
            dispatchAttemptId: value.dispatchAttemptId,
            state: "invalidated",
            detail: { code: "PROJECT_BINDING_MISSING", message: errorMessage(error) },
          });
          return;
        }
        // Preserve command order without blocking event acknowledgements or
        // reconciliation behind a long-running history import.
        const sourceSocket = this.socket;
        this.commandTail = this.commandTail.catch(() => undefined).then(async () => {
          if (this.socket !== sourceSocket || this.generation !== generation) return;
          await this.runtime.handleCommand(command, generation);
          await this.flushOutbox();
        }).catch(error => {
          this.logger.warn(`relay command handling failed: ${errorMessage(error)}`);
          if (sourceSocket && this.socket === sourceSocket) closeRelaySocket(sourceSocket, 4011, "relay command handling failed");
        });
        return;
      }
      case "maintenance.offer": {
        if (!this.onMaintenance || !this.reconciliationReady) return;
        void this.onMaintenance(value).catch((error) => this.logger.warn(`maintenance operation failed: ${errorMessage(error)}`));
        return;
      }
      case "error":
        this.logger.warn(`control-plane error: ${typeof value.code === "string" ? value.code : "unknown"}`);
        return;
      default:
        // In particular, never treat a generic `rpc`, Queue, Steer, shell, fs, or process frame as executable.
        this.protocolError(`unsupported frame type '${value.type}'`);
    }
  }

  reportMaintenance(result: Record<string, unknown>): void {
    // Diagnostics/recovery may start a registry reconciliation. Results are
    // durable and replayed by onReady; do not send them into a closed gate.
    if (!this.reconciliationReady) return;
    this.send({ type: "maintenance.result", ...result });
  }

  private scheduleAcknowledgements(): void {
    if (this.acknowledgementTask) return;
    this.acknowledgementTask = (async () => {
      // Drain a socket burst in one durable transaction, rather than rewriting
      // the entire outbox once per acknowledged historical item.
      await yieldToIO();
      while (this.pendingEventAcks.size) {
        const ids = this.pendingEventAcks;
        this.pendingEventAcks = new Set();
        await this.store.acknowledgeEvents(ids);
        for (const id of ids) this.sentEvents.delete(id);
        await this.maybeCompleteReconciliation();
        await yieldToIO();
      }
    })().catch(error => this.protocolError(errorMessage(error))).finally(() => {
      this.acknowledgementTask = undefined;
    });
  }

  private async refreshCredential(signal: AbortSignal): Promise<void> {
    const pairing = this.store.snapshot().pairing;
    if (!pairing || !shouldRenewCredential(pairing) || this.renewing) return;
    this.renewing = true;
    try { await renewCredential(this.store, this.identity, signal); }
    catch (error) { this.logger.warn(`credential renewal failed: ${errorMessage(error)}`); }
    finally { this.renewing = false; }
  }

  private async flushOutbox(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    const socket = this.socket;
    const generation = this.generation;
    if (!socket || socket.readyState !== WebSocket.OPEN || generation === undefined || !this.helloAcknowledged) return;
    this.flushing = true;
    this.flushAgain = false;
    try {
      for (const event of this.store.snapshot().outbox) {
        if (socket.readyState !== WebSocket.OPEN) break;
        if (this.sentEvents.has(event.eventId)) continue;
        while (socket.bufferedAmount > MAX_WS_FRAME_BYTES && socket.readyState === WebSocket.OPEN) {
          await delay(10);
        }
        if (this.socket !== socket || this.generation !== generation || socket.readyState !== WebSocket.OPEN) break;
        const serverProjectId = this.projectMappings.get(event.projectId ?? "");
        if (!serverProjectId) {
          this.logger.warn(`holding event ${event.eventId}: project mapping is unavailable`);
          continue;
        }
        this.send({ type: "event.append", event: { ...event, projectId: serverProjectId } });
        this.sentEvents.add(event.eventId);
      }
    } finally {
      this.flushing = false;
      if (this.flushAgain) void this.flushOutbox();
    }
  }

  private sendVolatile(event: Record<string, unknown>): void {
    if (!this.reconciliationReady || this.socket?.readyState !== WebSocket.OPEN) return;
    if (
      typeof event.projectId !== "string"
      || typeof event.logicalSessionId !== "string"
      || typeof event.executionSegmentId !== "string"
      || typeof event.nativeThreadId !== "string"
      || typeof event.nativeTurnId !== "string"
      || typeof event.eventType !== "string"
      || typeof event.producerEpoch !== "string"
      || typeof event.appServerEpoch !== "string"
      || !isRecord(event.payload)
    ) return;
    if (this.store.snapshot().projectContentPolicies[event.projectId]?.syncContent === false) return;
    const projectId = this.projectMappings.get(event.projectId);
    if (!projectId) return;
    this.send({
      type: "volatile",
      eventType: event.eventType,
      producerEpoch: event.producerEpoch,
      appServerEpoch: event.appServerEpoch,
      projectId,
      logicalSessionId: event.logicalSessionId,
      executionSegmentId: event.executionSegmentId,
      nativeThreadId: event.nativeThreadId,
      nativeTurnId: event.nativeTurnId,
      ...(typeof event.nativeItemId === "string" ? { nativeItemId: event.nativeItemId } : {}),
      payload: event.payload,
    });
  }

  private protocolError(message: string): void {
    this.logger.warn(`protocol error: ${message}`);
    if (this.socket) closeRelaySocket(this.socket, 4008, "unsupported or invalid frame");
  }

  private invalidateOffer(dispatchAttemptId: string, code: string, message: string): void {
    this.send({
      type: "command.ack",
      dispatchAttemptId,
      state: "invalidated",
      detail: { code, message },
    });
  }

  private bindCommand(
    command: Record<string, unknown>,
    dispatchAttemptId: string,
    target: { transportGeneration: number; appServerEpoch: string },
  ): Record<string, unknown> {
    let externalProjectId: string | undefined;
    if (typeof command.projectExternalId === "string") {
      externalProjectId = command.projectExternalId;
    } else if (typeof command.projectId === "string") {
      if (this.store.snapshot().projects.some((project) => project.id === command.projectId)) {
        externalProjectId = command.projectId;
      } else {
        externalProjectId = [...this.projectMappings.entries()].find(([, serverId]) => serverId === command.projectId)?.[0];
      }
    }
    if (!externalProjectId) {
      throw new AgentError("PROJECT_BINDING_MISSING", "command does not explicitly identify an authorized project");
    }
    return {
      ...command,
      attemptId: dispatchAttemptId,
      projectId: externalProjectId,
      transportGeneration: target.transportGeneration,
      appServerEpoch: target.appServerEpoch,
    };
  }

  private send(value: Record<string, unknown>): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(value));
      return true;
    } catch {
      closeRelaySocket(socket, 4011, "relay send failed");
      return false;
    }
  }
}
