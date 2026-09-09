import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { watch } from "node:fs";
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { CatalogSyncScheduler, CodexCatalogWatcher, type CatalogChange } from "../src/catalog-sync.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "expected filesystem notification");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentfleet-watch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, ".codex");
  await mkdir(home);
  return home;
}

test("idle catalog has no 30-second scan; five-minute reconciliation repairs watchers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const changes: CatalogChange[] = []; let repairs = 0;
  const scheduler = new CatalogSyncScheduler(async change => { changes.push(change); }, { repair: async () => { repairs++; } });
  t.after(() => scheduler.close()); scheduler.start();
  t.mock.timers.tick(299_999); await immediate();
  assert.deepEqual(changes, []);
  t.mock.timers.tick(1); await immediate();
  assert.equal(repairs, 1);
  t.mock.timers.tick(1_500); await immediate();
  assert.deepEqual(changes, ["full"]);
});

test("bursts coalesce, full repair wins, continuous writes cannot starve synchronization", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const changes: CatalogChange[] = [];
  const scheduler = new CatalogSyncScheduler(async change => { changes.push(change); });
  t.after(() => scheduler.close());
  scheduler.request("full");
  for (let i = 0; i < 10; i++) { scheduler.request("index"); t.mock.timers.tick(1_000); await immediate(); }
  assert.deepEqual(changes, ["full"]);
  scheduler.request("index"); t.mock.timers.tick(9_999); await immediate();
  assert.equal(changes.length, 1);
  t.mock.timers.tick(1); await immediate();
  assert.deepEqual(changes, ["full", "index"]);
});

test("changes during an in-flight sync get exactly one follow-up; close cancels queued work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0;
  const scheduler = new CatalogSyncScheduler(async () => { if (++calls === 1) await pending; });
  scheduler.request("index"); t.mock.timers.tick(1_500); await immediate();
  scheduler.request("index"); scheduler.request("full");
  t.mock.timers.tick(50_000); await immediate(); assert.equal(calls, 1);
  finish(); await immediate(); t.mock.timers.tick(1_500); await immediate(); assert.equal(calls, 2);
  scheduler.request("full"); scheduler.close(); t.mock.timers.tick(600_000); await immediate(); assert.equal(calls, 2);
});

test("failed sync retries with backoff and does not need another file event", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  let calls = 0;
  const scheduler = new CatalogSyncScheduler(async () => { if (++calls < 3) throw new Error("temporary RPC failure"); });
  t.after(() => scheduler.close());
  scheduler.request("index"); t.mock.timers.tick(1_500); await immediate();
  t.mock.timers.tick(29_999); await immediate(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await immediate(); assert.equal(calls, 2);
  t.mock.timers.tick(60_000); await immediate(); assert.equal(calls, 3);
});

test("real directory watches see CLI rollouts, late date directories, DB and atomic index replacement, but ignore credentials/logs", async t => {
  const home = await fixture(t); const changes: CatalogChange[] = [];
  const watcher = new CodexCatalogWatcher(home, change => changes.push(change));
  t.after(() => watcher.close()); await watcher.refresh(); assert.equal(watcher.mode, "events");
  await writeFile(join(home, "auth.json"), "fixture");
  await writeFile(join(home, "logs_2.sqlite-wal"), "fixture");
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(changes.length, 0);
  await writeFile(join(home, "state_5.sqlite-wal"), "fixture"); await waitFor(() => changes.includes("index"));
  changes.length = 0;
  const day = join(home, "sessions/2026/09/06"); await mkdir(day, { recursive: true });
  await waitFor(() => changes.includes("full"));
  await watcher.refresh(); changes.length = 0;
  await writeFile(join(day, "rollout-fixture.jsonl"), "{}\n"); await waitFor(() => changes.includes("full"));
  changes.length = 0;
  await writeFile(join(home, "index.tmp"), "{}\n"); await rename(join(home, "index.tmp"), join(home, "session_index.jsonl"));
  await waitFor(() => changes.includes("full"));
  watcher.close(); changes.length = 0;
  await appendFile(join(day, "rollout-fixture.jsonl"), "{}\n"); await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(changes, []);
});

test("replacement directories are re-armed; symlinks are not traversed", async t => {
  const home = await fixture(t); const changes: CatalogChange[] = [];
  await mkdir(join(home, "sessions"));
  const watcher = new CodexCatalogWatcher(home, change => changes.push(change)); t.after(() => watcher.close());
  await watcher.refresh();
  await rename(join(home, "sessions"), join(home, "previous")); await mkdir(join(home, "sessions"));
  await watcher.refresh(); changes.length = 0;
  await writeFile(join(home, "sessions/new.jsonl"), "{}\n"); await waitFor(() => changes.includes("full"));
  await symlink(join(home, "previous"), join(home, "sessions/2025"), "dir"); await watcher.refresh();
  assert.equal(watcher.mode, "fallback");
});

test("watch exhaustion and asynchronous watch errors degrade safely and recover on repair", async t => {
  const home = await fixture(t); let fail = true; const emitters: EventEmitter[] = [];
  const factory = (() => {
    if (fail) throw Object.assign(new Error("limit"), { code: "ENOSPC" });
    const emitter = Object.assign(new EventEmitter(), { close() {} }); emitters.push(emitter); return emitter;
  }) as unknown as typeof watch;
  const watcher = new CodexCatalogWatcher(home, () => undefined, () => undefined, factory);
  t.after(() => watcher.close()); await watcher.refresh(); assert.equal(watcher.mode, "fallback");
  fail = false; await watcher.refresh(); assert.equal(watcher.mode, "events");
  emitters.at(-1)!.emit("error", new Error("lost watcher")); assert.equal(watcher.mode, "fallback");
  await watcher.refresh(); assert.equal(watcher.mode, "events");
});
