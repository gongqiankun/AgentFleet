import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { WebSocket, RawData } from "ws";
import type { ControlPlaneConfig } from "../src/config.js";
import { buildControlPlane, cookieFromSetCookie, csrfHeaders } from "../src/server.js";
import { payloadHash } from "../src/crypto.js";
import { CoordinationService } from "../src/coordination.js";
import { AuthService } from "../src/auth.js";
import { AppError } from "../src/errors.js";
import { COMMAND_TYPES } from "../src/api-schema.js";

const origin = "http://control-plane.test";

function config(): ControlPlaneConfig {
  return {
    host: "127.0.0.1",
    port: 3000,
    databasePath: ":memory:",
    publicOrigin: origin,
    allowedOrigins: new Set([origin]),
    adminEmail: "admin@example.test",
    adminPassword: "correct horse battery staple",
    cookieName: "agentfleet_test",
    cookieSecure: false,
    sessionTtlSeconds: 3600,
    controlLeaseTtlSeconds: 45,
    pairTtlSeconds: 600,
    challengeTtlSeconds: 60,
    ticketTtlSeconds: 30,
    heartbeatOfflineSeconds: 45,
    logLevel: "silent",
  };
}

function json<T>(body: string): T {
  return JSON.parse(body) as T;
}

interface LoginResult {
  clientSessionId: string;
  csrfToken: string;
}

class WsInbox {
  private readonly messages: unknown[] = [];
  private readonly waiters: Array<{
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
  }> = [];

  attach(ws: WebSocket): void {
    ws.on("message", (raw: RawData) => {
      const value = JSON.parse(raw.toString()) as Record<string, unknown>;
      const index = this.waiters.findIndex((waiter) => waiter.predicate(value));
      if (index >= 0) {
        const waiter = this.waiters.splice(index, 1)[0];
        waiter?.resolve(value);
      } else {
        this.messages.push(value);
      }
    });
  }

  async next(type: string, timeoutMs = 2_000): Promise<Record<string, unknown>> {
    const existingIndex = this.messages.findIndex(
      (message) => typeof message === "object" && message !== null && (message as Record<string, unknown>).type === type,
    );
    if (existingIndex >= 0) return this.messages.splice(existingIndex, 1)[0] as Record<string, unknown>;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for WebSocket message ${type}`)), timeoutMs);
      this.waiters.push({
        predicate: (message) => message.type === type,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }
}

async function completeReconciliation(
  socket: WebSocket,
  inbox: WsInbox,
  helloAck: Record<string, unknown>,
  reconciliationStreams: Array<{ producerEpoch: string; throughHostSeq: number }>,
): Promise<void> {
  assert.equal(typeof helloAck.reconciliationId, "string");
  socket.send(JSON.stringify({
    type: "reconciliation.complete",
    reconciliationId: helloAck.reconciliationId,
    reconciliationStreams,
  }));
  const ack = await inbox.next("reconciliation.ack");
  assert.equal(ack.reconciliationId, helloAck.reconciliationId);
}

test("P0a pairing, signed agent transport, leases, commands, approvals, and durable ordering", async (t) => {
  const { app, db, runMaintenance } = await buildControlPlane(config());
  await app.ready();
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve) => setImmediate(resolve));
    await app.close();
  });

  const health = await app.inject({ method: "GET", url: "/ready" });
  assert.equal(health.statusCode, 200);
  assert.equal(json<{ status: string }>(health.body).status, "ok");

  const anonymousStatus = await app.inject({ method: "GET", url: "/api/auth/status" });
  assert.equal(anonymousStatus.statusCode, 200);
  assert.equal(json<{ authenticated: boolean }>(anonymousStatus.body).authenticated, false);

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin, "content-type": "application/json" },
    payload: { email: "admin@example.test", password: "correct horse battery staple" },
  });
  assert.equal(login.statusCode, 200, login.body);
  const loginBody = json<LoginResult>(login.body);
  const cookie = cookieFromSetCookie(login.headers["set-cookie"]);
  const browserHeaders = { cookie, ...csrfHeaders(loginBody.csrfToken, origin) };
  const authenticatedStatus = await app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie } });
  assert.equal(authenticatedStatus.statusCode, 200);
  assert.equal(json<{ authenticated: boolean }>(authenticatedStatus.body).authenticated, true);

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyEncoded = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const deviceCode = randomBytes(32).toString("base64url");
  const pairingInit = await app.inject({
    method: "POST",
    url: "/api/agent/pairing/init",
    payload: {
      deviceCode,
      publicKey: publicKeyEncoded,
      name: "alpha-host",
      platform: "linux",
      platformRelease: "22.04",
      architecture: "x86_64",
      agentVersion: "0.1.0",
    },
  });
  assert.equal(pairingInit.statusCode, 200, pairingInit.body);
  const pairing = json<{
    pairingId: string;
    userCode: string;
    verificationPhrase: string;
    proofMessage: string;
  }>(pairingInit.body);

  const preview = await app.inject({
    method: "GET",
    url: `/api/pairings/preview?userCode=${encodeURIComponent(pairing.userCode)}`,
    headers: { cookie },
  });
  assert.equal(preview.statusCode, 200, preview.body);

  const confirm = await app.inject({
    method: "POST",
    url: `/api/pairings/${pairing.pairingId}/confirm`,
    headers: browserHeaders,
    payload: { verificationPhrase: pairing.verificationPhrase },
  });
  assert.equal(confirm.statusCode, 200, confirm.body);

  const pairingSignature = sign(null, Buffer.from(pairing.proofMessage), privateKey).toString("base64url");
  const exchange = await app.inject({
    method: "POST",
    url: "/api/agent/pairing/exchange",
    payload: { deviceCode, signature: pairingSignature },
  });
  assert.equal(exchange.statusCode, 200, exchange.body);
  const agentCredential = json<{ machineId: string; agentToken: string }>(exchange.body);
  const secondExchange = await app.inject({
    method: "POST",
    url: "/api/agent/pairing/exchange",
    payload: { deviceCode, signature: pairingSignature },
  });
  assert.equal(secondExchange.statusCode, 409, secondExchange.body);

  const challengeResponse = await app.inject({
    method: "POST",
    url: "/api/agent/auth/challenge",
    payload: { ...agentCredential, transportGeneration: 1 },
  });
  assert.equal(challengeResponse.statusCode, 200, challengeResponse.body);
  const challenge = json<{ challengeId: string; message: string }>(challengeResponse.body);
  const ticketResponse = await app.inject({
    method: "POST",
    url: "/api/agent/auth/ticket",
    payload: {
      machineId: agentCredential.machineId,
      challengeId: challenge.challengeId,
      transportGeneration: 1,
      signature: sign(null, Buffer.from(challenge.message), privateKey).toString("base64url"),
    },
  });
  assert.equal(ticketResponse.statusCode, 200, ticketResponse.body);
  const ticket = json<{ ticket: string }>(ticketResponse.body).ticket;
  const agentInbox = new WsInbox();
  const agentSocket = await app.injectWS(`/ws/agent?ticket=${encodeURIComponent(ticket)}`, {}, {
    onInit: (socket) => agentInbox.attach(socket),
  });
  sockets.push(agentSocket);
  assert.equal((await agentInbox.next("welcome")).machineId, agentCredential.machineId);
  agentSocket.send(JSON.stringify({
    type: "hello",
    producerEpoch: "producer-epoch-1",
    appServerEpoch: "app-server-epoch-1",
    agentVersion: "0.16.2",
    capabilities: { commandTypes: COMMAND_TYPES, maintenanceTypes: ["diagnostics.collect"] },
    codexVersion: "0.154.0",
    schemaHash: "f3487938786b729cb6773dbc9e83a7efab9c78c845db7094e8f539f373cbacc9",
    credentialProtectionLevel: "software_protected",
    platform: "linux",
    platformRelease: "25.04",
    architecture: "x86_64",
    capacity: "idle",
    reconciliationStreams: [{ producerEpoch: "producer-epoch-1", throughHostSeq: 0 }],
    projects: [{
      externalId: "local-project-a",
      alias: "AgentFleet",
      canonicalRoot: "/work/agentfleet",
      identityHash: "sha256:project-a",
      repoRoot: "/work/agentfleet",
      branch: "main",
      dirty: false,
      leaseVersion: 1,
    }],
  }));
  const helloAck = await agentInbox.next("hello.ack");
  assert.equal(db.get<{ compatibility: string }>("SELECT compatibility FROM machines WHERE machine_id=?", agentCredential.machineId)?.compatibility, "compatible", "Ubuntu 25.04 is gated by architecture and validated runtime, not an obsolete distro whitelist");
  const projectId = (helloAck.projects as Record<string, string>)["local-project-a"] as string;
  assert.ok(projectId);

  agentSocket.send(JSON.stringify({ type: "heartbeat", capacity: "idle", activeTurns: 0 }));
  assert.equal((await agentInbox.next("error")).code, "RECONCILIATION_REQUIRED");
  assert.equal(
    db.get<{ reachability: string }>("SELECT reachability FROM machines WHERE machine_id=?", agentCredential.machineId)?.reachability,
    "connecting",
  );
  await completeReconciliation(
    agentSocket,
    agentInbox,
    helloAck,
    [{ producerEpoch: "producer-epoch-1", throughHostSeq: 0 }],
  );

  const reportedProfile = { id: "default", osAccount: "developer", codexHome: "/home/developer/.codex", hostCodexPath: "/home/developer/.nvm/versions/node/v24/bin/codex", hostCodexVersion: "0.153.4", runtimePath: "/home/developer/.local/share/agentfleet/codex/codex", runtimeVersion: "0.153.2", source: "managed", hostCodexDefaultPath: "/home/developer/.local/bin/codex", hostCodexDefaultVersion: "0.145.0", hostCodexCheckedAt: new Date().toISOString(), hostCodexDetection: "highest-detected", hostCodexVersionSource: "package-record", hostCodexMetadataPath: "/home/developer/.codex/packages/standalone/current/codex-package.json", hostCodexDefaultVersionSource: "command" };
  agentSocket.send(JSON.stringify({ type: "heartbeat", capacity: "idle", activeTurns: 0, codexProfile: reportedProfile }));
  await agentInbox.next("heartbeat.ack");
  const savedProfile = () => JSON.parse(db.get<{ codex_profile_json: string }>("SELECT codex_profile_json FROM machines WHERE machine_id=?", agentCredential.machineId)!.codex_profile_json);
  assert.deepEqual(savedProfile(), reportedProfile, "fresh inventory reaches the panel without an Agent reconnect");
  agentSocket.send(JSON.stringify({ type: "heartbeat", capacity: "idle", activeTurns: 0 }));
  await agentInbox.next("heartbeat.ack");
  assert.deepEqual(savedProfile(), reportedProfile, "legacy heartbeat does not clear the profile");
  agentSocket.send(JSON.stringify({ type: "heartbeat", capacity: "idle", activeTurns: 0, codexProfile: { ...reportedProfile, hostCodexVersion: 123 } }));
  assert.equal((await agentInbox.next("error")).code, "INVALID_CODEX_PROFILE");
  assert.deepEqual(savedProfile(), reportedProfile, "invalid profile cannot replace previous evidence");

  const runtimeState = () => db.get<{ runtime_read_only: number; security_state: string }>("SELECT runtime_read_only,security_state FROM machines WHERE machine_id=?", agentCredential.machineId)!;
  const probeCheck = { id: "sandbox", state: "failed", code: "SANDBOX_PROBE_FAILED", message: "temporary test failure", checkedAt: new Date().toISOString(), action: "agent.update" };
  agentSocket.send(JSON.stringify({ type: "heartbeat", capacity: "unknown", activeTurns: 0, readOnly: true, readOnlyReasons: ["sandbox failed"], discovery: { state: "ready", readiness: "action_required", checks: [probeCheck], skippedCount: 2, backgroundSync: true, syncMode: "events", reconcileIntervalSeconds: 300 } }));
  await agentInbox.next("heartbeat.ack");
  assert.equal(runtimeState().runtime_read_only, 1);
  assert.equal(runtimeState().security_state, "normal");
  const savedDiscovery = () => JSON.parse(db.get<{ discovery_json: string }>("SELECT discovery_json FROM machines WHERE machine_id=?", agentCredential.machineId)!.discovery_json);
  assert.deepEqual(savedDiscovery().checks, [probeCheck]);
  assert.equal(savedDiscovery().backgroundSync, true);
  assert.equal(savedDiscovery().syncMode, "events");
  assert.equal(savedDiscovery().reconcileIntervalSeconds, 300);
  agentSocket.send(JSON.stringify({ type: "heartbeat", capacity: "idle", activeTurns: 0, discovery: { state: "ready", syncMode: "fake" } }));
  assert.equal((await agentInbox.next("error")).code, "INVALID_DISCOVERY");
  assert.equal(savedDiscovery().syncMode, "events");
  agentSocket.send(JSON.stringify({ type: "heartbeat", capacity: "idle", activeTurns: 0, discovery: { state: "ready", backgroundSync: "true" } }));
  assert.equal((await agentInbox.next("error")).code, "INVALID_DISCOVERY");
  assert.equal(savedDiscovery().backgroundSync, true);
  agentSocket.send(JSON.stringify({ type: "heartbeat", capacity: "idle", activeTurns: 0 }));
  await agentInbox.next("heartbeat.ack");
  assert.equal(runtimeState().runtime_read_only, 1, "legacy messages cannot clear the safety gate");
  agentSocket.send(JSON.stringify({ type: "heartbeat", capacity: "idle", activeTurns: 0, readOnly: false, readOnlyReasons: "invalid" }));
  assert.equal((await agentInbox.next("error")).code, "INVALID_RUNTIME_STATE");
  assert.equal(runtimeState().runtime_read_only, 1);
  agentSocket.send(JSON.stringify({ type: "heartbeat", capacity: "idle", activeTurns: 0, discovery: { state: "ready", checks: [{ ...probeCheck, action: "shell.exec" }] } }));
  assert.equal((await agentInbox.next("error")).code, "INVALID_DISCOVERY");
  assert.deepEqual(savedDiscovery().checks, [probeCheck], "invalid recovery actions never replace evidence");
  agentSocket.send(JSON.stringify({ type: "heartbeat", capacity: "idle", activeTurns: 0, readOnly: false, readOnlyReasons: [], discovery: { state: "ready", readiness: "ready", checks: [{ ...probeCheck, state: "passed" }] } }));
  await agentInbox.next("heartbeat.ack");
  assert.equal(runtimeState().runtime_read_only, 0, "recovery does not require reconnecting the relay");

  // Released Agents replay maintenance results but do not understand a
  // maintenance.ack frame. Keep the wire response backwards-compatible.
  const maintenanceFrames: string[] = [];
  const captureMaintenance = (raw: RawData) => maintenanceFrames.push(JSON.parse(raw.toString()).type);
  agentSocket.on("message", captureMaintenance);
  const maintenanceRequest = await app.inject({
    method: "POST", url: `/api/machines/${agentCredential.machineId}/operations`, headers: browserHeaders,
    payload: { type: "diagnostics.collect", clientMutationId: "legacy-maintenance-wire-regression" },
  });
  assert.equal(maintenanceRequest.statusCode, 202, maintenanceRequest.body);
  const maintenanceOffer = await agentInbox.next("maintenance.offer");
  assert.equal(typeof maintenanceOffer.operationId, "string");
  for (const state of ["running", "succeeded", "succeeded"]) {
    agentSocket.send(JSON.stringify({ type: "maintenance.result", operationId: maintenanceOffer.operationId, state, result: { version: "0.19.0" } }));
  }
  agentSocket.send(JSON.stringify({ type: "ping" }));
  await agentInbox.next("pong");
  assert.equal(db.get<{ state: string }>("SELECT state FROM machine_operations WHERE operation_id=?", maintenanceOffer.operationId as string)?.state, "succeeded");
  assert.ok(!maintenanceFrames.includes("maintenance.ack"), "legacy Agents must not receive an unsupported maintenance acknowledgement");
  assert.ok(!maintenanceFrames.includes("error"), "maintenance replay remains idempotent");
  agentSocket.off("message", captureMaintenance);

  const createSession = await app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: browserHeaders,
    payload: { machineId: agentCredential.machineId, projectId, title: "Integration session" },
  });
  assert.equal(createSession.statusCode, 200, createSession.body);
  const session = json<{
    logicalSessionId: string;
    executionSegmentId: string;
    threadControlVersion: number;
    reachability: string;
  }>(createSession.body);
  assert.equal(session.reachability, "live", "A session created on an online Agent must accept its first command immediately");
  const timestampBeforeRehello = new Date().toISOString();
  db.run(
    `INSERT INTO logical_sessions(
      logical_session_id,workspace_id,machine_id,project_id,external_id,title,managed,
      execution_state,reachability,created_at,updated_at
    ) SELECT 'session-native-omitted',workspace_id,machine_id,?,'session-native-omitted',
      'Native session omitted from hello',1,'idle','live',?,? FROM machines WHERE machine_id=?`,
    projectId,
    timestampBeforeRehello,
    timestampBeforeRehello,
    agentCredential.machineId,
  );
  db.run(
    `INSERT INTO execution_segments(
      execution_segment_id,logical_session_id,machine_id,project_id,external_id,native_thread_id,
      history_completeness,created_at
    ) VALUES('segment-native-omitted','session-native-omitted',?,?,
      'segment-native-omitted','native-thread-omitted','complete',?)`,
    agentCredential.machineId,
    projectId,
    timestampBeforeRehello,
  );

  agentSocket.send(JSON.stringify({
    type: "hello",
    producerEpoch: "producer-epoch-1",
    appServerEpoch: "app-server-epoch-1",
    agentVersion: "0.16.2",
    capabilities: { commandTypes: COMMAND_TYPES },
    codexVersion: "0.153.4",
    schemaHash: "d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a",
    credentialProtectionLevel: "software_protected",
    platform: "linux",
    platformRelease: "24.04",
    architecture: "x86_64",
    capacity: "idle",
    reconciliationStreams: [{ producerEpoch: "producer-epoch-1", throughHostSeq: 0 }],
    projects: [{
      externalId: "local-project-a",
      alias: "AgentFleet",
      canonicalRoot: "/work/agentfleet",
      identityHash: "sha256:project-a",
      repoRoot: "/work/agentfleet",
      branch: "main",
      dirty: false,
      leaseVersion: 1,
    }],
    sessions: [],
  }));
  const reconciliation = await agentInbox.next("hello.ack");
  assert.equal((reconciliation.sessions as Record<string, string>)[session.logicalSessionId], undefined);
  assert.equal(
    db.get<{ reachability: string }>("SELECT reachability FROM logical_sessions WHERE logical_session_id=?", session.logicalSessionId)?.reachability,
    "reconciling",
  );
  const commandWhileReconciling = await app.inject({
    method: "POST",
    url: `/api/sessions/${session.logicalSessionId}/commands`,
    headers: browserHeaders,
    payload: {
      clientMutationId: "mutation-before-reconciliation",
      type: "turn.start",
      precondition: {},
      payload: { prompt: "must remain gated" },
    },
  });
  assert.equal(commandWhileReconciling.statusCode, 409, commandWhileReconciling.body);
  assert.equal(json<{ error: { code: string } }>(commandWhileReconciling.body).error.code, "SESSION_RECONCILING");
  await completeReconciliation(
    agentSocket,
    agentInbox,
    reconciliation,
    [{ producerEpoch: "producer-epoch-1", throughHostSeq: 0 }],
  );
  assert.equal(
    db.get<{ reachability: string }>("SELECT reachability FROM logical_sessions WHERE logical_session_id=?", session.logicalSessionId)?.reachability,
    "live",
    "a Control-Plane-created empty Session is safe to restore even when absent from the native hello snapshot",
  );
  assert.equal(
    db.get<{ count: number }>("SELECT COUNT(*) AS count FROM logical_sessions WHERE logical_session_id=?", session.logicalSessionId)?.count,
    1,
    "an empty Agent hello must not duplicate a Control-Plane-created Logical Session",
  );
  assert.equal(
    db.get<{ reachability: string }>("SELECT reachability FROM logical_sessions WHERE logical_session_id='session-native-omitted'")?.reachability,
    "reconciling",
    "an unreported managed Session with native state must remain fenced",
  );
  const omittedNativeCommand = await app.inject({
    method: "POST",
    url: "/api/sessions/session-native-omitted/commands",
    headers: browserHeaders,
    payload: {
      clientMutationId: "mutation-native-session-omitted",
      type: "turn.start",
      precondition: {},
      payload: { prompt: "must stay fenced" },
    },
  });
  assert.equal(omittedNativeCommand.statusCode, 409, omittedNativeCommand.body);
  assert.equal(json<{ error: { code: string } }>(omittedNativeCommand.body).error.code, "SESSION_RECONCILING");
  const machineView = await app.inject({ method: "GET", url: `/api/machines/${agentCredential.machineId}`, headers: { cookie } });
  const machineBody = json<{ codexVersion: string; schemaHash: string; credentialProtectionLevel: string }>(machineView.body);
  assert.equal(machineBody.codexVersion, "0.153.4");
  assert.equal(machineBody.schemaHash, "sha256:d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a");
  assert.equal(machineBody.credentialProtectionLevel, "software_protected");
  const renameMachine = await app.inject({
    method: "PATCH",
    url: `/api/machines/${agentCredential.machineId}`,
    headers: browserHeaders,
    payload: { alias: "部署节点 A" },
  });
  assert.equal(renameMachine.statusCode, 200, renameMachine.body);
  const renamedMachine = json<{ machine: { name: string; hostname: string; displayAlias: string } }>(renameMachine.body).machine;
  assert.equal(renamedMachine.name, "部署节点 A");
  assert.equal(renamedMachine.hostname, "alpha-host");
  assert.equal(renamedMachine.displayAlias, "部署节点 A");
  const dashboardView = json<{ compatibilityProfile: { validationStatus: string; managedCodexVersion: string; schemaHash: string } }>((await app.inject({
    method: "GET",
    url: "/api/dashboard",
    headers: { cookie },
  })).body);
  assert.equal(dashboardView.compatibilityProfile.validationStatus, "verified");
  assert.equal(dashboardView.compatibilityProfile.managedCodexVersion, "0.154.0");
  assert.equal(dashboardView.compatibilityProfile.schemaHash, "d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a");
  const sessionView = await app.inject({ method: "GET", url: `/api/sessions/${session.logicalSessionId}`, headers: { cookie } });
  const sessionViewBody = json<{ session: { historyCompleteness: string; turnControlVersion: number; projectLeaseVersion: number } }>(sessionView.body);
  assert.equal(sessionViewBody.session.historyCompleteness, "complete");
  assert.equal(sessionViewBody.session.turnControlVersion, 1);
  assert.equal(sessionViewBody.session.projectLeaseVersion, 1);

  const leaseResponse = await app.inject({
    method: "POST",
    url: `/api/sessions/${session.logicalSessionId}/control-lease`,
    headers: browserHeaders,
    payload: { expectedVersion: 0 },
  });
  assert.equal(leaseResponse.statusCode, 200, leaseResponse.body);
  const lease = json<{ leaseId: string; version: number }>(leaseResponse.body);

  const mutation = "mutation-turn-start-0001";
  const commandBody = {
    clientMutationId: mutation,
    controlLeaseId: lease.leaseId,
    type: "turn.start",
    precondition: {
      executionSegmentId: session.executionSegmentId,
      threadControlVersion: session.threadControlVersion,
      expectedActiveTurnId: null,
      projectLeaseVersion: 1,
    },
    payload: { prompt: "Run the integration test" },
  };
  const commandResponse = await app.inject({
    method: "POST",
    url: `/api/sessions/${session.logicalSessionId}/commands`,
    headers: browserHeaders,
    payload: commandBody,
  });
  assert.equal(commandResponse.statusCode, 202, commandResponse.body);
  const offered = await agentInbox.next("command.offer");
  assert.equal(offered.transportGeneration, 1);
  assert.equal(offered.producerEpoch, "producer-epoch-1");
  assert.equal(offered.appServerEpoch, "app-server-epoch-1");
  const offeredCommand = offered.command as Record<string, unknown>;
  assert.equal(offeredCommand.projectExternalId, "local-project-a");
  assert.equal(offeredCommand.executionSegmentId, session.executionSegmentId);
  const startCommandId = offeredCommand.commandId as string;
  assert.equal(typeof startCommandId, "string");
  const dispatchAttemptId = offered.dispatchAttemptId as string;
  for (const state of ["claimed", "invoking", "responded", "applied"]) {
    agentSocket.send(JSON.stringify({ type: "command.ack", dispatchAttemptId, state }));
    await agentInbox.next("command.ack.confirmed");
  }

  const idempotent = await app.inject({
    method: "POST",
    url: `/api/sessions/${session.logicalSessionId}/commands`,
    headers: browserHeaders,
    payload: commandBody,
  });
  assert.equal(idempotent.statusCode, 200, idempotent.body);
  assert.equal(json<{ duplicate: boolean }>(idempotent.body).duplicate, true);
  const mutationReuse = await app.inject({
    method: "POST",
    url: `/api/sessions/${session.logicalSessionId}/commands`,
    headers: browserHeaders,
    payload: { ...commandBody, payload: { prompt: "Different" } },
  });
  assert.equal(mutationReuse.statusCode, 409, mutationReuse.body);

  const clientInbox = new WsInbox();
  const clientSocket = await app.injectWS("/ws/client", { headers: { cookie, origin } }, {
    onInit: (socket) => clientInbox.attach(socket),
  });
  sockets.push(clientSocket);
  await clientInbox.next("welcome");
  clientSocket.send(JSON.stringify({ type: "subscribe", logicalSessionId: session.logicalSessionId }));
  await clientInbox.next("snapshot");

  agentSocket.send(JSON.stringify({
    type: "volatile",
    eventType: "agent_message.delta",
    producerEpoch: "producer-epoch-1",
    appServerEpoch: "app-server-epoch-1",
    projectId,
    logicalSessionId: session.logicalSessionId,
    executionSegmentId: session.executionSegmentId,
    nativeThreadId: "native-thread-1",
    nativeTurnId: "native-turn-1",
    nativeItemId: "native-item-1",
    payload: { delta: "streamed, never persisted" },
  }));
  const volatile = await clientInbox.next("volatile");
  assert.equal((volatile.payload as Record<string, unknown>).delta, "streamed, never persisted");
  assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM durable_events")?.count, 0);

  const baseEvent = {
    logicalSessionId: session.logicalSessionId,
    executionSegmentId: session.executionSegmentId,
    projectId,
    producerEpoch: "producer-epoch-1",
    appServerEpoch: "app-server-epoch-1",
    schemaVersion: "1.0",
    occurredAt: new Date().toISOString(),
  };
  const startedPayload = { commandId: startCommandId, status: "running" };
  agentSocket.send(JSON.stringify({
    type: "event.append",
    event: {
      ...baseEvent,
      eventId: "event-turn-started-0001",
      payloadHash: payloadHash(startedPayload),
      hostSeq: 1,
      nativeThreadId: "native-thread-1",
      nativeTurnId: "native-turn-1",
      type: "turn.started",
      payload: startedPayload,
    },
  }));
  const eventOneAck = await agentInbox.next("event.ack");
  assert.equal(eventOneAck.sessionSeq, 1);
  await clientInbox.next("event");

  const gapPayload = { status: "done" };
  agentSocket.send(JSON.stringify({
    type: "event.append",
    event: {
      ...baseEvent,
      eventId: "event-turn-completed-0003",
      payloadHash: payloadHash(gapPayload),
      hostSeq: 3,
      nativeTurnId: "native-turn-1",
      type: "turn.completed",
      payload: gapPayload,
    },
  }));
  const gap = await agentInbox.next("event.nack");
  assert.equal(gap.code, "HOST_SEQUENCE_GAP");
  assert.equal(gap.expectedHostSeq, 2);

  const approvalPayload = {
    approvalId: "approval-0001",
    approvalVersion: 1,
    actionHash: "sha256:approval-action",
    context: { command: ["npm", "test"], cwd: "/work/agentfleet", risk: "writes files" },
  };
  agentSocket.send(JSON.stringify({
    type: "event.append",
    event: {
      ...baseEvent,
      eventId: "event-approval-0002",
      payloadHash: payloadHash(approvalPayload),
      hostSeq: 2,
      nativeTurnId: "native-turn-1",
      type: "approval.requested",
      payload: approvalPayload,
    },
  }));
  assert.equal((await agentInbox.next("event.ack")).sessionSeq, 2);

  const approvalDecision = await app.inject({
    method: "POST",
    url: "/api/approvals/approval-0001/decision",
    headers: browserHeaders,
    payload: { clientMutationId: "approval-decision-0001", decision: "approve" },
  });
  assert.equal(approvalDecision.statusCode, 202, approvalDecision.body);
  const approvalOffer = await agentInbox.next("command.offer");
  assert.equal((approvalOffer.command as Record<string, unknown>).type, "approval.decide_once");
  for (const state of ["claimed", "invoking", "responded", "applied"]) {
    agentSocket.send(JSON.stringify({ type: "command.ack", dispatchAttemptId: approvalOffer.dispatchAttemptId, state }));
    await agentInbox.next("command.ack.confirmed");
  }

  agentSocket.send(JSON.stringify({
    type: "event.append",
    event: {
      ...baseEvent,
      eventId: "event-turn-completed-0003",
      payloadHash: payloadHash(gapPayload),
      hostSeq: 3,
      nativeTurnId: "native-turn-1",
      type: "turn.completed",
      payload: gapPayload,
    },
  }));
  assert.equal((await agentInbox.next("event.ack")).sessionSeq, 3);

  const restartChallengeResponse = await app.inject({
    method: "POST",
    url: "/api/agent/auth/challenge",
    payload: { ...agentCredential, transportGeneration: 2 },
  });
  assert.equal(restartChallengeResponse.statusCode, 200, restartChallengeResponse.body);
  const restartChallenge = json<{ challengeId: string; message: string }>(restartChallengeResponse.body);
  const restartTicketResponse = await app.inject({
    method: "POST",
    url: "/api/agent/auth/ticket",
    payload: {
      machineId: agentCredential.machineId,
      challengeId: restartChallenge.challengeId,
      transportGeneration: 2,
      signature: sign(null, Buffer.from(restartChallenge.message), privateKey).toString("base64url"),
    },
  });
  assert.equal(restartTicketResponse.statusCode, 200, restartTicketResponse.body);
  const restartedInbox = new WsInbox();
  const restartedSocket = await app.injectWS(
    `/ws/agent?ticket=${encodeURIComponent(json<{ ticket: string }>(restartTicketResponse.body).ticket)}`,
    {},
    { onInit: (socket) => restartedInbox.attach(socket) },
  );
  sockets.push(restartedSocket);
  await restartedInbox.next("welcome");
  restartedSocket.send(JSON.stringify({
    type: "hello",
    producerEpoch: "producer-epoch-2",
    appServerEpoch: "app-server-epoch-2",
    agentVersion: "0.16.2",
    capabilities: { commandTypes: COMMAND_TYPES },
    codexVersion: "0.153.4",
    schemaHash: "d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a",
    credentialProtectionLevel: "software_protected",
    platform: "linux",
    platformRelease: "24.04",
    architecture: "x86_64",
    capacity: "idle",
    reconciliationStreams: [
      { producerEpoch: "producer-epoch-1", throughHostSeq: 4 },
      { producerEpoch: "producer-epoch-2", throughHostSeq: 0 },
    ],
    resumeStreams: [{
      producerEpoch: "producer-epoch-1",
      firstRetainedHostSeq: 4,
      lastProducedHostSeq: 4,
      lastAckedHostSeq: 3,
    }],
    projects: [{
      externalId: "local-project-a",
      alias: "AgentFleet",
      canonicalRoot: "/work/agentfleet",
      identityHash: "sha256:project-a",
      leaseVersion: 1,
    }],
    sessions: [{
      externalId: session.logicalSessionId,
      projectExternalId: "local-project-a",
      executionSegmentExternalId: session.executionSegmentId,
      title: "Integration session",
      managed: true,
      nativeThreadId: "native-thread-1",
      executionState: "completed",
      threadControlVersion: 0,
      turnControlVersion: 1,
      historyCompleteness: "complete",
    }],
  }));
  const restartedHelloAck = await restartedInbox.next("hello.ack");
  const replayPayload = { item: "captured-before-restart" };
  restartedSocket.send(JSON.stringify({
    type: "event.append",
    event: {
      ...baseEvent,
      eventId: "event-old-epoch-replay-0004",
      payloadHash: payloadHash(replayPayload),
      hostSeq: 4,
      type: "item.completed",
      payload: replayPayload,
    },
  }));
  const oldEpochAck = await restartedInbox.next("event.ack");
  assert.equal(oldEpochAck.nextExpectedHostSeq, 5);
  restartedSocket.send(JSON.stringify({
    type: "event.append",
    event: {
      ...baseEvent,
      producerEpoch: "producer-epoch-2",
      appServerEpoch: "app-server-epoch-2",
      eventId: "event-new-epoch-0001",
      payloadHash: payloadHash({ item: "after-restart" }),
      hostSeq: 1,
      type: "item.completed",
      payload: { item: "after-restart" },
    },
  }));
  const newEpochAck = await restartedInbox.next("event.ack");
  assert.equal(newEpochAck.nextExpectedHostSeq, 2);
  await completeReconciliation(
    restartedSocket,
    restartedInbox,
    restartedHelloAck,
    [
      { producerEpoch: "producer-epoch-1", throughHostSeq: 4 },
      { producerEpoch: "producer-epoch-2", throughHostSeq: 0 },
    ],
  );
  assert.deepEqual(
    { ...db.get<{ thread_control_version: number; turn_control_version: number }>(
      "SELECT thread_control_version,turn_control_version FROM logical_sessions WHERE logical_session_id=?",
      session.logicalSessionId,
    ) },
    { thread_control_version: 1, turn_control_version: 3 },
    "an Agent hello snapshot cannot roll back Control-Plane-owned control versions",
  );
  const staleVersionCommand = await app.inject({
    method: "POST",
    url: `/api/sessions/${session.logicalSessionId}/commands`,
    headers: browserHeaders,
    payload: {
      clientMutationId: "stale-hello-control-version",
      controlLeaseId: lease.leaseId,
      type: "turn.start",
      precondition: {
        executionSegmentId: session.executionSegmentId,
        threadControlVersion: 0,
        expectedActiveTurnId: null,
        projectLeaseVersion: sessionViewBody.session.projectLeaseVersion,
      },
      payload: { prompt: "must fail against the retained CP version" },
    },
  });
  assert.equal(staleVersionCommand.statusCode, 409, staleVersionCommand.body);
  assert.equal(
    json<{ error: { code: string } }>(staleVersionCommand.body).error.code,
    "THREAD_VERSION_CONFLICT",
  );
  restartedSocket.send(JSON.stringify({
    type: "event.append",
    event: {
      ...baseEvent,
      eventId: "event-old-epoch-out-of-range-0005",
      payloadHash: payloadHash({ item: "not-declared" }),
      hostSeq: 5,
      type: "item.completed",
      payload: { item: "not-declared" },
    },
  }));
  assert.equal((await restartedInbox.next("event.nack")).code, "PRODUCER_EPOCH_SEALED");

  const secondLogin = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin, "content-type": "application/json" },
    payload: { email: "admin@example.test", password: "correct horse battery staple" },
  });
  const secondLoginBody = json<LoginResult>(secondLogin.body);
  const secondCookie = cookieFromSetCookie(secondLogin.headers["set-cookie"]);
  const secondHeaders = { cookie: secondCookie, ...csrfHeaders(secondLoginBody.csrfToken, origin) };
  const leaseConflict = await app.inject({
    method: "POST",
    url: `/api/sessions/${session.logicalSessionId}/control-lease`,
    headers: secondHeaders,
    payload: { expectedVersion: lease.version },
  });
  assert.equal(leaseConflict.statusCode, 200, leaseConflict.body);
  assert.equal(json<{ leaseId: string }>(leaseConflict.body).leaseId, lease.leaseId, "same account shares the existing lease");
  lease.version = json<{ version: number }>(leaseConflict.body).version;
  const release = await app.inject({
    method: "DELETE",
    url: `/api/sessions/${session.logicalSessionId}/control-lease/${lease.leaseId}`,
    headers: browserHeaders,
    payload: { expectedVersion: lease.version },
  });
  assert.equal(release.statusCode, 200, release.body);
  const secondAcquire = await app.inject({
    method: "POST",
    url: `/api/sessions/${session.logicalSessionId}/control-lease`,
    headers: secondHeaders,
    payload: { expectedVersion: lease.version + 1 },
  });
  assert.equal(secondAcquire.statusCode, 200, secondAcquire.body);

  const deleteContent = await app.inject({
    method: "DELETE",
    url: `/api/sessions/${session.logicalSessionId}/content`,
    headers: browserHeaders,
    payload: {},
  });
  assert.equal(deleteContent.statusCode, 410, deleteContent.body);
  assert.match(deleteContent.body, /CLOUD_CONTENT_DELETE_REMOVED/);
  assert.equal(db.get<{ content_epoch: number }>("SELECT content_epoch FROM logical_sessions WHERE logical_session_id=?", session.logicalSessionId)?.content_epoch, 1);
  assert.equal(db.get<{ count: number }>("SELECT count(*) AS count FROM durable_events WHERE logical_session_id=? AND payload_state='deleted'", session.logicalSessionId)?.count, 0);
  // Keep regression coverage for historical tombstones/retention without
  // restoring a user-facing cloud-only deletion endpoint.
  const deletion = new CoordinationService(db, config()).deleteSessionContent(
    new AuthService(db, config()).authenticateToken(cookie.slice(cookie.indexOf("=") + 1)), session.logicalSessionId);
  assert.equal(deletion.deletedEvents, 5);
  assert.equal(deletion.contentEpoch, 2);

  const stalePayload = { status: "running", secret: "must not return" };
  restartedSocket.send(JSON.stringify({
    type: "event.append",
    event: {
      ...baseEvent,
      producerEpoch: "producer-epoch-2",
      appServerEpoch: "app-server-epoch-2",
      eventId: "event-stale-content-0002",
      payloadHash: payloadHash(stalePayload),
      hostSeq: 2,
      nativeTurnId: "stale-turn-must-not-project",
      type: "turn.started",
      contentEpoch: 1,
      payload: stalePayload,
    },
  }));
  assert.equal((await restartedInbox.next("event.ack")).nextExpectedHostSeq, 3);
  const staleRow = db.get<{ payload_state: string; payload_ref: string | null }>(
    "SELECT payload_state,payload_ref FROM durable_events WHERE event_id='event-stale-content-0002'",
  );
  assert.equal(staleRow?.payload_state, "deleted");
  assert.equal(staleRow?.payload_ref, null);
  const postStaleSession = await app.inject({
    method: "GET",
    url: `/api/sessions/${session.logicalSessionId}`,
    headers: { cookie },
  });
  assert.equal(json<{ session: { executionState: string } }>(postStaleSession.body).session.executionState, "completed");

  const freshPayload = { item: "created after deletion" };
  restartedSocket.send(JSON.stringify({
    type: "event.append",
    event: {
      ...baseEvent,
      producerEpoch: "producer-epoch-2",
      appServerEpoch: "app-server-epoch-2",
      eventId: "event-current-content-0003",
      payloadHash: payloadHash(freshPayload),
      hostSeq: 3,
      type: "item.completed",
      contentEpoch: 2,
      payload: freshPayload,
    },
  }));
  assert.equal((await restartedInbox.next("event.ack")).nextExpectedHostSeq, 4);
  db.run(
    `UPDATE content_blobs SET expires_at='2000-01-01T00:00:00.000Z'
     WHERE payload_ref=(SELECT payload_ref FROM durable_events WHERE event_id='event-current-content-0003')`,
  );
  assert.ok(runMaintenance().expiredContent >= 1);
  const replay = await app.inject({
    method: "GET",
    url: `/api/sessions/${session.logicalSessionId}/events?afterSeq=0`,
    headers: { cookie },
  });
  const replayed = json<{ events: Array<Record<string, unknown>> }>(replay.body).events;
  assert.equal(replayed.length, 7);
  assert.ok(replayed.every((event) => event.payloadState === "deleted" && !("payload" in event)));
  assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM content_tombstones")?.count, 7);

  const revokeSecond = await app.inject({
    method: "DELETE",
    url: `/api/client-sessions/${secondLoginBody.clientSessionId}`,
    headers: { cookie, origin, "x-csrf-token": loginBody.csrfToken },
  });
  assert.equal(revokeSecond.statusCode, 200, revokeSecond.body);
  const revokedMe = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: secondCookie } });
  assert.equal(revokedMe.statusCode, 401, revokedMe.body);

  const beforeManagementRelease = json<{
    session: {
      nativeThreadId: string;
      threadControlVersion: number;
      projectLeaseVersion: number;
      controlLeaseVersion: number;
    };
  }>((await app.inject({
    method: "GET",
    url: `/api/sessions/${session.logicalSessionId}`,
    headers: { cookie },
  })).body).session;
  const managementLeaseResponse = await app.inject({
    method: "POST",
    url: `/api/sessions/${session.logicalSessionId}/control-lease`,
    headers: browserHeaders,
    payload: { expectedVersion: beforeManagementRelease.controlLeaseVersion },
  });
  assert.equal(managementLeaseResponse.statusCode, 200, managementLeaseResponse.body);
  const managementLease = json<{ leaseId: string; version: number }>(managementLeaseResponse.body);
  const managementReleaseResponse = await app.inject({
    method: "POST",
    url: `/api/sessions/${session.logicalSessionId}/commands`,
    headers: browserHeaders,
    payload: {
      clientMutationId: "release-thread-management-0001",
      controlLeaseId: managementLease.leaseId,
      type: "thread.release",
      precondition: {
        nativeThreadId: beforeManagementRelease.nativeThreadId,
        threadControlVersion: beforeManagementRelease.threadControlVersion,
        expectedActiveTurnId: null,
        projectLeaseVersion: beforeManagementRelease.projectLeaseVersion,
      },
      payload: {},
    },
  });
  assert.equal(managementReleaseResponse.statusCode, 202, managementReleaseResponse.body);
  const managementReleaseOffer = await restartedInbox.next("command.offer");
  const managementReleaseCommand = managementReleaseOffer.command as Record<string, unknown>;
  assert.equal(managementReleaseCommand.type, "thread.release");
  assert.equal(
    (managementReleaseCommand.precondition as Record<string, unknown>).nativeThreadId,
    beforeManagementRelease.nativeThreadId,
  );
  const managementReleaseAttemptId = managementReleaseOffer.dispatchAttemptId as string;
  for (const state of ["claimed", "invoking", "responded", "applied"]) {
    restartedSocket.send(JSON.stringify({ type: "command.ack", dispatchAttemptId: managementReleaseAttemptId, state }));
    await restartedInbox.next("command.ack.confirmed");
  }
  const releasedPayload = {
    commandId: managementReleaseCommand.commandId,
    hostThreadPreserved: true,
    hostHistoryPreserved: true,
  };
  restartedSocket.send(JSON.stringify({
    type: "event.append",
    event: {
      ...baseEvent,
      producerEpoch: "producer-epoch-2",
      appServerEpoch: "app-server-epoch-2",
      eventId: "event-thread-released-0004",
      payloadHash: payloadHash(releasedPayload),
      hostSeq: 4,
      nativeThreadId: beforeManagementRelease.nativeThreadId,
      type: "thread.released",
      contentEpoch: 2,
      payload: releasedPayload,
    },
  }));
  assert.equal((await restartedInbox.next("event.ack")).nextExpectedHostSeq, 5);
  const afterManagementRelease = json<{ session: { managed: boolean; executionState: string; controlLease: unknown } }>((await app.inject({
    method: "GET",
    url: `/api/sessions/${session.logicalSessionId}`,
    headers: { cookie },
  })).body).session;
  assert.equal(afterManagementRelease.managed, false);
  assert.equal(afterManagementRelease.executionState, "idle");
  assert.equal(afterManagementRelease.controlLease, null);
  assert.equal(
    db.get<{ state: string }>("SELECT state FROM control_leases WHERE control_lease_id=?", managementLease.leaseId)?.state,
    "revoked",
  );

  // Rediscovery names native threads differently from cloud-created sessions.
  // Neither a changed external id nor a stale management snapshot may duplicate
  // the conversation or undo a durably confirmed release.
  const rehello = (managed: boolean, managementRevision: number) => ({
    type: "hello", producerEpoch: "producer-epoch-2", appServerEpoch: "app-server-epoch-2",
    agentVersion: "0.17.0", capabilities: { commandTypes: COMMAND_TYPES },
    codexVersion: "0.153.4", schemaHash: "d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a",
    credentialProtectionLevel: "software_protected", platform: "linux", platformRelease: "24.04", architecture: "x86_64", capacity: "idle",
    reconciliationStreams: [{ producerEpoch: "producer-epoch-2", throughHostSeq: 4 }],
    projects: [{ externalId: "local-project-a", alias: "AgentFleet", canonicalRoot: "/work/agentfleet", identityHash: "sha256:project-a", leaseVersion: 1 }],
    sessions: [{ externalId: "native-thread-1", executionSegmentExternalId: "native-thread-1", projectExternalId: "local-project-a",
      nativeThreadId: "native-thread-1", managed, managementRevision, codexProfileId: "default", sessionCwd: "/work/agentfleet/packages/web",
      executionState: "idle", threadControlVersion: 1, historyMode: "legacy", historyCompleteness: "partial" }],
  });
  const countBeforeRediscovery = db.get<{ count: number }>("SELECT count(*) AS count FROM logical_sessions")!.count;
  const titleBeforeRediscovery = db.get<{ title: string }>("SELECT title FROM logical_sessions WHERE logical_session_id=?", session.logicalSessionId)!.title;
  for (const [managed, revision] of [[true, 1], [false, 2]] as const) {
    const snapshot = rehello(managed, revision);
    Object.assign(snapshot.sessions[0]!, { title: "部署", titleSource: "preview" });
    restartedSocket.send(JSON.stringify(snapshot));
    const ack = await restartedInbox.next("hello.ack");
    assert.equal((ack.sessions as Record<string, string>)["native-thread-1"], session.logicalSessionId);
    await completeReconciliation(restartedSocket, restartedInbox, ack, snapshot.reconciliationStreams);
    const record = db.get<{ managed: number; session_cwd: string }>("SELECT managed,session_cwd FROM logical_sessions WHERE logical_session_id=?", session.logicalSessionId)!;
    assert.equal(record.managed, 0, "stale hello must not undo thread.released");
    assert.equal(record.session_cwd, "/work/agentfleet/packages/web");
    assert.equal(db.get<{ title: string }>("SELECT title FROM logical_sessions WHERE logical_session_id=?", session.logicalSessionId)!.title, titleBeforeRediscovery);
    assert.equal(db.get<{ count: number }>("SELECT count(*) AS count FROM logical_sessions")!.count, countBeforeRediscovery);
  }
  const versionBeforeRename = db.get<{ thread_control_version: number }>("SELECT thread_control_version FROM logical_sessions WHERE logical_session_id=?", session.logicalSessionId)!.thread_control_version;
  const renamed = rehello(false, 2);
  Object.assign(renamed.sessions[0]!, { title: "主动改名", titleSource: "name" });
  restartedSocket.send(JSON.stringify(renamed));
  const renamedAck = await restartedInbox.next("hello.ack");
  await completeReconciliation(restartedSocket, restartedInbox, renamedAck, renamed.reconciliationStreams);
  assert.equal(db.get<{ title: string }>("SELECT title FROM logical_sessions WHERE logical_session_id=?", session.logicalSessionId)!.title, "主动改名");
  assert.equal(db.get<{ thread_control_version: number }>("SELECT thread_control_version FROM logical_sessions WHERE logical_session_id=?", session.logicalSessionId)!.thread_control_version, versionBeforeRename + 1, "Host rename invalidates stale action preconditions");
  Object.assign(renamed.sessions[0]!, { runtimeSettings: { archived: true } });
  for (let index = 0; index < 2; index++) {
    restartedSocket.send(JSON.stringify(renamed));
    const archivedAck = await restartedInbox.next("hello.ack");
    await completeReconciliation(restartedSocket, restartedInbox, archivedAck, renamed.reconciliationStreams);
    const metadata = db.get<{ runtime_settings_json: string; thread_control_version: number }>("SELECT runtime_settings_json,thread_control_version FROM logical_sessions WHERE logical_session_id=?", session.logicalSessionId)!;
    assert.equal(JSON.parse(metadata.runtime_settings_json).archived, true);
    assert.equal(metadata.thread_control_version, versionBeforeRename + 2, "Only a changed archive state invalidates action preconditions");
  }


  const durableCount = db.get<{ count: number }>("SELECT COUNT(*) AS count FROM durable_events");
  assert.equal(durableCount?.count, 8);
  const auditCount = db.get<{ count: number }>("SELECT COUNT(*) AS count FROM audit_entries");
  assert.ok((auditCount?.count ?? 0) >= 8);
});

test("origin and CSRF baseline reject cross-site mutations", async (t) => {
  const { app } = await buildControlPlane(config());
  t.after(async () => app.close());
  await app.ready();
  const noOrigin = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin@example.test", password: "correct horse battery staple" },
  });
  assert.equal(noOrigin.statusCode, 403);

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin },
    payload: { email: "admin@example.test", password: "correct horse battery staple" },
  });
  const cookie = cookieFromSetCookie(login.headers["set-cookie"]);
  const missingCsrf = await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: { origin, cookie },
  });
  assert.equal(missingCsrf.statusCode, 403);
  const crossSite = await app.inject({
    method: "POST",
    url: "/api/auth/logout",
    headers: { origin: "https://evil.example", cookie, "x-csrf-token": json<LoginResult>(login.body).csrfToken },
  });
  assert.equal(crossSite.statusCode, 403);
});

test("Project turn reservation atomically fences concurrent starts and keeps UNKNOWN frozen", async (t) => {
  const testConfig = config();
  const { app, db } = await buildControlPlane(testConfig);
  t.after(async () => app.close());
  await app.ready();
  assert.equal(
    Number((db.sqlite.prepare("PRAGMA user_version").get() as { user_version: number }).user_version),
    26,
  );

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin, "content-type": "application/json" },
    payload: { email: "admin@example.test", password: "correct horse battery staple" },
  });
  assert.equal(login.statusCode, 200, login.body);
  const loginBody = json<LoginResult>(login.body);
  const cookie = cookieFromSetCookie(login.headers["set-cookie"]);
  const browserHeaders = { cookie, ...csrfHeaders(loginBody.csrfToken, origin) };
  const owner = db.get<{ workspace_id: string; user_id: string }>(
    "SELECT workspace_id,user_id FROM users WHERE email=?",
    "admin@example.test",
  );
  assert.ok(owner);

  const timestamp = new Date().toISOString();
  const machineId = "mach_project_reservation";
  const projectId = "proj_project_reservation";
  db.run(
    `INSERT INTO machines(
      machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,
      platform_release,architecture,agent_version,identity_state,security_state,reachability,
      compatibility,capacity,last_heartbeat_at,created_at,updated_at,codex_version,schema_hash,
      credential_protection_level
    ) VALUES(?,?,?,?,?,?,?,?,?,'active','normal','online','compatible','idle',?,?,?,?,?,?)`,
    machineId,
    owner.workspace_id,
    "reservation-test-public-key",
    "reservation-test-fingerprint",
    "reservation-host",
    "linux",
    "24.04",
    "x86_64",
    "0.1.0",
    timestamp,
    timestamp,
    timestamp,
    "0.153.2",
    "sha256:d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a",
    "software_protected",
  );
  db.run(
    `INSERT INTO projects(
      project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,
      lease_version,created_at,last_reported_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    projectId,
    owner.workspace_id,
    machineId,
    "local-project-reservation",
    "Reservation Project",
    "/work/reservation",
    "sha256:reservation-project",
    1,
    timestamp,
    timestamp,
  );

  type CreatedSession = {
    logicalSessionId: string;
    executionSegmentId: string;
    threadControlVersion: number;
    projectLeaseVersion: number;
  };
  const sessions: CreatedSession[] = [];
  for (const title of ["Concurrent A", "Concurrent B", "After terminal"]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: browserHeaders,
      payload: { machineId, projectId, title },
    });
    assert.equal(response.statusCode, 200, response.body);
    sessions.push(json<CreatedSession>(response.body));
  }
  const leases: Array<{ leaseId: string }> = [];
  // Preferences are cloud defaults, not an assertion that the host has applied them.
  const catalog = { models: [{ model: "test-model", displayName: "Test", efforts: ["low", "high"], defaultEffort: "low" }], modes: ["default", "plan"], fetchedAt: timestamp };
  db.run("UPDATE machines SET codex_catalog_json=? WHERE machine_id=?", JSON.stringify(catalog), machineId);
  const settingsUrl = `/api/sessions/${sessions[0]!.logicalSessionId}/codex-settings`;
  const noAuth = await app.inject({ method: "GET", url: settingsUrl });
  assert.equal(noAuth.statusCode, 401);
  const saveSettings = async (scope: string, settings: unknown, revision: number) => app.inject({ method: "PUT", url: settingsUrl, headers: browserHeaders, payload: { scope, settings, revision } });
  assert.equal((await saveSettings("machine", { model: "other-host-model" }, 0)).statusCode, 409);
  assert.equal((await saveSettings("machine", { model: "test-model", config: { sandbox: "unsafe" } }, 0)).statusCode, 400);
  assert.equal((await saveSettings("machine", { model: "test-model", effort: "low" }, 0)).statusCode, 200);
  assert.equal((await saveSettings("machine", { model: "test-model", effort: "high" }, 0)).statusCode, 409);
  assert.equal((await saveSettings("session", { model: "test-model", effort: "high", mode: "plan" }, 0)).statusCode, 200);
  const saved = json<{ source: string; desired: { effort: string } }>((await app.inject({ method: "GET", url: settingsUrl, headers: browserHeaders })).body);
  assert.equal(saved.source, "session"); assert.equal(saved.desired.effort, "high");
  const inherited = json<{ source: string; desired: { effort: string } }>((await saveSettings("session", null, 1)).body);
  assert.equal(inherited.source, "machine"); assert.equal(inherited.desired.effort, "low");
  assert.equal((await saveSettings("machine", null, 1)).statusCode, 200);
  const machineSettingsUrl = `/api/machines/${machineId}/codex-settings`;
  assert.equal((await app.inject({ method: "GET", url: machineSettingsUrl })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/machines/not-in-workspace/codex-settings", headers: browserHeaders })).statusCode, 404);
  const hostDefault = { model: "test-model", effort: "high", mode: "plan" };
  assert.equal((await app.inject({ method: "PUT", url: machineSettingsUrl, headers: browserHeaders, payload: { settings: hostDefault, revision: 2 } })).statusCode, 200);
  assert.equal((await app.inject({ method: "PUT", url: machineSettingsUrl, headers: browserHeaders, payload: { settings: hostDefault, revision: 2 } })).statusCode, 409);
  const fromHost = json<{ source: string; desired: unknown }>((await app.inject({ method: "GET", url: settingsUrl, headers: browserHeaders })).body);
  assert.equal(fromHost.source, "machine"); assert.deepEqual(fromHost.desired, hostDefault);
  assert.equal((await app.inject({ method: "PUT", url: machineSettingsUrl, headers: browserHeaders, payload: { scope: "session", settings: hostDefault, revision: 3 } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PUT", url: machineSettingsUrl, headers: browserHeaders, payload: { settings: null, revision: 3 } })).statusCode, 200);
  for (const session of sessions) {
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.logicalSessionId}/control-lease`,
      headers: browserHeaders,
      payload: { expectedVersion: 0 },
    });
    assert.equal(response.statusCode, 200, response.body);
    leases.push(json<{ leaseId: string }>(response.body));
  }

  const startPayload = (session: CreatedSession, leaseId: string, mutation: string) => ({
    clientMutationId: mutation,
    controlLeaseId: leaseId,
    type: "turn.start",
    precondition: {
      executionSegmentId: session.executionSegmentId,
      threadControlVersion: session.threadControlVersion,
      expectedActiveTurnId: null,
      projectLeaseVersion: session.projectLeaseVersion,
    },
    payload: { prompt: mutation },
  });
  // Isolate native-command coverage from the reservation scenario below.
  const originalTransaction = db.transaction.bind(db);
  db.transaction = function<T>(operation: () => T): T {
    db.sqlite.exec("SAVEPOINT native_inner");
    try { const result = operation(); db.sqlite.exec("RELEASE native_inner"); return result; }
    catch (error) { db.sqlite.exec("ROLLBACK TO native_inner; RELEASE native_inner"); throw error; }
  };
  db.sqlite.exec("SAVEPOINT native_commands_test");
  try {
    const session = sessions[0]!;
    const url = `/api/sessions/${session.logicalSessionId}/commands`;
    db.run("UPDATE machines SET command_types_json=? WHERE machine_id=?", JSON.stringify(COMMAND_TYPES), machineId);
    db.run("UPDATE execution_segments SET native_thread_id='native-test' WHERE execution_segment_id=?", session.executionSegmentId);
    const request = { ...startPayload(session, leases[0]!.leaseId, "native-rename-test"), type: "thread.rename", precondition: { nativeThreadId: "native-test", threadControlVersion: session.threadControlVersion, expectedActiveTurnId: null, projectLeaseVersion: session.projectLeaseVersion }, payload: { name: "Renamed on host" } };
    const rename = await app.inject({ method: "POST", url, headers: browserHeaders, payload: request });
    assert.equal(rename.statusCode, 202, rename.body);
    const storedRename = db.get<{ precondition_json: string }>("SELECT precondition_json FROM commands WHERE client_mutation_id=?", request.clientMutationId)!;
    assert.equal(JSON.parse(storedRename.precondition_json).expectedTitle, db.get<{ title: string }>("SELECT title FROM logical_sessions WHERE logical_session_id=?", session.logicalSessionId)!.title);

    assert.equal((await app.inject({ method: "POST", url, headers: browserHeaders, payload: request })).statusCode, 200, "same mutation must replay");
    const blocked = await app.inject({ method: "POST", url, headers: browserHeaders, payload: startPayload(session, leases[0]!.leaseId, "native-race-start") });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.equal(json<{ error: { code: string } }>(blocked.body).error.code, "NATIVE_OPERATION_PENDING");
  } finally { db.sqlite.exec("ROLLBACK TO native_commands_test; RELEASE native_commands_test"); }
  db.sqlite.exec("SAVEPOINT native_delete_test");
  try {
    const session = sessions[0]!; const child = sessions[2]!;
    const url = `/api/sessions/${session.logicalSessionId}/commands`;
    db.run("UPDATE machines SET command_types_json=? WHERE machine_id=?", JSON.stringify(COMMAND_TYPES), machineId);
    db.run("UPDATE execution_segments SET native_thread_id='delete-root' WHERE execution_segment_id=?", session.executionSegmentId);
    db.run("UPDATE execution_segments SET native_thread_id='delete-child' WHERE execution_segment_id=?", child.executionSegmentId);
    const service = new CoordinationService(db,testConfig) as unknown as {setCommandState:(id:string,state:string,detail:Record<string,unknown>)=>void};
    const input = {...startPayload(session,leases[0]!.leaseId,"delete-preview"),type:"thread.delete.preview",payload:{},precondition:{nativeThreadId:"delete-root",executionSegmentId:session.executionSegmentId,threadControlVersion:session.threadControlVersion,expectedActiveTurnId:null,projectLeaseVersion:session.projectLeaseVersion}};
    const preview = await app.inject({method:"POST",url,headers:browserHeaders,payload:input});
    assert.equal(preview.statusCode,202,preview.body);
    const previewId = json<{command:{commandId:string}}>(preview.body).command.commandId;
    const plan = {nativeThreadId:"delete-root",fingerprint:"confirmed-scope",expiresAt:new Date(Date.now()+300000).toISOString(),threads:[{id:"delete-root"},{id:"delete-child"}]};
    service.setCommandState(previewId,"applied",{ok:true,response:{deletionPreview:plan}});
    const confirm = {...input,type:"thread.delete",clientMutationId:"delete-confirm",payload:{previewCommandId:previewId,fingerprint:plan.fingerprint}};
    const mismatch = await app.inject({method:"POST",url,headers:browserHeaders,payload:{...confirm,payload:{...confirm.payload,fingerprint:"other"}}});
    assert.equal(mismatch.statusCode,409,mismatch.body);
    const accepted = await app.inject({method:"POST",url,headers:browserHeaders,payload:confirm});
    assert.equal(accepted.statusCode,202,accepted.body);
    const commandId = json<{command:{commandId:string}}>(accepted.body).command.commandId;
    assert.equal(db.get<{deleted_at:string|null}>("SELECT deleted_at FROM logical_sessions WHERE logical_session_id=?",session.logicalSessionId)?.deleted_at,null,"Confirmation alone never deletes a cloud session");
    assert.throws(()=>service.setCommandState(commandId,"applied",{ok:true,response:{nativeThreadId:"delete-root",deletedNativeThreadIds:["delete-root","other"]}}),/does not match/);
    assert.equal(db.get<{state:string}>("SELECT state FROM command_projection WHERE command_id=?",commandId)?.state,"accepted");
    service.setCommandState(commandId,"applied",{ok:true,response:{nativeThreadId:"delete-root",deletedNativeThreadIds:["delete-child","delete-root"]}});
    for(const target of [session,child]) {
      assert.ok(db.get<{deleted_at:string|null}>("SELECT deleted_at FROM logical_sessions WHERE logical_session_id=?",target.logicalSessionId)?.deleted_at);
      const gone = await app.inject({method:"GET",url:`/api/sessions/${target.logicalSessionId}`,headers:browserHeaders});
      assert.equal(gone.statusCode,410,gone.body);
    }
    assert.equal(db.get<{deleted_at:string|null}>("SELECT deleted_at FROM logical_sessions WHERE logical_session_id=?",sessions[1]!.logicalSessionId)?.deleted_at,null,"Unrelated session remains");
    assert.equal(db.get<{n:number}>("SELECT COUNT(*) AS n FROM native_session_deletions")?.n,2);
  } finally { db.sqlite.exec("ROLLBACK TO native_delete_test; RELEASE native_delete_test"); }
  db.sqlite.exec("SAVEPOINT terminal_stop_test");
  try {
    const session = sessions[0]!;
    db.run("UPDATE machines SET command_types_json=? WHERE machine_id=?", JSON.stringify(COMMAND_TYPES), machineId);
    db.run("UPDATE execution_segments SET native_thread_id='native-test' WHERE execution_segment_id=?", session.executionSegmentId);
    const input = { ...startPayload(session, leases[0]!.leaseId, "terminal-stop-test"), type: "thread.terminals.stop", payload: {}, precondition: { nativeThreadId: "native-test", executionSegmentId: session.executionSegmentId, expectedActiveTurnId: null, threadControlVersion: session.threadControlVersion, projectLeaseVersion: session.projectLeaseVersion } };
    const url = `/api/sessions/${session.logicalSessionId}/commands`;
    const bad = await app.inject({ method: "POST", url, headers: browserHeaders, payload: { ...input, precondition: { ...input.precondition, nativeThreadId: "other" } } });
    assert.equal(bad.statusCode, 409);
    const accepted = await app.inject({ method: "POST", url, headers: browserHeaders, payload: input });
    assert.equal(accepted.statusCode, 202, accepted.body);
    assert.equal((await app.inject({ method: "POST", url, headers: browserHeaders, payload: input })).statusCode, 200);
    assert.equal(db.get("SELECT 1 FROM project_turn_reservations WHERE project_id=?", projectId), undefined, "terminal stop does not create a turn");
  } finally { db.sqlite.exec("ROLLBACK TO terminal_stop_test; RELEASE terminal_stop_test"); }
  for (const nativeType of ["turn.compact", "turn.review"]) {
    db.sqlite.exec("SAVEPOINT native_turn_test");
    try {
      const session = sessions[0]!;
      db.run("UPDATE machines SET command_types_json=? WHERE machine_id=?", JSON.stringify(COMMAND_TYPES), machineId);
      db.run("UPDATE execution_segments SET native_thread_id='native-test' WHERE execution_segment_id=?", session.executionSegmentId);
      const input = { ...startPayload(session, leases[0]!.leaseId, `test-${nativeType}`), type: nativeType, payload: {} };
      const result = await app.inject({ method: "POST", url: `/api/sessions/${session.logicalSessionId}/commands`, headers: browserHeaders, payload: input });
      assert.equal(result.statusCode, 202, result.body);
      assert.ok(db.get("SELECT 1 FROM project_turn_reservations WHERE project_id=?", projectId), "native turn must reserve project");
    } finally { db.sqlite.exec("ROLLBACK TO native_turn_test; RELEASE native_turn_test"); }
  }
  db.sqlite.exec("SAVEPOINT input_test");
  try {
    const session = sessions[0]!;
    db.run("UPDATE machines SET command_types_json=? WHERE machine_id=?", JSON.stringify(COMMAND_TYPES), machineId);
    db.run(`INSERT INTO approvals(approval_id,logical_session_id,execution_segment_id,action_hash,app_server_epoch,version,context_json,state,created_at) VALUES('input-test',?,?, 'input-hash','input-epoch',1,?,'pending',?)`, session.logicalSessionId, session.executionSegmentId,
      JSON.stringify({ expiresAt: new Date(Date.now() + 60_000).toISOString(), action: { kind: "user_input", questions: [{ id: "q" }] } }), timestamp);
    const input = { clientMutationId: "answer-input-test", type: "input.respond", precondition: { approvalId: "input-test", approvalVersion: 1, actionHash: "input-hash", appServerEpoch: "input-epoch" }, payload: { answers: { q: { answers: ["continue"] } } } };
    const url = `/api/sessions/${session.logicalSessionId}/commands`;
    const invalid = await app.inject({ method: "POST", url, headers: browserHeaders, payload: { ...input, type: "approval.decide_once", payload: { decision: "approve" } } });
    assert.equal(invalid.statusCode, 400, invalid.body);
    const incomplete = await app.inject({ method: "POST", url, headers: browserHeaders, payload: { ...input, payload: { answers: {} } } });
    assert.equal(incomplete.statusCode, 400, incomplete.body);
    const answer = await app.inject({ method: "POST", url, headers: browserHeaders, payload: input });
    assert.equal(answer.statusCode, 202, answer.body);
    const duplicate = await app.inject({ method: "POST", url, headers: browserHeaders, payload: input });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    const secondAnswer = await app.inject({ method: "POST", url, headers: browserHeaders, payload: { ...input, clientMutationId: "second-answer-test" } });
    assert.equal(secondAnswer.statusCode, 409, secondAnswer.body);
  } finally { db.sqlite.exec("ROLLBACK TO input_test; RELEASE input_test"); }
  db.sqlite.exec("SAVEPOINT permission_test");
  try {
    const session = sessions[0]!;
    const hostUrl = `/api/machines/${machineId}/permissions`;
    const permissionUrl = `/api/sessions/${session.logicalSessionId}/permissions`;
    const save = (scope: string, profile: unknown, revision: number, confirmFullAccess = false) => app.inject({ method: "PUT", url: scope === "machine" ? hostUrl : permissionUrl, headers: browserHeaders, payload: { scope, profile, revision, confirmFullAccess } });
    assert.equal((await app.inject({ method: "GET", url: hostUrl })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/api/machines/missing/permissions", headers: browserHeaders })).statusCode, 404);
    assert.equal((await save("machine", "network", 0)).statusCode, 409, "old agent must not claim permission support");
    db.run("UPDATE machines SET permission_profiles=1 WHERE machine_id=?", machineId);
    assert.equal((await save("machine", "full", 0)).statusCode, 400, "full access needs explicit confirmation");
    assert.equal((await save("machine", "network", 0)).statusCode, 200);
    assert.equal((await save("machine", "project", 0)).statusCode, 409, "stale edit rejected");
    // A model-only override must not freeze inherited permissions.
    assert.equal((await saveSettings("session", { model: "test-model" }, 2)).statusCode, 200);
    let inherited = json<{ profile: string; source: string }>((await app.inject({ method: "GET", url: permissionUrl, headers: browserHeaders })).body);
    assert.equal(inherited.source, "machine"); assert.equal(inherited.profile, "network");
    assert.equal((await save("project", "project", 0)).statusCode, 200);
    assert.equal((await save("session", "full", 0, true)).statusCode, 200);
    assert.equal((await save("session", null, 1)).statusCode, 200);
    inherited = json<{ profile: string; source: string }>((await app.inject({ method: "GET", url: permissionUrl, headers: browserHeaders })).body);
    assert.equal(inherited.source, "project"); assert.equal(inherited.profile, "project");
    assert.equal((await save("project", null, 1)).statusCode, 200);
    const request = { ...startPayload(session, leases[0]!.leaseId, "permission-snapshot"), payload: { prompt: "fixture", settings: { model: "test-model" } } };
    const commandUrl = `/api/sessions/${session.logicalSessionId}/commands`;
    const response = await app.inject({ method: "POST", url: commandUrl, headers: browserHeaders, payload: request });
    assert.equal(response.statusCode, 202, response.body);
    const commandId = json<{ command: { commandId: string } }>(response.body).command.commandId;
    const body = JSON.parse(db.get<{ body_json: string }>("SELECT body_json FROM command_contents WHERE command_id=?", commandId)!.body_json);
    assert.equal(body.permissionProfile, "network"); assert.equal(body.permissionSource, "machine"); assert.equal(body.sessionTitle, "Concurrent A");
    const hashes = db.get<{ request_hash: string; payload_hash: string }>("SELECT request_hash,payload_hash FROM commands WHERE command_id=?", commandId)!;
    assert.equal(hashes.request_hash, payloadHash({ type: request.type, precondition: request.precondition, payload: request.payload }));
    assert.equal(hashes.payload_hash, payloadHash({ type: request.type, precondition: request.precondition, payload: body }));
    assert.equal((await save("machine", "full", 1, true)).statusCode, 200);
    const duplicate = await app.inject({ method: "POST", url: commandUrl, headers: browserHeaders, payload: request });
    assert.equal(duplicate.statusCode, 200, duplicate.body);
    assert.equal(JSON.parse(db.get<{ body_json: string }>("SELECT body_json FROM command_contents WHERE command_id=?", commandId)!.body_json).permissionProfile, "network");
    const forged = await app.inject({ method: "POST", url: commandUrl, headers: browserHeaders, payload: { ...request, clientMutationId: "forged-permission", payload: { ...request.payload, permissionProfile: "full" } } });
    assert.equal(forged.statusCode, 400);
  } finally { db.sqlite.exec("ROLLBACK TO permission_test; RELEASE permission_test"); }
  db.transaction = originalTransaction;
  const concurrent = await Promise.all([
    app.inject({
      method: "POST",
      url: `/api/sessions/${sessions[0]!.logicalSessionId}/commands`,
      headers: browserHeaders,
      payload: startPayload(sessions[0]!, leases[0]!.leaseId, "concurrent-start-a"),
    }),
    app.inject({
      method: "POST",
      url: `/api/sessions/${sessions[1]!.logicalSessionId}/commands`,
      headers: browserHeaders,
      payload: startPayload(sessions[1]!, leases[1]!.leaseId, "concurrent-start-b"),
    }),
  ]);
  assert.deepEqual(concurrent.map((response) => response.statusCode).sort(), [202, 409]);
  const winnerIndex = concurrent.findIndex((response) => response.statusCode === 202);
  const loserIndex = winnerIndex === 0 ? 1 : 0;
  const conflict = json<{
    error: { code: string; details: { projectId: string; reservationState: string } };
  }>(concurrent[loserIndex]!.body);
  assert.equal(conflict.error.code, "PROJECT_TURN_RESERVED");
  assert.equal(conflict.error.details.projectId, projectId);
  assert.equal(conflict.error.details.reservationState, "accepted");
  assert.equal(
    db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_turn_reservations")?.count,
    1,
  );

  const coordination = new CoordinationService(db, testConfig);
  assert.equal(
    coordination.expireUndispatchedCommands(new Date(Date.now() + 5 * 60_000).toISOString()),
    1,
    "an accepted turn that was never offered is safe to expire and release",
  );
  assert.equal(
    db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_turn_reservations")?.count,
    0,
  );

  const selected = sessions[loserIndex]!;
  const selectedLease = leases[loserIndex]!;
  const accepted = await app.inject({
    method: "POST",
    url: `/api/sessions/${selected.logicalSessionId}/commands`,
    headers: browserHeaders,
    payload: startPayload(selected, selectedLease.leaseId, "start-after-safe-expiry"),
  });
  assert.equal(accepted.statusCode, 202, accepted.body);
  const acceptedCommandId = json<{ command: { commandId: string } }>(accepted.body).command.commandId;
  const attempt = coordination.createDispatchAttempt(acceptedCommandId, {
    machineId,
    transportGeneration: 7,
    producerEpoch: "reservation-producer",
    appServerEpoch: "reservation-app-server",
  });
  assert.ok(attempt);
  const attemptId = attempt.dispatchAttemptId as string;
  let connection = {
    connectionId: "conn_project_reservation",
    machineId,
    workspaceId: owner.workspace_id,
    transportGeneration: 7,
    publicKey: "reservation-test-public-key",
  };
  assert.deepEqual(coordination.handleConnectionLost(connection), { retryable: 1, unknown: 0 });
  const retryConnection = { ...connection, connectionId: "conn_project_reservation_retry", transportGeneration: 8 };
  db.run(
    `INSERT INTO agent_connections(
      connection_id,machine_id,transport_generation,producer_epoch,app_server_epoch,connected_at,hello_at
    ) VALUES(?,?,?,?,?,?,?)`,
    retryConnection.connectionId,
    machineId,
    retryConnection.transportGeneration,
    "reservation-producer",
    "reservation-app-server",
    timestamp,
    timestamp,
  );
  const retriedAttempt = coordination.createDispatchAttempt(acceptedCommandId, {
    machineId,
    transportGeneration: retryConnection.transportGeneration,
    producerEpoch: "reservation-producer",
    appServerEpoch: "reservation-app-server",
  });
  assert.ok(retriedAttempt);
  const retriedAttemptId = retriedAttempt.dispatchAttemptId as string;
  coordination.markOffered(retriedAttemptId);
  coordination.transitionAttempt(retryConnection, retriedAttemptId, "claimed");
  assert.deepEqual(coordination.handleConnectionLost(retryConnection), { retryable: 0, unknown: 1 });
  db.run(
    "UPDATE agent_connections SET disconnected_at=?,close_reason='test_reconnect' WHERE connection_id=?",
    timestamp,
    retryConnection.connectionId,
  );
  connection = {
    ...connection,
    connectionId: "conn_project_reservation_events",
    transportGeneration: 9,
  };
  assert.equal(
    db.get<{ state: string }>("SELECT state FROM project_turn_reservations WHERE project_id=?", projectId)?.state,
    "unknown",
  );

  const cleanupPrincipal = new AuthService(db, testConfig).authenticateToken(browserHeaders.cookie.slice(browserHeaders.cookie.indexOf("=") + 1));
  const currentContentEpoch = coordination.deleteSessionContent(cleanupPrincipal, selected.logicalSessionId).contentEpoch;
  assert.equal(
    db.get<{ state: string }>("SELECT state FROM project_turn_reservations WHERE project_id=?", projectId)?.state,
    "unknown",
    "content deletion must not release an ambiguously invoked turn",
  );

  const whileUnknown = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessions[2]!.logicalSessionId}/commands`,
    headers: browserHeaders,
    payload: startPayload(sessions[2]!, leases[2]!.leaseId, "start-while-project-unknown"),
  });
  assert.equal(whileUnknown.statusCode, 409, whileUnknown.body);
  assert.equal(json<{ error: { code: string } }>(whileUnknown.body).error.code, "PROJECT_TURN_RESERVED");

  db.run(
    `INSERT INTO agent_connections(
      connection_id,machine_id,transport_generation,producer_epoch,app_server_epoch,connected_at,hello_at
    ) VALUES(?,?,?,?,?,?,?)`,
    connection.connectionId,
    machineId,
    connection.transportGeneration,
    "reservation-producer",
    "reservation-app-server",
    timestamp,
    timestamp,
  );
  db.run(
    `INSERT INTO producer_streams(
      machine_id,producer_epoch,next_expected_host_seq,quarantined,updated_at,sealed
    ) VALUES(?,?,1,0,?,0)`,
    machineId,
    "reservation-producer",
    timestamp,
  );
  const startedPayload = { commandId: acceptedCommandId, status: "running" };
  const started = coordination.appendEvent(connection, {
    eventId: "event-project-reserved-started",
    payloadHash: payloadHash(startedPayload),
    logicalSessionId: selected.logicalSessionId,
    executionSegmentId: selected.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer",
    appServerEpoch: "reservation-app-server",
    hostSeq: 1,
    nativeTurnId: "native-turn-reservation",
    type: "turn.started",
    schemaVersion: "1.0",
    contentEpoch: currentContentEpoch,
    occurredAt: new Date().toISOString(),
    payload: startedPayload,
  });
  assert.equal(started.ok, true);
  const activeReservation = db.get<{ state: string; native_turn_id: string }>(
    "SELECT state,native_turn_id FROM project_turn_reservations WHERE project_id=?",
    projectId,
  );
  assert.equal(activeReservation?.state, "active");
  assert.equal(activeReservation?.native_turn_id, "native-turn-reservation");
  const completedPayload = { status: "completed" };
  const completed = coordination.appendEvent(connection, {
    eventId: "event-project-reserved-completed",
    payloadHash: payloadHash(completedPayload),
    logicalSessionId: selected.logicalSessionId,
    executionSegmentId: selected.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer",
    appServerEpoch: "reservation-app-server",
    hostSeq: 2,
    nativeTurnId: "native-turn-reservation",
    type: "turn.completed",
    schemaVersion: "1.0",
    contentEpoch: currentContentEpoch,
    occurredAt: new Date().toISOString(),
    payload: completedPayload,
  });
  assert.equal(completed.ok, true);
  assert.equal(
    db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_turn_reservations")?.count,
    0,
  );

  const afterTerminal = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessions[2]!.logicalSessionId}/commands`,
    headers: browserHeaders,
    payload: startPayload(sessions[2]!, leases[2]!.leaseId, "start-after-exact-terminal"),
  });
  assert.equal(afterTerminal.statusCode, 202, afterTerminal.body);
  const afterTerminalCommandId = json<{ command: { commandId: string } }>(afterTerminal.body).command.commandId;
  const createdBeforeSend = coordination.createDispatchAttempt(afterTerminalCommandId, {
    machineId,
    transportGeneration: connection.transportGeneration,
    producerEpoch: "reservation-producer",
    appServerEpoch: "reservation-app-server",
  });
  assert.ok(createdBeforeSend);
  const createdAttemptId = createdBeforeSend.dispatchAttemptId as string;
  assert.equal(
    db.get<{ state: string }>(
      "SELECT state FROM dispatch_attempt_projection WHERE dispatch_attempt_id=?",
      createdAttemptId,
    )?.state,
    "created",
  );

  const deletedEpoch = coordination.deleteSessionContent(cleanupPrincipal, sessions[2]!.logicalSessionId).contentEpoch;
  assert.equal(
    db.get<{ state: string }>(
      "SELECT state FROM dispatch_attempt_projection WHERE dispatch_attempt_id=?",
      createdAttemptId,
    )?.state,
    "unknown",
    "created cannot prove that socket.send did not deliver before a crash",
  );
  assert.equal(
    db.get<{ state: string }>("SELECT state FROM command_projection WHERE command_id=?", afterTerminalCommandId)?.state,
    "unknown",
  );
  assert.equal(
    db.get<{ state: string }>("SELECT state FROM project_turn_reservations WHERE project_id=?", projectId)?.state,
    "unknown",
  );

  const staleStartedPayload = {
    commandId: afterTerminalCommandId,
    status: "running",
    secret: "deleted prompt epoch",
  };
  const staleStarted = coordination.appendEvent(connection, {
    eventId: "event-stale-reservation-started",
    payloadHash: payloadHash(staleStartedPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer",
    appServerEpoch: "reservation-app-server",
    hostSeq: 3,
    nativeTurnId: "native-turn-stale-epoch",
    type: "turn.started",
    schemaVersion: "1.0",
    contentEpoch: deletedEpoch - 1,
    occurredAt: new Date().toISOString(),
    payload: staleStartedPayload,
  });
  assert.equal(staleStarted.ok, true);
  assert.equal(
    db.get<{ state: string; native_turn_id: string }>(
      "SELECT state,native_turn_id FROM project_turn_reservations WHERE project_id=?",
      projectId,
    )?.state,
    "active",
    "a matching stale envelope may bind the hidden reservation lifecycle",
  );
  const storedStaleStart = db.get<{ payload_state: string; payload_ref: string | null }>(
    "SELECT payload_state,payload_ref FROM durable_events WHERE event_id='event-stale-reservation-started'",
  );
  assert.deepEqual({ ...storedStaleStart }, { payload_state: "deleted", payload_ref: null });
  assert.equal(
    db.get<{ execution_state: string }>(
      "SELECT execution_state FROM logical_sessions WHERE logical_session_id=?",
      sessions[2]!.logicalSessionId,
    )?.execution_state,
    "idle",
    "stale content must not repopulate the deleted Session projection",
  );

  const staleTerminalPayload = { status: "completed", secret: "deleted terminal epoch" };
  const staleTerminal = coordination.appendEvent(connection, {
    eventId: "event-stale-reservation-terminal",
    payloadHash: payloadHash(staleTerminalPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer",
    appServerEpoch: "reservation-app-server",
    hostSeq: 4,
    nativeTurnId: "native-turn-stale-epoch",
    type: "turn.completed",
    schemaVersion: "1.0",
    contentEpoch: deletedEpoch - 1,
    occurredAt: new Date().toISOString(),
    payload: staleTerminalPayload,
  });
  assert.equal(staleTerminal.ok, true);
  assert.equal(
    db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_turn_reservations")?.count,
    0,
    "an exact stale terminal releases only its hidden reservation",
  );

  const epochBoundaryStart = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessions[2]!.logicalSessionId}/commands`,
    headers: browserHeaders,
    payload: startPayload(sessions[2]!, leases[2]!.leaseId, "start-across-content-epoch-boundary"),
  });
  assert.equal(epochBoundaryStart.statusCode, 202, epochBoundaryStart.body);
  const epochBoundaryCommandId = json<{ command: { commandId: string } }>(epochBoundaryStart.body).command.commandId;
  const epochBoundaryAttempt = coordination.createDispatchAttempt(epochBoundaryCommandId, {
    machineId,
    transportGeneration: connection.transportGeneration,
    producerEpoch: "reservation-producer",
    appServerEpoch: "reservation-app-server",
  });
  assert.ok(epochBoundaryAttempt);
  const boundaryContentEpoch = coordination.deleteSessionContent(cleanupPrincipal, sessions[2]!.logicalSessionId).contentEpoch;

  const boundaryStartedPayload = { commandId: epochBoundaryCommandId, status: "running" };
  const boundaryStarted = coordination.appendEvent(connection, {
    eventId: "event-boundary-stale-start",
    payloadHash: payloadHash(boundaryStartedPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer",
    appServerEpoch: "reservation-app-server",
    hostSeq: 5,
    nativeTurnId: "native-turn-boundary",
    type: "turn.started",
    schemaVersion: "1.0",
    contentEpoch: boundaryContentEpoch - 1,
    occurredAt: new Date().toISOString(),
    payload: boundaryStartedPayload,
  });
  assert.equal(boundaryStarted.ok, true);
  assert.equal(
    db.get<{ state: string }>("SELECT state FROM project_turn_reservations WHERE project_id=?", projectId)?.state,
    "active",
  );
  assert.equal(
    db.get<{ active_turn_id: string | null }>(
      "SELECT active_turn_id FROM logical_sessions WHERE logical_session_id=?",
      sessions[2]!.logicalSessionId,
    )?.active_turn_id,
    null,
    "a stale start binds only the hidden reservation",
  );

  const boundaryTerminalPayload = { status: "completed" };
  const boundaryTerminal = coordination.appendEvent(connection, {
    eventId: "event-boundary-current-terminal",
    payloadHash: payloadHash(boundaryTerminalPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer",
    appServerEpoch: "reservation-app-server",
    hostSeq: 6,
    nativeTurnId: "native-turn-boundary",
    type: "turn.completed",
    schemaVersion: "1.0",
    contentEpoch: boundaryContentEpoch,
    occurredAt: new Date().toISOString(),
    payload: boundaryTerminalPayload,
  });
  assert.equal(boundaryTerminal.ok, true);
  assert.equal(
    db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_turn_reservations")?.count,
    0,
    "a current-epoch exact terminal releases a hidden stale-start reservation",
  );
  assert.equal(
    db.get<{ execution_state: string; active_turn_id: string | null }>(
      "SELECT execution_state,active_turn_id FROM logical_sessions WHERE logical_session_id=?",
      sessions[2]!.logicalSessionId,
    )?.active_turn_id,
    null,
    "a hidden reservation release does not synthesize a Session projection",
  );

  const nextStart = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessions[2]!.logicalSessionId}/commands`,
    headers: browserHeaders,
    payload: startPayload(sessions[2]!, leases[2]!.leaseId, "start-after-stale-terminal-proof"),
  });
  assert.equal(nextStart.statusCode, 202, nextStart.body);
  const nextCommandId = json<{ command: { commandId: string } }>(nextStart.body).command.commandId;
  const nextDispatch = coordination.createDispatchAttempt(nextCommandId, {
    machineId,
    transportGeneration: connection.transportGeneration,
    producerEpoch: "reservation-producer",
    appServerEpoch: "reservation-app-server",
  });
  assert.ok(nextDispatch);
  const nextDispatchId = nextDispatch.dispatchAttemptId as string;
  coordination.markOffered(nextDispatchId);
  for (const state of ["claimed", "invoking", "responded", "applied"] as const) {
    coordination.transitionAttempt(connection, nextDispatchId, state);
  }

  const lateOldStartPayload = { commandId: afterTerminalCommandId, status: "running" };
  const lateOldStart = coordination.appendEvent(connection, {
    eventId: "event-late-old-start",
    payloadHash: payloadHash(lateOldStartPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer",
    appServerEpoch: "reservation-app-server",
    hostSeq: 7,
    nativeTurnId: "native-turn-late-old",
    type: "turn.started",
    schemaVersion: "1.0",
    contentEpoch: boundaryContentEpoch,
    occurredAt: new Date().toISOString(),
    payload: lateOldStartPayload,
  });
  assert.equal(lateOldStart.ok, true);
  const afterLateStart = db.get<{ state: string; native_turn_id: string | null }>(
    "SELECT state,native_turn_id FROM project_turn_reservations WHERE project_id=?",
    projectId,
  );
  assert.equal(afterLateStart?.state, "dispatching");
  assert.equal(afterLateStart?.native_turn_id, null);
  assert.equal(
    db.get<{ execution_state: string }>(
      "SELECT execution_state FROM logical_sessions WHERE logical_session_id=?",
      sessions[2]!.logicalSessionId,
    )?.execution_state,
    "idle",
    "a start for an old command remains durable but cannot claim a new reservation",
  );

  const nextStartedPayload = { commandId: nextCommandId, status: "running" };
  const nextStarted = coordination.appendEvent(connection, {
    eventId: "event-next-exact-start",
    payloadHash: payloadHash(nextStartedPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer",
    appServerEpoch: "reservation-app-server",
    hostSeq: 8,
    nativeTurnId: "native-turn-next",
    type: "turn.started",
    schemaVersion: "1.0",
    contentEpoch: boundaryContentEpoch,
    occurredAt: new Date().toISOString(),
    payload: nextStartedPayload,
  });
  assert.equal(nextStarted.ok, true);
  assert.deepEqual(
    {
      ...db.get<{ execution_state: string; active_turn_id: string | null }>(
        "SELECT execution_state,active_turn_id FROM logical_sessions WHERE logical_session_id=?",
        sessions[2]!.logicalSessionId,
      ),
    },
    { execution_state: "running", active_turn_id: "native-turn-next" },
  );

  const lateOldTerminalPayload = { status: "completed" };
  const lateOldTerminal = coordination.appendEvent(connection, {
    eventId: "event-late-old-terminal",
    payloadHash: payloadHash(lateOldTerminalPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer",
    appServerEpoch: "reservation-app-server",
    hostSeq: 9,
    nativeTurnId: "native-turn-late-old",
    type: "turn.completed",
    schemaVersion: "1.0",
    contentEpoch: boundaryContentEpoch,
    occurredAt: new Date().toISOString(),
    payload: lateOldTerminalPayload,
  });
  assert.equal(lateOldTerminal.ok, true);
  assert.deepEqual(
    {
      ...db.get<{ state: string; native_turn_id: string | null }>(
        "SELECT state,native_turn_id FROM project_turn_reservations WHERE project_id=?",
        projectId,
      ),
    },
    { state: "active", native_turn_id: "native-turn-next" },
    "a late terminal cannot release the current turn reservation",
  );
  assert.deepEqual(
    {
      ...db.get<{ execution_state: string; active_turn_id: string | null }>(
        "SELECT execution_state,active_turn_id FROM logical_sessions WHERE logical_session_id=?",
        sessions[2]!.logicalSessionId,
      ),
    },
    { execution_state: "running", active_turn_id: "native-turn-next" },
    "a late terminal cannot clear the current Session projection",
  );
  assert.equal(
    db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM durable_events WHERE event_id IN ('event-late-old-start','event-late-old-terminal')",
    )?.count,
    2,
    "mismatched ordered events remain durable for audit/reconciliation",
  );

  const nextTerminalPayload = { status: "completed" };
  const nextTerminal = coordination.appendEvent(connection, {
    eventId: "event-next-exact-terminal",
    payloadHash: payloadHash(nextTerminalPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer",
    appServerEpoch: "reservation-app-server",
    hostSeq: 10,
    nativeTurnId: "native-turn-next",
    type: "turn.completed",
    schemaVersion: "1.0",
    contentEpoch: boundaryContentEpoch,
    occurredAt: new Date().toISOString(),
    payload: nextTerminalPayload,
  });
  assert.equal(nextTerminal.ok, true);
  assert.equal(
    db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_turn_reservations")?.count,
    0,
  );
  assert.deepEqual(
    {
      ...db.get<{ execution_state: string; active_turn_id: string | null }>(
        "SELECT execution_state,active_turn_id FROM logical_sessions WHERE logical_session_id=?",
        sessions[2]!.logicalSessionId,
      ),
    },
    { execution_state: "completed", active_turn_id: null },
  );

  const snapshotStart = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessions[2]!.logicalSessionId}/commands`,
    headers: browserHeaders,
    payload: startPayload(sessions[2]!, leases[2]!.leaseId, "start-reconciled-from-agent-snapshot"),
  });
  assert.equal(snapshotStart.statusCode, 202, snapshotStart.body);
  const snapshotCommandId = json<{ command: { commandId: string } }>(snapshotStart.body).command.commandId;
  const snapshotAttempt = coordination.createDispatchAttempt(snapshotCommandId, {
    machineId,
    transportGeneration: connection.transportGeneration,
    producerEpoch: "reservation-producer",
    appServerEpoch: "reservation-app-server",
  });
  assert.ok(snapshotAttempt);
  const snapshotAttemptId = snapshotAttempt.dispatchAttemptId as string;
  coordination.markOffered(snapshotAttemptId);
  for (const state of ["claimed", "invoking", "responded", "applied"] as const) {
    coordination.transitionAttempt(connection, snapshotAttemptId, state);
  }
  db.run(
    `UPDATE project_turn_reservations SET state='unknown',version=version+1,updated_at=?
     WHERE project_id=? AND command_id=?`,
    new Date().toISOString(),
    projectId,
    snapshotCommandId,
  );
  db.run(
    `UPDATE logical_sessions SET execution_state='running',active_turn_id='native-turn-snapshot',
      turn_control_version=turn_control_version+1,updated_at=? WHERE logical_session_id=?`,
    new Date().toISOString(),
    sessions[2]!.logicalSessionId,
  );
  const snapshotTurnVersion = db.get<{ turn_control_version: number }>(
    "SELECT turn_control_version FROM logical_sessions WHERE logical_session_id=?",
    sessions[2]!.logicalSessionId,
  )?.turn_control_version;
  const snapshotStartedPayload = { commandId: snapshotCommandId, status: "running" };
  const snapshotStarted = coordination.appendEvent(connection, {
    eventId: "event-snapshot-exact-start",
    payloadHash: payloadHash(snapshotStartedPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer",
    appServerEpoch: "reservation-app-server",
    hostSeq: 11,
    nativeTurnId: "native-turn-snapshot",
    type: "turn.started",
    schemaVersion: "1.0",
    contentEpoch: boundaryContentEpoch,
    occurredAt: new Date().toISOString(),
    payload: snapshotStartedPayload,
  });
  assert.equal(snapshotStarted.ok, true);
  assert.deepEqual(
    {
      ...db.get<{ state: string; native_turn_id: string | null }>(
        "SELECT state,native_turn_id FROM project_turn_reservations WHERE project_id=?",
        projectId,
      ),
    },
    { state: "active", native_turn_id: "native-turn-snapshot" },
    "an exact outbox start may bind an unknown reservation after hello already reported the same turn",
  );
  assert.equal(
    db.get<{ turn_control_version: number }>(
      "SELECT turn_control_version FROM logical_sessions WHERE logical_session_id=?",
      sessions[2]!.logicalSessionId,
    )?.turn_control_version,
    snapshotTurnVersion,
    "an already projected snapshot turn is not projected twice",
  );

  const snapshotTerminalPayload = { status: "completed" };
  const snapshotTerminal = coordination.appendEvent(connection, {
    eventId: "event-snapshot-exact-terminal",
    payloadHash: payloadHash(snapshotTerminalPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer",
    appServerEpoch: "reservation-app-server",
    hostSeq: 12,
    nativeTurnId: "native-turn-snapshot",
    type: "turn.completed",
    schemaVersion: "1.0",
    contentEpoch: boundaryContentEpoch,
    occurredAt: new Date().toISOString(),
    payload: snapshotTerminalPayload,
  });
  assert.equal(snapshotTerminal.ok, true);
  assert.equal(
    db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_turn_reservations")?.count,
    0,
  );
  assert.deepEqual(
    {
      ...db.get<{ execution_state: string; active_turn_id: string | null }>(
        "SELECT execution_state,active_turn_id FROM logical_sessions WHERE logical_session_id=?",
        sessions[2]!.logicalSessionId,
      ),
    },
    { execution_state: "completed", active_turn_id: null },
  );

  const applyDispatchAttempt = (
    commandId: string,
    appServerEpoch = "reservation-app-server",
    targetConnection = connection,
    producerEpoch = "reservation-producer",
    throughState: "claimed" | "applied" = "applied",
  ): string => {
    const created = coordination.createDispatchAttempt(commandId, {
      machineId,
      transportGeneration: targetConnection.transportGeneration,
      producerEpoch,
      appServerEpoch,
    });
    assert.ok(created);
    const dispatchAttemptId = created.dispatchAttemptId as string;
    coordination.markOffered(dispatchAttemptId);
    const states = ["claimed", "invoking", "responded", "applied"] as const;
    for (const state of states) {
      coordination.transitionAttempt(targetConnection, dispatchAttemptId, state);
      if (state === throughState) break;
    }
    return dispatchAttemptId;
  };
  const appendCommandResult = (
    hostSeq: number,
    eventId: string,
    payload: Record<string, unknown>,
    contentEpoch: number,
    appServerEpoch = "reservation-app-server",
    sourceConnection = connection,
    producerEpoch = "reservation-producer",
  ) => coordination.appendEvent(sourceConnection, {
    eventId,
    payloadHash: payloadHash(payload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch,
    appServerEpoch,
    hostSeq,
    type: "command.result",
    schemaVersion: "1.0",
    contentEpoch,
    occurredAt: new Date().toISOString(),
    payload,
  });

  const fastStart = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessions[2]!.logicalSessionId}/commands`,
    headers: browserHeaders,
    payload: startPayload(sessions[2]!, leases[2]!.leaseId, "fast-terminal-command"),
  });
  assert.equal(fastStart.statusCode, 202, fastStart.body);
  const fastCommandId = json<{ command: { commandId: string } }>(fastStart.body).command.commandId;
  const fastAttemptId = applyDispatchAttempt(
    fastCommandId,
    "reservation-app-server",
    connection,
    "reservation-producer",
    "claimed",
  );
  assert.deepEqual(
    coordination.handleConnectionLost(connection),
    { retryable: 0, unknown: 1 },
    "disconnect makes a claimed attempt ambiguous until durable proof is replayed",
  );
  const replayConnection = {
    ...connection,
    connectionId: "conn_project_reservation_replay",
    transportGeneration: 10,
  };
  db.run(
    `INSERT INTO agent_connections(
      connection_id,machine_id,transport_generation,producer_epoch,app_server_epoch,connected_at,hello_at
    ) VALUES(?,?,?,?,?,?,?)`,
    replayConnection.connectionId,
    machineId,
    replayConnection.transportGeneration,
    "reservation-producer-new",
    "reservation-app-server",
    timestamp,
    timestamp,
  );
  db.run(
    `UPDATE producer_streams SET sealed=1,resume_through_host_seq=16,resume_connection_id=?,
      max_declared_host_seq=16 WHERE machine_id=? AND producer_epoch='reservation-producer'`,
    replayConnection.connectionId,
    machineId,
  );
  db.run(
    `INSERT INTO producer_streams(
      machine_id,producer_epoch,next_expected_host_seq,quarantined,updated_at,sealed,max_declared_host_seq
    ) VALUES(?,'reservation-producer-new',1,0,?,0,0)`,
    machineId,
    timestamp,
  );
  db.run(
    `INSERT INTO reconciliation_cycles(
      reconciliation_id,connection_id,machine_id,producer_epoch,app_server_epoch,capacity,state,created_at
    ) VALUES('recon-project-replay',?,?,
      'reservation-producer-new','reservation-app-server','idle','pending',?)`,
    replayConnection.connectionId,
    machineId,
    timestamp,
  );
  db.run(
    `INSERT INTO reconciliation_stream_targets(
      reconciliation_id,machine_id,producer_epoch,through_host_seq,is_current
    ) VALUES('recon-project-replay',?,'reservation-producer',16,0),
      ('recon-project-replay',?,'reservation-producer-new',0,1)`,
    machineId,
    machineId,
  );
  db.run(
    "UPDATE machines SET current_producer_epoch='reservation-producer-new' WHERE machine_id=?",
    machineId,
  );
  const fastPayload = (overrides: Record<string, unknown> = {}) => ({
    commandId: fastCommandId,
    attemptId: fastAttemptId,
    commandType: "turn.start",
    state: "applied",
    detail: { nativeTurnId: "native-turn-fast", status: "completed" },
    ...overrides,
  });
  const wrongStatus = fastPayload({ detail: { nativeTurnId: "native-turn-fast", status: "inProgress" } });
  assert.equal(appendCommandResult(13, "event-fast-result-wrong-status", wrongStatus, boundaryContentEpoch, "reservation-app-server", replayConnection).ok, true);
  const wrongCommand = fastPayload({ commandId: "command-not-the-reservation" });
  assert.equal(appendCommandResult(14, "event-fast-result-wrong-command", wrongCommand, boundaryContentEpoch, "reservation-app-server", replayConnection).ok, true);
  const missingNativeTurn = fastPayload({ detail: { nativeTurnId: "", status: "completed" } });
  assert.equal(appendCommandResult(15, "event-fast-result-missing-turn", missingNativeTurn, boundaryContentEpoch, "reservation-app-server", replayConnection).ok, true);
  assert.equal(
    db.get<{ command_id: string }>("SELECT command_id FROM project_turn_reservations WHERE project_id=?", projectId)?.command_id,
    fastCommandId,
    "malformed or non-terminal command.result events must not release a reservation",
  );
  const exactFastPayload = fastPayload();
  const exactFast = appendCommandResult(16, "event-fast-result-exact", exactFastPayload, boundaryContentEpoch, "reservation-app-server", replayConnection);
  assert.equal(exactFast.ok, true);
  assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_turn_reservations")?.count, 0);
  assert.deepEqual(
    {
      attempt: db.get<{ state: string }>(
        "SELECT state FROM dispatch_attempt_projection WHERE dispatch_attempt_id=?",
        fastAttemptId,
      )?.state,
      command: db.get<{ state: string }>(
        "SELECT state FROM command_projection WHERE command_id=?",
        fastCommandId,
      )?.state,
    },
    { attempt: "applied", command: "applied" },
    "durable applied proof catches up lifecycle projections even before the applied ACK",
  );
  for (const lateAck of ["invoking", "responded", "applied"] as const) {
    assert.throws(
      () => coordination.transitionAttempt(connection, fastAttemptId, lateAck),
      (error: unknown) => error instanceof AppError && error.code === "CONNECTION_FENCED",
      "a superseded transport cannot mutate lifecycle state even with a matching late ACK",
    );
  }
  assert.deepEqual(
    { ...db.get<{ execution_state: string; active_turn_id: string | null }>(
      "SELECT execution_state,active_turn_id FROM logical_sessions WHERE logical_session_id=?",
      sessions[2]!.logicalSessionId,
    ) },
    { execution_state: "completed", active_turn_id: null },
    "an exact applied fast-terminal result closes a turn that never emitted turn.started",
  );
  const versionAfterFastResult = db.get<{ turn_control_version: number }>(
    "SELECT turn_control_version FROM logical_sessions WHERE logical_session_id=?",
    sessions[2]!.logicalSessionId,
  )?.turn_control_version;
  const duplicateFast = appendCommandResult(16, "event-fast-result-exact", exactFastPayload, boundaryContentEpoch, "reservation-app-server", replayConnection);
  assert.equal(duplicateFast.ok, true);
  if (duplicateFast.ok) assert.equal(duplicateFast.duplicate, true);
  assert.equal(
    db.get<{ turn_control_version: number }>(
      "SELECT turn_control_version FROM logical_sessions WHERE logical_session_id=?",
      sessions[2]!.logicalSessionId,
    )?.turn_control_version,
    versionAfterFastResult,
    "replaying exact fast-terminal evidence is projection-idempotent",
  );

  const staleAppStart = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessions[2]!.logicalSessionId}/commands`,
    headers: browserHeaders,
    payload: startPayload(sessions[2]!, leases[2]!.leaseId, "stale-app-server-envelope"),
  });
  assert.equal(staleAppStart.statusCode, 202, staleAppStart.body);
  const staleAppCommandId = json<{ command: { commandId: string } }>(staleAppStart.body).command.commandId;
  applyDispatchAttempt(
    staleAppCommandId,
    "reservation-app-server-old",
    replayConnection,
    "reservation-producer-new",
  );
  const nativeThreadBeforeStaleApp = db.get<{ native_thread_id: string | null }>(
    "SELECT native_thread_id FROM execution_segments WHERE execution_segment_id=?",
    sessions[2]!.executionSegmentId,
  )?.native_thread_id ?? null;
  const staleAppStartedPayload = { commandId: staleAppCommandId, status: "running", secret: "old app epoch" };
  const staleAppStarted = coordination.appendEvent(replayConnection, {
    eventId: "event-stale-app-started",
    payloadHash: payloadHash(staleAppStartedPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer-new",
    appServerEpoch: "reservation-app-server-old",
    hostSeq: 1,
    nativeThreadId: "native-thread-from-old-app",
    nativeTurnId: "native-turn-from-old-app",
    type: "turn.started",
    schemaVersion: "1.0",
    contentEpoch: boundaryContentEpoch,
    occurredAt: new Date().toISOString(),
    payload: staleAppStartedPayload,
  });
  assert.equal(staleAppStarted.ok, true);
  assert.deepEqual(
    { ...db.get<{ execution_state: string; active_turn_id: string | null }>(
      "SELECT execution_state,active_turn_id FROM logical_sessions WHERE logical_session_id=?",
      sessions[2]!.logicalSessionId,
    ) },
    { execution_state: "completed", active_turn_id: null },
    "an old App Server epoch can bind hidden ownership but cannot resurrect Session projection",
  );
  assert.equal(
    db.get<{ native_thread_id: string | null }>(
      "SELECT native_thread_id FROM execution_segments WHERE execution_segment_id=?",
      sessions[2]!.executionSegmentId,
    )?.native_thread_id ?? null,
    nativeThreadBeforeStaleApp,
  );
  const retainedStaleStart = db.get<{ payload_state: string; payload_ref: string | null }>(
      "SELECT payload_state,payload_ref FROM durable_events WHERE event_id='event-stale-app-started'",
  );
  assert.equal(retainedStaleStart?.payload_state, "present");
  assert.equal(typeof retainedStaleStart?.payload_ref, "string");
  const staleApprovalPayload = {
    approvalId: "approval-from-old-app",
    approvalVersion: 1,
    actionHash: "sha256:old-app-action",
    context: { secret: "must not project" },
  };
  assert.equal(coordination.appendEvent(replayConnection, {
    eventId: "event-stale-app-approval",
    payloadHash: payloadHash(staleApprovalPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer-new",
    appServerEpoch: "reservation-app-server-old",
    hostSeq: 2,
    nativeTurnId: "native-turn-from-old-app",
    type: "approval.requested",
    schemaVersion: "1.0",
    contentEpoch: boundaryContentEpoch,
    occurredAt: new Date().toISOString(),
    payload: staleApprovalPayload,
  }).ok, true);
  assert.equal(
    db.get<{ count: number }>("SELECT COUNT(*) AS count FROM approvals WHERE approval_id='approval-from-old-app'")?.count,
    0,
    "an old App Server epoch cannot recreate a pending approval",
  );
  const staleItemPayload = { item: "historical output remains readable", secret: "retained for seven days" };
  const staleItem = coordination.appendEvent(replayConnection, {
    eventId: "event-stale-app-item",
    payloadHash: payloadHash(staleItemPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer-new",
    appServerEpoch: "reservation-app-server-old",
    hostSeq: 3,
    nativeTurnId: "native-turn-from-old-app",
    type: "item.completed",
    schemaVersion: "1.0",
    contentEpoch: boundaryContentEpoch,
    occurredAt: new Date().toISOString(),
    payload: staleItemPayload,
  });
  assert.equal(staleItem.ok, true);
  if (staleItem.ok) assert.deepEqual(staleItem.event.payload, staleItemPayload);
  const staleAppTerminalPayload = { status: "completed" };
  assert.equal(coordination.appendEvent(replayConnection, {
    eventId: "event-stale-app-terminal",
    payloadHash: payloadHash(staleAppTerminalPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer-new",
    appServerEpoch: "reservation-app-server-old",
    hostSeq: 4,
    nativeTurnId: "native-turn-from-old-app",
    type: "turn.completed",
    schemaVersion: "1.0",
    contentEpoch: boundaryContentEpoch,
    occurredAt: new Date().toISOString(),
    payload: staleAppTerminalPayload,
  }).ok, true);
  assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_turn_reservations")?.count, 0);
  assert.deepEqual(
    { ...db.get<{ execution_state: string; active_turn_id: string | null }>(
      "SELECT execution_state,active_turn_id FROM logical_sessions WHERE logical_session_id=?",
      sessions[2]!.logicalSessionId,
    ) },
    { execution_state: "completed", active_turn_id: null },
    "an exact old-epoch terminal releases only hidden ownership",
  );

  const boundFastStart = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessions[2]!.logicalSessionId}/commands`,
    headers: browserHeaders,
    payload: startPayload(sessions[2]!, leases[2]!.leaseId, "bound-fast-terminal-command"),
  });
  assert.equal(boundFastStart.statusCode, 202, boundFastStart.body);
  const boundFastCommandId = json<{ command: { commandId: string } }>(boundFastStart.body).command.commandId;
  const boundFastAttemptId = applyDispatchAttempt(
    boundFastCommandId,
    "reservation-app-server",
    replayConnection,
    "reservation-producer-new",
    "claimed",
  );
  db.run(
    "UPDATE project_turn_reservations SET state='active',native_turn_id='native-turn-bound-fast',version=version+1 WHERE project_id=?",
    projectId,
  );
  db.run(
    `UPDATE logical_sessions SET execution_state='running',active_turn_id='native-turn-newer-visible',
      turn_control_version=turn_control_version+1 WHERE logical_session_id=?`,
    sessions[2]!.logicalSessionId,
  );
  const wrongBoundNative = {
    commandId: boundFastCommandId,
    attemptId: boundFastAttemptId,
    commandType: "turn.start",
    state: "applied",
    detail: { nativeTurnId: "native-turn-wrong", status: "completed" },
  };
  assert.equal(appendCommandResult(
    5,
    "event-bound-fast-wrong-native",
    wrongBoundNative,
    boundaryContentEpoch,
    "reservation-app-server",
    replayConnection,
    "reservation-producer-new",
  ).ok, true);
  assert.equal(
    db.get<{ native_turn_id: string | null }>("SELECT native_turn_id FROM project_turn_reservations WHERE project_id=?", projectId)?.native_turn_id,
    "native-turn-bound-fast",
  );
  const exactBoundNative = {
    ...wrongBoundNative,
    detail: { nativeTurnId: "native-turn-bound-fast", status: "completed" },
  };
  assert.equal(appendCommandResult(
    6,
    "event-bound-fast-exact-native-fenced",
    exactBoundNative,
    boundaryContentEpoch,
    "reservation-app-server",
    replayConnection,
    "reservation-producer-new",
  ).ok, true);
  assert.equal(
    db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_turn_reservations")?.count,
    1,
    "exact old evidence must retain its reservation while a different visible turn is active",
  );
  assert.deepEqual(
    { ...db.get<{ execution_state: string; active_turn_id: string | null }>(
      "SELECT execution_state,active_turn_id FROM logical_sessions WHERE logical_session_id=?",
      sessions[2]!.logicalSessionId,
    ) },
    { execution_state: "running", active_turn_id: "native-turn-newer-visible" },
    "exact hidden evidence cannot clear a different visible active turn",
  );

  db.run(
    "UPDATE logical_sessions SET execution_state='completed',active_turn_id=NULL WHERE logical_session_id=?",
    sessions[2]!.logicalSessionId,
  );
  assert.equal(appendCommandResult(
    7,
    "event-bound-fast-exact-native-retry",
    exactBoundNative,
    boundaryContentEpoch,
    "reservation-app-server",
    replayConnection,
    "reservation-producer-new",
  ).ok, true);
  assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_turn_reservations")?.count, 0);
  for (const lateAck of ["invoking", "responded", "applied"] as const) {
    const confirmation = coordination.transitionAttempt(replayConnection, boundFastAttemptId, lateAck);
    assert.equal(confirmation.duplicate, true, "a late matching ACK cannot regress a durable applied proof");
    assert.equal(confirmation.state, "applied");
  }
  const staleFastStart = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessions[2]!.logicalSessionId}/commands`,
    headers: browserHeaders,
    payload: startPayload(sessions[2]!, leases[2]!.leaseId, "stale-content-fast-terminal"),
  });
  assert.equal(staleFastStart.statusCode, 202, staleFastStart.body);
  const staleFastCommandId = json<{ command: { commandId: string } }>(staleFastStart.body).command.commandId;
  const staleFastAttemptId = applyDispatchAttempt(
    staleFastCommandId,
    "reservation-app-server",
    replayConnection,
    "reservation-producer-new",
  );
  coordination.deleteSessionContent(cleanupPrincipal, sessions[2]!.logicalSessionId);
  const staleFastVersion = db.get<{ turn_control_version: number }>(
    "SELECT turn_control_version FROM logical_sessions WHERE logical_session_id=?",
    sessions[2]!.logicalSessionId,
  )?.turn_control_version;
  const staleFastPayload = {
    commandId: staleFastCommandId,
    attemptId: staleFastAttemptId,
    commandType: "turn.start",
    state: "applied",
    detail: { nativeTurnId: "native-turn-stale-fast", status: "failed" },
  };
  assert.equal(appendCommandResult(
    8,
    "event-stale-fast-result",
    staleFastPayload,
    boundaryContentEpoch,
    "reservation-app-server",
    replayConnection,
    "reservation-producer-new",
  ).ok, true);
  assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_turn_reservations")?.count, 0);
  assert.equal(
    db.get<{ turn_control_version: number }>(
      "SELECT turn_control_version FROM logical_sessions WHERE logical_session_id=?",
      sessions[2]!.logicalSessionId,
    )?.turn_control_version,
    staleFastVersion,
    "stale-content command.result evidence releases only hidden ownership",
  );
  assert.deepEqual(
    { ...db.get<{ payload_state: string; payload_ref: string | null }>(
      "SELECT payload_state,payload_ref FROM durable_events WHERE event_id='event-stale-fast-result'",
    ) },
    { payload_state: "deleted", payload_ref: null },
  );

  const crossEpochStart = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessions[2]!.logicalSessionId}/commands`,
    headers: browserHeaders,
    payload: startPayload(sessions[2]!, leases[2]!.leaseId, "cross-epoch-terminal-fence"),
  });
  assert.equal(crossEpochStart.statusCode, 202, crossEpochStart.body);
  const crossEpochCommandId = json<{ command: { commandId: string } }>(crossEpochStart.body).command.commandId;
  applyDispatchAttempt(
    crossEpochCommandId,
    "reservation-app-server",
    replayConnection,
    "reservation-producer-new",
    "claimed",
  );
  const crossEpochStartedPayload = { commandId: crossEpochCommandId, status: "running" };
  assert.equal(coordination.appendEvent(replayConnection, {
    eventId: "event-cross-epoch-start",
    payloadHash: payloadHash(crossEpochStartedPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer-new",
    appServerEpoch: "reservation-app-server",
    hostSeq: 9,
    nativeTurnId: "native-turn-epoch-reused",
    type: "turn.started",
    schemaVersion: "1.0",
    contentEpoch: boundaryContentEpoch + 1,
    occurredAt: new Date().toISOString(),
    payload: crossEpochStartedPayload,
  }).ok, true);
  db.run(
    `UPDATE producer_streams SET resume_through_host_seq=17,max_declared_host_seq=17
     WHERE machine_id=? AND producer_epoch='reservation-producer'`,
    machineId,
  );
  db.run(
    `UPDATE reconciliation_stream_targets SET through_host_seq=17
     WHERE reconciliation_id='recon-project-replay' AND producer_epoch='reservation-producer'`,
  );
  const crossEpochTerminalPayload = { status: "completed" };
  assert.equal(coordination.appendEvent(replayConnection, {
    eventId: "event-cross-producer-terminal",
    payloadHash: payloadHash(crossEpochTerminalPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer",
    appServerEpoch: "reservation-app-server",
    hostSeq: 17,
    nativeTurnId: "native-turn-epoch-reused",
    type: "turn.completed",
    schemaVersion: "1.0",
    contentEpoch: boundaryContentEpoch + 1,
    occurredAt: new Date().toISOString(),
    payload: crossEpochTerminalPayload,
  }).ok, true);
  assert.equal(coordination.appendEvent(replayConnection, {
    eventId: "event-cross-app-terminal",
    payloadHash: payloadHash(crossEpochTerminalPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer-new",
    appServerEpoch: "reservation-app-server-old",
    hostSeq: 10,
    nativeTurnId: "native-turn-epoch-reused",
    type: "turn.completed",
    schemaVersion: "1.0",
    contentEpoch: boundaryContentEpoch + 1,
    occurredAt: new Date().toISOString(),
    payload: crossEpochTerminalPayload,
  }).ok, true);
  assert.deepEqual(
    {
      reservation: db.get<{ native_turn_id: string | null }>(
        "SELECT native_turn_id FROM project_turn_reservations WHERE project_id=?",
        projectId,
      )?.native_turn_id,
      session: db.get<{ active_turn_id: string | null }>(
        "SELECT active_turn_id FROM logical_sessions WHERE logical_session_id=?",
        sessions[2]!.logicalSessionId,
      )?.active_turn_id,
    },
    { reservation: "native-turn-epoch-reused", session: "native-turn-epoch-reused" },
    "the same nativeTurnId from a different producer or App Server epoch cannot release the bound turn",
  );
  assert.equal(coordination.appendEvent(replayConnection, {
    eventId: "event-cross-epoch-terminal-exact",
    payloadHash: payloadHash(crossEpochTerminalPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer-new",
    appServerEpoch: "reservation-app-server",
    hostSeq: 11,
    nativeTurnId: "native-turn-epoch-reused",
    type: "turn.completed",
    schemaVersion: "1.0",
    contentEpoch: boundaryContentEpoch + 1,
    occurredAt: new Date().toISOString(),
    payload: crossEpochTerminalPayload,
  }).ok, true);
  assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_turn_reservations")?.count, 0);

  const hiddenGuardStart = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessions[2]!.logicalSessionId}/commands`,
    headers: browserHeaders,
    payload: startPayload(sessions[2]!, leases[2]!.leaseId, "hidden-active-turn-guard"),
  });
  assert.equal(hiddenGuardStart.statusCode, 202, hiddenGuardStart.body);
  const hiddenGuardCommandId = json<{ command: { commandId: string } }>(hiddenGuardStart.body).command.commandId;
  applyDispatchAttempt(
    hiddenGuardCommandId,
    "reservation-app-server",
    replayConnection,
    "reservation-producer-new",
    "claimed",
  );
  const hiddenCommandEpoch = boundaryContentEpoch + 1;
  coordination.deleteSessionContent(cleanupPrincipal, sessions[2]!.logicalSessionId);
  db.run(
    `UPDATE logical_sessions SET execution_state='running',active_turn_id='native-turn-visible-y',
      turn_control_version=turn_control_version+1 WHERE logical_session_id=?`,
    sessions[2]!.logicalSessionId,
  );
  const hiddenStartedPayload = { commandId: hiddenGuardCommandId, status: "running" };
  assert.equal(coordination.appendEvent(replayConnection, {
    eventId: "event-hidden-start-different-active",
    payloadHash: payloadHash(hiddenStartedPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer-new",
    appServerEpoch: "reservation-app-server",
    hostSeq: 12,
    nativeTurnId: "native-turn-hidden-t",
    type: "turn.started",
    schemaVersion: "1.0",
    contentEpoch: hiddenCommandEpoch,
    occurredAt: new Date().toISOString(),
    payload: hiddenStartedPayload,
  }).ok, true);
  assert.deepEqual(
    { ...db.get<{ state: string; native_turn_id: string | null }>(
      "SELECT state,native_turn_id FROM project_turn_reservations WHERE project_id=?",
      projectId,
    ) },
    { state: "unknown", native_turn_id: null },
    "a hidden start cannot bind through a different visible active turn",
  );
  db.run(
    "UPDATE logical_sessions SET execution_state='idle',active_turn_id=NULL WHERE logical_session_id=?",
    sessions[2]!.logicalSessionId,
  );
  db.run(
    `UPDATE logical_sessions SET execution_state='running',active_turn_id='native-turn-sibling-z',
      turn_control_version=turn_control_version+1 WHERE logical_session_id=?`,
    sessions[0]!.logicalSessionId,
  );
  assert.equal(coordination.appendEvent(replayConnection, {
    eventId: "event-hidden-start-sibling-active",
    payloadHash: payloadHash(hiddenStartedPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer-new",
    appServerEpoch: "reservation-app-server",
    hostSeq: 13,
    nativeTurnId: "native-turn-hidden-t",
    type: "turn.started",
    schemaVersion: "1.0",
    contentEpoch: hiddenCommandEpoch,
    occurredAt: new Date().toISOString(),
    payload: hiddenStartedPayload,
  }).ok, true);
  assert.equal(
    db.get<{ native_turn_id: string | null }>("SELECT native_turn_id FROM project_turn_reservations WHERE project_id=?", projectId)?.native_turn_id,
    null,
    "a hidden start cannot bind while a sibling Session in the Project has an active turn",
  );
  db.run(
    `UPDATE project_turn_reservations SET state='active',native_turn_id='native-turn-hidden-t',
      bound_producer_epoch='reservation-producer-new',bound_app_server_epoch='reservation-app-server',
      binding_state='bound',version=version+1 WHERE project_id=?`,
    projectId,
  );
  assert.equal(coordination.appendEvent(replayConnection, {
    eventId: "event-hidden-terminal-different-active",
    payloadHash: payloadHash(crossEpochTerminalPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer-new",
    appServerEpoch: "reservation-app-server",
    hostSeq: 14,
    nativeTurnId: "native-turn-hidden-t",
    type: "turn.completed",
    schemaVersion: "1.0",
    contentEpoch: hiddenCommandEpoch,
    occurredAt: new Date().toISOString(),
    payload: crossEpochTerminalPayload,
  }).ok, true);
  assert.equal(
    db.get<{ native_turn_id: string | null }>("SELECT native_turn_id FROM project_turn_reservations WHERE project_id=?", projectId)?.native_turn_id,
    "native-turn-hidden-t",
    "a hidden terminal cannot release while a sibling Session has a visible active turn",
  );
  db.run(
    "UPDATE logical_sessions SET execution_state='idle',active_turn_id=NULL WHERE logical_session_id=?",
    sessions[0]!.logicalSessionId,
  );
  db.run(
    `UPDATE logical_sessions SET execution_state='running',active_turn_id='native-turn-visible-y',
      turn_control_version=turn_control_version+1 WHERE logical_session_id=?`,
    sessions[2]!.logicalSessionId,
  );
  assert.equal(coordination.appendEvent(replayConnection, {
    eventId: "event-hidden-terminal-current-different-active",
    payloadHash: payloadHash(crossEpochTerminalPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer-new",
    appServerEpoch: "reservation-app-server",
    hostSeq: 15,
    nativeTurnId: "native-turn-hidden-t",
    type: "turn.completed",
    schemaVersion: "1.0",
    contentEpoch: hiddenCommandEpoch,
    occurredAt: new Date().toISOString(),
    payload: crossEpochTerminalPayload,
  }).ok, true);
  assert.equal(
    db.get<{ native_turn_id: string | null }>("SELECT native_turn_id FROM project_turn_reservations WHERE project_id=?", projectId)?.native_turn_id,
    "native-turn-hidden-t",
    "a hidden terminal cannot release through a different active turn on its own Session",
  );
  db.run(
    "UPDATE logical_sessions SET execution_state='idle',active_turn_id=NULL WHERE logical_session_id=?",
    sessions[2]!.logicalSessionId,
  );
  assert.equal(coordination.appendEvent(replayConnection, {
    eventId: "event-hidden-terminal-after-active-cleared",
    payloadHash: payloadHash(crossEpochTerminalPayload),
    logicalSessionId: sessions[2]!.logicalSessionId,
    executionSegmentId: sessions[2]!.executionSegmentId,
    projectId,
    producerEpoch: "reservation-producer-new",
    appServerEpoch: "reservation-app-server",
    hostSeq: 16,
    nativeTurnId: "native-turn-hidden-t",
    type: "turn.completed",
    schemaVersion: "1.0",
    contentEpoch: hiddenCommandEpoch,
    occurredAt: new Date().toISOString(),
    payload: crossEpochTerminalPayload,
  }).ok, true);
  assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM project_turn_reservations")?.count, 0);

  const preClaimProofCases = ["created", "offered", "delivery_failed_before_claim"] as const;
  for (const [index, proofState] of preClaimProofCases.entries()) {
    const proofStart = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessions[2]!.logicalSessionId}/commands`,
      headers: browserHeaders,
      payload: startPayload(sessions[2]!, leases[2]!.leaseId, `fast-proof-${proofState}`),
    });
    assert.equal(proofStart.statusCode, 202, proofStart.body);
    const proofCommandId = json<{ command: { commandId: string } }>(proofStart.body).command.commandId;
    const proofAttempt = coordination.createDispatchAttempt(proofCommandId, {
      machineId,
      transportGeneration: replayConnection.transportGeneration,
      producerEpoch: "reservation-producer-new",
      appServerEpoch: "reservation-app-server",
    });
    assert.ok(proofAttempt);
    const proofAttemptId = proofAttempt.dispatchAttemptId as string;
    if (proofState === "offered") coordination.markOffered(proofAttemptId);
    if (proofState === "delivery_failed_before_claim") {
      coordination.markDeliveryFailed(proofAttemptId, "ambiguous send before restart");
    }
    const proofPayload = {
      commandId: proofCommandId,
      attemptId: proofAttemptId,
      commandType: "turn.start",
      state: "applied",
      detail: { nativeTurnId: `native-turn-proof-${proofState}`, status: "completed" },
    };
    assert.equal(appendCommandResult(
      17 + index,
      `event-fast-proof-${proofState}`,
      proofPayload,
      boundaryContentEpoch + 2,
      "reservation-app-server",
      replayConnection,
      "reservation-producer-new",
    ).ok, true);
    assert.deepEqual(
      {
        attempt: db.get<{ state: string }>(
          "SELECT state FROM dispatch_attempt_projection WHERE dispatch_attempt_id=?",
          proofAttemptId,
        )?.state,
        command: db.get<{ state: string }>(
          "SELECT state FROM command_projection WHERE command_id=?",
          proofCommandId,
        )?.state,
        reservations: db.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM project_turn_reservations WHERE project_id=?",
          projectId,
        )?.count,
      },
      { attempt: "applied", command: "applied", reservations: 0 },
      `exact durable proof must override the conservative ${proofState} transport inference`,
    );
  }

  const revokeFenceStart = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessions[2]!.logicalSessionId}/commands`,
    headers: browserHeaders,
    payload: startPayload(sessions[2]!, leases[2]!.leaseId, "revoke-linearization-command"),
  });
  assert.equal(revokeFenceStart.statusCode, 202, revokeFenceStart.body);
  const revokeCommandId = json<{ command: { commandId: string } }>(revokeFenceStart.body).command.commandId;
  const revokeAttemptId = applyDispatchAttempt(
    revokeCommandId,
    "reservation-app-server",
    replayConnection,
    "reservation-producer-new",
    "claimed",
  );
  const eventCountBeforeRevoke = db.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM durable_events",
  )?.count;
  const revoke = await app.inject({
    method: "DELETE",
    url: `/api/machines/${machineId}`,
    headers: browserHeaders,
    payload: {},
  });
  assert.equal(revoke.statusCode, 200, revoke.body);
  const visibleMachines = json<{ machines: Array<{ machineId: string }> }>((await app.inject({
    method: "GET",
    url: "/api/machines",
    headers: { cookie },
  })).body).machines;
  assert.equal(visibleMachines.some((machine) => machine.machineId === machineId), false);
  const visibleProjects = json<{ projects: Array<{ machineId: string }> }>((await app.inject({
    method: "GET",
    url: `/api/projects?machineId=${encodeURIComponent(machineId)}`,
    headers: { cookie },
  })).body).projects;
  assert.deepEqual(visibleProjects, []);
  const visibleSessions = json<{ sessions: Array<{ machineId: string }> }>((await app.inject({
    method: "GET",
    url: "/api/sessions",
    headers: { cookie },
  })).body).sessions;
  assert.equal(visibleSessions.some((session) => session.machineId === machineId), false);
  assert.equal(
    db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM control_leases l JOIN logical_sessions s ON s.logical_session_id=l.logical_session_id
       WHERE s.machine_id=? AND l.state='active'`,
      machineId,
    )?.count,
    0,
  );
  assert.throws(
    () => coordination.transitionAttempt(replayConnection, revokeAttemptId, "invoking"),
    (error: unknown) => error instanceof AppError && error.code === "MACHINE_REVOKED",
  );
  const revokedPayload = { item: "must not be accepted after revoke" };
  assert.throws(
    () => coordination.appendEvent(replayConnection, {
      eventId: "event-after-machine-revoke",
      payloadHash: payloadHash(revokedPayload),
      logicalSessionId: sessions[2]!.logicalSessionId,
      executionSegmentId: sessions[2]!.executionSegmentId,
      projectId,
      producerEpoch: "reservation-producer-new",
      appServerEpoch: "reservation-app-server",
      hostSeq: 20,
      type: "item.completed",
      schemaVersion: "1.0",
      contentEpoch: boundaryContentEpoch + 2,
      occurredAt: new Date().toISOString(),
      payload: revokedPayload,
    }),
    (error: unknown) => error instanceof AppError && error.code === "MACHINE_REVOKED",
  );
  assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM durable_events")?.count, eventCountBeforeRevoke);
  const revokedConnection = db.get<{ disconnected_at: string | null; close_reason: string | null }>(
    "SELECT disconnected_at,close_reason FROM agent_connections WHERE connection_id=?",
    replayConnection.connectionId,
  );
  assert.equal(typeof revokedConnection?.disconnected_at, "string");
  assert.equal(revokedConnection?.close_reason, "machine_revoked");
  assert.equal(
    db.get<{ count: number }>("SELECT COUNT(*) AS count FROM reconciliation_cycles WHERE machine_id=?", machineId)?.count,
    0,
  );
});
