import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexCatalog, parseRuntimeSettings, validateCodexSettings } from "../src/codex-settings.js";
import { sanitizeInspection } from "../src/codex-inspection.js";
import { reconcileSessionTitle } from "../src/session-title.js";

test("preview updates never overwrite cloud names; explicit host renames remain shared", () => {
  assert.equal(reconcileSessionTitle("优化项目", "部署", "preview"), "优化项目");
  assert.equal(reconcileSessionTitle("优化项目", "部署"), "优化项目", "old agents fail closed");
  assert.equal(reconcileSessionTitle("优化项目", "新名称", "name"), "新名称");
  assert.equal(reconcileSessionTitle("New Codex session", "优化项目", "preview"), "优化项目");
  assert.equal(reconcileSessionTitle(undefined, "宿主机会话", "preview"), "宿主机会话");
});

test("control plane gates service tiers and personality and preserves accepted null reset", () => {
  const catalog = parseCodexCatalog({ models: [{ model: "test", displayName: "Test", efforts: [], defaultEffort: "", serviceTiers: [{ id: "fast", name: "Fast" }], supportsPersonality: true }], modes: ["default"], fetchedAt: "2026-09-05" });
  const settings = { model: "test", serviceTier: "fast", personality: "friendly" };
  assert.deepEqual(validateCodexSettings(settings, catalog), settings);
  assert.throws(() => validateCodexSettings({ ...settings, serviceTier: "invented" }, catalog));
  assert.throws(() => validateCodexSettings(settings, { ...catalog!, models: [{ ...catalog!.models[0]!, supportsPersonality: false }] }));
  assert.deepEqual(parseRuntimeSettings({ accepted: { model: "test", serviceTier: null, personality: "friendly", secret: "omit" } }), { accepted: { model: "test", serviceTier: null, personality: "friendly" } });
});

test("inspection projection only permits known sections and display fields", () => {
  const result = sanitizeInspection({ cwd: "/project", observedAt: "2026-09-05", secret: "omit", sections: { account: { available: true, rows: [{ name: "Account", detail: "ChatGPT", status: "ready", accessToken: "omit" }], truncated: false, raw: "omit" }, unknown: { secret: "omit" } } });
  assert.ok(result);
  assert.equal(JSON.stringify(result).includes("omit"), false);
  assert.equal(JSON.stringify(result).includes("unknown"), false);
});
