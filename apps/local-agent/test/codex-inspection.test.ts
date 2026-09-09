import assert from "node:assert/strict";
import test from "node:test";
import { inspectCodex, inspectionSection } from "../src/codex-inspection.js";
test("environment snapshots only export safe metadata, never credentials or hook commands", () => {
  const secret = "do-not-export-token";
  const account = inspectionSection("account", { account: { type: "apiKey", apiKey: secret, email: secret } });
  const config = inspectionSection("config", { config: { model: "model-x", model_provider: "openai", api_key: secret, env: { TOKEN: secret } }, origins: { model: { name: { type: "user", file: secret } } } });
  const hooks = inspectionSection("hooks", { data: [{ hooks: [{ eventName: "Stop", handlerType: "command", enabled: true, command: secret, trustStatus: "trusted" }] }] });
  assert.ok(!JSON.stringify({ account, config, hooks }).includes(secret));
  assert.equal(config.rows[0]?.status, "user");
});
test("inspection uses the exact project cwd and isolates unsupported sections", async () => {
  const calls: [string, unknown][] = [];
  const result = await inspectCodex(async (method, params) => {
    calls.push([method, params]);
    if (method === "hooks/list") throw new Error("unsupported");
    if (method === "skills/list") return { data: [{ cwd: "/project-a", skills: Array.from({ length: 30 }, (_, i) => ({ name: `skill-${i}`, description: "metadata", enabled: true })) }] };
    return {};
  }, "/project-a", "thread-a");
  assert.deepEqual(calls.find(([method]) => method === "config/read")?.[1], { cwd: "/project-a", includeLayers: false });
  assert.deepEqual(calls.find(([method]) => method === "skills/list")?.[1], { cwds: ["/project-a"], forceReload: true });
  assert.equal(result.sections.hooks?.available, false);
  assert.equal(result.sections.skills?.rows.length, 25); assert.equal(result.sections.skills?.truncated, true);
  assert.equal(result.sections.account?.available, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 28000);
  assert.deepEqual(calls.find(([method]) => method === "thread/backgroundTerminals/list")?.[1], { threadId: "thread-a", limit: 25 });
  assert.deepEqual(calls.find(([method]) => method === "thread/goal/get")?.[1], { threadId: "thread-a" });
});
test("terminal and permission inspection expose only allowlisted fields", () => {
  const terminals = inspectionSection("terminals", { data: [{ processId: "p1", command: "npm run test", cwd: "/project", env: { TOKEN: "do-not-export" }, rawOutput: "do-not-export" }], nextCursor: "next" });
  assert.equal(terminals.rows[0]?.name, "p1"); assert.equal(terminals.truncated, true);
  assert.equal(JSON.stringify(terminals).includes("do-not-export"), false);
  const profiles = inspectionSection("permissions", { data: [{ id: "custom", description: "Project", allowed: true, secrets: "do-not-export" }] });
  assert.match(profiles.rows[0]!.status, /面板仍受固定策略约束/);
});
