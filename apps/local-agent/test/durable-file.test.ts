import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { syncDirectory } from "../src/durable-file.js";

test("Windows skips unsupported directory handles", async (t) => {
  const open = t.mock.method(fs, "open", async () => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  });
  await syncDirectory("D:\\AgentFleet", "win32");
  assert.equal(open.mock.callCount(), 0);
});

test("Unix flushes directory metadata and closes the handle even on failure", async (t) => {
  let failure: Error | undefined;
  let syncs = 0;
  let closes = 0;
  t.mock.method(fs, "open", async () => ({
    sync: async () => { syncs++; if (failure) throw failure; },
    close: async () => { closes++; },
  }));
  await syncDirectory("/state", "linux");
  failure = Object.assign(new Error("I/O failure"), { code: "EIO" });
  await assert.rejects(syncDirectory("/state", "darwin"), failure);
  assert.equal(syncs, 2);
  assert.equal(closes, 2);
});
