import { AgentError } from "./errors.js";
import {
  apiUrl,
  normalizeControlPlaneUrl,
  postJson,
  requireSuccess,
  responseError,
  type JsonResponse,
} from "./http.js";
import type { MachineIdentity } from "./identity.js";
import { parseCredential } from "./pairing.js";
import type { StateStore } from "./store.js";
import type { PairingCredential, SupportReport } from "./types.js";
import { delay, requireString } from "./util.js";
import { AGENT_VERSION } from "./constants.js";

const TICKET_PART = /^[A-Za-z0-9_-]+$/u;
const CLAIM_RETRY_WINDOW_MS = 60_000;
const ENROLLMENT_MAX_WAIT_MS = 15 * 60_000;
const DEFAULT_RECOVERY_WINDOW_MS = 10 * 60_000;
const MAX_RECOVERY_WINDOW_MS = 15 * 60_000;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 5_000;

/**
 * Browser bootstrap tickets are deliberately opaque to the agent. The shape
 * check catches copied URLs and shell quoting mistakes without interpreting or
 * logging either secret component.
 */
export function validateEnrollmentTicket(value: string): string {
  if (value.length > 512) throw new AgentError("ENROLLMENT_TICKET_INVALID", "enrollment ticket is too long");
  const separator = value.indexOf(".");
  if (
    separator < 1 ||
    separator !== value.lastIndexOf(".") ||
    separator > 256 ||
    value.length - separator - 1 < 16 ||
    !TICKET_PART.test(value.slice(0, separator)) ||
    !TICKET_PART.test(value.slice(separator + 1))
  ) {
    throw new AgentError(
      "ENROLLMENT_TICKET_INVALID",
      "enrollment ticket must have the '<enrollment-id>.<bootstrap-secret>' format",
    );
  }
  return value;
}

export function enrollmentIdFromTicket(value: string): string {
  const valid = validateEnrollmentTicket(value);
  return valid.slice(0, valid.indexOf("."));
}

interface EnrollmentClaim {
  preauthorized: boolean;
  enrollmentId: string;
  claimToken: string;
  proofMessage: string;
  verificationPhrase: string;
  expiresAtMs: number;
  recoveryWindowMs: number;
  intervalMs: number;
}

function parseExpiry(value: unknown): number {
  if (typeof value !== "string") throw new AgentError("CONTROL_PLANE_RESPONSE_INVALID", "expiresAt is required");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new AgentError("CONTROL_PLANE_RESPONSE_INVALID", "expiresAt is invalid");
  return parsed;
}

function parseClaim(body: Record<string, unknown>, identity: MachineIdentity): EnrollmentClaim {
  const returnedFingerprint = requireString(body.publicKeyFingerprint, "publicKeyFingerprint", { maxLength: 256 });
  if (returnedFingerprint !== identity.metadata.fingerprint) {
    throw new AgentError(
      "ENROLLMENT_IDENTITY_MISMATCH",
      "control plane returned a fingerprint for a different machine identity",
    );
  }
  return {
    preauthorized: body.preauthorized === true,
    enrollmentId: requireString(body.enrollmentId, "enrollmentId", { maxLength: 256 }),
    claimToken: requireString(body.claimToken, "claimToken", { maxLength: 16_384 }),
    proofMessage: requireString(body.proofMessage ?? body.proofChallenge, "proofMessage", { maxLength: 16_384 }),
    verificationPhrase: requireString(body.verificationPhrase, "verificationPhrase", { maxLength: 256 }),
    expiresAtMs: Math.min(parseExpiry(body.expiresAt), Date.now() + ENROLLMENT_MAX_WAIT_MS),
    recoveryWindowMs:
      typeof body.recoveryWindowSeconds === "number" && Number.isFinite(body.recoveryWindowSeconds)
        ? Math.min(MAX_RECOVERY_WINDOW_MS, Math.max(0, body.recoveryWindowSeconds * 1_000))
        : DEFAULT_RECOVERY_WINDOW_MS,
    intervalMs:
      typeof body.interval === "number" && Number.isFinite(body.interval)
        ? Math.min(30_000, Math.max(1_000, body.interval * 1_000))
        : 2_000,
  };
}

export interface EnrollmentDisplay {
  preauthorized?: boolean;
  fingerprint: string;
  verificationPhrase: string;
  expiresAt: string;
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new AgentError("PAIRING_CANCELLED", "onboarding cancelled");
}

async function claimWithRetry(options: {
  url: URL;
  body: Record<string, unknown>;
  identity: MachineIdentity;
  expectedEnrollmentId: string;
  signal?: AbortSignal;
}): Promise<EnrollmentClaim> {
  const deadline = Date.now() + CLAIM_RETRY_WINDOW_MS;
  let backoffMs = RETRY_BASE_MS;
  let lastFailure: unknown = new AgentError("CONTROL_PLANE_UNAVAILABLE", "enrollment claim could not reach the control plane");
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    try {
      const response = await postJson(
        options.url,
        options.body,
        {
          timeoutMs: Math.max(1, Math.min(15_000, deadline - Date.now())),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      if (response.status >= 500 || response.status === 429) {
        lastFailure = new AgentError(
          "CONTROL_PLANE_UNAVAILABLE",
          `enrollment claim received retryable HTTP ${response.status}`,
        );
        const retryMs = response.retryAfterMs ?? backoffMs;
        await delay(Math.min(retryMs, Math.max(1, deadline - Date.now())), options.signal);
      } else {
        const body = requireSuccess(response, "enrollment claim");
        try {
          const claim = parseClaim(body, options.identity);
          if (claim.enrollmentId !== options.expectedEnrollmentId) {
            throw new AgentError("ENROLLMENT_ID_MISMATCH", "control plane returned a different enrollment identifier");
          }
          return claim;
        } catch (error) {
          if (
            error instanceof AgentError &&
            error.code !== "CONTROL_PLANE_RESPONSE_INVALID"
          ) throw error;
          if (!(error instanceof TypeError) && !(error instanceof AgentError)) throw error;
          lastFailure = new AgentError("CONTROL_PLANE_UNAVAILABLE", "enrollment claim returned an incomplete success response");
          await delay(Math.min(backoffMs, Math.max(1, deadline - Date.now())), options.signal);
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      if (!(error instanceof AgentError) || error.code !== "HTTP_FAILED") throw error;
      lastFailure = error;
      await delay(Math.min(backoffMs, Math.max(1, deadline - Date.now())), options.signal);
    }
    backoffMs = Math.min(RETRY_MAX_MS, backoffMs * 2);
  }
  throw lastFailure;
}

/** Claim a browser-created, single-use enrollment and wait for browser confirmation. */
export async function enrollMachine(options: {
  store: StateStore;
  identity: MachineIdentity;
  support: SupportReport;
  url: string;
  ticket: string;
  name: string;
  signal?: AbortSignal;
  onDisplay: (display: EnrollmentDisplay) => void;
}): Promise<PairingCredential> {
  if (options.identity.metadata.credentialProtectionLevel === "unknown") {
    throw new AgentError("CREDENTIAL_PROTECTION_UNKNOWN", "pairing is read-only because key protection is unknown");
  }
  if (options.store.snapshot().pairing) {
    throw new AgentError("ALREADY_PAIRED", "this installation is already paired; revoke it before replacing its identity");
  }
  const controlPlaneUrl = normalizeControlPlaneUrl(options.url);
  const ticket = validateEnrollmentTicket(options.ticket);
  const expectedEnrollmentId = enrollmentIdFromTicket(ticket);
  const claim = await claimWithRetry({
    url: apiUrl(controlPlaneUrl, "/api/agent/enrollments/claim"),
    body: {
      ticket,
      publicKey: options.identity.metadata.publicKey,
      name: options.name,
      platform: options.support.platform,
      platformRelease: options.support.osVersion,
      architecture: options.support.architecture,
      agentVersion: AGENT_VERSION,
    },
    identity: options.identity,
    expectedEnrollmentId,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (claim.expiresAtMs <= Date.now()) throw new AgentError("ENROLLMENT_EXPIRED", "enrollment expired before confirmation");
  options.onDisplay({
    preauthorized: claim.preauthorized,
    fingerprint: options.identity.metadata.fingerprint,
    verificationPhrase: claim.verificationPhrase,
    expiresAt: new Date(claim.expiresAtMs).toISOString(),
  });

  const signature = options.identity.sign(claim.proofMessage);
  let intervalMs = claim.intervalMs;
  let transportBackoffMs = RETRY_BASE_MS;
  const recoveryDeadlineMs = claim.expiresAtMs + claim.recoveryWindowMs;
  while (Date.now() < recoveryDeadlineMs) {
    let exchange: JsonResponse;
    try {
      exchange = await postJson(
        apiUrl(controlPlaneUrl, "/api/agent/enrollments/exchange"),
        {
          enrollmentId: claim.enrollmentId,
          claimToken: claim.claimToken,
          signature,
        },
        {
          timeoutMs: Math.max(1, Math.min(15_000, recoveryDeadlineMs - Date.now())),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      if (!(error instanceof AgentError) || error.code !== "HTTP_FAILED") throw error;
      await delay(Math.min(transportBackoffMs, Math.max(1, recoveryDeadlineMs - Date.now())), options.signal);
      transportBackoffMs = Math.min(RETRY_MAX_MS, transportBackoffMs * 2);
      continue;
    }
    const failure = responseError(exchange);
    if (
      exchange.status === 202 ||
      failure.code === "ENROLLMENT_NOT_CONFIRMED" ||
      failure.code === "authorization_pending"
    ) {
      await delay(Math.min(intervalMs, Math.max(1, recoveryDeadlineMs - Date.now())), options.signal);
      transportBackoffMs = RETRY_BASE_MS;
      continue;
    }
    if (exchange.status === 429 || failure.code === "slow_down") {
      intervalMs = Math.min(30_000, exchange.retryAfterMs ?? intervalMs + 1_000);
      await delay(Math.min(intervalMs, Math.max(1, recoveryDeadlineMs - Date.now())), options.signal);
      continue;
    }
    if (exchange.status >= 500) {
      await delay(Math.min(transportBackoffMs, Math.max(1, recoveryDeadlineMs - Date.now())), options.signal);
      transportBackoffMs = Math.min(RETRY_MAX_MS, transportBackoffMs * 2);
      continue;
    }
    let parsed: PairingCredential;
    try {
      parsed = parseCredential(
        requireSuccess(exchange, "enrollment exchange"),
        controlPlaneUrl,
        options.name,
        claim.verificationPhrase,
      );
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      await delay(Math.min(transportBackoffMs, Math.max(1, recoveryDeadlineMs - Date.now())), options.signal);
      transportBackoffMs = Math.min(RETRY_MAX_MS, transportBackoffMs * 2);
      continue;
    }
    const credential: PairingCredential = { ...parsed, enrollmentId: claim.enrollmentId };
    await options.store.setPairing(credential);
    return credential;
  }
  throw new AgentError("ENROLLMENT_EXPIRED", "enrollment expired before browser confirmation");
}
