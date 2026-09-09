import { count, t, locale, systemText } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2, X } from "lucide-react";
import { api } from "../lib/api";
import type { CommandReceipt, FleetSession } from "../lib/types";

export function NativeSessionDeletion({session,commands,pending,onChanged}:{session:FleetSession;commands:CommandReceipt[];pending:boolean;onChanged:()=>void}) {
  const [open,setOpen]=useState(false);
  const trigger=useRef<HTMLButtonElement>(null);
  const modal=useRef<HTMLElement>(null);
  const [previewId,setPreviewId]=useState<string>();
  const [confirmed,setConfirmed]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const close=()=>{if(!busy){setOpen(false);setConfirmed(false);trigger.current?.focus();}};
  useEffect(()=>{
    if(!open)return;
    const keydown=(event:KeyboardEvent)=>{
      if(event.key==="Escape"&&!busy){event.preventDefault();setOpen(false);setConfirmed(false);trigger.current?.focus();}
      if(event.key==="Tab"){
        const controls=modal.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)");
        const first=controls?.[0],last=controls?.[controls.length-1];
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    };
    document.addEventListener("keydown",keydown);
    return ()=>document.removeEventListener("keydown",keydown);
  },[open,busy]);
  const receipt=commands.find(c=>c.id===previewId);
  const plan=receipt?.state==="applied"&&receipt.outcome==="succeeded"?receipt.deletionPreview:undefined;
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{
    setConfirmed(false);setNow(Date.now());
    if (!plan) return;
    const timer=setTimeout(()=>setNow(Date.now()),Math.max(0,Date.parse(plan.expiresAt)-Date.now())+1);
    return ()=>clearTimeout(timer);
  },[plan?.fingerprint,plan?.expiresAt]);
  const valid=plan&&plan.nativeThreadId===session.nativeThreadId&&Date.parse(plan.expiresAt)>now;
  const precondition={nativeThreadId:session.nativeThreadId,executionSegmentId:session.executionSegmentId,threadControlVersion:session.threadControlVersion,projectLeaseVersion:session.projectLeaseVersion,expectedActiveTurnId:null};
  async function preview() {
    setBusy(true);setConfirmed(false);setMessage("");setPreviewId(undefined);
    try {const result=await api.command(session.id,{type:"thread.delete.preview",payload:{},precondition,clientMutationId:crypto.randomUUID()});setPreviewId(result.command.id);onChanged();}
    catch(error){setMessage(error instanceof Error?error.message:t("无法读取删除预览"));}finally{setBusy(false);}
  }
  async function remove() {
    if(!valid||!confirmed||!previewId||Date.parse(plan.expiresAt)<=Date.now())return;
    setBusy(true);setMessage("");
    try {await api.command(session.id,{type:"thread.delete",payload:{previewCommandId:previewId,fingerprint:plan.fingerprint},precondition,clientMutationId:crypto.randomUUID()});setConfirmed(false);setPreviewId(undefined);setMessage(t("删除请求已提交，等待主机确认。确认成功前会话继续保留。"));onChanged();}
    catch(error){setMessage(error instanceof Error?error.message:t("删除请求失败"));}finally{setBusy(false);}
  }
  return <>
    <button ref={trigger} type="button" className="button button--danger-quiet session-delete-trigger" onClick={()=>setOpen(true)}><Trash2 size={14}/>{t("删除会话")}</button>
    {open&&createPortal(<div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)close();}}>
    <section ref={modal} className="modal native-session-deletion" role="dialog" aria-modal="true" aria-labelledby="native-deletion-title">
    <div className="modal-head"><h2 id="native-deletion-title">{t("永久删除原生会话")}</h2><button type="button" className="icon-button" aria-label={t("关闭删除确认")} autoFocus disabled={busy} onClick={close}><X size={18}/></button></div>
    <p>{t("永久删除宿主机及面板中的此会话和它派生的子代理后代历史，无法撤销。项目文件不在删除范围内。")}</p>
    <p>{session.machineName} · {session.projectAlias} · {session.title}</p>
    <button type="button" className="button button--quiet" disabled={busy||pending||!session.actions?.deletePreview?.allowed} onClick={()=>void preview()}>{t("读取主机删除范围")}</button>
    {!session.actions?.deletePreview?.allowed&&<p>{systemText(session.actions?.deletePreview?.message)||t("请更新主机连接服务后使用删除预览。")}</p>}
    {previewId&&!plan&&<p>{systemText(receipt?.message)||t("正在等待主机返回删除范围…")}</p>}
    {plan&&<><p>{t("主机核验范围：")}{locale() === "en" ? " " : ""}{count(plan.threads.length, "个会话")} </p><ul>{plan.threads.map(thread=><li key={thread.id}>{thread.title} · {thread.id}<br/>{thread.cwd}</li>)}</ul>
      {!valid&&<p>{t("预览已过期，请重新读取主机删除范围。")}</p>}
      <label><input type="checkbox" checked={confirmed} disabled={busy||pending||!valid} onChange={e=>setConfirmed(e.target.checked)}/>{t("我确认永久删除以上会话及历史")}</label>
      <button type="button" className="button button--danger-quiet" disabled={busy||pending||!valid||!confirmed||!session.actions?.delete?.allowed} onClick={()=>void remove()}>{t("确认永久删除")}</button></>}
    {message&&<p role="status">{systemText(message)}</p>}
    <div className="modal-actions"><button type="button" className="button button--quiet" disabled={busy} onClick={close}>{t("取消")}</button></div>
    </section></div>,document.body)}
  </>;
}
