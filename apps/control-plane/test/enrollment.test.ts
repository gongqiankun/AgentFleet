import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { ControlPlaneConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { sha256 } from "../src/crypto.js";
import { buildControlPlane, cookieFromSetCookie, csrfHeaders } from "../src/server.js";

const origin = "http://control-plane.test";

function config(): ControlPlaneConfig {
  return {
    host: "127.0.0.1",
    port: 3000,
    databasePath: ":memory:",
    publicOrigin: origin,
    allowedOrigins: new Set([origin]),
    adminEmail: "admin@example.test",
    adminPassword: "correct horse battery staple",
    cookieName: "agentfleet_enrollment_test",
    cookieSecure: false,
    sessionTtlSeconds: 3600,
    controlLeaseTtlSeconds: 45,
    pairTtlSeconds: 600,
    challengeTtlSeconds: 60,
    ticketTtlSeconds: 30,
    heartbeatOfflineSeconds: 45,
    logLevel: "silent",
  };
}

function json<T>(body: string): T {
  return JSON.parse(body) as T;
}

function errorCode(body: string): string {
  return json<{ error: { code: string } }>(body).error.code;
}

async function login(app: Awaited<ReturnType<typeof buildControlPlane>>["app"]): Promise<{
  cookie: string;
  headers: Record<string, string>;
  clientSessionId: string;
}> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin, "content-type": "application/json" },
    payload: { email: "admin@example.test", password: "correct horse battery staple" },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = json<{ csrfToken: string; clientSessionId: string }>(response.body);
  const cookie = cookieFromSetCookie(response.headers["set-cookie"]);
  return {
    cookie,
    headers: { cookie, ...csrfHeaders(body.csrfToken, origin) },
    clientSessionId: body.clientSessionId,
  };
}

function claimPayload(ticket: string, publicKey: string): Record<string, unknown> {
  return {
    ticket,
    publicKey,
    name: "bootstrap-host",
    platform: "linux",
    platformRelease: "24.04",
    architecture: "x86_64",
    agentVersion: "0.3.0",
  };
}

test("guided enrollment redeems with proof and renews credentials idempotently", async (t) => {
  const { app, db } = await buildControlPlane(config());
  t.after(async () => app.close());
  const owner = await login(app);
  const created = await app.inject({ method: "POST", url: "/api/enrollments", headers: owner.headers, payload: { preauthorized: true } });
  assert.equal(created.statusCode, 200, created.body);
  const enrollment = created.json();
  const key = generateKeyPairSync("ed25519");
  const claimed = await app.inject({ method: "POST", url: "/api/agent/enrollments/claim", payload: claimPayload(`${enrollment.enrollmentId}.${enrollment.bootstrapSecret}`, key.publicKey.export({ format: "der", type: "spki" }).toString("base64url")) });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const claim = claimed.json();
  assert.equal(claim.preauthorized, true);
  const exchanged = await app.inject({ method: "POST", url: "/api/agent/enrollments/exchange", payload: { enrollmentId: claim.enrollmentId, claimToken: claim.claimToken, signature: sign(null, Buffer.from(claim.proofMessage), key.privateKey).toString("base64url") } });
  assert.equal(exchanged.statusCode, 200, exchanged.body);
  const credential = exchanged.json();
  const auth = { machineId: credential.machineId, agentToken: credential.agentToken };
  const challengeResponse = await app.inject({ method: "POST", url: "/api/agent/credentials/renew/challenge", payload: auth });
  assert.equal(challengeResponse.statusCode, 200, challengeResponse.body);
  const challenge = challengeResponse.json();
  const payload = { ...auth, challengeId: challenge.challengeId, signature: sign(null, Buffer.from(challenge.message), key.privateKey).toString("base64url") };
  const renew = await app.inject({ method: "POST", url: "/api/agent/credentials/renew", payload });
  assert.equal(renew.statusCode, 200, renew.body);
  const retry = await app.inject({ method: "POST", url: "/api/agent/credentials/renew", payload });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.deepEqual(retry.json(), renew.json());
  assert.notEqual(renew.json().agentToken, auth.agentToken);
  const old = db.get<{ expires_at: string }>("SELECT expires_at FROM machine_credentials WHERE token_hash=?", sha256(auth.agentToken));
  assert.ok(Date.parse(old!.expires_at) <= Date.now() + 24 * 60 * 60_000);
  const nextChallenge = await app.inject({ method: "POST", url: "/api/agent/credentials/renew/challenge", payload: { machineId: auth.machineId, agentToken: renew.json().agentToken } });
  assert.equal(nextChallenge.statusCode, 200, nextChallenge.body);
  db.run("UPDATE machines SET reachability='online',maintenance_types_json=? WHERE machine_id=?", JSON.stringify(["catalog.refresh"]), auth.machineId);
  const operationRequest = { method: "POST" as const, url: `/api/machines/${auth.machineId}/operations`, headers: owner.headers, payload: { type: "catalog.refresh", clientMutationId: "refresh-regression-1" } };
  const operation = await app.inject(operationRequest);
  assert.equal(operation.statusCode, 202, operation.body);
  assert.deepEqual((await app.inject(operationRequest)).json(), operation.json());
  db.run("UPDATE machine_operations SET expires_at='2000-01-01T00:00:00.000Z' WHERE machine_id=?", auth.machineId);
  const operations = await app.inject({ method: "GET", url: `/api/machines/${auth.machineId}/operations`, headers: owner.headers });
  assert.equal(operations.statusCode, 200, operations.body);
  assert.equal(operations.json().operations[0].state, "expired");
});

test("browser enrollment binds its session and securely claims, confirms, and exchanges once", async (t) => {
  const { app, db } = await buildControlPlane(config());
  t.after(async () => app.close());
  await app.ready();
  const creator = await login(app);
  const otherSession = await login(app);

  const missingCsrf = await app.inject({
    method: "POST",
    url: "/api/enrollments",
    headers: { cookie: creator.cookie, origin },
    payload: {},
  });
  assert.equal(missingCsrf.statusCode, 403);

  const create = await app.inject({
    method: "POST",
    url: "/api/enrollments",
    headers: creator.headers,
    payload: {},
  });
  assert.equal(create.statusCode, 200, create.body);
  const enrollment = json<{
    enrollmentId: string;
    bootstrapSecret: string;
    status: string;
    expiresAt: string;
  }>(create.body);
  assert.equal(enrollment.status, "created");
  const ticket = `${enrollment.enrollmentId}.${enrollment.bootstrapSecret}`;

  const storedCreated = db.get<{
    bootstrap_secret_hash: string;
    client_session_id: string;
  }>(
    "SELECT bootstrap_secret_hash,client_session_id FROM enrollment_transactions WHERE enrollment_id=?",
    enrollment.enrollmentId,
  );
  assert.notEqual(storedCreated?.bootstrap_secret_hash, enrollment.bootstrapSecret);
  assert.equal(storedCreated?.client_session_id, creator.clientSessionId);

  const crossSessionRead = await app.inject({
    method: "GET",
    url: `/api/enrollments/${enrollment.enrollmentId}`,
    headers: { cookie: otherSession.cookie },
  });
  assert.equal(crossSessionRead.statusCode, 403, crossSessionRead.body);
  assert.equal(errorCode(crossSessionRead.body), "ENROLLMENT_SESSION_MISMATCH");

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyEncoded = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const wrongTicket = `${enrollment.enrollmentId}.${randomBytes(32).toString("base64url")}`;
  const wrongSecret = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/claim",
    payload: claimPayload(wrongTicket, publicKeyEncoded),
  });
  assert.equal(wrongSecret.statusCode, 401, wrongSecret.body);
  assert.equal(errorCode(wrongSecret.body), "ENROLLMENT_TICKET_INVALID");

  const [claim, concurrentClaim] = await Promise.all([
    app.inject({
      method: "POST",
      url: "/api/agent/enrollments/claim",
      payload: claimPayload(ticket, publicKeyEncoded),
    }),
    app.inject({
      method: "POST",
      url: "/api/agent/enrollments/claim",
      payload: claimPayload(ticket, publicKeyEncoded),
    }),
  ]);
  assert.equal(claim.statusCode, 200, claim.body);
  assert.equal(concurrentClaim.statusCode, 200, concurrentClaim.body);
  const claimed = json<{
    enrollmentId: string;
    claimToken: string;
    proofMessage: string;
    verificationPhrase: string;
    publicKeyFingerprint: string;
    status: string;
  }>(claim.body);
  assert.equal(claimed.enrollmentId, enrollment.enrollmentId);
  assert.equal(claimed.status, "claimed");
  assert.ok(claimed.proofMessage.includes(enrollment.enrollmentId));
  assert.equal(json<{ claimToken: string }>(concurrentClaim.body).claimToken, claimed.claimToken);

  const storedClaim = db.get<{
    bootstrap_secret_hash: string;
    claim_token_hash: string;
  }>(
    "SELECT bootstrap_secret_hash,claim_token_hash FROM enrollment_transactions WHERE enrollment_id=?",
    enrollment.enrollmentId,
  );
  assert.notEqual(storedClaim?.bootstrap_secret_hash, enrollment.bootstrapSecret);
  assert.notEqual(storedClaim?.claim_token_hash, claimed.claimToken);
  assert.ok(!JSON.stringify(storedClaim).includes(enrollment.bootstrapSecret));
  assert.ok(!JSON.stringify(storedClaim).includes(claimed.claimToken));

  const replayClaim = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/claim",
    payload: claimPayload(ticket, publicKeyEncoded),
  });
  assert.equal(replayClaim.statusCode, 200, replayClaim.body);
  const replayedClaim = json<typeof claimed>(replayClaim.body);
  assert.deepEqual(
    {
      claimToken: replayedClaim.claimToken,
      proofMessage: replayedClaim.proofMessage,
      verificationPhrase: replayedClaim.verificationPhrase,
      publicKeyFingerprint: replayedClaim.publicKeyFingerprint,
    },
    {
      claimToken: claimed.claimToken,
      proofMessage: claimed.proofMessage,
      verificationPhrase: claimed.verificationPhrase,
      publicKeyFingerprint: claimed.publicKeyFingerprint,
    },
  );

  const { publicKey: otherPublicKey } = generateKeyPairSync("ed25519");
  const conflictingClaim = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/claim",
    payload: claimPayload(
      ticket,
      otherPublicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    ),
  });
  assert.equal(conflictingClaim.statusCode, 409, conflictingClaim.body);
  assert.equal(errorCode(conflictingClaim.body), "ENROLLMENT_CLAIM_KEY_MISMATCH");

  const preview = await app.inject({
    method: "GET",
    url: `/api/enrollments/${enrollment.enrollmentId}`,
    headers: { cookie: creator.cookie },
  });
  assert.equal(preview.statusCode, 200, preview.body);
  const previewBody = json<{
    status: string;
    pairingId: string;
    publicKeyFingerprint: string;
    verificationPhrase: string;
    machine: { name: string; platform: string; platformRelease: string; architecture: string };
  }>(preview.body);
  assert.deepEqual(
    {
      status: previewBody.status,
      pairingId: previewBody.pairingId,
      fingerprint: previewBody.publicKeyFingerprint,
      phrase: previewBody.verificationPhrase,
      machine: previewBody.machine,
    },
    {
      status: "claimed",
      pairingId: enrollment.enrollmentId,
      fingerprint: claimed.publicKeyFingerprint,
      phrase: claimed.verificationPhrase,
      machine: {
        name: "bootstrap-host",
        platform: "linux",
        platformRelease: "24.04",
        architecture: "x86_64",
        agentVersion: "0.3.0",
      },
    },
  );

  const signature = sign(null, Buffer.from(claimed.proofMessage), privateKey).toString("base64url");
  const pendingExchange = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/exchange",
    payload: { enrollmentId: enrollment.enrollmentId, claimToken: claimed.claimToken, signature },
  });
  assert.equal(pendingExchange.statusCode, 409, pendingExchange.body);
  assert.equal(errorCode(pendingExchange.body), "ENROLLMENT_NOT_CONFIRMED");

  const crossSessionConfirm = await app.inject({
    method: "POST",
    url: `/api/enrollments/${enrollment.enrollmentId}/confirm`,
    headers: otherSession.headers,
    payload: { verificationPhrase: claimed.verificationPhrase },
  });
  assert.equal(crossSessionConfirm.statusCode, 403, crossSessionConfirm.body);
  assert.equal(errorCode(crossSessionConfirm.body), "ENROLLMENT_SESSION_MISMATCH");

  const wrongPhrase = await app.inject({
    method: "POST",
    url: `/api/enrollments/${enrollment.enrollmentId}/confirm`,
    headers: creator.headers,
    payload: { verificationPhrase: "wrong-phrase" },
  });
  assert.equal(wrongPhrase.statusCode, 400, wrongPhrase.body);
  assert.equal(errorCode(wrongPhrase.body), "VERIFICATION_MISMATCH");

  const [confirm, concurrentConfirm] = await Promise.all([
    app.inject({
      method: "POST",
      url: `/api/enrollments/${enrollment.enrollmentId}/confirm`,
      headers: creator.headers,
      payload: { verificationPhrase: claimed.verificationPhrase, machineName: "renamed-host" },
    }),
    app.inject({
      method: "POST",
      url: `/api/enrollments/${enrollment.enrollmentId}/confirm`,
      headers: creator.headers,
      payload: { verificationPhrase: claimed.verificationPhrase, machineName: "renamed-host" },
    }),
  ]);
  assert.equal(confirm.statusCode, 200, confirm.body);
  assert.equal(concurrentConfirm.statusCode, 200, concurrentConfirm.body);
  assert.equal(json<{ status: string }>(confirm.body).status, "confirmed");

  const replayConfirm = await app.inject({
    method: "POST",
    url: `/api/enrollments/${enrollment.enrollmentId}/confirm`,
    headers: creator.headers,
    payload: { verificationPhrase: claimed.verificationPhrase },
  });
  assert.equal(replayConfirm.statusCode, 200, replayConfirm.body);
  assert.equal(json<{ status: string }>(replayConfirm.body).status, "confirmed");

  const replayConfirmSameName = await app.inject({
    method: "POST",
    url: `/api/enrollments/${enrollment.enrollmentId}/confirm`,
    headers: creator.headers,
    payload: { verificationPhrase: claimed.verificationPhrase, machineName: "renamed-host" },
  });
  assert.equal(replayConfirmSameName.statusCode, 200, replayConfirmSameName.body);

  const replayConfirmConflictingName = await app.inject({
    method: "POST",
    url: `/api/enrollments/${enrollment.enrollmentId}/confirm`,
    headers: creator.headers,
    payload: { verificationPhrase: claimed.verificationPhrase, machineName: "different-host" },
  });
  assert.equal(replayConfirmConflictingName.statusCode, 409, replayConfirmConflictingName.body);
  assert.equal(errorCode(replayConfirmConflictingName.body), "ENROLLMENT_CONFIRM_CONFLICT");

  const replayConfirmWrongPhrase = await app.inject({
    method: "POST",
    url: `/api/enrollments/${enrollment.enrollmentId}/confirm`,
    headers: creator.headers,
    payload: { verificationPhrase: "wrong-phrase" },
  });
  assert.equal(replayConfirmWrongPhrase.statusCode, 400, replayConfirmWrongPhrase.body);
  assert.equal(errorCode(replayConfirmWrongPhrase.body), "VERIFICATION_MISMATCH");

  const replayClaimAfterConfirmation = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/claim",
    payload: claimPayload(ticket, publicKeyEncoded),
  });
  assert.equal(replayClaimAfterConfirmation.statusCode, 200, replayClaimAfterConfirmation.body);
  assert.deepEqual(
    (({ status, claimToken, proofMessage }) => ({ status, claimToken, proofMessage }))(
      json<{ status: string; claimToken: string; proofMessage: string }>(replayClaimAfterConfirmation.body),
    ),
    { status: "confirmed", claimToken: claimed.claimToken, proofMessage: claimed.proofMessage },
  );

  const wrongClaimToken = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/exchange",
    payload: {
      enrollmentId: enrollment.enrollmentId,
      claimToken: randomBytes(32).toString("base64url"),
      signature,
    },
  });
  assert.equal(wrongClaimToken.statusCode, 401, wrongClaimToken.body);
  assert.equal(errorCode(wrongClaimToken.body), "ENROLLMENT_CLAIM_TOKEN_INVALID");

  const wrongProof = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/exchange",
    payload: {
      enrollmentId: enrollment.enrollmentId,
      claimToken: claimed.claimToken,
      signature: randomBytes(64).toString("base64url"),
    },
  });
  assert.equal(wrongProof.statusCode, 401, wrongProof.body);
  assert.equal(errorCode(wrongProof.body), "ENROLLMENT_PROOF_INVALID");

  const [exchange, concurrentReplay] = await Promise.all([
    app.inject({
      method: "POST",
      url: "/api/agent/enrollments/exchange",
      payload: { enrollmentId: enrollment.enrollmentId, claimToken: claimed.claimToken, signature },
    }),
    app.inject({
      method: "POST",
      url: "/api/agent/enrollments/exchange",
      payload: { enrollmentId: enrollment.enrollmentId, claimToken: claimed.claimToken, signature },
    }),
  ]);
  assert.equal(exchange.statusCode, 200, exchange.body);
  assert.equal(concurrentReplay.statusCode, 200, concurrentReplay.body);
  const credential = json<{ machineId: string; workspaceId: string; credentialId: string; agentToken: string }>(exchange.body);
  const concurrentlyRecovered = json<{ machineId: string; credentialId: string; agentToken: string }>(concurrentReplay.body);
  assert.deepEqual(
    {
      machineId: concurrentlyRecovered.machineId,
      credentialId: concurrentlyRecovered.credentialId,
      agentToken: concurrentlyRecovered.agentToken,
    }, {
    machineId: credential.machineId,
    credentialId: credential.credentialId,
    agentToken: credential.agentToken,
    },
  );
  assert.ok(credential.machineId.startsWith("mach_"));
  assert.ok(credential.workspaceId.startsWith("ws_"));
  assert.ok(credential.agentToken.length >= 32);
  assert.equal(
    db.get<{ name: string }>("SELECT name FROM machines WHERE machine_id=?", credential.machineId)?.name,
    "renamed-host",
  );

  const confirmAfterRedemption = await app.inject({
    method: "POST",
    url: `/api/enrollments/${enrollment.enrollmentId}/confirm`,
    headers: creator.headers,
    payload: { verificationPhrase: claimed.verificationPhrase, machineName: "renamed-host" },
  });
  assert.equal(confirmAfterRedemption.statusCode, 200, confirmAfterRedemption.body);
  assert.deepEqual(
    (({ status, machineId }) => ({ status, machineId }))(
      json<{ status: string; machineId: string }>(confirmAfterRedemption.body),
    ),
    { status: "redeemed", machineId: credential.machineId },
  );

  const replayExchange = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/exchange",
    payload: { enrollmentId: enrollment.enrollmentId, claimToken: claimed.claimToken, signature },
  });
  assert.equal(replayExchange.statusCode, 200, replayExchange.body);
  const replayedCredential = json<{ machineId: string; credentialId: string; agentToken: string }>(replayExchange.body);
  assert.deepEqual(
    {
      machineId: replayedCredential.machineId,
      credentialId: replayedCredential.credentialId,
      agentToken: replayedCredential.agentToken,
    }, {
    machineId: credential.machineId,
    credentialId: credential.credentialId,
    agentToken: credential.agentToken,
    },
  );

  const replayClaimAfterRedemption = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/claim",
    payload: claimPayload(ticket, publicKeyEncoded),
  });
  assert.equal(replayClaimAfterRedemption.statusCode, 200, replayClaimAfterRedemption.body);
  assert.equal(json<{ status: string; claimToken: string }>(replayClaimAfterRedemption.body).status, "redeemed");
  assert.equal(json<{ status: string; claimToken: string }>(replayClaimAfterRedemption.body).claimToken, claimed.claimToken);
  assert.equal(
    db.get<{ count: number }>("SELECT count(*) AS count FROM machines WHERE workspace_id=?", credential.workspaceId)?.count,
    1,
  );
  assert.equal(
    db.get<{ count: number }>("SELECT count(*) AS count FROM machine_credentials WHERE machine_id=?", credential.machineId)?.count,
    1,
  );
  const recoveryState = db.get<{ credential_id: string; recovery_expires_at: string }>(
    "SELECT credential_id,recovery_expires_at FROM enrollment_transactions WHERE enrollment_id=?",
    enrollment.enrollmentId,
  );
  assert.equal(recoveryState?.credential_id, credential.credentialId);
  assert.ok(Date.parse(recoveryState?.recovery_expires_at ?? "") > Date.now());
  assert.equal(
    db.get<{ token_hash: string }>("SELECT token_hash FROM machine_credentials WHERE credential_id=?", credential.credentialId)?.token_hash,
    sha256(credential.agentToken),
  );

  const redeemed = await app.inject({
    method: "GET",
    url: `/api/enrollments/${enrollment.enrollmentId}`,
    headers: { cookie: creator.cookie },
  });
  assert.equal(redeemed.statusCode, 200, redeemed.body);
  assert.deepEqual(
    (({ status, machineId, machineReady, projectCount, machineReachability }) => ({ status, machineId, machineReady, projectCount, machineReachability }))(
      json<{ status: string; machineId: string; machineReady: boolean; projectCount: number; machineReachability: string }>(redeemed.body),
    ),
    { status: "redeemed", machineId: credential.machineId, machineReady: false, projectCount: 0, machineReachability: "offline" },
  );

  // Readiness reflects completed checks, not the existence of a placeholder project.
  for (const [state, readiness, readOnly, expected] of [
    ["scanning", "checking", 0, false], ["error", "action_required", 0, false],
    ["ready", "action_required", 1, false], ["ready", "ready", 0, true],
  ] as const) {
    const discovery = { state, readiness, discoveredProjects: 0, discoveredSessions: 0 };
    db.run("UPDATE machines SET reachability='online',compatibility='compatible',security_state='normal',runtime_read_only=?,discovery_json=? WHERE machine_id=?", readOnly, JSON.stringify(discovery), credential.machineId);
    const response = await app.inject({ method: "GET", url: `/api/enrollments/${enrollment.enrollmentId}`, headers: { cookie: creator.cookie } });
    const body = json<{ machineReady: boolean; discovery: unknown }>(response.body);
    assert.equal(body.machineReady, expected, `${state}/${readiness} with zero projects`);
    assert.deepEqual(body.discovery, discovery);
  }
  db.run("UPDATE machines SET reachability='offline' WHERE machine_id=?", credential.machineId);

  const auditActions = db.all<{ action: string; outcome: string; ip_hash: string | null; metadata_json: string }>(
    "SELECT action,outcome,ip_hash,metadata_json FROM audit_entries WHERE action LIKE 'machine.enrollment.%' ORDER BY rowid",
  );
  assert.deepEqual(auditActions.map((entry) => `${entry.action}:${entry.outcome}`), [
    "machine.enrollment.create:success",
    "machine.enrollment.claim:denied",
    "machine.enrollment.claim:success",
    "machine.enrollment.claim:denied",
    "machine.enrollment.confirm:denied",
    "machine.enrollment.confirm:denied",
    "machine.enrollment.confirm:success",
    "machine.enrollment.confirm:denied",
    "machine.enrollment.exchange:denied",
    "machine.enrollment.exchange:denied",
    "machine.enrollment.exchange:success",
  ]);
  const denialReasons = auditActions
    .filter((entry) => entry.outcome === "denied")
    .map((entry) => JSON.parse(entry.metadata_json) as { reason?: string })
    .map((metadata) => metadata.reason);
  assert.ok(denialReasons.includes("invalid_bootstrap_secret"));
  assert.ok(denialReasons.includes("client_session_mismatch"));
  assert.ok(denialReasons.includes("verification_mismatch"));
  assert.ok(denialReasons.includes("invalid_claim_token"));
  assert.equal(auditActions.at(-1)?.ip_hash, sha256("127.0.0.1"));
  assert.ok(!JSON.stringify(auditActions).includes(enrollment.bootstrapSecret));
  assert.ok(!JSON.stringify(auditActions).includes(claimed.claimToken));

  db.run(
    "UPDATE enrollment_transactions SET recovery_expires_at=? WHERE enrollment_id=?",
    "2000-01-01T00:00:00.000Z",
    enrollment.enrollmentId,
  );
  const recoveryExpired = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/exchange",
    payload: { enrollmentId: enrollment.enrollmentId, claimToken: claimed.claimToken, signature },
  });
  assert.equal(recoveryExpired.statusCode, 410, recoveryExpired.body);
  assert.equal(errorCode(recoveryExpired.body), "ENROLLMENT_RECOVERY_EXPIRED");
  const reclaimExpired = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/claim",
    payload: claimPayload(ticket, publicKeyEncoded),
  });
  assert.equal(reclaimExpired.statusCode, 410, reclaimExpired.body);
  assert.equal(errorCode(reclaimExpired.body), "ENROLLMENT_RECOVERY_EXPIRED");
});

test("expired and cancelled enrollment tickets cannot be claimed or exchanged", async (t) => {
  const { app, db } = await buildControlPlane(config());
  t.after(async () => app.close());
  await app.ready();
  const browser = await login(app);

  const createExpired = await app.inject({ method: "POST", url: "/api/enrollments", headers: browser.headers, payload: {} });
  assert.equal(createExpired.statusCode, 200, createExpired.body);
  const expired = json<{ enrollmentId: string; bootstrapSecret: string }>(createExpired.body);
  db.run("UPDATE enrollment_transactions SET expires_at=? WHERE enrollment_id=?", "2000-01-01T00:00:00.000Z", expired.enrollmentId);
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeyEncoded = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const expiredClaim = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/claim",
    payload: claimPayload(`${expired.enrollmentId}.${expired.bootstrapSecret}`, publicKeyEncoded),
  });
  assert.equal(expiredClaim.statusCode, 410, expiredClaim.body);
  assert.equal(errorCode(expiredClaim.body), "ENROLLMENT_EXPIRED");
  const expiredStatus = await app.inject({
    method: "GET",
    url: `/api/enrollments/${expired.enrollmentId}`,
    headers: { cookie: browser.cookie },
  });
  assert.equal(json<{ status: string }>(expiredStatus.body).status, "expired");

  const createCancelled = await app.inject({ method: "POST", url: "/api/enrollments", headers: browser.headers, payload: {} });
  assert.equal(createCancelled.statusCode, 200, createCancelled.body);
  const cancelled = json<{ enrollmentId: string; bootstrapSecret: string }>(createCancelled.body);
  const cancel = await app.inject({
    method: "DELETE",
    url: `/api/enrollments/${cancelled.enrollmentId}`,
    headers: browser.headers,
    payload: {},
  });
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.equal(json<{ status: string }>(cancel.body).status, "cancelled");
  const cancelledClaim = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/claim",
    payload: claimPayload(`${cancelled.enrollmentId}.${cancelled.bootstrapSecret}`, publicKeyEncoded),
  });
  assert.equal(cancelledClaim.statusCode, 410, cancelledClaim.body);
  assert.equal(errorCode(cancelledClaim.body), "ENROLLMENT_CANCELLED");

  const createClaimed = await app.inject({ method: "POST", url: "/api/enrollments", headers: browser.headers, payload: {} });
  assert.equal(createClaimed.statusCode, 200, createClaimed.body);
  const claimedEnrollment = json<{ enrollmentId: string; bootstrapSecret: string }>(createClaimed.body);
  const { publicKey: exchangePublicKey, privateKey: exchangePrivateKey } = generateKeyPairSync("ed25519");
  const exchangePublicKeyEncoded = exchangePublicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const claim = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/claim",
    payload: claimPayload(`${claimedEnrollment.enrollmentId}.${claimedEnrollment.bootstrapSecret}`, exchangePublicKeyEncoded),
  });
  assert.equal(claim.statusCode, 200, claim.body);
  const claimBody = json<{ claimToken: string; proofMessage: string; verificationPhrase: string }>(claim.body);
  const confirm = await app.inject({
    method: "POST",
    url: `/api/enrollments/${claimedEnrollment.enrollmentId}/confirm`,
    headers: browser.headers,
    payload: { verificationPhrase: claimBody.verificationPhrase },
  });
  assert.equal(confirm.statusCode, 200, confirm.body);
  db.run("UPDATE enrollment_transactions SET expires_at=? WHERE enrollment_id=?", "2000-01-01T00:00:00.000Z", claimedEnrollment.enrollmentId);
  const expiredExchange = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/exchange",
    payload: {
      enrollmentId: claimedEnrollment.enrollmentId,
      claimToken: claimBody.claimToken,
      signature: sign(null, Buffer.from(claimBody.proofMessage), exchangePrivateKey).toString("base64url"),
    },
  });
  assert.equal(expiredExchange.statusCode, 410, expiredExchange.body);
  assert.equal(errorCode(expiredExchange.body), "ENROLLMENT_EXPIRED");
});

test("a new enrollment recovers an offline identity whose first credential response was lost", async (t) => {
  const { app, db } = await buildControlPlane(config());
  t.after(async () => app.close());
  await app.ready();
  const browser = await login(app);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyEncoded = publicKey.export({ format: "der", type: "spki" }).toString("base64url");

  const prepareEnrollment = async () => {
    const createdResponse = await app.inject({ method: "POST", url: "/api/enrollments", headers: browser.headers, payload: {} });
    assert.equal(createdResponse.statusCode, 200, createdResponse.body);
    const created = json<{ enrollmentId: string; bootstrapSecret: string }>(createdResponse.body);
    const claimResponse = await app.inject({
      method: "POST",
      url: "/api/agent/enrollments/claim",
      payload: claimPayload(`${created.enrollmentId}.${created.bootstrapSecret}`, publicKeyEncoded),
    });
    assert.equal(claimResponse.statusCode, 200, claimResponse.body);
    const claim = json<{ claimToken: string; proofMessage: string; verificationPhrase: string }>(claimResponse.body);
    const confirmation = await app.inject({
      method: "POST",
      url: `/api/enrollments/${created.enrollmentId}/confirm`,
      headers: browser.headers,
      payload: { verificationPhrase: claim.verificationPhrase },
    });
    assert.equal(confirmation.statusCode, 200, confirmation.body);
    return {
      enrollmentId: created.enrollmentId,
      payload: {
        enrollmentId: created.enrollmentId,
        claimToken: claim.claimToken,
        signature: sign(null, Buffer.from(claim.proofMessage), privateKey).toString("base64url"),
      },
    };
  };

  const first = await prepareEnrollment();
  const firstExchange = await app.inject({ method: "POST", url: "/api/agent/enrollments/exchange", payload: first.payload });
  assert.equal(firstExchange.statusCode, 200, firstExchange.body);
  const lost = json<{ machineId: string; credentialId: string; agentToken: string }>(firstExchange.body);

  const second = await prepareEnrollment();
  const prematureRecovery = await app.inject({ method: "POST", url: "/api/agent/enrollments/exchange", payload: second.payload });
  assert.equal(prematureRecovery.statusCode, 409, prematureRecovery.body);
  assert.equal(errorCode(prematureRecovery.body), "MACHINE_ENROLLMENT_RECOVERY_ACTIVE");
  assert.equal(
    db.get<{ revoked_at: string | null }>("SELECT revoked_at FROM machine_credentials WHERE credential_id=?", lost.credentialId)?.revoked_at,
    null,
  );

  db.run(
    "UPDATE enrollment_transactions SET recovery_expires_at=? WHERE enrollment_id=?",
    "2000-01-01T00:00:00.000Z",
    first.enrollmentId,
  );
  const recoveredExchange = await app.inject({ method: "POST", url: "/api/agent/enrollments/exchange", payload: second.payload });
  assert.equal(recoveredExchange.statusCode, 200, recoveredExchange.body);
  const recovered = json<{ machineId: string; credentialId: string; agentToken: string }>(recoveredExchange.body);
  assert.equal(recovered.machineId, lost.machineId);
  assert.notEqual(recovered.credentialId, lost.credentialId);
  assert.notEqual(recovered.agentToken, lost.agentToken);
  assert.equal(db.get<{ count: number }>("SELECT count(*) AS count FROM machines")?.count, 1);
  assert.ok(db.get<{ revoked_at: string | null }>("SELECT revoked_at FROM machine_credentials WHERE credential_id=?", lost.credentialId)?.revoked_at);
  assert.equal(db.get<{ revoked_at: string | null }>("SELECT revoked_at FROM machine_credentials WHERE credential_id=?", recovered.credentialId)?.revoked_at, null);
  const recoveryAudit = db.get<{ metadata_json: string }>(
    "SELECT metadata_json FROM audit_entries WHERE action='machine.enrollment.exchange' ORDER BY rowid DESC LIMIT 1",
  );
  assert.equal(JSON.parse(recoveryAudit?.metadata_json ?? "{}").recoveredExistingIdentity, true);
});

test("a cross-instance claim race commits its denied audit before returning conflict", async (t) => {
  const { app, db } = await buildControlPlane(config());
  t.after(async () => app.close());
  await app.ready();
  const browser = await login(app);
  const createdResponse = await app.inject({ method: "POST", url: "/api/enrollments", headers: browser.headers, payload: {} });
  const created = json<{ enrollmentId: string; bootstrapSecret: string }>(createdResponse.body);
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeyEncoded = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const originalTransaction = db.transaction.bind(db);
  let injected = false;
  Object.defineProperty(db, "transaction", {
    configurable: true,
    value: <T>(operation: () => T): T => {
      if (!injected) {
        injected = true;
        db.run(
          `UPDATE enrollment_transactions SET status='claimed',public_key_spki=?,public_key_fingerprint=?
           WHERE enrollment_id=? AND status='created'`,
          "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          "sha256:concurrent",
          created.enrollmentId,
        );
      }
      return originalTransaction(operation);
    },
  });
  const raced = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/claim",
    payload: claimPayload(`${created.enrollmentId}.${created.bootstrapSecret}`, publicKeyEncoded),
  });
  Object.defineProperty(db, "transaction", { configurable: true, value: originalTransaction });
  assert.equal(raced.statusCode, 409, raced.body);
  assert.equal(errorCode(raced.body), "ENROLLMENT_CLAIM_KEY_MISMATCH");
  const denied = db.get<{ metadata_json: string; outcome: string }>(
    `SELECT metadata_json,outcome FROM audit_entries
     WHERE action='machine.enrollment.claim' AND outcome='denied' ORDER BY rowid DESC LIMIT 1`,
  );
  assert.equal(denied?.outcome, "denied");
  assert.equal(JSON.parse(denied?.metadata_json ?? "{}").reason, "concurrent_public_key_mismatch");
});

test("revoking the creating Client Session atomically cancels an unredeemed enrollment", async (t) => {
  const { app, db } = await buildControlPlane(config());
  t.after(async () => app.close());
  await app.ready();
  const creator = await login(app);
  const revoker = await login(app);

  const create = await app.inject({ method: "POST", url: "/api/enrollments", headers: creator.headers, payload: {} });
  assert.equal(create.statusCode, 200, create.body);
  const enrollment = json<{ enrollmentId: string; bootstrapSecret: string }>(create.body);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyEncoded = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const claim = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/claim",
    payload: claimPayload(`${enrollment.enrollmentId}.${enrollment.bootstrapSecret}`, publicKeyEncoded),
  });
  assert.equal(claim.statusCode, 200, claim.body);
  const claimed = json<{ claimToken: string; proofMessage: string; verificationPhrase: string }>(claim.body);
  const confirm = await app.inject({
    method: "POST",
    url: `/api/enrollments/${enrollment.enrollmentId}/confirm`,
    headers: creator.headers,
    payload: { verificationPhrase: claimed.verificationPhrase },
  });
  assert.equal(confirm.statusCode, 200, confirm.body);

  const revoke = await app.inject({
    method: "DELETE",
    url: `/api/client-sessions/${creator.clientSessionId}`,
    headers: revoker.headers,
    payload: {},
  });
  assert.equal(revoke.statusCode, 200, revoke.body);
  assert.equal(
    db.get<{ status: string }>("SELECT status FROM enrollment_transactions WHERE enrollment_id=?", enrollment.enrollmentId)?.status,
    "cancelled",
  );

  const exchange = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/exchange",
    payload: {
      enrollmentId: enrollment.enrollmentId,
      claimToken: claimed.claimToken,
      signature: sign(null, Buffer.from(claimed.proofMessage), privateKey).toString("base64url"),
    },
  });
  assert.equal(exchange.statusCode, 410, exchange.body);
  assert.equal(errorCode(exchange.body), "ENROLLMENT_CANCELLED");
  const cancellationAudit = db.get<{ metadata_json: string }>(
    `SELECT metadata_json FROM audit_entries
     WHERE action='machine.enrollment.cancel' AND json_extract(metadata_json,'$.enrollmentId')=?`,
    enrollment.enrollmentId,
  );
  assert.equal(JSON.parse(cancellationAudit?.metadata_json ?? "{}").reason, "client_session_revoked");
});

test("trusted ingress IPs and transaction-scoped enrollment limits avoid proxy-wide lockout", async (t) => {
  const trustedConfig: ControlPlaneConfig = { ...config(), trustedProxies: ["127.0.0.1/32"] };
  const { app, db } = await buildControlPlane(trustedConfig);
  t.after(async () => app.close());
  await app.ready();
  const browser = await login(app);
  const create = await app.inject({ method: "POST", url: "/api/enrollments", headers: browser.headers, payload: {} });
  assert.equal(create.statusCode, 200, create.body);
  const enrollment = json<{ enrollmentId: string; bootstrapSecret: string }>(create.body);
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeyEncoded = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const attackerIp = "198.51.100.10";
  const agentIp = "198.51.100.11";

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const fakeId = `enroll_${attempt.toString(16).padStart(32, "0")}`;
    const response = await app.inject({
      method: "POST",
      url: "/api/agent/enrollments/claim",
      headers: { "x-forwarded-for": attackerIp },
      payload: claimPayload(`${fakeId}.${randomBytes(32).toString("base64url")}`, publicKeyEncoded),
    });
    assert.equal(response.statusCode, 401, response.body);
  }
  const blockedAttacker = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/claim",
    headers: { "x-forwarded-for": attackerIp },
    payload: claimPayload(`enroll_${"f".repeat(32)}.${randomBytes(32).toString("base64url")}`, publicKeyEncoded),
  });
  assert.equal(blockedAttacker.statusCode, 429, blockedAttacker.body);
  assert.ok(Number(blockedAttacker.headers["retry-after"]) > 0);

  const ticket = `${enrollment.enrollmentId}.${enrollment.bootstrapSecret}`;
  const claim = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/claim",
    headers: { "x-forwarded-for": agentIp },
    payload: claimPayload(ticket, publicKeyEncoded),
  });
  assert.equal(claim.statusCode, 200, claim.body);
  const claimed = json<{ enrollmentId: string; claimToken: string; proofMessage: string }>(claim.body);
  assert.equal(
    db.get<{ claim_ip_hash: string }>("SELECT claim_ip_hash FROM enrollment_transactions WHERE enrollment_id=?", enrollment.enrollmentId)?.claim_ip_hash,
    sha256(agentIp),
  );

  for (let replay = 1; replay < 10; replay += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/api/agent/enrollments/claim",
      headers: { "x-forwarded-for": agentIp },
      payload: claimPayload(ticket, publicKeyEncoded),
    });
    assert.equal(response.statusCode, 200, response.body);
  }
  const ticketLimited = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/claim",
    headers: { "x-forwarded-for": agentIp },
    payload: claimPayload(ticket, publicKeyEncoded),
  });
  assert.equal(ticketLimited.statusCode, 429, ticketLimited.body);

  const createSecond = await app.inject({ method: "POST", url: "/api/enrollments", headers: browser.headers, payload: {} });
  assert.equal(createSecond.statusCode, 200, createSecond.body);
  const second = json<{ enrollmentId: string; bootstrapSecret: string }>(createSecond.body);
  const secondTicket = `${second.enrollmentId}.${second.bootstrapSecret}`;
  const secondClaim = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/claim",
    headers: { "x-forwarded-for": agentIp },
    payload: claimPayload(secondTicket, publicKeyEncoded),
  });
  assert.equal(secondClaim.statusCode, 200, secondClaim.body);
  const secondClaimed = json<{ enrollmentId: string; claimToken: string; proofMessage: string }>(secondClaim.body);

  const pendingSignature = randomBytes(64).toString("base64url");
  for (let poll = 0; poll < 45; poll += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/api/agent/enrollments/exchange",
      headers: { "x-forwarded-for": agentIp },
      payload: { enrollmentId: claimed.enrollmentId, claimToken: claimed.claimToken, signature: pendingSignature },
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(errorCode(response.body), "ENROLLMENT_NOT_CONFIRMED");
  }
  const transactionLimited = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/exchange",
    headers: { "x-forwarded-for": agentIp },
    payload: { enrollmentId: claimed.enrollmentId, claimToken: claimed.claimToken, signature: pendingSignature },
  });
  assert.equal(transactionLimited.statusCode, 429, transactionLimited.body);

  const independentTransaction = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/exchange",
    headers: { "x-forwarded-for": agentIp },
    payload: {
      enrollmentId: secondClaimed.enrollmentId,
      claimToken: secondClaimed.claimToken,
      signature: pendingSignature,
    },
  });
  assert.equal(independentTransaction.statusCode, 409, independentTransaction.body);
  assert.equal(errorCode(independentTransaction.body), "ENROLLMENT_NOT_CONFIRMED");

  const createUntrusted = await app.inject({ method: "POST", url: "/api/enrollments", headers: browser.headers, payload: {} });
  assert.equal(createUntrusted.statusCode, 200, createUntrusted.body);
  const untrusted = json<{ enrollmentId: string; bootstrapSecret: string }>(createUntrusted.body);
  const untrustedPeer = "203.0.113.20";
  const spoofedForwardedIp = "198.51.100.200";
  const untrustedClaim = await app.inject({
    method: "POST",
    url: "/api/agent/enrollments/claim",
    remoteAddress: untrustedPeer,
    headers: { "x-forwarded-for": spoofedForwardedIp },
    payload: claimPayload(`${untrusted.enrollmentId}.${untrusted.bootstrapSecret}`, publicKeyEncoded),
  });
  assert.equal(untrustedClaim.statusCode, 200, untrustedClaim.body);
  assert.equal(
    db.get<{ claim_ip_hash: string }>("SELECT claim_ip_hash FROM enrollment_transactions WHERE enrollment_id=?", untrusted.enrollmentId)?.claim_ip_hash,
    sha256(untrustedPeer),
  );
});

test("TRUSTED_PROXIES accepts only explicit IP addresses and CIDRs", () => {
  const environment: NodeJS.ProcessEnv = {
    ADMIN_EMAIL: "admin@example.test",
    ADMIN_PASSWORD: "correct horse battery staple",
    PUBLIC_ORIGIN: origin,
    TRUSTED_PROXIES: "127.0.0.1/32, ::1",
  };
  assert.deepEqual(loadConfig(environment).trustedProxies, ["127.0.0.1/32", "::1"]);
  assert.throws(
    () => loadConfig({ ...environment, TRUSTED_PROXIES: "uniquelocal" }),
    /invalid IP\/CIDR/,
  );
  assert.throws(
    () => loadConfig({ ...environment, TRUSTED_PROXIES: "127.0.0.1/99" }),
    /invalid IP\/CIDR/,
  );
  assert.throws(
    () => loadConfig({ ...environment, ADMIN_PASSWORD: "replace-with-a-long-random-password" }),
    /ADMIN_PASSWORD is required/,
  );
});
