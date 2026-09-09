import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enrollMachine, validateEnrollmentTicket } from "../src/enrollment.js";
import { loadOrCreateIdentity } from "../src/identity.js";
import { StateStore } from "../src/store.js";
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

test("enrollment ticket shape rejects URLs and ambiguous separators", () => {
  assert.equal(validateEnrollmentTicket("enroll_123.secret_1234567890"), "enroll_123.secret_1234567890");
  assert.throws(() => validateEnrollmentTicket("https://fleet.example/install?t=x"), /enrollment ticket/);
  assert.throws(() => validateEnrollmentTicket("id.secret.with-dot"), /enrollment ticket/);
  assert.throws(() => validateEnrollmentTicket("id.short"), /enrollment ticket/);
});

test("browser enrollment proves the local identity and waits for confirmation", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-enroll-test-"));
  const store = new StateStore(directory);
  await store.initialize();
  context.after(() => store.close());
  const identity = await loadOrCreateIdentity(store);
  const publicKey = createPublicKey({
    key: Buffer.from(identity.metadata.publicKey, "base64url"),
    format: "der",
    type: "spki",
  });
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let exchangeCount = 0;
  let claimCount = 0;
  let observedTicket: unknown;
  let proofValid = false;
  let claimExpiresAt = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url.pathname === "/api/agent/enrollments/claim") {
      claimCount += 1;
      if (claimCount === 1) return new Response("", { status: 200 });
      observedTicket = body.ticket;
      assert.equal(body.publicKey, identity.metadata.publicKey);
      assert.equal(body.name, "workstation");
      claimExpiresAt = Date.now() + 1_200;
      return Response.json({
        enrollmentId: "enroll-1",
        claimToken: "claim-token-secret",
        proofMessage: "sign-this-exact-proof",
        publicKeyFingerprint: identity.metadata.fingerprint,
        verificationPhrase: "amber-birch-cedar-delta",
        expiresAt: new Date(claimExpiresAt).toISOString(),
        recoveryWindowSeconds: 5,
        interval: 0.001,
      });
    }
    if (url.pathname === "/api/agent/enrollments/exchange") {
      exchangeCount += 1;
      assert.equal(body.enrollmentId, "enroll-1");
      assert.equal(body.claimToken, "claim-token-secret");
      proofValid = verify(
        null,
        Buffer.from("sign-this-exact-proof"),
        publicKey,
        Buffer.from(String(body.signature), "base64url"),
      );
      if (exchangeCount === 1) {
        return Response.json({ code: "ENROLLMENT_NOT_CONFIRMED" }, { status: 409 });
      }
      if (exchangeCount === 2) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.error(new Error("simulated credential response loss after headers"));
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (exchangeCount === 3) return Response.json({});
      return Response.json({
        machineId: "machine-enrolled",
        workspaceId: "workspace-1",
        agentToken: "machine-token-secret",
        machineName: "browser-renamed-host",
      });
    }
    return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  };

  let displayed = false;
  const credential = await enrollMachine({
    store,
    identity,
    support,
    url: "http://127.0.0.1:3215",
    ticket: "enroll-1.secret_1234567890",
    name: "workstation",
    onDisplay(display) {
      displayed = true;
      assert.equal(display.fingerprint, identity.metadata.fingerprint);
      assert.equal(display.verificationPhrase, "amber-birch-cedar-delta");
    },
  });

  assert.equal(observedTicket, "enroll-1.secret_1234567890");
  assert.equal(claimCount, 2);
  assert.equal(exchangeCount, 4);
  assert.ok(Date.now() > claimExpiresAt, "credential recovery should continue past the original ticket expiry");
  assert.equal(proofValid, true);
  assert.equal(displayed, true);
  assert.equal(credential.machineId, "machine-enrolled");
  assert.equal(credential.enrollmentId, "enroll-1");
  assert.equal(credential.machineName, "browser-renamed-host");
  assert.equal(store.snapshot().pairing?.agentToken, "machine-token-secret");
});

test("enrollment fails closed when the server reports another fingerprint", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-enroll-mismatch-"));
  const store = new StateStore(directory);
  await store.initialize();
  context.after(() => store.close());
  const identity = await loadOrCreateIdentity(store);
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => Response.json({
    enrollmentId: "enroll-1",
    claimToken: "claim-token-secret",
    proofMessage: "proof",
    publicKeyFingerprint: "sha256:different",
    verificationPhrase: "amber-birch-cedar-delta",
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  });
  await assert.rejects(
    enrollMachine({
      store,
      identity,
      support,
      url: "http://127.0.0.1:3215",
      ticket: "enroll-1.secret_1234567890",
      name: "workstation",
      onDisplay() {},
    }),
    /different machine identity/,
  );
});

test("enrollment does not retry an explicit non-pending conflict", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-enroll-cancelled-"));
  const store = new StateStore(directory);
  await store.initialize();
  context.after(() => store.close());
  const identity = await loadOrCreateIdentity(store);
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let exchanges = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith("/claim")) {
      return Response.json({
        enrollmentId: "enroll-1",
        claimToken: "claim-token-secret",
        proofMessage: "proof",
        publicKeyFingerprint: identity.metadata.fingerprint,
        verificationPhrase: "amber-birch-cedar-delta",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
    }
    exchanges += 1;
    return Response.json(
      { code: "ENROLLMENT_CANCELLED", message: "Enrollment was cancelled" },
      { status: 409 },
    );
  };
  await assert.rejects(
    enrollMachine({
      store,
      identity,
      support,
      url: "http://127.0.0.1:3215",
      ticket: "enroll-1.secret_1234567890",
      name: "workstation",
      onDisplay() {},
    }),
    /cancelled/,
  );
  assert.equal(exchanges, 1);
});
