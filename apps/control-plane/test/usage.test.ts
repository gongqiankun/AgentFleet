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
 const value=service.read(workspaceId,"session","a1");assert.equal(value.recorded?.totalTokens,30);assert.equal(value.quotaCycle,null);
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
test("usage routes require authentication and migration creates version 27",async t=>{
 const {app,db}=await buildControlPlane(config());t.after(()=>app.close());
 assert.equal(db.get<{user_version:number}>("PRAGMA user_version")?.user_version,27);
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

 test("host cumulative usage and live panel notifications share one deduplicated counter", t => {
  const { db, workspaceId, service } = fixture(); t.after(() => db.close());
  db.transaction(() => service.record(event("a1", 10, 2)));
  const host = { ...event("a1", 15, 1), payload: { ...event("a1", 15, 1).payload, synchronizedFromHost: true } };
  db.transaction(() => service.record(host));
  db.transaction(() => service.record(host));
  db.transaction(() => service.record(event("a1", 15, 1)));
  db.transaction(() => service.record(event("a1", 17, 2)));
  assert.equal(service.read(workspaceId, "session", "a1").recorded?.totalTokens, 90);
 });

test("catalog native usage resolves to the same session without taking ownership and deduplicates replay", t => {
 const {db,workspaceId,service,at}=fixture();t.after(()=>db.close());
 db.run("INSERT INTO agent_connections(connection_id,machine_id,transport_generation,connected_at) VALUES('usage-connection','a',1,?)",at);
 const registry=new RegistryService(db,config());const connection={connectionId:"usage-connection",machineId:"a",workspaceId,transportGeneration:1,publicKey:"key-a"};
 const hello={producerEpoch:"usage-producer",appServerEpoch:"usage-epoch",agentVersion:"0.30.11",codexVersion:"0.154.0",schemaHash:"f3487938786b729cb6773dbc9e83a7efab9c78c845db7094e8f539f373cbacc9",platform:"linux",platformRelease:"24",architecture:"x64",capacity:"idle" as const,
  projects:[{externalId:"p-a",alias:"Project a",canonicalRoot:"/work/a",identityHash:"a",leaseVersion:1}],
  sessions:[{externalId:"host-session",projectExternalId:"p-a",executionSegmentExternalId:"host-segment",nativeThreadId:"host-native",title:"Host session",managed:false,executionState:"running" as const,threadControlVersion:1,turnControlVersion:1,contentEpoch:1,nativeUsage:{occurredAt:new Date().toISOString(),usage:{total:counts(10),last:counts(2)}}}],reconciliationStreams:[{producerEpoch:"usage-producer",throughHostSeq:0}]};
 const result=registry.registerHello(connection,hello);const id=result.sessions['host-session']!;
 assert.equal(service.read(workspaceId,"session",id).recorded?.totalTokens,20);
 registry.registerHello(connection,hello);assert.equal(service.read(workspaceId,"session",id).recorded?.totalTokens,20);
 hello.sessions[0]!.nativeUsage={occurredAt:new Date(Date.now()+1).toISOString(),usage:{total:counts(15),last:counts(1)}};
 registry.registerHello(connection,hello);assert.equal(service.read(workspaceId,"session",id).recorded?.totalTokens,70);
 assert.equal(db.get<{managed:number}>("SELECT managed FROM logical_sessions WHERE logical_session_id=?",id)?.managed,0);
 db.run("UPDATE projects SET sync_content=0 WHERE project_id=(SELECT project_id FROM logical_sessions WHERE logical_session_id=?)",id);
 hello.sessions[0]!.nativeUsage={occurredAt:new Date(Date.now()+2).toISOString(),usage:{total:counts(20),last:counts(1)}};
 registry.registerHello(connection,hello);assert.equal(service.read(workspaceId,"session",id).recorded?.totalTokens,70);
});

test("weekly tokens follow the reported next reset, not UTC dates or a rolling seven days", t => {
 const {db,workspaceId,service}=fixture();t.after(()=>db.close());
 const now=Date.now(), reset=now+2*86400_000+12345, start=reset-7*86400_000;
 const at=(time:number)=>new Date(time).toISOString();
 const report=(time:number,total:number)=>{const e=event("a1",total,1);e.occurredAt=at(time);service.record(e);};
 report(start-1,1);report(start,2);report(now,3);
 const quota=(end:number)=>service.quota("a",{observedAt:at(Date.now()),windows:[{bucket:"codex",window:"secondary",windowMinutes:10080,usedPercent:10,resetsAt:Math.floor(end/1000)}]});
 // Use exact second boundaries, as supplied by Codex.
 const exactReset=Math.floor(reset/1000)*1000, exactStart=exactReset-7*86400_000;
 db.run("DELETE FROM usage_intervals");
 for(const [time,total] of [[exactStart-1,90],[exactStart,10],[now,20],[exactReset,80]])db.run("INSERT INTO usage_intervals(logical_session_id,starts_at,ends_at,total_tokens,precision) VALUES('a1',?,?,?,'observation')",at(time!),at(time!),total!);
 quota(reset);
 const cycle=service.read(workspaceId,"session","a1").quotaCycle;
 assert.equal(cycle?.startsAt,at(exactStart));assert.equal(cycle?.resetsAt,at(exactReset));assert.equal(cycle?.recordedTokens,30);
 // A reset adjustment changes the range immediately, not the stored counters.
 quota(now+1*86400_000);
 assert.equal(service.read(workspaceId,"session","a1").quotaCycle?.recordedTokens,120);
 service.quota("a",null);assert.equal(service.read(workspaceId,"session","a1").quotaCycle,null);
 quota(now-1000);assert.equal(service.read(workspaceId,"session","a1").quotaCycle,null);
});

test("coarse historical data crossing a reset boundary is excluded and disclosed", t => {
 const {db,workspaceId,service}=fixture();t.after(()=>db.close());service.record(event("a1",1));
 const reset=Math.floor((Date.now()+2*86400_000)/1000),start=reset*1000-7*86400_000;
 service.quota("a",{observedAt:new Date().toISOString(),windows:[{bucket:"codex",window:"secondary",windowMinutes:10080,usedPercent:10,resetsAt:reset}]});
 db.run("INSERT INTO usage_intervals(logical_session_id,starts_at,ends_at,total_tokens,precision) VALUES('a1',?,?,999,'day')",new Date(start-1000).toISOString(),new Date(start+1000).toISOString());
 const cycle=service.read(workspaceId,"session","a1").quotaCycle;assert.equal(cycle?.recordedTokens,10);assert.equal(cycle?.boundaryIncomplete,true);
});

test("v26 daily totals survive migration without inventing intraday timing", t => {
 const dir=mkdtempSync(join(tmpdir(),"agentfleet-cycle-migration-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,"db.sqlite");
 const original=fixture(path);original.service.record(event("a1",1));original.service.record(event("a2",2));
 const before=original.db.all("SELECT * FROM usage_days");original.db.run("DROP TABLE usage_intervals");original.db.run("PRAGMA user_version=26");original.db.close();
 const next=new ControlPlaneDatabase(path);t.after(()=>next.close());assert.deepEqual(next.all("SELECT * FROM usage_days"),before);
 assert.equal(next.get<{n:number}>("SELECT COUNT(*) AS n FROM usage_intervals WHERE precision='day'")?.n,2);
});
