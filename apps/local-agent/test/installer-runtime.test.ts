import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { stageSandboxHelper } from "../src/managed-sandbox-helper.js";

test("Linux sandbox helper is checksum-verified, reusable and rejects symlink destinations", { skip: process.platform !== "linux" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-installer-helper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = join(directory, "managed"), temporary = join(directory, "temp");
  await mkdir(cache); await mkdir(temporary);
  const fixture = join(directory, "fixture");
  await writeFile(fixture, "verified-test-helper");
  const source = await readFile(new URL("../../../../packaging/install.sh", import.meta.url), "utf8");
  const prepare = source.slice(source.indexOf("prepare_managed_sandbox_helper() {"), source.indexOf("prepare_managed_codex() {"));
  const script = `set -eu\n${prepare}\ndownload() { cp "$HELPER_FIXTURE" "$2"; }\nprepare_managed_sandbox_helper`;
  const env = { ...process.env, INSTALL_UID: "1000", CODEX_CACHE_DIR: cache, TEMP_DIR: temporary, CONTROL_URL: "https://test.invalid", HELPER_FIXTURE: fixture,
    CODEX_BWRAP_SHA256: createHash("sha256").update("verified-test-helper").digest("hex") };
  const run = promisify(execFile);
  await run("/bin/sh", ["-c", script], { env });
  const installed = join(cache, "codex-resources", "bwrap");
  assert.equal(await readFile(installed, "utf8"), "verified-test-helper");
  await writeFile(fixture, "corrupted-download");
  await run("/bin/sh", ["-c", script], { env }); // good cached file is reused
  await writeFile(installed, "corrupted-cache");
  await assert.rejects(run("/bin/sh", ["-c", script], { env }), /SHA-256 verification failed/);
  assert.equal(await readFile(installed, "utf8"), "corrupted-cache"); // failed download never activates
  await rm(installed);
  await symlink(fixture, installed);
  await assert.rejects(run("/bin/sh", ["-c", script], { env }), /unsafe managed sandbox helper path/);
});

test("runtime promotion refuses missing, modified or symlinked Linux helpers", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-promotion-helper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const resources = join(directory, "codex", "codex-resources"), stage = join(directory, "stage");
  await mkdir(resources, { recursive: true }); await mkdir(stage);
  await assert.rejects(stageSandboxHelper(directory, stage, "linux", "x64"), { code: "RUNTIME_HELPER_UNAVAILABLE" });
  await writeFile(join(resources, "bwrap"), "not-official-bytes");
  await assert.rejects(stageSandboxHelper(directory, stage, "linux", "x64"), { code: "RUNTIME_HELPER_UNAVAILABLE" });
  await rm(join(resources, "bwrap"));
  await symlink(join(directory, "missing"), join(resources, "bwrap"));
  await assert.rejects(stageSandboxHelper(directory, stage, "linux", "x64"), { code: "RUNTIME_HELPER_UNAVAILABLE" });
  await stageSandboxHelper(directory, stage, "darwin", "arm64");
  await stageSandboxHelper(directory, stage, "win32", "x64");
  await assert.rejects(stageSandboxHelper(directory, stage, "linux", "arm64"), { code: "RUNTIME_HELPER_UNAVAILABLE" });
});

test("runtime helper downloads are bounded, version-specific and never activate unverified bytes", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-helper-download-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = "verified-official-fixture";
  const hash = createHash("sha256").update(bytes).digest("hex");
  const artifact = { file: `codex-bwrap-linux-x64-0.160.0-${hash.slice(0, 16)}`, sha256: hash, size: bytes.length, format: "raw" as const };
  const fetchMock = t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    assert.equal(String(url), `https://fleet.example/downloads/managed-codex/${artifact.file}`);
    assert.equal(options.redirect, "error");
    return new Response(bytes);
  });
  const stage = join(directory, "stage"); await mkdir(stage);
  assert.equal(await stageSandboxHelper(directory, stage, "linux", "x64", "0.160.0", "https://fleet.example", artifact), hash);
  assert.equal(await readFile(join(stage, "codex-resources", "bwrap"), "utf8"), bytes);
  for (const response of [new Response("corrupt"), new Response(bytes + "exceeds-size"), new Response("not found", { status: 404 })]) {
    fetchMock.mock.mockImplementation(async () => response);
    const rejected = await mkdtemp(join(directory, "rejected-"));
    await assert.rejects(stageSandboxHelper(directory, rejected, "linux", "x64", "0.160.0", "https://fleet.example", artifact), { code: "RUNTIME_HELPER_UNAVAILABLE" });
    await assert.rejects(access(join(rejected, "codex-resources")), { code: "ENOENT" });
  }
});

test("Linux installer reuses only isolated schema-verified runtime, never the PATH Codex", { skip: process.platform !== "linux" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-installer-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = join(directory, "managed"), host = join(directory, "host"), staging = join(directory, "stage");
  for (const path of [cache, host, staging]) await mkdir(path);
  await writeFile(join(host, "codex"), '#!/bin/sh\ntouch "$HOST_MARKER"\necho "codex-cli 9.0.0"\n', { mode: 0o755 });
  const source = await readFile(new URL("../../../../packaging/install.sh", import.meta.url), "utf8");
  const prepare = source.slice(source.indexOf("prepare_managed_codex() {"), source.indexOf("\ntrap cleanup EXIT HUP INT TERM"));
  assert.ok(prepare.length > 1000);
  const script = `set -eu\n${prepare}\ndownload() { exit 83; }\nprepare_managed_codex\nprintf '%s' "$SELECTED_CODEX_VERSION"`;
  const environment = { ...process.env, PATH: `${host}:/usr/bin:/bin`, HOST_MARKER: join(directory, "host-was-executed"), INSTALL_UID: "1000",
    CODEX_CACHE_DIR: cache, CODEX_CACHE_EXECUTABLE: join(cache, "codex"), TEMP_DIR: staging, CONTROL_URL: "https://test.invalid",
    CODEX_COMPAT_SCHEMA_HASH: createHash("sha256").update("test-schema").digest("hex"), EXISTING_PROFILE_CODEX_EXECUTABLE: join(host, "codex") };
  await assert.rejects(promisify(execFile)("/bin/sh", ["-c", script], { env: environment }), { code: 83 });
  await assert.rejects(access(environment.HOST_MARKER), { code: "ENOENT" });
  await writeFile(join(cache, "codex"), '#!/bin/sh\nif [ "$1" = --version ]; then echo "codex-cli 0.153.4"; else printf test-schema > "$4/codex_app_server_protocol.v2.schemas.json"; fi\n', { mode: 0o755 });
  const result = await promisify(execFile)("/bin/sh", ["-c", script], { env: environment });
  assert.match(result.stdout, /0\.153\.4$/);
  await assert.rejects(access(environment.HOST_MARKER), { code: "ENOENT" });
});
