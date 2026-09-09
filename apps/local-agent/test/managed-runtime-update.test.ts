import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseManagedRuntimeTarget } from "../src/managed-runtime-update.js";
import { REQUIRED_CODEX_SCHEMA_HASH } from "../src/constants.js";
import { AgentAutoUpdater } from "../src/updater.js";
import { StateStore } from "../src/store.js";
import { writeUpdateTransaction } from "../src/supervisor.js";
const target = () => ({ schemaVersion: 1, revision: randomUUID(), version: "0.153.4", schemaHash: REQUIRED_CODEX_SCHEMA_HASH, artifacts: { "linux-x64": { file: `codex-linux-x64-0.153.4-${"a".repeat(16)}`, sha256: "a".repeat(64), size: 100, format: "raw" } } });
test("managed targets reject schema changes, path injection, invalid hashes and previews", () => {
  assert.equal(parseManagedRuntimeTarget(target())?.version, "0.153.4");
  assert.equal(parseManagedRuntimeTarget(null), null);
  const helper = { file: `codex-bwrap-linux-x64-0.153.4-${"b".repeat(16)}`, sha256: "b".repeat(64), size: 300_000, format: "raw" };
  assert.equal(parseManagedRuntimeTarget({ ...target(), sandboxHelper: helper })?.sandboxHelper?.sha256, helper.sha256);
  for (const sandboxHelper of [null, { ...helper, file: "../../bwrap" }, { ...helper, size: 1024 * 1024 + 1 }, { ...helper, sha256: "wrong" }]) assert.throws(() => parseManagedRuntimeTarget({ ...target(), sandboxHelper }));
  for (const value of [{ ...target(), schemaHash: "b".repeat(64) }, { ...target(), version: "0.154.0-alpha" }, { ...target(), rollback: "true" }, { ...target(), artifacts: { "linux-x64": { ...target().artifacts["linux-x64"], file: "../../codex" } } }]) assert.throws(() => parseManagedRuntimeTarget(value));
});
test("same Agent release still checks managed targets, waits for idle and preserves self-installed Codex", async t => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-updater-")); const store = new StateStore(directory); await store.initialize();
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const requests: string[] = [];
  const options = { currentVersion: "0.21.0", controlPlaneUrl: "https://fleet.example", dataDir: directory, store, runtimeSource: "managed" as const, currentRuntimeVersion: "0.153.2", canUpdate: () => false, onStaged: () => assert.fail("busy host cannot stage"), logger: { info() {}, warn() {} },
    fetchImpl: async (input: string | URL | Request) => { requests.push(String(input)); return new Response(JSON.stringify(String(input).endsWith("manifest.json") ? { schemaVersion: 1, version: "0.21.0" } : { target: target() })); },
    prepareRuntime: async () => { assert.fail("busy host must not download or activate a runtime"); } };
  assert.equal(await new AgentAutoUpdater(options).checkNow(), "busy"); assert.equal(requests.length, 2); assert.ok(store.snapshot().maintenanceDrain);
  requests.length = 0;
  assert.equal(await new AgentAutoUpdater({ ...options, runtimeSource: "host" }).checkNow(), "current"); assert.equal(requests.length, 1);
  assert.equal(await new AgentAutoUpdater({ ...options, currentRuntimeVersion: "0.153.4" }).checkNow(), "current");
  assert.equal(store.snapshot().maintenanceDrain, undefined, "withdrawn/already-current target releases an old automatic drain");
  assert.equal(await new AgentAutoUpdater({ ...options, currentRuntimeVersion: "0.153.4", needsRuntimeRepair: () => true }).checkNow(), "busy", "missing execution tools allow same-version repair, but still wait for idle");
});
test("failed runtime revision is not retried and download verification failure clears maintenance drain", async t => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-updater-")); const store = new StateStore(directory); await store.initialize();
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const release = target();
  await writeUpdateTransaction(directory, { updateId: randomUUID(), phase: "rolled_back", previousVersion: "0.21.0", targetVersion: "0.21.0", targetRuntimeRevision: release.revision, targetRuntimeVersion: release.version, backupDir: join(directory, "updates", "test"), launcher: "test", previousTarget: "test", profilePresent: true, codexPresent: true, startedAt: new Date().toISOString() });
  const options = { currentVersion: "0.21.0", controlPlaneUrl: "https://fleet.example", dataDir: directory, store, runtimeSource: "managed" as const, currentRuntimeVersion: "0.153.2", canUpdate: () => true, onStaged: () => assert.fail("failed validation cannot stage"), logger: { info() {}, warn() {} },
    fetchImpl: async (input: string | URL | Request) => new Response(JSON.stringify(String(input).endsWith("manifest.json") ? { schemaVersion: 1, version: "0.21.0" } : { target: release })),
    prepareRuntime: async () => { throw new Error("checksum mismatch"); } };
  await assert.rejects(new AgentAutoUpdater(options).checkNow(), /失败并已回退/);
  release.revision = randomUUID();
  await assert.rejects(new AgentAutoUpdater(options).checkNow(), /checksum mismatch/);
  assert.equal(store.snapshot().maintenanceDrain, undefined);
});
