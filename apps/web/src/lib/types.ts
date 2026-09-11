import type { TokenCounts } from "./usage";

export type MachineIdentity = "paired" | "revoked";
export type MachineReachability = "connecting" | "live" | "reconciling" | "unreachable";
export type MachineCompatibility = "compatible" | "degraded_read_only" | "incompatible" | "unknown";
export type MachineCapacity = "unknown" | "idle" | "busy" | "saturated";

export interface Project {
  id: string;
  machineId: string;
  alias: string;
  pathHint: string;
  gitBranch?: string | null;
  gitDirty?: boolean | null;
  identityVersion?: number;
  activeSessionId?: string | null;
  syncContent: boolean;
  retentionDays: 1 | 3 | 7 | 14 | 30;
}

export interface Machine {
  codexCatalog?: import("./codex-settings").CodexCatalog | null;
  id: string;
  name: string;
  hostname: string;
  displayAlias?: string | null;
  os: string;
  arch: string;
  identity: MachineIdentity;
  reachability: MachineReachability;
  compatibility: MachineCompatibility;
  compatibilityReason?: string | null;
  capacity: MachineCapacity;
  unreachableReason?: "sleeping" | "network" | "agent_stopped" | "unknown" | null;
  credentialProtectionLevel: "hardware_bound" | "os_protected" | "software_protected" | "unknown";
  agentVersion: string;
  codexVersion: string;
  schemaHash?: string | null;
  lastSeenAt?: string | null;
  projects: Project[];
  discovery?: DiscoveryProgress;
  maintenanceCapabilities?: string[];
  codexProfile?: Record<string, unknown>;
  updateStatus?: Record<string, unknown>;
}

export interface DiscoveryProgress {
  syncMode?: "events" | "fallback";
  reconcileIntervalSeconds?: number;
  backgroundSync?: boolean;
  readiness?: "ready" | "checking" | "read_only" | "action_required";
  checks?: HostCheck[];
  skippedCount?: number;
  scanId?: string;
  state: "scanning" | "ready" | "error";
  discoveredProjects: number;
  discoveredSessions: number;
  scannedPages: number;
  scannedCount: number;
  lastSuccessfulAt?: string | null;
  error?: string | null;
  errorCode?: string | null;
}

export interface HostCheck {
  id: string;
  state: "passed" | "failed" | "checking" | "skipped";
  code: string;
  message: string;
  checkedAt: string;
  action?: MaintenanceType;
}

export type MaintenanceType = "catalog.refresh" | "agent.update" | "runtime.reconnect" | "diagnostics.collect" | "session.reconcile" | "commands.reconcile" | "images.preview" | "images.clean";
export interface HostOperation {
  id: string;
  type: MaintenanceType;
  state: "accepted" | "running" | "succeeded" | "failed" | "unknown" | "expired";
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  result?: Record<string, unknown> | null;
  error?: { code: string; message: string } | null;
}

export interface CodexCompatibilityProfile {
  profileVersion: string;
  validationStatus: "verified" | "unknown";
  protocol: string;
  minimumCodexVersion: string;
  managedCodexVersion: string;
  schemaHash: string;
  lastValidatedAt: string;
  upgradePolicy: "when-promoted" | "unknown";
}

export interface ControlLease {
  id: string;
  logicalSessionId: string;
  holderClientSessionId: string;
  holderLabel?: string | null;
  version: number;
  expiresAt: string;
  isMine: boolean;
}

export interface SessionState {
  ownership: "agentfleet_owned" | "external_owned" | "claimable" | "unknown";
  threadRuntime: "not_loaded" | "idle" | "active" | "system_error" | "unknown";
  currentTurn: "none" | "in_progress" | "completed" | "interrupted" | "failed" | "unknown";
  waitReason: "none" | "approval" | "user_input";
  reachability: "live" | "reconciling" | "unreachable";
  history: "complete" | "partial" | "summary_only" | "metadata_only" | "unavailable";
  unknownFreeze: boolean;
}

export interface FleetSession {
  recordedTokens?: number | null;
  weeklyTokens?: number | null;
  weeklyBoundaryIncomplete?: boolean;
  imageInputSupported?: boolean;
  cloudImageRevision?: number;
  runtimeSettings?: import("./codex-settings").RuntimeSettings | null;
  id: string;
  title: string;
  machineId: string;
  machineName: string;
  projectId: string;
  projectAlias: string;
  nativeThreadId?: string | null;
  historyMode: "legacy" | "paginated" | "unknown";
  state: SessionState;
  lastActivityAt: string;
  sessionSeq: number;
  projectionEpoch: number;
  contentEpoch: number;
  executionSegmentId: string;
  threadControlVersion: number;
  turnControlVersion: number;
  projectLeaseVersion: number;
  controlLeaseVersion: number;
  queueVersion: number;
  activeTurnId?: string | null;
  controlLease?: ControlLease | null;
  unreadCount?: number;
  actions?: Partial<Record<"deletePreview" | "delete" | "claim" | "release" | "start" | "queue" | "steer" | "cancel" | "read" | "rename" | "archive" | "unarchive" | "fork" | "compact" | "review" | "inspect" | "stop", { allowed: boolean; reasonCode: string | null; message: string | null }>>;
}

export interface CommandReceipt {
  deletionPreview?: {nativeThreadId:string;fingerprint:string;expiresAt:string;threads:{id:string;title:string;cwd:string}[]};
  clientMutationId?: string;
  writerReleased?: boolean;
  inspection?: { observedAt: string; cwd: string; sections: Record<string, { available: boolean; truncated: boolean; errorCode?: string; rows: { name: string; detail: string; status: string }[] }> };
  id: string;
  type: string;
  state: string;
  outcome?: string;
  createdAt: string;
  updatedAt?: string;
  message?: string | null;
  prompt?: string | null;
}

export interface TimelineEvent {
  nativeThreadId?: string;
  nativeTurnId?: string;
  nativeItemId?: string;
  executionSegmentId?: string;
  images?: string[];
  id: string;
  sessionSeq: number;
  type: string;
  occurredAt: string;
  actor?: "user" | "agent" | "system";
  title?: string | null;
  body?: string | null;
  payloadState?: "present" | "suppressed" | "deleted";
  status?: string | null;
  command?: string | null;
  output?: string | null;
  diff?: { additions: number; deletions: number; files: number } | null;
  /** Native cumulative and latest-request counters carried by a usage event. */
  nativeUsage?: { total: TokenCounts; last: TokenCounts };
  /** Per-turn total derived from native cumulative counter increments. */
  turnTokens?: number | null;
  /** Per-turn cached input divided by input tokens. */
  turnCacheHitRate?: number | null;
}

export interface Approval {
  grantScope?: "turn";
  networkTarget?: string;
  additionalPermissions?: string;
  id: string;
  logicalSessionId: string;
  approvalVersion: number;
  type: "command" | "file_change" | "user_input";
  questions?: { id: string; header: string; question: string; options: { label: string; description: string }[] }[];
  status: "pending" | "decided" | "delivery_in_progress" | "delivery_unknown" | "request_resolved" | "completed" | "expired" | "cancelled" | "invalidated";
  machineName: string;
  projectAlias: string;
  cwd: string;
  summary: string;
  command?: string | null;
  paths?: string[];
  risk: "low" | "medium" | "high";
  policyVersion: string;
  actionHash: string;
  appServerEpoch: string;
  expiresAt: string;
}

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  clientSessionId: string;
}

export interface Dashboard {
  activitySessions?: FleetSession[];
  user: CurrentUser;
  machines: Machine[];
  sessions: FleetSession[];
  pendingApprovals: Approval[];
  compatibilityProfile: CodexCompatibilityProfile;
  stats: {
    liveMachines: number;
    runningTurns: number;
    approvals: number;
  };
  serverTime: string;
}

export interface SessionDetail {
  recoverySupported?: boolean;
  commandRecoverySupported?: boolean;
  session: FleetSession;
  events: TimelineEvent[];
  approval?: Approval | null;
  writable: boolean;
  writeBlockedReason?: string | null;
  releaseManagementSupported?: boolean;
  releaseManagementBlockedReason?: string | null;
  queue: QueuedTurn[];
  commands?: CommandReceipt[];
  historyPage?: { nextBeforeSeq: number | null; projectionEpoch: number; contentEpoch: number; throughSeq: number };
}

export interface Page<T> { items: T[]; nextCursor: string | null; }

export interface QueuedTurn {
  id: string;
  commandId: string;
  position: number;
  state: "queued" | "dispatching" | "cancelled" | "expired" | "invalidated" | "applied" | "unknown";
  waitingForHost?: boolean;
  prompt: string;
  createdAt: string;
  expiresAt: string;
  mine: boolean;
}

export type EnrollmentStatus = "pending" | "claimed" | "confirmed" | "redeemed" | "expired" | "cancelled";

export interface Enrollment {
  id: string;
  bootstrapSecret?: string;
  claimUrl?: string;
  status: EnrollmentStatus;
  machineName?: string;
  os?: string;
  arch?: string;
  fingerprint?: string;
  verificationPhrase?: string;
  machineId?: string;
  machineReady?: boolean;
  machineReachability?: "offline" | "connecting" | "online" | "reconnecting";
  projectCount?: number;
  recoveryExpiresAt?: string;
  discovery?: DiscoveryProgress;
  expiresAt: string;
}

export interface ClientSessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string;
  ipHint: string;
  current: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}
export interface CloudImageUsage {
  machineId: string;
  usedBytes: number;
  quotaBytes: number;
  imageCount: number;
  revision: number;
  level: "normal" | "warning" | "full";
  pendingImageCommands: number;
  canClear: boolean;
}

export interface ImageSessionUsage { logicalSessionId: string; title: string; project: string; cloudBytes: number; imageCount: number; }
