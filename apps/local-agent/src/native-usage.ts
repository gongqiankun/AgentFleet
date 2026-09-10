import { open, realpath } from "node:fs/promises";
import { relative, isAbsolute, join, resolve } from "node:path";
import { tokenUsage } from "./usage.js";
import { isRecord } from "./util.js";

// Read only native counters; never resume the thread or acquire its writer lock.
// Bound reads even when a rollout contains large inline images or a partial append.
export async function readNativeUsage(home: string | undefined, path: string | undefined, threadId: string): Promise<{ usage: Record<string, unknown>; occurredAt: string } | undefined> {
  if (!home || !path) return;
  try {
    const root = await realpath(home), target = await realpath(path);
    const allowed = [join(root, "sessions"), join(root, "archived_sessions")].some(dir => {
      const child = relative(dir, target);
      return child !== "" && child !== ".." && !child.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) && !isAbsolute(child);
    });
    const comparable = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    if (!allowed || comparable(target) !== comparable(resolve(path))) return;
    const file = await open(target, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1) return;
      const head = Buffer.alloc(Math.min(stat.size, 64 * 1024));
      const headRead = await file.read(head, 0, head.length, 0);
      const firstLine = head.subarray(0, headRead.bytesRead).toString("utf8").split("\n")[0];
      const meta: unknown = JSON.parse(firstLine!);
      if (!isRecord(meta) || meta.type !== "session_meta" || !isRecord(meta.payload) || meta.payload.id !== threadId) return;
      const start = Math.max(0, stat.size - 4 * 1024 * 1024);
      const tail = Buffer.alloc(stat.size - start);
      const tailRead = await file.read(tail, 0, tail.length, start);
      const lines = tail.subarray(0, tailRead.bytesRead).toString("utf8").split("\n");
      lines.pop(); // Incomplete trailing record is retried on the next sync.
      if (start > 0) lines.shift();
      for (const line of lines.reverse()) {
        let row: unknown; try { row = JSON.parse(line); } catch { continue; }
        if (!isRecord(row) || row.type !== "event_msg" || !isRecord(row.payload) || row.payload.type !== "token_count" || !isRecord(row.payload.info)) continue;
        const info = row.payload.info;
        const convert = (value: unknown) => {
          if (!isRecord(value)) return;
          return { inputTokens: value.input_tokens, outputTokens: value.output_tokens, cachedInputTokens: value.cached_input_tokens,
            reasoningOutputTokens: value.reasoning_output_tokens, totalTokens: value.total_tokens };
        };
        const usage = tokenUsage({ total: convert(info.total_token_usage), last: convert(info.last_token_usage), modelContextWindow: info.model_context_window });
        const timestamp = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
        if (usage && Number.isFinite(timestamp) && timestamp <= Date.now() + 60_000) return { usage, occurredAt: new Date(timestamp).toISOString() };
      }
    } finally { await file.close(); }
  } catch { /* Missing, rotated, or inaccessible history must not disable sync. */ }
}
