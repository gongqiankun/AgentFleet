import { AgentError } from "./errors.js";
import { canonicalJson, isRecord, requireString, sha256 } from "./util.js";
import { verifySessionCwd } from "./projects.js";
import type { ManagedThread, ProjectRecord } from "./types.js";

export interface DeletionPreview {
  nativeThreadId: string;
  threads: {id:string;title:string;cwd:string;parentId:string|null;updatedAt:number|null;archived:boolean}[];
  fingerprint: string;
  expiresAt: string;
}
type Request = (method:string,params:Record<string,unknown>)=>Promise<unknown>;
const sources=["cli","vscode","exec","appServer","subAgent","subAgentReview","subAgentCompact","subAgentThreadSpawn","subAgentOther","unknown"];

export async function previewNativeDeletion(request:Request, thread:ManagedThread, project:ProjectRecord):Promise<DeletionPreview> {
  const catalog=new Map<string,DeletionPreview["threads"][number]>();
  const raw=await request("thread/read",{threadId:thread.nativeThreadId,includeTurns:false});
  if(!isRecord(raw)||!isRecord(raw.thread)||raw.thread.id!==thread.nativeThreadId)throw new AgentError("THREAD_ID_MISMATCH","删除目标身份无法确认");
  const expectedCwd=await verifySessionCwd(project,thread.sessionCwd??project.root);
  if(raw.thread.cwd!==expectedCwd||raw.thread.ephemeral===true)throw new AgentError("DELETE_TARGET_INVALID","只能删除本项目已持久保存的原生会话");
  for(const archived of [false,true]) {
    let cursor:string|null=null;const seen=new Set<string>();
    do {
      const page=await request("thread/list",{archived,cursor,limit:100,modelProviders:[],sourceKinds:sources,useStateDbOnly:false});
      if(!isRecord(page)||!Array.isArray(page.data)||page.data.length>100)throw new AgentError("DELETE_PREVIEW_INCOMPLETE","无法完整读取后代会话，删除已停止");
      for(const value of page.data) {
        if(!isRecord(value))throw new AgentError("DELETE_PREVIEW_INCOMPLETE","后代会话信息不完整");
        const id=requireString(value.id,"thread.id",{maxLength:256});
        const source = isRecord(value.source) && isRecord(value.source.subAgent) && isRecord(value.source.subAgent.thread_spawn) ? value.source.subAgent.thread_spawn : null;
        const sourceParent = source?.parent_thread_id;
        if (value.parentThreadId != null && (typeof value.parentThreadId !== "string" || !value.parentThreadId) || source && (typeof sourceParent !== "string" || !sourceParent) || value.parentThreadId && sourceParent && value.parentThreadId !== sourceParent) throw new AgentError("DELETE_PREVIEW_INCOMPLETE", "后代会话父级信息无法确认");
        catalog.set(id,{id,title:typeof value.name==="string"?value.name.slice(0,200):typeof value.preview==="string"?value.preview.slice(0,200):id,
          cwd:requireString(value.cwd,"thread.cwd",{maxLength:8192}),parentId:typeof value.parentThreadId==="string"?value.parentThreadId:typeof sourceParent==="string"?sourceParent:null,
          updatedAt:typeof value.updatedAt==="number"?value.updatedAt:null,archived});
      }
      if(catalog.size>5000)throw new AgentError("DELETE_PREVIEW_TOO_LARGE","主机会话过多，暂不能可靠预览删除范围");
      if(page.nextCursor!=null && (typeof page.nextCursor!=="string"||!page.nextCursor||page.nextCursor.length>8192||seen.has(page.nextCursor)))throw new AgentError("DELETE_PREVIEW_INCOMPLETE","后代会话分页未完成");
      cursor=typeof page.nextCursor==="string"?page.nextCursor:null;if(cursor)seen.add(cursor);
    }while(cursor);
  }
  if(!catalog.has(thread.nativeThreadId))throw new AgentError("DELETE_PREVIEW_INCOMPLETE","目录中未找到删除目标，不能用列表缺失推断已删除");
  const ids=new Set([thread.nativeThreadId]);
  for(let changed=true;changed;) {changed=false;for(const entry of catalog.values())if(entry.parentId&&ids.has(entry.parentId)&&!ids.has(entry.id)){ids.add(entry.id);changed=true;}}
  if(ids.size>50)throw new AgentError("DELETE_PREVIEW_TOO_LARGE","后代会话超过 49 个，请先逐个处理后代会话");
  const threads=[...ids].sort().map(id=>catalog.get(id)!);
  for(const entry of threads)await verifySessionCwd(project,entry.cwd);
  if(Buffer.byteLength(JSON.stringify(threads))>20000)throw new AgentError("DELETE_PREVIEW_TOO_LARGE","删除范围过大，请先处理部分后代会话");
  return {nativeThreadId:thread.nativeThreadId,threads,fingerprint:sha256(canonicalJson(threads)),expiresAt:new Date(Date.now()+300_000).toISOString()};
}
