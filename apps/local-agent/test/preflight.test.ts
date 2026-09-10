import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, access, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { checkCodexHome, checkSandbox, sandboxArgs, type ProbeRunner } from "../src/preflight.js";

test("new empty Codex home is valid, a non-directory home is reported without reading contents", async t => {
  const root = await mkdtemp(join(tmpdir(), "agentfleet-preflight-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await checkCodexHome(join(root, "missing"))).state, "passed");
  await writeFile(join(root, "file"), "not a directory");
  assert.equal((await checkCodexHome(join(root, "file"))).code, "DATA_UNREADABLE");
});

test("sandbox probe requires real artifacts, checks isolation, clears temp files and strips credentials", async () => {
  for (const mode of ["passed", "no-op", "escaped", "timeout"] as const) {
    let project = "";
    const runner: ProbeRunner = async (_file, args, options) => {
      project = options.cwd;
      assert.deepEqual(Object.keys(options.env).sort(), ["CODEX_HOME", "HOME", "PATH", "TMPDIR"]);
      assert.ok(options.timeout <= 12_000);
      const helpers = options.env.PATH!.split(":")[0]!;
      assert.equal(await readlink(join(helpers, "codex-linux-sandbox")), resolve("codex-test"));
      if (args.includes("--help")) return { stdout: "Usage: codex sandbox [OPTIONS] [COMMAND]..." };
      if (mode === "timeout") throw new Error("timeout");
      const [inside, outside, marker] = args.slice(-3) as [string, string, string];
      if (mode !== "no-op") await writeFile(inside, marker);
      if (mode === "escaped") await writeFile(outside, marker);
      return { stdout: "a false success message" };
    };
    const result = await checkSandbox("codex-test", runner, "linux");
    assert.equal(result.state, mode === "passed" ? "passed" : "failed");
    await assert.rejects(access(project), { code: "ENOENT" });
  }
});

test("sandbox invocation selects legacy subcommands only if actually advertised", () => {
  assert.equal(sandboxArgs("Usage: codex sandbox [OPTIONS] [COMMAND]...", "linux")[1], "-c");
  for (const [platform, name] of [["linux", "linux"], ["darwin", "macos"], ["win32", "windows"]] as const) {
    assert.equal(sandboxArgs(`Commands:\n  ${name} Run sandbox\n`, platform)[1], name);
  }
});

test("Windows no-op probes preserve bounded diagnostics instead of reporting an unexplained missing write", async () => {
  const diagnostic = "Windows test error " + "x".repeat(1000);
  const runner: ProbeRunner = async (_file, args, options) => {
    assert.equal(options.env.CODEX_HOME, options.env.USERPROFILE);
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    if (args.includes("--help")) return { stdout: "Usage: codex sandbox [OPTIONS] [COMMAND]..." };
    assert.ok(args.includes("-EncodedCommand"));
    assert.ok(args.includes('windows.sandbox="unelevated"'), "empty probe home must explicitly enable the Windows backend or workspace-write becomes read-only");
    return { stdout: "", stderr: diagnostic };
  };
  const result = await checkSandbox("codex-test", runner, "win32");
  assert.equal(result.code, "SANDBOX_WRITE_UNVERIFIED");
  assert.ok(result.message.includes(diagnostic.slice(-600)));
  assert.ok(!result.message.includes(diagnostic));
});
