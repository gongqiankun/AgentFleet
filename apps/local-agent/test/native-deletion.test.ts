import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { previewNativeDeletion } from "../src/native-deletion.js";
import { CodexAppServer, type AppServerCallbacks, type AppServerClient } from "../src/app-server.js";
import { SessionAppServer } from "../src/session-app-server.js";
import { resolveProject } from "../src/projects.js";
import { StateStore } from "../src/store.js";
import type { FleetCommand, ManagedThread } from "../src/types.js";

async function fixture(t: test.TestContext) {
  const root=await mkdtemp(join(tmpdir(),"native-delete-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const cwd=join(root,"project");await mkdir(cwd);const project=await resolveProject(cwd,"fixture");
  const thread:ManagedThread={nativeThreadId:"parent",projectId:project.id,logicalSessionId:"session",executionSegmentId:"segment",sessionCwd:cwd,appServerEpoch:"epoch",policyVersion:"remote-restricted-v1",policyVerified:true,contentEpoch:1,createdAt:new Date().toISOString()};
  let changed=false;
  const calls:string[]=[];
  const request=async(method:string,params:Record<string,unknown>):Promise<unknown>=>{
    calls.push(method);
    if(method==="thread/read")return {thread:{id:params.threadId,cwd,ephemeral:false}};
    if(method==="thread/backgroundTerminals/list")return {data:[],nextCursor:null};
    if(method==="thread/delete")return {};
    assert.equal(method,"thread/list");assert.deepEqual(params.modelProviders,[]);assert.ok((params.sourceKinds as string[]).includes("subAgentThreadSpawn"));
    const row=(id:string,parentThreadId:string|null)=>({id,parentThreadId,cwd,name:changed?"Changed":"Title",updatedAt:1});
    return {data:params.archived?[row("child","parent"),row("grandchild","child")]:[row("parent",null),row("unrelated",null),{...row("fork",null),forkedFromId:"parent"}],nextCursor:null};
  };
  return {root,cwd,project,thread,request,calls,change:()=>{changed=true;}};
}

test("preview includes archived descendants but excludes independent forks and other sessions",async t=>{
  const f=await fixture(t);const plan=await previewNativeDeletion(f.request,f.thread,f.project);
  assert.deepEqual(plan.threads.map(t=>t.id),["child","grandchild","parent"]);
  assert.equal(plan.threads.find(t=>t.id==="child")?.archived,true);
  assert.ok(!f.calls.includes("thread/delete"));
});

test("incomplete pagination and descendants outside the project stop deletion preview",async t=>{
  const f=await fixture(t);
  await assert.rejects(previewNativeDeletion(async(m,p)=>m==="thread/list"?{data:[],nextCursor:"repeat"}:f.request(m,p),f.thread,f.project),/分页未完成/);
  await assert.rejects(previewNativeDeletion(async(m,p)=>m==="thread/list"?{data:[{id:"parent",cwd:f.cwd},{id:"child",parentThreadId:"parent",cwd:f.root}],nextCursor:null}:f.request(m,p),f.thread,f.project));
  assert.ok(!f.calls.includes("thread/delete"));
});

for(const mode of ["confirmed","changed","expired","busy"] as const)test(`native delete requires current confirmation and every writer: ${mode}`,async t=>{
  const f=await fixture(t);const plan=await previewNativeDeletion(f.request,f.thread,f.project);
  const server=new CodexAppServer({} as AppServerCallbacks);
  (server as unknown as {request:typeof f.request}).request=f.request;
  const resumed:string[]=[];
  server.resumeThread=async id=>{resumed.push(id);if(mode==="busy"&&id==="parent")throw Error("active writer");return {nativeThreadId:id,policyVerified:true,rawSummary:{},history:{nativeThreadId:id,cwd:f.cwd,historyMode:"legacy",executionState:"idle",updatedAt:1,items:[]}};};
  if(mode==="changed")f.change();if(mode==="expired")plan.expiresAt="invalid";
  if(mode==="confirmed") {await server.deleteThread(f.thread,f.project,plan);assert.equal(f.calls.filter(m=>m==="thread/delete").length,1);assert.deepEqual(new Set(resumed),new Set(["parent"]));}
  else {await assert.rejects(server.deleteThread(f.thread,f.project,plan));assert.ok(!f.calls.includes("thread/delete"));if(mode!=="busy")assert.equal(resumed.length,0);}
});

test("confirmed native deletion survives a writer cleanup error",async t=>{
 const f=await fixture(t);const plan=await previewNativeDeletion(f.request,f.thread,f.project);let deleted=0,stopped=0;
 const facade=new SessionAppServer({} as AppServerCallbacks,()=>({start:async()=>{},stop:async()=>{stopped++;},releaseWriter:async()=>{throw Error("cleanup failed");},deleteThread:async()=>{deleted++;}} as unknown as AppServerClient));
 await facade.start();await facade.deleteThread(f.thread,f.project,plan);assert.equal(deleted,1);assert.equal(stopped,1);await facade.stop();
});

test("confirmed deletion atomically retains its receipt and blocks stale catalog resurrection",async t=>{
 const f=await fixture(t);const store=new StateStore(join(f.root,"state"));await store.initialize();t.after(()=>store.close());
 await store.update(s=>{s.projects.push(f.project);});await store.setManagedThread(f.thread);
 const other={...f.thread,nativeThreadId:"unrelated",logicalSessionId:"other-session",executionSegmentId:"other-segment"};await store.setManagedThread(other);
 const command={commandId:"delete-command",attemptId:"delete-attempt",type:"thread.delete",projectId:f.project.id,logicalSessionId:"session",executionSegmentId:"segment",precondition:{nativeThreadId:"parent"},payload:{},contentEpoch:1,expiresAt:new Date(Date.now()+60000).toISOString()} as FleetCommand;
 await store.claimCommand(command,"hash");await store.transitionCommand(command.attemptId,"claimed","invoking");
 await store.commitNativeDeletion(command,["parent"]);
 assert.equal(store.snapshot().commandJournal[command.commandId]?.state,"applied");assert.equal(store.snapshot().managedThreads.parent,undefined);assert.ok(store.snapshot().managedThreads.unrelated);
 await store.reconcileDiscoveredCatalog([], [{nativeThreadId:"parent",externalId:"parent",executionSegmentExternalId:"parent",projectId:f.project.id,sessionCwd:f.cwd,title:"Old scan",archived:false,availability:"available",executionState:"idle",historyCompleteness:"partial"}],"epoch");
 assert.equal(store.snapshot().discoveredThreads.parent,undefined);
 const reopened=new StateStore(store.dataDir);await reopened.initialize();try {assert.ok(reopened.snapshot().nativeDeletionTombstones.parent);assert.equal(reopened.snapshot().nativeThreadBindings.parent?.managed,false);assert.deepEqual(reopened.snapshot().managedThreads.unrelated,store.snapshot().managedThreads.unrelated);}finally{reopened.close();}
});
