import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const MAX_RUNTIME_BYTES = 512 * 1024 * 1024;
export async function downloadVerified(url: string, path: string, expected: { sha256: string; size: number }): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(expected.sha256) || expected.size < 1 || expected.size > MAX_RUNTIME_BYTES) throw new Error("官方安装包缺少有效 SHA-256 或大小超限");
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`官方安装包下载失败 HTTP ${response.status}`);
  let bytes = 0; const hash = createHash("sha256");
  const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length; if (bytes > expected.size) callback(new Error("安装包大小超过官方声明")); else { hash.update(chunk); callback(null, chunk); }
  } });
  await pipeline(response.body, bounded, createWriteStream(path, { flags: "wx", mode: 0o600 }));
  if (bytes !== expected.size || hash.digest("hex") !== expected.sha256) throw new Error("官方安装包 SHA-256 或大小不一致，拒绝晋升");
}
export async function unpackRuntime(archive: string, entry: string, destination: string): Promise<{ sha256: string; size: number }> {
  const { stdout } = await exec("tar", ["-tzf", archive], { timeout: 30_000, maxBuffer: 16_384 });
  if (stdout.trim() !== entry) throw new Error("官方安装包包含非预期文件，拒绝解包");
  const child = spawn("tar", ["-xOzf", archive, "--", entry], { stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  let size = 0; const hash = createHash("sha256");
  const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.length; if (size > MAX_RUNTIME_BYTES) callback(new Error("解压后程序超限")); else { hash.update(chunk); callback(null, chunk); }
  } });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    await Promise.all([pipeline(child.stdout, bounded, createWriteStream(destination, { flags: "wx", mode: 0o700 })), exited.then(code => { if (code !== 0) throw new Error("安装包解压失败"); })]);
    if (size === 0) throw new Error("安装包没有常规程序文件");
    await chmod(destination, 0o700);
    return { sha256: hash.digest("hex"), size };
  } finally { clearTimeout(timer); child.kill("SIGKILL"); }
}
export async function validateRuntime(executable: string, version: string, schemaHash: string, directory: string): Promise<string[]> {
  const codexHome = join(directory, "codex-home"); const project = join(directory, "project");
  await mkdir(codexHome); await mkdir(project);
  // Deliberately do not inherit API keys, real HOME/CODEX_HOME, user config or projects.
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: directory, CODEX_HOME: codexHome, RUST_LOG: "off" };
  const options = { env, cwd: project, timeout: 20_000, maxBuffer: 64 * 1024 };
  const actual = (await exec(executable, ["--version"], options)).stdout.trim();
  if (actual !== `codex-cli ${version}`) throw new Error("程序报告版本与官方发布版本不一致");
  const schemaDirectory = join(directory, "schema");
  await exec(executable, ["app-server", "generate-json-schema", "--out", schemaDirectory], options);
  const hash = createHash("sha256").update(await readFile(join(schemaDirectory, "codex_app_server_protocol.v2.schemas.json"))).digest("hex");
  if (hash !== schemaHash) throw new Error(`需要适配：新版协议 SHA-256 ${hash} 与当前已验证协议 ${schemaHash} 不同，未自动晋升`);
  await smokeRuntime(executable, env, project);
  return ["程序版本一致", "App Server v2 schema 完全一致", "initialize / initialized 握手", "config/read、thread/list 会话接口（隔离空目录，无账号）"];
}
async function smokeRuntime(executable: string, env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  const child = spawn(executable, ["app-server", "--stdio", "--strict-config", "-c", 'approval_policy="on-request"', "-c", 'sandbox_mode="workspace-write"', "-c", "sandbox_workspace_write.network_access=false"], { env, cwd, stdio: ["pipe", "pipe", "ignore"] });
  const requests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let id = 0;
  const lines = createInterface({ input: child.stdout });
  const fail = (error: Error) => { for (const request of requests.values()) request.reject(error); requests.clear(); };
  child.on("error", fail); child.on("exit", () => fail(new Error("隔离 app-server 提前退出"))); child.stdin.on("error", fail);
  lines.on("line", line => {
    if (line.length > 1024 * 1024) { fail(new Error("协议响应超限")); return; }
    try {
      const message = JSON.parse(line); const pending = requests.get(message.id);
      if (pending) { requests.delete(message.id); if (message.error) pending.reject(new Error("隔离会话接口返回错误")); else pending.resolve(message.result); }
    } catch { fail(new Error("协议响应不是 JSON")); }
  });
  const timer = setTimeout(() => { fail(new Error("隔离 app-server 验证超时")); child.kill("SIGKILL"); }, 25_000);
  const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => { requests.set(++id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); });
  try {
    const initialized = await request("initialize", { clientInfo: { name: "agentfleet-validator", version: "1" }, capabilities: { experimentalApi: true } }) as { platformOs?: string };
    if (initialized?.platformOs !== "linux") throw new Error("验证程序目标平台错误");
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const config = await request("config/read", { includeLayers: false });
    if (!config || typeof config !== "object") throw new Error("配置读取响应不兼容");
    const threads = await request("thread/list", { limit: 1 }) as { data?: unknown[] };
    if (!Array.isArray(threads?.data) || threads.data.length !== 0) throw new Error("会话列表响应不兼容或验证环境不为空");
  } finally { clearTimeout(timer); lines.close(); child.kill("SIGKILL"); }
}
export async function sha256File(path: string): Promise<string> { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
