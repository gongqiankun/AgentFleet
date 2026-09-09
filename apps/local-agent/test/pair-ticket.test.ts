import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadOrCreateIdentity } from "../src/identity.js";
import { pairMachine } from "../src/pairing.js";
import { StateStore } from "../src/store.js";
import { obtainConnectionTicket } from "../src/ticket.js";
import type { SupportReport } from "../src/types.js";

const support: SupportReport = {
  supported: true,
  writable: true,
  readOnlyReasons: [],
  platform: "linux",
  architecture: "x64",
  osId: "ubuntu",
  osVersion: "24.04",
  uid: 1000,
  nodeVersion: "v24.0.0",
  codexVersion: "0.153.2",
  codexSchemaHash: "schema",
  expectedCodexSchemaHash: "schema",
};

test("pair and ticket requests follow the control-plane proof contracts", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-pair-test-"));
  const store = new StateStore(directory);
  await store.initialize();
  const identity = await loadOrCreateIdentity(store);
  const publicKey = createPublicKey({
    key: Buffer.from(identity.metadata.publicKey, "base64url"),
    format: "der",
    type: "spki",
  });
  let initBody: Record<string, unknown> | undefined;
  let exchangeSignatureValid = false;
  let challengeSignatureValid = false;
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const origin = "http://127.0.0.1:3215";
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const respond = (status: number, value: Record<string, unknown>) => Response.json(value, { status });
    if (url.pathname === "/api/agent/pairing/init") {
      initBody = parsed;
      return respond(200, {
        pairingId: "pair-1",
        userCode: "ABCD-EFGH",
        verificationUrl: `${origin}/pair`,
        verificationPhrase: "amber-birch-cedar-delta",
        proofMessage: "pair-proof-message",
        expiresIn: 30,
        interval: 0.001,
      });
    }
    if (url.pathname === "/api/agent/pairing/exchange") {
      exchangeSignatureValid = verify(
        null,
        Buffer.from("pair-proof-message"),
        publicKey,
        Buffer.from(String(parsed.signature), "base64url"),
      );
      return respond(200, {
        machineId: "machine-1",
        agentToken: "agent-token-secret",
        credentialExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
    }
    if (url.pathname === "/api/agent/auth/challenge") {
      assert.deepEqual(parsed, {
        machineId: "machine-1",
        agentToken: "agent-token-secret",
        transportGeneration: 7,
      });
      return respond(200, {
        challengeId: "challenge-1",
        message: "ws-proof-message",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
    }
    if (url.pathname === "/api/agent/auth/ticket") {
      challengeSignatureValid = verify(
        null,
        Buffer.from("ws-proof-message"),
        publicKey,
        Buffer.from(String(parsed.signature), "base64url"),
      );
      assert.equal(parsed.transportGeneration, 7);
      return respond(200, {
        ticket: "short-lived-ticket",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
    }
    return respond(404, { code: "NOT_FOUND" });
  };
  let displayed = false;
  const paired = await pairMachine({
    store,
    identity,
    support,
    url: origin,
    name: "test-machine",
    onDisplay(display) {
      displayed = true;
      assert.equal(display.userCode, "ABCD-EFGH");
      assert.equal(display.fingerprint, identity.metadata.fingerprint);
      assert.equal(display.verificationPhrase, "amber-birch-cedar-delta");
    },
  });
  assert.equal(displayed, true);
  assert.equal(exchangeSignatureValid, true);
  assert.equal(paired.agentToken, "agent-token-secret");
  assert.equal(initBody?.name, "test-machine");
  assert.equal(typeof initBody?.deviceCode, "string");
  assert.equal(initBody?.publicKey, identity.metadata.publicKey);

  const ticket = await obtainConnectionTicket({
    pairing: paired,
    identity,
    producerEpoch: "producer-1",
    requestedUrl: origin,
    transportGeneration: 7,
  });
  assert.equal(challengeSignatureValid, true);
  assert.equal(ticket.transportGeneration, 7);
  assert.equal(new URL(ticket.wsUrl).pathname, "/ws/agent");
  assert.equal(new URL(ticket.wsUrl).searchParams.get("ticket"), "short-lived-ticket");
});
