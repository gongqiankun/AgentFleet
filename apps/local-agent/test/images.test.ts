import test from "node:test";
import assert from "node:assert/strict";
import { parseImages, validImageUrl } from "../src/images.js";
import { CodexAppServer, sanitizeThreadItem, type AppServerCallbacks } from "../src/app-server.js";
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
test("only bounded inline raster bytes are accepted, never URLs, SVG, paths or mislabeled content", () => {
  assert.deepEqual(parseImages(undefined), []); assert.deepEqual(parseImages([png]), [png]);
  for (const value of ["https://example.test/a.png", "file:///root/secret", "data:image/svg+xml;base64,PHN2Zy8+", png.replace("image/png", "image/jpeg"), "data:image/png;base64,AAAA", png + "A"]) assert.equal(validImageUrl(value), false);
  assert.throws(() => parseImages(Array(5).fill(png)));
  assert.throws(() => parseImages([png.slice(0, 22) + "A".repeat(200_000)]));
  assert.throws(() => parseImages({url: png}));
});
test("native image inputs preserve actual image bytes; text-only models fail before RPC", () => {
  const server = new CodexAppServer({} as AppServerCallbacks);
  const internal = server as unknown as { imageInputs(prompt: string, images: unknown, model?: string): Record<string, unknown>[]; codexCatalog: unknown };
  internal.codexCatalog = { models: [{ model: "text-only", inputModalities: ["text"] }, { model: "vision", inputModalities: ["text", "image"] }], modes: [] };
  assert.deepEqual(internal.imageInputs("", [png], "vision"), [{type:"image",url:png}]);
  assert.throws(() => internal.imageInputs("describe", [png], "text-only"), /不支持图片/);
  assert.equal(internal.imageInputs("describe", [png], "vision").length, 2);
  assert.deepEqual(sanitizeThreadItem({ id: "same-item", type: "userMessage", content: [{ type: "image", url: png }] }),
    { id: "same-item", type: "userMessage", content: [{type:"image",url:png}] });
  const unsafe = sanitizeThreadItem({id:"unsafe",type:"userMessage",content:[{type:"localImage",path:"/root/private.png"},{type:"image",url:"https://tracker.test/pixel"}]});
  assert.ok(JSON.stringify(unsafe).includes("图片未同步")); assert.ok(!JSON.stringify(unsafe).includes("private.png"));
});
