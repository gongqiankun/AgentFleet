import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { appServerLaunchArgs } from "../src/app-server.js";

const executable = process.env.AGENTFLEET_TEST_CODEX_EXECUTABLE ?? fileURLToPath(new URL("../../../../packaging/build/native-baseline/codex", import.meta.url));

test("native initialization tolerates desktop configuration and retains remote permission overrides without editing the home", { skip: !existsSync(executable), timeout: 20_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), "agentfleet-desktop-config-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const contents = 'sandbox_mode = "danger-full-access"\nappearanceTheme = "dark"\nappearanceDarkCodeThemeId = "absolutely"\nappearanceLightCodeThemeId = "absolutely"\n[computer_use.windows.always_allowed_app_ids]\n"io.github.wangnov.codexappmanager" = true\n';
  const configPath = join(home, "config.toml");
  await writeFile(configPath, contents);
  const child = spawn(executable, appServerLaunchArgs(), {
    cwd: home, stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, CODEX_HOME: home },
  });
  const lines = createInterface({ input: child.stdout });
  child.stderr.resume();
  const timer = setTimeout(() => child.kill(), 15_000);
  t.after(() => { clearTimeout(timer); lines.close(); child.kill(); });
  const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const config = await new Promise<Record<string, unknown>>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", code => reject(new Error(`Codex exited before config response: ${code}`)));
    lines.on("line", line => {
      try {
        const response = JSON.parse(line);
        if (response.error) throw new Error(JSON.stringify(response.error));
        if (response.id === 1) {
          assert.ok(response.result.platformOs);
          send({ method: "initialized" });
          send({ id: 2, method: "config/read", params: { includeLayers: false } });
        }
        if (response.id === 2) resolve(response.result.config);
      } catch (error) { reject(error); }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "agentfleet-config-test", version: "1" } } });
  });
  assert.equal(config.approval_policy, "on-request");
  assert.equal(config.sandbox_mode, "workspace-write");
  assert.deepEqual(config.sandbox_workspace_write, { writable_roots: [], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true });
  assert.equal(await readFile(configPath, "utf8"), contents);
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.stdin.end();
  await exited;
});
