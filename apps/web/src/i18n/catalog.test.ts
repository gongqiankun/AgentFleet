import ts from "typescript";
import { expect, it } from "vitest";
import english from "./en.json";

const sources = import.meta.glob<string>("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });
it("every static UI translation has an English entry", () => {
  const missing: string[] = [];
  for (const [path, source] of Object.entries(sources)) {
    if (path.includes(".test.")) continue;
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t") {
        const key = node.arguments[0];
        if (key && ts.isStringLiteral(key) && !(key.text in english)) missing.push(`${path}: ${key.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  expect(missing).toEqual([]);
});
