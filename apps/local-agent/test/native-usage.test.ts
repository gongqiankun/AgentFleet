import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNativeUsage } from "../src/native-usage.js";
const counts = (n: number) => ({ input_tokens: n * 8, output_tokens: n * 2, cached_input_tokens: n * 3, reasoning_output_tokens: n, total_tokens: n * 10 });
const row = (n: number) => JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: counts(n), last_token_usage: counts(1), model_context_window: 100000 } } }) + "\n";
test("reads completed native counters despite partial appends and large preceding image records", async t => {
 const home = await mkdtemp(join(tmpdir(), "native-usage-")); t.after(() => rm(home, { recursive: true, force: true }));
 await mkdir(join(home, "sessions")); const path = join(home, "sessions", "rollout.jsonl");
 await writeFile(path, JSON.stringify({ type: "session_meta", payload: { id: "thread" } }) + "\n" + JSON.stringify({ image: "x".repeat(5 * 1024 * 1024) }) + "\n" + row(10) + '{"partial":');
 const first = await readNativeUsage(home, path, "thread"); assert.equal((first?.usage.total as Record<string, number>).totalTokens, 100);
 await appendFile(path, 'true}\n' + row(12));
 const next = await readNativeUsage(home, path, "thread"); assert.equal((next?.usage.total as Record<string, number>).totalTokens, 120);
 assert.equal(next?.occurredAt, "2026-01-01T00:00:00.000Z");
 assert.equal(await readNativeUsage(home, path, "other-thread"), undefined);
 const outside = join(home, "outside.jsonl"); await writeFile(outside, await import("node:fs/promises").then(fs => fs.readFile(path)));
 assert.equal(await readNativeUsage(home, outside, "thread"), undefined);
 if (process.platform !== "win32") { const link = join(home, "sessions", "link.jsonl"); await symlink(outside, link); assert.equal(await readNativeUsage(home, link, "thread"), undefined); }
});
