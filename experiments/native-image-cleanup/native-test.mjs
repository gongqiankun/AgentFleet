// Real Linux Codex, synthetic history and loopback model fixture only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { CodexAppServer } from '../../apps/local-agent/dist/src/app-server.js';
import { resolveProject } from '../../apps/local-agent/dist/src/projects.js';
import { nativeImageCleanup } from '../../apps/local-agent/dist/src/native-image-cleanup.js';
const exec = promisify(execFile);
const experiment = dirname(fileURLToPath(import.meta.url));
const binary = process.env.AGENTFLEET_NATIVE_CODEX;
const hash = b => createHash('sha256').update(b).digest('hex');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC';
function makeBluePng() {
  function chunk(name,data){const content=Buffer.concat([Buffer.from(name),data]);let crc=0xffffffff;
    for(const byte of content){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    const size=Buffer.alloc(4);size.writeUInt32BE(data.length);const checksum=Buffer.alloc(4);checksum.writeUInt32BE((crc^0xffffffff)>>>0);
    return Buffer.concat([size,content,checksum]);}
  const header=Buffer.alloc(13);header.writeUInt32BE(8,0);header.writeUInt32BE(8,4);header[8]=8;header[9]=2;
  const pixels=Buffer.concat(Array.from({length:8},()=>Buffer.from([0,...Array.from({length:8},()=>[0,0,255]).flat()])));
  return 'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
const other=makeBluePng();

for (const mode of ['legacy', 'paginated']) test(`native ${mode}: remove target image, preserve text and IDs, resume and continue`, {skip: !binary, timeout: 45000}, async t => {
  assert.match((await exec(binary,['--version'])).stdout,/0\.153\.4/);
  const root = await mkdtemp(join(tmpdir(),'agentfleet-cleanup-native-'));
  const home=join(root,'codex-home'),cwd=join(root,'project'),day=join(home,'sessions','2026','09','09');
  await mkdir(day,{recursive:true}); await mkdir(cwd);
  let captured, complete;
  const upstream=createServer(async(req,res)=>{
    if(req.method!=='POST'){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
    const parts=[];for await(const part of req)parts.push(Buffer.from(part));captured=JSON.parse(Buffer.concat(parts));
    const message={id:'msg_new_reply',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Continuation verified.',annotations:[]}]};
    const events=[{type:'response.created',response:{id:'resp_fixture',object:'response',status:'in_progress',output:[]}},
      {type:'response.output_item.added',output_index:0,item:{...message,status:'in_progress',content:[]}},
      {type:'response.output_text.delta',item_id:message.id,output_index:0,content_index:0,delta:'Continuation verified.'},
      {type:'response.output_item.done',output_index:0,item:message},
      {type:'response.completed',response:{id:'resp_fixture',object:'response',status:'completed',output:[message],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
    res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  await writeFile(join(home,'config.toml'),`model = "gpt-5.4"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${upstream.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  await writeFile(join(home,'.agentfleet-image-cleanup-fixture'),'isolated-no-account-no-user-data\n');
  let id,turn,file;
  const text='保留原文、换行\n与 emoji 🦊；do not change this text.';
  const env={PATH:process.env.PATH,HOME:root,CODEX_HOME:home,AGENTFLEET_CODEX_EXECUTABLE:binary};
  let managed;
  const callbacks={findManagedThread:threadId=>managed?.nativeThreadId===threadId?managed:undefined,findProject:()=>undefined,
    onEvent:async e=>{if(e.type==='turn.completed'||e.type==='turn.failed')complete?.(e);},onVolatile:()=>{},onApproval:async()=>{},onApprovalResolved:async()=>{},onExit:async()=>{}};
  let server;
  async function fresh(){await server?.stop();server=new CodexAppServer(callbacks,undefined,env);await server.start();return server;}
  t.after(async()=>{await server?.stop();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));await rm(root,{recursive:true,force:true});});
  const project=await resolveProject(cwd,'fixture');
  await fresh();
  const request=server.request.bind(server);
  server.request=(method,params)=>request(method,method==='thread/start'?{...params,historyMode:mode}:params);
  const created=await server.createThread(project,'project','Keep this title');
  id=created.nativeThreadId;
  managed={nativeThreadId:id,projectId:project.id,logicalSessionId:'fixture',executionSegmentId:'fixture',appServerEpoch:server.appServerEpoch,policyVerified:true,sessionCwd:cwd,permissionProfile:'project'};
  const firstFinished=new Promise(r=>complete=r);
  const started=await server.startTurn(managed,project,text,undefined,undefined,[png,other]);
  turn=started.nativeTurnId;
  assert.equal((await firstFinished).type,'turn.completed');
  const paths=await (await import('node:fs/promises')).readdir(join(home,'sessions'),{recursive:true});
  file=join(home,'sessions',paths.find(p=>p.endsWith(id+'.jsonl')));
  const rows=(await readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const beforeHistory=await server.readThread(id);
  assert.equal((await server.request('thread/read',{threadId:id,includeTurns:false})).thread.name,'Keep this title');
  assert.ok(JSON.stringify(beforeHistory).includes(png));
  const beforeFile=await readFile(file);
  async function clean(failpoint){
    const args={home,rollout:file,thread_id:id,turn_id:turn,image_hashes:[hash(png)],expected_digest:hash(await readFile(file)),...(failpoint?{failpoint}:{})};
    if (process.env.AGENTFLEET_PRODUCTION_CLEANUP && !failpoint) {
      const result=await nativeImageCleanup({home,rollout:file,threadId:id,targets:[{turnId:turn,hashes:[hash(png)]}],version:'0.153.4',preview:false,expectedDigest:args.expected_digest});
      return {stdout:JSON.stringify(result)};
    }
    return exec('python3' ,['-c',`import sys,json;sys.path.insert(0,sys.argv[1]);from cleanup import cleanup_fixture;print(json.dumps(cleanup_fixture(**json.loads(sys.argv[2]))))`,experiment,JSON.stringify(args)],{timeout:5000,maxBuffer:16384});
  }
  await assert.rejects(clean(),/Native writer busy/);
  assert.deepEqual(await readFile(file),beforeFile,'native writer conflict changes nothing');
  await server.stop();server=undefined;
  if (!process.env.AGENTFLEET_PRODUCTION_CLEANUP) {
  await assert.rejects(clean('before_replace'),/before replacement/);
  assert.deepEqual(await readFile(file),beforeFile);
  await assert.rejects(clean('crash_after_replace'),error=>error.code===73);
  // Interrupted cleanup must still leave a readable native session, then an
  // explicit reconciliation finishes the projection; never claim early success.
  await fresh();assert.equal((await server.resumeThread(id,project)).nativeThreadId,id);
  assert.ok(JSON.stringify(await server.readThread(id)).includes('保留原文'));
  await server.stop();server=undefined;
  } else {
    const preview = await nativeImageCleanup({home,rollout:file,threadId:id,targets:[{turnId:turn,hashes:[hash(png)]}],version:'0.153.4',preview:true});
    assert.ok(preview.imageContentBytes > 0);
    assert.deepEqual(await readFile(file), beforeFile, 'production preview never edits history');
    await assert.rejects(nativeImageCleanup({home,rollout:file,threadId:id,targets:[{turnId:turn,hashes:[hash(png)]}],version:'0.153.4',expectedDigest:'0'.repeat(64)}),/stale/);
  }
  const pre=await readFile(file);
  const receipt=JSON.parse((await clean()).stdout);
  const post=await readFile(file);
  assert.equal(post.length,pre.length);
  assert.deepEqual(post.toString().split('\n').map(s=>Buffer.byteLength(s)),pre.toString().split('\n').map(s=>Buffer.byteLength(s)));
  assert.ok(!post.toString().includes(png));assert.ok(post.toString().includes(other));
  const postRows=post.toString().trim().split('\n').map(s=>JSON.parse(s));
  for(const original of rows){
    const match=postRows.find(r=>r.type===original.type&&r.payload.id===original.payload.id&&JSON.stringify(r.payload)===JSON.stringify(original.payload));
    if(!JSON.stringify(original).includes(png))assert.ok(match,`unchanged ${original.type}/${original.payload.type}`);
  }
  assert.equal(JSON.parse((await clean()).stdout).changedProjectedItems,0,'repeat is idempotent');
  await fresh();const resumed=await server.resumeThread(id,project);
  assert.equal(resumed.nativeThreadId,id);
  const afterHistory=await server.readThread(id);
  assert.equal(afterHistory.nativeThreadId,id);
  assert.equal((await server.request('thread/read',{threadId:id,includeTurns:false})).thread.name,'Keep this title');
  const withoutTarget=value=>Array.isArray(value)?value.filter(v=>!(v?.type==='image'&&v.url===png)&&!(v?.type==='text'&&v.text==='[image removed]')).map(withoutTarget):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,withoutTarget(v)])):value;
  assert.deepEqual(withoutTarget(afterHistory.items),withoutTarget(beforeHistory.items),'all original non-target content remains byte-for-byte as strings and structurally identical');
  assert.deepEqual(afterHistory.items.map(i=>[i.nativeTurnId,i.nativeItemId]),beforeHistory.items.map(i=>[i.nativeTurnId,i.nativeItemId]),'native item identities remain');
  assert.ok(!JSON.stringify(afterHistory).includes(png),'native read no longer returns target pixels');
  assert.ok(JSON.stringify(afterHistory).includes(other),'non-target image remains');
  assert.ok(JSON.stringify(afterHistory).includes('保留原文'));
  managed={nativeThreadId:id,projectId:project.id,logicalSessionId:'fixture',executionSegmentId:'fixture',appServerEpoch:server.appServerEpoch,policyVerified:true,sessionCwd:cwd,permissionProfile:'project'};
  const finished=new Promise(r=>complete=r);
  await server.startTurn(managed,project,'Continue with the preserved text.');
  const end=await finished;assert.equal(end.type,'turn.completed');
  assert.ok(captured);assert.ok(!JSON.stringify(captured).includes(png));assert.ok(JSON.stringify(captured).includes(other),'non-target image remains in model input');
  assert.ok(JSON.stringify(captured).includes('保留原文'));
  await fresh();assert.equal((await server.resumeThread(id,project)).nativeThreadId,id);
  assert.ok(JSON.stringify(await server.readThread(id)).includes('Continuation verified.'));
  t.diagnostic(JSON.stringify({mode,threadIdPreserved:true,textPreserved:true,titlePreserved:true,processDeathRecovery:!process.env.AGENTFLEET_PRODUCTION_CLEANUP,targetImageRemoved:true,otherImagePreserved:true,continuedAndResumed:true,receipt}));
});
