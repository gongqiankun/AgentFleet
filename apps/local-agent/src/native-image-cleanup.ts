import { spawn } from "node:child_process";
import { NATIVE_IMAGE_HELPER } from "./native-image-helper.js";
import { AgentError } from "./errors.js";

export function nativeImageCleanup(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (process.platform !== "linux") throw new AgentError("IMAGE_CLEANUP_UNSUPPORTED", "原生图片清理目前支持 Linux；其他系统待验证");
  return new Promise((resolve, reject) => {
    // Embedded source works in both SEA and portable releases. No shell, path from user, or pip install.
    const child = spawn("python3", ["-I", "-c", NATIVE_IMAGE_HELPER], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", data => { output += String(data); if (output.length > 32000) child.kill("SIGKILL"); });
    child.stderr.resume();
    child.stdin.on("error", () => undefined);
    child.on("error", () => { clearTimeout(timer); reject(new AgentError("IMAGE_HELPER_UNAVAILABLE", "主机需要 Python 3（含 sqlite3、fcntl），未执行图片清理")); });
    child.on("close", code => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(output);
        if (code !== 0 || result.error) throw new AgentError("IMAGE_CLEANUP_UNCONFIRMED", `${String(result.error ?? "主机回执异常")}；结果未确认，请重新预览核验，不会自动重试清理。`);
        resolve(result);
      } catch (error) { reject(error instanceof AgentError ? error : new AgentError("IMAGE_CLEANUP_UNCONFIRMED", "清理回执不完整，请重新预览核验；不会自动重试")); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
