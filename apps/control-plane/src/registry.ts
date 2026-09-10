import type { ControlPlaneConfig } from "./config.js";
import { sameLeaseAccount } from "./lease-ownership.js";
import { parseCodexCatalog, parseRuntimeSettings } from "./codex-settings.js";
import { reconcileSessionTitle } from "./session-title.js";
import {
  createUserCode,
  decodeHighEntropyCode,
  deriveEnrollmentAgentToken,
  deriveEnrollmentClaimToken,
  enrollmentProofMessage,
  futureIso,
  newId,
  normalizeEd25519PublicKey,
  normalizeUserCode,
  nowIso,
  pairingProofMessage,
  publicKeyFingerprint,
  randomToken,
  sha256,
  verificationPhrase,
  verifyEd25519,
  wsChallengeMessage,
} from "./crypto.js";
import type { ControlPlaneDatabase } from "./db.js";
import { AppError, invariant } from "./errors.js";
import type {
  AgentProjectHello,
  AgentCapabilities,
  AgentSessionHello,
  ControlLeaseView,
  LogicalSessionSummary,
  MachineCapacity,
  MachineCompatibility,
  MachineSummary,
  ProjectSummary,
} from "./api-schema.js";
import { CODEX_COMPATIBILITY_PROFILE } from "./api-schema.js";
import type { Principal } from "./auth.js";
import { parseCommandCapabilities, sessionActions } from "./capabilities.js";
import { pageCursor, pageLimit, parsePageCursor, type ListOptions } from "./pagination.js";
import { MAINTENANCE_TYPES } from "./maintenance.js";

function parseCodexProfile(input: Record<string, unknown>): Record<string, unknown> {
  const profile: Record<string, unknown> = {};
  const required = ["id", "osAccount", "codexHome", "hostCodexPath", "hostCodexVersion", "runtimePath", "runtimeVersion", "source"];
  for (const key of [...required, "hostCodexDefaultPath", "hostCodexDefaultVersion", "hostCodexCheckedAt", "hostCodexDetection", "hostCodexVersionSource", "hostCodexMetadataPath", "hostCodexDefaultVersionSource", "runtimeUpdateState", "runtimeUpdateTarget", "runtimeUpdateError"]) {
    const value = input[key];
    if (value === undefined && !required.includes(key)) continue;
    invariant(value === null || typeof value === "string", 400, "INVALID_CODEX_PROFILE", `Invalid profile ${key}`);
    invariant(value === null || value.length <= 8192, 400, "INVALID_CODEX_PROFILE", `Profile ${key} exceeds limit`);
    profile[key] = value;
  }
  invariant(profile.source === "host" || profile.source === "managed", 400, "INVALID_CODEX_PROFILE", "Invalid runtime source");
  return profile;
}

interface PairingRow {
  pairing_id: string;
  device_code_hash: string;
  user_code: string;
  public_key_spki: string;
  public_key_fingerprint: string;
  verification_phrase: string;
  proof_challenge: string;
  requested_name: string;
  platform: string;
  platform_release: string;
  architecture: string;
  agent_version: string | null;
  status: "pending" | "confirmed" | "redeemed" | "expired";
  bound_workspace_id: string | null;
  bound_user_id: string | null;
  bound_client_session_id: string | null;
  expires_at: string;
}

type EnrollmentStatus = "created" | "claimed" | "confirmed" | "redeemed" | "expired" | "cancelled";

interface EnrollmentRow {
  enrollment_id: string;
  bootstrap_secret_hash: string;
  claim_token_hash: string | null;
  workspace_id: string;
  user_id: string;
  client_session_id: string;
  public_key_spki: string | null;
  public_key_fingerprint: string | null;
  verification_phrase: string | null;
  proof_challenge: string | null;
  requested_name: string | null;
  platform: string | null;
  platform_release: string | null;
  architecture: string | null;
  agent_version: string | null;
  status: EnrollmentStatus;
  machine_id: string | null;
  credential_id: string | null;
  recovery_expires_at: string | null;
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  confirmed_at: string | null;
  redeemed_at: string | null;
  cancelled_at: string | null;
  preauthorized: number;
  consent_at: string | null;
}

interface EnrollmentCredentialRow {
  credential_id: string;
  token_hash: string;
  credential_expires_at: string;
  revoked_at: string | null;
  machine_id: string;
  workspace_id: string;
  name: string;
  identity_state: "active" | "revoked";
  compatibility: MachineCompatibility;
  compatibility_reason: string | null;
}

interface MachineRow {
  codex_catalog_json: string | null;
  machine_id: string;
  workspace_id: string;
  public_key_spki: string;
  public_key_fingerprint: string;
  name: string;
  display_alias: string | null;
  platform: string;
  platform_release: string;
  architecture: string;
  agent_version: string | null;
  codex_version: string | null;
  schema_hash: string | null;
  credential_protection_level: "unknown" | "os_keychain" | "software_protected" | "file_restricted";
  identity_state: "active" | "revoked";
  security_state: "normal" | "degraded_read_only";
  security_reason: string | null;
  reachability: "offline" | "connecting" | "online" | "reconnecting";
  compatibility: MachineCompatibility;
  compatibility_reason: string | null;
  capacity: MachineCapacity;
  unreachable_reason: string | null;
  last_heartbeat_at: string | null;
  maintenance_types_json: string;
  discovery_json: string | null;
  codex_profile_json: string | null;
}

export interface AgentConnectionIdentity {
  connectionId: string;
  machineId: string;
  workspaceId: string;
  transportGeneration: number;
  publicKey: string;
}

function cleanText(value: unknown, field: string, max = 500): string {
  invariant(typeof value === "string", 400, "INVALID_INPUT", `${field} must be a string`);
  const clean = value.trim();
  invariant(clean.length > 0 && clean.length <= max && !clean.includes("\0"), 400, "INVALID_INPUT", `${field} is invalid`);
  return clean;
}

function parseEnrollmentTicket(ticket: string): { enrollmentId: string; bootstrapSecret: string } {
  const separator = ticket.indexOf(".");
  invariant(separator > 0 && separator === ticket.lastIndexOf("."), 400, "INVALID_ENROLLMENT_TICKET", "Enrollment ticket is invalid");
  const enrollmentId = ticket.slice(0, separator);
  const bootstrapSecret = ticket.slice(separator + 1);
  invariant(/^enroll_[a-f0-9]{32}$/.test(enrollmentId), 400, "INVALID_ENROLLMENT_TICKET", "Enrollment ticket is invalid");
  try {
    decodeHighEntropyCode(bootstrapSecret);
  } catch {
    throw new AppError(400, "INVALID_ENROLLMENT_TICKET", "Enrollment ticket is invalid");
  }
  return { enrollmentId, bootstrapSecret };
}

const MINIMUM_CODEX_VERSION = CODEX_COMPATIBILITY_PROFILE.minimumCodexVersion;
const SUPPORTED_SCHEMA_HASH = CODEX_COMPATIBILITY_PROFILE.schemaHash;
const ENROLLMENT_RECOVERY_TTL_SECONDS = 10 * 60;

function normalizeCodexVersion(value: string | null): string | null {
  if (!value) return null;
  return value.startsWith("codex-cli ") ? value.slice("codex-cli ".length) : value;
}

function normalizeSchemaHash(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase();
  return normalized.startsWith("sha256:") ? normalized.slice("sha256:".length) : normalized;
}

function isSupportedCodexVersion(value: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return false;
  const version = match.slice(1).map((part) => Number.parseInt(part, 10));
  const minimum = MINIMUM_CODEX_VERSION.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < 3; index += 1) {
    if ((version[index] ?? 0) > (minimum[index] ?? 0)) return true;
    if ((version[index] ?? 0) < (minimum[index] ?? 0)) return false;
  }
  return true;
}

function compatibilityFor(
  platform: string,
  release: string,
  architecture: string,
  codexVersion: string | null,
  schemaHash: string | null,
): {
  compatibility: MachineCompatibility;
  reason: string | null;
} {
  const normalizedPlatform = platform.toLowerCase();
  const normalizedArchitecture = architecture.toLowerCase();
  const reasons: string[] = [];
  const x64 = ["x86_64", "x64", "amd64"].includes(normalizedArchitecture);
  const arm64 = ["aarch64", "arm64"].includes(normalizedArchitecture);
  if (normalizedPlatform === "linux" || normalizedPlatform === "ubuntu") {
    if (!x64) reasons.push("Linux write mode currently requires x86_64");
  } else if (normalizedPlatform === "darwin" || normalizedPlatform === "macos") {
    const major = Number.parseInt(release.split(".")[0] ?? "", 10);
    if (!Number.isSafeInteger(major) || major < 13 || (!x64 && !arm64)) reasons.push("macOS write mode requires macOS 13 or newer on x86_64 or Apple Silicon");
  } else if (normalizedPlatform === "win32" || normalizedPlatform === "windows") {
    const build = Number.parseInt(release.split(".")[2] ?? "", 10);
    if (!Number.isSafeInteger(build) || build < 19041 || !x64) reasons.push("Windows write mode requires Windows 10 build 19041 or newer on x86_64");
  } else {
    reasons.push("P0b supports Linux, macOS, and Windows");
  }
  const normalizedCodexVersion = normalizeCodexVersion(codexVersion);
  if (normalizedCodexVersion === null || !isSupportedCodexVersion(normalizedCodexVersion)) {
    reasons.push(codexVersion ? `Codex ${codexVersion} is older than required ${MINIMUM_CODEX_VERSION}` : "Codex version was not reported");
  }
  if (normalizeSchemaHash(schemaHash) !== SUPPORTED_SCHEMA_HASH) {
    reasons.push(schemaHash ? "App Server schema hash does not match the pinned schema" : "App Server schema hash was not reported");
  }
  if (reasons.length === 0) {
    return { compatibility: "compatible", reason: null };
  }
  return {
    compatibility: "incompatible",
    reason: reasons.join("; "),
  };
}

function mapMachine(row: MachineRow): MachineSummary {
  return {
    machineId: row.machine_id,
    name: row.display_alias ?? row.name,
    hostname: row.name,
    displayAlias: row.display_alias,
    platform: row.platform,
    platformRelease: row.platform_release,
    architecture: row.architecture,
    identityState: row.identity_state,
    securityState: row.security_state,
    securityReason: row.security_reason,
    reachability: row.reachability,
    compatibility: row.compatibility,
    compatibilityReason: row.compatibility_reason,
    capacity: row.capacity,
    unreachableReason: row.unreachable_reason,
    agentVersion: row.agent_version,
    codexVersion: row.codex_version,
    schemaHash: row.schema_hash,
    credentialProtectionLevel: row.credential_protection_level,
    lastHeartbeatAt: row.last_heartbeat_at,
    maintenanceCapabilities: JSON.parse(row.maintenance_types_json ?? "[]") as string[],
    discovery: row.discovery_json ? JSON.parse(row.discovery_json) as Record<string,unknown> : null,
    codexProfile: row.codex_profile_json ? JSON.parse(row.codex_profile_json) as Record<string,unknown> : null,
    codexCatalog: row.codex_catalog_json ? parseCodexCatalog(JSON.parse(row.codex_catalog_json)) : null,
  };
}

export class RegistryService {
  constructor(
    private readonly db: ControlPlaneDatabase,
    private readonly config: ControlPlaneConfig,
  ) {}

  createEnrollment(
    principal: Principal,
    ip: string,
    agent: string,
    preauthorized = false,
  ): Record<string, unknown> {
    const enrollmentId = newId("enroll");
    const bootstrapSecret = randomToken(32);
    const createdAt = nowIso();
    const expiresAt = futureIso(this.config.pairTtlSeconds);
    const ipHash = sha256(ip);
    const userAgentHash = sha256(agent);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO enrollment_transactions(
          enrollment_id,bootstrap_secret_hash,workspace_id,user_id,client_session_id,
          status,created_at,expires_at,create_ip_hash
        ) VALUES(?,?,?,?,?,?,?,?,?)`,
        enrollmentId,
        sha256(bootstrapSecret),
        principal.workspaceId,
        principal.userId,
        principal.clientSessionId,
        "created",
        createdAt,
        expiresAt,
        ipHash,
      );
      this.db.run("UPDATE enrollment_transactions SET preauthorized=?,consent_at=? WHERE enrollment_id=?",preauthorized?1:0,preauthorized?createdAt:null,enrollmentId);
      this.db.audit({
        workspaceId: principal.workspaceId,
        actorUserId: principal.userId,
        actorClientSessionId: principal.clientSessionId,
        action: "machine.enrollment.create",
        ipHash,
        userAgentHash,
        metadata: { enrollmentId, expiresAt, preauthorized, consentAt: preauthorized?createdAt:null },
      });
    });
    return {
      enrollmentId,
      bootstrapSecret,
      status: "created",
      preauthorized,
      expiresAt,
    };
  }

  claimEnrollment(input: {
    ticket: string;
    publicKey: string;
    name: string;
    platform: string;
    platformRelease: string;
    architecture: string;
    agentVersion?: string;
    ip: string;
  }): Record<string, unknown> {
    const { enrollmentId, bootstrapSecret } = parseEnrollmentTicket(input.ticket);
    let publicKey: string;
    try {
      publicKey = normalizeEd25519PublicKey(input.publicKey);
    } catch {
      throw new AppError(400, "INVALID_PUBLIC_KEY", "A valid Ed25519 public key is required");
    }
    const requestedName = cleanText(input.name, "name", 120);
    const platform = cleanText(input.platform, "platform", 50);
    const platformRelease = cleanText(input.platformRelease, "platformRelease", 100);
    const architecture = cleanText(input.architecture, "architecture", 50);
    const agentVersion = input.agentVersion ? cleanText(input.agentVersion, "agentVersion", 100) : null;
    const secretHash = sha256(bootstrapSecret);
    const initial = this.db.get<EnrollmentRow>(
      "SELECT * FROM enrollment_transactions WHERE enrollment_id=? AND bootstrap_secret_hash=?",
      enrollmentId,
      secretHash,
    );
    if (!initial) {
      const candidate = this.db.get<EnrollmentRow>(
        "SELECT * FROM enrollment_transactions WHERE enrollment_id=?",
        enrollmentId,
      );
      if (candidate) {
        this.db.audit({
          workspaceId: candidate.workspace_id,
          action: "machine.enrollment.claim",
          outcome: "denied",
          ipHash: sha256(input.ip),
          metadata: { enrollmentId, reason: "invalid_bootstrap_secret" },
        });
      }
      throw new AppError(401, "ENROLLMENT_TICKET_INVALID", "Enrollment ticket is invalid");
    }
    const requestAt = nowIso();
    if (
      initial.status === "expired" ||
      (["created", "claimed", "confirmed"].includes(initial.status) && initial.expires_at <= requestAt)
    ) {
      if (["created", "claimed", "confirmed"].includes(initial.status)) {
        this.db.run(
          "UPDATE enrollment_transactions SET status='expired' WHERE enrollment_id=? AND status IN ('created','claimed','confirmed')",
          enrollmentId,
        );
      }
      throw new AppError(410, "ENROLLMENT_EXPIRED", "Enrollment ticket has expired");
    }
    invariant(initial.status !== "cancelled", 410, "ENROLLMENT_CANCELLED", "Enrollment was cancelled");

    if (["claimed", "confirmed", "redeemed"].includes(initial.status)) {
      if (initial.public_key_spki !== publicKey) {
        this.db.audit({
          workspaceId: initial.workspace_id,
          action: "machine.enrollment.claim",
          outcome: "denied",
          ipHash: sha256(input.ip),
          metadata: {
            enrollmentId,
            reason: "public_key_mismatch",
            suppliedFingerprint: publicKeyFingerprint(publicKey),
            boundFingerprint: initial.public_key_fingerprint,
          },
        });
        throw new AppError(409, "ENROLLMENT_CLAIM_KEY_MISMATCH", "Enrollment is already bound to another machine identity");
      }
      return this.enrollmentClaimResponse(initial, bootstrapSecret, publicKey, requestAt);
    }

    invariant(initial.status === "created", 409, "ENROLLMENT_NOT_CLAIMABLE", "Enrollment is no longer claimable");

    const proofChallenge = randomToken(32);
    const claimToken = deriveEnrollmentClaimToken(bootstrapSecret, enrollmentId, proofChallenge, publicKey);
    const fingerprint = publicKeyFingerprint(publicKey);
    const phrase = verificationPhrase(publicKey, enrollmentId);
    const claimedAt = nowIso();
    const proofMessage = enrollmentProofMessage(enrollmentId, claimToken, proofChallenge);
    const claimOutcome = this.db.transaction((): { response: Record<string, unknown> } | { denied: true } => {
      const changed = this.db.run(
        `UPDATE enrollment_transactions SET
          claim_token_hash=?,public_key_spki=?,public_key_fingerprint=?,verification_phrase=?,
          proof_challenge=?,requested_name=?,platform=?,platform_release=?,architecture=?,
          agent_version=?,status='claimed',claimed_at=?,claim_ip_hash=?
         WHERE enrollment_id=? AND bootstrap_secret_hash=? AND status='created' AND expires_at>?`,
        sha256(claimToken),
        publicKey,
        fingerprint,
        phrase,
        proofChallenge,
        requestedName,
        platform,
        platformRelease,
        architecture,
        agentVersion,
        claimedAt,
        sha256(input.ip),
        enrollmentId,
        secretHash,
        claimedAt,
      );
      if (Number(changed.changes) !== 1) {
        const current = this.db.get<EnrollmentRow>(
          "SELECT * FROM enrollment_transactions WHERE enrollment_id=? AND bootstrap_secret_hash=?",
          enrollmentId,
          secretHash,
        );
        invariant(current, 409, "ENROLLMENT_CLAIM_RACE_LOST", "Enrollment ticket changed concurrently");
        if (["claimed", "confirmed", "redeemed"].includes(current.status)) {
          if (current.public_key_spki !== publicKey) {
            this.db.audit({
              workspaceId: current.workspace_id,
              action: "machine.enrollment.claim",
              outcome: "denied",
              ipHash: sha256(input.ip),
              metadata: {
                enrollmentId,
                reason: "concurrent_public_key_mismatch",
                suppliedFingerprint: fingerprint,
                boundFingerprint: current.public_key_fingerprint,
              },
            });
            return { denied: true };
          }
          return { response: this.enrollmentClaimResponse(current, bootstrapSecret, publicKey, nowIso()) };
        }
        invariant(current.status !== "cancelled", 410, "ENROLLMENT_CANCELLED", "Enrollment was cancelled");
        invariant(current.status !== "expired", 410, "ENROLLMENT_EXPIRED", "Enrollment ticket has expired");
        throw new AppError(409, "ENROLLMENT_CLAIM_RACE_LOST", "Enrollment ticket was claimed concurrently");
      }
      if(initial.preauthorized===1) {
        this.db.run("UPDATE enrollment_transactions SET status='confirmed',confirmed_at=? WHERE enrollment_id=? AND status='claimed'",claimedAt,enrollmentId);
        this.db.audit({workspaceId:initial.workspace_id,actorUserId:initial.user_id,actorClientSessionId:initial.client_session_id,action:"machine.enrollment.preauthorized",metadata:{enrollmentId,consentAt:initial.consent_at,fingerprint}});
      }
      this.db.audit({
        workspaceId: initial.workspace_id,
        action: "machine.enrollment.claim",
        ipHash: sha256(input.ip),
        metadata: { enrollmentId, fingerprint, platform, platformRelease, architecture },
      });
      return {
        response: {
          enrollmentId,
          status: initial.preauthorized===1?"confirmed":"claimed",
          preauthorized: initial.preauthorized===1,
          claimToken,
          proofChallenge,
          proofMessage,
          publicKeyFingerprint: fingerprint,
          verificationPhrase: phrase,
          expiresAt: initial.expires_at,
          recoveryWindowSeconds: ENROLLMENT_RECOVERY_TTL_SECONDS,
        },
      };
    });
    if ("denied" in claimOutcome) {
      throw new AppError(409, "ENROLLMENT_CLAIM_KEY_MISMATCH", "Enrollment was concurrently bound to another machine identity");
    }
    return claimOutcome.response;
  }

  private enrollmentClaimResponse(
    row: EnrollmentRow,
    bootstrapSecret: string,
    publicKey: string,
    recoveredAt: string,
  ): Record<string, unknown> {
    invariant(
      row.status === "claimed" || row.status === "confirmed" || row.status === "redeemed",
      500,
      "ENROLLMENT_STATE_INVALID",
      "Enrollment has not been claimed",
    );
    invariant(row.public_key_spki === publicKey, 409, "ENROLLMENT_CLAIM_KEY_MISMATCH", "Enrollment belongs to another machine identity");
    if (row.status === "redeemed") {
      invariant(
        row.recovery_expires_at && row.recovery_expires_at > recoveredAt,
        410,
        "ENROLLMENT_RECOVERY_EXPIRED",
        "Enrollment recovery window has expired",
      );
    }
    invariant(
      row.proof_challenge && row.claim_token_hash && row.public_key_fingerprint && row.verification_phrase,
      500,
      "ENROLLMENT_STATE_INVALID",
      "Enrollment claim state is incomplete",
    );
    const claimToken = deriveEnrollmentClaimToken(
      bootstrapSecret,
      row.enrollment_id,
      row.proof_challenge,
      publicKey,
    );
    invariant(
      sha256(claimToken) === row.claim_token_hash,
      500,
      "ENROLLMENT_STATE_INVALID",
      "Enrollment claim token does not match persisted state",
    );
    return {
      enrollmentId: row.enrollment_id,
      status: row.status,
      preauthorized: row.preauthorized===1,
      claimToken,
      proofChallenge: row.proof_challenge,
      proofMessage: enrollmentProofMessage(row.enrollment_id, claimToken, row.proof_challenge),
      publicKeyFingerprint: row.public_key_fingerprint,
      verificationPhrase: row.verification_phrase,
      expiresAt: row.status === "redeemed" ? row.recovery_expires_at : row.expires_at,
      recoveryWindowSeconds: ENROLLMENT_RECOVERY_TTL_SECONDS,
    };
  }

  getEnrollment(principal: Principal, enrollmentId: string): Record<string, unknown> {
    const initial = this.requireOwnedEnrollment(principal, enrollmentId);
    let row = initial;
    if (row.expires_at <= nowIso() && ["created", "claimed", "confirmed"].includes(row.status)) {
      this.db.run(
        "UPDATE enrollment_transactions SET status='expired' WHERE enrollment_id=? AND status IN ('created','claimed','confirmed')",
        enrollmentId,
      );
      row = { ...row, status: "expired" };
    }
    const hasMachinePreview = row.public_key_spki !== null;
    const machineState = row.machine_id
      ? this.db.get<{ reachability: string; project_count: number; discovery_json: string | null; runtime_read_only: number; compatibility: string; security_state: string }>(
          `SELECT m.reachability,m.discovery_json,m.runtime_read_only,m.compatibility,m.security_state,
                  (SELECT count(*) FROM projects p WHERE p.machine_id=m.machine_id) AS project_count
           FROM machines m WHERE m.machine_id=? AND m.workspace_id=?`,
          row.machine_id,
          principal.workspaceId,
        )
      : undefined;
    const discovery = machineState?.discovery_json ? JSON.parse(machineState.discovery_json) as Record<string, unknown> : undefined;
    return {
      enrollmentId: row.enrollment_id,
      status: row.status,
      expiresAt: row.expires_at,
      preauthorized: row.preauthorized===1,
      consentAt: row.consent_at,
      createdAt: row.created_at,
      claimedAt: row.claimed_at,
      confirmedAt: row.confirmed_at,
      redeemedAt: row.redeemed_at,
      cancelledAt: row.cancelled_at,
      ...(hasMachinePreview ? {
        pairingId: row.enrollment_id,
        machine: {
          name: row.requested_name,
          platform: row.platform,
          platformRelease: row.platform_release,
          architecture: row.architecture,
          agentVersion: row.agent_version,
        },
        publicKeyFingerprint: row.public_key_fingerprint,
        verificationPhrase: row.verification_phrase,
      } : { machine: null }),
      ...(row.machine_id ? { machineId: row.machine_id } : {}),
      ...(machineState ? {
        machineReady: machineState.reachability === "online" && discovery?.state === "ready" &&
          (discovery.readiness === undefined || discovery.readiness === "ready") &&
          machineState.runtime_read_only === 0 && machineState.compatibility === "compatible" && machineState.security_state === "normal",
        ...(discovery ? { discovery } : {}),
        machineReachability: machineState.reachability,
        projectCount: machineState.project_count,
      } : {}),
      ...(row.recovery_expires_at ? { recoveryExpiresAt: row.recovery_expires_at } : {}),
    };
  }

  confirmEnrollment(
    principal: Principal,
    enrollmentId: string,
    verificationPhraseInput: string,
    ip: string,
    machineName?: string,
  ): Record<string, unknown> {
    const initial = this.requireOwnedEnrollment(principal, enrollmentId, {
      action: "machine.enrollment.confirm",
      ip,
    });
    const requestAt = nowIso();
    if (
      initial.status === "expired" ||
      (["created", "claimed", "confirmed"].includes(initial.status) && initial.expires_at <= requestAt)
    ) {
      if (["created", "claimed", "confirmed"].includes(initial.status)) {
        this.db.run(
          "UPDATE enrollment_transactions SET status='expired' WHERE enrollment_id=? AND status IN ('created','claimed','confirmed')",
          enrollmentId,
        );
      }
      throw new AppError(410, "ENROLLMENT_EXPIRED", "Enrollment ticket has expired");
    }
    invariant(initial.status !== "cancelled", 410, "ENROLLMENT_CANCELLED", "Enrollment was cancelled");
    invariant(
      initial.status === "claimed" || initial.status === "confirmed" || initial.status === "redeemed",
      409,
      "ENROLLMENT_NOT_CLAIMED",
      "Enrollment is not awaiting confirmation",
    );
    if (verificationPhraseInput !== initial.verification_phrase) {
      this.db.audit({
        workspaceId: initial.workspace_id,
        actorUserId: principal.userId,
        actorClientSessionId: principal.clientSessionId,
        action: "machine.enrollment.confirm",
        outcome: "denied",
        ipHash: sha256(ip),
        metadata: { enrollmentId, reason: "verification_mismatch" },
      });
      throw new AppError(400, "VERIFICATION_MISMATCH", "Verification phrase does not match");
    }
    const suppliedName = machineName ? cleanText(machineName, "machineName", 120) : undefined;
    if (initial.status === "confirmed" || initial.status === "redeemed") {
      invariant(
        suppliedName === undefined || suppliedName === initial.requested_name,
        409,
        "ENROLLMENT_CONFIRM_CONFLICT",
        "Enrollment was already confirmed with a different machine name",
      );
      return this.enrollmentConfirmationResponse(initial);
    }
    const name = suppliedName ?? initial.requested_name;
    const confirmedAt = nowIso();
    const ipHash = sha256(ip);
    return this.db.transaction(() => {
      const changed = this.db.run(
        `UPDATE enrollment_transactions SET status='confirmed',confirmed_at=?,confirm_ip_hash=?,requested_name=?
         WHERE enrollment_id=? AND workspace_id=? AND user_id=? AND client_session_id=?
           AND status='claimed' AND expires_at>?`,
        confirmedAt,
        ipHash,
        name,
        enrollmentId,
        principal.workspaceId,
        principal.userId,
        principal.clientSessionId,
        confirmedAt,
      );
      if (Number(changed.changes) !== 1) {
        const current = this.db.get<EnrollmentRow>("SELECT * FROM enrollment_transactions WHERE enrollment_id=?", enrollmentId);
        if (current?.status === "confirmed" || current?.status === "redeemed") {
          invariant(
            current.verification_phrase === verificationPhraseInput &&
              (suppliedName === undefined || suppliedName === current.requested_name),
            409,
            "ENROLLMENT_CONFIRM_CONFLICT",
            "Enrollment was concurrently confirmed with different values",
          );
          return this.enrollmentConfirmationResponse(current);
        }
        invariant(current?.status !== "cancelled", 410, "ENROLLMENT_CANCELLED", "Enrollment was cancelled");
        invariant(current?.status !== "expired", 410, "ENROLLMENT_EXPIRED", "Enrollment ticket has expired");
        throw new AppError(409, "ENROLLMENT_CONFIRM_RACE_LOST", "Enrollment changed concurrently");
      }
      this.db.audit({
        workspaceId: principal.workspaceId,
        actorUserId: principal.userId,
        actorClientSessionId: principal.clientSessionId,
        action: "machine.enrollment.confirm",
        ipHash,
        metadata: { enrollmentId, fingerprint: initial.public_key_fingerprint },
      });
      return {
        enrollmentId,
        status: "confirmed",
        expiresAt: initial.expires_at,
        publicKeyFingerprint: initial.public_key_fingerprint,
        verificationPhrase: initial.verification_phrase,
        machine: {
          name,
          platform: initial.platform,
          platformRelease: initial.platform_release,
          architecture: initial.architecture,
          agentVersion: initial.agent_version,
        },
      };
    });
  }

  private enrollmentConfirmationResponse(row: EnrollmentRow): Record<string, unknown> {
    invariant(
      row.status === "confirmed" || row.status === "redeemed",
      500,
      "ENROLLMENT_STATE_INVALID",
      "Enrollment has not been confirmed",
    );
    return {
      enrollmentId: row.enrollment_id,
      status: row.status,
      expiresAt: row.expires_at,
      publicKeyFingerprint: row.public_key_fingerprint,
      verificationPhrase: row.verification_phrase,
      machine: {
        name: row.requested_name,
        platform: row.platform,
        platformRelease: row.platform_release,
        architecture: row.architecture,
        agentVersion: row.agent_version,
      },
      ...(row.machine_id ? { machineId: row.machine_id } : {}),
      ...(row.recovery_expires_at ? { recoveryExpiresAt: row.recovery_expires_at } : {}),
    };
  }

  cancelEnrollment(principal: Principal, enrollmentId: string, ip: string): Record<string, unknown> {
    const initial = this.requireOwnedEnrollment(principal, enrollmentId);
    if (
      initial.status === "expired" ||
      (["created", "claimed", "confirmed"].includes(initial.status) && initial.expires_at <= nowIso())
    ) {
      if (["created", "claimed", "confirmed"].includes(initial.status)) {
        this.db.run(
          "UPDATE enrollment_transactions SET status='expired' WHERE enrollment_id=? AND status IN ('created','claimed','confirmed')",
          enrollmentId,
        );
      }
      return { enrollmentId, status: "expired", expiresAt: initial.expires_at };
    }
    if (initial.status === "cancelled") return { enrollmentId, status: initial.status, expiresAt: initial.expires_at };
    invariant(initial.status !== "redeemed", 409, "ENROLLMENT_ALREADY_REDEEMED", "Redeemed enrollment cannot be cancelled");
    const cancelledAt = nowIso();
    return this.db.transaction(() => {
      const changed = this.db.run(
        `UPDATE enrollment_transactions SET status='cancelled',cancelled_at=?
         WHERE enrollment_id=? AND workspace_id=? AND user_id=? AND client_session_id=?
           AND status IN ('created','claimed','confirmed')`,
        cancelledAt,
        enrollmentId,
        principal.workspaceId,
        principal.userId,
        principal.clientSessionId,
      );
      invariant(Number(changed.changes) === 1, 409, "ENROLLMENT_CANCEL_RACE_LOST", "Enrollment changed concurrently");
      this.db.audit({
        workspaceId: principal.workspaceId,
        actorUserId: principal.userId,
        actorClientSessionId: principal.clientSessionId,
        action: "machine.enrollment.cancel",
        ipHash: sha256(ip),
        metadata: { enrollmentId },
      });
      return { enrollmentId, status: "cancelled", expiresAt: initial.expires_at };
    });
  }

  exchangeEnrollment(enrollmentId: string, claimToken: string, signature: string, ip: string): Record<string, unknown> {
    invariant(/^enroll_[a-f0-9]{32}$/.test(enrollmentId), 400, "INVALID_ENROLLMENT_ID", "Enrollment id is invalid");
    try {
      decodeHighEntropyCode(claimToken);
    } catch {
      throw new AppError(400, "INVALID_CLAIM_TOKEN", "Claim token is invalid");
    }
    const tokenHash = sha256(claimToken);
    const initial = this.db.get<EnrollmentRow>(
      "SELECT * FROM enrollment_transactions WHERE enrollment_id=? AND claim_token_hash=?",
      enrollmentId,
      tokenHash,
    );
    if (!initial) {
      const candidate = this.db.get<EnrollmentRow>(
        "SELECT * FROM enrollment_transactions WHERE enrollment_id=?",
        enrollmentId,
      );
      if (candidate) {
        this.db.audit({
          workspaceId: candidate.workspace_id,
          action: "machine.enrollment.exchange",
          outcome: "denied",
          ipHash: sha256(ip),
          metadata: { enrollmentId, reason: "invalid_claim_token" },
        });
      }
      throw new AppError(401, "ENROLLMENT_CLAIM_TOKEN_INVALID", "Enrollment claim token is invalid");
    }
    const requestAt = nowIso();
    if (
      initial.status === "expired" ||
      (["created", "claimed", "confirmed"].includes(initial.status) && initial.expires_at <= requestAt)
    ) {
      if (["created", "claimed", "confirmed"].includes(initial.status)) {
        this.db.run(
          "UPDATE enrollment_transactions SET status='expired' WHERE enrollment_id=? AND status IN ('created','claimed','confirmed')",
          enrollmentId,
        );
      }
      throw new AppError(410, "ENROLLMENT_EXPIRED", "Enrollment ticket has expired");
    }
    invariant(initial.status !== "claimed", 409, "ENROLLMENT_NOT_CONFIRMED", "Enrollment is awaiting browser confirmation");
    invariant(initial.status !== "cancelled", 410, "ENROLLMENT_CANCELLED", "Enrollment was cancelled");
    invariant(
      initial.status === "confirmed" || initial.status === "redeemed",
      500,
      "ENROLLMENT_STATE_INVALID",
      "Enrollment is not exchangeable",
    );
    invariant(initial.public_key_spki && initial.proof_challenge, 500, "ENROLLMENT_STATE_INVALID", "Enrollment claim is incomplete");
    const proof = enrollmentProofMessage(enrollmentId, claimToken, initial.proof_challenge);
    if (!verifyEd25519(initial.public_key_spki, proof, signature)) {
      this.db.audit({
        workspaceId: initial.workspace_id,
        action: "machine.enrollment.exchange",
        outcome: "denied",
        ipHash: sha256(ip),
        metadata: { enrollmentId, reason: "invalid_public_key_proof" },
      });
      throw new AppError(401, "ENROLLMENT_PROOF_INVALID", "Public-key proof is invalid");
    }

    return this.db.transaction(() => {
      const row = this.db.get<EnrollmentRow>("SELECT * FROM enrollment_transactions WHERE enrollment_id=?", enrollmentId);
      invariant(row && row.claim_token_hash === tokenHash, 409, "ENROLLMENT_EXCHANGE_RACE_LOST", "Enrollment changed concurrently");
      const transactionAt = nowIso();
      if (row.status === "redeemed") return this.recoverEnrollmentCredential(row, claimToken, transactionAt);
      invariant(row.status !== "cancelled", 410, "ENROLLMENT_CANCELLED", "Enrollment was cancelled");
      invariant(row.status !== "expired" && row.expires_at > transactionAt, 410, "ENROLLMENT_EXPIRED", "Enrollment ticket has expired");
      invariant(row.status !== "claimed", 409, "ENROLLMENT_NOT_CONFIRMED", "Enrollment is awaiting browser confirmation");
      invariant(
        row.status === "confirmed",
        500,
        "ENROLLMENT_STATE_INVALID",
        "Enrollment is not exchangeable",
      );
      invariant(
        row.public_key_spki && row.public_key_fingerprint && row.requested_name && row.platform &&
        row.platform_release && row.architecture && row.proof_challenge,
        500,
        "ENROLLMENT_STATE_INVALID",
        "Enrollment claim is incomplete",
      );
      const priorMachine = this.db.get<{
        machine_id: string;
        identity_state: string;
        reachability: string;
        project_count: number;
        recovery_expires_at: string | null;
      }>(
        `SELECT m.machine_id,m.identity_state,m.reachability,
                (SELECT count(*) FROM projects p WHERE p.machine_id=m.machine_id) AS project_count,
                (SELECT max(e.recovery_expires_at) FROM enrollment_transactions e
                  WHERE e.machine_id=m.machine_id AND e.status='redeemed') AS recovery_expires_at
         FROM machines m WHERE m.workspace_id=? AND m.public_key_spki=?`,
        row.workspace_id,
        row.public_key_spki,
      );
      if (priorMachine) {
        invariant(priorMachine.identity_state === "active", 409, "MACHINE_IDENTITY_REVOKED", "Machine identity was revoked and must be replaced locally");
        invariant(
          priorMachine.reachability === "offline",
          409,
          "MACHINE_IDENTITY_ALREADY_REGISTERED",
          "Machine identity is online; stop the old connection before repairing it",
        );
        invariant(
          priorMachine.recovery_expires_at !== null && priorMachine.recovery_expires_at <= transactionAt,
          409,
          "MACHINE_ENROLLMENT_RECOVERY_ACTIVE",
          "The prior enrollment can still recover its credential; retry that exchange",
        );
      }
      const machineId = priorMachine?.machine_id ?? newId("mach");
      const credentialId = newId("cred");
      const agentToken = deriveEnrollmentAgentToken(claimToken, enrollmentId, row.proof_challenge, machineId);
      const timestamp = transactionAt;
      const credentialExpiresAt = futureIso(60 * 60 * 24 * 90);
      const recoveryExpiresAt = futureIso(ENROLLMENT_RECOVERY_TTL_SECONDS);
      const compatibility = "unknown" as const;
      const compatibilityReason = "Awaiting pinned Codex and schema verification in Agent hello";
      if (priorMachine) {
        const updatedMachine = this.db.run(
          `UPDATE machines SET name=?,platform=?,platform_release=?,architecture=?,agent_version=?,
             compatibility=?,compatibility_reason=?,capacity='unknown',unreachable_reason=NULL,updated_at=?
           WHERE machine_id=? AND identity_state='active' AND reachability='offline'`,
          row.requested_name,
          row.platform,
          row.platform_release,
          row.architecture,
          row.agent_version,
          compatibility,
          compatibilityReason,
          timestamp,
          machineId,
        );
        invariant(Number(updatedMachine.changes) === 1, 409, "MACHINE_IDENTITY_RECOVERY_RACE", "Machine identity changed during credential recovery");
        this.db.run(
          "UPDATE machine_credentials SET revoked_at=? WHERE machine_id=? AND revoked_at IS NULL",
          timestamp,
          machineId,
        );
      } else {
        this.db.run(
          `INSERT INTO machines(
            machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,
            platform_release,architecture,agent_version,compatibility,compatibility_reason,created_at,updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          machineId,
          row.workspace_id,
          row.public_key_spki,
          row.public_key_fingerprint,
          row.requested_name,
          row.platform,
          row.platform_release,
          row.architecture,
          row.agent_version,
          compatibility,
          compatibilityReason,
          timestamp,
          timestamp,
        );
      }
      this.db.run(
        "INSERT INTO machine_credentials(credential_id,machine_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)",
        credentialId,
        machineId,
        sha256(agentToken),
        timestamp,
        credentialExpiresAt,
      );
      const changed = this.db.run(
        `UPDATE enrollment_transactions SET status='redeemed',redeemed_at=?,machine_id=?,credential_id=?,recovery_expires_at=?
         WHERE enrollment_id=? AND status='confirmed' AND claim_token_hash=? AND expires_at>?`,
        timestamp,
        machineId,
        credentialId,
        recoveryExpiresAt,
        enrollmentId,
        tokenHash,
        timestamp,
      );
      invariant(Number(changed.changes) === 1, 409, "ENROLLMENT_EXCHANGE_RACE_LOST", "Enrollment was redeemed concurrently");
      this.db.audit({
        workspaceId: row.workspace_id,
        actorUserId: row.user_id,
        actorClientSessionId: row.client_session_id,
        machineId,
        action: "machine.enrollment.exchange",
        ipHash: sha256(ip),
        metadata: { enrollmentId, compatibility, recoveredExistingIdentity: Boolean(priorMachine) },
      });
      return {
        machineId,
        machineName: row.requested_name,
        workspaceId: row.workspace_id,
        credentialId,
        agentToken,
        credentialExpiresAt,
        recoveryExpiresAt,
        compatibility,
        compatibilityReason,
      };
    });
  }

  private recoverEnrollmentCredential(
    row: EnrollmentRow,
    claimToken: string,
    recoveredAt: string,
  ): Record<string, unknown> {
    invariant(
      row.status === "redeemed" && row.recovery_expires_at && row.recovery_expires_at > recoveredAt,
      410,
      "ENROLLMENT_RECOVERY_EXPIRED",
      "Enrollment recovery window has expired",
    );
    invariant(
      row.machine_id && row.credential_id && row.proof_challenge,
      500,
      "ENROLLMENT_STATE_INVALID",
      "Redeemed enrollment is missing credential recovery state",
    );
    const credential = this.db.get<EnrollmentCredentialRow>(
      `SELECT c.credential_id,c.token_hash,c.expires_at AS credential_expires_at,c.revoked_at,
              m.machine_id,m.workspace_id,m.name,m.identity_state,m.compatibility,m.compatibility_reason
       FROM machine_credentials c JOIN machines m ON m.machine_id=c.machine_id
       WHERE c.credential_id=? AND c.machine_id=?`,
      row.credential_id,
      row.machine_id,
    );
    invariant(credential && credential.workspace_id === row.workspace_id, 500, "ENROLLMENT_STATE_INVALID", "Recovered credential is missing");
    const agentToken = deriveEnrollmentAgentToken(
      claimToken,
      row.enrollment_id,
      row.proof_challenge,
      row.machine_id,
    );
    invariant(credential.token_hash === sha256(agentToken), 500, "ENROLLMENT_STATE_INVALID", "Recovered credential token does not match");
    invariant(
      credential.identity_state === "active" && !credential.revoked_at && credential.credential_expires_at > recoveredAt,
      410,
      "ENROLLMENT_RECOVERY_UNAVAILABLE",
      "Recovered Machine credential is no longer active",
    );
    return {
      machineId: credential.machine_id,
      machineName: credential.name,
      workspaceId: credential.workspace_id,
      credentialId: credential.credential_id,
      agentToken,
      credentialExpiresAt: credential.credential_expires_at,
      recoveryExpiresAt: row.recovery_expires_at,
      compatibility: credential.compatibility,
      compatibilityReason: credential.compatibility_reason,
    };
  }

  private requireOwnedEnrollment(
    principal: Principal,
    enrollmentId: string,
    deniedAudit?: { action: string; ip: string },
  ): EnrollmentRow {
    const row = this.db.get<EnrollmentRow>("SELECT * FROM enrollment_transactions WHERE enrollment_id=?", enrollmentId);
    if (!row || row.workspace_id !== principal.workspaceId || row.user_id !== principal.userId) {
      if (row && deniedAudit) {
        this.db.audit({
          workspaceId: row.workspace_id,
          actorUserId: principal.userId,
          actorClientSessionId: principal.clientSessionId,
          action: deniedAudit.action,
          outcome: "denied",
          ipHash: sha256(deniedAudit.ip),
          metadata: { enrollmentId, reason: "principal_mismatch" },
        });
      }
      throw new AppError(404, "ENROLLMENT_NOT_FOUND", "Enrollment was not found");
    }
    if (row.client_session_id !== principal.clientSessionId) {
      if (deniedAudit) {
        this.db.audit({
          workspaceId: row.workspace_id,
          actorUserId: principal.userId,
          actorClientSessionId: principal.clientSessionId,
          action: deniedAudit.action,
          outcome: "denied",
          ipHash: sha256(deniedAudit.ip),
          metadata: { enrollmentId, reason: "client_session_mismatch" },
        });
      }
      throw new AppError(403, "ENROLLMENT_SESSION_MISMATCH", "Enrollment belongs to a different browser session");
    }
    return row;
  }

  /**
   * Process memory is the authority for live sockets. After a Control Plane
   * restart that map is empty, so persisted online/connecting rows must not
   * continue authorizing writes until a new Agent hello proves reachability.
   */
  reconcileControlPlaneRestart(): { machines: number; sessions: number } {
    return this.db.transaction(() => {
      const machines = this.db.all<{ machine_id: string; workspace_id: string }>(
        `SELECT machine_id,workspace_id FROM machines
         WHERE identity_state='active' AND reachability IN ('online','connecting')`,
      );
      const timestamp = nowIso();
      let reconciledMachines = 0;
      let reconciledSessions = 0;
      for (const machine of machines) {
        const changed = this.db.run(
          `UPDATE machines SET reachability='reconnecting',capacity='unknown',
            unreachable_reason='control_plane_restarted',updated_at=?
           WHERE machine_id=? AND identity_state='active'
             AND reachability IN ('online','connecting')`,
          timestamp,
          machine.machine_id,
        );
        if (Number(changed.changes) !== 1) continue;
        reconciledMachines += 1;
        const sessions = this.db.run(
          `UPDATE logical_sessions SET reachability='reconciling',updated_at=?
           WHERE machine_id=? AND reachability='live'`,
          timestamp,
          machine.machine_id,
        );
        reconciledSessions += Number(sessions.changes);
        this.db.audit({
          workspaceId: machine.workspace_id,
          machineId: machine.machine_id,
          action: "machine.control_plane_restart",
          outcome: "reconciling",
          metadata: { previousReachability: "online_or_connecting" },
        });
      }
      return { machines: reconciledMachines, sessions: reconciledSessions };
    });
  }

  initPairing(input: {
    deviceCode: string;
    publicKey: string;
    name: string;
    platform: string;
    platformRelease: string;
    architecture: string;
    agentVersion?: string;
    ip: string;
  }): Record<string, unknown> {
    decodeHighEntropyCode(input.deviceCode);
    let publicKey: string;
    try {
      publicKey = normalizeEd25519PublicKey(input.publicKey);
    } catch {
      throw new AppError(400, "INVALID_PUBLIC_KEY", "A valid Ed25519 public key is required");
    }
    const pairingId = newId("pair");
    const fingerprint = publicKeyFingerprint(publicKey);
    const phrase = verificationPhrase(publicKey, pairingId);
    const proofChallenge = randomToken(32);
    const createdAt = nowIso();
    const expiresAt = futureIso(this.config.pairTtlSeconds);
    const requestedName = cleanText(input.name, "name", 120);
    const platform = cleanText(input.platform, "platform", 50);
    const platformRelease = cleanText(input.platformRelease, "platformRelease", 100);
    const architecture = cleanText(input.architecture, "architecture", 50);
    const agentVersion = input.agentVersion ? cleanText(input.agentVersion, "agentVersion", 100) : null;

    let userCode = "";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      userCode = createUserCode();
      const exists = this.db.get("SELECT 1 FROM pairing_transactions WHERE user_code=?", userCode);
      if (!exists) break;
    }
    invariant(userCode, 503, "PAIRING_CODE_UNAVAILABLE", "Could not allocate a pairing code");

    try {
      this.db.run(
        `INSERT INTO pairing_transactions(
          pairing_id,device_code_hash,user_code,public_key_spki,public_key_fingerprint,
          verification_phrase,proof_challenge,requested_name,platform,platform_release,
          architecture,agent_version,status,created_at,expires_at,init_ip_hash
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        pairingId,
        sha256(input.deviceCode),
        userCode,
        publicKey,
        fingerprint,
        phrase,
        proofChallenge,
        requestedName,
        platform,
        platformRelease,
        architecture,
        agentVersion,
        "pending",
        createdAt,
        expiresAt,
        sha256(input.ip),
      );
    } catch (error) {
      if (String(error).includes("device_code_hash")) {
        throw new AppError(409, "DEVICE_CODE_REUSE", "deviceCode has already been used");
      }
      throw error;
    }
    return {
      pairingId,
      userCode,
      expiresAt,
      proofChallenge,
      publicKeyFingerprint: fingerprint,
      verificationPhrase: phrase,
      verificationUrl: `${this.config.publicOrigin}/pair?code=${encodeURIComponent(userCode)}`,
      proofMessage: pairingProofMessage(pairingId, input.deviceCode, proofChallenge),
    };
  }

  pairingPreview(principal: Principal, userCodeInput: string): Record<string, unknown> {
    const userCode = normalizeUserCode(userCodeInput);
    const row = this.db.get<PairingRow>("SELECT * FROM pairing_transactions WHERE user_code=?", userCode);
    invariant(row && row.status === "pending" && row.expires_at > nowIso(), 404, "PAIRING_NOT_FOUND", "Pairing is missing or expired");
    return {
      pairingId: row.pairing_id,
      userCode: row.user_code,
      machine: {
        name: row.requested_name,
        platform: row.platform,
        platformRelease: row.platform_release,
        architecture: row.architecture,
        agentVersion: row.agent_version,
      },
      publicKeyFingerprint: row.public_key_fingerprint,
      verificationPhrase: row.verification_phrase,
      expiresAt: row.expires_at,
      requestedByClientSessionId: principal.clientSessionId,
    };
  }

  confirmPairing(
    principal: Principal,
    pairingIdentifier: string,
    verificationPhraseInput: string,
    ip: string,
    machineName?: string,
  ): Record<string, unknown> {
    const isPairingId = pairingIdentifier.startsWith("pair_");
    const userCode = isPairingId ? null : normalizeUserCode(pairingIdentifier);
    return this.db.transaction(() => {
      const row = isPairingId
        ? this.db.get<PairingRow>("SELECT * FROM pairing_transactions WHERE pairing_id=?", pairingIdentifier)
        : this.db.get<PairingRow>("SELECT * FROM pairing_transactions WHERE user_code=?", userCode as string);
      invariant(row, 404, "PAIRING_NOT_FOUND", "Pairing was not found");
      invariant(row.status === "pending", 409, "PAIRING_NOT_PENDING", "Pairing is no longer pending");
      invariant(row.expires_at > nowIso(), 410, "PAIRING_EXPIRED", "Pairing has expired");
      invariant(
        verificationPhraseInput === row.verification_phrase,
        400,
        "VERIFICATION_MISMATCH",
        "Verification phrase does not match",
      );
      const confirmedAt = nowIso();
      const name = machineName ? cleanText(machineName, "machineName", 120) : row.requested_name;
      const result = this.db.run(
        `UPDATE pairing_transactions SET status='confirmed',bound_workspace_id=?,bound_user_id=?,
          bound_client_session_id=?,confirmed_at=?,confirm_ip_hash=?,requested_name=?
         WHERE pairing_id=? AND status='pending' AND expires_at>?`,
        principal.workspaceId,
        principal.userId,
        principal.clientSessionId,
        confirmedAt,
        sha256(ip),
        name,
        row.pairing_id,
        confirmedAt,
      );
      invariant(Number(result.changes) === 1, 409, "PAIRING_RACE_LOST", "Pairing was changed concurrently");
      this.db.audit({
        workspaceId: principal.workspaceId,
        actorUserId: principal.userId,
        actorClientSessionId: principal.clientSessionId,
        action: "machine.pair.confirm",
        ipHash: sha256(ip),
        metadata: { pairingId: row.pairing_id, fingerprint: row.public_key_fingerprint },
      });
      return {
        pairingId: row.pairing_id,
        status: "confirmed",
        expiresAt: row.expires_at,
        publicKeyFingerprint: row.public_key_fingerprint,
        verificationPhrase: row.verification_phrase,
      };
    });
  }

  exchangePairing(deviceCode: string, signature: string): Record<string, unknown> {
    decodeHighEntropyCode(deviceCode);
    const codeHash = sha256(deviceCode);
    const initial = this.db.get<PairingRow>("SELECT * FROM pairing_transactions WHERE device_code_hash=?", codeHash);
    invariant(initial, 404, "PAIRING_NOT_FOUND", "Pairing was not found");
    invariant(initial.status === "confirmed", 409, "PAIRING_NOT_CONFIRMED", "Pairing is not confirmed or was already redeemed");
    invariant(initial.expires_at > nowIso(), 410, "PAIRING_EXPIRED", "Pairing has expired");
    const proof = pairingProofMessage(initial.pairing_id, deviceCode, initial.proof_challenge);
    invariant(verifyEd25519(initial.public_key_spki, proof, signature), 401, "PAIRING_PROOF_INVALID", "Public-key proof is invalid");

    return this.db.transaction(() => {
      const row = this.db.get<PairingRow>("SELECT * FROM pairing_transactions WHERE pairing_id=?", initial.pairing_id);
      invariant(row?.status === "confirmed" && row.expires_at > nowIso(), 409, "PAIRING_RACE_LOST", "Pairing was already redeemed or expired");
      invariant(row.bound_workspace_id && row.bound_user_id && row.bound_client_session_id, 409, "PAIRING_BINDING_MISSING", "Pairing is not bound to a user session");
      const machineId = newId("mach");
      const credentialId = newId("cred");
      const agentToken = randomToken(32);
      const timestamp = nowIso();
      const credentialExpiresAt = futureIso(60 * 60 * 24 * 90);
      const platformResult = {
        compatibility: "unknown" as const,
        reason: "Awaiting pinned Codex and schema verification in Agent hello",
      };
      this.db.run(
        `INSERT INTO machines(
          machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,
          platform_release,architecture,agent_version,compatibility,compatibility_reason,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        machineId,
        row.bound_workspace_id,
        row.public_key_spki,
        row.public_key_fingerprint,
        row.requested_name,
        row.platform,
        row.platform_release,
        row.architecture,
        row.agent_version,
        platformResult.compatibility,
        platformResult.reason,
        timestamp,
        timestamp,
      );
      this.db.run(
        "INSERT INTO machine_credentials(credential_id,machine_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)",
        credentialId,
        machineId,
        sha256(agentToken),
        timestamp,
        credentialExpiresAt,
      );
      const changed = this.db.run(
        "UPDATE pairing_transactions SET status='redeemed',redeemed_at=? WHERE pairing_id=? AND status='confirmed'",
        timestamp,
        row.pairing_id,
      );
      invariant(Number(changed.changes) === 1, 409, "PAIRING_RACE_LOST", "Pairing was redeemed concurrently");
      this.db.audit({
        workspaceId: row.bound_workspace_id,
        actorUserId: row.bound_user_id,
        actorClientSessionId: row.bound_client_session_id,
        machineId,
        action: "machine.pair.exchange",
        metadata: { pairingId: row.pairing_id, compatibility: platformResult.compatibility },
      });
      return {
        machineId,
        credentialId,
        agentToken,
        credentialExpiresAt,
        compatibility: platformResult.compatibility,
        compatibilityReason: platformResult.reason,
      };
    });
  }

  createChallenge(
    machineId: string,
    agentToken: string,
    transportGeneration: number,
  ): Record<string, unknown> {
    invariant(Number.isSafeInteger(transportGeneration) && transportGeneration > 0, 400, "INVALID_GENERATION", "transportGeneration must be a positive integer");
    const credential = this.db.get<{
      credential_id: string;
      expires_at: string;
      revoked_at: string | null;
      identity_state: string;
      public_key_spki: string;
    }>(
      `SELECT c.credential_id,c.expires_at,c.revoked_at,m.identity_state,m.public_key_spki
       FROM machine_credentials c JOIN machines m ON m.machine_id=c.machine_id
       WHERE c.machine_id=? AND c.token_hash=?`,
      machineId,
      sha256(agentToken),
    );
    invariant(
      credential && !credential.revoked_at && credential.expires_at > nowIso() && credential.identity_state === "active",
      401,
      "AGENT_CREDENTIAL_INVALID",
      "Agent credential is invalid",
    );
    const latest = this.db.get<{ generation: number | null }>(
      "SELECT MAX(transport_generation) AS generation FROM agent_connections WHERE machine_id=?",
      machineId,
    );
    const latestGeneration = latest?.generation ?? null;
    invariant(
      latestGeneration === null || transportGeneration > latestGeneration,
      409,
      "STALE_TRANSPORT_GENERATION",
      "transportGeneration must be greater than every prior connection",
      { latestGeneration: latestGeneration ?? 0 },
    );
    const challengeId = newId("chal");
    const nonce = randomToken(32);
    const audience = "agent-ws";
    const createdAt = nowIso();
    const expiresAt = futureIso(this.config.challengeTtlSeconds);
    this.db.run(
      `INSERT INTO agent_challenges(
        challenge_id,machine_id,credential_id,nonce,audience,transport_generation,created_at,expires_at
      ) VALUES(?,?,?,?,?,?,?,?)`,
      challengeId,
      machineId,
      credential.credential_id,
      nonce,
      audience,
      transportGeneration,
      createdAt,
      expiresAt,
    );
    return {
      challengeId,
      nonce,
      audience,
      machineId,
      transportGeneration,
      expiresAt,
      message: wsChallengeMessage(challengeId, machineId, nonce, audience, transportGeneration),
    };
  }

  exchangeChallenge(input: {
    machineId: string;
    challengeId: string;
    transportGeneration: number;
    signature: string;
  }): Record<string, unknown> {
    const challenge = this.db.get<{
      challenge_id: string;
      machine_id: string;
      nonce: string;
      audience: string;
      transport_generation: number;
      expires_at: string;
      consumed_at: string | null;
      public_key_spki: string;
      identity_state: string;
    }>(
      `SELECT c.*,m.public_key_spki,m.identity_state FROM agent_challenges c
       JOIN machines m ON m.machine_id=c.machine_id WHERE c.challenge_id=? AND c.machine_id=?`,
      input.challengeId,
      input.machineId,
    );
    invariant(challenge && challenge.identity_state === "active", 401, "CHALLENGE_INVALID", "Challenge is invalid");
    invariant(!challenge.consumed_at && challenge.expires_at > nowIso(), 401, "CHALLENGE_EXPIRED", "Challenge is expired or consumed");
    invariant(challenge.transport_generation === input.transportGeneration, 401, "CHALLENGE_BINDING_MISMATCH", "Challenge generation does not match");
    const message = wsChallengeMessage(
      challenge.challenge_id,
      challenge.machine_id,
      challenge.nonce,
      challenge.audience,
      challenge.transport_generation,
    );
    invariant(verifyEd25519(challenge.public_key_spki, message, input.signature), 401, "AGENT_SIGNATURE_INVALID", "Agent signature is invalid");

    return this.db.transaction(() => {
      const timestamp = nowIso();
      const consumed = this.db.run(
        "UPDATE agent_challenges SET consumed_at=? WHERE challenge_id=? AND consumed_at IS NULL AND expires_at>?",
        timestamp,
        input.challengeId,
        timestamp,
      );
      invariant(Number(consumed.changes) === 1, 409, "CHALLENGE_RACE_LOST", "Challenge was consumed concurrently");
      const ticket = randomToken(32);
      const ticketId = newId("ticket");
      const expiresAt = futureIso(this.config.ticketTtlSeconds);
      this.db.run(
        `INSERT INTO agent_tickets(ticket_id,machine_id,token_hash,audience,transport_generation,created_at,expires_at)
         VALUES(?,?,?,?,?,?,?)`,
        ticketId,
        input.machineId,
        sha256(ticket),
        challenge.audience,
        input.transportGeneration,
        timestamp,
        expiresAt,
      );
      return { ticket, expiresAt, audience: challenge.audience, transportGeneration: input.transportGeneration };
    });
  }

  consumeAgentTicket(ticket: string): AgentConnectionIdentity {
    return this.db.transaction(() => {
      const row = this.db.get<{
        ticket_id: string;
        machine_id: string;
        transport_generation: number;
        expires_at: string;
        consumed_at: string | null;
        workspace_id: string;
        public_key_spki: string;
        identity_state: string;
      }>(
        `SELECT t.*,m.workspace_id,m.public_key_spki,m.identity_state FROM agent_tickets t
         JOIN machines m ON m.machine_id=t.machine_id WHERE t.token_hash=? AND t.audience='agent-ws'`,
        sha256(ticket),
      );
      const timestamp = nowIso();
      invariant(row && row.identity_state === "active" && !row.consumed_at && row.expires_at > timestamp, 401, "WS_TICKET_INVALID", "WebSocket ticket is invalid");
      const consumed = this.db.run(
        "UPDATE agent_tickets SET consumed_at=? WHERE ticket_id=? AND consumed_at IS NULL AND expires_at>?",
        timestamp,
        row.ticket_id,
        timestamp,
      );
      invariant(Number(consumed.changes) === 1, 409, "WS_TICKET_RACE_LOST", "WebSocket ticket was consumed concurrently");
      const connectionId = newId("conn");
      try {
        this.db.run(
          `UPDATE agent_connections SET disconnected_at=?,close_reason='superseded'
           WHERE machine_id=? AND disconnected_at IS NULL AND transport_generation<?`,
          timestamp,
          row.machine_id,
          row.transport_generation,
        );
        this.db.run(
          `INSERT INTO agent_connections(connection_id,machine_id,transport_generation,connected_at)
           VALUES(?,?,?,?)`,
          connectionId,
          row.machine_id,
          row.transport_generation,
          timestamp,
        );
      } catch {
        throw new AppError(409, "STALE_TRANSPORT_GENERATION", "transportGeneration has already been used");
      }
      this.db.run(
        `UPDATE machines SET reachability='connecting',unreachable_reason=NULL,last_connected_at=?,updated_at=?
         WHERE machine_id=?`,
        timestamp,
        timestamp,
        row.machine_id,
      );
      this.db.run(
        "UPDATE logical_sessions SET reachability='reconciling',updated_at=? WHERE machine_id=?",
        timestamp,
        row.machine_id,
      );
      return {
        connectionId,
        machineId: row.machine_id,
        workspaceId: row.workspace_id,
        transportGeneration: row.transport_generation,
        publicKey: row.public_key_spki,
      };
    });
  }

  registerHello(
    connection: AgentConnectionIdentity,
    hello: {
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
      resumeStreams?: Array<{
        producerEpoch: string;
        lastProducedHostSeq: number;
        firstRetainedHostSeq?: number;
        lastAckedHostSeq?: number;
      }>;
      reconciliationStreams: Array<{
        producerEpoch: string;
        throughHostSeq: number;
      }>;
    },
  ): {
    projects: Record<string, string>;
    sessions: Record<string, string>;
    sessionContentEpochs: Record<string, number>;
    projectContentPolicies: Record<string, { syncContent: boolean; retentionDays: number }>;
    reconciliationId: string;
  } {
    const timestamp = nowIso();
    // Receipt of any new hello immediately withdraws prior replay grants and
    // freezes reachability, even if the rest of that hello is malformed. This
    // prevents an invalid re-hello from leaving HTTP command admission open.
    this.db.transaction(() => {
      const currentConnection = this.db.get<{ disconnected_at: string | null }>(
        "SELECT disconnected_at FROM agent_connections WHERE connection_id=? AND machine_id=?",
        connection.connectionId,
        connection.machineId,
      );
      invariant(currentConnection && !currentConnection.disconnected_at, 409, "CONNECTION_FENCED", "Agent connection is no longer current");
      this.db.run(
        "UPDATE agent_connections SET producer_epoch=NULL,app_server_epoch=NULL,hello_at=NULL WHERE connection_id=?",
        connection.connectionId,
      );
      this.db.run(
        `UPDATE producer_streams SET resume_through_host_seq=NULL,resume_connection_id=NULL,updated_at=?
         WHERE machine_id=?`,
        timestamp,
        connection.machineId,
      );
      this.db.run("DELETE FROM reconciliation_cycles WHERE connection_id=?", connection.connectionId);
      this.db.run(
        `UPDATE machines SET reachability=CASE WHEN reachability='connecting' THEN 'connecting' ELSE 'reconnecting' END,
          capacity='unknown',unreachable_reason='reconciliation_pending',updated_at=?
         WHERE machine_id=? AND identity_state='active'`,
        timestamp,
        connection.machineId,
      );
      this.db.run(
        "UPDATE logical_sessions SET reachability='reconciling',updated_at=? WHERE machine_id=?",
        timestamp,
        connection.machineId,
      );
    });
    const producerEpoch = cleanText(hello.producerEpoch, "producerEpoch", 200);
    const appServerEpoch = cleanText(hello.appServerEpoch, "appServerEpoch", 200);
    const platform = cleanText(hello.platform, "platform", 50);
    const platformRelease = cleanText(hello.platformRelease, "platformRelease", 100);
    const architecture = cleanText(hello.architecture, "architecture", 50);
    const agentVersion = cleanText(hello.agentVersion, "agentVersion", 100);
    invariant(hello.readOnly === undefined || typeof hello.readOnly === "boolean", 400, "INVALID_RUNTIME_STATE", "readOnly must be boolean");
    invariant(hello.readOnlyReasons === undefined || (Array.isArray(hello.readOnlyReasons) && hello.readOnlyReasons.length <= 32 && hello.readOnlyReasons.every((reason) => typeof reason === "string" && reason.length <= 2000)), 400, "INVALID_RUNTIME_STATE", "readOnlyReasons is invalid");
    const commandTypes = hello.capabilities?.commandTypes;
    invariant(commandTypes === undefined || (Array.isArray(commandTypes) && commandTypes.length <= 64 && commandTypes.every((entry) => typeof entry === "string")), 400, "INVALID_CAPABILITIES", "commandTypes must be an array of strings");
    const commandTypesJson = parseCommandCapabilities(commandTypes);
    invariant(hello.capabilities?.paginatedHistory === undefined || typeof hello.capabilities.paginatedHistory === "boolean", 400, "INVALID_CAPABILITIES", "paginatedHistory must be boolean");
    invariant(hello.capabilities?.permissionProfiles === undefined || typeof hello.capabilities.permissionProfiles === "boolean", 400, "INVALID_CAPABILITIES", "permissionProfiles must be boolean");
    const maintenanceTypes=hello.capabilities?.maintenanceTypes;
    invariant(maintenanceTypes===undefined||(Array.isArray(maintenanceTypes)&&maintenanceTypes.length<=32&&maintenanceTypes.every(entry=>typeof entry==="string")),400,"INVALID_CAPABILITIES","maintenanceTypes must be an array of strings");
    const reportedCodexVersion = hello.codexVersion ? cleanText(hello.codexVersion, "codexVersion", 100) : null;
    const reportedSchemaHash = hello.schemaHash ? cleanText(hello.schemaHash, "schemaHash", 200) : null;
    const codexVersion = normalizeCodexVersion(reportedCodexVersion);
    const normalizedSchemaHash = normalizeSchemaHash(reportedSchemaHash);
    const schemaHash = normalizedSchemaHash ? `sha256:${normalizedSchemaHash}` : null;
    const credentialProtectionLevel = hello.credentialProtectionLevel ?? "unknown";
    invariant(
      ["unknown", "os_keychain", "software_protected", "file_restricted"].includes(credentialProtectionLevel),
      400,
      "INVALID_CREDENTIAL_PROTECTION",
      "Invalid credentialProtectionLevel",
    );
    invariant(["unknown", "idle", "busy", "saturated"].includes(hello.capacity), 400, "INVALID_CAPACITY", "Invalid capacity state");
    invariant(Array.isArray(hello.projects) && hello.projects.length <= 500, 400, "INVALID_PROJECTS", "projects must be an array of at most 500 entries");
    invariant(!hello.sessions || (Array.isArray(hello.sessions) && hello.sessions.length <= 10000), 400, "INVALID_SESSIONS", "sessions must be an array of at most 10000 entries");
    invariant(!hello.resumeStreams || (Array.isArray(hello.resumeStreams) && hello.resumeStreams.length <= 32), 400, "INVALID_RESUME_STREAMS", "resumeStreams must contain at most 32 entries");
    invariant(
      Array.isArray(hello.reconciliationStreams) && hello.reconciliationStreams.length >= 1 && hello.reconciliationStreams.length <= 32,
      400,
      "INVALID_RECONCILIATION_STREAMS",
      "reconciliationStreams must contain between 1 and 32 entries",
    );
    const compatibility = compatibilityFor(
      platform,
      platformRelease,
      architecture,
      reportedCodexVersion,
      reportedSchemaHash,
    );
    const projectMap: Record<string, string> = {};
    const sessionMap: Record<string, string> = {};
    const sessionContentEpochs: Record<string, number> = {};
    const projectContentPolicies: Record<string, { syncContent: boolean; retentionDays: number }> = {};
    const reconciliationId = newId("recon");
    const reconciliationStreams = new Map<string, number>();
    for (const watermark of hello.reconciliationStreams) {
      const epoch = cleanText(watermark.producerEpoch, "reconciliationStream.producerEpoch", 200);
      invariant(!reconciliationStreams.has(epoch), 400, "INVALID_RECONCILIATION_STREAM", "reconciliationStreams must contain unique producer epochs");
      invariant(Number.isSafeInteger(watermark.throughHostSeq) && watermark.throughHostSeq >= 0, 400, "INVALID_RECONCILIATION_STREAM", "throughHostSeq must be non-negative");
      reconciliationStreams.set(epoch, watermark.throughHostSeq);
    }
    invariant(
      reconciliationStreams.has(producerEpoch),
      400,
      "CURRENT_RECONCILIATION_STREAM_REQUIRED",
      "reconciliationStreams must contain the current producer epoch",
    );
    const resumeStreams = new Map<string, NonNullable<typeof hello.resumeStreams>[number]>();
    for (const resume of hello.resumeStreams ?? []) {
      const epoch = cleanText(resume.producerEpoch, "resumeStream.producerEpoch", 200);
      invariant(epoch !== producerEpoch && !resumeStreams.has(epoch), 400, "INVALID_RESUME_STREAM", "resumeStreams must contain unique old producer epochs");
      invariant(reconciliationStreams.has(epoch), 400, "INVALID_RESUME_STREAM", "resumeStreams must be present in reconciliationStreams");
      invariant(Number.isSafeInteger(resume.lastProducedHostSeq) && resume.lastProducedHostSeq >= 0, 400, "INVALID_RESUME_STREAM", "lastProducedHostSeq must be non-negative");
      invariant(Number.isSafeInteger(resume.lastAckedHostSeq) && Number(resume.lastAckedHostSeq) >= 0, 400, "INVALID_RESUME_STREAM", "lastAckedHostSeq must be non-negative");
      invariant(Number.isSafeInteger(resume.firstRetainedHostSeq) && Number(resume.firstRetainedHostSeq) >= 1, 400, "INVALID_RESUME_STREAM", "firstRetainedHostSeq must be positive");
      invariant(
        resume.lastAckedHostSeq! <= resume.lastProducedHostSeq && resume.firstRetainedHostSeq! <= resume.lastProducedHostSeq,
        409,
        "RESUME_METADATA_INVALID",
        "Resume acknowledgement/retention metadata is inconsistent",
      );
      invariant(
        reconciliationStreams.get(epoch) === resume.lastProducedHostSeq,
        409,
        "RECONCILIATION_TARGET_MISMATCH",
        "resumeStreams and reconciliationStreams disagree on the producer watermark",
      );
      resumeStreams.set(epoch, resume);
    }

    this.db.transaction(() => {
      const currentConnection = this.db.get<{ disconnected_at: string | null }>(
        "SELECT disconnected_at FROM agent_connections WHERE connection_id=? AND machine_id=?",
        connection.connectionId,
        connection.machineId,
      );
      invariant(currentConnection && !currentConnection.disconnected_at, 409, "CONNECTION_FENCED", "Agent connection is no longer current");
      const machineEpoch = this.db.get<{ current_producer_epoch: string | null }>(
        "SELECT current_producer_epoch FROM machines WHERE machine_id=? AND identity_state='active'",
        connection.machineId,
      );
      invariant(machineEpoch, 409, "MACHINE_REVOKED", "Machine is revoked or missing");
      if (machineEpoch.current_producer_epoch && machineEpoch.current_producer_epoch !== producerEpoch) {
        const priorUse = this.db.get(
          "SELECT 1 FROM producer_streams WHERE machine_id=? AND producer_epoch=?",
          connection.machineId,
          producerEpoch,
        );
        invariant(!priorUse, 409, "PRODUCER_EPOCH_ROLLBACK", "A sealed producerEpoch cannot become current again");
      }
      // A watermark accepted by an earlier hello is a durable promise. A
      // reconnect cannot make unfinished old-stream debt disappear merely by
      // omitting that stream from its new snapshot.
      const outstandingOldStreams = this.db.all<{
        producer_epoch: string;
        next_expected_host_seq: number;
        max_declared_host_seq: number;
      }>(
        `SELECT producer_epoch,next_expected_host_seq,max_declared_host_seq
         FROM producer_streams
         WHERE machine_id=? AND producer_epoch<>?
           AND next_expected_host_seq-1<max_declared_host_seq`,
        connection.machineId,
        producerEpoch,
      );
      for (const outstanding of outstandingOldStreams) {
        const declaredTarget = reconciliationStreams.get(outstanding.producer_epoch);
        const resume = resumeStreams.get(outstanding.producer_epoch);
        invariant(
          declaredTarget !== undefined &&
            resume !== undefined,
          409,
          "RECONCILIATION_INCOMPLETE",
          "Every unfinished previously declared producer stream must be resumed",
          {
            producerEpoch: outstanding.producer_epoch,
            nextExpectedHostSeq: outstanding.next_expected_host_seq,
            minimumThroughHostSeq: outstanding.max_declared_host_seq,
          },
        );
      }
      this.db.run(
        `UPDATE agent_connections SET producer_epoch=?,app_server_epoch=?,hello_at=? WHERE connection_id=?`,
        producerEpoch,
        appServerEpoch,
        timestamp,
        connection.connectionId,
      );
      this.db.run(`UPDATE approvals SET state='rejected',version=version+1,decided_at=?
        WHERE state='pending' AND app_server_epoch<>? AND logical_session_id IN (SELECT logical_session_id FROM logical_sessions WHERE machine_id=?)`, timestamp, appServerEpoch, connection.machineId);
      this.db.run(
        `UPDATE machines SET platform=?,platform_release=?,architecture=?,agent_version=?,codex_version=?,schema_hash=?,
          credential_protection_level=?,security_state=CASE
            WHEN security_reason='source_stream_corrupt' THEN 'degraded_read_only'
            WHEN ?='unknown' THEN 'degraded_read_only' ELSE 'normal' END,
          security_reason=CASE
            WHEN security_reason='source_stream_corrupt' THEN security_reason
            WHEN ?='unknown' THEN 'credential_protection_unknown' ELSE NULL END,
          current_producer_epoch=?,compatibility=?,compatibility_reason=?,capacity='unknown',
          unreachable_reason='reconciliation_pending',updated_at=?
         WHERE machine_id=? AND identity_state='active'`,
        platform,
        platformRelease,
        architecture,
        agentVersion,
        codexVersion,
        schemaHash,
        credentialProtectionLevel,
        credentialProtectionLevel,
        credentialProtectionLevel,
        producerEpoch,
        compatibility.compatibility,
        compatibility.reason,
        timestamp,
        connection.machineId,
      );
      this.db.run(
        "UPDATE machines SET command_types_json=?,runtime_read_only=?,runtime_read_only_reasons_json=?,paginated_history=?,permission_profiles=? WHERE machine_id=?",
        commandTypesJson, hello.readOnly ? 1 : 0, JSON.stringify(hello.readOnlyReasons ?? []), hello.capabilities?.paginatedHistory === true ? 1 : 0, hello.capabilities?.permissionProfiles === true ? 1 : 0, connection.machineId,
      );
      this.db.run("UPDATE machines SET maintenance_types_json=? WHERE machine_id=?",JSON.stringify((maintenanceTypes??[]).filter(type=>MAINTENANCE_TYPES.includes(type as typeof MAINTENANCE_TYPES[number]))),connection.machineId);
      this.db.run("UPDATE machines SET codex_catalog_json=? WHERE machine_id=?", JSON.stringify(parseCodexCatalog(hello.codexCatalog)), connection.machineId);
      if(hello.discovery) this.updateDiscovery(connection.machineId,hello.discovery);
      if(hello.codexProfile) {
        const profile = parseCodexProfile(hello.codexProfile);
        this.db.run("UPDATE machines SET codex_profile_json=? WHERE machine_id=?",JSON.stringify(profile),connection.machineId);
      }
      this.db.run(
        `UPDATE producer_streams SET sealed=1,resume_through_host_seq=NULL,resume_connection_id=NULL,updated_at=?
         WHERE machine_id=? AND producer_epoch<>?`,
        timestamp,
        connection.machineId,
        producerEpoch,
      );
      this.db.run(
        `INSERT INTO producer_streams(
          machine_id,producer_epoch,next_expected_host_seq,quarantined,updated_at,sealed,
          resume_through_host_seq,resume_connection_id,max_declared_host_seq
        ) VALUES(?,?,1,0,?,0,NULL,NULL,0) ON CONFLICT(machine_id,producer_epoch) DO UPDATE SET
          sealed=0,resume_through_host_seq=NULL,resume_connection_id=NULL,updated_at=excluded.updated_at`,
        connection.machineId,
        producerEpoch,
        timestamp,
      );
      this.db.run(
        `INSERT INTO reconciliation_cycles(
          reconciliation_id,connection_id,machine_id,producer_epoch,app_server_epoch,capacity,state,created_at
        ) VALUES(?,?,?,?,?,?,'pending',?)`,
        reconciliationId,
        connection.connectionId,
        connection.machineId,
        producerEpoch,
        appServerEpoch,
        hello.capacity,
        timestamp,
      );
      for (const [streamEpoch, throughHostSeq] of reconciliationStreams) {
        const isCurrent = streamEpoch === producerEpoch;
        const stream = this.db.get<{
          next_expected_host_seq: number;
          quarantined: number;
          sealed: number;
          max_declared_host_seq: number;
        }>(
          `SELECT next_expected_host_seq,quarantined,sealed,max_declared_host_seq
           FROM producer_streams WHERE machine_id=? AND producer_epoch=?`,
          connection.machineId,
          streamEpoch,
        );
        invariant(
          stream && stream.quarantined === 0 && (isCurrent ? stream.sealed === 0 : stream.sealed === 1),
          409,
          "RECONCILIATION_STREAM_UNKNOWN",
          "Only the current stream or a known healthy sealed stream can be reconciled",
        );
        const serverCursor = stream.next_expected_host_seq - 1;
        invariant(
          throughHostSeq >= stream.max_declared_host_seq && throughHostSeq >= serverCursor,
          409,
          "RECONCILIATION_TARGET_ROLLBACK",
          "A reconciliation watermark cannot move behind a prior declaration or the server cursor",
          { producerEpoch: streamEpoch, minimumThroughHostSeq: Math.max(stream.max_declared_host_seq, serverCursor) },
        );
        invariant(
          throughHostSeq <= stream.next_expected_host_seq + 100_000,
          409,
          "RECONCILIATION_RANGE_INVALID",
          "The reconciliation range is unreasonably large",
          { producerEpoch: streamEpoch, nextExpectedHostSeq: stream.next_expected_host_seq },
        );
        const resume = resumeStreams.get(streamEpoch);
        if (resume) {
          invariant(
            resume.lastAckedHostSeq! <= serverCursor && serverCursor <= resume.lastProducedHostSeq,
            409,
            "RESUME_CURSOR_INVALID",
            "Agent acknowledgement metadata does not contain the server cursor",
            { producerEpoch: streamEpoch, nextExpectedHostSeq: stream.next_expected_host_seq },
          );
          if (resume.lastProducedHostSeq >= stream.next_expected_host_seq) {
            invariant(
              resume.firstRetainedHostSeq! <= stream.next_expected_host_seq,
              409,
              "SNAPSHOT_REQUIRED",
              "The Agent no longer retains the next event required by the Control Plane",
              { producerEpoch: streamEpoch, nextExpectedHostSeq: stream.next_expected_host_seq },
            );
          }
        } else if (!isCurrent && throughHostSeq >= stream.next_expected_host_seq) {
          throw new AppError(
            409,
            "SNAPSHOT_REQUIRED",
            "A sealed producer stream has a gap but no retained replay metadata",
            { producerEpoch: streamEpoch, nextExpectedHostSeq: stream.next_expected_host_seq },
          );
        }
        this.db.run(
          `UPDATE producer_streams SET max_declared_host_seq=?,
            resume_through_host_seq=CASE WHEN ?=1 THEN NULL ELSE ? END,
            resume_connection_id=CASE WHEN ?=1 THEN NULL ELSE ? END,updated_at=?
           WHERE machine_id=? AND producer_epoch=?`,
          throughHostSeq,
          isCurrent ? 1 : 0,
          throughHostSeq,
          isCurrent ? 1 : 0,
          connection.connectionId,
          timestamp,
          connection.machineId,
          streamEpoch,
        );
        this.db.run(
          `INSERT INTO reconciliation_stream_targets(
            reconciliation_id,machine_id,producer_epoch,through_host_seq,is_current
          ) VALUES(?,?,?,?,?)`,
          reconciliationId,
          connection.machineId,
          streamEpoch,
          throughHostSeq,
          isCurrent ? 1 : 0,
        );
      }

      const seenProjectExternalIds = new Set<string>();
      for (const project of hello.projects) {
        const externalId = cleanText(project.externalId, "project.externalId", 200);
        invariant(!seenProjectExternalIds.has(externalId), 400, "DUPLICATE_PROJECT", "Duplicate project externalId in hello");
        seenProjectExternalIds.add(externalId);
        const alias = cleanText(project.alias, "project.alias", 200);
        const canonicalRoot = cleanText(project.canonicalRoot, "project.canonicalRoot", 4096);
        const absoluteProjectRoot = platform === "win32" || platform === "windows"
          ? /^[A-Za-z]:[\\/]|^\\\\/u.test(canonicalRoot)
          : canonicalRoot.startsWith("/");
        invariant(absoluteProjectRoot, 400, "INVALID_PROJECT_ROOT", "canonicalRoot must be an absolute path for the reported host platform");
        const identityHash = cleanText(project.identityHash, "project.identityHash", 200);
        invariant(Number.isSafeInteger(project.leaseVersion) && project.leaseVersion >= 1, 400, "INVALID_PROJECT_VERSION", "project.leaseVersion must be positive");
        const existing = this.db.get<{ project_id: string }>(
          "SELECT project_id FROM projects WHERE machine_id=? AND external_id=?",
          connection.machineId,
          externalId,
        );
        const projectId = existing?.project_id ?? newId("proj");
        this.db.run(
          `INSERT INTO projects(
            project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,
            repo_root,branch,dirty,lease_version,created_at,last_reported_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(machine_id,external_id) DO UPDATE SET
            alias=excluded.alias,canonical_root=excluded.canonical_root,identity_hash=excluded.identity_hash,
            repo_root=excluded.repo_root,branch=excluded.branch,dirty=excluded.dirty,
            lease_version=excluded.lease_version,last_reported_at=excluded.last_reported_at`,
          projectId,
          connection.workspaceId,
          connection.machineId,
          externalId,
          alias,
          canonicalRoot,
          identityHash,
          project.repoRoot ?? null,
          project.branch ?? null,
          project.dirty === undefined || project.dirty === null ? null : project.dirty ? 1 : 0,
          project.leaseVersion,
          timestamp,
          timestamp,
        );
        projectMap[externalId] = projectId;
        const contentPolicy = this.db.get<{ sync_content: number; retention_days: number }>(
          "SELECT sync_content,retention_days FROM projects WHERE project_id=?",
          projectId,
        );
        projectContentPolicies[externalId] = {
          syncContent: contentPolicy?.sync_content !== 0,
          retentionDays: contentPolicy?.retention_days ?? 7,
        };
      }

      const seenSessionExternalIds = new Set<string>();
      const seenLogicalSessionIds = new Set<string>();
      for (const session of hello.sessions ?? []) {
        const externalId = cleanText(session.externalId, "session.externalId", 200);
        invariant(!seenSessionExternalIds.has(externalId), 400, "DUPLICATE_SESSION", "Duplicate session externalId in hello");
        seenSessionExternalIds.add(externalId);
        const projectId = projectMap[session.projectExternalId];
        invariant(projectId, 400, "SESSION_PROJECT_UNKNOWN", "Session references a project absent from hello");
        invariant(
          ["idle", "running", "awaiting_approval", "completed", "interrupted", "failed", "unknown"].includes(session.executionState),
          400,
          "INVALID_EXECUTION_STATE",
          "Invalid session executionState",
        );
        const profileId = session.codexProfileId === undefined ? "default" : cleanText(session.codexProfileId, "codexProfileId", 200);
        const nativeId = session.nativeThreadId ? cleanText(session.nativeThreadId, "nativeThreadId", 300) : null;
        if (nativeId && this.db.get("SELECT 1 FROM native_session_deletions WHERE machine_id=? AND codex_profile_id=? AND native_thread_id=?",connection.machineId,profileId,nativeId)) continue;
        invariant(session.managementRevision === undefined || (Number.isSafeInteger(session.managementRevision) && session.managementRevision >= 1), 400, "INVALID_MANAGEMENT_REVISION", "managementRevision must be positive");
        const binding = nativeId ? this.db.get<{ logical_session_id: string; execution_segment_id: string }>(
          "SELECT logical_session_id,execution_segment_id FROM native_thread_bindings WHERE machine_id=? AND codex_profile_id=? AND native_thread_id=?",
          connection.machineId, profileId, nativeId,
        ) : undefined;
        const existing = this.db.get<{ logical_session_id: string; title: string; managed: number; management_revision: number; runtime_settings_json: string | null }>(
          `SELECT logical_session_id,title,managed,management_revision,runtime_settings_json FROM logical_sessions
           WHERE machine_id=? AND (external_id=? OR logical_session_id=?)`,
          connection.machineId,
          binding ? "" : externalId,
          binding?.logical_session_id ?? externalId,
        );
        const logicalSessionId = existing?.logical_session_id ?? newId("ls");
        invariant(!seenLogicalSessionIds.has(logicalSessionId), 400, "DUPLICATE_NATIVE_THREAD", "Native thread appears more than once in hello");
        seenLogicalSessionIds.add(logicalSessionId);
        // Message previews are mutable (e.g. the next prompt is just “deploy”).
        // Only a native explicit name can rename an existing catalog entry.
        const incomingTitle = session.title ? cleanText(session.title, "session.title", 200) : undefined;
        const sessionTitle = reconcileSessionTitle(existing?.title, incomingTitle, session.titleSource);
        if (existing) {
          const incomingRevision = session.managementRevision ?? 0;
          const acceptManagement = existing.management_revision === 0 || incomingRevision > existing.management_revision;
          const priorSettings = existing.runtime_settings_json ? parseRuntimeSettings(JSON.parse(existing.runtime_settings_json)) : null;
          const nextSettings = parseRuntimeSettings(session.runtimeSettings);
          const metadataChanged = existing.title !== sessionTitle || (incomingRevision >= existing.management_revision && typeof nextSettings?.archived === "boolean" && nextSettings.archived !== (priorSettings?.archived ?? false));
          this.db.run(
            `UPDATE logical_sessions SET external_id=COALESCE(external_id,?),project_id=?,title=?,managed=?,
              execution_state=?,reachability='reconciling',active_turn_id=?,updated_at=?,
              management_revision=MAX(management_revision,?),codex_profile_id=?,session_cwd=COALESCE(?,session_cwd),
              thread_control_version=thread_control_version+?
             WHERE logical_session_id=?`,
            externalId,
            projectId,
            sessionTitle,
            acceptManagement ? (session.managed ? 1 : 0) : existing.managed,
            session.executionState,
            session.activeTurnId ?? null,
            timestamp,
            incomingRevision,
            profileId,
            session.sessionCwd ? cleanText(session.sessionCwd, "sessionCwd", 8192) : null,
            (acceptManagement && existing.managed !== (session.managed ? 1 : 0) ? 1 : 0) + (metadataChanged ? 1 : 0),
            logicalSessionId,
          );
        } else {
          this.db.run(
            `INSERT INTO logical_sessions(
              logical_session_id,workspace_id,machine_id,project_id,external_id,title,managed,
              execution_state,reachability,thread_control_version,turn_control_version,active_turn_id,created_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            logicalSessionId,
            connection.workspaceId,
            connection.machineId,
            projectId,
            externalId,
            sessionTitle,
            session.managed ? 1 : 0,
            session.executionState,
            "reconciling",
            session.threadControlVersion,
            session.turnControlVersion ?? 1,
            session.activeTurnId ?? null,
            timestamp,
            timestamp,
          );
        }
        if (!existing) this.db.run(
          "UPDATE logical_sessions SET management_revision=?,codex_profile_id=?,session_cwd=? WHERE logical_session_id=?",
          session.managementRevision ?? 0, profileId, session.sessionCwd ? cleanText(session.sessionCwd, "sessionCwd", 8192) : null, logicalSessionId,
        );
        const segmentExternalId = cleanText(session.executionSegmentExternalId, "session.executionSegmentExternalId", 200);
        if (!existing || (session.managementRevision ?? 0) >= existing.management_revision) {
          this.db.run("UPDATE logical_sessions SET runtime_settings_json=? WHERE logical_session_id=?", JSON.stringify(parseRuntimeSettings(session.runtimeSettings)), logicalSessionId);
        }
        const segment = this.db.get<{ execution_segment_id: string }>(
          `SELECT execution_segment_id FROM execution_segments
           WHERE machine_id=? AND (external_id=? OR execution_segment_id=?)`,
          connection.machineId,
          binding ? "" : segmentExternalId,
          binding?.execution_segment_id ?? segmentExternalId,
        );
        const segmentId = segment?.execution_segment_id ?? newId("seg");
        const historyCompleteness = session.historyCompleteness ?? (session.managed ? "complete" : "partial");
        invariant(["complete", "partial", "unknown"].includes(historyCompleteness), 400, "INVALID_HISTORY_COMPLETENESS", "Invalid historyCompleteness");
        const historyMode = session.historyMode ?? null;
        invariant(historyMode === null || historyMode === "legacy" || historyMode === "paginated", 400, "INVALID_HISTORY_MODE", "Invalid history mode");
        if (segment) {
          this.db.run(
            `UPDATE execution_segments SET external_id=COALESCE(external_id,?),logical_session_id=?,project_id=?,
              native_thread_id=?,history_completeness=?,history_mode=? WHERE execution_segment_id=?`,
            segmentExternalId,
            logicalSessionId,
            projectId,
            session.nativeThreadId ?? null,
            historyCompleteness,
            historyMode,
            segmentId,
          );
        } else {
          this.db.run(
            `INSERT INTO execution_segments(
              execution_segment_id,logical_session_id,machine_id,project_id,external_id,native_thread_id,
              history_completeness,history_mode,created_at
            ) VALUES(?,?,?,?,?,?,?,?,?)`,
            segmentId,
            logicalSessionId,
            connection.machineId,
            projectId,
            segmentExternalId,
            session.nativeThreadId ?? null,
            historyCompleteness,
            historyMode,
            timestamp,
          );
        }
        if (nativeId) this.db.run(
          "INSERT OR IGNORE INTO native_thread_bindings(machine_id,codex_profile_id,native_thread_id,logical_session_id,execution_segment_id) VALUES(?,?,?,?,?)",
          connection.machineId, profileId, nativeId, logicalSessionId, segmentId,
        );
        sessionMap[externalId] = logicalSessionId;
        this.db.run(
          "INSERT INTO reconciliation_session_targets(reconciliation_id,logical_session_id) VALUES(?,?)",
          reconciliationId,
          logicalSessionId,
        );
        sessionContentEpochs[externalId] = this.db.get<{ content_epoch: number }>(
          "SELECT content_epoch FROM logical_sessions WHERE logical_session_id=?",
          logicalSessionId,
        )?.content_epoch ?? 1;
      }
      // A Control-Plane-created Session has no native state to reconcile until
      // its first turn is dispatched, so it is safe to make it live even though
      // it cannot yet appear in the Agent's native thread snapshot.
      this.db.run(
        `INSERT OR IGNORE INTO reconciliation_session_targets(reconciliation_id,logical_session_id)
         SELECT ?,s.logical_session_id FROM logical_sessions s
         JOIN execution_segments e ON e.logical_session_id=s.logical_session_id AND e.ended_at IS NULL
         WHERE s.machine_id=? AND s.managed=1 AND s.active_turn_id IS NULL AND e.native_thread_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM execution_segments native
             WHERE native.logical_session_id=s.logical_session_id AND native.ended_at IS NULL
               AND native.native_thread_id IS NOT NULL
           )`,
        reconciliationId,
        connection.machineId,
      );
      const externalSessions = this.db.all<{ logical_session_id: string; external_id: string | null }>(
        "SELECT logical_session_id,external_id FROM logical_sessions WHERE machine_id=? AND managed=0",
        connection.machineId,
      );
      for (const externalSession of externalSessions) {
        if(hello.discovery && hello.discovery.state!=="ready") continue;
        if (seenLogicalSessionIds.has(externalSession.logical_session_id)) continue;
        this.db.run(
          `UPDATE logical_sessions SET execution_state='unknown',reachability='unreachable',updated_at=?
           WHERE logical_session_id=? AND managed=0`,
          timestamp,
          externalSession.logical_session_id,
        );
      }
      this.db.audit({
        workspaceId: connection.workspaceId,
        machineId: connection.machineId,
        action: "agent.hello",
        metadata: {
          connectionId: connection.connectionId,
          transportGeneration: connection.transportGeneration,
          producerEpoch,
          projectCount: hello.projects.length,
          sessionCount: hello.sessions?.length ?? 0,
          compatibility: compatibility.compatibility,
        },
      });
    });
    return { projects: projectMap, sessions: sessionMap, sessionContentEpochs, projectContentPolicies, reconciliationId };
  }

  completeReconciliation(
    connection: AgentConnectionIdentity,
    reconciliationIdInput: string,
    reportedStreams: Array<{ producerEpoch: string; throughHostSeq: number }>,
  ): { alreadyComplete: boolean; dispatchEligible: boolean } {
    const reconciliationId = cleanText(reconciliationIdInput, "reconciliationId", 256);
    invariant(Array.isArray(reportedStreams) && reportedStreams.length >= 1 && reportedStreams.length <= 32, 400, "INVALID_RECONCILIATION_STREAMS", "reconciliationStreams must contain between 1 and 32 entries");
    const reported = new Map<string, number>();
    for (const watermark of reportedStreams) {
      const epoch = cleanText(watermark.producerEpoch, "reconciliationStream.producerEpoch", 200);
      invariant(!reported.has(epoch), 400, "INVALID_RECONCILIATION_STREAM", "reconciliationStreams must contain unique producer epochs");
      invariant(Number.isSafeInteger(watermark.throughHostSeq) && watermark.throughHostSeq >= 0, 400, "INVALID_RECONCILIATION_STREAM", "throughHostSeq must be non-negative");
      reported.set(epoch, watermark.throughHostSeq);
    }

    return this.db.transaction(() => {
      const cycle = this.db.get<{
        connection_id: string;
        machine_id: string;
        producer_epoch: string;
        app_server_epoch: string;
        state: string;
        disconnected_at: string | null;
        connection_producer_epoch: string | null;
        connection_app_server_epoch: string | null;
        transport_generation: number;
        identity_state: string;
        security_state: string;
        compatibility: string;
        current_producer_epoch: string | null;
      }>(
        `SELECT r.connection_id,r.machine_id,r.producer_epoch,r.app_server_epoch,r.state,
          c.disconnected_at,c.producer_epoch AS connection_producer_epoch,
          c.app_server_epoch AS connection_app_server_epoch,c.transport_generation,
          m.identity_state,m.security_state,m.compatibility,m.current_producer_epoch
         FROM reconciliation_cycles r
         JOIN agent_connections c ON c.connection_id=r.connection_id AND c.machine_id=r.machine_id
         JOIN machines m ON m.machine_id=r.machine_id
         WHERE r.reconciliation_id=?`,
        reconciliationId,
      );
      invariant(
        cycle && cycle.connection_id === connection.connectionId && cycle.machine_id === connection.machineId,
        409,
        "RECONCILIATION_FENCED",
        "Reconciliation does not belong to this Agent connection",
      );
      invariant(
        !cycle.disconnected_at && cycle.transport_generation === connection.transportGeneration,
        409,
        "CONNECTION_FENCED",
        "Agent connection is no longer current",
      );
      const newerGeneration = this.db.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM agent_connections WHERE machine_id=? AND transport_generation>?",
        connection.machineId,
        connection.transportGeneration,
      );
      invariant(!newerGeneration || newerGeneration.count === 0, 409, "CONNECTION_FENCED", "A newer Agent transport generation exists");
      invariant(cycle.identity_state === "active", 409, "MACHINE_REVOKED", "Machine is revoked or missing");
      invariant(
        cycle.connection_producer_epoch === cycle.producer_epoch &&
          cycle.connection_app_server_epoch === cycle.app_server_epoch &&
          cycle.current_producer_epoch === cycle.producer_epoch,
        409,
        "RECONCILIATION_EPOCH_FENCED",
        "Reconciliation belongs to a stale producer or App Server epoch",
      );

      const targets = this.db.all<{ producer_epoch: string; through_host_seq: number }>(
        `SELECT producer_epoch,through_host_seq FROM reconciliation_stream_targets
         WHERE reconciliation_id=?`,
        reconciliationId,
      );
      invariant(targets.length === reported.size, 409, "RECONCILIATION_TARGET_MISMATCH", "Reconciliation completion changed the captured stream set");
      for (const target of targets) {
        invariant(
          reported.get(target.producer_epoch) === target.through_host_seq,
          409,
          "RECONCILIATION_TARGET_MISMATCH",
          "Reconciliation completion changed a captured stream watermark",
        );
      }

      const notReady = this.db.get<{
        producer_epoch: string;
        through_host_seq: number;
        next_expected_host_seq: number;
      }>(
        `SELECT t.producer_epoch,t.through_host_seq,s.next_expected_host_seq
         FROM reconciliation_stream_targets t
         LEFT JOIN producer_streams s ON s.machine_id=t.machine_id AND s.producer_epoch=t.producer_epoch
         WHERE t.reconciliation_id=? AND (
           s.producer_epoch IS NULL OR s.quarantined<>0 OR s.next_expected_host_seq<=t.through_host_seq OR
           (t.is_current=1 AND (s.sealed<>0 OR s.resume_through_host_seq IS NOT NULL OR s.resume_connection_id IS NOT NULL)) OR
           (t.is_current=0 AND (s.sealed<>1 OR s.resume_through_host_seq<>t.through_host_seq OR
             s.resume_connection_id<>?))
         ) LIMIT 1`,
        reconciliationId,
        connection.connectionId,
      );
      invariant(
        !notReady,
        409,
        "RECONCILIATION_INCOMPLETE",
        "The Control Plane has not continuously received every captured producer stream",
        notReady ? {
          producerEpoch: notReady.producer_epoch,
          throughHostSeq: notReady.through_host_seq,
          nextExpectedHostSeq: notReady.next_expected_host_seq,
        } : undefined,
      );
      if (cycle.state === "complete") {
        return {
          alreadyComplete: true,
          dispatchEligible: cycle.security_state === "normal" && cycle.compatibility === "compatible",
        };
      }
      const timestamp = nowIso();
      const completed = this.db.run(
        "UPDATE reconciliation_cycles SET state='complete',completed_at=? WHERE reconciliation_id=? AND state='pending'",
        timestamp,
        reconciliationId,
      );
      invariant(Number(completed.changes) === 1, 409, "RECONCILIATION_RACE_LOST", "Reconciliation was completed concurrently");
      const machine = this.db.run(
        `UPDATE machines SET reachability='online',capacity=(
            SELECT capacity FROM reconciliation_cycles WHERE reconciliation_id=?
          ),unreachable_reason=NULL,last_heartbeat_at=?,updated_at=?
         WHERE machine_id=? AND identity_state='active' AND current_producer_epoch=?`,
        reconciliationId,
        timestamp,
        timestamp,
        connection.machineId,
        cycle.producer_epoch,
      );
      invariant(Number(machine.changes) === 1, 409, "MACHINE_REVOKED", "Machine is revoked or changed during reconciliation");
      this.db.run(
        `UPDATE logical_sessions SET reachability='live',updated_at=? WHERE logical_session_id IN (
          SELECT logical_session_id FROM reconciliation_session_targets WHERE reconciliation_id=?
        )`,
        timestamp,
        reconciliationId,
      );
      this.db.audit({
        workspaceId: connection.workspaceId,
        machineId: connection.machineId,
        action: "agent.reconciliation.complete",
        metadata: { reconciliationId, connectionId: connection.connectionId, streamCount: targets.length },
      });
      return {
        alreadyComplete: false,
        dispatchEligible: cycle.security_state === "normal" && cycle.compatibility === "compatible",
      };
    });
  }

  heartbeat(connection: AgentConnectionIdentity, capacity: MachineCapacity, activeTurns: number, unreachableReason?: string | null, codexProfile?: Record<string, unknown>, runtime?: { readOnly?: unknown; readOnlyReasons?: unknown }): void {
    const profile = codexProfile ? parseCodexProfile(codexProfile) : undefined;
    if (runtime?.readOnly !== undefined) {
      invariant(typeof runtime.readOnly === "boolean" && Array.isArray(runtime.readOnlyReasons) && runtime.readOnlyReasons.length <= 32 &&
        runtime.readOnlyReasons.every(reason => typeof reason === "string" && reason.length <= 2000), 400, "INVALID_RUNTIME_STATE", "Invalid runtime readiness report");
    }
    invariant(["unknown", "idle", "busy", "saturated"].includes(capacity), 400, "INVALID_CAPACITY", "Invalid capacity state");
    invariant(Number.isSafeInteger(activeTurns) && activeTurns >= 0, 400, "INVALID_ACTIVE_TURNS", "activeTurns must be non-negative");
    const liveConnection = this.db.get<{ disconnected_at: string | null; reconciliation_state: string | null }>(
      `SELECT c.disconnected_at,r.state AS reconciliation_state FROM agent_connections c
       LEFT JOIN reconciliation_cycles r ON r.connection_id=c.connection_id
       WHERE c.connection_id=? AND c.machine_id=?`,
      connection.connectionId,
      connection.machineId,
    );
    invariant(liveConnection && !liveConnection.disconnected_at, 409, "CONNECTION_FENCED", "Agent connection is no longer current");
    invariant(liveConnection.reconciliation_state === "complete", 409, "RECONCILIATION_REQUIRED", "Heartbeat is disabled until reconciliation completes");
    const timestamp = nowIso();
    const result = this.db.run(
      `UPDATE machines SET reachability='online',capacity=?,active_turns=?,unreachable_reason=?,
        last_heartbeat_at=?,updated_at=? WHERE machine_id=? AND identity_state='active'`,
      capacity,
      activeTurns,
      unreachableReason ?? null,
      timestamp,
      timestamp,
      connection.machineId,
    );
    invariant(Number(result.changes) === 1, 409, "MACHINE_REVOKED", "Machine is revoked or missing");
    if (profile) this.db.run("UPDATE machines SET codex_profile_json=? WHERE machine_id=?", JSON.stringify(profile), connection.machineId);
    // Runtime readiness may recover or fail without changing the relay connection.
    // Never modify independent credential/security/compatibility gates here.
    if (runtime?.readOnly !== undefined) this.db.run("UPDATE machines SET runtime_read_only=?,runtime_read_only_reasons_json=? WHERE machine_id=?",
      runtime.readOnly ? 1 : 0, JSON.stringify(runtime.readOnlyReasons), connection.machineId);
  }

  disconnect(connection: AgentConnectionIdentity, reason: string): void {
    const timestamp = nowIso();
    this.db.transaction(() => {
      this.db.run(
        "UPDATE agent_connections SET disconnected_at=?,close_reason=? WHERE connection_id=? AND disconnected_at IS NULL",
        timestamp,
        reason.slice(0, 500),
        connection.connectionId,
      );
      const newer = this.db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM agent_connections
         WHERE machine_id=? AND disconnected_at IS NULL AND transport_generation>?`,
        connection.machineId,
        connection.transportGeneration,
      );
      if (!newer || newer.count === 0) {
        this.db.run(
          `UPDATE machines SET reachability='reconnecting',unreachable_reason='connection_closed',updated_at=?
           WHERE machine_id=? AND identity_state='active'`,
          timestamp,
          connection.machineId,
        );
        this.db.run(
          "UPDATE logical_sessions SET reachability='reconciling',updated_at=? WHERE machine_id=?",
          timestamp,
          connection.machineId,
        );
      }
    });
  }

  sweepOffline(): string[] {
    const cutoff = new Date(Date.now() - this.config.heartbeatOfflineSeconds * 1_000).toISOString();
    const rows = this.db.all<{ machine_id: string }>(
      `SELECT machine_id FROM machines WHERE identity_state='active' AND reachability != 'offline'
       AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)`,
      cutoff,
    );
    if (rows.length === 0) return [];
    const timestamp = nowIso();
    this.db.transaction(() => {
      for (const row of rows) {
        this.db.run(
          `UPDATE machines SET reachability='offline',unreachable_reason='heartbeat_timeout',updated_at=?
           WHERE machine_id=?`,
          timestamp,
          row.machine_id,
        );
        this.db.run(
          "UPDATE logical_sessions SET reachability='unreachable',updated_at=? WHERE machine_id=?",
          timestamp,
          row.machine_id,
        );
      }
    });
    return rows.map((row) => row.machine_id);
  }

  listMachines(principal: Principal): MachineSummary[] {
    this.sweepOffline();
    return this.db
      .all<MachineRow>(
        "SELECT * FROM machines WHERE workspace_id=? AND identity_state='active' ORDER BY created_at DESC",
        principal.workspaceId,
      )
      .map(mapMachine);
  }

  getMachine(principal: Principal, machineId: string): MachineSummary {
    this.sweepOffline();
    const row = this.db.get<MachineRow>("SELECT * FROM machines WHERE machine_id=? AND workspace_id=?", machineId, principal.workspaceId);
    invariant(row, 404, "MACHINE_NOT_FOUND", "Machine was not found");
    return mapMachine(row);
  }

  updateMachineAlias(principal: Principal, machineId: string, alias: string | null): MachineSummary {
    const displayAlias = alias === null ? null : cleanText(alias, "alias", 80);
    this.db.transaction(() => {
      const machine = this.db.get<{ identity_state: string; display_alias: string | null }>(
        "SELECT identity_state,display_alias FROM machines WHERE machine_id=? AND workspace_id=?",
        machineId,
        principal.workspaceId,
      );
      invariant(machine && machine.identity_state === "active", 404, "MACHINE_NOT_FOUND", "Machine was not found");
      if (machine.display_alias === displayAlias) return;
      const timestamp = nowIso();
      this.db.run("UPDATE machines SET display_alias=?,updated_at=? WHERE machine_id=?", displayAlias, timestamp, machineId);
      this.db.audit({
        workspaceId: principal.workspaceId,
        actorUserId: principal.userId,
        actorClientSessionId: principal.clientSessionId,
        machineId,
        action: "machine.alias.update",
        metadata: { displayAlias },
      });
    });
    return this.getMachine(principal, machineId);
  }

  revokeMachine(principal: Principal, machineId: string): void {
    this.db.transaction(() => {
      const machine = this.db.get<{ identity_state: string }>(
        "SELECT identity_state FROM machines WHERE machine_id=? AND workspace_id=?",
        machineId,
        principal.workspaceId,
      );
      invariant(machine, 404, "MACHINE_NOT_FOUND", "Machine was not found");
      if (machine.identity_state === "revoked") return;
      const timestamp = nowIso();
      this.db.run(
        `UPDATE machines SET identity_state='revoked',reachability='offline',unreachable_reason='revoked',
          revoked_at=?,updated_at=? WHERE machine_id=?`,
        timestamp,
        timestamp,
        machineId,
      );
      this.db.run("UPDATE machine_credentials SET revoked_at=? WHERE machine_id=? AND revoked_at IS NULL", timestamp, machineId);
      this.db.run("DELETE FROM agent_tickets WHERE machine_id=?", machineId);
      this.db.run("DELETE FROM agent_challenges WHERE machine_id=?", machineId);
      this.db.run(
        `UPDATE agent_connections SET disconnected_at=?,close_reason='machine_revoked'
         WHERE machine_id=? AND disconnected_at IS NULL`,
        timestamp,
        machineId,
      );
      this.db.run(
        `UPDATE producer_streams SET resume_through_host_seq=NULL,resume_connection_id=NULL,updated_at=?
         WHERE machine_id=?`,
        timestamp,
        machineId,
      );
      this.db.run("DELETE FROM reconciliation_cycles WHERE machine_id=?", machineId);
      this.db.run("UPDATE logical_sessions SET reachability='unreachable',updated_at=? WHERE machine_id=?", timestamp, machineId);
      this.db.run(
        `UPDATE control_leases SET state='revoked',version=version+1,ended_at=?
         WHERE state='active' AND logical_session_id IN (
           SELECT logical_session_id FROM logical_sessions WHERE machine_id=?
         )`,
        timestamp,
        machineId,
      );
      this.db.audit({
        workspaceId: principal.workspaceId,
        actorUserId: principal.userId,
        actorClientSessionId: principal.clientSessionId,
        machineId,
        action: "machine.revoke",
      });
    });
  }

  updateDiscovery(machineId: string, discovery: Record<string, unknown>): void {
    invariant(discovery && typeof discovery === "object" && !Array.isArray(discovery) && ["scanning","ready","error"].includes(String(discovery.state)),400,"INVALID_DISCOVERY","Invalid discovery state");
    const safe: Record<string,unknown>={state:discovery.state};
    if (discovery.syncMode !== undefined) {
      invariant(discovery.syncMode === "events" || discovery.syncMode === "fallback",400,"INVALID_DISCOVERY","Invalid syncMode");
      safe.syncMode = discovery.syncMode;
    }
    if (discovery.backgroundSync !== undefined) {
      invariant(typeof discovery.backgroundSync === "boolean",400,"INVALID_DISCOVERY","Invalid backgroundSync");
      safe.backgroundSync = discovery.backgroundSync;
    }
    for(const key of ["scanId","lastSuccessfulAt","error","errorCode"]) {
      if(discovery[key]!==undefined) {
        invariant(typeof discovery[key]==="string" && discovery[key].length<=2000,400,"INVALID_DISCOVERY",`Invalid ${key}`);
        safe[key]=discovery[key];
      }
    }
    for(const key of ["scannedCount","discoveredCount","discoveredProjects","discoveredSessions","scannedPages","skippedCount","reconcileIntervalSeconds"]) {
      if(discovery[key]!==undefined) {
        invariant(Number.isSafeInteger(discovery[key]) && Number(discovery[key])>=0,400,"INVALID_DISCOVERY",`Invalid ${key}`);
        safe[key]=discovery[key];
      }
    }
    if (discovery.readiness !== undefined) {
      invariant(["ready", "checking", "read_only", "action_required"].includes(String(discovery.readiness)),400,"INVALID_DISCOVERY","Invalid readiness");
      safe.readiness = discovery.readiness;
    }
    if (discovery.checks !== undefined) {
      invariant(Array.isArray(discovery.checks) && discovery.checks.length <= 12,400,"INVALID_DISCOVERY","Invalid checks");
      const ids = new Set<string>();
      safe.checks = discovery.checks.map((item: unknown) => {
        invariant(item && typeof item === "object" && !Array.isArray(item),400,"INVALID_DISCOVERY","Invalid check");
        const value = item as Record<string, unknown>;
        const id = cleanText(value.id, "check.id", 40);
        invariant(["environment", "runtime", "protocol", "data", "sandbox", "tools", "server", "catalog"].includes(id) && !ids.has(id),400,"INVALID_DISCOVERY","Invalid or duplicate check id");
        ids.add(id);
        invariant(["passed", "failed", "checking", "skipped"].includes(String(value.state)),400,"INVALID_DISCOVERY","Invalid check state");
        invariant(typeof value.checkedAt === "string" && value.checkedAt.length <= 40 && Number.isFinite(Date.parse(value.checkedAt)),400,"INVALID_DISCOVERY","Invalid check timestamp");
        invariant(value.action === undefined || MAINTENANCE_TYPES.includes(value.action as typeof MAINTENANCE_TYPES[number]),400,"INVALID_DISCOVERY","Invalid recovery action");
        return { id, state: value.state, code: cleanText(value.code, "check.code", 80), message: cleanText(value.message, "check.message", 2000), checkedAt: value.checkedAt,
          ...(value.action ? { action: value.action } : {}) };
      });
    }
    this.db.run("UPDATE machines SET discovery_json=? WHERE machine_id=?",JSON.stringify(safe),machineId);
  }

  listProjects(principal: Principal, machineId?: string): ProjectSummary[] {
    const rows = machineId
      ? this.db.all<{
          project_id: string; machine_id: string; alias: string; canonical_root: string;
          identity_hash: string; repo_root: string | null; branch: string | null; dirty: number | null;
          lease_version: number; last_reported_at: string;
          sync_content: number; retention_days: 1 | 3 | 7 | 14 | 30;
        }>(
          `SELECT p.* FROM projects p JOIN machines m ON m.machine_id=p.machine_id
           WHERE p.workspace_id=? AND p.machine_id=? AND m.identity_state='active' ORDER BY p.alias`,
          principal.workspaceId,
          machineId,
        )
      : this.db.all<{
          project_id: string; machine_id: string; alias: string; canonical_root: string;
          identity_hash: string; repo_root: string | null; branch: string | null; dirty: number | null;
          lease_version: number; last_reported_at: string;
          sync_content: number; retention_days: 1 | 3 | 7 | 14 | 30;
        }>(
          `SELECT p.* FROM projects p JOIN machines m ON m.machine_id=p.machine_id
           WHERE p.workspace_id=? AND m.identity_state='active' ORDER BY p.alias`,
          principal.workspaceId,
        );
    return rows.map((row) => ({
      projectId: row.project_id,
      machineId: row.machine_id,
      alias: row.alias,
      canonicalRoot: row.canonical_root,
      identityHash: row.identity_hash,
      repoRoot: row.repo_root,
      branch: row.branch,
      dirty: row.dirty === null ? null : row.dirty === 1,
      leaseVersion: row.lease_version,
      lastReportedAt: row.last_reported_at,
      syncContent: row.sync_content === 1,
      retentionDays: row.retention_days,
    }));
  }

  listProjectsPage(principal: Principal, options: ListOptions): { items: ProjectSummary[]; nextCursor: string | null; total: number } {
    const limit = pageLimit(options.limit);
    const scope = JSON.stringify(["projects", principal.workspaceId, options.machineId ?? null, options.q ?? null]);
    const cursor = parsePageCursor(options.cursor, scope);
    const where = ["p.workspace_id=?", "m.identity_state='active'"];
    const params: Array<string | number> = [principal.workspaceId];
    if (options.machineId) { where.push("p.machine_id=?"); params.push(options.machineId); }
    if (options.q) { where.push("(instr(lower(p.alias),lower(?))>0 OR instr(lower(p.canonical_root),lower(?))>0 OR instr(lower(m.name),lower(?))>0 OR instr(lower(coalesce(m.display_alias,'')),lower(?))>0)"); params.push(options.q, options.q, options.q, options.q); }
    const total = this.db.get<{ count: number }>(`SELECT count(*) AS count FROM projects p JOIN machines m ON m.machine_id=p.machine_id WHERE ${where.join(" AND ")}`, ...params)!.count;
    if (cursor) { where.push("(p.alias>? OR (p.alias=? AND p.project_id>?))"); params.push(cursor[0]!,cursor[0]!,cursor[1]!); }
    const rows = this.db.all<{ project_id: string; alias: string; machine_id: string; canonical_root: string; identity_hash: string; repo_root: string | null; branch: string | null; dirty: number | null; lease_version: number; last_reported_at: string; sync_content: number; retention_days: 1 | 3 | 7 | 14 | 30 }>(
      `SELECT p.* FROM projects p JOIN machines m ON m.machine_id=p.machine_id WHERE ${where.join(" AND ")} ORDER BY p.alias,p.project_id LIMIT ?`, ...params,limit+1);
    const visible = rows.slice(0,limit);
    const last = visible.at(-1);
    return { items: visible.map((row) => ({ projectId: row.project_id,machineId: row.machine_id,alias: row.alias,canonicalRoot: row.canonical_root,identityHash: row.identity_hash,repoRoot: row.repo_root,branch: row.branch,dirty: row.dirty===null?null:row.dirty===1,leaseVersion: row.lease_version,lastReportedAt: row.last_reported_at,syncContent: row.sync_content===1,retentionDays: row.retention_days })),
      nextCursor: rows.length>limit && last ? pageCursor(scope,[last.alias,last.project_id]) : null,total };
  }

  updateProjectContentPolicy(
    principal: Principal,
    projectId: string,
    input: { syncContent: boolean; retentionDays: 1 | 3 | 7 | 14 | 30 },
  ): ProjectSummary {
    const changed = this.db.run(
      "UPDATE projects SET sync_content=?,retention_days=? WHERE project_id=? AND workspace_id=?",
      input.syncContent ? 1 : 0,
      input.retentionDays,
      projectId,
      principal.workspaceId,
    );
    invariant(Number(changed.changes) === 1, 404, "PROJECT_NOT_FOUND", "Project was not found");
    const project = this.listProjects(principal).find((entry) => entry.projectId === projectId);
    invariant(project, 404, "PROJECT_NOT_FOUND", "Project was not found");
    this.db.audit({
      workspaceId: principal.workspaceId,
      actorUserId: principal.userId,
      actorClientSessionId: principal.clientSessionId,
      machineId: project.machineId,
      projectId,
      action: "project.content_policy.update",
      metadata: input,
    });
    return project;
  }

  createSession(principal: Principal, machineId: string, projectId: string, title?: string, clientMutationId?: string): LogicalSessionSummary {
    this.sweepOffline();
    return this.db.transaction(() => {
      const requestHash=sha256(JSON.stringify({machineId,projectId,title:title??null}));
      if(clientMutationId) {
        cleanText(clientMutationId,"clientMutationId",200);
        const previous=this.db.get<{logical_session_id:string;request_hash:string}>("SELECT logical_session_id,request_hash FROM session_creation_requests WHERE workspace_id=? AND actor_client_session_id=? AND client_mutation_id=?",principal.workspaceId,principal.clientSessionId,clientMutationId);
        if(previous) {
          invariant(previous.request_hash===requestHash,409,"IDEMPOTENCY_KEY_REUSE","clientMutationId belongs to another session request");
          return this.getSession(principal,previous.logical_session_id);
        }
      }
      const target = this.db.get<{
        machine_id: string;
        project_id: string;
        compatibility: string;
        identity_state: string;
        security_state: string;
        reachability: string;
      }>(
        `SELECT m.machine_id,p.project_id,m.compatibility,m.identity_state,m.security_state,m.reachability
         FROM machines m JOIN projects p ON p.machine_id=m.machine_id
         WHERE m.machine_id=? AND p.project_id=? AND m.workspace_id=?`,
        machineId,
        projectId,
        principal.workspaceId,
      );
      invariant(target, 404, "TARGET_NOT_FOUND", "Machine or Project was not found");
      invariant(target.identity_state === "active", 409, "MACHINE_REVOKED", "Machine is revoked");
      invariant(target.compatibility === "compatible", 409, "MACHINE_INCOMPATIBLE", "Machine is not P0a-compatible");
      invariant(target.security_state === "normal", 409, "MACHINE_READ_ONLY", "Machine is in degraded read-only mode");
      invariant(target.reachability === "online", 409, "MACHINE_NOT_ONLINE", "Machine is not online");
      const logicalSessionId = newId("ls");
      const executionSegmentId = newId("seg");
      const timestamp = nowIso();
      this.db.run(
        `INSERT INTO logical_sessions(
          logical_session_id,workspace_id,machine_id,project_id,external_id,title,managed,execution_state,
          reachability,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,1,'idle','live',?,?)`,
        logicalSessionId,
        principal.workspaceId,
        machineId,
        projectId,
        logicalSessionId,
        title ? cleanText(title, "title", 200) : "New Codex session",
        timestamp,
        timestamp,
      );
      this.db.run(
        `INSERT INTO execution_segments(
          execution_segment_id,logical_session_id,machine_id,project_id,external_id,history_completeness,created_at
        ) VALUES(?,?,?,?,?,?,?)`,
        executionSegmentId,
        logicalSessionId,
        machineId,
        projectId,
        executionSegmentId,
        "complete",
        timestamp,
      );
      this.db.audit({
        workspaceId: principal.workspaceId,
        actorUserId: principal.userId,
        actorClientSessionId: principal.clientSessionId,
        machineId,
        projectId,
        logicalSessionId,
        action: "logical_session.create",
      });
      if(clientMutationId) this.db.run("INSERT INTO session_creation_requests(workspace_id,actor_client_session_id,client_mutation_id,request_hash,logical_session_id) VALUES(?,?,?,?,?)",principal.workspaceId,principal.clientSessionId,clientMutationId,requestHash,logicalSessionId);
      return this.getSession(principal, logicalSessionId);
    });
  }

  listSessions(principal: Principal): LogicalSessionSummary[] {
    return this.db
      .all<{ logical_session_id: string }>(
        `SELECT s.logical_session_id FROM logical_sessions s JOIN machines m ON m.machine_id=s.machine_id
         WHERE s.workspace_id=? AND m.identity_state='active' AND s.deleted_at IS NULL ORDER BY s.updated_at DESC`,
        principal.workspaceId,
      )
      .map((row) => this.getSession(principal, row.logical_session_id));
  }

  listSessionsPage(principal: Principal, options: ListOptions): { items: LogicalSessionSummary[]; nextCursor: string | null; total: number } {
    const limit = pageLimit(options.limit);
    const scope = JSON.stringify(["sessions",principal.workspaceId,options.machineId??null,options.projectId??null,options.q??null,options.executionState??null,options.managed??null]);
    const cursor = parsePageCursor(options.cursor,scope);
    const where = ["s.workspace_id=?", "m.identity_state='active'", "s.deleted_at IS NULL"];
    const params: Array<string | number> = [principal.workspaceId];
    if(options.machineId) { where.push("s.machine_id=?"); params.push(options.machineId); }
    if(options.projectId) { where.push("s.project_id=?"); params.push(options.projectId); }
    if(options.q) { where.push("(instr(lower(s.title),lower(?))>0 OR instr(lower(p.alias),lower(?))>0 OR instr(lower(p.canonical_root),lower(?))>0 OR instr(lower(m.name),lower(?))>0 OR instr(lower(coalesce(m.display_alias,'')),lower(?))>0 OR instr(lower(coalesce(s.session_cwd,'')),lower(?))>0)"); params.push(options.q,options.q,options.q,options.q,options.q,options.q); }
    if(options.executionState) { where.push("s.execution_state=?"); params.push(options.executionState); }
    if(options.managed!==undefined) { where.push("s.managed=?"); params.push(options.managed?1:0); }
    const total = this.db.get<{ count:number }>(`SELECT count(*) AS count FROM logical_sessions s JOIN machines m ON m.machine_id=s.machine_id JOIN projects p ON p.project_id=s.project_id WHERE ${where.join(" AND ")}`, ...params)!.count;
    if(cursor) { where.push("(s.updated_at<? OR (s.updated_at=? AND s.logical_session_id<?))"); params.push(cursor[0]!,cursor[0]!,cursor[1]!); }
    const rows = this.db.all<{ logical_session_id:string;updated_at:string }>(`SELECT s.logical_session_id,s.updated_at FROM logical_sessions s JOIN machines m ON m.machine_id=s.machine_id JOIN projects p ON p.project_id=s.project_id WHERE ${where.join(" AND ")} ORDER BY s.updated_at DESC,s.logical_session_id DESC LIMIT ?`,...params,limit+1);
    const visible=rows.slice(0,limit); const last=visible.at(-1);
    return { items:visible.map((row)=>this.getSession(principal,row.logical_session_id)),nextCursor:rows.length>limit&&last?pageCursor(scope,[last.updated_at,last.logical_session_id]):null,total };
  }

  getSession(principal: Principal, logicalSessionId: string): LogicalSessionSummary {
    invariant(!this.db.get("SELECT 1 FROM logical_sessions WHERE logical_session_id=? AND workspace_id=? AND deleted_at IS NOT NULL",logicalSessionId,principal.workspaceId),410,"SESSION_DELETED","主机已确认永久删除此会话");
    const lease = this.currentLease(principal, logicalSessionId);
    const row = this.db.get<{
      logical_session_id: string;
      machine_id: string;
      project_id: string;
      title: string;
      managed: number;
      execution_state: LogicalSessionSummary["executionState"];
      reachability: LogicalSessionSummary["reachability"];
      thread_control_version: number;
      turn_control_version: number;
      project_lease_version: number;
      active_turn_id: string | null;
      projection_epoch: number;
      next_session_seq: number;
      control_lease_version: number;
      content_epoch: number;
      queue_version: number;
      updated_at: string;
      execution_segment_id: string;
      native_thread_id: string | null;
      history_completeness: "complete" | "partial" | "unknown";
      history_mode: "legacy" | "paginated" | null;
      management_revision: number;
      codex_profile_id: string;
      session_cwd: string | null;
      runtime_settings_json: string | null;
      project_alias: string;
      canonical_root: string;
      recorded_tokens: number | null;
    }>(
      `SELECT s.*,e.execution_segment_id,e.native_thread_id,e.history_completeness,e.history_mode,
        p.lease_version AS project_lease_version,p.alias AS project_alias,p.canonical_root,json_extract(u.recorded_json,'$.totalTokens') AS recorded_tokens FROM logical_sessions s
       JOIN execution_segments e ON e.logical_session_id=s.logical_session_id AND e.ended_at IS NULL
       JOIN projects p ON p.project_id=s.project_id
       LEFT JOIN session_usage u ON u.logical_session_id=s.logical_session_id
       WHERE s.logical_session_id=? AND s.workspace_id=? AND s.deleted_at IS NULL ORDER BY e.created_at DESC LIMIT 1`,
      logicalSessionId,
      principal.workspaceId,
    );
    invariant(row, 404, "SESSION_NOT_FOUND", "Logical Session was not found");
    return {
      logicalSessionId: row.logical_session_id,
      recordedTokens: row.recorded_tokens,
      machineId: row.machine_id,
      imageInputSupported: JSON.parse(this.db.get<{ codex_catalog_json: string | null }>("SELECT codex_catalog_json FROM machines WHERE machine_id=?", row.machine_id)?.codex_catalog_json ?? "null")?.imageInput === true,
      cloudImageRevision: this.db.get<{ cloud_image_revision: number }>("SELECT cloud_image_revision FROM machines WHERE machine_id=?", row.machine_id)?.cloud_image_revision ?? 0,
      projectId: row.project_id,
      executionSegmentId: row.execution_segment_id,
      title: row.title,
      nativeThreadId: row.native_thread_id,
      historyCompleteness: row.history_completeness,
      historyMode: row.history_mode ?? "unknown",
      managed: row.managed === 1,
      executionState: row.execution_state,
      reachability: row.reachability,
      threadControlVersion: row.thread_control_version,
      turnControlVersion: row.turn_control_version,
      projectLeaseVersion: row.project_lease_version,
      activeTurnId: row.active_turn_id,
      projectionEpoch: row.projection_epoch,
      latestSessionSeq: row.next_session_seq - 1,
      contentEpoch: row.content_epoch,
      controlLeaseVersion: row.control_lease_version,
      queueVersion: row.queue_version,
      controlLease: lease,
      updatedAt: row.updated_at,
      managementRevision: row.management_revision,
      codexProfileId: row.codex_profile_id,
      sessionCwd: row.session_cwd,
      runtimeSettings: row.runtime_settings_json ? parseRuntimeSettings(JSON.parse(row.runtime_settings_json)) : null,
      projectAlias: row.project_alias,
      canonicalRoot: row.canonical_root,
      actions: sessionActions(this.db, logicalSessionId, principal.clientSessionId),
    };
  }

  currentLease(principal: Principal, logicalSessionId: string): ControlLeaseView | null {
    const timestamp = nowIso();
    const expired = this.db.get<{ control_lease_id: string; holder_client_session_id: string }>(
      `SELECT l.control_lease_id,l.holder_client_session_id FROM control_leases l
       JOIN logical_sessions s ON s.logical_session_id=l.logical_session_id
       WHERE l.logical_session_id=? AND s.workspace_id=? AND l.state='active' AND l.expires_at<=?`,
      logicalSessionId,
      principal.workspaceId,
      timestamp,
    );
    if (expired) {
      this.db.run(
        `UPDATE control_leases SET state='expired',version=version+1,ended_at=?
         WHERE control_lease_id=? AND state='active'`,
        timestamp,
        expired.control_lease_id,
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
        controlLeaseId: expired.control_lease_id,
        action: "control_lease.expire",
        metadata: { previousHolderClientSessionId: expired.holder_client_session_id },
      });
    }
    const row = this.db.get<{
      control_lease_id: string;
      logical_session_id: string;
      holder_client_session_id: string;
      version: number;
      expires_at: string;
      state: ControlLeaseView["state"];
    }>(
      `SELECT l.* FROM control_leases l JOIN logical_sessions s ON s.logical_session_id=l.logical_session_id
       WHERE l.logical_session_id=? AND s.workspace_id=? AND l.state='active'`,
      logicalSessionId,
      principal.workspaceId,
    );
    return row
      ? {
          leaseId: row.control_lease_id,
          logicalSessionId: row.logical_session_id,
          holderClientSessionId: row.holder_client_session_id,
          isMine: sameLeaseAccount(this.db, row.holder_client_session_id, principal.clientSessionId),
          version: row.version,
          expiresAt: row.expires_at,
          state: row.state,
        }
      : null;
  }

  dashboard(principal: Principal): Record<string, unknown> {
    const machines = this.listMachines(principal);
    const sessions = this.listSessions(principal);
    const pendingApprovals = this.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM approvals a JOIN logical_sessions s ON s.logical_session_id=a.logical_session_id
       JOIN machines m ON m.machine_id=s.machine_id
       WHERE s.workspace_id=? AND m.identity_state='active' AND a.state='pending'`,
      principal.workspaceId,
    )?.count ?? 0;
    const unresolvedAlerts = this.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM security_alerts WHERE workspace_id=? AND resolved_at IS NULL",
      principal.workspaceId,
    )?.count ?? 0;
    return {
      counts: {
        machines: machines.length,
        onlineMachines: machines.filter((machine) => machine.reachability === "online").length,
        sessions: sessions.length,
        activeSessions: sessions.filter((session) => ["running", "awaiting_approval"].includes(session.executionState)).length,
        pendingApprovals,
        unresolvedAlerts,
      },
      machines,
      recentSessions: sessions.slice(0, 20),
      activitySessions: sessions.filter(session => session.managed || ["running", "awaiting_approval"].includes(session.executionState)),
      compatibilityProfile: CODEX_COMPATIBILITY_PROFILE,
    };
  }
}
