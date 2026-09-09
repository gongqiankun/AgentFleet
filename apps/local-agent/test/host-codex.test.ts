import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { detectHostCodex } from "../src/host-codex.js";

test("inventory discovers newer NVM/native installs beyond the first PATH match and rescans upgrades", async t => {
  const home = await mkdtemp(join(tmpdir(), "agentfleet-host-codex-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const versions = new Map<string, string>();
  const install = async (path: string, version: string) => {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, "fixture", { mode: 0o700 }); versions.set(path, version);
  };
  const old = join(home, ".local/bin/codex");
  const newer = join(home, ".nvm/versions/node/v24.20.0/bin/codex");
  const native = join(home, ".codex/bin/releases/0.154.0/codex");
  const managed = join(home, ".local/share/agentfleet/codex/codex");
  await install(old, "0.145.0"); await install(newer, "0.153.4"); await install(managed, "9.0.0");
  const calls: string[] = [];
  const options = { home, uid: null, platform: "linux" as const, environment: { PATH: `${dirname(old)}:${dirname(managed)}` }, source: "managed" as const, runtimePath: managed,
    probe: async (path: string) => { calls.push(path); return versions.get(path) ?? null; } };
  const detected = await detectHostCodex(options);
  assert.equal(detected.hostCodexVersion, "0.153.4"); assert.equal(detected.hostCodexPath, newer);
  assert.equal(detected.hostCodexDefaultVersion, "0.145.0"); assert.equal(detected.hostCodexDefaultPath, old);
  assert.ok(!calls.includes(managed));
  await install(native, "0.154.0");
  assert.equal((await detectHostCodex(options)).hostCodexVersion, "0.154.0");
  versions.set(old, "0.200.0");
  assert.equal((await detectHostCodex(options)).hostCodexVersion, "0.200.0", "version comparison is numeric, not path order");
});

test("inventory deduplicates symlinks, skips invalid and failing installs, and does not scan projects", async t => {
  const home = await mkdtemp(join(tmpdir(), "agentfleet-host-codex-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = ["bin/codex", ".local/bin/codex", ".npm-global/bin/codex", "project/codex"];
  for (const path of paths) { await mkdir(dirname(join(home, path)), { recursive: true }); await writeFile(join(home, path), "fixture", { mode: 0o700 }); }
  await mkdir(join(home, "links")); await symlink(join(home, "bin/codex"), join(home, "links/codex"));
  const calls: string[] = [];
  const result = await detectHostCodex({ home, uid: null, platform: "linux", environment: { PATH: `${home}/bin:${home}/links:.:relative` }, probe: async path => {
    calls.push(path);
    if (path === join(home, ".local/bin/codex")) throw new Error("stale install");
    return path === join(home, "bin/codex") ? "0.153.4" : "unexpected output";
  } });
  assert.equal(result.hostCodexVersion, "0.153.4");
  assert.ok(!calls.includes(join(home, "links/codex"))); assert.ok(!calls.includes(join(home, "project/codex")));
  await chmod(join(home, "bin/codex"), 0o600);
  assert.equal((await detectHostCodex({ home, uid: null, platform: "linux", environment: { PATH: "" }, probe: async () => null })).hostCodexVersion, null);
});

test("real version probe uses bounded direct execution without starting a Codex session", async t => {
  if (process.platform === "win32") return t.skip("POSIX executable fixture");
  const home = await mkdtemp(join(tmpdir(), "agentfleet-host-codex-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "bin"));
  await writeFile(join(home, "bin/codex"), '#!/bin/sh\n[ "$1" = "--version" ] || exit 1\necho "codex-cli 0.153.4"\n', { mode: 0o700 });
  assert.equal((await detectHostCodex({ home, uid: null, systemDirectories: [], environment: { PATH: join(home, "bin") } })).hostCodexVersion, "0.153.4");
});

test("root inventory never executes candidates with writable parent directories", async t => {
  if (process.platform === "win32") return t.skip("POSIX ownership rules");
  const home = await mkdtemp(join(tmpdir(), "agentfleet-host-codex-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "bin")); await chmod(join(home, "bin"), 0o777);
  await writeFile(join(home, "bin/codex"), "fixture", { mode: 0o700 });
  let probes = 0;
  const result = await detectHostCodex({ home, uid: 0, systemDirectories: [], environment: { PATH: join(home, "bin") }, probe: async () => { probes++; return "0.153.4"; } });
  assert.equal(probes, 0); assert.equal(result.hostCodexVersion, null);
  assert.equal(result.hostCodexPath, join(home, "bin/codex"), "a discovered installation is not hidden when it cannot be probed");
});

test("standalone package records reveal the version without executing root-unsafe binaries", async t => {
  const home = await mkdtemp(join(tmpdir(), "agentfleet-host-record-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const release = join(home, ".codex/packages/standalone/releases/0.153.4-linux");
  const binary = join(release, "bin/codex");
  await mkdir(dirname(binary), { recursive: true });
  await writeFile(binary, "never execute this", { mode: 0o700 });
  await chmod(dirname(binary), 0o777);
  const metadataPath = join(release, "codex-package.json");
  await writeFile(metadataPath, JSON.stringify({ layoutVersion: 1, variant: "codex", version: "0.153.4", entrypoint: "bin/codex" }));
  await symlink(release, join(home, ".codex/packages/standalone/current"));
  let probes = 0;
  const options = { home, uid: 0, platform: "linux" as const, systemDirectories: [], environment: { PATH: "" }, probe: async () => { probes++; return "0.153.4"; } };
  const found = await detectHostCodex(options);
  assert.equal(probes, 0);
  assert.equal(found.hostCodexVersion, "0.153.4");
  assert.equal(found.hostCodexVersionSource, "package-record");
  assert.equal(found.hostCodexMetadataPath, metadataPath);
  assert.equal(found.hostCodexPath, join(home, ".codex/packages/standalone/current/bin/codex"));
  for (const record of [ { layoutVersion: 1, variant: "codex", version: "9.9.9", entrypoint: "../../other" }, { layoutVersion: 1, variant: "other", version: "9.9.9", entrypoint: "bin/codex" }, { layoutVersion: 1, variant: "codex", version: "9.9.9-preview", entrypoint: "bin/codex" } ]) {
    await writeFile(metadataPath, JSON.stringify(record));
    assert.equal((await detectHostCodex(options)).hostCodexVersion, null, "reject unbound or invalid records; never infer version from directory name");
  }
  await writeFile(metadataPath, "x".repeat(65537));
  assert.equal((await detectHostCodex(options)).hostCodexVersion, null);
});

test("npm package record fallback is bound to @openai/codex and its executable", async t => {
  const home = await mkdtemp(join(tmpdir(), "agentfleet-host-npm-record-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, "node_modules/@openai/codex");
  await mkdir(join(root, "bin"), { recursive: true }); await mkdir(join(home, "bin"));
  await writeFile(join(root, "bin/codex.js"), "fixture", { mode: 0o700 });
  await symlink(join(root, "bin/codex.js"), join(home, "bin/codex"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.153.4", bin: { codex: "bin/codex.js" } }));
  const result = await detectHostCodex({ home, uid: null, systemDirectories: [], environment: { PATH: join(home, "bin") }, probe: async () => null });
  assert.equal(result.hostCodexVersion, "0.153.4"); assert.equal(result.hostCodexDefaultVersionSource, "package-record");
});
