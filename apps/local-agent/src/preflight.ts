import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, opendir, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { HostCheck } from "./types.js";
import { probeCodeModeHost } from "./code-mode-probe.js";
import { codeModeName } from "./managed-code-mode.js";

export async function resolveCodeModeExecutable(executable: string): Promise<string> {
  const directory = dirname(await realpath(executable));
  // Match Codex InstallContext: a recognized package's resource takes priority
  // over its bin sibling. Do not accept an unrelated executable from PATH.
  const packageRoot = dirname(directory);
  if (directory === join(packageRoot, "bin")) {
    try {
      const resource = join(packageRoot, "codex-resources", codeModeName());
      if ((await stat(join(packageRoot, "codex-package.json"))).isFile() && (await stat(resource)).isFile()) return resource;
    } catch { /* Legacy standalone/npm layouts use the native binary sibling. */ }
  }
  return join(directory, codeModeName());
}
export async function checkCodeMode(executable: string): Promise<HostCheck> {
  try {
    await probeCodeModeHost(await resolveCodeModeExecutable(executable));
    return check("tools", "passed", "CODE_MODE_VERIFIED", "Code Mode 执行程序实测通过（不调用模型）");
  } catch {
    return check("tools", "failed", "CODE_MODE_UNAVAILABLE", "面板 Codex 缺少可用的 codex-code-mode-host 执行程序，请检查并更新连接服务。原会话仍可读取", "agent.update");
  }
}

const execute = promisify(execFile);
export type ProbeRunner = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;
const run: ProbeRunner = async (file, args, options) => execute(file, args, { ...options, encoding: "utf8" });

export function check(id: HostCheck["id"], state: HostCheck["state"], code: string, message: string, action?: HostCheck["action"]): HostCheck {
  return { id, state, code, message, checkedAt: new Date().toISOString(), ...(action ? { action } : {}) };
}

// Probe only accessibility, never read or send authentication/config contents.
export async function checkCodexHome(home: string): Promise<HostCheck> {
  try {
    for (const directory of [home, join(home, "sessions"), join(home, "archived_sessions")]) {
      try { const handle = await opendir(directory); await handle.close(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    try { await access(join(home, "config.toml"), constants.R_OK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return check("data", "passed", "DATA_ACCESSIBLE", "Codex 数据目录可读取；没有历史数据也可继续连接");
  } catch {
    return check("data", "failed", "DATA_UNREADABLE", "连接服务无法读取所选 Codex 数据目录。请核对下方运行账号与数据目录", "diagnostics.collect");
  }
}

export function sandboxArgs(help: string, platform: NodeJS.Platform): string[] {
  const legacy = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";
  return ["sandbox", ...(new RegExp(`^\\s+${legacy}\\s+`, "m").test(help) ? [legacy] : []),
    "-c", 'sandbox_mode="workspace-write"', "-c", "sandbox_workspace_write.network_access=false",
    "-c", "sandbox_workspace_write.exclude_slash_tmp=true", "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true", "--"];
}

// A real, bounded no-model probe. All writes are in our disposable directory;
// verify artifacts, not stdout (some sandbox versions suppress child output).
export async function checkSandbox(executable: string, runner: ProbeRunner = run, platform = process.platform): Promise<HostCheck> {
  let directory: string | undefined;
  let phase = "start";
  try {
    directory = await mkdtemp(join(tmpdir(), "agentfleet-preflight-"));
    const project = join(directory, "project"), home = join(directory, "home");
    await mkdir(project); await mkdir(home);
    // Codex deliberately refuses to create its argv0 helpers when CODEX_HOME
    // is under /tmp. Its non-root Linux sandbox still needs this re-entry name.
    // Supply only the selected executable's alias in our private probe tree;
    // never borrow a different Codex from the user's PATH or use real auth data.
    const helpers = join(directory, "helpers");
    if (platform === "linux") {
      await mkdir(helpers, { mode: 0o700 });
      await symlink(resolve(executable), join(helpers, "codex-linux-sandbox"));
    }
    const windows = platform === "win32";
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const env: NodeJS.ProcessEnv = { HOME: home, CODEX_HOME: home, ...(windows
      ? { SystemRoot: systemRoot, WINDIR: systemRoot, USERPROFILE: home, TEMP: home, TMP: home, PATH: join(systemRoot, "System32") }
      : { PATH: `${platform === "linux" ? `${helpers}:` : ""}/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: home }) };
    const options = { cwd: project, env, timeout: 12_000, maxBuffer: 65_536 };
    const { stdout } = await runner(executable, ["sandbox", "--help"], { ...options, timeout: 3_000 });
    phase = "execute";
    const inside = join(project, "inside.txt"), outside = join(directory, "outside.txt"), marker = randomUUID();
    const command = windows
      ? [join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-Command",
        `& { param($inside,$outside,$marker) [IO.File]::WriteAllText($inside,$marker); try { [IO.File]::WriteAllText($outside,$marker); exit 42 } catch { exit 0 } } '${inside.replaceAll("'", "''")}' '${outside.replaceAll("'", "''")}' '${marker}'`]
      : ["/bin/sh", "-c", 'printf %s "$3" > "$1" || exit 41; if (printf %s "$3" > "$2") 2>/dev/null; then exit 42; fi; exit 0', "agentfleet-probe", inside, outside, marker];
    await runner(executable, [...sandboxArgs(stdout, platform), ...command], options);
    phase = "write";
    if (await readFile(inside, "utf8") !== marker) throw new Error("missing inside write");
    phase = "isolation";
    try { await access(outside); throw new Error("outside write escaped sandbox"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return check("sandbox", "passed", "SANDBOX_VERIFIED", "临时目录实测通过：项目内可写，项目外写入被阻止");
  } catch (error) {
    const failure = error as { code?: unknown; killed?: boolean; stderr?: unknown };
    const code = failure.killed ? "SANDBOX_TIMEOUT" : phase === "write" || failure.code === 41 ? "SANDBOX_WRITE_UNVERIFIED"
      : phase === "isolation" || failure.code === 42 ? "SANDBOX_ISOLATION_FAILED" : "SANDBOX_START_FAILED";
    const reason = code === "SANDBOX_TIMEOUT" ? "隔离检查超时" : code === "SANDBOX_WRITE_UNVERIFIED" ? "未能在临时项目内完成写入"
      : code === "SANDBOX_ISOLATION_FAILED" ? "未能确认项目外写入已被阻止" : "系统未能启动写入隔离检查";
    // This subprocess receives an empty temporary CODEX_HOME and no credentials.
    // Keep only its bounded diagnostic, never the exec error's entire command/env.
    const detail = typeof failure.stderr === "string" ? failure.stderr.replace(/\u001b\[[0-9;]*m/g, "").replace(/[\r\n\t]+/g, " ").trim().slice(-600) : "";
    return check("sandbox", "failed", code, `${reason}，暂仅查看会话。不会自动关闭隔离。${detail ? `检查详情：${detail}` : "可重新自检，或检查并更新连接服务"}`, "diagnostics.collect");
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
