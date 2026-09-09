import { AgentError } from "./errors.js";
import { apiUrl, normalizeControlPlaneUrl, postJson, requireSuccess, validateWebSocketUrl } from "./http.js";
import type { MachineIdentity } from "./identity.js";
import type { PairingCredential } from "./types.js";
import { requireString } from "./util.js";

export interface ConnectionTicket {
  wsUrl: string;
  ticket: string;
  transportGeneration: number;
  expiresAt: string;
}

export async function obtainConnectionTicket(options: {
  pairing: PairingCredential;
  identity: MachineIdentity;
  producerEpoch: string;
  requestedUrl: string;
  transportGeneration: number;
  signal?: AbortSignal;
}): Promise<ConnectionTicket> {
  const requestedUrl = normalizeControlPlaneUrl(options.requestedUrl);
  if (requestedUrl !== options.pairing.controlPlaneUrl) {
    throw new AgentError("CONTROL_PLANE_MISMATCH", "run URL differs from the paired control plane; refusing to disclose credentials");
  }
  const commonOptions = { ...(options.signal === undefined ? {} : { signal: options.signal }) };
  const challengeResponse = await postJson(
    apiUrl(requestedUrl, "/api/agent/auth/challenge"),
    {
      machineId: options.pairing.machineId,
      agentToken: options.pairing.agentToken,
      transportGeneration: options.transportGeneration,
    },
    commonOptions,
  );
  const challenge = requireSuccess(challengeResponse, "connection challenge");
  const challengeId = requireString(challenge.challengeId, "challengeId", { maxLength: 256 });
  const proofMessage = requireString(challenge.message ?? challenge.proofMessage ?? challenge.challenge, "message", { maxLength: 16_384 });
  const transportGeneration = options.transportGeneration;
  const expiresAt = requireString(challenge.expiresAt, "expiresAt", { maxLength: 128 });
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
    throw new AgentError("CHALLENGE_EXPIRED", "control-plane challenge is already expired");
  }
  const ticketResponse = await postJson(
    apiUrl(requestedUrl, "/api/agent/auth/ticket"),
    {
      machineId: options.pairing.machineId,
      challengeId,
      transportGeneration,
      signature: options.identity.sign(proofMessage),
    },
    commonOptions,
  );
  const ticketBody = requireSuccess(ticketResponse, "connection ticket exchange");
  const derivedRelayUrl = new URL(requestedUrl);
  derivedRelayUrl.protocol = derivedRelayUrl.protocol === "https:" ? "wss:" : "ws:";
  derivedRelayUrl.pathname = `${derivedRelayUrl.pathname.replace(/\/+$/, "")}/ws/agent`;
  derivedRelayUrl.search = "";
  const wsUrl = validateWebSocketUrl(
    typeof ticketBody.wsUrl === "string" ? ticketBody.wsUrl : derivedRelayUrl.toString(),
  );
  const ticket = requireString(ticketBody.ticket, "ticket", { maxLength: 16_384 });
  const ticketExpiresAt = requireString(ticketBody.expiresAt, "expiresAt", { maxLength: 128 });
  if (!Number.isFinite(Date.parse(ticketExpiresAt)) || Date.parse(ticketExpiresAt) <= Date.now()) {
    throw new AgentError("TICKET_EXPIRED", "WebSocket ticket is already expired");
  }
  wsUrl.searchParams.set("ticket", ticket);
  return { wsUrl: wsUrl.toString(), ticket, transportGeneration, expiresAt: ticketExpiresAt };
}
