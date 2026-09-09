import test from "node:test";
import assert from "node:assert/strict";
import { parseModels, validateSettings, turnSettingsParams, readObservedSettings, type CodexCatalog } from "../src/codex-settings.js";

const catalog: CodexCatalog = { models: [{ model: "model-a", displayName: "A", efforts: ["low", "high"], defaultEffort: "low" }], modes: ["default", "plan"], fetchedAt: new Date().toISOString() };
test("service tier and personality are capability-gated typed parameters, including explicit reset", () => {
  const models = parseModels({ data: [{ model: "model-a", supportedReasoningEfforts: [], serviceTiers: [{ id: "fast", name: "Fast", secret: "omit" }], supportsPersonality: true }] });
  assert.deepEqual(models[0]?.serviceTiers, [{ id: "fast", name: "Fast" }]);
  const capable = { ...catalog, models };
  const settings = { model: "model-a", serviceTier: "fast", personality: "pragmatic" } as const;
  assert.deepEqual(turnSettingsParams(validateSettings(settings, capable)), settings);
  assert.deepEqual(turnSettingsParams(validateSettings({ model: "model-a", serviceTier: null }, capable)), { model: "model-a", serviceTier: null });
  for (const value of [settings, { model: "model-a", personality: "friendly" }, { model: "model-a", serviceTier: "invented" }]) assert.throws(() => validateSettings(value, catalog));
  assert.throws(() => validateSettings({ model: "model-a", personality: "invented" }, capable));
});
test("only host-advertised models, effort and modes can be selected", () => {
  assert.deepEqual(validateSettings({ model: "model-a", effort: "high", mode: "plan" }, catalog), { model: "model-a", effort: "high", mode: "plan" });
  for (const value of [{ model: "other-host-model" }, { model: "model-a", effort: "ultra" }, { model: "model-a", mode: "other" }, { model: "model-a", config: { sandbox_mode: "danger-full-access" } }]) assert.throws(() => validateSettings(value, catalog));
  assert.throws(() => validateSettings({ model: "model-a" }, undefined));
  assert.throws(() => validateSettings({ model: "model-a", mode: "plan" }, { ...catalog, modes: [] }));
  assert.equal(validateSettings(undefined, undefined), undefined);
});
test("plan uses typed collaborationMode, never a text prompt or arbitrary instructions", () => {
  assert.deepEqual(turnSettingsParams({ model: "model-a", effort: "high", mode: "plan" }), {
    model: "model-a", effort: "high", collaborationMode: { mode: "plan", settings: { model: "model-a", reasoning_effort: "high", developer_instructions: null } },
  });
  assert.deepEqual(turnSettingsParams(undefined), {});
  assert.deepEqual(turnSettingsParams({ model: "model-a" }), { model: "model-a" });
});
test("model discovery filters hidden entries and extracts only displayable fields", () => {
  assert.deepEqual(parseModels({ data: [{ model: "model-a", displayName: "A", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }], secret: "must not be copied" }, { hidden: true }] }), [{ model: "model-a", displayName: "A", defaultEffort: "low", efforts: ["low"] }]);
  assert.throws(() => parseModels({ data: [{}] }));
});
test("observed settings only come from an actual model-bearing response", () => {
  assert.equal(readObservedSettings({ codexVersion: "0.153.2" }), undefined);
  const actual = readObservedSettings({ model: "model-a", modelProvider: "provider", reasoningEffort: "high", config: { apiKey: "never export" } });
  assert.equal(actual?.model, "model-a");
  assert.equal(actual?.effort, "high");
  assert.ok(actual?.observedAt);
  assert.equal(Object.hasOwn(actual!, "config"), false);
});
