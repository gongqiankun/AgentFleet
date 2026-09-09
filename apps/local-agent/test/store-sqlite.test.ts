import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { StateStore } from "../src/store.js";
import type { AgentState } from "../src/types.js";

function stateFixture(generation = 0): AgentState {
  return {
    nativeDeletionTombstones: {},
    schemaVersion: 2,
    projects: [],
    lastTransportGeneration: generation,
    producerStreams: {},
    inbox: {},
    commandJournal: {},
    projectReservations: {},
    outbox: [],
    approvals: {},
    managedThreads: {},
    nativeThreadBindings: {},
    maintenanceOperations: {},
    discoveredThreads: {},
    projectDiscovery: {},
    projectContentPolicies: {},
  };
}

async function runChild(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const environment = { ...process.env };
  // A plain helper/CLI child must not inherit Node's internal test-worker role.
  for (const key of Object.keys(environment)) {
    if (key.startsWith("NODE_TEST_")) delete environment[key];
  }
  const child = spawn(process.execPath, args, { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

test("SQLite update commits sequence allocation, event hash, and outbox atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-sqlite-atomic-"));
  const store = new StateStore(directory);
  await store.initialize();
  await store.beginProducerEpoch("epoch-a");
  const event = await store.appendEvent({
    machineId: "machine-a",
    producerEpoch: "epoch-a",
    type: "agent.warning",
    payload: { code: "ATOMIC" },
  });

  const database = new DatabaseSync(store.statePath, { readOnly: true });
  const row = database.prepare("SELECT schema_version, state_json FROM agent_state WHERE singleton = 1").get() as {
    schema_version: number;
    state_json: string;
  };
  const persisted = JSON.parse(row.state_json) as AgentState;
  assert.equal(row.schema_version, 2);
  assert.equal(persisted.producerStreams["epoch-a"]?.lastProducedSeq, 1);
  assert.equal(persisted.outbox.length, 1);
  assert.deepEqual(persisted.outbox[0], event);
  assert.equal(database.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  database.close();

  await assert.rejects(
    store.update((draft) => {
      draft.lastTransportGeneration = 99;
      throw new Error("rollback sentinel");
    }),
    /rollback sentinel/,
  );
  assert.equal(store.snapshot().lastTransportGeneration, 0);
  await assert.rejects(
    store.update(async (draft) => {
      draft.lastTransportGeneration = 100;
    }),
    /must be synchronous/,
  );
  assert.equal(store.snapshot().lastTransportGeneration, 0);
  assert.equal((await stat(store.statePath)).mode & 0o777, 0o600);
  store.close();
});

test("Project no-persist scrubs retained outbox content and suppresses new payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-no-persist-"));
  const store = new StateStore(directory);
  await store.initialize();
  await store.beginProducerEpoch("epoch-private");
  await store.appendEvent({
    machineId: "machine-a",
    projectId: "project-private",
    producerEpoch: "epoch-private",
    type: "item.completed",
    payload: { body: "must disappear" },
  });
  await store.setProjectContentPolicy("project-private", false, 1);
  assert.deepEqual(store.snapshot().outbox[0]?.payload, { suppressed: true });
  assert.equal(store.snapshot().outbox[0]?.payloadState, "suppressed");
  const next = await store.appendEvent({
    machineId: "machine-a",
    projectId: "project-private",
    producerEpoch: "epoch-private",
    type: "item.completed",
    payload: { body: "must never enter the queue" },
  });
  assert.deepEqual(next.payload, { suppressed: true });
  assert.equal(next.payloadState, "suppressed");
  assert.doesNotMatch(JSON.stringify(store.snapshot().outbox), /must disappear|must never enter/);
  store.close();
});

test("two StateStore connections reload the latest SQLite snapshot without lost updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-sqlite-dual-"));
  const first = new StateStore(directory);
  const second = new StateStore(directory);
  await Promise.all([first.initialize(), second.initialize()]);

  const reservations = await Promise.all(
    Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? first : second).reserveTransportGeneration()),
  );
  assert.deepEqual([...reservations].sort((left, right) => left - right), Array.from({ length: 40 }, (_, index) => index + 1));
  assert.equal(first.snapshot().lastTransportGeneration, 40);
  assert.equal(second.snapshot().lastTransportGeneration, 40);
  first.close();
  second.close();
});

test("independent processes serialize BEGIN IMMEDIATE updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-sqlite-processes-"));
  const seed = new StateStore(directory);
  await seed.initialize();
  seed.close();
  const moduleUrl = new URL("../src/store.js", import.meta.url).href;
  const script = `
    import { StateStore } from ${JSON.stringify(moduleUrl)};
    const store = new StateStore(process.argv[1]);
    await store.initialize();
    for (let index = 0; index < 30; index += 1) await store.reserveTransportGeneration();
    store.close();
  `;
  const [left, right] = await Promise.all([
    runChild(["--input-type=module", "--eval", script, directory]),
    runChild(["--input-type=module", "--eval", script, directory]),
  ]);
  assert.deepEqual([left.code, right.code], [0, 0], `${left.stderr}\n${right.stderr}`);

  const reopened = new StateStore(directory);
  await reopened.initialize();
  assert.equal(reopened.snapshot().lastTransportGeneration, 60);
  reopened.close();
});

test("v1 and v2 state.json are imported once and retained as 0600 backups", async (t) => {
  const cases: Array<{ name: string; state: object; expectedGeneration: number }> = [
    {
      name: "v1",
      state: {
        ...stateFixture(),
        schemaVersion: 1,
        lastTransportGeneration: undefined,
        commandJournal: undefined,
        projectReservations: undefined,
        discoveredThreads: undefined,
        projectDiscovery: undefined,
      },
      expectedGeneration: 0,
    },
    { name: "v2", state: stateFixture(7), expectedGeneration: 7 },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const directory = await mkdtemp(join(tmpdir(), `agentfleet-legacy-${fixture.name}-`));
      const legacyPath = join(directory, "state.json");
      const serialized = `${JSON.stringify(fixture.state)}\n`;
      await writeFile(legacyPath, serialized, { mode: 0o644 });
      const store = new StateStore(directory);
      await store.initialize();
      assert.equal(store.snapshot().schemaVersion, 2);
      assert.equal(store.snapshot().lastTransportGeneration, fixture.expectedGeneration);
      assert.deepEqual(store.snapshot().projectDiscovery, {});
      assert.equal(await readFile(store.legacyBackupPath, "utf8"), serialized);
      assert.equal((await stat(store.legacyStatePath)).mode & 0o777, 0o600);
      assert.equal((await stat(store.legacyBackupPath)).mode & 0o777, 0o600);

      await store.reserveTransportGeneration();
      store.close();
      await writeFile(legacyPath, `${JSON.stringify(stateFixture(999))}\n`, { mode: 0o600 });
      const reopened = new StateStore(directory);
      await reopened.initialize();
      assert.equal(reopened.snapshot().lastTransportGeneration, fixture.expectedGeneration + 1);
      assert.equal(await readFile(reopened.legacyBackupPath, "utf8"), serialized);
      reopened.close();
    });
  }
});

test("runtime ownership rejects a second run and an owner-fenced release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-owner-live-"));
  const first = new StateStore(directory);
  const second = new StateStore(directory);
  await first.initialize();
  await second.initialize();
  const lease = await first.acquireRuntimeOwnership();
  await assert.rejects(second.acquireRuntimeOwnership(), /another agentfleet runtime owns this data directory/);
  assert.equal(await second.releaseRuntimeOwnership({ ...lease, ownerToken: "not-the-owner" }), false);

  const cliUrl = new URL("../src/cli.js", import.meta.url);
  const result = await runChild([cliUrl.pathname, "run", "--url", "https://control.invalid", "--data-dir", directory]);
  assert.equal(result.code, 1);
  assert.equal(await first.releaseRuntimeOwnership(lease), true);
  first.close();
  second.close();
});

test("a crashed process owner is reclaimed using PID plus Linux start token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-owner-stale-"));
  const moduleUrl = new URL("../src/store.js", import.meta.url).href;
  const script = `
    import { StateStore } from ${JSON.stringify(moduleUrl)};
    const store = new StateStore(process.argv[1]);
    await store.initialize();
    const lease = await store.acquireRuntimeOwnership();
    process.stdout.write(JSON.stringify(lease));
  `;
  const crashed = await runChild(["--input-type=module", "--eval", script, directory]);
  assert.equal(crashed.code, 0, crashed.stderr);

  const store = new StateStore(directory);
  await store.initialize();
  const replacement = await store.acquireRuntimeOwnership();
  assert.equal(replacement.pid, process.pid);
  assert.notEqual(replacement.processStartToken, "");
  assert.equal(await store.releaseRuntimeOwnership(replacement), true);
  store.close();
});
