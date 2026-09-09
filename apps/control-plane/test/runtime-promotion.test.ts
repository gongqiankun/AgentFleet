import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { RuntimePromotion, RUNTIME_PLATFORMS, CODE_MODE_PLATFORMS, stableRelease } from "../src/runtime-promotion.js";
import { channelState, writeChannelJson, emptyChannel, type RuntimeTarget } from "../src/runtime-channel.js";
import { CODEX_COMPATIBILITY_PROFILE } from "../src/api-schema.js";
const target = (version: string): RuntimeTarget => ({ schemaVersion: 1, revision: randomUUID(), version, schemaHash: CODEX_COMPATIBILITY_PROFILE.schemaHash, validatedAt: new Date().toISOString(), artifacts: {} });
const release = (version = "0.153.4") => ({ tag_name: `rust-v${version}`, draft: false, prerelease: false, assets: [...Object.values(RUNTIME_PLATFORMS), ...Object.values(CODE_MODE_PLATFORMS), "bwrap-x86_64-unknown-linux-musl"].map(name => ({ name: `${name}.tar.gz`, size: 100, digest: `sha256:${"a".repeat(64)}` })) });
test("stable discovery rejects previews, missing platforms and unverified digests", () => {
  assert.equal(stableRelease(release()).version, "0.153.4");
  assert.throws(() => stableRelease({ ...release(), assets: release().assets.filter(a => !a.name.startsWith("codex-code-mode-host-")) }));
  assert.throws(() => stableRelease({ ...release(), assets: release().assets.filter(a => !a.name.startsWith("bwrap-")) }));
  for (const input of [{ ...release(), prerelease: true }, { ...release(), draft: true }, { ...release(), tag_name: "rust-v0.154.0-alpha.1" }, { ...release(), assets: release().assets.slice(1) }, { ...release(), assets: release().assets.map(a => ({ ...a, digest: "" })) }]) assert.throws(() => stableRelease(input));
});
test("promotion is serialized, persistent, scheduled and rolls back only to a verified target", async t => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-promotion-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const initial = target("0.153.2"); writeChannelJson(directory, "state.json", { ...emptyChannel(), target: initial });
  let preparations = 0;
  const worker = new RuntimePromotion(directory, directory, { discover: async () => release(), prepare: async version => { preparations++; return target(version); } });
  await Promise.all([worker.run(), worker.run()]);
  assert.equal(preparations, 1); assert.equal(channelState(directory).target?.version, "0.153.4"); assert.equal(channelState(directory).previous?.version, "0.153.2");
  const deadline = channelState(directory).nextCheckAt;
  await worker.run(); assert.equal(channelState(directory).nextCheckAt, deadline, "idle polls must not postpone the scheduled check forever");
  writeChannelJson(directory, "control.json", { paused: true, checkId: "initial", rollbackId: "rollback-1" });
  await worker.run(); const rolled = channelState(directory);
  assert.equal(rolled.target?.version, "0.153.2"); assert.equal(rolled.target?.rollback, true); assert.notEqual(rolled.target?.revision, initial.revision);
  await worker.run(); assert.equal(channelState(directory).target?.revision, rolled.target?.revision, "rollback is idempotent");
});
test("schema failures and a pause during validation never replace the published target", async t => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-promotion-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const initial = target("0.153.2"); writeChannelJson(directory, "state.json", { ...emptyChannel(), target: initial });
  await new RuntimePromotion(directory, directory, { discover: async () => release(), prepare: async () => { throw new Error("需要适配：schema 不匹配"); } }).run();
  assert.equal(channelState(directory).phase, "blocked"); assert.deepEqual(channelState(directory).target, initial);
  await new RuntimePromotion(directory, directory, { discover: async () => release(), prepare: async version => { writeChannelJson(directory, "control.json", { paused: true, checkId: "pause" }); return target(version); } }).run(true);
  assert.equal(channelState(directory).phase, "paused"); assert.deepEqual(channelState(directory).target, initial);
});

test("a published version with missing execution dependencies is repaired without a version bump", async t => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-helper-repair-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const initial = target("0.153.4"); writeChannelJson(directory, "state.json", { ...emptyChannel(), target: initial });
  let prepared = 0;
  const worker = new RuntimePromotion(directory, directory, { discover: async () => release(), prepare: async version => {
    prepared++; const result = target(version);
    result.codeModeHosts = Object.fromEntries(Object.keys(RUNTIME_PLATFORMS).map(platform => [platform, { file: "fixture", sha256: "a".repeat(64), size: 100, format: "raw" as const }]));
    return result;
  } });
  await worker.run(true);
  assert.equal(prepared, 1); assert.notEqual(channelState(directory).target?.revision, initial.revision);
  await worker.run(true); assert.equal(prepared, 1, "a complete same-version target is not rebuilt repeatedly");
});
