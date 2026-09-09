import test from "node:test";
import assert from "node:assert/strict";
import { parseImages, validImageUrl } from "../src/images.js";
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
test("only bounded inline raster bytes are accepted, never URLs, SVG, paths or mislabeled content", () => {
  assert.deepEqual(parseImages(undefined), []); assert.deepEqual(parseImages([png]), [png]);
  for (const value of ["https://example.test/a.png", "file:///root/secret", "data:image/svg+xml;base64,PHN2Zy8+", png.replace("image/png", "image/jpeg"), "data:image/png;base64,AAAA", png + "A"]) assert.equal(validImageUrl(value), false);
  assert.throws(() => parseImages(Array(5).fill(png)));
  assert.throws(() => parseImages([png.slice(0, 22) + "A".repeat(200_000)]));
  assert.throws(() => parseImages({url: png}));
});

