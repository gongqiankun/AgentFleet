import { randomBytes } from "node:crypto";
import { AGENT_VERSION } from "./constants.js";
import { AgentError } from "./errors.js";
import { apiUrl, normalizeControlPlaneUrl, postJson, requireSuccess, responseError } from "./http.js";
import type { MachineIdentity } from "./identity.js";
import type { StateStore } from "./store.js";
import type { PairingCredential, SupportReport } from "./types.js";
import { delay, nowIso, requireString } from "./util.js";

interface PairingInit {
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  verificationPhrase: string;
  expiresAtMs: number;
  intervalMs: number;
  proofMessage: string;
}

function parseExpiry(body: Record<string, unknown>, fallbackMs: number): number {
  if (typeof body.expiresAt === "string") {
    const value = Date.parse(body.expiresAt);
    if (Number.isFinite(value)) return value;
  }
  if (typeof body.expiresIn === "number" && Number.isFinite(body.expiresIn)) {
    return Date.now() + Math.max(1, body.expiresIn) * 1_000;
  }
  return Date.now() + fallbackMs;
}

function parseInit(body: Record<string, unknown>, localPhrase: string): PairingInit {
  const verificationPhrase =
    typeof body.verificationPhrase === "string" ? body.verificationPhrase : localPhrase;
  return {
    deviceCode: "",
    userCode: requireString(body.userCode, "userCode", { maxLength: 64 }),
    verifyUrl: requireString(body.verifyUrl ?? body.verificationUrl ?? body.verificationUri, "verifyUrl", { maxLength: 2_048 }),
    verificationPhrase,
    expiresAtMs: parseExpiry(body, 10 * 60_000),
    intervalMs:
      typeof body.interval === "number" && Number.isFinite(body.interval)
        ? Math.min(30_000, Math.max(1_000, body.interval * 1_000))
        : 2_000,
    proofMessage: requireString(body.proofMessage, "proofMessage", { maxLength: 16_384 }),
  };
}

export function parseCredential(
  body: Record<string, unknown>,
  controlPlaneUrl: string,
  machineName: string,
  verificationPhrase: string,
): PairingCredential {
  const agentToken = body.agentToken ?? body.machineCredential ?? body.machineToken;
  const returnedName = body.machineName ?? body.name;
  const effectiveMachineName = typeof returnedName === "string"
    ? requireString(returnedName.trim(), "machineName", { maxLength: 120 })
    : machineName;
  return {
    controlPlaneUrl,
    machineId: requireString(body.machineId, "machineId", { maxLength: 256 }),
    ...(typeof body.workspaceId === "string" ? { workspaceId: body.workspaceId } : {}),
    agentToken: requireString(agentToken, "agentToken", { maxLength: 16_384 }),
    ...(typeof body.credentialExpiresAt === "string" ? { credentialExpiresAt: body.credentialExpiresAt } : {}),
    pairedAt: nowIso(),
    machineName: effectiveMachineName,
    verificationPhrase,
  };
}

export interface PairDisplay {
  userCode: string;
  verifyUrl: string;
  fingerprint: string;
  verificationPhrase: string;
  expiresAt: string;
}

export async function pairMachine(options: {
  store: StateStore;
  identity: MachineIdentity;
  support: SupportReport;
  url: string;
  name: string;
  signal?: AbortSignal;
  onDisplay: (display: PairDisplay) => void;
}): Promise<PairingCredential> {
  if (options.identity.metadata.credentialProtectionLevel === "unknown") {
    throw new AgentError("CREDENTIAL_PROTECTION_UNKNOWN", "pairing is read-only because key protection is unknown");
  }
  if (options.store.snapshot().pairing) {
    throw new AgentError("ALREADY_PAIRED", "this installation is already paired; reinstallation/revocation is required to replace identity");
  }
  const controlPlaneUrl = normalizeControlPlaneUrl(options.url);
  const deviceCode = randomBytes(32).toString("base64url");
  const initResponse = await postJson(
    apiUrl(controlPlaneUrl, "/api/agent/pairing/init"),
    {
      deviceCode,
      publicKey: options.identity.metadata.publicKey,
      name: options.name,
      platform: options.support.platform,
      platformRelease: options.support.osVersion,
      architecture: options.support.architecture,
      agentVersion: AGENT_VERSION,
    },
    { ...(options.signal === undefined ? {} : { signal: options.signal }) },
  );
  const init = parseInit(requireSuccess(initResponse, "pairing initialization"), options.identity.metadata.verificationPhrase);
  init.deviceCode = deviceCode;
  const verifyUrl = new URL(init.verifyUrl);
  if (verifyUrl.protocol !== "https:" && verifyUrl.hostname !== "localhost" && verifyUrl.hostname !== "127.0.0.1") {
    throw new AgentError("VERIFY_URL_INSECURE", "verification URL must use HTTPS");
  }
  options.onDisplay({
    userCode: init.userCode,
    verifyUrl: init.verifyUrl,
    fingerprint: options.identity.metadata.fingerprint,
    verificationPhrase: init.verificationPhrase,
    expiresAt: new Date(init.expiresAtMs).toISOString(),
  });

  let intervalMs = init.intervalMs;
  while (Date.now() < init.expiresAtMs) {
    await delay(intervalMs, options.signal);
    const response = await postJson(
      apiUrl(controlPlaneUrl, "/api/agent/pairing/exchange"),
      {
        deviceCode: init.deviceCode,
        signature: options.identity.sign(init.proofMessage),
      },
      { ...(options.signal === undefined ? {} : { signal: options.signal }) },
    );
    const code = responseError(response).code;
    if (response.status === 202 || code === "authorization_pending" || code === "PAIRING_NOT_CONFIRMED") continue;
    if (code === "slow_down" || response.status === 429) {
      intervalMs = Math.min(30_000, response.retryAfterMs ?? intervalMs + 1_000);
      continue;
    }
    const credential = parseCredential(
      requireSuccess(response, "pairing exchange"),
      controlPlaneUrl,
      options.name,
      init.verificationPhrase,
    );
    await options.store.setPairing(credential);
    return credential;
  }
  throw new AgentError("PAIRING_EXPIRED", "pairing code expired before browser confirmation");
}
