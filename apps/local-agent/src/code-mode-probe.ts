import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** No model, credentials, user configuration, network or tools. Exercises the
 * actual Code Mode isolate over the versioned length-prefixed stdio protocol.
 * Kept identical in local-agent and control-plane for independently built apps.
 */
export async function probeCodeModeHost(executable: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-code-mode-check-"));
  const env: NodeJS.ProcessEnv = { HOME: directory, CODEX_HOME: directory, PATH: process.env.PATH,
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, USERPROFILE: directory, TEMP: directory, TMP: directory } : {}) };
  const child = spawn(executable, ["--listen", "stdio"], { env, cwd: directory, stdio: ["pipe", "pipe", "ignore"], shell: false });
  let buffer: Buffer = Buffer.alloc(0);
  let timer: NodeJS.Timeout | undefined;
  const send = (value: unknown) => { const data = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32LE(data.length); child.stdin.write(Buffer.concat([header, data])); };
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = () => reject(new Error("Code Mode 执行探针失败（程序缺失、协议不兼容或执行失败）"));
      child.on("error", fail); child.stdin.on("error", fail); child.on("exit", fail);
      timer = setTimeout(fail, 10_000);
      child.stdout.on("data", (chunk: Buffer) => {
        try {
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length > 256_000) throw new Error("frame bound");
          while (buffer.length >= 4) {
            const length = buffer.readUInt32LE(0);
            if (length > 256_000) throw new Error("frame bound");
            if (buffer.length < length + 4) break;
            const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
            buffer = buffer.subarray(length + 4);
            if (message.type === "connection/ready" && message.selectedVersion === 1) {
              send({ type: "operation/request", id: 1, request: { method: "session/open", sessionId: "probe" } });
            } else if (message.type === "operation/response" && message.id === 1 && message.result?.status === "ok") {
              send({ type: "operation/request", id: 2, request: { method: "session/execute", sessionId: "probe",
                request: { tool_call_id: "probe", enabled_tools: [], source: 'text("agentfleet-code-mode-" + (6 * 7));', yield_time_ms: 1000, max_output_tokens: 128 } } });
            } else if (message.type === "execute/initialResponse" && message.id === 2) {
              if (message.result?.status !== "ok" || !JSON.stringify(message.result.value).includes("agentfleet-code-mode-42") || message.result.value.error_text) throw new Error("execution failed");
              resolve();
            } else if (message.type === "connection/rejected" || message.result?.status === "error" || message.type === "delegate/request") fail();
          }
        } catch { fail(); }
      });
      send({ type: "connection/hello", supportedVersions: [1], requiredCapabilities: [], optionalCapabilities: [] });
    });
  } finally {
    if (timer) clearTimeout(timer);
    child.stdin.destroy();
    const exited = new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("close", () => resolve()); });
    child.kill("SIGKILL"); // Only our isolated no-tool diagnostic child.
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
}
