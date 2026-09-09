import type { ControlPlaneConfig } from "./config.js";
import { sameLeaseAccount } from "./lease-ownership.js";
import { parseImages } from "./images.js";
import { CloudImages } from "./cloud-images.js";
import { canonicalJson, futureIso, newId, nowIso, payloadHash as hashPayload } from "./crypto.js";
import { PermissionPreferencesService } from "./permission-preferences.js";
import { parseCodexCatalog, validateCodexSettings } from "./codex-settings.js";
import { CodexPreferencesService } from "./codex-preferences.js";
import type { ControlPlaneDatabase } from "./db.js";
import { AppError, invariant } from "./errors.js";
import type {
  CommandType,
  ControlLeaseView,
  CreateCommandRequest,
  DurableAgentEvent,
} from "./api-schema.js";
import { COMMAND_TYPES } from "./api-schema.js";
import type { Principal } from "./auth.js";
import type { AgentConnectionIdentity } from "./registry.js";
import { supportsCommand } from "./capabilities.js";
import { validateInputAnswers } from "./user-input.js";
import { sanitizeInspection } from "./codex-inspection.js";

export interface DispatchTarget {
  machineId: string;
  transportGeneration: number;
  producerEpoch: string;
  appServerEpoch: string;
}

export interface EventAck {
  ok: true;
  eventId: string;
  duplicate: boolean;
  projectionEpoch: number;
  sessionSeq: number;
  nextExpectedHostSeq: number;
  event: Record<string, unknown>;
}

export interface EventNack {
  ok: false;
  eventId: string;
  code:
    | "HOST_SEQUENCE_GAP"
    | "SOURCE_STREAM_CORRUPT"
    | "PRODUCER_EPOCH_SEALED"
    | "CONTENT_EPOCH_STALE"
    | "CONTENT_EPOCH_FUTURE";
  message: string;
  expectedHostSeq?: number;
}

interface SessionCommandRow {
  paginated_history: number;
  logical_session_id: string;
  workspace_id: string;
  machine_id: string;
  project_id: string;
  managed: number;
  execution_state: string;
  reachability: string;
  thread_control_version: number;
  turn_control_version: number;
  active_turn_id: string | null;
  control_lease_version: number;
  security_state: string;
  identity_state: string;
  compatibility: string;
  agent_version: string | null;
  command_types_json: string | null;
  runtime_read_only: number;
  machine_reachability: string;
  project_lease_version: number;
  execution_segment_id: string;
  native_thread_id: string | null;
  history_mode: "legacy" | "paginated" | null;
  content_epoch: number;
  queue_version: number;
  sync_content: number;
  retention_days: number;
}

interface ProjectTurnReservationRow {
  project_id: string;
  logical_session_id: string;
  command_id: string | null;
  native_turn_id: string | null;
  bound_producer_epoch: string | null;
  bound_app_server_epoch: string | null;
  binding_state: "unbound" | "bound" | "legacy_unbound";
  state: "accepted" | "dispatching" | "active" | "unknown" | "migration_conflict";
  conflict_count: number;
  version: number;
  reserved_at: string;
  updated_at: string;
}

const KNOWN_EVENT_TYPES = new Set([
  "session.created",
  "thread.started",
  "thread.claimed",
  "thread.released",
  "thread.updated",
  "thread.status_changed",
  "turn.started",
  "turn.steered",
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "turn.error",
  "item.started",
  "item.completed",
  "approval.requested",
  "approval.resolved",
  "approval.auto_declined",
  "turn.diff.final",
  "command.result",
  "agent.warning",
]);

const ATTEMPT_TRANSITIONS: Record<string, Set<string>> = {
  created: new Set(["offered", "expired", "invalidated", "delivery_failed_before_claim"]),
  offered: new Set(["claimed", "expired", "invalidated", "delivery_failed_before_claim"]),
  claimed: new Set(["invoking", "invalidated", "unknown"]),
  invoking: new Set(["responded", "unknown"]),
  responded: new Set(["applied", "unknown"]),
  applied: new Set(),
  delivery_failed_before_claim: new Set(),
  expired: new Set(),
  invalidated: new Set(),
  unknown: new Set(),
};
const SUCCESS_ATTEMPT_RANK: Record<string, number> = {
  claimed: 1,
  invoking: 2,
  responded: 3,
  applied: 4,
};

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  return JSON.parse(value) as unknown;
}

function ensureRecord(value: unknown, message = "Expected an object"): Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), 400, "INVALID_INPUT", message);
  return value as Record<string, unknown>;
}

export class CoordinationService {
  constructor(
    private readonly db: ControlPlaneDatabase,
    private readonly config: ControlPlaneConfig,
  ) {}

  acquireLease(
    principal: Principal,
    logicalSessionId: string,
    expectedVersion?: number,
    ttlSeconds?: number,
  ): ControlLeaseView {
    invariant(expectedVersion === undefined || (Number.isSafeInteger(expectedVersion) && expectedVersion >= 0), 400, "INVALID_LEASE_VERSION", "expectedVersion must be non-negative");
    const ttl = ttlSeconds ?? this.config.controlLeaseTtlSeconds;
    invariant(Number.isSafeInteger(ttl) && ttl >= 10 && ttl <= 120, 400, "INVALID_LEASE_TTL", "Lease TTL must be between 10 and 120 seconds");
    return this.db.transaction(() => {
      const timestamp = nowIso();
      const expired = this.db.all<{ control_lease_id: string; holder_client_session_id: string }>(
        `SELECT control_lease_id,holder_client_session_id FROM control_leases
         WHERE logical_session_id=? AND state='active' AND expires_at<=?`,
        logicalSessionId,
        timestamp,
      );
      for (const lease of expired) {
        this.db.run(
          `UPDATE control_leases SET state='expired',version=version+1,ended_at=?
           WHERE control_lease_id=? AND state='active'`,
          timestamp,
          lease.control_lease_id,
        );
        this.db.run(
          `UPDATE logical_sessions SET control_lease_version=control_lease_version+1,updated_at=?
           WHERE logical_session_id=?`,
          timestamp,
          logicalSessionId,
        );
        this.db.audit({
          workspaceId: principal.workspaceId,
          logicalSessionId,
          controlLeaseId: lease.control_lease_id,
          action: "control_lease.expire",
          metadata: { previousHolderClientSessionId: lease.holder_client_session_id },
        });
      }
      const session = this.db.get<{ control_lease_version: number }>(
        "SELECT control_lease_version FROM logical_sessions WHERE logical_session_id=? AND workspace_id=?",
        logicalSessionId,
        principal.workspaceId,
      );
      invariant(session, 404, "SESSION_NOT_FOUND", "Logical Session was not found");
      const active = this.db.get<{ control_lease_id: string; holder_client_session_id: string; expires_at: string; version: number }>(
        "SELECT control_lease_id,holder_client_session_id,expires_at,version FROM control_leases WHERE logical_session_id=? AND state='active'",
        logicalSessionId,
      );
      if (active && sameLeaseAccount(this.db, active.holder_client_session_id, principal.clientSessionId)) {
        const version = active.version + 1;
        const expiresAt = futureIso(ttl);
        this.db.run("UPDATE control_leases SET version=?,renewed_at=?,expires_at=? WHERE control_lease_id=?",
          version, timestamp, expiresAt, active.control_lease_id);
        this.db.run("UPDATE logical_sessions SET control_lease_version=?,updated_at=? WHERE logical_session_id=?",
          version, timestamp, logicalSessionId);
        this.db.audit({ workspaceId: principal.workspaceId, actorUserId: principal.userId,
          actorClientSessionId: principal.clientSessionId, logicalSessionId, controlLeaseId: active.control_lease_id,
          action: "control_lease.reuse", metadata: { version, expiresAt } });
        return { leaseId: active.control_lease_id, logicalSessionId, holderClientSessionId: active.holder_client_session_id,
          isMine: true, version, expiresAt, state: "active" };
      }
      invariant(
        !active,
        409,
        "CONTROL_LEASE_HELD",
        "Another Client Session holds the control lease",
        {
          holderClientSessionId: active?.holder_client_session_id,
          expiresAt: active?.expires_at,
        },
      );
      invariant(expectedVersion === undefined || session.control_lease_version === expectedVersion,
        409, "LEASE_VERSION_CONFLICT", "Control lease version changed", { currentVersion: session.control_lease_version });
      const version = session.control_lease_version + 1;
      const leaseId = newId("lease");
      const expiresAt = futureIso(ttl);
      const advanced = this.db.run(
        `UPDATE logical_sessions SET control_lease_version=?,updated_at=?
         WHERE logical_session_id=? AND workspace_id=? AND control_lease_version=?`,
        version,
        timestamp,
        logicalSessionId,
        principal.workspaceId,
        session.control_lease_version,
      );
      invariant(Number(advanced.changes) === 1, 409, "LEASE_VERSION_CONFLICT", "Control lease changed concurrently");
      this.db.run(
        `INSERT INTO control_leases(
          control_lease_id,logical_session_id,holder_client_session_id,version,state,acquired_at,renewed_at,expires_at
        ) VALUES(?,?,?,?,'active',?,?,?)`,
        leaseId,
        logicalSessionId,
        principal.clientSessionId,
        version,
        timestamp,
        timestamp,
        expiresAt,
      );
      this.db.audit({
        workspaceId: principal.workspaceId,
        actorUserId: principal.userId,
        actorClientSessionId: principal.clientSessionId,
        logicalSessionId,
        controlLeaseId: leaseId,
        action: "control_lease.acquire",
        metadata: { version, expiresAt },
      });
      return {
        leaseId,
        logicalSessionId,
        holderClientSessionId: principal.clientSessionId,
        isMine: true,
        version,
        expiresAt,
        state: "active",
      };
    });
  }

  renewLease(
    principal: Principal,
    logicalSessionId: string,
    leaseId: string,
    expectedVersion: number,
    ttlSeconds?: number,
  ): ControlLeaseView {
    const ttl = ttlSeconds ?? this.config.controlLeaseTtlSeconds;
    invariant(Number.isSafeInteger(expectedVersion) && expectedVersion > 0, 400, "INVALID_LEASE_VERSION", "expectedVersion must be positive");
    invariant(Number.isSafeInteger(ttl) && ttl >= 10 && ttl <= 120, 400, "INVALID_LEASE_TTL", "Lease TTL must be between 10 and 120 seconds");
    return this.db.transaction(() => {
      const lease = this.db.get<{
        holder_client_session_id: string;
        version: number;
        expires_at: string;
        state: string;
      }>(
        `SELECT l.holder_client_session_id,l.version,l.expires_at,l.state FROM control_leases l
         JOIN logical_sessions s ON s.logical_session_id=l.logical_session_id
         WHERE l.control_lease_id=? AND l.logical_session_id=? AND s.workspace_id=?`,
        leaseId,
        logicalSessionId,
        principal.workspaceId,
      );
      invariant(lease, 404, "CONTROL_LEASE_NOT_FOUND", "Control lease was not found");
      invariant(lease.state === "active" && lease.expires_at > nowIso(), 409, "CONTROL_LEASE_EXPIRED", "Control lease is no longer active");
      invariant(sameLeaseAccount(this.db, lease.holder_client_session_id, principal.clientSessionId), 403, "CONTROL_LEASE_NOT_HELD", "This account does not hold the lease");
      invariant(lease.version === expectedVersion, 409, "LEASE_VERSION_CONFLICT", "Control lease version changed", { currentVersion: lease.version });
      const version = expectedVersion + 1;
      const timestamp = nowIso();
      const expiresAt = futureIso(ttl);
      const updated = this.db.run(
        `UPDATE control_leases SET version=?,renewed_at=?,expires_at=?
         WHERE control_lease_id=? AND state='active' AND version=? AND expires_at>?`,
        version,
        timestamp,
        expiresAt,
        leaseId,
        expectedVersion,
        timestamp,
      );
      invariant(Number(updated.changes) === 1, 409, "LEASE_VERSION_CONFLICT", "Control lease changed concurrently");
      this.db.run(
        "UPDATE logical_sessions SET control_lease_version=?,updated_at=? WHERE logical_session_id=?",
        version,
        timestamp,
        logicalSessionId,
      );
      this.db.audit({
        workspaceId: principal.workspaceId,
        actorUserId: principal.userId,
        actorClientSessionId: principal.clientSessionId,
        logicalSessionId,
        controlLeaseId: leaseId,
        action: "control_lease.renew",
        metadata: { version, expiresAt },
      });
      return {
        leaseId,
        logicalSessionId,
        holderClientSessionId: lease.holder_client_session_id,
        isMine: true,
        version,
        expiresAt,
        state: "active",
      };
    });
  }

  releaseLease(
    principal: Principal,
    logicalSessionId: string,
    leaseId: string,
    expectedVersion: number,
  ): ControlLeaseView {
    return this.db.transaction(() => {
      const lease = this.db.get<{
        holder_client_session_id: string;
        version: number;
        expires_at: string;
        state: ControlLeaseView["state"];
      }>(
        `SELECT l.holder_client_session_id,l.version,l.expires_at,l.state FROM control_leases l
         JOIN logical_sessions s ON s.logical_session_id=l.logical_session_id
         WHERE l.control_lease_id=? AND l.logical_session_id=? AND s.workspace_id=?`,
        leaseId,
        logicalSessionId,
        principal.workspaceId,
      );
      invariant(lease, 404, "CONTROL_LEASE_NOT_FOUND", "Control lease was not found");
      invariant(lease.state === "active", 409, "CONTROL_LEASE_NOT_ACTIVE", "Control lease is not active");
      invariant(sameLeaseAccount(this.db, lease.holder_client_session_id, principal.clientSessionId), 403, "CONTROL_LEASE_NOT_HELD", "This account does not hold the lease");
      invariant(lease.version === expectedVersion, 409, "LEASE_VERSION_CONFLICT", "Control lease version changed", { currentVersion: lease.version });
      const version = expectedVersion + 1;
      const timestamp = nowIso();
      const released = this.db.run(
        `UPDATE control_leases SET state='released',version=?,ended_at=?
         WHERE control_lease_id=? AND state='active' AND version=?`,
        version,
        timestamp,
        leaseId,
        expectedVersion,
      );
      invariant(Number(released.changes) === 1, 409, "LEASE_VERSION_CONFLICT", "Control lease changed concurrently");
      this.db.run(
        "UPDATE logical_sessions SET control_lease_version=?,updated_at=? WHERE logical_session_id=?",
        version,
        timestamp,
        logicalSessionId,
      );
      this.db.audit({
        workspaceId: principal.workspaceId,
        actorUserId: principal.userId,
        actorClientSessionId: principal.clientSessionId,
        logicalSessionId,
        controlLeaseId: leaseId,
        action: "control_lease.release",
        metadata: { version },
      });
      return {
        leaseId,
        logicalSessionId,
        holderClientSessionId: principal.clientSessionId,
        version,
        expiresAt: lease.expires_at,
        state: "released",
      };
    });
  }

  createCommand(principal: Principal, logicalSessionId: string, input: CreateCommandRequest): {
    command: Record<string, unknown>;
    duplicate: boolean;
  } {
    invariant(COMMAND_TYPES.includes(input.type), 400, "COMMAND_TYPE_DENIED", "Command type is not allowed");
    invariant(typeof input.clientMutationId === "string" && input.clientMutationId.length >= 8 && input.clientMutationId.length <= 200, 400, "INVALID_MUTATION_ID", "clientMutationId is invalid");
    const precondition = { ...ensureRecord(input.precondition, "precondition must be an object") };
    const payload = { ...ensureRecord(input.payload, "payload must be an object") };
    invariant(!Object.hasOwn(payload, "permissionProfile") && !Object.hasOwn(payload, "permissionSource") && !Object.hasOwn(payload, "sessionTitle"), 400, "SERVER_SETTINGS_ONLY", "Permissions and native title are resolved by the control plane");
    const computedHash = hashPayload({ type: input.type, precondition, payload });
    invariant(!input.payloadHash || input.payloadHash === computedHash, 400, "PAYLOAD_HASH_MISMATCH", "payloadHash does not match the canonical command body", { computedHash });

    return this.db.transaction(() => {
      const existing = this.db.get<{ command_id: string; payload_hash: string; request_hash: string | null }>(
        `SELECT command_id,payload_hash,request_hash FROM commands
         WHERE workspace_id=? AND actor_client_session_id=? AND client_mutation_id=?`,
        principal.workspaceId,
        principal.clientSessionId,
        input.clientMutationId,
      );
      if (existing) {
        invariant((existing.request_hash ?? existing.payload_hash) === computedHash, 409, "IDEMPOTENCY_KEY_REUSE", "clientMutationId was reused with a different payload");
        return { command: this.getCommand(principal, existing.command_id), duplicate: true };
      }

      const session = this.commandSession(principal, logicalSessionId);
      if ((input.type === "turn.start" || input.type === "turn.queue") && payload.settings === undefined) {
        invariant(!new CodexPreferencesService(this.db).read(principal, logicalSessionId).desired, 409, "CODEX_SETTINGS_REQUIRED", "Saved model defaults exist; reload runtime settings before sending, or clear the saved override");
      }
      if (payload.settings !== undefined) {
        invariant(input.type === "turn.start" || input.type === "turn.queue", 400, "CODEX_SETTINGS_ACTION_DENIED", "Settings can only apply when starting a new turn");
        const machine = this.db.get<{ codex_catalog_json: string | null }>("SELECT codex_catalog_json FROM machines WHERE machine_id=?", session.machine_id);
        validateCodexSettings(payload.settings, machine?.codex_catalog_json ? parseCodexCatalog(JSON.parse(machine.codex_catalog_json)) : null);
      }
      const claiming = input.type === "thread.claim";
      invariant(
        claiming ? session.managed === 0 : session.managed === 1,
        409,
        claiming ? "SESSION_ALREADY_MANAGED" : "EXTERNAL_SESSION_READ_ONLY",
        claiming ? "Session is already managed" : "Existing session must be claimed before writing",
      );
      invariant(session.reachability === "live", 409, "SESSION_RECONCILING", "Session must finish reconciliation before accepting a command");
      invariant(session.identity_state === "active", 409, "MACHINE_REVOKED", "Machine is revoked");
      invariant(session.security_state === "normal", 409, "MACHINE_READ_ONLY", "Machine is degraded read-only");
      invariant(session.compatibility === "compatible", 409, "MACHINE_INCOMPATIBLE", "Machine is not P0a-compatible");
      invariant(session.machine_reachability === "online", 409, "MACHINE_OFFLINE", "Machine must be online when accepting a command");
      invariant(!session.runtime_read_only, 409, "MACHINE_READ_ONLY", "Agent runtime currently supports read-only access");
      invariant(supportsCommand(session.command_types_json, input.type), 409, "AGENT_CAPABILITY_UNAVAILABLE", "Agent has not reported support for this operation; update the connection service");
      let images: string[];
      try { images = parseImages(payload.images); } catch (error) { throw new AppError(400, "INVALID_IMAGES", (error as Error).message); }
      if (images.length) {
        invariant(["turn.start", "turn.queue", "turn.steer"].includes(input.type), 400, "IMAGES_NOT_ALLOWED", "此操作不能附带图片");
        const raw = this.db.get<{ codex_catalog_json: string | null }>("SELECT codex_catalog_json FROM machines WHERE machine_id=?", session.machine_id);
        const catalog = parseCodexCatalog(raw?.codex_catalog_json ? JSON.parse(raw.codex_catalog_json) : null);
        invariant(catalog?.imageInput === true, 409, "AGENT_IMAGE_UNSUPPORTED", "请先更新这台主机的连接服务，当前版本尚不能接收图片；图片不会作为纯文字发送");
        const selected = payload.settings as { model?: string } | undefined;
        const model = catalog.models.find(entry => entry.model === selected?.model);
        invariant(!model?.inputModalities || model.inputModalities.includes("image"), 409, "MODEL_IMAGE_UNSUPPORTED", "当前模型不支持图片，请更换模型");
      }
      const nativeOperation = ["thread.rename", "thread.archive", "thread.unarchive", "thread.fork", "thread.delete.preview", "thread.delete"].includes(input.type);
      if (nativeOperation || ["turn.start", "turn.compact", "turn.review", "thread.release"].includes(input.type)) {
        const pendingNative = this.db.get<{ count: number }>(`SELECT count(*) AS count FROM commands c JOIN command_projection cp ON cp.command_id=c.command_id
          JOIN logical_sessions s ON s.logical_session_id=c.logical_session_id WHERE s.project_id=? AND c.type IN ('thread.rename','thread.archive','thread.unarchive','thread.fork','thread.delete.preview','thread.delete') AND cp.state IN ('accepted','dispatching','unknown')`, session.project_id);
        invariant(!pendingNative?.count, 409, "NATIVE_OPERATION_PENDING", "Wait for the previous native operation to be confirmed");
      }
      if (["thread.claim", "turn.start", "turn.compact", "turn.review", "turn.queue", "thread.release", "thread.archive", "thread.fork"].includes(input.type)) {
        const state = this.db.get<{ runtime_settings_json: string | null }>("SELECT runtime_settings_json FROM logical_sessions WHERE logical_session_id=?", logicalSessionId);
        invariant(!state?.runtime_settings_json || JSON.parse(state.runtime_settings_json)?.archived !== true, 409, "THREAD_ARCHIVED", "Restore the archived host session first");
      }

      let executionSegmentId = session.execution_segment_id;
      if (input.type === "thread.claim") {
        this.requireLease(principal, logicalSessionId, input.controlLeaseId);
        invariant(session.execution_state === "idle", 409, "THREAD_BUSY", "Host thread must be idle before it can be claimed");
        invariant(session.active_turn_id === null, 409, "THREAD_BUSY", "Host thread has an active turn");
        invariant(session.native_thread_id !== null, 409, "THREAD_NOT_CLAIMABLE", "Native thread id is unavailable");
        invariant(session.history_mode === "legacy" || (session.history_mode === "paginated" && session.paginated_history === 1), 409, "THREAD_HISTORY_UNSUPPORTED", "Update the agent to resume this history format");
        invariant(precondition.nativeThreadId === session.native_thread_id, 409, "THREAD_VERSION_CONFLICT", "Native thread id changed");
        invariant(precondition.threadControlVersion === session.thread_control_version, 409, "THREAD_VERSION_CONFLICT", "threadControlVersion changed", { currentVersion: session.thread_control_version });
        invariant(precondition.projectLeaseVersion === session.project_lease_version, 409, "PROJECT_VERSION_CONFLICT", "projectLeaseVersion changed", { currentVersion: session.project_lease_version });
        invariant(Object.hasOwn(precondition, "expectedActiveTurnId") && precondition.expectedActiveTurnId === null, 409, "ACTIVE_TURN_CONFLICT", "expectedActiveTurnId must be null");
        invariant(Object.keys(payload).length === 0, 400, "INVALID_CLAIM_PAYLOAD", "thread.claim does not accept a payload");
      } else if (input.type === "thread.release") {
        this.requireLease(principal, logicalSessionId, input.controlLeaseId);
        invariant(
          ["idle", "completed", "failed", "interrupted"].includes(session.execution_state),
          409,
          "THREAD_BUSY",
          "Thread must not have an active turn before management can be released",
        );
        invariant(session.active_turn_id === null, 409, "THREAD_BUSY", "Thread has an active turn");
        invariant(session.native_thread_id !== null, 409, "THREAD_NOT_MANAGED", "Native thread id is unavailable");
        invariant(precondition.nativeThreadId === session.native_thread_id, 409, "THREAD_VERSION_CONFLICT", "Native thread id changed");
        invariant(precondition.threadControlVersion === session.thread_control_version, 409, "THREAD_VERSION_CONFLICT", "threadControlVersion changed", { currentVersion: session.thread_control_version });
        invariant(precondition.projectLeaseVersion === session.project_lease_version, 409, "PROJECT_VERSION_CONFLICT", "projectLeaseVersion changed", { currentVersion: session.project_lease_version });
        invariant(Object.hasOwn(precondition, "expectedActiveTurnId") && precondition.expectedActiveTurnId === null, 409, "ACTIVE_TURN_CONFLICT", "expectedActiveTurnId must be null");
        invariant(Object.keys(payload).length === 0, 400, "INVALID_RELEASE_PAYLOAD", "thread.release does not accept a payload");
        const pendingApprovals = this.db.get<{ count: number }>(
          "SELECT count(*) AS count FROM approvals WHERE logical_session_id=? AND state='pending'",
          logicalSessionId,
        );
        invariant(Number(pendingApprovals?.count ?? 0) === 0, 409, "APPROVAL_PENDING", "Resolve pending approvals before releasing management");
        const pendingQueue = this.db.get<{ count: number }>(
          "SELECT count(*) AS count FROM turn_queue WHERE logical_session_id=? AND state IN ('queued','dispatching','unknown')",
          logicalSessionId,
        );
        invariant(Number(pendingQueue?.count ?? 0) === 0, 409, "QUEUE_NOT_EMPTY", "Cancel or finish queued turns before releasing management");
      } else if (input.type === "thread.terminals.stop") {
        this.requireLease(principal, logicalSessionId, input.controlLeaseId);
        invariant(Object.keys(payload).length === 0, 400, "INVALID_NATIVE_PAYLOAD", "Stopping background terminals takes no payload");
        invariant(session.native_thread_id && precondition.nativeThreadId === session.native_thread_id && precondition.executionSegmentId === executionSegmentId, 409, "THREAD_VERSION_CONFLICT", "Terminal target changed");
        invariant(precondition.threadControlVersion === session.thread_control_version && precondition.projectLeaseVersion === session.project_lease_version && precondition.expectedActiveTurnId === session.active_turn_id, 409, "THREAD_VERSION_CONFLICT", "Refresh the exact terminal target before stopping");
      } else if (input.type === "codex.inspect") {
        invariant(!input.controlLeaseId && Object.keys(payload).length === 0, 400, "INVALID_INSPECTION", "Inspection is read-only and takes no payload or control lease");
        invariant(precondition.executionSegmentId === executionSegmentId && precondition.projectLeaseVersion === session.project_lease_version, 409, "PROJECT_VERSION_CONFLICT", "Inspection target changed");
        invariant(session.sync_content === 1, 409, "CONTENT_SYNC_DISABLED", "Enable project content sync before requesting a cloud environment snapshot");
      } else if (nativeOperation) {
        this.requireLease(principal, logicalSessionId, input.controlLeaseId);
        invariant(session.active_turn_id === null && ["idle", "completed", "failed", "interrupted"].includes(session.execution_state), 409, "THREAD_BUSY", "Wait for the active task");
        invariant(session.native_thread_id && precondition.nativeThreadId === session.native_thread_id, 409, "THREAD_VERSION_CONFLICT", "Native thread changed");
        invariant(precondition.threadControlVersion === session.thread_control_version && precondition.projectLeaseVersion === session.project_lease_version && precondition.expectedActiveTurnId === null, 409, "THREAD_VERSION_CONFLICT", "Refresh session state before operating");
        invariant(!this.db.get("SELECT 1 FROM project_turn_reservations WHERE project_id=?", session.project_id), 409, "PROJECT_TURN_RESERVED", "Project has an active or uncertain task");
        invariant(!this.db.get("SELECT 1 FROM approvals WHERE logical_session_id=? AND state='pending'", logicalSessionId) && !this.db.get("SELECT 1 FROM turn_queue WHERE logical_session_id=? AND state IN ('queued','dispatching','unknown')", logicalSessionId), 409, "SESSION_HAS_PENDING_WORK", "Resolve questions, approvals and queued turns first");
        if (input.type === "thread.rename") invariant(Object.keys(payload).length === 1 && typeof payload.name === "string" && payload.name.trim().length > 0 && payload.name.length <= 200 && !payload.name.includes("\0"), 400, "INVALID_THREAD_NAME", "Provide a name of 1–200 characters");
        else if (input.type === "thread.delete") {
          invariant(Object.keys(payload).length === 2 && typeof payload.previewCommandId === "string" && typeof payload.fingerprint === "string",400,"DELETE_CONFIRMATION_REQUIRED","先读取删除预览，再明确确认删除");
          const preview = this.getCommand(principal,payload.previewCommandId);
          const plan = (preview.result as Record<string,unknown>)?.deletionPreview as Record<string,unknown> | undefined;
          invariant(preview.type === "thread.delete.preview" && preview.logicalSessionId === logicalSessionId && preview.state === "applied" && preview.outcome === "succeeded" && plan?.fingerprint === payload.fingerprint && typeof plan.expiresAt === "string" && plan.expiresAt > nowIso(),409,"DELETE_PREVIEW_EXPIRED","删除预览无效或过期，请重新预览确认");
        } else invariant(Object.keys(payload).length === 0, 400, "INVALID_NATIVE_PAYLOAD", "This operation takes no additional parameters");
      } else if (["turn.start", "turn.compact", "turn.review"].includes(input.type)) {
        this.requireLease(principal, logicalSessionId, input.controlLeaseId);
        invariant(session.execution_state === "idle" || ["completed", "failed", "interrupted"].includes(session.execution_state), 409, "TURN_ALREADY_ACTIVE", "Session already has an active turn");
        invariant(precondition.executionSegmentId === executionSegmentId, 409, "SEGMENT_VERSION_CONFLICT", "executionSegmentId does not match");
        invariant(precondition.threadControlVersion === session.thread_control_version, 409, "THREAD_VERSION_CONFLICT", "threadControlVersion changed", { currentVersion: session.thread_control_version });
        invariant(Object.hasOwn(precondition, "expectedActiveTurnId") && precondition.expectedActiveTurnId === null && session.active_turn_id === null, 409, "ACTIVE_TURN_CONFLICT", "expectedActiveTurnId must be null and the session must be idle", { activeTurnId: session.active_turn_id });
        invariant(precondition.projectLeaseVersion === session.project_lease_version, 409, "PROJECT_VERSION_CONFLICT", "projectLeaseVersion changed", { currentVersion: session.project_lease_version });
        if (input.type === "turn.start") invariant(typeof payload.prompt === "string" && (payload.prompt.trim().length > 0 || images.length > 0) && Buffer.byteLength(payload.prompt) <= 200_000, 400, "INVALID_PROMPT", "请填写消息或粘贴图片，文字不能超过 200 KB");
        else invariant(session.native_thread_id && Object.keys(payload).length === 0, 400, "INVALID_NATIVE_PAYLOAD", "Native turns require an existing thread and an empty payload");
      } else if (input.type === "turn.queue") {
        invariant(session.sync_content === 1, 409, "QUEUE_REQUIRES_CONTENT_SYNC", "Queue is unavailable while Project content sync is disabled");
        invariant(!input.controlLeaseId, 400, "QUEUE_LEASE_FORBIDDEN", "queued turns use queueVersion instead of a Control Lease");
        invariant(session.active_turn_id !== null, 409, "QUEUE_NOT_NEEDED", "Queue is available only while a turn is active");
        invariant(precondition.executionSegmentId === executionSegmentId, 409, "SEGMENT_VERSION_CONFLICT", "executionSegmentId does not match");
        invariant(precondition.threadControlVersion === session.thread_control_version, 409, "THREAD_VERSION_CONFLICT", "threadControlVersion changed", { currentVersion: session.thread_control_version });
        invariant(precondition.expectedActiveTurnId === session.active_turn_id, 409, "ACTIVE_TURN_CONFLICT", "active turn changed", { activeTurnId: session.active_turn_id });
        invariant(precondition.projectLeaseVersion === session.project_lease_version, 409, "PROJECT_VERSION_CONFLICT", "projectLeaseVersion changed", { currentVersion: session.project_lease_version });
        invariant(precondition.queueVersion === session.queue_version, 409, "QUEUE_VERSION_CONFLICT", "queueVersion changed", { currentVersion: session.queue_version });
        invariant(typeof payload.prompt === "string" && (payload.prompt.trim().length > 0 || images.length > 0) && Buffer.byteLength(payload.prompt) <= 200_000, 400, "INVALID_PROMPT", "请填写消息或粘贴图片，文字不能超过 200 KB");
      } else if (input.type === "turn.steer") {
        invariant(!input.controlLeaseId, 400, "STEER_LEASE_FORBIDDEN", "Steer uses turnControlVersion instead of a Control Lease");
        invariant(session.active_turn_id !== null, 409, "NO_ACTIVE_TURN", "Session has no active turn");
        invariant(precondition.nativeTurnId === session.active_turn_id, 409, "ACTIVE_TURN_CONFLICT", "nativeTurnId changed", { activeTurnId: session.active_turn_id });
        invariant(precondition.turnControlVersion === session.turn_control_version, 409, "TURN_VERSION_CONFLICT", "turnControlVersion changed", { currentVersion: session.turn_control_version });
        invariant(typeof payload.prompt === "string" && (payload.prompt.trim().length > 0 || images.length > 0) && Buffer.byteLength(payload.prompt) <= 200_000, 400, "INVALID_PROMPT", "请填写消息或粘贴图片，文字不能超过 200 KB");
      } else if (input.type === "turn.cancel") {
        this.requireLease(principal, logicalSessionId, input.controlLeaseId);
        invariant(session.active_turn_id !== null, 409, "NO_ACTIVE_TURN", "Session has no active turn");
        invariant(precondition.nativeTurnId === session.active_turn_id, 409, "ACTIVE_TURN_CONFLICT", "nativeTurnId changed", { activeTurnId: session.active_turn_id });
        invariant(precondition.turnControlVersion === session.turn_control_version, 409, "TURN_VERSION_CONFLICT", "turnControlVersion changed", { currentVersion: session.turn_control_version });
      } else {
        invariant(!input.controlLeaseId, 400, "APPROVAL_LEASE_FORBIDDEN", "approval.decide_once does not use a Control Lease");
        const decision = payload.decision;
        if (input.type === "approval.decide_once") invariant(decision === "approve" || decision === "reject", 400, "INVALID_APPROVAL_DECISION", "decision must be approve or reject");
        invariant(!Object.hasOwn(payload, "scope") || payload.scope === "once", 400, "APPROVAL_SCOPE_DENIED", "Only scope=once is allowed");
        invariant(typeof precondition.approvalId === "string", 400, "APPROVAL_PRECONDITION_REQUIRED", "approvalId is required");
        const approval = this.db.get<{
          logical_session_id: string;
          execution_segment_id: string;
          action_hash: string;
          app_server_epoch: string;
          version: number;
          state: string;
          context_json: string;
        }>("SELECT * FROM approvals WHERE approval_id=?", precondition.approvalId as string);
        invariant(approval && approval.logical_session_id === logicalSessionId, 404, "APPROVAL_NOT_FOUND", "Approval was not found");
        const context = ensureRecord(JSON.parse(approval.context_json));
        const action = ensureRecord(context.action ?? {});
        invariant((input.type === "input.respond") === (action.kind === "user_input"), 400, "INPUT_RESPONSE_REQUIRED", "Question answers and permission decisions cannot be interchanged");
        if (input.type === "input.respond") {
          invariant(Object.keys(payload).length === 1 && Object.hasOwn(payload, "answers"), 400, "INPUT_ANSWERS_INVALID", "Only answers are accepted");
          validateInputAnswers(payload.answers, action.questions);
        }
        if (typeof context.expiresAt === "string") invariant(Date.parse(context.expiresAt) > Date.now(), 409, "APPROVAL_EXPIRED", "Request has expired");
        invariant(approval.state === "pending", 409, "APPROVAL_ALREADY_DECIDED", "Approval has already been decided");
        invariant(precondition.approvalVersion === approval.version, 409, "APPROVAL_VERSION_CONFLICT", "approvalVersion changed", { currentVersion: approval.version });
        invariant(precondition.actionHash === approval.action_hash, 409, "APPROVAL_ACTION_CONFLICT", "actionHash changed");
        invariant(precondition.appServerEpoch === approval.app_server_epoch, 409, "APP_SERVER_EPOCH_CONFLICT", "appServerEpoch changed");
        executionSegmentId = approval.execution_segment_id;
      }

      // Snapshot inheritance only for NEW commands. Retries retain the accepted
      // snapshot even if defaults changed; the wire hash covers resolved values.
      if (["thread.claim", "turn.start", "turn.queue", "turn.compact", "turn.review"].includes(input.type)) {
        const permissions = new PermissionPreferencesService(this.db).read(principal, "sessions", logicalSessionId);
        invariant(permissions.supported || permissions.profile === "project", 409, "PERMISSION_AGENT_UPDATE_REQUIRED", "Update the host connection service before executing with expanded permissions");
        if (permissions.supported) {
          payload.permissionProfile = permissions.profile;
          payload.permissionSource = permissions.source;
          const name = this.db.get<{ title: string }>("SELECT title FROM logical_sessions WHERE logical_session_id=?", logicalSessionId)?.title;
          if (name && !["New Codex session", "Codex session"].includes(name)) payload.sessionTitle = name;
        }
      }
      if (input.type === "thread.rename") {
        precondition.expectedTitle = this.db.get<{ title: string }>("SELECT title FROM logical_sessions WHERE logical_session_id=?", logicalSessionId)!.title;
      }
      const wireHash = hashPayload({ type: input.type, precondition, payload });
      const commandId = newId("cmd");
      const timestamp = nowIso();
      const expiresIn = input.expiresInSeconds ?? (input.type === "turn.queue" ? 3_600 : 60);
      const maximumExpiry = input.type === "turn.queue" ? 86_400 : 300;
      invariant(Number.isSafeInteger(expiresIn) && expiresIn >= 1 && expiresIn <= maximumExpiry, 400, "INVALID_COMMAND_EXPIRY", `Command expiry must be between 1 and ${maximumExpiry} seconds`);
      const expiresAt = futureIso(expiresIn);
      this.db.run(
        `INSERT INTO commands(
          command_id,client_mutation_id,payload_hash,workspace_id,actor_user_id,actor_client_session_id,
          logical_session_id,execution_segment_id,control_lease_id,type,precondition_json,payload_json,
          content_epoch,created_at,expires_at,request_hash
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        commandId,
        input.clientMutationId,
        wireHash,
        principal.workspaceId,
        principal.userId,
        principal.clientSessionId,
        logicalSessionId,
        executionSegmentId,
        input.controlLeaseId ?? null,
        input.type,
        canonicalJson(precondition),
        "{}",
        session.content_epoch,
        timestamp,
        expiresAt,
        computedHash,
      );
      this.db.run(
        `INSERT INTO command_contents(command_id,body_json,created_at,expires_at)
         VALUES(?,?,?,?)`,
        commandId,
        canonicalJson(new CloudImages(this.db).store(session.machine_id, "command", commandId, payload, "command")),
        timestamp,
        futureIso(session.sync_content === 1 ? session.retention_days * 24 * 60 * 60 : 5 * 60),
      );
      const initialState = input.type === "turn.queue" ? "queued" : "accepted";
      this.db.run("INSERT INTO command_projection(command_id,state,updated_at) VALUES(?,?,?)", commandId, initialState, timestamp);
      this.db.run(
        "INSERT INTO command_lifecycle(command_id,state,created_at) VALUES(?,?,?)",
        commandId,
        initialState,
        timestamp,
      );

      if (input.type === "turn.queue") {
        const position = (this.db.get<{ next_position: number }>(
          "SELECT COALESCE(MAX(position),0)+1 AS next_position FROM turn_queue WHERE logical_session_id=?",
          logicalSessionId,
        )?.next_position ?? 1);
        const queueItemId = newId("queue");
        const nextQueueVersion = session.queue_version + 1;
        const advanced = this.db.run(
          "UPDATE logical_sessions SET queue_version=?,updated_at=? WHERE logical_session_id=? AND queue_version=?",
          nextQueueVersion,
          timestamp,
          logicalSessionId,
          session.queue_version,
        );
        invariant(Number(advanced.changes) === 1, 409, "QUEUE_VERSION_CONFLICT", "queue changed concurrently");
        this.db.run(
          `INSERT INTO turn_queue(
            queue_item_id,command_id,workspace_id,logical_session_id,actor_client_session_id,
            accepted_queue_version,position,state,created_at,expires_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,'queued',?,?,?)`,
          queueItemId,
          commandId,
          principal.workspaceId,
          logicalSessionId,
          principal.clientSessionId,
          nextQueueVersion,
          position,
          timestamp,
          expiresAt,
          timestamp,
        );
      }

      if (["turn.start", "turn.compact", "turn.review"].includes(input.type)) {
        const reservation = this.db.get<ProjectTurnReservationRow>(
          "SELECT * FROM project_turn_reservations WHERE project_id=?",
          session.project_id,
        );
        invariant(
          !reservation,
          409,
          "PROJECT_TURN_RESERVED",
          "Project already has an accepted, dispatching, active, or unknown turn",
          reservation
            ? {
                projectId: reservation.project_id,
                logicalSessionId: reservation.logical_session_id,
                commandId: reservation.command_id,
                nativeTurnId: reservation.native_turn_id,
                reservationState: reservation.state,
                conflictCount: reservation.conflict_count,
                reservationVersion: reservation.version,
              }
            : undefined,
        );
        this.db.run(
          `INSERT INTO project_turn_reservations(
            project_id,logical_session_id,command_id,state,version,reserved_at,updated_at
          ) VALUES(?,?,?,'accepted',1,?,?)`,
          session.project_id,
          logicalSessionId,
          commandId,
          timestamp,
          timestamp,
        );
      }

      if (input.type === "approval.decide_once" || input.type === "input.respond") {
        const approvalId = precondition.approvalId as string;
        const state = input.type === "input.respond" || payload.decision === "approve" ? "approved" : "rejected";
        const decision = this.db.run(
          `UPDATE approvals SET state=?,version=version+1,decision_command_id=?,decided_by_client_session_id=?,decided_at=?
           WHERE approval_id=? AND state='pending' AND version=?`,
          state,
          commandId,
          principal.clientSessionId,
          timestamp,
          approvalId,
          precondition.approvalVersion as number,
        );
        invariant(Number(decision.changes) === 1, 409, "APPROVAL_RACE_LOST", "Another Client Session decided this approval first");
      }

      this.db.audit({
        workspaceId: principal.workspaceId,
        actorUserId: principal.userId,
        actorClientSessionId: principal.clientSessionId,
        machineId: session.machine_id,
        projectId: session.project_id,
        logicalSessionId,
        controlLeaseId: input.controlLeaseId ?? null,
        action: `command.${input.type}`,
        metadata: {
          commandId,
          clientMutationId: input.clientMutationId,
          payloadHash: computedHash,
          approvalScope: input.type === "approval.decide_once" ? "once" : undefined,
        },
      });
      return { command: this.getCommand(principal, commandId), duplicate: false };
    });
  }

  private commandSession(principal: Principal, logicalSessionId: string): SessionCommandRow {
    const row = this.db.get<SessionCommandRow>(
      `SELECT s.*,m.security_state,m.identity_state,m.compatibility,m.agent_version,m.command_types_json,m.runtime_read_only,m.paginated_history,m.reachability AS machine_reachability,
        p.lease_version AS project_lease_version,p.sync_content,p.retention_days,
        e.execution_segment_id,e.native_thread_id,e.history_mode
       FROM logical_sessions s JOIN machines m ON m.machine_id=s.machine_id
       JOIN projects p ON p.project_id=s.project_id
       JOIN execution_segments e ON e.logical_session_id=s.logical_session_id AND e.ended_at IS NULL
       WHERE s.logical_session_id=? AND s.workspace_id=? AND s.deleted_at IS NULL ORDER BY e.created_at DESC LIMIT 1`,
      logicalSessionId,
      principal.workspaceId,
    );
    invariant(row, 404, "SESSION_NOT_FOUND", "Logical Session was not found");
    return row;
  }

  private requireLease(principal: Principal, logicalSessionId: string, leaseId: string | undefined): void {
    invariant(leaseId, 403, "CONTROL_LEASE_REQUIRED", "A Control Lease is required");
    const lease = this.db.get<{ holder_client_session_id: string; expires_at: string; state: string }>(
      `SELECT holder_client_session_id,expires_at,state FROM control_leases
       WHERE control_lease_id=? AND logical_session_id=?`,
      leaseId,
      logicalSessionId,
    );
    invariant(
      lease && lease.state === "active" && lease.expires_at > nowIso(),
      409,
      "CONTROL_LEASE_EXPIRED",
      "Control Lease is missing or expired",
    );
    invariant(sameLeaseAccount(this.db, lease.holder_client_session_id, principal.clientSessionId), 403, "CONTROL_LEASE_NOT_HELD", "This account does not hold the Control Lease");
  }

  getCommand(principal: Principal, commandId: string): Record<string, unknown> {
    const row = this.db.get<{
      command_id: string;
      client_mutation_id: string;
      payload_hash: string;
      workspace_id: string;
      actor_user_id: string;
      actor_client_session_id: string;
      logical_session_id: string;
      execution_segment_id: string;
      control_lease_id: string | null;
      type: CommandType;
      precondition_json: string;
      payload_json: string;
      command_body_json: string | null;
      command_content_deleted_at: string | null;
      created_at: string;
      expires_at: string;
      state: string;
      operation_updated_at: string;
      machine_id: string;
      project_id: string;
      project_external_id: string;
      session_external_id: string | null;
      execution_segment_external_id: string | null;
      content_epoch: number;
      queue_item_id: string | null;
      queue_position: number | null;
      queue_state: string | null;
      accepted_queue_version: number | null;
    }>(
      `SELECT c.*,p.state,p.updated_at AS operation_updated_at,s.machine_id,s.project_id,s.external_id AS session_external_id,
        e.external_id AS execution_segment_external_id,pr.external_id AS project_external_id
        ,cc.body_json AS command_body_json,cc.deleted_at AS command_content_deleted_at
        ,q.queue_item_id,q.position AS queue_position,q.state AS queue_state,q.accepted_queue_version
       FROM commands c JOIN command_projection p ON p.command_id=c.command_id
       JOIN logical_sessions s ON s.logical_session_id=c.logical_session_id
       JOIN projects pr ON pr.project_id=s.project_id
       JOIN execution_segments e ON e.execution_segment_id=c.execution_segment_id
       LEFT JOIN command_contents cc ON cc.command_id=c.command_id
       LEFT JOIN turn_queue q ON q.command_id=c.command_id
       WHERE c.command_id=? AND c.workspace_id=?`,
      commandId,
      principal.workspaceId,
    );
    invariant(row, 404, "COMMAND_NOT_FOUND", "Command was not found");
    const lifecycle = this.db.get<{ detail_json: string | null }>(
      "SELECT detail_json FROM command_lifecycle WHERE command_id=? ORDER BY lifecycle_id DESC LIMIT 1", commandId,
    );
    const detail = lifecycle?.detail_json ? parseJson(lifecycle.detail_json) as Record<string, unknown> : {};
    const errorValue = detail.error && typeof detail.error === "object" ? detail.error as Record<string, unknown> :
      (detail.ok === false || typeof detail.code === "string" ? detail : null);
    const failed = ["invalidated", "expired", "rejected"].includes(row.state) || (row.state === "applied" && errorValue !== null);
    const error = errorValue ? {
      code: typeof errorValue.code === "string" ? errorValue.code : "COMMAND_FAILED",
      message: typeof errorValue.message === "string" ? errorValue.message : "主机未完成此操作",
    } : failed ? { code: row.state.toUpperCase(), message: "操作未完成，请查看主机状态后重试" } : null;
    const latestAttempt = this.db.get<{ id: string; state: string; updatedAt: string }>(
      `SELECT a.dispatch_attempt_id AS id,p.state,p.updated_at AS updatedAt FROM dispatch_attempts a
       JOIN dispatch_attempt_projection p ON p.dispatch_attempt_id=a.dispatch_attempt_id
       WHERE a.command_id=? ORDER BY a.attempt_no DESC LIMIT 1`, commandId,
    );
    const resultValue = detail.response && typeof detail.response === "object" ? detail.response as Record<string, unknown> : detail;
    const result = Object.fromEntries(["nativeThreadId", "nativeTurnId", "status", "claimed", "released", "writerReleased", "hostThreadPreserved", "importedItems", "title", "archived", "forkedNativeThreadId", "backgroundTerminalsStopped"]
      .filter((key) => ["string", "number", "boolean"].includes(typeof resultValue[key])).map((key) => [key, resultValue[key]]));
    if (row.type === "thread.delete.preview" && resultValue.deletionPreview && typeof resultValue.deletionPreview === "object" && JSON.stringify(resultValue.deletionPreview).length <= 32_000) result.deletionPreview = resultValue.deletionPreview;
    if (row.type === "codex.inspect" && resultValue.inspection && typeof resultValue.inspection === "object" && JSON.stringify(resultValue.inspection).length <= 32_000) result.inspection = sanitizeInspection(resultValue.inspection);
    return {
      commandId: row.command_id,
      clientMutationId: row.client_mutation_id,
      payloadHash: row.payload_hash,
      workspaceId: row.workspace_id,
      actorUserId: row.actor_user_id,
      actorClientSessionId: row.actor_client_session_id,
      logicalSessionId: row.logical_session_id,
      executionSegmentId: row.execution_segment_id,
      machineId: row.machine_id,
      projectId: row.project_id,
      projectExternalId: row.project_external_id,
      sessionExternalId: row.session_external_id,
      executionSegmentExternalId: row.execution_segment_external_id,
      controlLeaseId: row.control_lease_id,
      type: row.type,
      precondition: parseJson(row.precondition_json),
      payload: row.command_content_deleted_at ? null : new CloudImages(this.db).hydrate(row.machine_id, "command", row.command_id, parseJson(row.command_body_json ?? row.payload_json)),
      payloadState: row.command_content_deleted_at ? "deleted" : "present",
      contentEpoch: row.content_epoch,
      state: row.state,
      outcome: row.state === "unknown" ? "unknown" : failed ? "failed" : row.state === "applied" ? "succeeded" : "pending",
      updatedAt: row.operation_updated_at,
      error,
      result: row.command_content_deleted_at ? null : result,
      latestAttempt: latestAttempt ?? null,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      ...(row.queue_item_id === null ? {} : {
        queue: {
          queueItemId: row.queue_item_id,
          position: row.queue_position,
          state: row.queue_state,
          acceptedQueueVersion: row.accepted_queue_version,
        },
      }),
    };
  }

  /** Reconcile only persisted, authenticated host journal evidence. Never redispatch. */
  recoverCommandResults(machineId: string, operationId: string): string[] {
    return this.db.transaction(() => {
      const operation = this.db.get<{result_json:string|null;workspace_id:string;created_at:string}>(
        "SELECT result_json,workspace_id,created_at FROM machine_operations WHERE operation_id=? AND machine_id=? AND type='commands.reconcile' AND state='succeeded'", operationId,machineId);
      if (!operation?.result_json) return [];
      const result = JSON.parse(operation.result_json);
      if (result.readOnly !== true || !Array.isArray(result.commands) || result.commands.length > 20) return [];
      const changed = new Set<string>();
      for (const evidence of result.commands) {
        if (!evidence || typeof evidence.commandId !== "string" || typeof evidence.attemptId !== "string" || !["applied","rejected"].includes(evidence.state)) continue;
        const command = this.db.get<{logical_session_id:string;project_id:string;type:string;active_turn_id:string|null;native_thread_id:string|null}>(
          `SELECT c.logical_session_id,s.project_id,c.type,s.active_turn_id,e.native_thread_id FROM commands c
           JOIN command_projection p ON p.command_id=c.command_id
           JOIN dispatch_attempts a ON a.command_id=c.command_id AND a.dispatch_attempt_id=?
           JOIN logical_sessions s ON s.logical_session_id=c.logical_session_id
           JOIN execution_segments e ON e.execution_segment_id=c.execution_segment_id AND e.ended_at IS NULL
           WHERE c.command_id=? AND a.machine_id=? AND s.machine_id=? AND c.workspace_id=?
             AND c.content_epoch=s.content_epoch AND c.created_at<=? AND p.state='unknown'`,
          evidence.attemptId,evidence.commandId,machineId,machineId,operation.workspace_id,operation.created_at);
        if (!command || evidence.commandType !== command.type) continue;
        const response = evidence.response && typeof evidence.response === "object" && !Array.isArray(evidence.response) ? evidence.response : {};
        if (response.nativeThreadId && command.native_thread_id && response.nativeThreadId !== command.native_thread_id) continue;
        const failed = evidence.state === "rejected" || Boolean(evidence.error);
        if (!failed && command.type === "thread.delete" && !this.validNativeDeletionEvidence(evidence.commandId,response)) continue;
        const startsTurn = ["turn.start","turn.queue","turn.compact","turn.review"].includes(command.type);
        const terminal = evidence.terminalStatus ?? response.status;
        if (!failed && startsTurn && (typeof response.nativeTurnId !== "string" || !["completed","failed","interrupted"].includes(terminal))) continue;
        if (!failed && startsTurn && command.active_turn_id && command.active_turn_id !== response.nativeTurnId) continue;
        const timestamp = nowIso();
        const detail = {source:"host_journal_recovery",operationId,...(failed ? {ok:false,error:evidence.error ?? {code:"COMMAND_REJECTED",message:"主机确认未执行此操作"}} : {response})};
        this.db.run("UPDATE dispatch_attempt_projection SET state=?,updated_at=? WHERE dispatch_attempt_id=? AND state='unknown'",evidence.state === "rejected" ? "invalidated" : "applied",timestamp,evidence.attemptId);
        this.db.run("INSERT INTO dispatch_attempt_lifecycle(dispatch_attempt_id,state,detail_json,created_at) VALUES(?,?,?,?)",evidence.attemptId,evidence.state === "rejected" ? "invalidated" : "applied",canonicalJson(detail),timestamp);
        this.setCommandState(evidence.commandId,evidence.state === "rejected" ? "invalidated" : "applied",detail);
        this.releaseProjectTurnReservationForCommand(evidence.commandId,"host_journal_recovery",timestamp);
        if (!failed && startsTurn) this.db.run(
          "UPDATE logical_sessions SET active_turn_id=NULL,execution_state=?,turn_control_version=turn_control_version+1,updated_at=? WHERE logical_session_id=? AND active_turn_id=?",
          terminal,timestamp,command.logical_session_id,response.nativeTurnId);
        this.db.audit({workspaceId:operation.workspace_id,machineId,logicalSessionId:command.logical_session_id,action:"command.recovered",outcome:failed?"failed":"succeeded",metadata:{operationId,commandId:evidence.commandId,attemptId:evidence.attemptId,source:"host_journal"}});
        changed.add(command.logical_session_id);
      }
      return [...changed];
    });
  }

  listCommands(principal: Principal, logicalSessionId: string): Record<string, unknown>[] {
    const session = this.db.get("SELECT 1 FROM logical_sessions WHERE logical_session_id=? AND workspace_id=?", logicalSessionId, principal.workspaceId);
    invariant(session, 404, "SESSION_NOT_FOUND", "Logical Session was not found");
    return this.db
      .all<{ command_id: string }>(
        `SELECT c.command_id FROM commands c JOIN command_projection p ON p.command_id=c.command_id
         WHERE c.logical_session_id=? AND (p.state IN ('accepted','dispatching','unknown') OR c.command_id IN (
           SELECT command_id FROM commands WHERE logical_session_id=? ORDER BY created_at DESC LIMIT 200
         )) ORDER BY c.created_at DESC`,
        logicalSessionId,
        logicalSessionId,
      )
      .map((row) => {
        const command = this.getCommand(principal, row.command_id);
        const payload = command.payload as Record<string, unknown> | null;
        // Receipts don't render attachments. History remains their authoritative display.
        if (payload?.images) { const { images, ...rest } = payload; command.payload = { ...rest, imageCount: Array.isArray(images) ? images.length : 0 }; }
        return command;
      });
  }

  listQueue(principal: Principal, logicalSessionId: string): Record<string, unknown>[] {
    const session = this.db.get(
      "SELECT 1 FROM logical_sessions WHERE logical_session_id=? AND workspace_id=?",
      logicalSessionId,
      principal.workspaceId,
    );
    invariant(session, 404, "SESSION_NOT_FOUND", "Logical Session was not found");
    return this.db.all<{
      queue_item_id: string;
      command_id: string;
      actor_client_session_id: string;
      accepted_queue_version: number;
      position: number;
      state: string;
      created_at: string;
      expires_at: string;
      updated_at: string;
    }>(
      `SELECT queue_item_id,command_id,actor_client_session_id,accepted_queue_version,
        position,state,created_at,expires_at,updated_at
       FROM turn_queue WHERE logical_session_id=? ORDER BY position`,
      logicalSessionId,
    ).map((row) => ({
      queueItemId: row.queue_item_id,
      commandId: row.command_id,
      actorClientSessionId: row.actor_client_session_id,
      acceptedQueueVersion: row.accepted_queue_version,
      position: row.position,
      state: row.state,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      updatedAt: row.updated_at,
    }));
  }

  cancelQueueItem(principal: Principal, logicalSessionId: string, queueItemId: string): Record<string, unknown> {
    return this.db.transaction(() => {
      const row = this.db.get<{
        command_id: string;
        actor_client_session_id: string;
        state: string;
        queue_version: number;
      }>(
        `SELECT q.command_id,q.actor_client_session_id,q.state,s.queue_version
         FROM turn_queue q JOIN logical_sessions s ON s.logical_session_id=q.logical_session_id
         WHERE q.queue_item_id=? AND q.logical_session_id=? AND q.workspace_id=?`,
        queueItemId,
        logicalSessionId,
        principal.workspaceId,
      );
      invariant(row, 404, "QUEUE_ITEM_NOT_FOUND", "Queued turn was not found");
      invariant(row.state === "queued", 409, "QUEUE_ITEM_NOT_CANCELLABLE", "Queued turn is no longer waiting");
      // Single-user P0b allows either participating browser to cancel, while
      // retaining actor attribution in the audit log.
      const timestamp = nowIso();
      this.db.run("UPDATE turn_queue SET state='cancelled',updated_at=? WHERE queue_item_id=? AND state='queued'", timestamp, queueItemId);
      this.db.run("UPDATE command_projection SET state='invalidated',updated_at=? WHERE command_id=?", timestamp, row.command_id);
      this.db.run("INSERT INTO command_lifecycle(command_id,state,detail_json,created_at) VALUES(?,'invalidated',?,?)", row.command_id, canonicalJson({ reason: "queue_cancelled", queueItemId }), timestamp);
      this.db.run("UPDATE logical_sessions SET queue_version=queue_version+1,updated_at=? WHERE logical_session_id=?", timestamp, logicalSessionId);
      this.db.audit({
        workspaceId: principal.workspaceId,
        actorUserId: principal.userId,
        actorClientSessionId: principal.clientSessionId,
        logicalSessionId,
        action: "turn_queue.cancel",
        metadata: { queueItemId, commandId: row.command_id, originalClientSessionId: row.actor_client_session_id },
      });
      return { queueItemId, commandId: row.command_id, state: "cancelled" };
    });
  }

  /** Promote exactly one queue head after a terminal turn; no Attempt exists before this point. */
  activateNextQueued(logicalSessionId: string): { commandId: string } | null {
    return this.db.transaction(() => {
      const session = this.db.get<SessionCommandRow>(
        `SELECT s.*,m.security_state,m.identity_state,m.compatibility,m.agent_version,m.runtime_read_only,m.reachability AS machine_reachability,
          p.lease_version AS project_lease_version,p.sync_content,p.retention_days,
          e.execution_segment_id,e.native_thread_id,e.history_mode
         FROM logical_sessions s JOIN machines m ON m.machine_id=s.machine_id
         JOIN projects p ON p.project_id=s.project_id
         JOIN execution_segments e ON e.logical_session_id=s.logical_session_id AND e.ended_at IS NULL
         WHERE s.logical_session_id=? ORDER BY e.created_at DESC LIMIT 1`,
        logicalSessionId,
      );
      if (!session || session.active_turn_id !== null || !["idle", "completed", "interrupted", "failed"].includes(session.execution_state) || session.managed !== 1 || session.reachability !== "live" ||
          session.identity_state !== "active" || session.security_state !== "normal" || session.compatibility !== "compatible" ||
          session.machine_reachability !== "online" || session.runtime_read_only === 1) return null;
      if (this.db.get("SELECT 1 FROM project_turn_reservations WHERE project_id=?", session.project_id)) return null;
      if (this.db.get("SELECT 1 FROM turn_queue WHERE logical_session_id=? AND state='unknown'", logicalSessionId)) return null;

      const timestamp = nowIso();
      for (;;) {
        const head = this.db.get<{
          queue_item_id: string;
          command_id: string;
          expires_at: string;
          precondition_json: string;
        }>(
          `SELECT q.queue_item_id,q.command_id,q.expires_at,c.precondition_json
           FROM turn_queue q JOIN commands c ON c.command_id=q.command_id
           WHERE q.logical_session_id=? AND q.state='queued' ORDER BY q.position LIMIT 1`,
          logicalSessionId,
        );
        if (!head) return null;
        if (head.expires_at <= timestamp) {
          this.db.run("UPDATE turn_queue SET state='expired',updated_at=? WHERE queue_item_id=?", timestamp, head.queue_item_id);
          this.db.run("UPDATE command_projection SET state='expired',updated_at=? WHERE command_id=?", timestamp, head.command_id);
          this.db.run("INSERT INTO command_lifecycle(command_id,state,detail_json,created_at) VALUES(?,'expired',?,?)", head.command_id, canonicalJson({ reason: "queue_expired" }), timestamp);
          this.db.run("UPDATE logical_sessions SET queue_version=queue_version+1,updated_at=? WHERE logical_session_id=?", timestamp, logicalSessionId);
          continue;
        }
        const precondition = ensureRecord(parseJson(head.precondition_json), "queued precondition is invalid");
        const valid = precondition.executionSegmentId === session.execution_segment_id &&
          precondition.threadControlVersion === session.thread_control_version &&
          precondition.projectLeaseVersion === session.project_lease_version;
        if (!valid) {
          this.db.run("UPDATE turn_queue SET state='invalidated',updated_at=? WHERE queue_item_id=?", timestamp, head.queue_item_id);
          this.db.run("UPDATE command_projection SET state='invalidated',updated_at=? WHERE command_id=?", timestamp, head.command_id);
          this.db.run("INSERT INTO command_lifecycle(command_id,state,detail_json,created_at) VALUES(?,'invalidated',?,?)", head.command_id, canonicalJson({ reason: "queue_precondition_changed" }), timestamp);
          this.db.run("UPDATE logical_sessions SET queue_version=queue_version+1,updated_at=? WHERE logical_session_id=?", timestamp, logicalSessionId);
          continue;
        }
        const promoted = this.db.run("UPDATE turn_queue SET state='dispatching',updated_at=? WHERE queue_item_id=? AND state='queued'", timestamp, head.queue_item_id);
        if (Number(promoted.changes) !== 1) continue;
        this.db.run("UPDATE command_projection SET state='accepted',updated_at=? WHERE command_id=?", timestamp, head.command_id);
        this.db.run("INSERT INTO command_lifecycle(command_id,state,detail_json,created_at) VALUES(?,'accepted',?,?)", head.command_id, canonicalJson({ reason: "queue_head_promoted", queueItemId: head.queue_item_id }), timestamp);
        this.db.run(
          `INSERT INTO project_turn_reservations(project_id,logical_session_id,command_id,state,version,reserved_at,updated_at)
           VALUES(?,?,?,'accepted',1,?,?)`,
          session.project_id,
          logicalSessionId,
          head.command_id,
          timestamp,
          timestamp,
        );
        this.db.run("UPDATE logical_sessions SET queue_version=queue_version+1,updated_at=? WHERE logical_session_id=?", timestamp, logicalSessionId);
        return { commandId: head.command_id };
      }
    });
  }

  createDispatchAttempt(commandId: string, target: DispatchTarget): Record<string, unknown> | null {
    return this.db.transaction(() => {
      const command = this.db.get<{
        machine_id: string;
        state: string;
        expires_at: string;
        identity_state: string;
        security_state: string;
        reachability: string;
        command_content_epoch: number;
        session_content_epoch: number;
      }>(
        `SELECT s.machine_id,p.state,c.expires_at,m.identity_state,m.security_state,m.reachability,
          c.content_epoch AS command_content_epoch,s.content_epoch AS session_content_epoch
         FROM commands c JOIN command_projection p ON p.command_id=c.command_id
         JOIN logical_sessions s ON s.logical_session_id=c.logical_session_id
         JOIN machines m ON m.machine_id=s.machine_id WHERE c.command_id=?`,
        commandId,
      );
      invariant(command, 404, "COMMAND_NOT_FOUND", "Command was not found");
      if (!["accepted", "dispatching"].includes(command.state)) return null;
      const attempts = this.db.all<{ attempt_no: number; state: string }>(
        `SELECT a.attempt_no,p.state FROM dispatch_attempts a
         JOIN dispatch_attempt_projection p ON p.dispatch_attempt_id=a.dispatch_attempt_id
         WHERE a.command_id=? ORDER BY a.attempt_no DESC`,
        commandId,
      );
      const neverClaimed = attempts.every(attempt => attempt.state === "delivery_failed_before_claim");
      if (command.command_content_epoch !== command.session_content_epoch) {
        this.setCommandState(commandId, neverClaimed ? "invalidated" : "unknown", {
          reason: neverClaimed ? "content_epoch_changed_before_dispatch" : "content_epoch_changed_after_offer",
          commandContentEpoch: command.command_content_epoch,
          sessionContentEpoch: command.session_content_epoch,
        });
        return null;
      }
      if (command.expires_at <= nowIso()) {
        this.setCommandState(commandId, neverClaimed ? "expired" : "unknown", {
          reason: neverClaimed ? "not_dispatched_before_expiry" : "expired_after_offer",
        });
        return null;
      }
      invariant(command.machine_id === target.machineId, 409, "DISPATCH_TARGET_MISMATCH", "Command targets another Machine");
      invariant(command.identity_state === "active" && command.security_state === "normal", 409, "MACHINE_READ_ONLY", "Machine cannot accept commands");
      invariant(command.reachability === "online", 409, "MACHINE_OFFLINE", "Machine is offline");
      const latest = attempts[0];
      if (latest && latest.state !== "delivery_failed_before_claim") return null;
      // A queued command can outlive an Agent upgrade/rollback. Never offer
      // image content to a runtime that would silently ignore the new field.
      const imageTarget = this.db.get<{ body_json: string; codex_catalog_json: string | null }>(
        `SELECT cc.body_json,m.codex_catalog_json FROM command_contents cc
         JOIN commands c ON c.command_id=cc.command_id
         JOIN logical_sessions s ON s.logical_session_id=c.logical_session_id
         JOIN machines m ON m.machine_id=s.machine_id WHERE c.command_id=?`, commandId,
      );
      const imagePayload = imageTarget ? JSON.parse(imageTarget.body_json) as { images?: unknown[] } | null : null;
      if (imagePayload?.images?.length && parseCodexCatalog(imageTarget?.codex_catalog_json ? JSON.parse(imageTarget.codex_catalog_json) : null)?.imageInput !== true) {
        this.setCommandState(commandId, "invalidated", { code: "AGENT_IMAGE_UNSUPPORTED", message: "主机图片能力已变化，请更新连接服务后重新发送" });
        return null;
      }
      const attemptNo = (latest?.attempt_no ?? 0) + 1;
      const dispatchAttemptId = newId("attempt");
      const timestamp = nowIso();
      this.db.run(
        `INSERT INTO dispatch_attempts(
          dispatch_attempt_id,command_id,attempt_no,machine_id,transport_generation,
          producer_epoch,app_server_epoch,created_at
        ) VALUES(?,?,?,?,?,?,?,?)`,
        dispatchAttemptId,
        commandId,
        attemptNo,
        target.machineId,
        target.transportGeneration,
        target.producerEpoch,
        target.appServerEpoch,
        timestamp,
      );
      this.db.run(
        "INSERT INTO dispatch_attempt_projection(dispatch_attempt_id,state,updated_at) VALUES(?,'created',?)",
        dispatchAttemptId,
        timestamp,
      );
      this.db.run(
        "INSERT INTO dispatch_attempt_lifecycle(dispatch_attempt_id,state,created_at) VALUES(?,'created',?)",
        dispatchAttemptId,
        timestamp,
      );
      this.setCommandState(commandId, "dispatching", { dispatchAttemptId, attemptNo });
      return {
        dispatchAttemptId,
        commandId,
        attemptNo,
        machineId: target.machineId,
        transportGeneration: target.transportGeneration,
        producerEpoch: target.producerEpoch,
        appServerEpoch: target.appServerEpoch,
        createdAt: timestamp,
      };
    });
  }

  transitionAttempt(
    connection: AgentConnectionIdentity,
    dispatchAttemptId: string,
    nextState: string,
    detail?: Record<string, unknown>,
  ): Record<string, unknown> {
    return this.db.transaction(() => {
      const attempt = this.db.get<{
        command_id: string;
        machine_id: string;
        transport_generation: number;
        state: string;
        disconnected_at: string | null;
        identity_state: string;
        newer_generation: number;
      }>(
        `SELECT a.command_id,a.machine_id,a.transport_generation,p.state,c.disconnected_at,
          m.identity_state,EXISTS(
            SELECT 1 FROM agent_connections newer
            WHERE newer.machine_id=a.machine_id AND newer.transport_generation>a.transport_generation
          ) AS newer_generation
         FROM dispatch_attempts a
         JOIN dispatch_attempt_projection p ON p.dispatch_attempt_id=a.dispatch_attempt_id
         JOIN agent_connections c ON c.connection_id=? AND c.machine_id=a.machine_id
           AND c.transport_generation=a.transport_generation
         JOIN machines m ON m.machine_id=a.machine_id
         WHERE a.dispatch_attempt_id=?`,
        connection.connectionId,
        dispatchAttemptId,
      );
      invariant(attempt, 404, "DISPATCH_ATTEMPT_NOT_FOUND", "Dispatch Attempt was not found");
      invariant(attempt.machine_id === connection.machineId && attempt.transport_generation === connection.transportGeneration, 403, "DISPATCH_ATTEMPT_FENCED", "Attempt belongs to another connection generation");
      invariant(attempt.identity_state === "active", 409, "MACHINE_REVOKED", "Machine identity was revoked");
      invariant(!attempt.disconnected_at && attempt.newer_generation === 0, 409, "CONNECTION_FENCED", "Agent connection is no longer current");
      // Released Agents reject during a hello refresh before bindCommand/handleCommand.
      // Only this authenticated, pre-claim queue rejection permits another offer.
      const deferredUntilReconciliation = nextState === "invalidated" &&
        detail?.code === "RECONCILIATION_INCOMPLETE" &&
        ["created", "offered", "delivery_failed_before_claim"].includes(attempt.state) &&
        Boolean(this.db.get("SELECT 1 FROM commands WHERE command_id=? AND type='turn.queue'", attempt.command_id));
      if (deferredUntilReconciliation) nextState = "delivery_failed_before_claim";
      if (attempt.state === nextState) return { dispatchAttemptId, state: nextState, duplicate: true, deferredUntilReconciliation };
      if (
        SUCCESS_ATTEMPT_RANK[attempt.state] !== undefined &&
        SUCCESS_ATTEMPT_RANK[nextState] !== undefined &&
        SUCCESS_ATTEMPT_RANK[attempt.state]! > SUCCESS_ATTEMPT_RANK[nextState]!
      ) {
        return { dispatchAttemptId, state: attempt.state, duplicate: true, superseded: true };
      }
      invariant(ATTEMPT_TRANSITIONS[attempt.state]?.has(nextState), 409, "INVALID_ATTEMPT_TRANSITION", `Cannot transition attempt from ${attempt.state} to ${nextState}`);
      const timestamp = nowIso();
      this.db.run(
        "UPDATE dispatch_attempt_projection SET state=?,updated_at=? WHERE dispatch_attempt_id=? AND state=?",
        nextState,
        timestamp,
        dispatchAttemptId,
        attempt.state,
      );
      this.db.run(
        "INSERT INTO dispatch_attempt_lifecycle(dispatch_attempt_id,state,detail_json,created_at) VALUES(?,?,?,?)",
        dispatchAttemptId,
        nextState,
        detail ? canonicalJson(detail) : null,
        timestamp,
      );
      if (nextState === "applied") this.setCommandState(attempt.command_id, "applied", detail);
      else if (nextState === "unknown") this.setCommandState(attempt.command_id, "unknown", detail);
      else if (["expired", "invalidated"].includes(nextState)) this.setCommandState(attempt.command_id, nextState, detail);
      else if (nextState === "delivery_failed_before_claim") this.setCommandState(attempt.command_id, "accepted", detail);
      return { dispatchAttemptId, state: nextState, duplicate: false, deferredUntilReconciliation };
    });
  }

  handleConnectionLost(connection: AgentConnectionIdentity): { retryable: number; unknown: number } {
    return this.db.transaction(() => {
      const attempts = this.db.all<{
        dispatch_attempt_id: string;
        command_id: string;
        state: string;
        logical_session_id: string;
      }>(
        `SELECT a.dispatch_attempt_id,a.command_id,p.state,c.logical_session_id
         FROM dispatch_attempts a JOIN dispatch_attempt_projection p
           ON p.dispatch_attempt_id=a.dispatch_attempt_id
         JOIN commands c ON c.command_id=a.command_id
         WHERE a.machine_id=? AND a.transport_generation=?
           AND p.state IN ('created','offered','claimed','invoking','responded')`,
        connection.machineId,
        connection.transportGeneration,
      );
      const timestamp = nowIso();
      let retryable = 0;
      let unknown = 0;
      for (const attempt of attempts) {
        const beforeClaim = attempt.state === "created" || attempt.state === "offered";
        const nextAttemptState = beforeClaim ? "delivery_failed_before_claim" : "unknown";
        const updated = this.db.run(
          `UPDATE dispatch_attempt_projection SET state=?,updated_at=?
           WHERE dispatch_attempt_id=? AND state=?`,
          nextAttemptState,
          timestamp,
          attempt.dispatch_attempt_id,
          attempt.state,
        );
        if (Number(updated.changes) !== 1) continue;
        this.db.run(
          `INSERT INTO dispatch_attempt_lifecycle(dispatch_attempt_id,state,detail_json,created_at)
           VALUES(?,?,?,?)`,
          attempt.dispatch_attempt_id,
          nextAttemptState,
          canonicalJson({ reason: "agent_connection_lost", transportGeneration: connection.transportGeneration }),
          timestamp,
        );
        if (beforeClaim) {
          this.setCommandState(attempt.command_id, "accepted", { reason: "agent_connection_lost_before_claim" });
          retryable += 1;
        } else {
          this.setCommandState(attempt.command_id, "unknown", { reason: "agent_connection_lost_after_claim" });
          unknown += 1;
        }
        this.db.audit({
          workspaceId: connection.workspaceId,
          machineId: connection.machineId,
          logicalSessionId: attempt.logical_session_id,
          action: "dispatch.connection_lost",
          outcome: beforeClaim ? "retryable" : "unknown",
          metadata: {
            dispatchAttemptId: attempt.dispatch_attempt_id,
            commandId: attempt.command_id,
            previousState: attempt.state,
            transportGeneration: connection.transportGeneration,
          },
        });
      }
      return { retryable, unknown };
    });
  }

  /**
   * A Control Plane restart loses the in-memory WebSocket ownership that would
   * normally drive handleConnectionLost. Reconcile every persisted non-terminal
   * attempt before accepting traffic: pre-claim attempts may be offered again
   * using the same immutable commandId (the Agent journal deduplicates it), while
   * claimed or later attempts have an ambiguous side-effect boundary and freeze.
   */
  reconcilePersistedAttempts(reason = "control_plane_restarted"): { retryable: number; unknown: number } {
    return this.db.transaction(() => {
      const attempts = this.db.all<{
        dispatch_attempt_id: string;
        command_id: string;
        state: string;
        workspace_id: string;
        machine_id: string;
        logical_session_id: string;
        expires_at: string;
      }>(
        `SELECT a.dispatch_attempt_id,a.command_id,ap.state,c.workspace_id,a.machine_id,
          c.logical_session_id,c.expires_at
         FROM dispatch_attempts a
         JOIN dispatch_attempt_projection ap ON ap.dispatch_attempt_id=a.dispatch_attempt_id
         JOIN commands c ON c.command_id=a.command_id
         JOIN command_projection cp ON cp.command_id=c.command_id
         WHERE cp.state='dispatching'
           AND ap.state IN ('created','offered','claimed','invoking','responded')`,
      );
      const timestamp = nowIso();
      let retryable = 0;
      let unknown = 0;
      for (const attempt of attempts) {
        const beforeClaim = attempt.state === "created" || attempt.state === "offered";
        const mayRetry = beforeClaim && attempt.expires_at > timestamp;
        const nextAttemptState = mayRetry ? "delivery_failed_before_claim" : "unknown";
        const updated = this.db.run(
          `UPDATE dispatch_attempt_projection SET state=?,updated_at=?
           WHERE dispatch_attempt_id=? AND state=?`,
          nextAttemptState,
          timestamp,
          attempt.dispatch_attempt_id,
          attempt.state,
        );
        if (Number(updated.changes) !== 1) continue;
        this.db.run(
          `INSERT INTO dispatch_attempt_lifecycle(dispatch_attempt_id,state,detail_json,created_at)
           VALUES(?,?,?,?)`,
          attempt.dispatch_attempt_id,
          nextAttemptState,
          canonicalJson({ reason, previousState: attempt.state }),
          timestamp,
        );
        this.setCommandState(attempt.command_id, mayRetry ? "accepted" : "unknown", {
          reason,
          previousAttemptState: attempt.state,
          ...(beforeClaim && !mayRetry ? { commandExpired: true } : {}),
        });
        this.db.audit({
          workspaceId: attempt.workspace_id,
          machineId: attempt.machine_id,
          logicalSessionId: attempt.logical_session_id,
          action: "dispatch.restart_reconcile",
          outcome: mayRetry ? "retryable" : "unknown",
          metadata: {
            dispatchAttemptId: attempt.dispatch_attempt_id,
            commandId: attempt.command_id,
            previousState: attempt.state,
            reason,
          },
        });
        if (mayRetry) retryable += 1;
        else unknown += 1;
      }
      return { retryable, unknown };
    });
  }

  markOffered(dispatchAttemptId: string): void {
    const row = this.db.get<{ command_id: string; state: string }>(
      `SELECT a.command_id,p.state FROM dispatch_attempts a JOIN dispatch_attempt_projection p
       ON p.dispatch_attempt_id=a.dispatch_attempt_id WHERE a.dispatch_attempt_id=?`,
      dispatchAttemptId,
    );
    if (!row || row.state !== "created") return;
    const timestamp = nowIso();
    this.db.transaction(() => {
      this.db.run(
        "UPDATE dispatch_attempt_projection SET state='offered',updated_at=? WHERE dispatch_attempt_id=? AND state='created'",
        timestamp,
        dispatchAttemptId,
      );
      this.db.run(
        "INSERT INTO dispatch_attempt_lifecycle(dispatch_attempt_id,state,created_at) VALUES(?,'offered',?)",
        dispatchAttemptId,
        timestamp,
      );
    });
  }

  markDeliveryFailed(dispatchAttemptId: string, message: string): void {
    const row = this.db.get<{ command_id: string; state: string }>(
      `SELECT a.command_id,p.state FROM dispatch_attempts a JOIN dispatch_attempt_projection p
       ON p.dispatch_attempt_id=a.dispatch_attempt_id WHERE a.dispatch_attempt_id=?`,
      dispatchAttemptId,
    );
    if (!row || !["created", "offered"].includes(row.state)) return;
    const timestamp = nowIso();
    this.db.transaction(() => {
      this.db.run(
        "UPDATE dispatch_attempt_projection SET state='delivery_failed_before_claim',updated_at=? WHERE dispatch_attempt_id=?",
        timestamp,
        dispatchAttemptId,
      );
      this.db.run(
        `INSERT INTO dispatch_attempt_lifecycle(dispatch_attempt_id,state,detail_json,created_at)
         VALUES(?,'delivery_failed_before_claim',?,?)`,
        dispatchAttemptId,
        canonicalJson({ message: message.slice(0, 500) }),
        timestamp,
      );
      this.setCommandState(row.command_id, "accepted", { deliveryFailure: true });
    });
  }

  private validNativeDeletionEvidence(commandId: string, response: Record<string, unknown>): boolean {
    const ids = response.deletedNativeThreadIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !id || id.length > 256)) return false;
    const command = this.db.get<{logical_session_id:string;precondition_json:string;payload_json:string}>(
      `SELECT c.logical_session_id,c.precondition_json,COALESCE(cc.body_json,c.payload_json) AS payload_json FROM commands c LEFT JOIN command_contents cc ON cc.command_id=c.command_id AND cc.deleted_at IS NULL JOIN logical_sessions s ON s.logical_session_id=c.logical_session_id
       WHERE c.command_id=? AND c.type='thread.delete' AND s.deleted_at IS NULL AND c.content_epoch=s.content_epoch`, commandId);
    if (!command?.payload_json || !command.precondition_json) return false;
    const payload = JSON.parse(command.payload_json); const precondition = JSON.parse(command.precondition_json);
    if (!payload || !precondition || typeof payload.previewCommandId !== "string" || typeof payload.fingerprint !== "string") return false;
    const preview = this.db.get<{detail_json:string|null}>(`SELECT l.detail_json FROM command_lifecycle l JOIN commands c ON c.command_id=l.command_id
      WHERE c.command_id=? AND c.logical_session_id=? AND c.type='thread.delete.preview' AND l.state='applied' ORDER BY l.lifecycle_id DESC LIMIT 1`, payload.previewCommandId, command.logical_session_id);
    const detail = preview?.detail_json ? JSON.parse(preview.detail_json) : null;
    const plan = detail?.response?.deletionPreview;
    return detail?.ok !== false && plan && Array.isArray(plan.threads) && plan.threads.length <= 50 && plan.threads.every((t:unknown) => t && typeof t === "object" && typeof (t as {id?:unknown}).id === "string") &&
      plan.fingerprint === payload.fingerprint && plan.nativeThreadId === precondition.nativeThreadId && response.nativeThreadId === precondition.nativeThreadId &&
      canonicalJson([...ids].sort()) === canonicalJson(plan.threads.map((t:{id:string})=>t.id).sort());
  }

  private applyNativeDeletion(commandId:string,response:Record<string,unknown>):void {
    if (!this.validNativeDeletionEvidence(commandId,response)) return;
    const ids=response.deletedNativeThreadIds;
    if(!Array.isArray(ids)||ids.length<1||ids.length>50||ids.some(id=>typeof id!=="string"||id.length>256))return;
    const command=this.db.get<{workspace_id:string;actor_user_id:string;actor_client_session_id:string;logical_session_id:string;machine_id:string;codex_profile_id:string;project_id:string;precondition_json:string;payload_json:string}>(
      `SELECT c.*,COALESCE(cc.body_json,c.payload_json) AS payload_json,s.machine_id,s.codex_profile_id,s.project_id FROM commands c LEFT JOIN command_contents cc ON cc.command_id=c.command_id AND cc.deleted_at IS NULL JOIN logical_sessions s ON s.logical_session_id=c.logical_session_id
       WHERE c.command_id=? AND c.type='thread.delete' AND s.deleted_at IS NULL`,commandId);
    if(!command)return;
    const precondition=JSON.parse(command.precondition_json);const payload=JSON.parse(command.payload_json);
    const preview=this.db.get<{detail_json:string|null}>("SELECT detail_json FROM command_lifecycle WHERE command_id=? AND state='applied' ORDER BY lifecycle_id DESC LIMIT 1",payload.previewCommandId);
    const detail=preview?.detail_json?JSON.parse(preview.detail_json):{};
    const plan=detail.response?.deletionPreview;
    if(!plan || plan.fingerprint!==payload.fingerprint || plan.nativeThreadId!==precondition.nativeThreadId || response.nativeThreadId!==precondition.nativeThreadId || canonicalJson([...ids].sort())!==canonicalJson(plan.threads.map((t:{id:string})=>t.id).sort()))return;
    const principal:Principal={workspaceId:command.workspace_id,userId:command.actor_user_id,clientSessionId:command.actor_client_session_id,email:"recovery@internal.invalid",csrfHash:"",expiresAt:""};
    const timestamp=nowIso();
    for(const id of ids) {
      this.db.run("INSERT OR IGNORE INTO native_session_deletions(machine_id,codex_profile_id,native_thread_id,command_id,deleted_at) VALUES(?,?,?,?,?)",command.machine_id,command.codex_profile_id,id,commandId,timestamp);
      const sessions=this.db.all<{logical_session_id:string}>(`SELECT DISTINCT s.logical_session_id FROM logical_sessions s JOIN execution_segments e ON e.logical_session_id=s.logical_session_id
        WHERE s.machine_id=? AND s.codex_profile_id=? AND e.native_thread_id=? AND s.deleted_at IS NULL`,command.machine_id,command.codex_profile_id,id);
      for(const session of sessions) {
        this.deleteSessionContent(principal,session.logical_session_id,true);
        this.db.run("UPDATE logical_sessions SET deleted_at=?,managed=0,active_turn_id=NULL,execution_state='idle',thread_control_version=thread_control_version+1,updated_at=? WHERE logical_session_id=?",timestamp,timestamp,session.logical_session_id);
        this.db.run("DELETE FROM project_turn_reservations WHERE logical_session_id=?",session.logical_session_id);
        this.db.audit({workspaceId:command.workspace_id,machineId:command.machine_id,logicalSessionId:session.logical_session_id,action:"native_session.deleted",metadata:{commandId,nativeThreadId:id}});
      }
    }
  }

  private reconcileNativeDeletionResult(event:DurableAgentEvent,connection:AgentConnectionIdentity):void {
    const payload=event.payload;
    if(!payload || typeof payload!=="object" || Array.isArray(payload))return;
    const result=payload as Record<string,unknown>;
    if(result.commandType!=="thread.delete" || result.state!=="applied" || typeof result.commandId!=="string" || typeof result.attemptId!=="string" || !result.detail || typeof result.detail!=="object")return;
    const command=this.db.get<{state:string}>(`SELECT p.state FROM commands c JOIN command_projection p ON p.command_id=c.command_id
      JOIN dispatch_attempts a ON a.command_id=c.command_id JOIN logical_sessions s ON s.logical_session_id=c.logical_session_id
      WHERE c.command_id=? AND c.type='thread.delete' AND c.logical_session_id=? AND c.execution_segment_id=? AND c.content_epoch=?
        AND a.dispatch_attempt_id=? AND a.machine_id=? AND a.producer_epoch=? AND a.app_server_epoch=? AND s.content_epoch=c.content_epoch AND s.deleted_at IS NULL`,
      result.commandId,event.logicalSessionId,event.executionSegmentId,event.contentEpoch??1,result.attemptId,connection.machineId,event.producerEpoch,event.appServerEpoch??"");
    if(!command||!["dispatching","unknown","applied"].includes(command.state))return;
    if (!this.validNativeDeletionEvidence(result.commandId,result.detail as Record<string,unknown>)) return;
    this.setCommandState(result.commandId,"applied",{source:"durable_delete_result",response:result.detail});
    this.db.run("UPDATE dispatch_attempt_projection SET state='applied',updated_at=? WHERE dispatch_attempt_id=?",nowIso(),result.attemptId);
  }

  private syncQueueState(commandId: string, state: string, timestamp: string): boolean {
    if (!["applied", "expired", "invalidated", "unknown"].includes(state)) return false;
    const updated = this.db.get<{ logical_session_id: string }>(
      `UPDATE turn_queue SET state=?,updated_at=? WHERE command_id=?
       AND state IN ('queued','dispatching','unknown') AND state<>? RETURNING logical_session_id`,
      state, timestamp, commandId, state,
    );
    if (!updated) return false;
    this.db.run("UPDATE logical_sessions SET queue_version=queue_version+1,updated_at=? WHERE logical_session_id=?", timestamp, updated.logical_session_id);
    return true;
  }

  /** Repair projections from existing command evidence only; never re-offer old commands. */
  reconcileQueueStates(): number {
    return this.db.transaction(() => {
      const rows = this.db.all<{ command_id: string; state: string; updated_at: string }>(
        `SELECT q.command_id,p.state,p.updated_at FROM turn_queue q
         JOIN command_projection p ON p.command_id=q.command_id
         WHERE q.state IN ('queued','dispatching','unknown') AND q.state<>p.state
           AND p.state IN ('applied','expired','invalidated','unknown')`,
      );
      return rows.filter(row => this.syncQueueState(row.command_id, row.state, nowIso())).length;
    });
  }

  private setCommandState(commandId: string, state: string, detail?: Record<string, unknown>): void {
    if (state === "applied" && detail?.ok !== false && this.db.get("SELECT 1 FROM commands WHERE command_id=? AND type='thread.delete'",commandId)) {
      invariant(Boolean(detail?.response && typeof detail.response === "object" && this.validNativeDeletionEvidence(commandId,detail.response as Record<string,unknown>)),409,"DELETE_RECEIPT_INVALID","Native deletion receipt does not match the confirmed preview");
    }
    const timestamp = nowIso();
    this.db.run("UPDATE command_projection SET state=?,updated_at=? WHERE command_id=?", state, timestamp, commandId);
    this.syncQueueState(commandId, state, timestamp);
    this.db.run(
      "INSERT INTO command_lifecycle(command_id,state,detail_json,created_at) VALUES(?,?,?,?)",
      commandId,
      state,
      detail ? canonicalJson(detail) : null,
      timestamp,
    );
    if (state === "applied" && detail?.ok !== false && detail?.response && typeof detail.response === "object") {
      this.applyNativeDeletion(commandId,detail.response as Record<string,unknown>);
    }
    if (state === "dispatching") {
      this.db.run(
        `UPDATE project_turn_reservations SET state='dispatching',version=version+1,updated_at=?
         WHERE command_id=? AND state='accepted'`,
        timestamp,
        commandId,
      );
    } else if (state === "accepted") {
      this.db.run(
        `UPDATE project_turn_reservations SET state='accepted',version=version+1,updated_at=?
         WHERE command_id=? AND state='dispatching'`,
        timestamp,
        commandId,
      );
    } else if (state === "unknown") {
      this.db.run(
        `UPDATE project_turn_reservations SET state='unknown',version=version+1,updated_at=?
         WHERE command_id=? AND state<>'unknown'`,
        timestamp,
        commandId,
      );
    } else if (
      state === "expired" ||
      state === "invalidated" ||
      (state === "applied" && detail?.ok === false)
    ) {
      this.releaseProjectTurnReservationForCommand(commandId, state, timestamp);
    }
  }

  /** Expire only commands with no attempt or exclusively proven pre-claim failures.
   * Missing ACKs after an offer remain ambiguous and keep the Project reserved. */
  expireUndispatchedCommands(timestamp = nowIso()): number {
    return this.db.transaction(() => {
      const rows = this.db.all<{ command_id: string }>(
        `SELECT c.command_id FROM commands c
         JOIN command_projection cp ON cp.command_id=c.command_id
         WHERE c.type IN ('turn.start','turn.queue','turn.compact','turn.review','thread.rename','thread.archive','thread.unarchive','thread.fork','thread.delete.preview','thread.delete','thread.terminals.stop','codex.inspect','input.respond') AND cp.state='accepted' AND c.expires_at<=?
           AND NOT EXISTS (
             SELECT 1 FROM dispatch_attempts a JOIN dispatch_attempt_projection p ON p.dispatch_attempt_id=a.dispatch_attempt_id
             WHERE a.command_id=c.command_id AND p.state<>'delivery_failed_before_claim'
           )`,
        timestamp,
      );
      for (const row of rows) {
        this.setCommandState(row.command_id, "expired", { reason: "undispatched_command_expired" });
      }
      return rows.length;
    });
  }

  private releaseProjectTurnReservationForCommand(
    commandId: string,
    reason: string,
    timestamp: string,
  ): boolean {
    const reservation = this.db.get<
      ProjectTurnReservationRow & { workspace_id: string }
    >(
      `SELECT r.*,p.workspace_id FROM project_turn_reservations r
       JOIN projects p ON p.project_id=r.project_id WHERE r.command_id=?`,
      commandId,
    );
    if (!reservation) return false;
    const released = this.db.run(
      `DELETE FROM project_turn_reservations
       WHERE project_id=? AND command_id=? AND version=?`,
      reservation.project_id,
      commandId,
      reservation.version,
    );
    if (Number(released.changes) !== 1) return false;
    this.db.audit({
      workspaceId: reservation.workspace_id,
      projectId: reservation.project_id,
      logicalSessionId: reservation.logical_session_id,
      action: "project_turn.release",
      metadata: { commandId, reason, reservationVersion: reservation.version },
    });
    return true;
  }

  private activateProjectTurnReservation(
    connection: AgentConnectionIdentity,
    event: DurableAgentEvent,
    timestamp: string,
  ): boolean {
    if (!event.nativeTurnId || !event.appServerEpoch) return false;
    const payload = event.payload;
    const commandId = payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).commandId
      : undefined;
    if (typeof commandId !== "string") return false;
    const session = this.db.get<{ project_id: string; active_turn_id: string | null }>(
      "SELECT project_id,active_turn_id FROM logical_sessions WHERE logical_session_id=?",
      event.logicalSessionId,
    );
    if (
      !session ||
      session.project_id !== event.projectId ||
      (session.active_turn_id !== null && session.active_turn_id !== event.nativeTurnId)
    ) return false;
    const competingSession = this.db.get<{ logical_session_id: string }>(
      `SELECT logical_session_id FROM logical_sessions
       WHERE project_id=? AND active_turn_id IS NOT NULL
         AND (logical_session_id<>? OR active_turn_id<>?) LIMIT 1`,
      event.projectId,
      event.logicalSessionId,
      event.nativeTurnId,
    );
    if (competingSession) return false;
    const reservation = this.db.get<{ version: number }>(
      `SELECT r.version FROM project_turn_reservations r
       JOIN commands c ON c.command_id=r.command_id
       JOIN command_projection cp ON cp.command_id=c.command_id
       WHERE r.project_id=? AND r.logical_session_id=? AND r.command_id=?
         AND r.native_turn_id IS NULL AND r.state IN ('accepted','dispatching','unknown')
         AND c.type IN ('turn.start','turn.queue','turn.compact','turn.review') AND c.logical_session_id=? AND c.execution_segment_id=?
         AND cp.state IN ('accepted','dispatching','unknown','applied')
         AND EXISTS (
           SELECT 1 FROM dispatch_attempts a
           JOIN dispatch_attempt_projection ap ON ap.dispatch_attempt_id=a.dispatch_attempt_id
           WHERE a.command_id=r.command_id AND a.machine_id=?
             AND a.producer_epoch=? AND a.app_server_epoch=?
             AND ap.state IN ('created','offered','claimed','invoking','responded','applied','unknown')
         )`,
      event.projectId,
      event.logicalSessionId,
      commandId,
      event.logicalSessionId,
      event.executionSegmentId,
      connection.machineId,
      event.producerEpoch,
      event.appServerEpoch,
    );
    if (!reservation) return false;
    const activated = this.db.run(
      `UPDATE project_turn_reservations
       SET state='active',native_turn_id=?,bound_producer_epoch=?,bound_app_server_epoch=?,binding_state='bound',
         version=version+1,updated_at=?
       WHERE project_id=? AND logical_session_id=? AND command_id=?
         AND native_turn_id IS NULL AND state IN ('accepted','dispatching','unknown')
         AND version=?`,
      event.nativeTurnId,
      event.producerEpoch,
      event.appServerEpoch,
      timestamp,
      event.projectId,
      event.logicalSessionId,
      commandId,
      reservation.version,
    );
    return Number(activated.changes) === 1;
  }

  private releaseProjectTurnReservationForTerminalEvent(
    event: DurableAgentEvent,
    timestamp: string,
  ): boolean {
    if (!event.nativeTurnId) return false;
    const session = this.db.get<{ project_id: string; active_turn_id: string | null }>(
      "SELECT project_id,active_turn_id FROM logical_sessions WHERE logical_session_id=?",
      event.logicalSessionId,
    );
    if (
      !session ||
      session.project_id !== event.projectId ||
      (session.active_turn_id !== null && session.active_turn_id !== event.nativeTurnId)
    ) return false;
    const reservation = this.db.get<
      ProjectTurnReservationRow & { workspace_id: string }
    >(
      `SELECT r.*,p.workspace_id FROM project_turn_reservations r
       JOIN projects p ON p.project_id=r.project_id
       WHERE r.project_id=?`,
      event.projectId,
    );
    if (!reservation) return false;
    if (reservation.state === "migration_conflict") {
      const resolved = this.db.run(
        `UPDATE project_turn_migration_members SET resolved_at=?
         WHERE project_id=? AND logical_session_id=? AND native_turn_id=? AND resolved_at IS NULL`,
        timestamp,
        event.projectId,
        event.logicalSessionId,
        event.nativeTurnId,
      );
      if (Number(resolved.changes) !== 1) return false;
      const remaining = this.db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM project_turn_migration_members
         WHERE project_id=? AND resolved_at IS NULL`,
        event.projectId,
      )?.count ?? reservation.conflict_count;
      if (remaining === 0) {
        const released = this.db.run(
          `DELETE FROM project_turn_reservations
           WHERE project_id=? AND state='migration_conflict' AND version=?`,
          reservation.project_id,
          reservation.version,
        );
        if (Number(released.changes) !== 1) return false;
      } else {
        const advanced = this.db.run(
          `UPDATE project_turn_reservations
           SET conflict_count=?,version=version+1,updated_at=?
           WHERE project_id=? AND state='migration_conflict' AND version=?`,
          remaining,
          timestamp,
          reservation.project_id,
          reservation.version,
        );
        if (Number(advanced.changes) !== 1) return false;
      }
      this.db.audit({
        workspaceId: reservation.workspace_id,
        projectId: reservation.project_id,
        logicalSessionId: event.logicalSessionId,
        action: remaining === 0 ? "project_turn.release" : "project_turn.migration_member_resolved",
        metadata: {
          nativeTurnId: event.nativeTurnId,
          reason: event.type,
          remainingConflictCount: remaining,
          reservationVersion: reservation.version,
        },
      });
      return true;
    }
    const competingSession = this.db.get<{ logical_session_id: string }>(
      `SELECT logical_session_id FROM logical_sessions
       WHERE project_id=? AND active_turn_id IS NOT NULL
         AND (logical_session_id<>? OR active_turn_id<>?) LIMIT 1`,
      event.projectId,
      event.logicalSessionId,
      event.nativeTurnId,
    );
    if (competingSession) return false;
    if (
      reservation.logical_session_id !== event.logicalSessionId ||
      reservation.native_turn_id !== event.nativeTurnId
    ) return false;
    const exactBoundEvidence =
      reservation.binding_state === "bound" &&
      reservation.bound_producer_epoch === event.producerEpoch &&
      reservation.bound_app_server_epoch !== null &&
      reservation.bound_app_server_epoch === event.appServerEpoch;
    const legacyEvidence = reservation.binding_state === "legacy_unbound";
    if (!exactBoundEvidence && !legacyEvidence) return false;
    const released = exactBoundEvidence
      ? this.db.run(
          `DELETE FROM project_turn_reservations
           WHERE project_id=? AND logical_session_id=? AND native_turn_id=?
             AND binding_state='bound' AND bound_producer_epoch=? AND bound_app_server_epoch=? AND version=?`,
          reservation.project_id,
          reservation.logical_session_id,
          event.nativeTurnId,
          reservation.bound_producer_epoch!,
          reservation.bound_app_server_epoch!,
          reservation.version,
        )
      : this.db.run(
          `DELETE FROM project_turn_reservations
           WHERE project_id=? AND logical_session_id=? AND native_turn_id=?
             AND binding_state='legacy_unbound' AND version=?`,
          reservation.project_id,
          reservation.logical_session_id,
          event.nativeTurnId,
          reservation.version,
        );
    if (Number(released.changes) !== 1) return false;
    this.db.audit({
      workspaceId: reservation.workspace_id,
      projectId: reservation.project_id,
      logicalSessionId: reservation.logical_session_id,
      action: "project_turn.release",
      metadata: {
        commandId: reservation.command_id,
        nativeTurnId: event.nativeTurnId,
        reason: event.type,
        bindingEvidence: exactBoundEvidence ? "exact_epoch_binding" : "legacy_unbound",
        reservationVersion: reservation.version,
      },
    });
    return true;
  }

  private reconcileAppliedTurnStartResult(
    event: DurableAgentEvent,
    connection: AgentConnectionIdentity,
    currentAppServerEpoch: string,
    timestamp: string,
    allowSessionProjection: boolean,
  ): boolean {
    if (!event.appServerEpoch) return false;
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const result = payload as Record<string, unknown>;
    const detail = result.detail;
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) return false;
    const terminal = detail as Record<string, unknown>;
    const terminalStatus = terminal.status;
    if (
      typeof result.commandId !== "string" ||
      typeof result.attemptId !== "string" ||
      !["turn.start", "turn.queue", "turn.compact", "turn.review"].includes(String(result.commandType)) ||
      result.state !== "applied" ||
      typeof terminal.nativeTurnId !== "string" ||
      terminal.nativeTurnId.length === 0 ||
      terminal.nativeTurnId.length > 300 ||
      typeof terminalStatus !== "string" ||
      !["completed", "failed", "interrupted"].includes(terminalStatus)
    ) return false;
    const incomingContentEpoch = event.contentEpoch ?? 1;
    const evidence = this.db.get<{
      version: number;
      native_turn_id: string | null;
      reservation_state: string;
      workspace_id: string;
      command_content_epoch: number;
      command_state: string;
      attempt_state: string;
      attempt_machine_id: string;
      transport_generation: number;
      attempt_producer_epoch: string;
      attempt_app_server_epoch: string;
    }>(
      `SELECT r.version,r.native_turn_id,r.state AS reservation_state,p.workspace_id,
        c.content_epoch AS command_content_epoch,cp.state AS command_state,
        ap.state AS attempt_state,a.machine_id AS attempt_machine_id,a.transport_generation,
        a.producer_epoch AS attempt_producer_epoch,a.app_server_epoch AS attempt_app_server_epoch
       FROM project_turn_reservations r
       JOIN projects p ON p.project_id=r.project_id
       JOIN commands c ON c.command_id=r.command_id
       JOIN command_projection cp ON cp.command_id=c.command_id
       JOIN dispatch_attempts a ON a.command_id=c.command_id AND a.dispatch_attempt_id=?
       JOIN dispatch_attempt_projection ap ON ap.dispatch_attempt_id=a.dispatch_attempt_id
       WHERE r.project_id=? AND r.logical_session_id=? AND r.command_id=?
         AND c.type IN ('turn.start','turn.queue','turn.compact','turn.review') AND c.logical_session_id=? AND c.execution_segment_id=?`,
      result.attemptId,
      event.projectId,
      event.logicalSessionId,
      result.commandId,
      event.logicalSessionId,
      event.executionSegmentId,
    );
    if (
      !evidence ||
      !["accepted", "dispatching", "active", "unknown"].includes(evidence.reservation_state) ||
      (evidence.native_turn_id !== null && evidence.native_turn_id !== terminal.nativeTurnId) ||
      evidence.command_content_epoch !== incomingContentEpoch ||
      !["accepted", "dispatching", "applied", "unknown"].includes(evidence.command_state) ||
      ![
        "created",
        "offered",
        "claimed",
        "invoking",
        "responded",
        "applied",
        "unknown",
        "delivery_failed_before_claim",
      ].includes(evidence.attempt_state) ||
      evidence.attempt_machine_id !== connection.machineId ||
      evidence.attempt_producer_epoch !== event.producerEpoch ||
      evidence.attempt_app_server_epoch !== event.appServerEpoch
    ) return false;

    const session = this.db.get<{
      project_id: string;
      active_turn_id: string | null;
      turn_control_version: number;
    }>(
      "SELECT project_id,active_turn_id,turn_control_version FROM logical_sessions WHERE logical_session_id=?",
      event.logicalSessionId,
    );
    if (!session || session.project_id !== event.projectId) return false;
    if (session.active_turn_id !== null && session.active_turn_id !== terminal.nativeTurnId) return false;
    const competingSession = this.db.get<{ logical_session_id: string }>(
      `SELECT logical_session_id FROM logical_sessions
       WHERE project_id=? AND active_turn_id IS NOT NULL
         AND (logical_session_id<>? OR active_turn_id<>?) LIMIT 1`,
      event.projectId,
      event.logicalSessionId,
      terminal.nativeTurnId,
    );
    if (competingSession) return false;

    if (evidence.attempt_state !== "applied") {
      const attemptApplied = this.db.run(
        `UPDATE dispatch_attempt_projection SET state='applied',updated_at=?
         WHERE dispatch_attempt_id=? AND state=?`,
        timestamp,
        result.attemptId,
        evidence.attempt_state,
      );
      if (Number(attemptApplied.changes) !== 1) return false;
      this.db.run(
        `INSERT INTO dispatch_attempt_lifecycle(dispatch_attempt_id,state,detail_json,created_at)
         VALUES(?,'applied',?,?)`,
        result.attemptId,
        canonicalJson({ source: "durable_command_result", eventId: event.eventId }),
        timestamp,
      );
    }
    if (evidence.command_state !== "applied") {
      this.setCommandState(result.commandId, "applied", {
        source: "durable_command_result",
        eventId: event.eventId,
        dispatchAttemptId: result.attemptId,
      });
    }

    const bound = this.db.run(
      `UPDATE project_turn_reservations SET native_turn_id=?,state='active',bound_producer_epoch=?,
         bound_app_server_epoch=?,binding_state='bound',version=version+1,updated_at=?
       WHERE project_id=? AND logical_session_id=? AND command_id=? AND version=?
         AND state IN ('accepted','dispatching','active','unknown')
         AND (native_turn_id IS NULL OR native_turn_id=?)`,
      terminal.nativeTurnId,
      event.producerEpoch,
      event.appServerEpoch,
      timestamp,
      event.projectId,
      event.logicalSessionId,
      result.commandId,
      evidence.version,
      terminal.nativeTurnId,
    );
    if (Number(bound.changes) !== 1) return false;
    const released = this.db.run(
      `DELETE FROM project_turn_reservations
       WHERE project_id=? AND logical_session_id=? AND command_id=? AND native_turn_id=?
         AND state='active' AND version=?`,
      event.projectId,
      event.logicalSessionId,
      result.commandId,
      terminal.nativeTurnId,
      evidence.version + 1,
    );
    invariant(Number(released.changes) === 1, 409, "TURN_RESULT_RELEASE_RACE", "Turn result reservation changed during exact release");
    this.db.audit({
      workspaceId: evidence.workspace_id,
      machineId: connection.machineId,
      projectId: event.projectId,
      logicalSessionId: event.logicalSessionId,
      action: "project_turn.release",
      metadata: {
        commandId: result.commandId,
        dispatchAttemptId: result.attemptId,
        nativeTurnId: terminal.nativeTurnId,
        reason: "command.result.fast_terminal",
        reservationVersion: evidence.version,
      },
    });

    if (
      !allowSessionProjection ||
      event.appServerEpoch !== currentAppServerEpoch ||
      (session.active_turn_id !== null && session.active_turn_id !== terminal.nativeTurnId)
    ) return true;
    const projected = session.active_turn_id === null
      ? this.db.run(
          `UPDATE logical_sessions SET execution_state=?,active_turn_id=NULL,
            turn_control_version=turn_control_version+1,updated_at=?
           WHERE logical_session_id=? AND project_id=? AND active_turn_id IS NULL AND turn_control_version=?`,
          terminalStatus,
          timestamp,
          event.logicalSessionId,
          event.projectId,
          session.turn_control_version,
        )
      : this.db.run(
          `UPDATE logical_sessions SET execution_state=?,active_turn_id=NULL,
            turn_control_version=turn_control_version+1,updated_at=?
           WHERE logical_session_id=? AND project_id=? AND active_turn_id=? AND turn_control_version=?`,
          terminalStatus,
          timestamp,
          event.logicalSessionId,
          event.projectId,
          terminal.nativeTurnId,
          session.turn_control_version,
        );
    invariant(Number(projected.changes) === 1, 409, "TURN_PROJECTION_RACE", "Session turn projection changed during exact fast-terminal release");
    return true;
  }

  /**
   * Deleted or fenced content removes payload projection, not the trustworthy
   * ordered envelope. Only exact ownership evidence may move the hidden
   * Project reservation lifecycle; Session/Approval state stays untouched.
   */
  private reconcileHiddenTurnLifecycle(
    event: DurableAgentEvent,
    connection: AgentConnectionIdentity,
    currentAppServerEpoch: string,
    timestamp: string,
  ): void {
    if (event.type === "turn.started") {
      this.activateProjectTurnReservation(connection, event, timestamp);
    } else if (["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type)) {
      this.releaseProjectTurnReservationForTerminalEvent(event, timestamp);
    } else if (event.type === "command.result") {
      this.reconcileAppliedTurnStartResult(
        event,
        connection,
        currentAppServerEpoch,
        timestamp,
        false,
      );
    }
  }

  appendEvent(connection: AgentConnectionIdentity, event: DurableAgentEvent): EventAck | EventNack {
    invariant(event && typeof event === "object", 400, "EVENT_INVALID", "event must be an object");
    invariant(typeof event.eventId === "string" && event.eventId.length >= 8 && event.eventId.length <= 200, 400, "EVENT_INVALID", "eventId is invalid");
    invariant(/^sha256:[a-f0-9]{64}$/.test(event.payloadHash), 400, "EVENT_INVALID", "payloadHash is invalid");
    invariant(Number.isSafeInteger(event.hostSeq) && event.hostSeq >= 1, 400, "EVENT_INVALID", "hostSeq must be positive");
    invariant(typeof event.producerEpoch === "string" && event.producerEpoch.length > 0 && event.producerEpoch.length <= 200, 400, "EVENT_INVALID", "producerEpoch is invalid");
    invariant(typeof event.type === "string" && event.type.length > 0 && event.type.length <= 200, 400, "EVENT_INVALID", "event type is invalid");
    invariant(typeof event.schemaVersion === "string" && event.schemaVersion.length <= 50, 400, "EVENT_INVALID", "schemaVersion is invalid");
    invariant(!Number.isNaN(Date.parse(event.occurredAt)), 400, "EVENT_INVALID", "occurredAt must be an ISO timestamp");
    if (event.payload !== undefined) {
      invariant(hashPayload(event.payload) === event.payloadHash, 400, "PAYLOAD_HASH_MISMATCH", "Event payloadHash does not match payload");
    }

    return this.db.transaction(() => {
      const connectionRow = this.db.get<{
        producer_epoch: string | null;
        app_server_epoch: string | null;
        disconnected_at: string | null;
        identity_state: string;
        newer_generation: number;
      }>(
        `SELECT c.producer_epoch,c.app_server_epoch,c.disconnected_at,m.identity_state,
          EXISTS(
            SELECT 1 FROM agent_connections newer
            WHERE newer.machine_id=c.machine_id AND newer.transport_generation>c.transport_generation
          ) AS newer_generation
         FROM agent_connections c JOIN machines m ON m.machine_id=c.machine_id
         WHERE c.connection_id=? AND c.machine_id=? AND c.transport_generation=?`,
        connection.connectionId,
        connection.machineId,
        connection.transportGeneration,
      );
      invariant(connectionRow && connectionRow.identity_state === "active", 409, "MACHINE_REVOKED", "Machine identity was revoked or is missing");
      invariant(!connectionRow.disconnected_at && connectionRow.newer_generation === 0, 409, "CONNECTION_FENCED", "Agent connection is no longer current");
      invariant(connectionRow.producer_epoch, 409, "AGENT_HELLO_REQUIRED", "Agent must send hello first");
      const isCurrentProducer = connectionRow.producer_epoch === event.producerEpoch;
      let stream = this.db.get<{
        next_expected_host_seq: number;
        quarantined: number;
        sealed: number;
        resume_through_host_seq: number | null;
        resume_connection_id: string | null;
        resume_admitted: number;
      }>(
        `SELECT s.next_expected_host_seq,s.quarantined,s.sealed,s.resume_through_host_seq,
          s.resume_connection_id,EXISTS(
            SELECT 1 FROM reconciliation_cycles r
            JOIN reconciliation_stream_targets t ON t.reconciliation_id=r.reconciliation_id
            WHERE r.connection_id=? AND r.machine_id=s.machine_id
              AND t.machine_id=s.machine_id AND t.producer_epoch=s.producer_epoch
              AND t.is_current=0 AND t.through_host_seq=s.resume_through_host_seq
          ) AS resume_admitted
         FROM producer_streams s WHERE s.machine_id=? AND s.producer_epoch=?`,
        connection.connectionId,
        connection.machineId,
        event.producerEpoch,
      );
      if (!stream && isCurrentProducer) {
        this.db.run(
          `INSERT INTO producer_streams(machine_id,producer_epoch,next_expected_host_seq,quarantined,updated_at)
           VALUES(?,?,1,0,?)`,
          connection.machineId,
          event.producerEpoch,
          nowIso(),
        );
        stream = {
          next_expected_host_seq: 1,
          quarantined: 0,
          sealed: 0,
          resume_through_host_seq: null,
          resume_connection_id: null,
          resume_admitted: 0,
        };
      }
      if (
        !stream ||
        (!isCurrentProducer &&
          (stream.sealed !== 1 ||
            stream.resume_through_host_seq === null ||
            stream.resume_connection_id !== connection.connectionId ||
            stream.resume_admitted !== 1 ||
            event.hostSeq > stream.resume_through_host_seq))
      ) {
        return {
          ok: false,
          eventId: event.eventId,
          code: "PRODUCER_EPOCH_SEALED",
          message: "Old producer stream was not declared for bounded reconciliation",
          ...(stream ? { expectedHostSeq: stream.next_expected_host_seq } : {}),
        };
      }
      if (stream.quarantined === 1) {
        return {
          ok: false,
          eventId: event.eventId,
          code: "SOURCE_STREAM_CORRUPT",
          message: "Producer stream is quarantined",
          expectedHostSeq: stream.next_expected_host_seq,
        };
      }

      const duplicate = this.db.get<{
        payload_hash: string;
        machine_id: string;
        projection_epoch: number;
        session_seq: number;
      }>("SELECT payload_hash,machine_id,projection_epoch,session_seq FROM durable_events WHERE event_id=?", event.eventId);
      if (duplicate) {
        if (duplicate.payload_hash !== event.payloadHash || duplicate.machine_id !== connection.machineId) {
          return this.corruptStream(connection, event, "event_id_payload_or_source_mismatch");
        }
        return {
          ok: true,
          eventId: event.eventId,
          duplicate: true,
          projectionEpoch: duplicate.projection_epoch,
          sessionSeq: duplicate.session_seq,
          nextExpectedHostSeq: stream.next_expected_host_seq,
          event: this.getEventRecord(event.eventId),
        };
      }

      const hostCollision = this.db.get<{ event_id: string; payload_hash: string }>(
        `SELECT event_id,payload_hash FROM durable_events
         WHERE machine_id=? AND producer_epoch=? AND host_seq=?`,
        connection.machineId,
        event.producerEpoch,
        event.hostSeq,
      );
      if (hostCollision) return this.corruptStream(connection, event, "host_seq_event_id_mismatch");

      if (event.hostSeq > stream.next_expected_host_seq) {
        this.quarantineEvent(connection, event, "host_sequence_gap");
        this.db.run(
          `INSERT INTO security_alerts(alert_id,workspace_id,machine_id,code,detail_json,created_at)
           VALUES(?,?,?,?,?,?)`,
          newId("alert"),
          connection.workspaceId,
          connection.machineId,
          "HOST_SEQUENCE_GAP",
          canonicalJson({ producerEpoch: event.producerEpoch, expectedHostSeq: stream.next_expected_host_seq, receivedHostSeq: event.hostSeq }),
          nowIso(),
        );
        return {
          ok: false,
          eventId: event.eventId,
          code: "HOST_SEQUENCE_GAP",
          message: "Event rejected until the missing host sequence is replayed",
          expectedHostSeq: stream.next_expected_host_seq,
        };
      }
      if (event.hostSeq < stream.next_expected_host_seq) {
        return this.corruptStream(connection, event, "host_sequence_reuse_without_matching_event");
      }

      const session = this.db.get<{
        workspace_id: string;
        machine_id: string;
        project_id: string;
        projection_epoch: number;
        next_session_seq: number;
        content_epoch: number;
        sync_content: number;
        retention_days: number;
      }>(
        `SELECT s.workspace_id,s.machine_id,s.project_id,s.projection_epoch,s.next_session_seq,s.content_epoch,
          p.sync_content,p.retention_days
         FROM logical_sessions s JOIN projects p ON p.project_id=s.project_id WHERE s.logical_session_id=?`,
        event.logicalSessionId,
      );
      invariant(
        session && session.workspace_id === connection.workspaceId && session.machine_id === connection.machineId && session.project_id === event.projectId,
        403,
        "EVENT_SESSION_BINDING_INVALID",
        "Event does not belong to this Machine/Project/Workspace",
      );
      const segment = this.db.get<{ execution_segment_id: string }>(
        `SELECT execution_segment_id FROM execution_segments
         WHERE execution_segment_id=? AND logical_session_id=? AND machine_id=? AND project_id=?`,
        event.executionSegmentId,
        event.logicalSessionId,
        connection.machineId,
        event.projectId,
      );
      invariant(segment, 403, "EVENT_SEGMENT_BINDING_INVALID", "Event execution segment binding is invalid");

      const incomingContentEpoch = event.contentEpoch ?? 1;
      invariant(Number.isSafeInteger(incomingContentEpoch) && incomingContentEpoch >= 1, 400, "EVENT_INVALID", "contentEpoch must be a positive integer");
      const staleContentEpoch = incomingContentEpoch < session.content_epoch;
      if (incomingContentEpoch > session.content_epoch) {
        return {
          ok: false,
          eventId: event.eventId,
          code: "CONTENT_EPOCH_FUTURE",
          message: "Event contentEpoch is ahead of the Control Plane",
        };
      }

      const recognized = event.schemaVersion === "1.0" && KNOWN_EVENT_TYPES.has(event.type);
      const currentAppServerEpoch = connectionRow.app_server_epoch ?? "";
      const staleAppServerEpoch = recognized && event.appServerEpoch !== currentAppServerEpoch;
      const requestedPayloadState = event.payloadState ?? (event.payload === undefined ? "suppressed" : "present");
      invariant(["present", "suppressed", "deleted"].includes(requestedPayloadState), 400, "EVENT_INVALID", "payloadState is invalid");
      const retentionSeconds = session.retention_days * 24 * 60 * 60;
      const expiredAtIngress = Date.parse(event.occurredAt) <= Date.now() - retentionSeconds * 1_000;
      const tombstoneAtIngress = staleContentEpoch || requestedPayloadState === "deleted" || expiredAtIngress;
      const payloadState = tombstoneAtIngress
        ? "deleted"
        : session.sync_content === 1 && recognized && requestedPayloadState === "present" && event.payload !== undefined
          ? "present"
          : "suppressed";
      const storedContentEpoch = staleContentEpoch
        ? session.content_epoch
        : tombstoneAtIngress
          ? Math.max(incomingContentEpoch + 1, session.content_epoch)
          : incomingContentEpoch;
      let payloadRef: string | null = null;
      const timestamp = nowIso();
      if (payloadState === "present") {
        payloadRef = newId("blob");
        this.db.run(
          `INSERT INTO content_blobs(payload_ref,workspace_id,body_json,payload_hash,created_at,expires_at)
           VALUES(?,?,?,?,?,?)`,
          payloadRef,
          connection.workspaceId,
          canonicalJson(new CloudImages(this.db).store(connection.machineId, "event", payloadRef, event.payload, "sync", {logicalSessionId:event.logicalSessionId,nativeThreadId:event.nativeThreadId,nativeTurnId:event.nativeTurnId})),
          event.payloadHash,
          timestamp,
          futureIso(retentionSeconds),
        );
      }
      const sessionSeq = session.next_session_seq;
      this.db.run(
        `INSERT INTO durable_events(
          event_id,payload_hash,source_kind,workspace_id,logical_session_id,execution_segment_id,
          machine_id,project_id,producer_epoch,app_server_epoch,host_seq,session_seq,projection_epoch,
          native_thread_id,native_turn_id,native_item_id,type,schema_version,occurred_at,received_at,
          payload_ref,payload_state,content_epoch
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        event.eventId,
        event.payloadHash,
        "agent",
        connection.workspaceId,
        event.logicalSessionId,
        event.executionSegmentId,
        connection.machineId,
        event.projectId,
        event.producerEpoch,
        event.appServerEpoch ?? null,
        event.hostSeq,
        sessionSeq,
        session.projection_epoch,
        event.nativeThreadId ?? null,
        event.nativeTurnId ?? null,
        event.nativeItemId ?? null,
        event.type,
        event.schemaVersion,
        event.occurredAt,
        timestamp,
        payloadRef,
        payloadState,
        storedContentEpoch,
      );
      if (tombstoneAtIngress) {
        this.db.run(
          `INSERT INTO content_tombstones(
            event_id,workspace_id,logical_session_id,payload_hash,deleted_content_epoch,
            tombstone_content_epoch,reason,deleted_at
          ) VALUES(?,?,?,?,?,?,?,?)`,
          event.eventId,
          connection.workspaceId,
          event.logicalSessionId,
          event.payloadHash,
          incomingContentEpoch,
          storedContentEpoch,
          staleContentEpoch ? "user_deleted" : "expired",
          timestamp,
        );
      }
      this.db.run(
        "UPDATE producer_streams SET next_expected_host_seq=?,updated_at=? WHERE machine_id=? AND producer_epoch=?",
        event.hostSeq + 1,
        timestamp,
        connection.machineId,
        event.producerEpoch,
      );
      this.db.run(
        `UPDATE logical_sessions SET next_session_seq=?,updated_at=?
         WHERE logical_session_id=? AND next_session_seq=?`,
        sessionSeq + 1,
        timestamp,
        event.logicalSessionId,
        sessionSeq,
      );
      if (event.nativeThreadId && !staleContentEpoch && !staleAppServerEpoch) {
        this.db.run(
          "UPDATE execution_segments SET native_thread_id=? WHERE execution_segment_id=?",
          event.nativeThreadId,
          event.executionSegmentId,
        );
        this.db.run(
          `INSERT OR IGNORE INTO native_thread_bindings(machine_id,codex_profile_id,native_thread_id,logical_session_id,execution_segment_id)
           SELECT machine_id,codex_profile_id,?,?,? FROM logical_sessions WHERE logical_session_id=?`,
          event.nativeThreadId,event.logicalSessionId,event.executionSegmentId,event.logicalSessionId,
        );
      }
      if (recognized && event.type === "command.result") this.reconcileNativeDeletionResult(event,connection);
      if (recognized && (staleContentEpoch || staleAppServerEpoch)) {
        this.reconcileHiddenTurnLifecycle(
          event,
          connection,
          currentAppServerEpoch,
          timestamp,
        );
      } else if (recognized && event.type === "command.result") {
        this.reconcileAppliedTurnStartResult(
          event,
          connection,
          currentAppServerEpoch,
          timestamp,
          true,
        );
      } else if (recognized && !(tombstoneAtIngress && event.type === "approval.requested")) {
        this.applyProjection(connection, event, currentAppServerEpoch, timestamp);
      }
      const record = this.getEventRecord(event.eventId);
      return {
        ok: true,
        eventId: event.eventId,
        duplicate: false,
        projectionEpoch: session.projection_epoch,
        sessionSeq,
        nextExpectedHostSeq: event.hostSeq + 1,
        event: record,
      };
    });
  }

  private applyProjection(
    connection: AgentConnectionIdentity,
    event: DurableAgentEvent,
    currentAppServerEpoch: string,
    timestamp: string,
  ): void {
    if (this.db.get("SELECT 1 FROM logical_sessions WHERE logical_session_id=? AND deleted_at IS NOT NULL",event.logicalSessionId)) return;
    if (event.type === "thread.claimed" || event.type === "thread.released") {
      const current = this.db.get<{ management_revision: number; active_turn_id: string | null; managed: number }>(
        "SELECT management_revision,active_turn_id,managed FROM logical_sessions WHERE logical_session_id=? AND project_id=?",
        event.logicalSessionId, event.projectId,
      );
      if (!current || (event.type === "thread.released" && current.active_turn_id !== null)) return;
      const payload = event.payload as Record<string, unknown> | undefined;
      const revision = payload?.managementRevision;
      if (revision !== undefined && (!Number.isSafeInteger(revision) || Number(revision) < 1)) return;
      if (typeof revision === "number" && revision < current.management_revision) return;
      if (revision === current.management_revision && current.managed !== (event.type === "thread.claimed" ? 1 : 0)) return;
      this.db.run("UPDATE logical_sessions SET management_revision=? WHERE logical_session_id=?",
        typeof revision === "number" ? revision : current.management_revision + 1, event.logicalSessionId);
    }
    if (event.type === "thread.updated") {
      const payload = ensureRecord(event.payload);
      if (typeof payload.title === "string" && payload.title.trim() && payload.title.length <= 200) this.db.run("UPDATE logical_sessions SET title=?,updated_at=? WHERE logical_session_id=?", payload.title, timestamp, event.logicalSessionId);
      if (typeof payload.archived === "boolean") this.db.run("UPDATE logical_sessions SET runtime_settings_json=json_set(CASE WHEN json_type(runtime_settings_json)='object' THEN runtime_settings_json ELSE '{}' END,'$.archived',json(?)),updated_at=? WHERE logical_session_id=?", JSON.stringify(payload.archived), timestamp, event.logicalSessionId);
      this.db.run("UPDATE logical_sessions SET thread_control_version=thread_control_version+1 WHERE logical_session_id=?", event.logicalSessionId);
    } else if (event.type === "thread.claimed") {
      if (!event.nativeThreadId) return;
      this.db.run(
        `UPDATE logical_sessions SET managed=1,execution_state='idle',active_turn_id=NULL,
          thread_control_version=thread_control_version+1,updated_at=?
         WHERE logical_session_id=? AND project_id=? AND managed=0`,
        timestamp,
        event.logicalSessionId,
        event.projectId,
      );
      this.db.run(
        `UPDATE execution_segments SET native_thread_id=?,history_completeness='partial',history_mode=COALESCE(?,history_mode)
         WHERE execution_segment_id=? AND logical_session_id=?`,
        event.nativeThreadId,
        (event.payload as Record<string, unknown> | undefined)?.historyMode === "paginated" ? "paginated" : (event.payload as Record<string, unknown> | undefined)?.historyMode === "legacy" ? "legacy" : null,
        event.executionSegmentId,
        event.logicalSessionId,
      );
    } else if (event.type === "thread.released") {
      this.db.run(
        `UPDATE logical_sessions SET managed=0,execution_state='idle',active_turn_id=NULL,
          thread_control_version=thread_control_version+1,control_lease_version=control_lease_version+1,updated_at=?
         WHERE logical_session_id=? AND project_id=? AND managed=1 AND active_turn_id IS NULL`,
        timestamp,
        event.logicalSessionId,
        event.projectId,
      );
      this.db.run(
        `UPDATE control_leases SET state='revoked',version=version+1,ended_at=?
         WHERE logical_session_id=? AND state='active'`,
        timestamp,
        event.logicalSessionId,
      );
      this.db.run(
        `UPDATE execution_segments SET history_completeness='partial'
         WHERE execution_segment_id=? AND logical_session_id=?`,
        event.executionSegmentId,
        event.logicalSessionId,
      );
    } else if (event.type === "turn.started") {
      if (!event.nativeTurnId) return;
      const session = this.db.get<{
        project_id: string;
        active_turn_id: string | null;
        turn_control_version: number;
      }>(
        `SELECT project_id,active_turn_id,turn_control_version FROM logical_sessions
         WHERE logical_session_id=?`,
        event.logicalSessionId,
      );
      if (
        !session ||
        session.project_id !== event.projectId ||
        (session.active_turn_id !== null && session.active_turn_id !== event.nativeTurnId)
      ) return;
      if (!this.activateProjectTurnReservation(connection, event, timestamp)) return;
      if (session.active_turn_id === event.nativeTurnId) return;
      const projected = this.db.run(
        `UPDATE logical_sessions SET execution_state='running',active_turn_id=?,turn_control_version=turn_control_version+1,updated_at=?
         WHERE logical_session_id=? AND project_id=? AND active_turn_id IS NULL AND turn_control_version=?`,
        event.nativeTurnId,
        timestamp,
        event.logicalSessionId,
        event.projectId,
        session.turn_control_version,
      );
      invariant(Number(projected.changes) === 1, 409, "TURN_PROJECTION_RACE", "Session turn projection changed during reservation activation");
    } else if (["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type)) {
      if (!event.nativeTurnId) return;
      const session = this.db.get<{
        project_id: string;
        active_turn_id: string | null;
        turn_control_version: number;
      }>(
        `SELECT project_id,active_turn_id,turn_control_version FROM logical_sessions
         WHERE logical_session_id=?`,
        event.logicalSessionId,
      );
      if (!session || session.project_id !== event.projectId) return;
      if (session.active_turn_id !== null && session.active_turn_id !== event.nativeTurnId) return;
      const state = event.type === "turn.completed" ? "completed" : event.type === "turn.failed" ? "failed" : "interrupted";
      if (!this.releaseProjectTurnReservationForTerminalEvent(event, timestamp)) return;
      if (session.active_turn_id === null) return;
      const projected = this.db.run(
        `UPDATE logical_sessions SET execution_state=?,active_turn_id=NULL,turn_control_version=turn_control_version+1,updated_at=?
         WHERE logical_session_id=? AND project_id=? AND active_turn_id=? AND turn_control_version=?`,
        state,
        timestamp,
        event.logicalSessionId,
        event.projectId,
        event.nativeTurnId,
        session.turn_control_version,
      );
      invariant(Number(projected.changes) === 1, 409, "TURN_PROJECTION_RACE", "Session turn projection changed during reservation release");
    } else if (event.type === "approval.requested") {
      const payload = ensureRecord(event.payload, "approval.requested payload is required");
      invariant(typeof payload.approvalId === "string" && typeof payload.actionHash === "string", 400, "EVENT_INVALID", "approval.requested requires approvalId and actionHash");
      const version = typeof payload.approvalVersion === "number" ? payload.approvalVersion : 1;
      invariant(Number.isSafeInteger(version) && version >= 1, 400, "EVENT_INVALID", "approvalVersion must be positive");
      const existing = this.db.get<{ action_hash: string; app_server_epoch: string; version: number }>(
        "SELECT action_hash,app_server_epoch,version FROM approvals WHERE approval_id=?",
        payload.approvalId,
      );
      if (existing) {
        invariant(
          existing.action_hash === payload.actionHash && existing.app_server_epoch === (event.appServerEpoch ?? currentAppServerEpoch) && existing.version === version,
          409,
          "APPROVAL_ID_COLLISION",
          "approvalId was reused with different context",
        );
      } else {
        this.db.run(
          `INSERT INTO approvals(
            approval_id,logical_session_id,execution_segment_id,action_hash,app_server_epoch,version,
            context_json,state,created_at
          ) VALUES(?,?,?,?,?,?,?,'pending',?)`,
          payload.approvalId,
          event.logicalSessionId,
          event.executionSegmentId,
          payload.actionHash,
          event.appServerEpoch ?? currentAppServerEpoch,
          version,
          canonicalJson(payload.context ?? payload),
          timestamp,
        );
      }
      this.db.run(
        "UPDATE logical_sessions SET execution_state='awaiting_approval',updated_at=? WHERE logical_session_id=?",
        timestamp,
        event.logicalSessionId,
      );
    } else if (event.type === "approval.resolved") {
      this.db.run(`UPDATE approvals SET state='rejected',version=version+1,decided_at=?
        WHERE approval_id=? AND logical_session_id=? AND app_server_epoch=? AND state='pending'`,
        timestamp, String(ensureRecord(event.payload).approvalId ?? ""), event.logicalSessionId, event.appServerEpoch ?? currentAppServerEpoch);
      this.db.run(
        `UPDATE logical_sessions SET execution_state=CASE WHEN active_turn_id IS NULL THEN execution_state ELSE 'running' END,
          updated_at=? WHERE logical_session_id=?`,
        timestamp,
        event.logicalSessionId,
      );
    }
  }

  private corruptStream(
    connection: AgentConnectionIdentity,
    event: DurableAgentEvent,
    reason: string,
  ): EventNack {
    const timestamp = nowIso();
    this.quarantineEvent(connection, event, reason);
    this.db.run(
      `INSERT INTO producer_streams(machine_id,producer_epoch,next_expected_host_seq,quarantined,updated_at)
       VALUES(?,?,1,1,?) ON CONFLICT(machine_id,producer_epoch) DO UPDATE SET quarantined=1,updated_at=excluded.updated_at`,
      connection.machineId,
      event.producerEpoch,
      timestamp,
    );
    this.db.run(
      `UPDATE machines SET security_state='degraded_read_only',security_reason='source_stream_corrupt',
        unreachable_reason='source_stream_corrupt',updated_at=?
       WHERE machine_id=?`,
      timestamp,
      connection.machineId,
    );
    this.db.run(
      `INSERT INTO security_alerts(alert_id,workspace_id,machine_id,code,detail_json,created_at)
       VALUES(?,?,?,?,?,?)`,
      newId("alert"),
      connection.workspaceId,
      connection.machineId,
      "SOURCE_STREAM_CORRUPT",
      canonicalJson({ producerEpoch: event.producerEpoch, eventId: event.eventId, hostSeq: event.hostSeq, reason }),
      timestamp,
    );
    this.db.audit({
      workspaceId: connection.workspaceId,
      machineId: connection.machineId,
      action: "event.source_stream_quarantine",
      outcome: "denied",
      metadata: { producerEpoch: event.producerEpoch, eventId: event.eventId, hostSeq: event.hostSeq, reason },
    });
    const stream = this.db.get<{ next_expected_host_seq: number }>(
      "SELECT next_expected_host_seq FROM producer_streams WHERE machine_id=? AND producer_epoch=?",
      connection.machineId,
      event.producerEpoch,
    );
    return {
      ok: false,
      eventId: event.eventId,
      code: "SOURCE_STREAM_CORRUPT",
      message: "Producer stream was quarantined and Machine is read-only",
      ...(stream ? { expectedHostSeq: stream.next_expected_host_seq } : {}),
    };
  }

  private quarantineEvent(connection: AgentConnectionIdentity, event: DurableAgentEvent, reason: string): void {
    const safeEnvelope = {
      eventId: event.eventId,
      payloadHash: event.payloadHash,
      logicalSessionId: event.logicalSessionId,
      executionSegmentId: event.executionSegmentId,
      projectId: event.projectId,
      producerEpoch: event.producerEpoch,
      appServerEpoch: event.appServerEpoch,
      hostSeq: event.hostSeq,
      type: event.type,
      schemaVersion: event.schemaVersion,
      occurredAt: event.occurredAt,
    };
    this.db.run(
      `INSERT INTO quarantined_events(
        quarantine_id,machine_id,producer_epoch,event_id,host_seq,payload_hash,reason,envelope_json,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`,
      newId("quarantine"),
      connection.machineId,
      event.producerEpoch,
      event.eventId,
      event.hostSeq,
      event.payloadHash,
      reason,
      canonicalJson(safeEnvelope),
      nowIso(),
    );
  }

  private getEventRecord(eventId: string): Record<string, unknown> {
    const row = this.db.get<{
      event_id: string;
      payload_hash: string;
      source_kind: string;
      workspace_id: string;
      logical_session_id: string;
      execution_segment_id: string;
      machine_id: string;
      project_id: string;
      producer_epoch: string | null;
      app_server_epoch: string | null;
      host_seq: number | null;
      session_seq: number;
      projection_epoch: number;
      native_thread_id: string | null;
      native_turn_id: string | null;
      native_item_id: string | null;
      type: string;
      schema_version: string;
      occurred_at: string;
      received_at: string;
      payload_ref: string | null;
      payload_state: string;
      content_epoch: number;
      body_json: string | null;
    }>(
      `SELECT e.*,b.body_json FROM durable_events e LEFT JOIN content_blobs b ON b.payload_ref=e.payload_ref
       AND b.deleted_at IS NULL AND b.expires_at>? WHERE e.event_id=?`,
      nowIso(),
      eventId,
    );
    invariant(row, 404, "EVENT_NOT_FOUND", "Event was not found");
    return {
      eventId: row.event_id,
      payloadHash: row.payload_hash,
      sourceKind: row.source_kind,
      workspaceId: row.workspace_id,
      logicalSessionId: row.logical_session_id,
      executionSegmentId: row.execution_segment_id,
      machineId: row.machine_id,
      projectId: row.project_id,
      producerEpoch: row.producer_epoch,
      appServerEpoch: row.app_server_epoch,
      hostSeq: row.host_seq,
      sessionSeq: row.session_seq,
      projectionEpoch: row.projection_epoch,
      nativeThreadId: row.native_thread_id,
      nativeTurnId: row.native_turn_id,
      nativeItemId: row.native_item_id,
      type: row.type,
      schemaVersion: row.schema_version,
      occurredAt: row.occurred_at,
      receivedAt: row.received_at,
      payloadRef: row.payload_ref,
      payloadState: row.body_json ? row.payload_state : row.payload_state === "present" ? "deleted" : row.payload_state,
      contentEpoch: row.content_epoch,
      ...(row.body_json ? { payload: new CloudImages(this.db).hydrate(row.machine_id, "event", row.payload_ref!, parseJson(row.body_json)) } : {}),
    };
  }

  historyPage(principal: Principal, logicalSessionId: string, options: { limit: number; beforeSeq?: number; projectionEpoch?: number; contentEpoch?: number }): Record<string, unknown> {
    invariant(Number.isSafeInteger(options.limit) && options.limit >= 1 && options.limit <= 200, 400, "INVALID_LIMIT", "limit must be between 1 and 200");
    invariant(options.beforeSeq === undefined || (Number.isSafeInteger(options.beforeSeq) && options.beforeSeq >= 1), 400, "INVALID_CURSOR", "beforeSeq must be positive");
    const session = this.db.get<{ projection_epoch: number; content_epoch: number; next_session_seq: number }>(
      "SELECT projection_epoch,content_epoch,next_session_seq FROM logical_sessions WHERE logical_session_id=? AND workspace_id=?", logicalSessionId,principal.workspaceId);
    invariant(session,404,"SESSION_NOT_FOUND","Logical Session was not found");
    invariant(options.projectionEpoch===undefined || options.projectionEpoch===session.projection_epoch,409,"PROJECTION_EPOCH_CHANGED","Refresh the history snapshot");
    invariant(options.contentEpoch===undefined || options.contentEpoch===session.content_epoch,409,"CONTENT_EPOCH_CHANGED","Content was removed; refresh the history snapshot");
    const rows=this.db.all<{event_id:string;session_seq:number}>(
      "SELECT event_id,session_seq FROM durable_events WHERE logical_session_id=? AND projection_epoch=? AND session_seq<? ORDER BY session_seq DESC LIMIT ?",
      logicalSessionId,session.projection_epoch,options.beforeSeq??session.next_session_seq,options.limit+1);
    const visible: typeof rows = []; const items: Record<string, unknown>[] = []; let bytes = 0;
    for (const row of rows.slice(0,options.limit)) {
      const item = this.getEventRecord(row.event_id); const size = Buffer.byteLength(JSON.stringify(item));
      if (items.length && bytes + size > 2_000_000) break;
      visible.push(row); items.push(item); bytes += size;
    }
    items.reverse();
    return {items,events:items,nextBeforeSeq:rows.length>visible.length?visible.at(-1)?.session_seq??null:null,
      throughSeq:session.next_session_seq-1,projectionEpoch:session.projection_epoch,contentEpoch:session.content_epoch};
  }

  replayEvents(principal: Principal, logicalSessionId: string, afterSeq = 0, projectionEpoch?: number): Record<string, unknown>[] {
    invariant(Number.isSafeInteger(afterSeq) && afterSeq >= 0, 400, "INVALID_CURSOR", "afterSeq must be non-negative");
    const session = this.db.get<{ projection_epoch: number }>(
      "SELECT projection_epoch FROM logical_sessions WHERE logical_session_id=? AND workspace_id=?",
      logicalSessionId,
      principal.workspaceId,
    );
    invariant(session, 404, "SESSION_NOT_FOUND", "Logical Session was not found");
    invariant(projectionEpoch === undefined || projectionEpoch === session.projection_epoch, 409, "PROJECTION_EPOCH_CHANGED", "Projection epoch changed; request a fresh snapshot", { currentProjectionEpoch: session.projection_epoch });
    return this.db
      .all<{ event_id: string }>(
        `SELECT event_id FROM durable_events WHERE logical_session_id=? AND projection_epoch=? AND session_seq>?
         ORDER BY session_seq LIMIT 10000`,
        logicalSessionId,
        session.projection_epoch,
        afterSeq,
      )
      .map((row) => this.getEventRecord(row.event_id));
  }

  deleteSessionContent(principal: Principal, logicalSessionId: string, withinTransaction = false): {
    logicalSessionId: string;
    deletedEvents: number;
    contentEpoch: number;
    deletedAt: string;
  } {
    const work = () => {
      const session = this.db.get<{ content_epoch: number }>(
        "SELECT content_epoch FROM logical_sessions WHERE logical_session_id=? AND workspace_id=?",
        logicalSessionId,
        principal.workspaceId,
      );
      invariant(session, 404, "SESSION_NOT_FOUND", "Logical Session was not found");
      const timestamp = nowIso();
      const nextContentEpoch = session.content_epoch + 1;
      const advanced = this.db.run(
        `UPDATE logical_sessions SET content_epoch=?,updated_at=?
         WHERE logical_session_id=? AND workspace_id=? AND content_epoch=?`,
        nextContentEpoch,
        timestamp,
        logicalSessionId,
        principal.workspaceId,
        session.content_epoch,
      );
      invariant(Number(advanced.changes) === 1, 409, "CONTENT_EPOCH_CONFLICT", "Session content epoch changed concurrently");
      const events = this.db.all<{
        event_id: string;
        payload_hash: string;
        payload_ref: string | null;
        content_epoch: number;
      }>(
        `SELECT event_id,payload_hash,payload_ref,content_epoch FROM durable_events
         WHERE logical_session_id=? AND payload_state='present'`,
        logicalSessionId,
      );
      for (const event of events) {
        this.tombstoneEvent(
          event,
          principal.workspaceId,
          logicalSessionId,
          "user_deleted",
          timestamp,
          Math.max(event.content_epoch + 1, nextContentEpoch),
        );
      }
      const commands = this.db.all<{
        command_id: string;
        command_state: string;
        dispatch_attempt_id: string | null;
        attempt_state: string | null;
      }>(
        `SELECT c.command_id,cp.state AS command_state,a.dispatch_attempt_id,ap.state AS attempt_state
         FROM commands c JOIN command_projection cp ON cp.command_id=c.command_id
         LEFT JOIN dispatch_attempts a ON a.dispatch_attempt_id=(
           SELECT a2.dispatch_attempt_id FROM dispatch_attempts a2
           WHERE a2.command_id=c.command_id ORDER BY a2.attempt_no DESC LIMIT 1
         )
         LEFT JOIN dispatch_attempt_projection ap ON ap.dispatch_attempt_id=a.dispatch_attempt_id
         WHERE c.logical_session_id=? AND c.content_epoch<?`,
        logicalSessionId,
        nextContentEpoch,
      );
      for (const command of commands) {
        if (command.command_state === "accepted") {
          this.setCommandState(
            command.command_id,
            command.dispatch_attempt_id ? "unknown" : "invalidated",
            {
              reason: command.dispatch_attempt_id
                ? "content_deleted_after_prior_offer"
                : "content_deleted_before_dispatch",
            },
          );
        } else if (command.command_state === "dispatching") {
          if (command.dispatch_attempt_id && command.attempt_state !== "unknown") {
            const updated = this.db.run(
              `UPDATE dispatch_attempt_projection SET state='unknown',updated_at=?
               WHERE dispatch_attempt_id=? AND state=?`,
              timestamp,
              command.dispatch_attempt_id,
              command.attempt_state,
            );
            if (Number(updated.changes) === 1) {
              this.db.run(
                `INSERT INTO dispatch_attempt_lifecycle(dispatch_attempt_id,state,detail_json,created_at)
                 VALUES(?,'unknown',?,?)`,
                command.dispatch_attempt_id,
                canonicalJson({ reason: "content_deleted_after_possible_delivery" }),
                timestamp,
              );
            }
          }
          this.setCommandState(command.command_id, "unknown", {
            reason: "content_deleted_after_possible_delivery",
          });
        }
      }
      this.db.run(
        `UPDATE command_contents SET body_json='null',deleted_at=?
         WHERE deleted_at IS NULL AND command_id IN (
           SELECT command_id FROM commands WHERE logical_session_id=?
         )`,
        timestamp,
        logicalSessionId,
      );
      this.db.run(
        `UPDATE approvals SET context_json='{"payloadState":"deleted"}',
          state=CASE WHEN state='pending' THEN 'rejected' ELSE state END,
          version=CASE WHEN state='pending' THEN version+1 ELSE version END,
          decided_at=CASE WHEN state='pending' THEN ? ELSE decided_at END
         WHERE logical_session_id=?`,
        timestamp,
        logicalSessionId,
      );
      this.db.audit({
        workspaceId: principal.workspaceId,
        actorUserId: principal.userId,
        actorClientSessionId: principal.clientSessionId,
        logicalSessionId,
        action: "content.delete",
        metadata: {
          deletedEvents: events.length,
          invalidatedCommands: commands.filter((command) => ["accepted", "dispatching"].includes(command.command_state)).length,
          contentEpoch: nextContentEpoch,
          localThreadDeleted: false,
        },
      });
      return {
        logicalSessionId,
        deletedEvents: events.length,
        contentEpoch: nextContentEpoch,
        deletedAt: timestamp,
      };
    };
    return withinTransaction ? work() : this.db.transaction(work);
  }

  purgeExpiredContent(timestamp = nowIso(), limit = 1_000): number {
    invariant(Number.isSafeInteger(limit) && limit >= 1 && limit <= 10_000, 400, "INVALID_LIMIT", "Purge limit is invalid");
    return this.db.transaction(() => {
      const events = this.db.all<{
        event_id: string;
        workspace_id: string;
        logical_session_id: string;
        payload_hash: string;
        payload_ref: string | null;
        content_epoch: number;
      }>(
        `SELECT e.event_id,e.workspace_id,e.logical_session_id,e.payload_hash,e.payload_ref,e.content_epoch
         FROM durable_events e JOIN content_blobs b ON b.payload_ref=e.payload_ref
         WHERE e.payload_state='present' AND b.deleted_at IS NULL AND b.expires_at<=?
         ORDER BY b.expires_at LIMIT ?`,
        timestamp,
        limit,
      );
      const counts = new Map<string, { workspaceId: string; count: number }>();
      for (const event of events) {
        this.tombstoneEvent(
          event,
          event.workspace_id,
          event.logical_session_id,
          "expired",
          timestamp,
          event.content_epoch + 1,
        );
        const current = counts.get(event.logical_session_id);
        if (current) current.count += 1;
        else counts.set(event.logical_session_id, { workspaceId: event.workspace_id, count: 1 });
      }
      for (const [logicalSessionId, item] of counts) {
        this.db.audit({
          workspaceId: item.workspaceId,
          logicalSessionId,
          action: "content.expire",
          metadata: { deletedEvents: item.count },
        });
      }
      const expiredCommands = this.db.run(
        `UPDATE command_contents SET body_json='null',deleted_at=?
         WHERE deleted_at IS NULL AND expires_at<=?`,
        timestamp,
        timestamp,
      );
      const approvalCutoff = new Date(Date.parse(timestamp) - 7 * 24 * 60 * 60 * 1_000).toISOString();
      const expiredApprovals = this.db.run(
        `UPDATE approvals SET context_json='{"payloadState":"deleted"}',
          state=CASE WHEN state='pending' THEN 'rejected' ELSE state END,
          version=CASE WHEN state='pending' THEN version+1 ELSE version END,
          decided_at=CASE WHEN state='pending' THEN ? ELSE decided_at END
         WHERE created_at<=? AND context_json<>'{"payloadState":"deleted"}'`,
        timestamp,
        approvalCutoff,
      );
      new CloudImages(this.db).collect(timestamp);
      return events.length + Number(expiredCommands.changes) + Number(expiredApprovals.changes);
    });
  }

  purgeExpiredAudit(timestamp = nowIso()): number {
    const cutoff = new Date(Date.parse(timestamp) - 180 * 24 * 60 * 60 * 1_000).toISOString();
    const result = this.db.run("DELETE FROM audit_entries WHERE created_at<=?", cutoff);
    return Number(result.changes);
  }

  private tombstoneEvent(
    event: { event_id: string; payload_hash: string; payload_ref: string | null; content_epoch: number },
    workspaceId: string,
    logicalSessionId: string,
    reason: "expired" | "user_deleted",
    timestamp: string,
    tombstoneContentEpoch: number,
  ): void {
    const changed = this.db.run(
      `UPDATE durable_events SET payload_ref=NULL,payload_state='deleted',content_epoch=?
       WHERE event_id=? AND payload_state='present'`,
      tombstoneContentEpoch,
      event.event_id,
    );
    if (Number(changed.changes) !== 1) return;
    if (event.payload_ref) {
      this.db.run(
        "UPDATE content_blobs SET body_json='null',deleted_at=? WHERE payload_ref=? AND deleted_at IS NULL",
        timestamp,
        event.payload_ref,
      );
    }
    this.db.run(
      `INSERT INTO content_tombstones(
        event_id,workspace_id,logical_session_id,payload_hash,deleted_content_epoch,
        tombstone_content_epoch,reason,deleted_at
      ) VALUES(?,?,?,?,?,?,?,?)`,
      event.event_id,
      workspaceId,
      logicalSessionId,
      event.payload_hash,
      event.content_epoch,
      tombstoneContentEpoch,
      reason,
      timestamp,
    );
  }

  listApprovals(principal: Principal, state?: string): Record<string, unknown>[] {
    invariant(!state || ["pending", "approved", "rejected"].includes(state), 400, "INVALID_APPROVAL_STATE", "Invalid approval state");
    const rows = state
      ? this.db.all<{
          approval_id: string; logical_session_id: string; execution_segment_id: string; action_hash: string;
          app_server_epoch: string; version: number; context_json: string; state: string;
          command_state: string | null;
          decision_command_id: string | null; decided_by_client_session_id: string | null;
          decided_at: string | null; created_at: string;
        }>(
          `SELECT a.*,cp.state AS command_state FROM approvals a
           JOIN logical_sessions s ON s.logical_session_id=a.logical_session_id
           JOIN machines m ON m.machine_id=s.machine_id
           LEFT JOIN command_projection cp ON cp.command_id=a.decision_command_id
           WHERE s.workspace_id=? AND m.identity_state='active' AND a.state=? ORDER BY a.created_at DESC LIMIT 200`,
          principal.workspaceId,
          state,
        )
      : this.db.all<{
          approval_id: string; logical_session_id: string; execution_segment_id: string; action_hash: string;
          app_server_epoch: string; version: number; context_json: string; state: string;
          command_state: string | null;
          decision_command_id: string | null; decided_by_client_session_id: string | null;
          decided_at: string | null; created_at: string;
        }>(
          `SELECT a.*,cp.state AS command_state FROM approvals a
           JOIN logical_sessions s ON s.logical_session_id=a.logical_session_id
           JOIN machines m ON m.machine_id=s.machine_id
           LEFT JOIN command_projection cp ON cp.command_id=a.decision_command_id
           WHERE s.workspace_id=? AND m.identity_state='active' ORDER BY a.created_at DESC LIMIT 200`,
          principal.workspaceId,
        );
    return rows.map((row) => ({
      approvalId: row.approval_id,
      logicalSessionId: row.logical_session_id,
      executionSegmentId: row.execution_segment_id,
      actionHash: row.action_hash,
      appServerEpoch: row.app_server_epoch,
      approvalVersion: row.version,
      context: parseJson(row.context_json),
      scope: "once",
      state: row.state === "pending"
        ? "pending"
        : row.command_state === "unknown"
          ? "delivery_unknown"
          : row.command_state === "accepted" || row.command_state === "dispatching"
            ? "delivery_in_progress"
            : row.state,
      decisionCommandId: row.decision_command_id,
      decidedByClientSessionId: row.decided_by_client_session_id,
      decidedAt: row.decided_at,
      createdAt: row.created_at,
    }));
  }

  listAudit(principal: Principal, limit = 100): Record<string, unknown>[] {
    invariant(Number.isSafeInteger(limit) && limit >= 1 && limit <= 500, 400, "INVALID_LIMIT", "limit must be between 1 and 500");
    return this.db
      .all<{
        audit_id: string; actor_user_id: string | null; actor_client_session_id: string | null;
        machine_id: string | null; project_id: string | null; logical_session_id: string | null;
        control_lease_id: string | null; action: string; outcome: string; ip_hash: string | null;
        user_agent_hash: string | null; metadata_json: string; created_at: string;
      }>("SELECT * FROM audit_entries WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?", principal.workspaceId, limit)
      .map((row) => ({
        auditId: row.audit_id,
        actorUserId: row.actor_user_id,
        actorClientSessionId: row.actor_client_session_id,
        machineId: row.machine_id,
        projectId: row.project_id,
        logicalSessionId: row.logical_session_id,
        controlLeaseId: row.control_lease_id,
        action: row.action,
        outcome: row.outcome,
        ipHash: row.ip_hash,
        userAgentHash: row.user_agent_hash,
        metadata: parseJson(row.metadata_json),
        createdAt: row.created_at,
      }));
  }
}
