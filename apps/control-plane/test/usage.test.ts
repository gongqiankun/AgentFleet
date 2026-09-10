import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ControlPlaneDatabase } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { CoordinationService } from "../src/coordination.js";
import { payloadHash } from "../src/crypto.js";
import { RegistryService } from "../src/registry.js";
import { UsageService } from "../src/usage.js";
import { buildControlPlane } from "../src/server.js";
const config=()=>({...loadConfig({ADMIN_EMAIL:"usage@example.test",ADMIN_PASSWORD:randomUUID(),DATABASE_PATH:":memory:",PUBLIC_ORIGIN:"http://usage.test",COOKIE_SECURE:"false"}),databasePath:":memory:"});
function fixture(path=":memory:") {
  const db=new ControlPlaneDatabase(path);const {workspaceId}=db.bootstrap(config());const at=new Date().toISOString();
  for(const machine of ["a","b"]) {
    db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,agent_version,identity_state,security_state,reachability,compatibility,capacity,created_at,updated_at) VALUES(?,?,?,?,?,'linux','24','x64','0.30.0','active','normal','online','compatible','idle',?,?)`,machine,workspaceId,`key-${machine}`,`fingerprint-${machine}`,machine,at,at);
    db.run(`INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at) VALUES(?,?,?,?,?,?,?,?,?)`,`p-${machine}`,workspaceId,machine,`p-${machine}`,`Project ${machine}`,`/work/${machine}`,machine,at,at);
    for(const n of [1,2])db.run(`INSERT INTO logical_sessions(logical_session_id,workspace_id,machine_id,project_id,title,managed,execution_state,reachability,created_at,updated_at) VALUES(?,?,?,?,?,1,'idle','live',?,?)`,`${machine}${n}`,workspaceId,machine,`p-${machine}`,`Session ${machine}${n}`,at,at);
  }
  const service=new UsageService(db);return {db,workspaceId,service,at};
}
const counts=(n:number)=>({inputTokens:n*8,outputTokens:n*2,cachedInputTokens:n*3,reasoningOutputTokens:n,totalTokens:n*10});
const event=(id:string,total:number,last=1,epoch="epoch1")=>({logicalSessionId:id,nativeThreadId:`native-${id}`,appServerEpoch:epoch,occurredAt:new Date().toISOString(),payload:{usage:{total:counts(total),last:counts(last),modelContextWindow:100000}}});
test("usage snapshots exclude earlier history and deduplicate across repeated notifications and reconnects",t=>{
 const {db,workspaceId,service}=fixture();t.after(()=>db.close());
 assert.equal(service.read(workspaceId,"session","a1").recorded,null);
 db.transaction(()=>service.record(event("a1",100)));
 db.transaction(()=>service.record(event("a1",100)));
 db.transaction(()=>service.record(event("a1",100,1,"epoch2")));
 assert.equal(service.read(workspaceId,"session","a1").recorded?.totalTokens,10);
 db.transaction(()=>service.record(event("a1",102,2,"epoch2")));
 db.transaction(()=>service.record(event("a1",101,1,"epoch2")));
 const value=service.read(workspaceId,"session","a1");assert.equal(value.recorded?.totalTokens,30);assert.equal(value.recentSevenDaysTokens,30);
 assert.equal(value.nativeTotal.totalTokens,1020);assert.equal(value.last.totalTokens,20);
 assert.equal(value.recorded?.inputTokens,24);assert.equal(value.recorded?.cachedInputTokens,9);
});
test("new counter baseline is explicit, malformed values cannot corrupt accounting, deleted sessions leave aggregates",t=>{
 const {db,workspaceId,service}=fixture();t.after(()=>db.close());
 db.transaction(()=>service.record(event("a1",100)));
 db.transaction(()=>service.record(event("a1",2,1,"new-epoch")));
 db.transaction(()=>service.record(event("a1",3,1,"new-epoch")));
 const bad=event("a1",4);bad.payload.usage.total.totalTokens=NaN;db.transaction(()=>service.record(bad));
 assert.equal(service.read(workspaceId,"session","a1").recorded?.totalTokens,20);
 assert.equal(service.read(workspaceId,"session","a1").discontinuities,1);
 db.transaction(()=>service.record(event("a2",80,5)));
 db.transaction(()=>service.record(event("b1",30,9)));
 const project=service.read(workspaceId,"project","p-a");assert.equal(project.recorded?.totalTokens,70);assert.equal(project.topSessions[0]?.id,"a2");
 const host=service.read(workspaceId,"machine","a");assert.equal(host.topProjects[0]?.totalTokens,70);
 assert.throws(()=>service.read("different-workspace","project","p-a"));
 db.run("UPDATE logical_sessions SET deleted_at=? WHERE logical_session_id='a2'",new Date().toISOString());
 assert.equal(service.read(workspaceId,"project","p-a").recorded?.totalTokens,20);
});
test("shared account quota selects one newest snapshot without summing percentages or retaining secrets",t=>{
 const {db,workspaceId,service,at}=fixture();t.after(()=>db.close());const key="a".repeat(64);
 const snapshot={accountKey:key,observedAt:at,windows:[{bucket:"codex",window:"secondary",windowMinutes:10080,usedPercent:40,resetsAt:1900000000}],accessToken:"must-not-persist"};
 service.quota("a",snapshot);service.quota("b",{...snapshot,observedAt:new Date(Date.now()+1000).toISOString(),windows:[{...snapshot.windows[0],usedPercent:60}]});
 const value=service.read(workspaceId,"machine","a");assert.equal(value.accounts.length,1);assert.equal(value.accounts[0]?.windows[0].remainingPercent,40);
 assert.equal(value.accounts[0]?.sourceMachine,"b");assert.ok(!JSON.stringify(db.all("SELECT * FROM machine_usage")).includes("must-not-persist"));
 service.quota("a",null);assert.equal(service.read(workspaceId,"machine","a").accounts.length,0);
 service.quota("a",{...snapshot,accountKey:"unknown",observedAt:"2000-01-01T00:00:00Z"});
 assert.equal(service.read(workspaceId,"machine","a").accounts[0]?.stale,true);
});
test("usage routes require authentication and migration creates version 26",async t=>{
 const {app,db}=await buildControlPlane(config());t.after(()=>app.close());
 assert.equal(db.get<{user_version:number}>("PRAGMA user_version")?.user_version,26);
 for(const path of ["sessions","projects","machines"])assert.equal((await app.inject({method:"GET",url:`/api/${path}/missing/usage`})).statusCode,401);
});

test("version 25 upgrade and reopen preserve native session identity and usage",t=>{
 const dir=mkdtempSync(join(tmpdir(),"agentfleets-usage-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,"control.sqlite");
 const original=fixture(path);const before=original.db.all("SELECT * FROM logical_sessions");
 original.db.run("DROP TABLE usage_days");original.db.run("DROP TABLE session_usage");original.db.run("DROP TABLE machine_usage");original.db.run("PRAGMA user_version=25");original.db.close();
 const upgraded=new ControlPlaneDatabase(path);assert.deepEqual(upgraded.all("SELECT * FROM logical_sessions"),before);
 new UsageService(upgraded).record(event("a1",100));upgraded.close();
 const reopened=new ControlPlaneDatabase(path);t.after(()=>reopened.close());
 const service=new UsageService(reopened);service.record(event("a1",100));assert.equal(service.read(original.workspaceId,"session","a1").recorded?.totalTokens,10);
 assert.deepEqual(reopened.all("SELECT * FROM logical_sessions"),before);
});

test("durable ingress deduplicates usage and fences stale or content-disabled reports",t=>{
 const {db,workspaceId,service,at}=fixture();t.after(()=>db.close());
 db.run("INSERT INTO execution_segments(execution_segment_id,logical_session_id,machine_id,project_id,native_thread_id,created_at) VALUES('segment','a1','a','p-a','native-a1',?)",at);
 db.run("INSERT INTO agent_connections(connection_id,machine_id,transport_generation,producer_epoch,app_server_epoch,connected_at,hello_at) VALUES('connection','a',1,'producer','epoch1',?,?)",at,at);
 const coordinator=new CoordinationService(db,config());
 const connection={connectionId:"connection",machineId:"a",workspaceId,transportGeneration:1,publicKey:"key-a"};
 const make=(seq:number,total:number,epoch="epoch1")=>{const sample=event("a1",total,1,epoch);return {...sample,eventId:`usage-event-${seq}`,executionSegmentId:"segment",projectId:"p-a",producerEpoch:"producer",hostSeq:seq,type:"thread.usage",schemaVersion:"1.0",contentEpoch:1,payloadHash:payloadHash(sample.payload)};};
 assert.equal(coordinator.appendEvent(connection,make(1,100)).ok,true);
 assert.equal(coordinator.appendEvent(connection,make(1,100)).ok,true);
 assert.equal(service.read(workspaceId,"session","a1").recorded?.totalTokens,10);
 assert.equal(coordinator.appendEvent(connection,make(2,200,"stale-epoch")).ok,true);
 assert.equal(service.read(workspaceId,"session","a1").recorded?.totalTokens,10);
 db.run("UPDATE projects SET sync_content=0 WHERE project_id='p-a'");
 assert.equal(coordinator.appendEvent(connection,make(3,300)).ok,true);
 assert.equal(service.read(workspaceId,"session","a1").recorded?.totalTokens,10);
});

test("session list usage matches detail counters, includes zero, and keeps missing usage null",t=>{
 const {db,workspaceId,service,at}=fixture();t.after(()=>db.close());
 for(const id of ["a1","a2","b1","b2"])db.run("INSERT INTO execution_segments(execution_segment_id,logical_session_id,machine_id,project_id,native_thread_id,created_at) VALUES(?,?,?,?,?,?)",`segment-${id}`,id,id[0]!,`p-${id[0]}`,`native-${id}`,at);
 service.record(event("a1",100,3));service.record(event("a2",0,0));
 const principal={workspaceId,userId:"test-user",clientSessionId:"test-client",email:"test@example.test",csrfHash:"test",expiresAt:at};
 const registry=new RegistryService(db,config());
 const items=registry.listSessionsPage(principal,{projectId:"p-a",limit:30}).items;
 assert.equal(items.find(s=>s.logicalSessionId==="a1")?.recordedTokens,service.read(workspaceId,"session","a1").recorded?.totalTokens);
 assert.equal(items.find(s=>s.logicalSessionId==="a2")?.recordedTokens,0);
 assert.equal(registry.getSession(principal,"b1").recordedTokens,null);
});
