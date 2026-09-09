import type { MachineIdentity } from "./identity.js";
import type { StateStore } from "./store.js";
import type { PairingCredential } from "./types.js";
import { apiUrl, postJson, requireSuccess } from "./http.js";
import { AgentError } from "./errors.js";

export async function renewCredential(store: StateStore, identity: MachineIdentity, signal?: AbortSignal): Promise<PairingCredential> {
  const pairing = store.snapshot().pairing;
  if (!pairing) throw new AgentError("NOT_PAIRED", "agent is not paired");
  const auth = { machineId: pairing.machineId, agentToken: pairing.agentToken };
  const challenge = requireSuccess(await postJson(apiUrl(pairing.controlPlaneUrl, "/api/agent/credentials/renew/challenge"), auth,
    signal ? { signal } : {}), "credential renewal challenge");
  if (typeof challenge.challengeId !== "string" || typeof challenge.message !== "string" || typeof challenge.expiresAt !== "string" || Date.parse(challenge.expiresAt) <= Date.now()) {
    throw new AgentError("CREDENTIAL_CHALLENGE_INVALID", "renewal challenge is incomplete or expired");
  }
  const renewed = requireSuccess(await postJson(apiUrl(pairing.controlPlaneUrl, "/api/agent/credentials/renew"), {
    ...auth, challengeId: challenge.challengeId, signature: identity.sign(challenge.message),
  }, signal ? { signal } : {}), "credential renewal");
  if (renewed.machineId !== pairing.machineId || typeof renewed.agentToken !== "string" || typeof renewed.credentialExpiresAt !== "string" || Date.parse(renewed.credentialExpiresAt) <= Date.now()) {
    throw new AgentError("CREDENTIAL_RESPONSE_INVALID", "renewed credential identity or expiry is invalid");
  }
  const next = { ...pairing, agentToken: renewed.agentToken, credentialExpiresAt: renewed.credentialExpiresAt };
  await store.setPairing(next);
  return next;
}

export function shouldRenewCredential(pairing: PairingCredential, now = Date.now()): boolean {
  const expires = Date.parse(pairing.credentialExpiresAt ?? "");
  return Number.isFinite(expires) && expires > now && expires - now < 24 * 60 * 60_000;
}
