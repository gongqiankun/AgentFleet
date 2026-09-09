import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { AgentRuntime } from "../src/runtime.js";
import { nativeImageCleanup } from "../src/native-image-cleanup.js";

const png="data:image/png;base64,"+"AAAA".repeat(100);
const digest=(s:string)=>createHash("sha256").update(s).digest("hex");

test("runtime image operation fences original binding, dispatch, pending sync, then preserves text and ID", {skip:process.platform!=="linux"},async t=>{
  const home=await mkdtemp(join(tmpdir(),"production-image-adapter-"));t.after(()=>rm(home,{recursive:true,force:true}));
  await mkdir(join(home,"sessions"));const id=randomUUID(), turn=randomUUID(), file=join(home,"sessions",id+".jsonl");
  const rows=[{type:"session_meta",payload:{id,cli_version:"0.153.4"}},
    {type:"event_msg",payload:{type:"task_started",turn_id:turn}},
    {type:"response_item",payload:{type:"message",role:"user",id:"item-id",content:[{type:"input_text",text:"保持文字 🦊\n保持换行"},{type:"input_image",image_url:png}]}},
    {type:"event_msg",payload:{type:"task_complete",turn_id:turn}}];
  const original=rows.map(r=>JSON.stringify(r)).join("\n")+"\n";await writeFile(file,original);
  const binding={nativeThreadId:id,logicalSessionId:"session",executionSegmentId:"segment",contentEpoch:1,codexProfileId:"default",projectId:"p"};
  const thread={...binding,activeTurnId:undefined as string|undefined};
  const state={managedThreads:{[id]:thread},nativeThreadBindings:{[id]:binding},projectReservations:{},approvals:{},inbox:{} as Record<string,unknown>,outbox:[] as unknown[],commandJournal:{upload:{state:"applied",commandType:"turn.start",response:{nativeThreadId:id,nativeTurnId:turn}}}};
  let releases=0;
  const runtime=Object.assign(Object.create(AgentRuntime.prototype) as object,{
    imageMaintenanceSessions:new Set(),historySyncJobs:new Set(),support:{codexVersion:"0.153.4",codexProfile:{id:"default",codexHome:home}},
    store:{snapshot:()=>structuredClone(state),updateManagedThread:async (_id:string,fn:(t:typeof thread)=>void)=>{fn(thread);}},
    appServer:{unsubscribeThread:async()=>{releases++;},readThread:async()=>({nativeThreadId:id,rolloutPath:file,executionState:"idle"})}
  }) as unknown as AgentRuntime;
  const target={...binding,uploads:[{commandId:"upload",hashes:[digest(png)]}]};
  await assert.rejects(runtime.manageSessionImages({...target,logicalSessionId:"other"},false),/身份已变化/);
  thread.activeTurnId=turn;await assert.rejects(runtime.manageSessionImages(target,false),/运行/);thread.activeTurnId=undefined;
  state.inbox.pending={state:"invoking"};await assert.rejects(runtime.manageSessionImages(target,false),/派发/);state.inbox={};
  assert.equal(releases,0);assert.equal(await readFile(file,"utf8"),original);
  state.outbox=[{nativeThreadId:id}];await assert.rejects(runtime.manageSessionImages(target,false),/同步/);state.outbox=[];
  const preview=await runtime.manageSessionImages(target,false);assert.equal(preview.rolloutBytes,Buffer.byteLength(original));assert.equal(preview.cleaned,false);assert.equal(await readFile(file,"utf8"),original);
  const proof=await runtime.manageSessionImages({...target,expectedDigest:preview.beforeSha256},true);assert.equal(proof.cleaned,true);assert.equal(proof.threadId,id);
  const after=await readFile(file,"utf8");assert.equal(Buffer.byteLength(after),Buffer.byteLength(original));assert.ok(!after.includes(png));
  const preserved=after.trim().split("\n").map(line=>JSON.parse(line));assert.equal(preserved[0].payload.id,id);assert.equal(preserved[2].payload.content[0].text,"保持文字 🦊\n保持换行");assert.equal(preserved[2].payload.id,"item-id");
  await assert.rejects(nativeImageCleanup({home,rollout:file,threadId:id,version:"0.153.2",preview:true,targets:[{turnId:turn,hashes:[digest(png)]}]}),/0.153.4/);
});
