import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { stageCodeModeHost, validCodeModeArtifact } from "../src/managed-code-mode.js";
import { parseManagedRuntimeTarget } from "../src/managed-runtime-update.js";
import { checkCodeMode } from "../src/preflight.js";

test("Code Mode staging rejects missing, mismatched, oversized and corrupt artifacts before execution", async t => {
  const root = await mkdtemp(join(tmpdir(), "agentfleet-code-mode-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  const platform = `${process.platform}-${process.arch}`, version = "0.153.4";
  const bytes = "not-executable-fixture", sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifact = { file: `codex-code-mode-host-${platform}-${version}-${sha256.slice(0, 16)}${process.platform === "win32" ? ".exe" : ""}`, sha256, size: bytes.length, format: "raw" as const };
  assert.equal(validCodeModeArtifact(artifact, version, platform), true);
  for (const value of [{ ...artifact, file: "../../codex" }, { ...artifact, size: 193 * 1024 * 1024 }, { ...artifact, sha256: "bad" }]) assert.equal(validCodeModeArtifact(value, version, platform), false);
  await assert.rejects(stageCodeModeHost(root, version, "https://fleet.example", undefined), { code: "CODE_MODE_UNAVAILABLE" });
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("corrupt"));
  await assert.rejects(stageCodeModeHost(root, version, "https://fleet.example", artifact), { code: "CODE_MODE_CHECKSUM_FAILED" });
  assert.equal(fetch.mock.callCount(), 1);
  const missing = await checkCodeMode(join(root, "absent", "codex"));
  assert.equal(missing.state, "failed"); assert.equal(missing.code, "CODE_MODE_UNAVAILABLE");
  assert.throws(() => parseManagedRuntimeTarget({ codeModeHosts: { "linux-x64": artifact } }));
});

test("control-plane and local-agent run the same Code Mode execution probe", async () => {
  const local = await readFile(new URL("../../src/code-mode-probe.ts", import.meta.url), "utf8").catch(() => readFile(new URL("../../../src/code-mode-probe.ts", import.meta.url), "utf8"));
  const remote = await readFile(new URL("../../../control-plane/src/code-mode-probe.ts", import.meta.url), "utf8");
  assert.equal(local, remote);
});
