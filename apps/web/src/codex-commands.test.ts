import { expect, it } from "vitest";
import { codexCommands } from "./lib/codex-commands";
it("registers all reviewed CLI commands including aliases with honest coverage notes", () => {
  const names = "permissions ide keymap vim setup-default-sandbox sandbox-add-read-dir agent subagents apps plugins hooks clear rename archive delete compact copy diff exit experimental approve memories skills import feedback init logout mcp mention model fast plan goal personality ps stop fork app side btw raw resume new quit review status usage debug-config statusline title theme pets pet".split(" ");
  const registry = new Map(codexCommands.map(c=>[c.name,c]));
  expect(registry.size).toBe(codexCommands.length);
  for (const name of names) { expect(registry.has(name), name).toBe(true); expect(registry.get(name)!.note.length).toBeGreaterThan(12); }
  expect(registry.get("goal")!.coverage).toBe("partial");
  expect(registry.get("permissions")!.coverage).toBe("partial");
  expect(registry.get("delete")!.action).toBe("pending");
  expect(registry.get("quit")!.canonical).toBe("exit");
  expect(registry.get("pets")!.coverage).toBe("terminal");
});
