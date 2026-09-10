import type { AllowedCommandType } from "./constants.js";

export type CredentialProtectionLevel =
  | "hardware_bound"
  | "os_protected"
  | "software_protected"
  | "unknown";

export interface IdentityMetadata {
  algorithm: "Ed25519";
  publicKey: string;
  fingerprint: string;
  verificationPhrase: string;
  credentialProtectionLevel: CredentialProtectionLevel;
  createdAt: string;
}

export interface PairingCredential {
  controlPlaneUrl: string;
  machineId: string;
  enrollmentId?: string;
  workspaceId?: string;
  agentToken: string;
  credentialExpiresAt?: string;
  pairedAt: string;
  machineName: string;
  verificationPhrase?: string;
}

export interface ProjectRecord {
  id: string;
  alias: string;
  root: string;
  device: string;
  inode: string;
  identityVersion: number;
  addedAt: string;
  source?: "explicit" | "session_discovery" | "bootstrap_fallback";
}

export type InboxState = "claimed" | "invoking" | "responded" | "applied" | "unknown" | "rejected";

export interface FleetCommand {
  attemptId: string;
  commandId: string;
  type: AllowedCommandType;
  expiresAt: string;
  projectId: string;
  logicalSessionId: string;
  executionSegmentId: string;
  contentEpoch: number;
  sessionExternalId?: string;
  executionSegmentExternalId?: string;
  payload: Record<string, unknown>;
  precondition: Record<string, unknown>;
  transportGeneration?: number;
  appServerEpoch?: string;
}

export interface InboxEntry {
  attemptId: string;
  commandId: string;
  commandType: AllowedCommandType;
  envelopeHash: string;
  state: InboxState;
  receivedAt: string;
  updatedAt: string;
  invokingAt?: string;
  response?: unknown;
  error?: { code: string; message: string };
  replayedFromAttemptId?: string;
}

export interface CommandJournalEntry {
  commandId: string;
  commandType: AllowedCommandType;
  envelopeHash: string;
  canonicalAttemptId: string;
  state: InboxState;
  receivedAt: string;
  updatedAt: string;
  invokingAt?: string;
  response?: unknown;
  error?: { code: string; message: string };
}

export interface ProjectCommandReservation {
  projectId: string;
  commandId: string;
  attemptId: string;
  envelopeHash: string;
  appServerEpoch: string;
  state: "starting" | "unknown";
  createdAt: string;
  updatedAt: string;
}

export interface DurableAgentEvent {
  eventId: string;
  payloadHash: string;
  sourceKind: "agent";
  machineId: string;
  producerEpoch: string;
  appServerEpoch?: string;
  hostSeq: number;
  type: string;
  schemaVersion: "1.0";
  contentEpoch: number;
  occurredAt: string;
  logicalSessionId?: string;
  executionSegmentId?: string;
  projectId?: string;
  nativeThreadId?: string;
  nativeTurnId?: string;
  nativeItemId?: string;
  payloadState?: "present" | "suppressed";
  payload: Record<string, unknown>;
}

export interface ProducerStream {
  lastProducedSeq: number;
  lastAckedSeq: number;
}

export interface ApprovalRecord {
  approvalId: string;
  nativeRequestId: string | number;
  method:
    | "item/permissions/requestApproval"
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "execCommandApproval"
    | "applyPatchApproval"
    | "item/tool/requestUserInput";
  actionHash: string;
  appServerEpoch: string;
  projectId: string;
  nativeThreadId: string;
  nativeTurnId?: string;
  nativeItemId?: string;
  expiresAt: string;
  state: "pending" | "decided" | "invalidated" | "delivery_unknown";
  params: Record<string, unknown>;
  decision?: "accept" | "decline" | "cancel";
  createdAt: string;
  updatedAt: string;
}

export interface ManagedThread {
  nativeUsageDigest?: string;
  usageObservedAt?: string;
  historyPage?: { cursor: string | null; legacyAnchor?: string; complete: boolean };
  /** Fences catalog reads issued before a local metadata mutation. */
  metadataRevision?: number;
  permissionProfile?: import("./permissions.js").PermissionProfile;
  acceptedPermissions?: { profile: import("./permissions.js").PermissionProfile; source: string; acceptedAt: string; nativeTurnId: string };
  titleSource?: "name" | "preview";
  title?: string;
  archived?: boolean;
  observedSettings?: import("./codex-settings.js").CodexObservedSettings;
  acceptedSettings?: import("./codex-settings.js").CodexSettings & { acceptedAt: string; nativeTurnId: string };
  nativeThreadId: string;
  projectId: string;
  logicalSessionId?: string;
  executionSegmentId?: string;
  appServerEpoch: string;
  policyVersion: "remote-restricted-v1";
  policyVerified: boolean;
  contentEpoch: number;
  createdAt: string;
  activeTurnId?: string;
  lastTurnId?: string;
  lastTurnStatus?: string;
  origin?: "agentfleet" | "host_claimed";
  historyMode?: "legacy" | "paginated";
  historySyncInitialized?: boolean;
  historyCursor?: string;
  historyItemCount?: number;
  lastHistoryUpdatedAt?: number;
  subscribed?: boolean;
  sessionCwd?: string;
  codexProfileId?: string;
  managementRevision?: number;
}

export interface DiscoveredThread {
  titleSource?: "name" | "preview";
  externalId: string;
  executionSegmentExternalId: string;
  nativeThreadId: string;
  projectId: string;
  title: string;
  archived: boolean;
  availability: "available" | "unavailable";
  executionState: "idle" | "running" | "completed" | "failed" | "unknown";
  historyCompleteness: "partial" | "unknown";
  historyMode?: "legacy" | "paginated";
  firstSeenAt: string;
  lastSeenAt: string;
  lastReconciledAt: string;
  sessionCwd?: string;
  codexProfileId?: string;
  managementRevision?: number;
}

/** Native identity survives releases, rescans and restarts. */
export interface NativeThreadBinding {
  nativeThreadId: string;
  codexProfileId: string;
  projectId: string;
  logicalSessionId: string;
  executionSegmentId: string;
  managementRevision: number;
  managed: boolean;
  contentEpoch: number;
  sessionCwd?: string;
  title?: string;
}

export type MaintenanceType = "catalog.refresh" | "agent.update" | "runtime.reconnect" | "diagnostics.collect" | "session.reconcile" | "commands.reconcile" | "images.preview" | "images.clean";
export interface MaintenanceOperation {
  recoveryTarget?: Record<string, unknown>;
  commands?: string[];
  operationId: string;
  operationType: MaintenanceType;
  state: "running" | "succeeded" | "failed";
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface ProjectDiscoveryStatus {
  projectId: string;
  appServerEpoch: string;
  state: "healthy" | "unavailable";
  lastAttemptAt: string;
  lastSuccessfulAt?: string;
}

export interface AgentState {
  nativeDeletionTombstones: Record<string,string>;
  schemaVersion: 2;
  identity?: IdentityMetadata;
  pairing?: PairingCredential;
  projects: ProjectRecord[];
  activeProducerEpoch?: string;
  lastTransportGeneration: number;
  producerStreams: Record<string, ProducerStream>;
  inbox: Record<string, InboxEntry>;
  commandJournal: Record<string, CommandJournalEntry>;
  projectReservations: Record<string, ProjectCommandReservation>;
  outbox: DurableAgentEvent[];
  approvals: Record<string, ApprovalRecord>;
  managedThreads: Record<string, ManagedThread>;
  discoveredThreads: Record<string, DiscoveredThread>;
  projectDiscovery: Record<string, ProjectDiscoveryStatus>;
  projectContentPolicies: Record<string, { syncContent: boolean; retentionDays: number }>;
  nativeThreadBindings: Record<string, NativeThreadBinding>;
  maintenanceOperations: Record<string, MaintenanceOperation>;
  maintenanceDrain?: { operationId: string; startedAt: string };
}

export interface HostCheck {
  id: "environment" | "runtime" | "protocol" | "data" | "sandbox" | "tools" | "server" | "catalog";
  state: "passed" | "failed" | "checking" | "skipped";
  code: string;
  message: string;
  checkedAt: string;
  action?: MaintenanceType;
}

export interface SupportReport {
  checks?: HostCheck[];
  supported: boolean;
  writable: boolean;
  readOnlyReasons: string[];
  platform: string;
  architecture: string;
  osId: string;
  osVersion: string;
  uid: number | null;
  nodeVersion: string;
  codexVersion: string | null;
  codexSchemaHash: string | null;
  expectedCodexSchemaHash: string;
  readable?: boolean;
  readCompatibilityReason?: string;
  codexProfile?: {
    id: string;
    osAccount: string;
    codexHome: string;
    hostCodexPath: string | null;
    hostCodexVersion: string | null;
    hostCodexDefaultPath?: string | null;
    hostCodexDefaultVersion?: string | null;
    hostCodexCheckedAt?: string;
    hostCodexDetection?: "highest-detected";
    hostCodexVersionSource?: "command" | "package-record" | null;
    hostCodexMetadataPath?: string | null;
    hostCodexDefaultVersionSource?: "command" | "package-record" | null;
    runtimeUpdateState?: string;
    runtimeUpdateTarget?: string;
    runtimeUpdateError?: string | null;
    runtimePath: string | null;
    runtimeVersion: string | null;
    source: "host" | "managed";
  };
}
