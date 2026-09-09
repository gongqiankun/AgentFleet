import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppServer, type AppServerCallbacks } from "../src/app-server.js";
import { StateStore } from "../src/store.js";
import type { DiscoveredThread, ManagedThread, ProjectRecord } from "../src/types.js";

const project = { id: "project", root: "/workspace", alias: "fixture", device: "1", inode: "1", identityVersion: 1, addedAt: "2026-09-08T00:00:00Z" } satisfies ProjectRecord;
const managed = { nativeThreadId: "native", projectId: project.id, sessionCwd: project.root, logicalSessionId: "logical", executionSegmentId: "segment", appServerEpoch: "epoch", policyVersion: "remote-restricted-v1", policyVerified: true, contentEpoch: 1, createdAt: project.addedAt, title: "Original", titleSource: "name", archived: false } satisfies ManagedThread;
const observed = (archived: boolean, title = "Host title") => ({ externalId: "native", executionSegmentExternalId: "native", nativeThreadId: "native", projectId: project.id, sessionCwd: project.root, title, titleSource: "name", archived, availability: "available", executionState: "idle", historyCompleteness: "partial" } satisfies Omit<DiscoveredThread, "firstSeenAt" | "lastSeenAt" | "lastReconciledAt">);

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "agentfleet-catalog-lifecycle-"));
  const store = new StateStore(root); await store.initialize();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  await store.update(state => { state.projects.push(project); });
  await store.setManagedThread(managed);
  return store;
}

test("catalog pages cover active and archived collections without mixing native cursors", async () => {
  const server = new CodexAppServer({} as AppServerCallbacks);
  const internal = server as unknown as { initialized: boolean; child: unknown; request(method: string, params: Record<string, unknown>): Promise<unknown> };
  internal.initialized = true; internal.child = {};
  const requests: Record<string, unknown>[] = [];
  internal.request = async (method, params) => {
    assert.equal(method, "thread/list"); requests.push(params);
    return { data: [{ id: params.archived ? "archived" : params.cursor ? "active-2" : "active-1", cwd: project.root, name: "Native title", status: { type: "notLoaded" } }], nextCursor: !params.archived && !params.cursor ? "native-cursor" : null };
  };
  const all = await server.listThreads();
  assert.deepEqual(all.map(t => [t.nativeThreadId, t.archived]), [["active-1", false], ["active-2", false], ["archived", true]]);
  assert.deepEqual(requests.map(r => [r.archived, r.cursor]), [[false, null], [false, "native-cursor"], [true, null]]);
});

test("host archive and restore update metadata while preserving identity and history", async t => {
  const store = await fixture(t);
  const original = store.snapshot().managedThreads.native!;
  assert.equal(await store.reconcileDiscoveredCatalog([], [observed(true)], "epoch"), true);
  assert.equal(store.snapshot().managedThreads.native?.archived, true);
  assert.equal(store.snapshot().managedThreads.native?.logicalSessionId, original.logicalSessionId);
  assert.equal(store.snapshot().managedThreads.native?.executionSegmentId, original.executionSegmentId);
  const reopened = new StateStore(store.dataDir); await reopened.initialize();
  try { assert.equal(reopened.snapshot().managedThreads.native?.archived, true); } finally { reopened.close(); }
  await store.reconcileDiscoveredCatalog([], [observed(false)], "epoch");
  assert.equal(store.snapshot().managedThreads.native?.archived, false);
  await store.reconcileDiscoveredCatalog([], [], "epoch");
  assert.ok(store.snapshot().managedThreads.native, "Missing from a list is not deletion evidence");
});

test("late catalog snapshots cannot undo a completed rename/archive or cross a moved project", async t => {
  const store = await fixture(t);
  await store.updateManagedThread("native", thread => { thread.title = "Panel title"; thread.archived = true; thread.metadataRevision = 1; });
  await store.reconcileDiscoveredCatalog([], [observed(false, "Old title")], "epoch", { complete: true, metadataRevisions: { native: 0 } });
  assert.equal(store.snapshot().managedThreads.native?.title, "Panel title");
  assert.equal(store.snapshot().managedThreads.native?.archived, true);
  await store.reconcileDiscoveredCatalog([], [{ ...observed(false), sessionCwd: "/moved" }], "epoch", { complete: true, metadataRevisions: { native: 1 } });
  assert.equal(store.snapshot().managedThreads.native?.title, "Panel title");
  await store.reconcileDiscoveredCatalog([], [observed(false, "Latest host title")], "epoch", { complete: true, metadataRevisions: { native: 1 } });
  assert.equal(store.snapshot().managedThreads.native?.title, "Latest host title");
  assert.equal(store.snapshot().managedThreads.native?.archived, false);
});

test("catalog metadata cannot rewrite a session during an active turn", async t => {
  const store = await fixture(t);
  await store.updateManagedThread("native", thread => { thread.activeTurnId = "turn"; });
  await store.reconcileDiscoveredCatalog([], [observed(true)], "epoch");
  assert.equal(store.snapshot().managedThreads.native?.title, "Original");
  assert.equal(store.snapshot().managedThreads.native?.activeTurnId, "turn");
  assert.equal(store.snapshot().managedThreads.native?.archived, false);
});

test("a newer native name is not overwritten by a command accepted against an older title", async t => {
  const store = await fixture(t);
  const targetProject = { ...project, root: store.dataDir };
  const server = new CodexAppServer({} as AppServerCallbacks);
  const internal = server as unknown as { initialized: boolean; child: unknown; request(method: string, params: Record<string, unknown>): Promise<unknown> };
  internal.initialized = true; internal.child = {};
  const mutations: string[] = [];
  internal.request = async (method) => {
    if (method === "thread/read") return { thread: { id: "native", cwd: store.dataDir, name: "New host title", status: { type: "notLoaded" } } };
    mutations.push(method); return {};
  };
  const thread = { ...managed, sessionCwd: store.dataDir };
  await assert.rejects(server.threadAction(thread, targetProject, "rename", "Panel title", "Original"), (e: unknown) => (e as { code: string }).code === "THREAD_NAME_CONFLICT");
  assert.deepEqual(mutations, []);
  await server.threadAction(thread, targetProject, "rename", "Panel title", "New host title");
  assert.deepEqual(mutations, ["thread/name/set"]);
});


test("legacy managed records without optional metadata still complete catalog reconciliation", async t => {
  const store = await fixture(t);
  await store.updateManagedThread("native", thread => { delete thread.title; delete thread.titleSource; delete thread.archived; delete thread.metadataRevision; });
  await store.reconcileDiscoveredCatalog([], [observed(false, "Existing host name")], "epoch", { complete: true, metadataRevisions: { native: 0 } });
  const thread = store.snapshot().managedThreads.native!;
  assert.equal(thread.title, "Existing host name");
  assert.equal(thread.archived, false);
  assert.equal(thread.logicalSessionId, "logical");
  assert.equal(thread.executionSegmentId, "segment");
  const revision = thread.metadataRevision!;
  await store.reconcileDiscoveredCatalog([], [observed(true, "Existing host name")], "epoch", { complete: true, metadataRevisions: { native: revision } });
  assert.equal(store.snapshot().managedThreads.native?.archived, true);
});

test("native recovery reads only the matching turn and requests no history items", async () => {
 const server=new CodexAppServer({} as AppServerCallbacks);
 const internal=server as unknown as {initialized:boolean;child:unknown;request(method:string,params:Record<string,unknown>):Promise<unknown>};
 internal.initialized=true;internal.child={};let pages=0;
 internal.request=async(method,params)=>{
   if(method==="thread/read"){assert.equal(params.includeTurns,false);return {thread:{id:"native",cwd:"/workspace",historyMode:"paginated"}};}
   assert.equal(method,"thread/turns/list");assert.equal(params.itemsView,"notLoaded");assert.equal(params.limit,100);pages++;
   return params.cursor?{data:[{id:"wanted",status:"interrupted"}],nextCursor:null}:{data:[{id:"other",status:"completed"}],nextCursor:"page2"};
 };
 assert.deepEqual(await server.readTurnOutcome("native","wanted"),{cwd:"/workspace",status:"interrupted"});assert.equal(pages,2);
});

test("native history pages validate bounded content and reject non-advancing cursors",async()=>{
 const server=new CodexAppServer({} as AppServerCallbacks);
 const internal=server as unknown as {initialized:boolean;child:unknown;request(method:string,params:Record<string,unknown>):Promise<unknown>};
 internal.initialized=true;internal.child={};
 internal.request=async(method,params)=>{assert.equal(method,"thread/items/list");assert.equal(params.limit,100);assert.equal(params.sortDirection,"asc");return {data:[{turnId:"turn",item:{id:"item",type:"agentMessage",text:"body"}}],nextCursor:"next"};};
 const page=await server.readHistoryPage("native",null);assert.equal(page.items[0]?.nativeTurnId,"turn");assert.equal(page.nextCursor,"next");
 await assert.rejects(server.readHistoryPage("native","next"),/did not advance/);
});
