import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { CodexAppServer, type AppServerCallbacks } from "../src/app-server.js";
import { resolveProject } from "../src/projects.js";
import type { ManagedThread } from "../src/types.js";

// Real Codex binary + isolated local Responses fixture: no account credentials,
// model charges, real projects, or external HTTP requests are needed.
test("native image turn reaches Responses as image bytes and survives writer release/resume", { skip: !process.env.AGENTFLEET_IMAGE_NATIVE_TEST, timeout: 60_000 }, async () => {
  function chunk(name: string, data: Buffer) {
    const content = Buffer.concat([Buffer.from(name), data]); let crc = 0xffffffff;
    for (const byte of content) { crc ^= byte; for (let bit=0; bit<8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, content, checksum]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(8,0); header.writeUInt32BE(8,4); header[8]=8; header[9]=2;
  const pixels = Buffer.concat(Array.from({length:8}, () => Buffer.from([0,...Array.from({length:8},()=>[255,0,0]).flat()])));
  const png = "data:image/png;base64," + Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",deflateSync(pixels)),chunk("IEND",Buffer.alloc(0))]).toString("base64");
  let captured: Record<string, unknown> | undefined;
  const upstream = createServer(async (req,res) => {
    if (req.method !== "POST") {res.writeHead(200,{"content-type":"application/json"});res.end('{"data":[]}');return;}
    const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
    captured = JSON.parse(Buffer.concat(parts).toString());
    res.writeHead(200,{"content-type":"text/event-stream"});
    const message = { id:"msg_fixture",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:"Image fixture received.",annotations:[]}] };
    const events = [
      {type:"response.created",response:{id:"resp_fixture",object:"response",status:"in_progress",output:[]}},
      {type:"response.output_item.added",output_index:0,item:{...message,status:"in_progress",content:[]}},
      {type:"response.output_text.delta",item_id:"msg_fixture",output_index:0,content_index:0,delta:"Image fixture received."},
      {type:"response.output_item.done",output_index:0,item:message},
      {type:"response.completed",response:{id:"resp_fixture",object:"response",status:"completed",output:[message],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}},
    ];
    res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise<void>(resolve=>upstream.listen(0,"127.0.0.1",resolve));
  const port = (upstream.address() as {port:number}).port;
  const root = await mkdtemp(join(tmpdir(),"agentfleet-image-native-")); const home=join(root,"codex-home"), cwd=join(root,"project");
  await mkdir(home); await mkdir(cwd);
  await writeFile(join(home,"config.toml"),`model = "gpt-5.4"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  let managed: ManagedThread | undefined; let finish!: () => void;
  const completed = new Promise<void>(resolve => {finish=resolve;});
  const callbacks: AppServerCallbacks = { findManagedThread:id=>managed?.nativeThreadId===id?managed:undefined,findProject:()=>undefined,
    onEvent:async event=>{if(event.type==="turn.completed" || event.type==="turn.failed")finish();},onVolatile:()=>undefined,onApproval:async()=>undefined,onApprovalResolved:async()=>undefined,onExit:async()=>undefined };
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:root,CODEX_HOME:home,...(process.env.AGENTFLEET_NATIVE_CODEX?{AGENTFLEET_CODEX_EXECUTABLE:process.env.AGENTFLEET_NATIVE_CODEX}:{})};
  const server=new CodexAppServer(callbacks,undefined,env); const reader=new CodexAppServer(callbacks,undefined,env);
  try {
    await server.start(); const project=await resolveProject(cwd,"fixture");
    const created=await server.createThread(project,"project","Pasted image fixture");
    managed={nativeThreadId:created.nativeThreadId,projectId:project.id,logicalSessionId:"fixture",executionSegmentId:"fixture",appServerEpoch:server.appServerEpoch,
      policyVerified:true,sessionCwd:cwd,permissionProfile:"project"} as ManagedThread;
    await server.startTurn(managed,project,"Describe the image.",undefined,undefined,[png]);
    await completed;
    assert.ok(captured, "native runtime reached the local fixture");
    assert.ok(JSON.stringify(captured).includes('"input_image"'), "upstream receives a real image input, not a filename");
    const history=await server.readThread(created.nativeThreadId);
    assert.ok(JSON.stringify(history.items).includes(png), "native stored history retains inline image bytes");
    await server.releaseWriter(); await reader.start();
    await reader.resumeThread(created.nativeThreadId,project);
    assert.ok(JSON.stringify((await reader.readThread(created.nativeThreadId)).items).includes(png), "second process resumes the same image context");
  } finally {await server.stop();await reader.stop();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
});
