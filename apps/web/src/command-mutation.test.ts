// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { commandMutationId, mergeCommandReceipts, rememberCommandReceipt } from "./lib/command-mutation";
import { mapCommandReceipt } from "./lib/api";
import type { CommandReceipt } from "./lib/types";

const key = "agentfleet.mutation:user:session";
const signature = "claim-original-thread";
const receipt = (state: string, outcome?: string): CommandReceipt => ({
  id: "command-old", clientMutationId: "mutation-old", type: "thread.claim", state, outcome, createdAt: "2026-09-07T11:53:37Z",
});
beforeEach(() => {
  sessionStorage.clear();
  sessionStorage.setItem(key, JSON.stringify({ signature, id: "mutation-old" }));
});

describe("explicit command retries", () => {
  it("keeps newer host outcomes when an old submission or snapshot arrives late", () => {
    const accepted = receipt("accepted", "pending");
    const applied = { ...receipt("applied", "succeeded"), updatedAt: "2026-09-07T11:53:38Z" };
    expect(mergeCommandReceipts([applied], [accepted])).toEqual([applied]);
    expect(mergeCommandReceipts([accepted], [applied])).toEqual([applied]);
    expect(mergeCommandReceipts([accepted], [])).toEqual([accepted]);
    const unknown = { ...receipt("unknown", "unknown"), updatedAt: "2026-09-07T11:53:39Z" };
    expect(mergeCommandReceipts([accepted], [unknown])).toEqual([unknown]);
    const reconciled = { ...applied, updatedAt: "2026-09-07T11:53:40Z" };
    expect(mergeCommandReceipts([unknown], [reconciled])).toEqual([reconciled]);
  });
  it.each(["applied", "rejected", "failed", "invalidated", "expired"])("rotates a legacy cached key after a confirmed %s receipt", (state) => {
    expect(commandMutationId(sessionStorage, key, signature, "mutation-new", [receipt(state, "failed")])).toBe("mutation-new");
    expect(JSON.parse(sessionStorage.getItem(key)!).id).toBe("mutation-new");
    // A second click before the new result arrives must not create a third operation.
    expect(commandMutationId(sessionStorage, key, signature, "mutation-third", [receipt(state, "failed")])).toBe("mutation-new");
  });
  it("allows the same explicit action again after success", () => {
    expect(commandMutationId(sessionStorage, key, signature, "mutation-new", [receipt("applied", "succeeded")])).toBe("mutation-new");
  });
  it.each([
    ["accepted", "pending"], ["dispatching", "pending"], ["unknown", "unknown"], ["applied", "unknown"], ["new-server-state", "failed"],
  ])("preserves deduplication for %s / %s", (state, outcome) => {
    expect(commandMutationId(sessionStorage, key, signature, "mutation-new", [receipt(state, outcome)])).toBe("mutation-old");
  });
  it("retains the key across reloads, network errors, missing receipts and unrelated failures", () => {
    expect(commandMutationId(sessionStorage, key, signature, "new", [])).toBe("mutation-old");
    expect(commandMutationId(sessionStorage, key, signature, "new", [{ ...receipt("applied", "failed"), clientMutationId: "unrelated" }])).toBe("mutation-old");
  });
  it("records the server command ID and fences late responses", () => {
    rememberCommandReceipt(sessionStorage, key, "mutation-old", "command-old");
    expect(commandMutationId(sessionStorage, key, signature, "mutation-new", [{ ...receipt("applied", "failed"), clientMutationId: undefined }])).toBe("mutation-new");
    rememberCommandReceipt(sessionStorage, key, "mutation-old", "command-old");
    expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual({ signature, id: "mutation-new" });
  });
  it("does not reuse IDs across different input, users or sessions", () => {
    expect(commandMutationId(sessionStorage, "other-user-session", signature, "fresh", [receipt("applied")])).toBe("fresh");
    expect(commandMutationId(sessionStorage, key, "different-action", "fresh-action", [])).toBe("fresh-action");
  });
  it("tolerates broken or unavailable storage", () => {
    sessionStorage.setItem(key, "not-json");
    expect(commandMutationId(sessionStorage, key, signature, "fresh", [])).toBe("fresh");
    const broken = { getItem: () => { throw Error("blocked"); }, setItem: () => { throw Error("blocked"); } };
    expect(commandMutationId(broken, key, signature, "fresh", [])).toBe("fresh");
    expect(() => rememberCommandReceipt(broken, key, "fresh", "command")).not.toThrow();
  });
  it("maps the server mutation ID so pre-upgrade browser caches can recover", () => {
    const mapped = mapCommandReceipt({ commandId: "command-old", clientMutationId: "mutation-old", type: "thread.claim", state: "applied", outcome: "failed", error: { code: "THREAD_WRITER_BUSY", message: "active writer" } });
    expect(mapped.clientMutationId).toBe("mutation-old");
    expect(commandMutationId(sessionStorage, key, signature, "new", [mapped])).toBe("new");
  });
});
