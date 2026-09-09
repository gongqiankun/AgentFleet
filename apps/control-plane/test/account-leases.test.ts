import test from "node:test";
import assert from "node:assert/strict";
import { buildControlPlane, cookieFromSetCookie, csrfHeaders } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { COMMAND_TYPES } from "../src/api-schema.js";
import { CoordinationService } from "../src/coordination.js";

test("same account switches browsers without handoff; other accounts and concurrent tasks remain fenced", async t => {
  const origin = "http://control-plane.test";
  const password = "isolated-account-lease-password";
  const { app, db, config } = await buildControlPlane({ ...loadConfig({ ADMIN_EMAIL: "owner@example.test", ADMIN_PASSWORD: password,
    PUBLIC_ORIGIN: origin, COOKIE_SECURE: "false", LOG_LEVEL: "silent" }), databasePath: ":memory:" });
  t.after(() => app.close());
  async function login(email = "owner@example.test") {
    const result = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { email, password } });
    assert.equal(result.statusCode, 200, result.body);
    return { cookie: cookieFromSetCookie(result.headers["set-cookie"]), ...csrfHeaders(result.json().csrfToken, origin) };
  }
  const a = await login(), b = await login();
  const owner = db.get<{ workspace_id: string; password_hash: string }>("SELECT workspace_id,password_hash FROM users")!;
  const now = new Date().toISOString();
  db.run("INSERT INTO users(user_id,workspace_id,email,password_hash,role,created_at) VALUES('other-user',?,'other@example.test',?,'admin',?)", owner.workspace_id, owner.password_hash, now);
  const other = await login("other@example.test");
  db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,
    identity_state,security_state,reachability,compatibility,capacity,last_heartbeat_at,created_at,updated_at,command_types_json)
    VALUES('mach_accounts',?,'fixture','fixture','Fixture','linux','Linux','x64','0.26.1','active','normal','online','compatible','idle',?,?,?,?)`,
    owner.workspace_id, now, now, now, JSON.stringify(COMMAND_TYPES));
  db.run(`INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,lease_version,created_at,last_reported_at)
    VALUES('proj_accounts',?,'mach_accounts','fixture','Fixture','/fixture','fixture',1,?,?)`, owner.workspace_id, now, now);
  const created = await app.inject({ method: "POST", url: "/api/sessions", headers: a,
    payload: { machineId: "mach_accounts", projectId: "proj_accounts", title: "Shared account fixture" } });
  assert.equal(created.statusCode, 200, created.body);
  const session = created.json();
  const url = `/api/sessions/${session.logicalSessionId}`;
  const acquire = (headers: typeof a) => app.inject({ method: "POST", url: `${url}/control-lease`, headers, payload: {} });
  const first = await acquire(a);
  assert.equal(first.statusCode, 200, first.body);
  const second = await acquire(b);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().leaseId, first.json().leaseId);
  assert.equal(second.json().holderClientSessionId, first.json().holderClientSessionId);
  assert.equal(second.json().isMine, true);
  const readB = await app.inject({ method: "GET", url, headers: b });
  assert.equal(readB.statusCode, 200, readB.body);
  assert.equal(readB.json().session.controlLease.isMine, true);
  assert.equal(readB.json().session.actions.start.allowed, true);
  const readOther = await app.inject({ method: "GET", url, headers: other });
  assert.equal(readOther.json().session.controlLease.isMine, false);
  assert.equal(readOther.json().session.actions.start.reasonCode, "CONTROL_HELD_ELSEWHERE");
  assert.equal((await acquire(other)).statusCode, 409);
  const payload = (id: string, leaseId = second.json().leaseId) => ({ type: "turn.start", clientMutationId: id, controlLeaseId: leaseId,
    payload: { prompt: "synthetic task; no agent is connected" }, precondition: {
      executionSegmentId: session.executionSegmentId, threadControlVersion: session.threadControlVersion,
      projectLeaseVersion: session.projectLeaseVersion, expectedActiveTurnId: null } });
  const denied = await app.inject({ method: "POST", url: `${url}/commands`, headers: other, payload: payload("other-account-denied") });
  assert.equal(denied.statusCode, 403, denied.body);
  // Credentials are independently revocable; a revoked browser cannot reuse account access.
  const revoked = await login();
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers: revoked, payload: {} })).statusCode, 200);
  assert.equal((await acquire(revoked)).statusCode, 401);
  // No periodic browser renew is required, even after the old lease expires.
  db.run("UPDATE control_leases SET expires_at='2000-01-01T00:00:00Z' WHERE control_lease_id=?", second.json().leaseId);
  const recovered = await acquire(b);
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.notEqual(recovered.json().leaseId, second.json().leaseId);
  const stale = await app.inject({ method: "POST", url: `${url}/commands`, headers: a, payload: payload("stale-lease-command") });
  assert.equal(stale.statusCode, 409, stale.body);
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  const imageRequest = { ...payload("image-old-agent", recovered.json().leaseId), payload: { prompt: "", images: [png] } };
  const oldAgent = await app.inject({ method: "POST", url: `${url}/commands`, headers: b, payload: imageRequest });
  assert.equal(oldAgent.statusCode, 409);
  assert.equal(oldAgent.json().error.code, "AGENT_IMAGE_UNSUPPORTED");
  db.run("UPDATE machines SET codex_catalog_json=? WHERE machine_id='mach_accounts'", JSON.stringify({ imageInput: true, models: [], modes: [], fetchedAt: now }));
  const invalidImage = await app.inject({ method: "POST", url: `${url}/commands`, headers: b,
    payload: { ...imageRequest, payload: { prompt: "image", images: ["http://private-host/image.png"] } } });
  assert.equal(invalidImage.statusCode, 400);
  assert.equal(invalidImage.json().error.code, "INVALID_IMAGES");
  const results = await Promise.all([a, b].map((headers, i) => app.inject({ method: "POST", url: `${url}/commands`, headers,
    payload: { ...payload(`concurrent-account-${i}`, recovered.json().leaseId), payload: { prompt: "", images: [png] } } })));
  assert.deepEqual(results.map(r => r.statusCode).sort(), [202, 409]);
  assert.equal(db.get<{ count: number }>("SELECT count(*) AS count FROM project_turn_reservations")?.count, 1);
  const winner = results.findIndex(r => r.statusCode === 202);
  const duplicate = await app.inject({ method: "POST", url: `${url}/commands`, headers: [a, b][winner]!,
    payload: { ...payload(`concurrent-account-${winner}`, recovered.json().leaseId), payload: { prompt: "", images: [png] } } });
  assert.equal(duplicate.statusCode, 200);
  assert.deepEqual(duplicate.json().command.payload.images, [png]);
  const usage = await app.inject({ method: "GET", url: "/api/machines/mach_accounts/images", headers: b });
  assert.equal(usage.json().imageCount, 1);
  assert.equal(usage.json().pendingImageCommands, 1);
  const pendingClear = await app.inject({ method: "POST", url: "/api/machines/mach_accounts/images/clear", headers: b,
    payload: { revision: usage.json().revision, confirmCloudOnly: true } });
  assert.equal(pendingClear.statusCode, 409);
  assert.equal(pendingClear.json().error.code, "IMAGE_COMMAND_PENDING");
  assert.equal(db.get<{ count: number }>("SELECT count(*) AS count FROM commands WHERE type='turn.start'")?.count, 1);
  // Rollback while a command waits must not downgrade images to plain text.
  db.run("UPDATE machines SET codex_catalog_json=NULL WHERE machine_id='mach_accounts'");
  const commandId = duplicate.json().command.commandId;
  const dispatch = new CoordinationService(db, config).createDispatchAttempt(commandId, {
    machineId: "mach_accounts", transportGeneration: 1, producerEpoch: "fixture-producer", appServerEpoch: "fixture-app",
  });
  assert.equal(dispatch, null);
  assert.equal(db.get<{ state: string }>("SELECT state FROM command_projection WHERE command_id=?", commandId)?.state, "invalidated");
  assert.equal(db.get<{ count: number }>("SELECT count(*) AS count FROM project_turn_reservations")?.count, 0);
});
