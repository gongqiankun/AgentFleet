import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudImages, CLOUD_IMAGE_QUOTA } from "../src/cloud-images.js";
import { buildControlPlane, cookieFromSetCookie, csrfHeaders } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDatabase } from "../src/db.js";
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const second = "data:image/png;base64," + Buffer.concat([Buffer.from(png.split(",")[1]!, "base64"), Buffer.from([0])]).toString("base64");

async function fixture(t: import("node:test").TestContext, disk = false) {
  const origin = "http://images.test", password = "isolated-image-quota-password";
  const path = disk ? join(mkdtempSync(join(tmpdir(), "agentfleet-images-")), "db.sqlite") : ":memory:";
  const result = await buildControlPlane({ ...loadConfig({ ADMIN_EMAIL: "images@example.test", ADMIN_PASSWORD: password, PUBLIC_ORIGIN: origin, COOKIE_SECURE: "false", LOG_LEVEL: "silent" }), databasePath: path });
  t.after(() => result.app.close());
  const login = await result.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { email: "images@example.test", password } });
  const headers = { cookie: cookieFromSetCookie(login.headers["set-cookie"]), ...csrfHeaders(login.json().csrfToken, origin) };
  const ws = result.db.get<{ workspace_id: string }>("SELECT workspace_id FROM workspaces")!.workspace_id;
  for (const id of ["image-a", "image-b"]) result.db.run(`INSERT INTO machines(machine_id,workspace_id,public_key_spki,public_key_fingerprint,name,platform,platform_release,architecture,created_at,updated_at)
    VALUES(?,?,?,?,?,'linux','fixture','x64',?,?)`, id, ws, id, id, id, new Date().toISOString(), new Date().toISOString());
  return { ...result, path, headers, store: new CloudImages(result.db) };
}

test("image quota is per machine, counts unique encoded bytes; clear needs confirmation and never restores replayed pixels", async t => {
  const { app, db, store, headers } = await fixture(t);
  const body = { item: { type: "userMessage", content: [{ type: "text", text: "keep this text" }, { type: "image", url: png }] } };
  const saved = db.transaction(() => store.store("image-a", "event", "event-a", body, "sync"));
  db.transaction(() => store.store("image-a", "event", "event-b", body, "sync"));
  db.transaction(() => store.store("image-b", "event", "event-c", body, "sync"));
  assert.equal(JSON.stringify(saved).includes(png), false);
  assert.equal(store.stats("image-a").usedBytes, Buffer.byteLength(png));
  assert.equal(store.stats("image-a").imageCount, 1);
  assert.deepEqual(store.hydrate("image-a", "event", "event-a", saved), body);
  assert.equal(JSON.stringify(store.hydrate("image-a", "event", "unbound-owner", saved)).includes(png), false);
  const url = "/api/machines/image-a/images";
  assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
  const usage = (await app.inject({ method: "GET", url, headers })).json();
  assert.equal(usage.quotaBytes, 50_000_000);
  assert.equal((await app.inject({ method: "POST", url: url + "/clear", headers, payload: { revision: usage.revision } })).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: url + "/clear", headers, payload: { revision: -1, confirmCloudOnly: true } })).statusCode, 409);
  const cleared = await app.inject({ method: "POST", url: url + "/clear", headers, payload: { revision: usage.revision, confirmCloudOnly: true } });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(cleared.json().usedBytes, 0);
  assert.equal(cleared.json().nativeHistoryChanged, false);
  assert.equal(store.stats("image-b").imageCount, 1);
  assert.match(JSON.stringify(store.hydrate("image-a", "event", "event-a", saved)), /keep this text.*云端图片已清理/);
  const replay = db.transaction(() => store.store("image-a", "event", "replay", body, "sync"));
  assert.equal(JSON.stringify(replay).includes(png), false);
  assert.equal(store.stats("image-a").usedBytes, 0);
  assert.throws(() => store.stats("image-a", { workspaceId: "another-workspace" } as never), /主机不存在/);
  assert.equal(db.get<{ count: number }>("SELECT count(*) AS count FROM commands")!.count, 0, "clear never sends a native deletion command");
});

test("80 percent warning, hard quota, atomic rollback, text remains allowed, retention releases image content", async t => {
  const { db, store } = await fixture(t);
  db.transaction(() => store.store("image-a", "command", "synthetic", { images: [png] }, "command"));
  db.run("UPDATE cloud_images SET size_bytes=? WHERE machine_id='image-a'", 39_999_999);
  assert.equal(store.stats("image-a").level, "normal");
  db.run("UPDATE cloud_images SET size_bytes=? WHERE machine_id='image-a'", 40_000_000);
  assert.equal(store.stats("image-a").level, "warning");
  db.run("UPDATE cloud_images SET size_bytes=? WHERE machine_id='image-a'", CLOUD_IMAGE_QUOTA);
  assert.equal(store.stats("image-a").level, "full");
  assert.throws(() => db.transaction(() => store.store("image-a", "command", "new", { images: [second] }, "command")), /50 MB/);
  assert.equal(store.stats("image-a").imageCount, 1);
  // Lowering the quota never deletes existing images, including stores already over the limit.
  db.run("UPDATE cloud_images SET size_bytes=? WHERE machine_id='image-a'", 50_000_001);
  assert.equal(store.stats("image-a").level, "full");
  const existing = db.transaction(() => store.store("image-a", "command", "reuse", { images: [png] }, "command"));
  assert.deepEqual(store.hydrate("image-a", "command", "reuse", existing), { images: [png] });
  assert.equal(store.stats("image-a").usedBytes, 50_000_001);
  assert.throws(() => db.transaction(() => store.store("image-a", "command", "over", { images: [second] }, "command")), /50 MB/);
  assert.deepEqual(db.transaction(() => store.store("image-a", "command", "text", { prompt: "text still works" }, "command")), { prompt: "text still works" });
  const sync = db.transaction(() => store.store("image-a", "event", "full-sync", { item: { type: "image", url: second } }, "sync"));
  assert.match(JSON.stringify(sync), /空间已满/);
  db.transaction(() => store.collect()); // synthetic owners no longer have live content
  assert.equal(store.stats("image-a").usedBytes, 0);
});

test("schema 19 inline command migration preserves payload bytes and is restart-safe", async t => {
  const { db, app, config, path, headers } = await fixture(t, true);
  const ws = db.get<{ workspace_id: string }>("SELECT workspace_id FROM workspaces")!.workspace_id;
  const user = db.get<{ user_id: string; client_session_id: string }>("SELECT user_id,client_session_id FROM client_sessions")!;
  const now = new Date().toISOString();
  db.run("UPDATE machines SET compatibility='compatible',reachability='online',capacity='idle',last_heartbeat_at=? WHERE machine_id='image-a'", now);
  db.run("INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at) VALUES('p',?,'image-a','p','project','/tmp/fixture','fixture',?,?)", ws, now, now);
  const session = await app.inject({ method: "POST", url: "/api/sessions", headers, payload: { machineId: "image-a", projectId: "p", title: "migration" } });
  assert.equal(session.statusCode, 200, session.body);
  const s = session.json();
  db.run(`INSERT INTO commands(command_id,client_mutation_id,payload_hash,workspace_id,actor_user_id,actor_client_session_id,logical_session_id,execution_segment_id,type,precondition_json,payload_json,created_at,expires_at)
    VALUES('old','old','wire-hash',?,?,?,?,?,'turn.start','{}','{}',?,?)`, ws, user.user_id, user.client_session_id, s.logicalSessionId, s.executionSegmentId, now, "2099-01-01T00:00:00Z");
  const payload = { prompt: "old image", images: [png] };
  db.run("INSERT INTO command_contents(command_id,body_json,created_at,expires_at) VALUES('old',?,?,'2099-01-01T00:00:00Z')", JSON.stringify(payload), now);
  db.sqlite.exec("DROP TABLE usage_days; DROP TABLE session_usage; DROP TABLE machine_usage; PRAGMA user_version=19");
  const migrated = new ControlPlaneDatabase(path); t.after(() => migrated.close());
  const normalized = JSON.parse(migrated.get<{ body_json: string }>("SELECT body_json FROM command_contents WHERE command_id='old'")!.body_json);
  assert.equal(JSON.stringify(normalized).includes(png), false);
  assert.deepEqual(new CloudImages(migrated).hydrate("image-a", "command", "old", normalized), payload);
  assert.equal(migrated.get<{ payload_hash: string }>("SELECT payload_hash FROM commands WHERE command_id='old'")!.payload_hash, "wire-hash");
  assert.equal(new CloudImages(migrated).stats("image-a").imageCount, 1);
  assert.equal(config.databasePath, path);
});

async function imageSessionFixture(t: import("node:test").TestContext) {
  const f=await fixture(t);const {app,db,headers,store}=f;
  const now=new Date().toISOString(); const ws=db.get<{workspace_id:string}>("SELECT workspace_id FROM workspaces")!.workspace_id;
  const user=db.get<{user_id:string;client_session_id:string}>("SELECT user_id,client_session_id FROM client_sessions")!;
  db.run("UPDATE machines SET reachability='online',compatibility='compatible',capacity='idle',last_heartbeat_at=?,maintenance_types_json=? WHERE machine_id='image-a'",now,JSON.stringify(["images.preview","images.clean"]));
  db.run("INSERT INTO projects(project_id,workspace_id,machine_id,external_id,alias,canonical_root,identity_hash,created_at,last_reported_at) VALUES('p',?,'image-a','p','project','/tmp/fixture','fixture',?,?)",ws,now,now);
  async function add(name:string) {
    const response=await app.inject({method:"POST",url:"/api/sessions",headers,payload:{machineId:"image-a",projectId:"p",title:name}});assert.equal(response.statusCode,200,response.body);
    const session=response.json();const native="native-"+name;
    db.run("UPDATE execution_segments SET native_thread_id=? WHERE execution_segment_id=?",native,session.executionSegmentId);
    db.run(`INSERT INTO commands(command_id,client_mutation_id,payload_hash,workspace_id,actor_user_id,actor_client_session_id,logical_session_id,execution_segment_id,type,precondition_json,payload_json,created_at,expires_at)
      VALUES(?,?,?, ?,?,?,?,?,'turn.start','{}','{}',?,'2099-01-01')`,name,name,"immutable",ws,user.user_id,user.client_session_id,session.logicalSessionId,session.executionSegmentId,now);
    db.run("INSERT INTO command_projection VALUES(?,'applied',?)",name,now);
    const body=store.store("image-a","command",name,{prompt:"保留文字",images:[png]},"command");
    db.run("INSERT INTO command_contents(command_id,body_json,created_at,expires_at) VALUES(?,?,?,'2099-01-01')",name,JSON.stringify(body),now);
    return {...session,native,body};
  }
  return {...f,add};
}

test("session cleanup requires matching host proof, preserves shared images and text, rejects stale scope",async t=>{
  const {app,db,headers,store,add}=await imageSessionFixture(t);
  const one=await add("one"),two=await add("two");
  const list=await app.inject({method:"GET",url:"/api/machines/image-a/images/sessions",headers});
  assert.equal(list.statusCode,200,list.body);assert.equal(list.json().sessions.length,2);
  const start=async(type:string,id:string,previewOperationId?:string)=>app.inject({method:"POST",url:"/api/machines/image-a/operations",headers,payload:{type,logicalSessionId:id,previewOperationId,clientMutationId:crypto.randomUUID()}});
  assert.equal((await start("images.clean",one.logicalSessionId)).statusCode,409);
  const previewResponse=await start("images.preview",one.logicalSessionId);assert.equal(previewResponse.statusCode,202,previewResponse.body);
  const previewId=previewResponse.json().operation.operationId;
  const request=JSON.parse(db.get<{request_json:string}>("SELECT request_json FROM machine_operations WHERE operation_id=?",previewId)!.request_json);
  const turns=[{turnId:"turn-one",hashes:request.uploads[0].hashes}];
  const proof={logicalSessionId:one.logicalSessionId,threadId:one.native,targets:turns,beforeSha256:"a".repeat(64),afterSha256:"b".repeat(64),byteOffsetsPreserved:true};
  const {MaintenanceService}=await import("../src/maintenance.js");const maintenance=new MaintenanceService(db);
  maintenance.result("image-a",previewId,"succeeded",proof,undefined);
  const cleanResponse=await start("images.clean",one.logicalSessionId,previewId);assert.equal(cleanResponse.statusCode,202,cleanResponse.body);
  const cleanId=cleanResponse.json().operation.operationId;
  assert.throws(()=>maintenance.result("image-a",cleanId,"succeeded",{...proof,cleaned:true,threadId:two.native},undefined),/不符/);
  assert.equal(store.stats("image-a").imageCount,1);
  maintenance.result("image-a",cleanId,"succeeded",{...proof,cleaned:true},undefined);
  maintenance.result("image-a",cleanId,"succeeded",{...proof,cleaned:true},undefined);
  assert.match(JSON.stringify(store.hydrate("image-a","command","one",one.body)),/保留文字.*图片已按会话清理/);
  assert.ok(JSON.stringify(store.hydrate("image-a","command","two",two.body)).includes(png),"unselected shared image remains");
  assert.equal(store.stats("image-a").imageCount,1);
  const replay=store.store("image-a","event","late",{item:{type:"image",url:png}},"sync",{logicalSessionId:one.logicalSessionId,nativeThreadId:one.native,nativeTurnId:"turn-one"});
  assert.ok(!JSON.stringify(replay).includes(png));assert.match(JSON.stringify(replay),/图片已按会话清理/);
  const anotherTurn=store.store("image-a","event","another",{item:{type:"image",url:png}},"sync",{logicalSessionId:one.logicalSessionId,nativeThreadId:one.native,nativeTurnId:"turn-other"});
  assert.ok(JSON.stringify(store.hydrate("image-a","event","another",anotherTurn)).includes(png));
  assert.equal((await start("images.clean",one.logicalSessionId,previewId)).statusCode,409,"cleaned scope cannot be silently reused");
  assert.equal(db.get<{payload_hash:string}>("SELECT payload_hash FROM commands WHERE command_id='one'")!.payload_hash,"immutable");
});

test("image session list covers all pages and enforces host ownership and pending commands",async t=>{
  const {app,db,headers,add}=await imageSessionFixture(t);
  for(let i=0;i<52;i++) await add("session-"+i);
  const first=await app.inject({url:"/api/machines/image-a/images/sessions",headers});
  assert.equal(first.json().sessions.length,50);assert.ok(first.json().nextCursor);
  const last=await app.inject({url:"/api/machines/image-a/images/sessions?cursor="+first.json().nextCursor,headers});
  assert.equal(last.json().sessions.length,2);assert.equal(last.json().nextCursor,null);
  const id=first.json().sessions[0].logicalSessionId;
  db.run("UPDATE command_projection SET state='unknown' WHERE command_id IN (SELECT command_id FROM commands WHERE logical_session_id=?)",id);
  const result=await app.inject({method:"POST",url:"/api/machines/image-a/operations",headers,payload:{type:"images.preview",logicalSessionId:id,clientMutationId:crypto.randomUUID()}});
  assert.equal(result.statusCode,409);assert.equal(result.json().error.code,"IMAGE_COMMAND_PENDING");
  assert.equal((await app.inject({url:"/api/machines/image-b/images/sessions",headers})).json().sessions.length,0);
});
