/**
 * Stable P0a/P0b wire vocabulary shared by the dashboard and local Agent.
 * JSON schemas are deliberately dependency-free so callers can feed them to
 * Fastify, Ajv, or a code generator.
 */

export const COMMAND_TYPES = [
  "thread.claim",
  "thread.release",
  "thread.rename",
  "thread.delete.preview",
  "thread.delete",
  "thread.archive",
  "thread.unarchive",
  "thread.fork",
  "turn.start",
  "turn.compact",
  "turn.review",
  "turn.queue",
  "turn.steer",
  "turn.cancel",
  "approval.decide_once",
  "input.respond",
  "codex.inspect",
  "thread.terminals.stop",
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export const MACHINE_REACHABILITY = [
  "offline",
  "connecting",
  "online",
  "reconnecting",
] as const;
export type MachineReachability = (typeof MACHINE_REACHABILITY)[number];

export const MACHINE_COMPATIBILITY = [
  "unknown",
  "compatible",
  "incompatible",
] as const;
export type MachineCompatibility = (typeof MACHINE_COMPATIBILITY)[number];

export const MACHINE_CAPACITY = ["unknown", "idle", "busy", "saturated"] as const;
export type MachineCapacity = (typeof MACHINE_CAPACITY)[number];

export const EXECUTION_STATES = [
  "idle",
  "running",
  "awaiting_approval",
  "completed",
  "interrupted",
  "failed",
  "unknown",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const SESSION_REACHABILITY = ["live", "reconciling", "unreachable"] as const;
export type SessionReachability = (typeof SESSION_REACHABILITY)[number];

export interface MachineSummary {
  codexCatalog?: import("./codex-settings.js").CodexCatalog | null;
  machineId: string;
  name: string;
  hostname: string;
  displayAlias: string | null;
  platform: string;
  platformRelease: string;
  architecture: string;
  identityState: "active" | "revoked";
  securityState: "normal" | "degraded_read_only";
  securityReason: string | null;
  reachability: MachineReachability;
  compatibility: MachineCompatibility;
  compatibilityReason: string | null;
  capacity: MachineCapacity;
  unreachableReason: string | null;
  agentVersion: string | null;
  codexVersion: string | null;
  schemaHash: string | null;
  credentialProtectionLevel: "unknown" | "os_keychain" | "software_protected" | "file_restricted";
  lastHeartbeatAt: string | null;
  maintenanceCapabilities: string[];
  discovery: Record<string, unknown> | null;
  codexProfile: Record<string, unknown> | null;
}

export interface CodexCompatibilityProfile {
  profileVersion: string;
  validationStatus: "verified";
  protocol: "codex-app-server-v2";
  minimumCodexVersion: string;
  managedCodexVersion: string;
  schemaHash: string;
  lastValidatedAt: string;
  upgradePolicy: "when-promoted";
}

/** Updated only after the pinned Codex artifact and App Server schema pass CI. */
export const CODEX_COMPATIBILITY_PROFILE: CodexCompatibilityProfile = {
  profileVersion: "codex-v2-2026.09.05",
  validationStatus: "verified",
  protocol: "codex-app-server-v2",
  minimumCodexVersion: "0.153.2",
  managedCodexVersion: "0.154.0",
  schemaHash: "d3eace08be5dca386bfd1f1e8df650058b4113f1e10870a284d775d75517576a",
  lastValidatedAt: "2026-09-05T02:30:00.000Z",
  upgradePolicy: "when-promoted",
};

export interface ProjectSummary {
  projectId: string;
  machineId: string;
  alias: string;
  canonicalRoot: string;
  identityHash: string;
  repoRoot: string | null;
  branch: string | null;
  dirty: boolean | null;
  leaseVersion: number;
  lastReportedAt: string;
  syncContent: boolean;
  retentionDays: 1 | 3 | 7 | 14 | 30;
}

export interface ControlLeaseView {
  /** Relative to the authenticated account, not an individual browser. */
  isMine?: boolean;
  leaseId: string;
  logicalSessionId: string;
  holderClientSessionId: string;
  version: number;
  expiresAt: string;
  state: "active" | "released" | "expired" | "revoked";
}

export interface LogicalSessionSummary {
  recordedTokens?: number | null;
  imageInputSupported?: boolean;
  cloudImageRevision?: number;
  runtimeSettings?: Record<string, unknown> | null;
  logicalSessionId: string;
  machineId: string;
  projectId: string;
  executionSegmentId: string;
  title: string;
  nativeThreadId: string | null;
  historyCompleteness: "complete" | "partial" | "unknown";
  historyMode: "legacy" | "paginated" | "unknown";
  managed: boolean;
  executionState: ExecutionState;
  reachability: SessionReachability;
  threadControlVersion: number;
  turnControlVersion: number;
  projectLeaseVersion: number;
  activeTurnId: string | null;
  projectionEpoch: number;
  latestSessionSeq: number;
  contentEpoch: number;
  controlLeaseVersion: number;
  queueVersion: number;
  controlLease: ControlLeaseView | null;
  updatedAt: string;
  managementRevision: number;
  codexProfileId: string;
  sessionCwd: string | null;
  projectAlias: string;
  canonicalRoot: string;
  actions: SessionActions;
}

export interface ActionAvailability {
  allowed: boolean;
  reasonCode: string | null;
  message: string | null;
}
export type SessionAction = "deletePreview" | "delete" | "read" | "claim" | "release" | "start" | "queue" | "steer" | "cancel" | "approve" | "rename" | "archive" | "unarchive" | "fork" | "compact" | "review" | "inspect" | "stop";
export type SessionActions = Record<SessionAction, ActionAvailability>;

export interface AgentCapabilities {
  paginatedHistory?: boolean;
  permissionProfiles?: boolean;
  commandTypes?: string[];
  methods?: string[];
  maintenanceTypes?: string[];
}

export interface CommandPrecondition {
  executionSegmentId?: string;
  threadControlVersion?: number;
  expectedActiveTurnId?: string | null;
  projectLeaseVersion?: number;
  nativeTurnId?: string;
  nativeThreadId?: string;
  turnControlVersion?: number;
  queueVersion?: number;
  approvalId?: string;
  approvalVersion?: number;
  actionHash?: string;
  appServerEpoch?: string;
}

export interface CreateCommandRequest {
  clientMutationId: string;
  payloadHash?: string;
  controlLeaseId?: string;
  type: CommandType;
  precondition: CommandPrecondition;
  payload: Record<string, unknown>;
  expiresInSeconds?: number;
}

export interface DurableAgentEvent {
  eventId: string;
  payloadHash: string;
  logicalSessionId: string;
  executionSegmentId: string;
  projectId: string;
  producerEpoch: string;
  appServerEpoch?: string;
  hostSeq: number;
  nativeThreadId?: string;
  nativeTurnId?: string;
  nativeItemId?: string;
  type: string;
  schemaVersion: string;
  occurredAt: string;
  payloadState?: "present" | "suppressed" | "deleted";
  contentEpoch?: number;
  payload?: unknown;
}

export interface AgentProjectHello {
  externalId: string;
  alias: string;
  canonicalRoot: string;
  identityHash: string;
  repoRoot?: string | null;
  branch?: string | null;
  dirty?: boolean | null;
  leaseVersion: number;
}

export interface AgentSessionHello {
  nativeUsage?: unknown;
  runtimeSettings?: Record<string, unknown>;
  externalId: string;
  projectExternalId: string;
  executionSegmentExternalId: string;
  title?: string;
  titleSource?: "name" | "preview";
  nativeThreadId?: string | null;
  managed: boolean;
  executionState: ExecutionState;
  threadControlVersion: number;
  turnControlVersion?: number;
  activeTurnId?: string | null;
  historyCompleteness?: "complete" | "partial" | "unknown";
  historyMode?: "legacy" | "paginated";
  contentEpoch?: number;
  managementRevision?: number;
  codexProfileId?: string;
  sessionCwd?: string;
}

export interface AgentResumeStream {
  producerEpoch: string;
  lastProducedHostSeq: number;
  firstRetainedHostSeq?: number;
  lastAckedHostSeq?: number;
}

export interface AgentReconciliationStream {
  producerEpoch: string;
  throughHostSeq: number;
}

export type AgentToServerMessage =
  | {
      type: "hello";
      producerEpoch: string;
      appServerEpoch: string;
      agentVersion: string;
      codexVersion?: string;
      schemaHash?: string;
      capabilities?: AgentCapabilities;
      readOnly?: boolean;
      readOnlyReasons?: string[];
      discovery?: Record<string, unknown>;
      codexProfile?: Record<string, unknown>;
      codexCatalog?: unknown;
      credentialProtectionLevel?: "unknown" | "os_keychain" | "software_protected" | "file_restricted";
      platform: string;
      platformRelease: string;
      architecture: string;
      capacity: MachineCapacity;
      projects: AgentProjectHello[];
      sessions?: AgentSessionHello[];
      resumeStreams?: AgentResumeStream[];
      reconciliationStreams: AgentReconciliationStream[];
    }
  | {
      type: "reconciliation.complete";
      reconciliationId: string;
      reconciliationStreams: AgentReconciliationStream[];
    }
  | {
      type: "heartbeat";
      quota?: unknown;
      readOnly?: boolean;
      readOnlyReasons?: string[];
      codexProfile?: Record<string, unknown>;
      discovery?: Record<string, unknown>;
      capacity: MachineCapacity;
      activeTurns: number;
      unreachableReason?: string | null;
    }
  | { type: "event.append"; event: DurableAgentEvent }
  | {
      type: "volatile";
      eventType: "agent_message.delta" | "command_output.delta" | "turn_diff.delta";
      producerEpoch: string;
      appServerEpoch: string;
      logicalSessionId: string;
      executionSegmentId: string;
      projectId: string;
      nativeThreadId: string;
      nativeTurnId: string;
      nativeItemId?: string;
      payload: Record<string, unknown>;
    }
  | {
      type: "command.ack";
      dispatchAttemptId: string;
      state:
        | "offered"
        | "claimed"
        | "invoking"
        | "responded"
        | "applied"
        | "delivery_failed_before_claim"
        | "invalidated"
        | "unknown";
      detail?: Record<string, unknown>;
    }
  | { type: "maintenance.result"; operationId: string; state: "running" | "succeeded" | "failed"; result?: Record<string, unknown>; error?: {code:string;message:string} }
  | { type: "ping" };

export type ServerToAgentMessage =
  | { type: "welcome"; machineId: string; transportGeneration: number; serverTime: string }
  | {
      type: "hello.ack";
      projects: Record<string, string>;
      sessions: Record<string, string>;
      sessionContentEpochs: Record<string, number>;
      reconciliationId: string;
    }
  | { type: "reconciliation.ack"; reconciliationId: string; serverTime: string }
  | { type: "content.epoch"; logicalSessionId: string; contentEpoch: number }
  | { type: "heartbeat.ack"; serverTime: string }
  | {
      type: "event.ack";
      eventId: string;
      duplicate: boolean;
      projectionEpoch: number;
      sessionSeq: number;
      nextExpectedHostSeq: number;
    }
  | {
      type: "event.nack";
      eventId: string;
      code:
        | "HOST_SEQUENCE_GAP"
        | "SOURCE_STREAM_CORRUPT"
        | "PRODUCER_EPOCH_SEALED"
        | "CONTENT_EPOCH_STALE"
        | "CONTENT_EPOCH_FUTURE"
        | "EVENT_INVALID";
      expectedHostSeq?: number;
      message: string;
    }
  | {
      type: "command.offer";
      dispatchAttemptId: string;
      transportGeneration: number;
      producerEpoch: string;
      appServerEpoch: string;
      command: Record<string, unknown>;
    }
  | { type: "error"; code: string; message: string };

export type ClientToServerMessage =
  | { type: "subscribe"; logicalSessionId: string; lastAppliedSeq?: number; projectionEpoch?: number }
  | { type: "unsubscribe"; logicalSessionId: string }
  | { type: "ping" };

export type ServerToClientMessage =
  | { type: "welcome"; clientSessionId: string; serverTime: string }
  | { type: "snapshot"; session: LogicalSessionSummary; events: unknown[] }
  | { type: "event"; event: unknown }
  | {
      type: "volatile";
      eventType: "agent_message.delta" | "command_output.delta" | "turn_diff.delta";
      logicalSessionId: string;
      nativeTurnId: string;
      nativeItemId?: string;
      payload: Record<string, unknown>;
    }
  | { type: "lease.changed"; logicalSessionId: string; controlLease: ControlLeaseView | null }
  | { type: "queue.changed"; logicalSessionId: string; queue?: unknown[] }
  | { type: "machine.changed"; machine: MachineSummary }
  | { type: "command.changed"; logicalSessionId: string; command: unknown }
  | { type: "content.deleted"; logicalSessionId: string; contentEpoch: number; deletedEvents: number }
  | { type: "pong" }
  | { type: "error"; code: string; message: string };

const stringId = { type: "string", minLength: 1, maxLength: 200 } as const;

export const apiSchemas = {
  login: {
    body: {
      type: "object",
      additionalProperties: false,
      required: ["email", "password"],
      properties: {
        email: { type: "string", minLength: 3, maxLength: 320 },
        password: { type: "string", minLength: 1, maxLength: 1024 },
      },
    },
  },
  createSession: {
    body: {
      type: "object",
      additionalProperties: false,
      required: ["machineId", "projectId"],
      properties: {
        machineId: stringId,
        projectId: stringId,
        title: { type: "string", minLength: 1, maxLength: 200 },
        clientMutationId: { type: "string", minLength: 8, maxLength: 200 },
      },
    },
  },
  command: {
    body: {
      type: "object",
      additionalProperties: false,
      required: ["clientMutationId", "type", "precondition", "payload"],
      properties: {
        clientMutationId: stringId,
        payloadHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
        controlLeaseId: stringId,
        type: { enum: COMMAND_TYPES },
        precondition: { type: "object" },
        payload: { type: "object" },
        expiresInSeconds: { type: "integer", minimum: 1, maximum: 86_400 },
      },
    },
  },
} as const;

/** Exact release/schema pair reviewed against the native adapter regression suite. */
export function validatedCodexSchemaHash(version: string | null): string {
  return version === "0.154.0" ? "f3487938786b729cb6773dbc9e83a7efab9c78c845db7094e8f539f373cbacc9" : CODEX_COMPATIBILITY_PROFILE.schemaHash;
}
