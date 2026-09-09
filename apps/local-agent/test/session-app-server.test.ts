import assert from "node:assert/strict";
import test from "node:test";
import { SessionAppServer } from "../src/session-app-server.js";
import type { AppServerCallbacks, AppServerClient } from "../src/app-server.js";
import type { ApprovalRecord, ManagedThread, ProjectRecord } from "../src/types.js";

function fixture() {
  const clients: { callbacks: AppServerCallbacks; stopped: number; released: number; failRelease: boolean; resumes: number; answers: unknown[] }[] = [];
  const approvals: ApprovalRecord[] = []; const events: unknown[] = []; const exits: string[] = [];
  const callbacks: AppServerCallbacks = {
    findManagedThread: id => ({ nativeThreadId: id } as ManagedThread), findProject: () => undefined,
    onEvent: async event => { events.push(event); }, onVolatile: event => { events.push(event); },
    onApproval: async approval => { approvals.push(approval); }, onApprovalResolved: async id => { events.push(id); },
    onExit: async () => { exits.push("global"); }, onThreadExit: async id => { exits.push(id); },
  };
  const server = new SessionAppServer(callbacks, (cb, epoch) => {
    const c = { callbacks: cb, stopped: 0, released: 0, failRelease: false, resumes: 0, answers: [] as unknown[] };
    clients.push(c);
    return { appServerEpoch: epoch, start: async () => undefined, stop: async () => { c.stopped++; },
      releaseWriter: async () => { if (c.failRelease) throw new Error("still active"); c.released++; },
      resumeThread: async (id: string) => { c.resumes++; return { nativeThreadId: id }; },
      createThread: async () => ({ nativeThreadId: `created-${clients.length}` }),
      readThread: async (id: string) => ({ nativeThreadId: id }), listThreads: async () => [],
      startTurn: async () => ({ nativeTurnId: "turn", status: "inProgress" }),
      respondApproval: async (a: ApprovalRecord) => { c.answers.push(a.nativeRequestId); },
    } as unknown as AppServerClient;
  });
  return { server, clients, approvals, events, exits };
}
const project = {} as ProjectRecord;

test("catalog reads never create writers; releasing A preserves B and rejects stale A callbacks", async () => {
  const f = fixture(); await f.server.start();
  await f.server.listThreads(); await f.server.readThread("a"); assert.equal(f.clients.length, 1);
  await f.server.resumeThread("a", project); await f.server.resumeThread("b", project);
  const a = f.clients[1]!; const b = f.clients[2]!;
  await f.server.unsubscribeThread("a");
  assert.equal(a.released, 1); assert.equal(b.released, 0); assert.equal(b.stopped, 0); assert.equal(f.clients[0]!.stopped, 0);
  await a.callbacks.onEvent({ type: "turn.completed", nativeThreadId: "a", payload: {} }, f.server.appServerEpoch);
  assert.equal(f.events.length, 0);
  await b.callbacks.onEvent({ type: "turn.completed", nativeThreadId: "b", payload: {} }, f.server.appServerEpoch);
  assert.equal(f.events.length, 1);
  await f.server.resumeThread("a", project); assert.equal(f.clients.length, 4);
  await a.callbacks.onExit(f.server.appServerEpoch, "late exit"); assert.deepEqual(f.exits, []);
  await f.server.stop();
});

test("failed release retains writer and does not report handoff success; retry succeeds", async () => {
  const f = fixture(); await f.server.resumeThread("a", project);
  const a = f.clients[1]!; a.failRelease = true;
  await assert.rejects(f.server.unsubscribeThread("a"), /still active/);
  await f.server.resumeThread("a", project); assert.equal(f.clients.length, 2);
  a.failRelease = false; await f.server.unsubscribeThread("a"); await f.server.unsubscribeThread("a");
  assert.equal(a.released, 1); await f.server.stop();
});

test("concurrent resume for one session is serialized and uses one writer", async () => {
  const f = fixture(); await Promise.all([f.server.resumeThread("a", project), f.server.resumeThread("a", project)]);
  assert.equal(f.clients.length, 2); assert.equal(f.clients[1]!.resumes, 2); await f.server.stop();
});

test("identical native approval IDs in different writers are scoped and replies route to original process", async () => {
  const f = fixture(); await f.server.resumeThread("a", project); await f.server.resumeThread("b", project);
  for (const [index, id] of [[1, "a"], [2, "b"]] as const) {
    await f.clients[index]!.callbacks.onApproval({ approvalId: id, nativeThreadId: id, nativeRequestId: 1, actionHash: id } as ApprovalRecord);
  }
  assert.notEqual(f.approvals[0]!.nativeRequestId, f.approvals[1]!.nativeRequestId);
  await f.server.respondApproval(f.approvals[1]!, "accept");
  assert.deepEqual(f.clients[1]!.answers, []); assert.deepEqual(f.clients[2]!.answers, [1]);
  await f.server.unsubscribeThread("a");
  await assert.rejects(f.server.respondApproval(f.approvals[0]!, "accept"), /released writer/);
  await f.server.stop();
});

test("one writer crash only reports that thread and leaves the other writer usable", async () => {
  const f = fixture(); await f.server.resumeThread("a", project); await f.server.resumeThread("b", project);
  await f.clients[1]!.callbacks.onExit(f.server.appServerEpoch, "fixture crash");
  assert.deepEqual(f.exits, ["a"]); assert.equal(f.clients[2]!.stopped, 0);
  await f.server.startTurn({ nativeThreadId: "b" } as ManagedThread, project, "fixture");
  await f.server.stop();
});
