import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlPlaneConfig } from "../src/config.js";
import { ControlPlaneDatabase } from "../src/db.js";
import { CoordinationService } from "../src/coordination.js";
import { payloadHash, sha256 } from "../src/crypto.js";
import { MaintenanceService } from "../src/maintenance.js";
import type { Principal } from "../src/auth.js";
import { AppError } from "../src/errors.js";
import { RegistryService, type AgentConnectionIdentity } from "../src/registry.js";
import { buildControlPlane, cookieFromSetCookie, csrfHeaders } from "../src/server.js";

function config(databasePath: string): ControlPlaneConfig {
  return {
    host: "127.0.0.1",
    port: 3000,
    databasePath,
    publicOrigin: "http://control-plane.test",
    allowedOrigins: new Set(["http://control-plane.test"]),
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

function insertMachine(
  db: ControlPlaneDatabase,
  workspaceId: string,
  machineId: string,
  timestamp: string,
): void {
  db.run(
    `INSERT INTO machines(
      machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,
      platform_release,architecture,agent_version,identity_state,security_state,reachability,
      compatibility,capacity,last_heartbeat_at,created_at,updated_at,codex_version,schema_hash,
      credential_protection_level
    ) VALUES(?,?,?,?,?,?,?,?,?,'active','normal','online','compatible','busy',?,?,?,?,?,?)`,
    machineId,
    workspaceId,
    `public-key-${machineId}`,
    `fingerprint-${machineId}`,
    `host-${machineId}`,
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
}

test("cold start reconciles persisted reachability and dispatch attempts", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agentfleet-recovery-"));
  const databasePath = join(directory, "control-plane.sqlite");
  const testConfig = config(databasePath);
  const seed = new ControlPlaneDatabase(databasePath);
  const owner = seed.bootstrap(testConfig);
  const timestamp = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const machineId = "mach_restart_recovery";
  insertMachine(seed, owner.workspaceId, machineId, timestamp);
  seed.run(
    `INSERT INTO client_sessions(
      client_session_id,workspace_id,user_id,token_hash,csrf_hash,created_at,last_seen_at,expires_at
    ) VALUES(?,?,?,?,?,?,?,?)`,
    "client-recovery",
    owner.workspaceId,
    owner.userId,
    "token-hash-recovery",
    "csrf-hash-recovery",
    timestamp,
    timestamp,
    expiresAt,
  );

  const attemptStates = ["created", "offered", "claimed", "invoking", "responded"] as const;
  for (const state of attemptStates) {
    const projectId = `proj_recovery_${state}`;
    const sessionId = `session_recovery_${state}`;
    const segmentId = `segment_recovery_${state}`;
    const commandId = `command_recovery_${state}`;
    const attemptId = `attempt_recovery_${state}`;
    seed.run(
      `INSERT INTO projects(
        project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,
        lease_version,created_at,last_reported_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      projectId,
      owner.workspaceId,
      machineId,
      `external-${state}`,
      `Project ${state}`,
      `/work/${state}`,
      `identity-${state}`,
      1,
      timestamp,
      timestamp,
    );
    seed.run(
      `INSERT INTO logical_sessions(
        logical_session_id,workspace_id,machine_id,project_id,external_id,title,managed,
        execution_state,reachability,active_turn_id,created_at,updated_at
      ) VALUES(?,?,?,?,?, ?,1,'idle','live',NULL,?,?)`,
      sessionId,
      owner.workspaceId,
      machineId,
      projectId,
      sessionId,
      `Session ${state}`,
      timestamp,
      timestamp,
    );
    seed.run(
      `INSERT INTO execution_segments(
        execution_segment_id,logical_session_id,machine_id,project_id,external_id,
        history_completeness,created_at
      ) VALUES(?,?,?,?,?,'complete',?)`,
      segmentId,
      sessionId,
      machineId,
      projectId,
      segmentId,
      timestamp,
    );
    seed.run(
      `INSERT INTO commands(
        command_id,client_mutation_id,payload_hash,workspace_id,actor_user_id,
        actor_client_session_id,logical_session_id,execution_segment_id,type,
        precondition_json,payload_json,content_epoch,created_at,expires_at
      ) VALUES(?,?,?,?,?,?,?,?,?,'{}','{}',1,?,?)`,
      commandId,
      `mutation-${state}`,
      `payload-hash-${state}`,
      owner.workspaceId,
      owner.userId,
      "client-recovery",
      sessionId,
      segmentId,
      "turn.start",
      timestamp,
      expiresAt,
    );
    seed.run(
      "INSERT INTO command_contents(command_id,body_json,created_at,expires_at) VALUES(?,?,?,?)",
      commandId,
      JSON.stringify({ prompt: state }),
      timestamp,
      expiresAt,
    );
    seed.run(
      "INSERT INTO command_projection(command_id,state,updated_at) VALUES(?,'dispatching',?)",
      commandId,
      timestamp,
    );
    seed.run(
      `INSERT INTO dispatch_attempts(
        dispatch_attempt_id,command_id,attempt_no,machine_id,transport_generation,
        producer_epoch,app_server_epoch,created_at
      ) VALUES(?,?,1,?,1,'producer-before-restart','app-server-before-restart',?)`,
      attemptId,
      commandId,
      machineId,
      timestamp,
    );
    seed.run(
      "INSERT INTO dispatch_attempt_projection(dispatch_attempt_id,state,updated_at) VALUES(?,?,?)",
      attemptId,
      state,
      timestamp,
    );
    seed.run(
      `INSERT INTO project_turn_reservations(
        project_id,logical_session_id,command_id,state,version,reserved_at,updated_at
      ) VALUES(?,?,?,'dispatching',1,?,?)`,
      projectId,
      sessionId,
      commandId,
      timestamp,
      timestamp,
    );
  }
  seed.close();

  const handle = await buildControlPlane(testConfig);
  t.after(async () => {
    await handle.app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const machine = handle.db.get<{ reachability: string; capacity: string; unreachable_reason: string }>(
    "SELECT reachability,capacity,unreachable_reason FROM machines WHERE machine_id=?",
    machineId,
  );
  assert.deepEqual({ ...machine }, {
    reachability: "reconnecting",
    capacity: "unknown",
    unreachable_reason: "control_plane_restarted",
  });
  assert.equal(
    handle.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM logical_sessions WHERE machine_id=? AND reachability='reconciling'",
      machineId,
    )?.count,
    attemptStates.length,
  );
  const login = await handle.app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: testConfig.publicOrigin },
    payload: { email: testConfig.adminEmail, password: testConfig.adminPassword },
  });
  assert.equal(login.statusCode, 200, login.body);
  const loginBody = JSON.parse(login.body) as { csrfToken: string };
  const createWhileSocketless = await handle.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: {
      cookie: cookieFromSetCookie(login.headers["set-cookie"]),
      ...csrfHeaders(loginBody.csrfToken, testConfig.publicOrigin),
    },
    payload: { machineId, projectId: "proj_recovery_created", title: "Must wait for hello" },
  });
  assert.equal(createWhileSocketless.statusCode, 409, createWhileSocketless.body);
  assert.equal(
    (JSON.parse(createWhileSocketless.body) as { error: { code: string } }).error.code,
    "MACHINE_NOT_ONLINE",
  );

  for (const state of attemptStates) {
    const retryable = state === "created" || state === "offered";
    assert.equal(
      handle.db.get<{ state: string }>(
        "SELECT state FROM dispatch_attempt_projection WHERE dispatch_attempt_id=?",
        `attempt_recovery_${state}`,
      )?.state,
      retryable ? "delivery_failed_before_claim" : "unknown",
    );
    assert.equal(
      handle.db.get<{ state: string }>(
        "SELECT state FROM command_projection WHERE command_id=?",
        `command_recovery_${state}`,
      )?.state,
      retryable ? "accepted" : "unknown",
    );
    assert.equal(
      handle.db.get<{ state: string }>(
        "SELECT state FROM project_turn_reservations WHERE project_id=?",
        `proj_recovery_${state}`,
      )?.state,
      retryable ? "accepted" : "unknown",
    );
  }
  await t.test("host journal recovery rejects mismatches, waits for exact terminal proof, and is idempotent", () => {
    const service = new CoordinationService(handle.db,testConfig);
    const operationId = "recover-journal";
    const evidence = {commandId:"command_recovery_responded",attemptId:"attempt_recovery_claimed",commandType:"turn.start",state:"applied",response:{nativeThreadId:"original-thread",nativeTurnId:"original-turn",status:"inProgress"}};
    handle.db.run("INSERT INTO machine_operations(operation_id,machine_id,workspace_id,actor_client_session_id,client_mutation_id,type,state,created_at,updated_at,expires_at,result_json) VALUES(?,?,?,?,?,'commands.reconcile','succeeded',?,?,?,?)",operationId,machineId,owner.workspaceId,"client-recovery","recovery-mutation",timestamp,timestamp,expiresAt,JSON.stringify({readOnly:true,commands:[evidence]}));
    const write = (value: unknown) => handle.db.run("UPDATE machine_operations SET result_json=? WHERE operation_id=?",JSON.stringify({readOnly:true,commands:[value]}),operationId);
    assert.deepEqual(service.recoverCommandResults(machineId,operationId),[],"attempt belongs to another command");
    evidence.attemptId = "attempt_recovery_responded"; write(evidence);
    assert.deepEqual(service.recoverCommandResults(machineId,operationId),[],"start acknowledgement does not prove task completion");
    write({...evidence,terminalStatus:"completed"});
    assert.deepEqual(service.recoverCommandResults("different-machine",operationId),[]);
    handle.db.run("UPDATE logical_sessions SET content_epoch=2 WHERE logical_session_id='session_recovery_responded'");
    assert.deepEqual(service.recoverCommandResults(machineId,operationId),[],"old content epoch cannot unfreeze a newer session");
    handle.db.run("UPDATE logical_sessions SET content_epoch=1 WHERE logical_session_id='session_recovery_responded'");
    const attempts = handle.db.get<{n:number}>("SELECT count(*) n FROM dispatch_attempts")!.n;
    assert.deepEqual(service.recoverCommandResults(machineId,operationId),["session_recovery_responded"]);
    assert.equal(handle.db.get<{state:string}>("SELECT state FROM command_projection WHERE command_id=?",evidence.commandId)?.state,"applied");
    assert.equal(handle.db.get("SELECT 1 FROM project_turn_reservations WHERE command_id=?",evidence.commandId),undefined);
    assert.deepEqual(service.recoverCommandResults(machineId,operationId),[]);
    assert.equal(handle.db.get<{n:number}>("SELECT count(*) n FROM dispatch_attempts")!.n,attempts,"no new execution attempt");
    assert.equal(handle.db.get<{state:string}>("SELECT state FROM command_projection WHERE command_id='command_recovery_invoking'")?.state,"unknown","unproven commands stay frozen");
  });

});

test("v7 enrollment schema upgrades with explicit credential recovery fields", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agentfleet-migration-v7-"));
  const databasePath = join(directory, "control-plane.sqlite");
  const seed = new ControlPlaneDatabase(databasePath);
  seed.sqlite.exec(
    `DROP TABLE codex_preferences;
     ALTER TABLE machines DROP COLUMN codex_catalog_json;
     ALTER TABLE logical_sessions DROP COLUMN runtime_settings_json;
     DROP TABLE native_thread_bindings;
     DROP TABLE machine_operations;
     DROP TABLE credential_renewal_challenges;
     DROP TABLE session_creation_requests;
     ALTER TABLE machines DROP COLUMN maintenance_types_json;
     ALTER TABLE machines DROP COLUMN discovery_json;
     ALTER TABLE machines DROP COLUMN codex_profile_json;
     ALTER TABLE enrollment_transactions DROP COLUMN preauthorized;
     ALTER TABLE enrollment_transactions DROP COLUMN consent_at;
     DROP INDEX sessions_filter_page_idx;
     ALTER TABLE machines DROP COLUMN command_types_json;
     ALTER TABLE machines DROP COLUMN runtime_read_only;
     ALTER TABLE machines DROP COLUMN runtime_read_only_reasons_json;
     ALTER TABLE logical_sessions DROP COLUMN management_revision;
     ALTER TABLE logical_sessions DROP COLUMN codex_profile_id;
     ALTER TABLE logical_sessions DROP COLUMN session_cwd;
     DROP INDEX enrollment_credential_idx;
     ALTER TABLE enrollment_transactions DROP COLUMN credential_id;
     ALTER TABLE enrollment_transactions DROP COLUMN recovery_expires_at;
     ALTER TABLE machines DROP COLUMN display_alias;
     ALTER TABLE projects DROP COLUMN sync_content;
     ALTER TABLE projects DROP COLUMN retention_days;
     DROP TABLE turn_queue;
     ALTER TABLE logical_sessions DROP COLUMN queue_version;
     ALTER TABLE execution_segments DROP COLUMN history_mode;
     DROP TABLE usage_days; DROP TABLE session_usage; DROP TABLE machine_usage; PRAGMA user_version = 7`,
  );
  seed.close();

  const upgraded = new ControlPlaneDatabase(databasePath);
  t.after(() => {
    upgraded.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(
    Number((upgraded.sqlite.prepare("PRAGMA user_version").get() as { user_version: number }).user_version),
    28,
  );
  const columns = upgraded.all<{ name: string }>("PRAGMA table_info(enrollment_transactions)").map((column) => column.name);
  assert.ok(columns.includes("credential_id"));
  assert.ok(columns.includes("recovery_expires_at"));
  assert.ok(upgraded.get("SELECT 1 FROM sqlite_master WHERE type='index' AND name='enrollment_credential_idx'"));
});

test("v4 through v8 migration freezes a Project with multiple legacy active Sessions", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agentfleet-migration-v4-"));
  const databasePath = join(directory, "control-plane.sqlite");
  const testConfig = config(databasePath);
  const seed = new ControlPlaneDatabase(databasePath);
  const owner = seed.bootstrap(testConfig);
  const timestamp = new Date().toISOString();
  const machineId = "mach_migration_conflict";
  const projectId = "proj_migration_conflict";
  const singletonProjectId = "proj_migration_singleton";
  insertMachine(seed, owner.workspaceId, machineId, timestamp);
  seed.run(
    `INSERT INTO projects(
      project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,
      lease_version,created_at,last_reported_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    projectId,
    owner.workspaceId,
    machineId,
    "external-migration-conflict",
    "Migration conflict",
    "/work/migration-conflict",
    "identity-migration-conflict",
    1,
    timestamp,
    timestamp,
  );
  seed.run(
    `INSERT INTO projects(
      project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,
      lease_version,created_at,last_reported_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    singletonProjectId,
    owner.workspaceId,
    machineId,
    "external-migration-singleton",
    "Migration singleton",
    "/work/migration-singleton",
    "identity-migration-singleton",
    1,
    timestamp,
    timestamp,
  );
  seed.run(
    `INSERT INTO logical_sessions(
      logical_session_id,workspace_id,machine_id,project_id,external_id,title,managed,
      execution_state,reachability,active_turn_id,created_at,updated_at
    ) VALUES(?,?,?,?,?, ?,1,'running','live',?, ?,?)`,
    "session_migration_singleton",
    owner.workspaceId,
    machineId,
    singletonProjectId,
    "session_migration_singleton",
    "Legacy active singleton",
    "native-turn-singleton",
    timestamp,
    timestamp,
  );
  seed.run(
    `INSERT INTO execution_segments(
      execution_segment_id,logical_session_id,machine_id,project_id,external_id,
      native_thread_id,history_completeness,created_at
    ) VALUES(?,?,?,?,?,?,'complete',?)`,
    "segment_migration_singleton",
    "session_migration_singleton",
    machineId,
    singletonProjectId,
    "segment_migration_singleton",
    "native-thread-singleton",
    timestamp,
  );
  for (const suffix of ["a", "b"]) {
    const sessionId = `session_migration_${suffix}`;
    const segmentId = `segment_migration_${suffix}`;
    seed.run(
      `INSERT INTO logical_sessions(
        logical_session_id,workspace_id,machine_id,project_id,external_id,title,managed,
        execution_state,reachability,active_turn_id,created_at,updated_at
      ) VALUES(?,?,?,?,?, ?,1,'running','live',?, ?,?)`,
      sessionId,
      owner.workspaceId,
      machineId,
      projectId,
      sessionId,
      `Legacy active ${suffix}`,
      `native-turn-${suffix}`,
      timestamp,
      timestamp,
    );
    seed.run(
      `INSERT INTO execution_segments(
        execution_segment_id,logical_session_id,machine_id,project_id,external_id,
        native_thread_id,history_completeness,created_at
      ) VALUES(?,?,?,?,?,?,'complete',?)`,
      segmentId,
      sessionId,
      machineId,
      projectId,
      segmentId,
      `native-thread-${suffix}`,
      timestamp,
    );
  }
  seed.sqlite.exec(
    `DROP TABLE codex_preferences;
     ALTER TABLE machines DROP COLUMN codex_catalog_json;
     ALTER TABLE logical_sessions DROP COLUMN runtime_settings_json;
     DROP TABLE native_thread_bindings;
     DROP TABLE machine_operations;
     DROP TABLE credential_renewal_challenges;
     DROP TABLE session_creation_requests;
     ALTER TABLE machines DROP COLUMN maintenance_types_json;
     ALTER TABLE machines DROP COLUMN discovery_json;
     ALTER TABLE machines DROP COLUMN codex_profile_json;
     DROP INDEX sessions_filter_page_idx;
     ALTER TABLE machines DROP COLUMN command_types_json;
     ALTER TABLE machines DROP COLUMN runtime_read_only;
     ALTER TABLE machines DROP COLUMN runtime_read_only_reasons_json;
     ALTER TABLE logical_sessions DROP COLUMN management_revision;
     ALTER TABLE logical_sessions DROP COLUMN codex_profile_id;
     ALTER TABLE logical_sessions DROP COLUMN session_cwd;
     DROP TABLE enrollment_transactions;
     DROP TABLE reconciliation_session_targets;
     DROP TABLE reconciliation_stream_targets;
     DROP TABLE reconciliation_cycles;
     ALTER TABLE producer_streams DROP COLUMN resume_connection_id;
     ALTER TABLE producer_streams DROP COLUMN max_declared_host_seq;
     DROP TABLE project_turn_migration_members;
     DROP TABLE project_turn_reservations;
     ALTER TABLE machines DROP COLUMN display_alias;
     ALTER TABLE projects DROP COLUMN sync_content;
     ALTER TABLE projects DROP COLUMN retention_days;
     DROP TABLE turn_queue;
     ALTER TABLE logical_sessions DROP COLUMN queue_version;
     ALTER TABLE execution_segments DROP COLUMN history_mode;
     DROP TABLE usage_days; DROP TABLE session_usage; DROP TABLE machine_usage; PRAGMA user_version = 4`,
  );
  seed.close();

  const upgraded = new ControlPlaneDatabase(databasePath);
  t.after(() => {
    upgraded.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(
    Number((upgraded.sqlite.prepare("PRAGMA user_version").get() as { user_version: number }).user_version),
    28,
  );
  const reservation = upgraded.get<{
    state: string;
    conflict_count: number;
    command_id: string | null;
    native_turn_id: string | null;
  }>("SELECT state,conflict_count,command_id,native_turn_id FROM project_turn_reservations WHERE project_id=?", projectId);
  assert.deepEqual({ ...reservation }, {
    state: "migration_conflict",
    conflict_count: 2,
    command_id: null,
    native_turn_id: null,
  });
  assert.deepEqual(
    { ...upgraded.get<{ state: string; native_turn_id: string | null; binding_state: string }>(
      "SELECT state,native_turn_id,binding_state FROM project_turn_reservations WHERE project_id=?",
      singletonProjectId,
    ) },
    { state: "active", native_turn_id: "native-turn-singleton", binding_state: "legacy_unbound" },
    "a singleton legacy active turn is explicitly marked for weaker auditable settlement",
  );

  upgraded.run(
    `INSERT INTO agent_connections(
      connection_id,machine_id,transport_generation,producer_epoch,app_server_epoch,connected_at,hello_at
    ) VALUES('connection-migration',?,1,'producer-migration','app-server-migration',?,?)`,
    machineId,
    timestamp,
    timestamp,
  );
  upgraded.run(
    `INSERT INTO producer_streams(
      machine_id,producer_epoch,next_expected_host_seq,quarantined,updated_at,sealed
    ) VALUES(?,'producer-migration',1,0,?,0)`,
    machineId,
    timestamp,
  );
  const terminalPayload = { status: "completed" };
  const result = new CoordinationService(upgraded, testConfig).appendEvent(
    {
      connectionId: "connection-migration",
      machineId,
      workspaceId: owner.workspaceId,
      transportGeneration: 1,
      publicKey: `public-key-${machineId}`,
    },
    {
      eventId: "event-migration-terminal",
      payloadHash: payloadHash(terminalPayload),
      logicalSessionId: "session_migration_a",
      executionSegmentId: "segment_migration_a",
      projectId,
      producerEpoch: "producer-migration",
      appServerEpoch: "app-server-migration",
      hostSeq: 1,
      nativeThreadId: "native-thread-a",
      nativeTurnId: "native-turn-a",
      type: "turn.completed",
      schemaVersion: "1.0",
      contentEpoch: 1,
      occurredAt: new Date().toISOString(),
      payload: terminalPayload,
    },
  );
  assert.equal(result.ok, true);
  const afterFirstTerminal = upgraded.get<{ state: string; conflict_count: number }>(
    "SELECT state,conflict_count FROM project_turn_reservations WHERE project_id=?",
    projectId,
  );
  assert.equal(afterFirstTerminal?.state, "migration_conflict");
  assert.equal(
    afterFirstTerminal?.conflict_count,
    1,
    "one legacy terminal must not release a multi-Session migration freeze",
  );
  const secondTerminal = { status: "interrupted" };
  const secondResult = new CoordinationService(upgraded, testConfig).appendEvent(
    {
      connectionId: "connection-migration",
      machineId,
      workspaceId: owner.workspaceId,
      transportGeneration: 1,
      publicKey: `public-key-${machineId}`,
    },
    {
      eventId: "event-migration-terminal-b",
      payloadHash: payloadHash(secondTerminal),
      logicalSessionId: "session_migration_b",
      executionSegmentId: "segment_migration_b",
      projectId,
      producerEpoch: "producer-migration",
      appServerEpoch: "app-server-migration",
      hostSeq: 2,
      nativeThreadId: "native-thread-b",
      nativeTurnId: "native-turn-b",
      type: "turn.interrupted",
      schemaVersion: "1.0",
      contentEpoch: 1,
      occurredAt: new Date().toISOString(),
      payload: secondTerminal,
    },
  );
  assert.equal(secondResult.ok, true);
  assert.equal(
    upgraded.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM project_turn_reservations WHERE project_id=?",
      projectId,
    )?.count,
    0,
    "the migration freeze releases only after every exact legacy terminal",
  );
  const singletonTerminal = { status: "completed" };
  const singletonResult = new CoordinationService(upgraded, testConfig).appendEvent(
    {
      connectionId: "connection-migration",
      machineId,
      workspaceId: owner.workspaceId,
      transportGeneration: 1,
      publicKey: `public-key-${machineId}`,
    },
    {
      eventId: "event-migration-terminal-singleton",
      payloadHash: payloadHash(singletonTerminal),
      logicalSessionId: "session_migration_singleton",
      executionSegmentId: "segment_migration_singleton",
      projectId: singletonProjectId,
      producerEpoch: "producer-migration",
      appServerEpoch: "app-server-migration",
      hostSeq: 3,
      nativeThreadId: "native-thread-singleton",
      nativeTurnId: "native-turn-singleton",
      type: "turn.completed",
      schemaVersion: "1.0",
      contentEpoch: 1,
      occurredAt: new Date().toISOString(),
      payload: singletonTerminal,
    },
  );
  assert.equal(singletonResult.ok, true);
  assert.equal(
    upgraded.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM project_turn_reservations WHERE project_id=?",
      singletonProjectId,
    )?.count,
    0,
    "a v4 singleton can terminate after upgrade instead of freezing forever",
  );
  assert.equal(
    upgraded.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM audit_entries
       WHERE project_id=? AND action='project_turn.release' AND metadata_json LIKE '%legacy_unbound%'`,
      singletonProjectId,
    )?.count,
    1,
    "settlement records that it relied on weaker legacy evidence",
  );
});

test("producer replay grants are connection-scoped, monotonic, and require a retained contiguous range", (t) => {
  const database = new ControlPlaneDatabase(":memory:");
  t.after(() => database.close());
  const testConfig = config(":memory:");
  const owner = database.bootstrap(testConfig);
  const timestamp = new Date().toISOString();
  const machineId = "mach_reconciliation_bounds";
  insertMachine(database, owner.workspaceId, machineId, timestamp);
  database.run(
    `INSERT INTO producer_streams(
      machine_id,producer_epoch,next_expected_host_seq,quarantined,updated_at,sealed,
      resume_through_host_seq,max_declared_host_seq
    ) VALUES(?,'producer-old',5,0,?,1,NULL,4)`,
    machineId,
    timestamp,
  );
  const registry = new RegistryService(database, testConfig);
  const coordination = new CoordinationService(database, testConfig);

  const connect = (connectionId: string, generation: number): AgentConnectionIdentity => {
    database.run(
      `INSERT INTO agent_connections(connection_id,machine_id,transport_generation,connected_at)
       VALUES(?,?,?,?)`,
      connectionId,
      machineId,
      generation,
      timestamp,
    );
    return {
      connectionId,
      machineId,
      workspaceId: owner.workspaceId,
      transportGeneration: generation,
      publicKey: `public-key-${machineId}`,
    };
  };
  const hello = (
    producerEpoch: string,
    reconciliationStreams: Array<{ producerEpoch: string; throughHostSeq: number }>,
    resumeStreams: Array<{
      producerEpoch: string;
      firstRetainedHostSeq: number;
      lastProducedHostSeq: number;
      lastAckedHostSeq: number;
    }> = [],
  ) => ({
    producerEpoch,
    appServerEpoch: `app-${producerEpoch}`,
    agentVersion: "0.1.0",
    codexVersion: "0.153.2",
    schemaHash: "d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a",
    credentialProtectionLevel: "software_protected" as const,
    platform: "linux",
    platformRelease: "24.04",
    architecture: "x86_64",
    capacity: "idle" as const,
    projects: [],
    sessions: [],
    reconciliationStreams,
    resumeStreams,
  });

  const first = connect("connection-bounds-1", 1);
  registry.registerHello(
    first,
    hello(
      "producer-current-1",
      [
        { producerEpoch: "producer-old", throughHostSeq: 100 },
        { producerEpoch: "producer-current-1", throughHostSeq: 0 },
      ],
      [{ producerEpoch: "producer-old", firstRetainedHostSeq: 5, lastProducedHostSeq: 100, lastAckedHostSeq: 4 }],
    ),
  );
  assert.deepEqual(
    { ...database.get<{ resume_through_host_seq: number | null; resume_connection_id: string | null; max_declared_host_seq: number }>(
      "SELECT resume_through_host_seq,resume_connection_id,max_declared_host_seq FROM producer_streams WHERE machine_id=? AND producer_epoch='producer-old'",
      machineId,
    ) },
    { resume_through_host_seq: 100, resume_connection_id: first.connectionId, max_declared_host_seq: 100 },
  );
  database.run(
    "UPDATE producer_streams SET next_expected_host_seq=51 WHERE machine_id=? AND producer_epoch='producer-old'",
    machineId,
  );
  registry.disconnect(first, "test reconnect");

  const second = connect("connection-bounds-2", 2);
  assert.throws(
    () => registry.registerHello(
      second,
      hello("producer-current-2", [{ producerEpoch: "producer-current-2", throughHostSeq: 0 }]),
    ),
    (error: unknown) => error instanceof AppError && error.code === "RECONCILIATION_INCOMPLETE",
  );
  assert.deepEqual(
    { ...database.get<{ resume_through_host_seq: number | null; resume_connection_id: string | null; max_declared_host_seq: number }>(
      "SELECT resume_through_host_seq,resume_connection_id,max_declared_host_seq FROM producer_streams WHERE machine_id=? AND producer_epoch='producer-old'",
      machineId,
    ) },
    { resume_through_host_seq: null, resume_connection_id: null, max_declared_host_seq: 100 },
  );
  assert.notEqual(
    database.get<{ reachability: string }>("SELECT reachability FROM machines WHERE machine_id=?", machineId)?.reachability,
    "online",
    "omitting a partially received promised stream must not restore command admission",
  );
  assert.throws(
    () => coordination.appendEvent(second, {
      eventId: "event-old-grant-leak",
      payloadHash: payloadHash({}),
      logicalSessionId: "not-reached",
      executionSegmentId: "not-reached",
      projectId: "not-reached",
      producerEpoch: "producer-old",
      appServerEpoch: "app-producer-old",
      hostSeq: 51,
      type: "item.completed",
      schemaVersion: "1.0",
      occurredAt: timestamp,
      payload: {},
    }),
    (error: unknown) => error instanceof AppError && error.code === "AGENT_HELLO_REQUIRED",
    "a rejected hello grants no replay authority to its connection",
  );
  assert.throws(
    () => registry.registerHello(second, hello("producer-current-2", [])),
    (error: unknown) => error instanceof AppError && error.code === "INVALID_RECONCILIATION_STREAMS",
  );
  assert.notEqual(
    database.get<{ reachability: string }>("SELECT reachability FROM machines WHERE machine_id=?", machineId)?.reachability,
    "online",
    "even a malformed re-hello must synchronously close command admission",
  );
  registry.disconnect(second, "test rollback");

  const rollbackConnection = connect("connection-bounds-3", 3);
  assert.throws(
    () => registry.registerHello(
      rollbackConnection,
      hello(
        "producer-current-3",
        [
          { producerEpoch: "producer-old", throughHostSeq: 60 },
          { producerEpoch: "producer-current-3", throughHostSeq: 0 },
        ],
        [{ producerEpoch: "producer-old", firstRetainedHostSeq: 51, lastProducedHostSeq: 60, lastAckedHostSeq: 50 }],
      ),
    ),
    (error: unknown) => error instanceof AppError && error.code === "RECONCILIATION_TARGET_ROLLBACK",
  );
  assert.notEqual(
    database.get<{ reachability: string }>("SELECT reachability FROM machines WHERE machine_id=?", machineId)?.reachability,
    "online",
  );
  registry.disconnect(rollbackConnection, "test snapshot gap");

  const gapConnection = connect("connection-bounds-4", 4);
  assert.throws(
    () => registry.registerHello(
      gapConnection,
      hello(
        "producer-current-4",
        [
          { producerEpoch: "producer-old", throughHostSeq: 120 },
          { producerEpoch: "producer-current-4", throughHostSeq: 0 },
        ],
        [{ producerEpoch: "producer-old", firstRetainedHostSeq: 60, lastProducedHostSeq: 120, lastAckedHostSeq: 50 }],
      ),
    ),
    (error: unknown) => error instanceof AppError && error.code === "SNAPSHOT_REQUIRED",
  );
  assert.notEqual(
    database.get<{ reachability: string }>("SELECT reachability FROM machines WHERE machine_id=?", machineId)?.reachability,
    "online",
  );
});

test("manual recovery stays frozen until scoped request and authenticated terminal proof", () => {
 const db=new ControlPlaneDatabase(":memory:");const owner=db.bootstrap(config(":memory:"));const now=new Date().toISOString();
 try {
  insertMachine(db,owner.workspaceId,"manual-host",now);
  db.run("UPDATE machines SET maintenance_types_json=? WHERE machine_id='manual-host'",JSON.stringify(["session.reconcile","catalog.refresh"]));
  db.run("INSERT INTO client_sessions(client_session_id,workspace_id,user_id,token_hash,csrf_hash,created_at,last_seen_at,expires_at) VALUES('manual-client',?,?, 'manual-token','manual-csrf',?,?,?)",owner.workspaceId,owner.userId,now,now,new Date(Date.now()+60000).toISOString());
  db.run("INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,lease_version,created_at,last_reported_at) VALUES('manual-project',?,'manual-host','project','Project','/work','identity',1,?,?)",owner.workspaceId,now,now);
  for(const id of ["manual-session","unrelated-session"]){
   db.run("INSERT INTO logical_sessions(logical_session_id,workspace_id,machine_id,project_id,external_id,title,managed,execution_state,reachability,created_at,updated_at) VALUES(?,?,'manual-host','manual-project',?,'Frozen',1,'unknown','live',?,?)",id,owner.workspaceId,id,now,now);
   db.run("INSERT INTO execution_segments(execution_segment_id,logical_session_id,machine_id,project_id,external_id,native_thread_id,created_at) VALUES(?,?,'manual-host','manual-project',?,?,?)",id+"-segment",id,id+"-segment",id+"-native",now);
  }
  db.run("INSERT INTO agent_connections(connection_id,machine_id,transport_generation,producer_epoch,app_server_epoch,connected_at) VALUES('manual-connection','manual-host',1,'producer','new-runtime',?)",now);
  const principal={workspaceId:owner.workspaceId,userId:owner.userId,clientSessionId:"manual-client",email:"admin@example.test",csrfHash:"manual-csrf",expiresAt:new Date(Date.now()+60000).toISOString()} as Principal;
  const service=new MaintenanceService(db);const state=(id="manual-session")=>db.get<{execution_state:string}>("SELECT execution_state FROM logical_sessions WHERE logical_session_id=?",id)!.execution_state;
  assert.equal(state(),"unknown");assert.equal(service.offers("manual-host").length,0);
  assert.throws(()=>service.create(principal,"manual-host","session.reconcile","missing-target"),/Choose a session/);
  assert.throws(()=>service.create(principal,"manual-host","session.reconcile","wrong-target","absent"),/not found/);
  const operation=service.create(principal,"manual-host","session.reconcile","manual-click","manual-session");
  assert.equal(state(),"unknown","Click alone cannot bypass proof");
  assert.throws(()=>service.create(principal,"manual-host","session.reconcile","manual-click","unrelated-session"),/another operation/);
  const offer=service.offers("manual-host")[0]!;assert.equal((offer.recoveryTarget as Record<string,unknown>).logicalSessionId,"manual-session");
  assert.throws(()=>service.result("wrong-host",String(operation.operationId),"succeeded",{recovered:true},undefined),/does not belong/);
  service.result("manual-host",String(operation.operationId),"succeeded",{recovered:true,nativeThreadId:"manual-session-native",nativeTurnId:"old-turn",previousAppServerEpoch:"old-runtime",status:"interrupted"},undefined);
  assert.equal(state(),"interrupted");assert.equal(state("unrelated-session"),"unknown");
  const audits=db.get<{n:number}>("SELECT COUNT(*) n FROM audit_entries WHERE action='session.manually_recovered'");assert.equal(audits?.n,1);
  service.result("manual-host",String(operation.operationId),"succeeded",{recovered:true},undefined);assert.equal(state(),"interrupted");
 } finally {db.close();}
});


function seedQueuedCommand(db: ControlPlaneDatabase, commandId = "queue-command", expiresAt = new Date(Date.now() + 600_000).toISOString()) {
  const owner = db.bootstrap(config(":memory:"));
  const now = new Date().toISOString();
  if (!db.get("SELECT 1 FROM machines WHERE machine_id='queue-host'")) {
    insertMachine(db, owner.workspaceId, "queue-host", now);
    db.run("INSERT INTO client_sessions(client_session_id,workspace_id,user_id,token_hash,csrf_hash,created_at,last_seen_at,expires_at) VALUES('queue-client',?,?,'queue-token','queue-csrf',?,?,?)", owner.workspaceId,owner.userId,now,now,expiresAt);
    db.run("INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,lease_version,created_at,last_reported_at) VALUES('queue-project',?,'queue-host','project','Project','/work','identity',1,?,?)",owner.workspaceId,now,now);
    db.run("INSERT INTO logical_sessions(logical_session_id,workspace_id,machine_id,project_id,external_id,title,managed,execution_state,reachability,created_at,updated_at) VALUES('queue-session',?,'queue-host','queue-project','session','Queue',1,'completed','live',?,?)",owner.workspaceId,now,now);
    db.run("INSERT INTO execution_segments(execution_segment_id,logical_session_id,machine_id,project_id,external_id,native_thread_id,created_at) VALUES('queue-segment','queue-session','queue-host','queue-project','segment','native-thread',?)",now);
  }
  const precondition = { executionSegmentId: "queue-segment", threadControlVersion: 1, projectLeaseVersion: 1, queueVersion: 0, expectedActiveTurnId: "previous-turn" };
  db.run("INSERT INTO commands(command_id,client_mutation_id,payload_hash,workspace_id,actor_user_id,actor_client_session_id,logical_session_id,execution_segment_id,type,precondition_json,payload_json,content_epoch,created_at,expires_at) VALUES(?,?,?,?,?,'queue-client','queue-session','queue-segment','turn.queue',?,'{}',1,?,?)",commandId,commandId,payloadHash({prompt:"queued prompt"}),owner.workspaceId,owner.userId,JSON.stringify(precondition),now,expiresAt);
  db.run("INSERT INTO command_contents(command_id,body_json,created_at,expires_at) VALUES(?,?,?,?)",commandId,JSON.stringify({prompt:"queued prompt"}),now,expiresAt);
  db.run("INSERT INTO command_projection(command_id,state,updated_at) VALUES(?,'queued',?)",commandId,now);
  db.run("INSERT INTO turn_queue(queue_item_id,command_id,workspace_id,logical_session_id,actor_client_session_id,accepted_queue_version,position,state,created_at,expires_at,updated_at) VALUES(?,?,?,'queue-session','queue-client',1,(SELECT COALESCE(MAX(position),0)+1 FROM turn_queue),'queued',?,?,?)",commandId+"-item",commandId,owner.workspaceId,now,expiresAt,now);
  return owner;
}

test("queue receipts converge, only proven pre-claim reconciliation refusal can defer, and old failures never replay", async t => {
  for (const outcome of ["applied", "invalidated", "unknown", "expired"] as const) {
    await t.test(outcome, () => {
      const db = new ControlPlaneDatabase(":memory:");
      try {
        const owner = seedQueuedCommand(db);
        const service = new CoordinationService(db, config(":memory:"));
        const now = new Date().toISOString();
        db.run("INSERT INTO agent_connections(connection_id,machine_id,transport_generation,connected_at) VALUES('queue-connection','queue-host',1,?)",now);
        const connection = {connectionId:"queue-connection",machineId:"queue-host",workspaceId:owner.workspaceId,transportGeneration:1,publicKey:"key"};
        const target = { machineId:"queue-host", transportGeneration:1, producerEpoch:"producer", appServerEpoch:"runtime" };
        const state = () => db.get<{state:string}>("SELECT state FROM turn_queue WHERE command_id='queue-command'")!.state;
        const immutable = JSON.stringify(db.get("SELECT * FROM commands WHERE command_id='queue-command'"));
        db.run("UPDATE logical_sessions SET execution_state='running',active_turn_id='previous-turn'");
        assert.equal(service.activateNextQueued("queue-session"),null);
        assert.equal(service.createDispatchAttempt("queue-command",target),null,"queued commands cannot bypass promotion");
        db.run("UPDATE logical_sessions SET execution_state='unknown',active_turn_id=NULL");
        assert.equal(service.activateNextQueued("queue-session"),null,"manual freezes never promote automatically");
        db.run("UPDATE logical_sessions SET execution_state='completed'");
        assert.ok(service.activateNextQueued("queue-session"));
        const first = String(service.createDispatchAttempt("queue-command",target)!.dispatchAttemptId);
        service.markOffered(first);
        const refused = service.transitionAttempt(connection,first,"invalidated",{code:"RECONCILIATION_INCOMPLETE"});
        assert.equal(refused.state,"delivery_failed_before_claim");
        assert.equal(refused.deferredUntilReconciliation,true);
        assert.equal(service.transitionAttempt(connection,first,"invalidated",{code:"RECONCILIATION_INCOMPLETE"}).duplicate,true);
        assert.equal(state(),"dispatching");
        assert.equal(db.get<{state:string}>("SELECT state FROM command_projection")!.state,"accepted");
        if (outcome === "expired") {
          assert.equal(service.expireUndispatchedCommands(new Date(Date.now()+700_000).toISOString()),1);
        } else {
          const second = String(service.createDispatchAttempt("queue-command",target)!.dispatchAttemptId);
          service.markOffered(second);
          if (outcome === "invalidated") service.transitionAttempt(connection,second,"invalidated",{code:"PROJECT_BINDING_MISSING"});
          else {
            service.transitionAttempt(connection,second,"claimed");
            service.transitionAttempt(connection,second,"invoking");
            if (outcome === "unknown") {
              assert.throws(() => service.transitionAttempt(connection,second,"invalidated",{code:"RECONCILIATION_INCOMPLETE"}),/Cannot transition/);
              service.transitionAttempt(connection,second,"unknown");
            } else {
              service.transitionAttempt(connection,second,"responded");
              service.transitionAttempt(connection,second,"applied",{ok:true});
            }
          }
        }
        assert.equal(state(),outcome);
        assert.equal(service.createDispatchAttempt("queue-command",target),null);
        assert.equal(service.reconcileQueueStates(),0);
        assert.equal(JSON.stringify(db.get("SELECT * FROM commands WHERE command_id='queue-command'")),immutable);
        if (outcome === "invalidated" || outcome === "expired") assert.equal(db.get("SELECT 1 FROM project_turn_reservations"),undefined);
        if (outcome === "unknown") assert.equal(db.get<{state:string}>("SELECT state FROM project_turn_reservations")!.state,"unknown");
        // Reproduce the old stale queue while another command owns the active turn.
        db.run("UPDATE turn_queue SET state='dispatching'");
        db.run("DELETE FROM project_turn_reservations");
        seedQueuedCommand(db,"new-command");
        db.run("INSERT INTO project_turn_reservations(project_id,logical_session_id,command_id,native_turn_id,state,version,reserved_at,updated_at) VALUES('queue-project','queue-session','new-command','new-turn','active',1,?,?)",now,now);
        const reservation = JSON.stringify(db.get("SELECT * FROM project_turn_reservations"));
        assert.equal(service.reconcileQueueStates(),1);
        assert.equal(state(),outcome);
        assert.equal(service.reconcileQueueStates(),0);
        assert.equal(JSON.stringify(db.get("SELECT * FROM project_turn_reservations")),reservation);
      } finally { db.close(); }
    });
  }
});


test("WebSocket queue waits through repeated hello cycles and dispatches once after reconciliation", async t => {
  const {app,db} = await buildControlPlane(config(":memory:"));
  const owner = seedQueuedCommand(db);
  await app.ready();
  const now = new Date().toISOString();
  db.run("INSERT INTO agent_tickets(ticket_id,machine_id,token_hash,audience,transport_generation,created_at,expires_at) VALUES('queue-ticket','queue-host',?,'agent-ws',1,?,?)",sha256("test-queue-ticket"),now,new Date(Date.now()+60000).toISOString());
  const messages: Record<string,unknown>[] = [];
  const socket = await app.injectWS("/ws/agent?ticket=test-queue-ticket", {}, {onInit: ws => ws.on("message", raw => messages.push(JSON.parse(raw.toString()) as Record<string,unknown>))});
  t.after(async () => { socket.terminate(); await new Promise(resolve => setImmediate(resolve)); await app.close(); });
  const next = async (type: string) => {
    for (let i=0; i<200; i++) {
      const index = messages.findIndex(message => message.type === type);
      if (index>=0) return messages.splice(index,1)[0]!;
      await new Promise(resolve => setTimeout(resolve,10));
    }
    throw new Error(`Missing ${type}: ${JSON.stringify(messages)}`);
  };
  const send = (message: Record<string,unknown>) => socket.send(JSON.stringify(message));
  await next("welcome");
  const hello = { type:"hello", producerEpoch:"queue-producer", appServerEpoch:"queue-runtime", agentVersion:"0.28.0",
    codexVersion:"0.153.4",schemaHash:"d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a",
    credentialProtectionLevel:"software_protected",platform:"linux",platformRelease:"24.04",architecture:"x86_64",capacity:"idle",
    projects:[{externalId:"project",alias:"Project",canonicalRoot:"/work",identityHash:"identity",leaseVersion:1}],
    sessions:[{externalId:"session",projectExternalId:"project",executionSegmentExternalId:"segment",nativeThreadId:"native-thread",managed:true,executionState:"completed",threadControlVersion:1}],
    reconciliationStreams:[{producerEpoch:"queue-producer",throughHostSeq:0}] };
  send(hello);
  const initial = await next("hello.ack");
  assert.equal(db.get<{state:string}>("SELECT state FROM turn_queue")!.state,"queued");
  assert.equal(db.all("SELECT * FROM dispatch_attempts").length,0);
  const complete = async (ack: Record<string,unknown>) => {
    send({type:"reconciliation.complete",reconciliationId:ack.reconciliationId,reconciliationStreams:hello.reconciliationStreams});
    await next("reconciliation.ack");
  };
  await complete(initial);
  const first = await next("command.offer");
  // The Agent starts another registry hello before it receives the first offer.
  send(hello);
  send({type:"command.ack",dispatchAttemptId:first.dispatchAttemptId,state:"invalidated",detail:{code:"RECONCILIATION_INCOMPLETE"}});
  const secondHello = await next("hello.ack");
  const rejected = await next("command.ack.confirmed");
  assert.equal(rejected.state,"delivery_failed_before_claim");
  assert.equal(db.get<{state:string}>("SELECT state FROM command_projection")!.state,"accepted");
  assert.equal(db.get<{state:string}>("SELECT state FROM turn_queue")!.state,"dispatching");
  send({type:"heartbeat",capacity:"idle",activeTurns:0});
  assert.equal((await next("error")).code,"RECONCILIATION_REQUIRED");
  assert.equal(db.all("SELECT * FROM dispatch_attempts").length,1,"no retry before reconciliation completes");
  await complete(secondHello);
  const second = await next("command.offer");
  assert.notEqual(second.dispatchAttemptId,first.dispatchAttemptId);
  assert.equal((second.command as Record<string,unknown>).commandId,"queue-command");
  for (const state of ["claimed","invoking","responded","applied"]) {
    send({type:"command.ack",dispatchAttemptId:second.dispatchAttemptId,state,detail:{ok:true}});
    await next("command.ack.confirmed");
  }
  assert.equal(db.get<{state:string}>("SELECT state FROM turn_queue")!.state,"applied");
  const append = async (hostSeq: number, type: string, nativeTurnId: string, payload: Record<string,unknown>) => {
    send({type:"event.append",event:{eventId:`queue-event-${hostSeq}`,logicalSessionId:"queue-session",executionSegmentId:"queue-segment",projectId:"queue-project",
      producerEpoch:"queue-producer",appServerEpoch:"queue-runtime",nativeThreadId:"native-thread",nativeTurnId,hostSeq,type,schemaVersion:"1.0",contentEpoch:1,
      occurredAt:new Date().toISOString(),payloadHash:payloadHash(payload),payload}});
    await next("event.ack");
  };
  await append(1,"turn.started","queued-native-turn",{commandId:"queue-command"});
  assert.equal(db.get<{binding_state:string}>("SELECT binding_state FROM project_turn_reservations")!.binding_state,"bound");
  seedQueuedCommand(db,"next-queue-command");
  await append(2,"turn.completed","queued-native-turn",{});
  const third = await next("command.offer");
  assert.equal((third.command as Record<string,unknown>).commandId,"next-queue-command","the next queue item runs only after the exact previous native turn ends");
  await append(3,"command.result","fast-native-turn",{commandId:"next-queue-command",attemptId:third.dispatchAttemptId,commandType:"turn.queue",state:"applied",detail:{nativeTurnId:"fast-native-turn",status:"completed"}});
  assert.equal(db.get<{state:string}>("SELECT state FROM turn_queue WHERE command_id='next-queue-command'")!.state,"applied","durable terminal evidence converges even without transport ACKs");
  assert.equal(db.get("SELECT * FROM project_turn_reservations"),undefined,"fast queue completion releases only its own reservation");
  send({type:"command.ack",dispatchAttemptId:first.dispatchAttemptId,state:"invalidated",detail:{code:"RECONCILIATION_INCOMPLETE"}});
  assert.equal((await next("command.ack.confirmed")).duplicate,true);
  send({type:"heartbeat",capacity:"idle",activeTurns:0});
  await next("heartbeat.ack");
  assert.equal(db.all("SELECT * FROM dispatch_attempts").length,3,"terminal queue command is never offered again");
  assert.equal(messages.some(message => message.type === "command.offer"),false);
  assert.ok(owner.workspaceId);
});


test("dashboard shortcuts include old managed/running sessions beyond recent and paginated history", () => {
  const db = new ControlPlaneDatabase(":memory:");
  try {
    const owner = seedQueuedCommand(db);
    const principal: Principal = {...owner,clientSessionId:"queue-client",email:"admin@example.test",csrfHash:"queue-csrf",expiresAt:new Date(Date.now()+60000).toISOString()};
    const now=new Date().toISOString();
    for(let i=0;i<105;i++) {
      const id=`activity-${i}`;
      db.run("INSERT INTO logical_sessions(logical_session_id,workspace_id,machine_id,project_id,external_id,title,managed,execution_state,reachability,created_at,updated_at) VALUES(?,?,'queue-host','queue-project',?,?,? ,?,'live',?,?)",id,owner.workspaceId,id,id,i===0?1:0,i===1?"running":"idle",now,i<2?"2020-01-01T00:00:00.000Z":now);
      db.run("INSERT INTO execution_segments(execution_segment_id,logical_session_id,machine_id,project_id,external_id,native_thread_id,created_at) VALUES(?,?,'queue-host','queue-project',?,?,?)",id+"-seg",id,id+"-seg",id+"-native",now);
    }
    const registry = new RegistryService(db,config(":memory:"));
    const result=registry.dashboard(principal);
    const activity=result.activitySessions as Array<{logicalSessionId:string}>;
    assert.deepEqual(activity.map(s=>s.logicalSessionId).sort(),["activity-0","activity-1","queue-session"]);
    assert.equal((result.recentSessions as unknown[]).length,20);
    assert.equal(registry.listSessionsPage(principal,{limit:100}).items.some(s=>s.logicalSessionId==="activity-0"),false);
  } finally {db.close();}
});
