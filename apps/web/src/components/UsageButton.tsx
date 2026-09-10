import { useEffect, useRef, useState } from "react";
import { BarChart3, X } from "lucide-react";
import { api } from "../lib/api";
import type { UsageSummary } from "../lib/usage";
import { locale, t } from "../i18n";
export function UsageButton({scope,id,onSession}:{scope:"session"|"project"|"machine";id:string;onSession?:(id:string)=>void}) {
  const [data,setData]=useState<UsageSummary>();const [failed,setFailed]=useState(false);const [open,setOpen]=useState(false);
  const [refreshing,setRefreshing]=useState(false);const [refreshNotice,setRefreshNotice]=useState("");
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    setData(undefined);setFailed(false);setOpen(false);setRefreshNotice("");
    const controller=new AbortController();let busy=false;
    const update=async()=>{if(busy||controller.signal.aborted)return;busy=true;try{const next=await api.usage(scope,id,controller.signal);if(!next || next.coverage!=="observed-only" || !Array.isArray(next.accounts) || !Array.isArray(next.topSessions))throw new Error("Invalid usage response");if(!controller.signal.aborted){setData(next);setFailed(false);}}catch{if(!controller.signal.aborted)setFailed(true);}finally{busy=false;}};
    void update();const timer=window.setInterval(()=>{if(!document.hidden)void update();},30_000);
    return ()=>{controller.abort();window.clearInterval(timer);};
  },[scope,id]);
  useEffect(()=>{const element=dialog.current;if(open&&!element?.open)element?.showModal?.();else if(!open&&element?.open)element.close();},[open]);
  async function refreshHost() {
    setRefreshing(true);setRefreshNotice("");
    try { await api.hostOperation(id,"catalog.refresh",crypto.randomUUID());setRefreshNotice(t("已请求主机刷新，结果以更新时间为准。")); }
    catch { setRefreshNotice(t("暂时无法请求刷新，请确认主机在线且没有其他维护操作。")); }
    finally { setRefreshing(false); }
  }
  const number=(n:number)=>new Intl.NumberFormat(locale(),{maximumFractionDigits:0}).format(n);
  const short=(n:number)=>new Intl.NumberFormat(locale(),{notation:"compact",maximumFractionDigits:1}).format(n);
  const date=(s:string)=>new Date(s).toLocaleString(locale());
  const weekly=data?.accounts.flatMap(a=>a.windows.filter(w=>w.windowMinutes===10080 && w.bucket==="codex").map(w=>({w,a})))??[];
  const label=scope==="machine"&&weekly.length===1?t("周额度剩余 {0}%",weekly[0].w.remainingPercent):scope==="machine"&&!!data?.accounts.some(a=>a.windows.length)?t("用量与剩余额度"):data?.recorded?t("已记录 {0} tokens",short(data.recorded.totalTokens)):t("用量未上报");
  return <>
    <button type="button" className="button button--quiet usage-trigger" onClick={()=>setOpen(true)} aria-haspopup="dialog" title={t("查看用量与剩余额度")}><BarChart3 size={14}/>{failed?t("用量暂不可用"):label}</button>
    <dialog ref={dialog} className="modal usage-dialog" aria-label={t("用量与剩余额度")} onCancel={()=>setOpen(false)} onClose={()=>setOpen(false)}>
      <header className="modal-head"><div><h2>{t("用量与剩余额度")}</h2><p>{t("账号看额度，项目和会话看已记录 token")}</p></div><button type="button" className="icon-button" aria-label={t("关闭用量")} onClick={()=>setOpen(false)}><X size={18}/></button></header>
      <div className="usage-body">
        {failed&&<p role="status">{t("用量读取失败，已有数据可能过期。")}</p>}
        <section><h3>{t("账号额度（共享）")}</h3>
          {scope==="machine"&&<button type="button" className="button button--quiet" disabled={refreshing} onClick={()=>void refreshHost()}>{t("刷新主机信息与额度")}</button>}
          {refreshNotice&&<p role="status">{refreshNotice}</p>}
          {!data?.accounts.length&&<p>{t("账号额度未上报；需要支持额度查询的 Codex 认证。")}</p>}
          {data?.accounts.map((account,i)=><div className="usage-account" key={i}>
            <p>{account.sourceMachine} · {t("更新于 {0}",date(account.observedAt))}{(account.stale||Date.now()-Date.parse(account.observedAt)>180_000)&&<strong> · {t("数据已过期")}</strong>}</p>
            {!account.windows.length&&<p>{t("当前认证未返回额度窗口。")}</p>}
            {account.windows.map(w=><div className="usage-window" key={`${w.bucket}:${w.window}`}><div><strong>{w.windowMinutes===10080?t("周额度"):w.windowMinutes===300?t("5 小时额度"):t("{0} 分钟额度",w.windowMinutes)} · {w.bucket}</strong><span>{t("已用 {0}% · 剩余 {1}%",w.usedPercent,w.remainingPercent)}</span></div><progress max={100} value={w.usedPercent} aria-label={t("额度已用比例")}/><small>{w.resetsAt?t("重置于 {0}",date(new Date(w.resetsAt*1000).toISOString())):t("重置时间未上报")}</small></div>)}
            {!account.identityKnown&&<small>{t("账号身份未上报，此处仅展示来源主机快照，不与其他主机相加。")}</small>}
          </div>)}
          <p className="usage-note">{t("账号额度由同账号的多个设备和会话共享，不能按 token 比例归属到某个项目。")}</p>
        </section>
        <section><h3>{t("已记录 token 消耗")}</h3>
          {data?.recorded?<><dl className="usage-totals"><div><dt>{t("已记录总量")}</dt><dd>{number(data.recorded.totalTokens)}</dd></div><div><dt>{t("近 7 个 UTC 日期")}</dt><dd>{number(data.recentSevenDaysTokens??0)}</dd></div><div><dt>{t("输入 token")}</dt><dd>{number(data.recorded.inputTokens)}</dd></div><div><dt>{t("输出 token")}</dt><dd>{number(data.recorded.outputTokens)}</dd></div><div><dt>{t("缓存输入（包含于输入）")}</dt><dd>{number(data.recorded.cachedInputTokens)}</dd></div><div><dt>{t("推理输出（包含于输出）")}</dt><dd>{number(data.recorded.reasoningOutputTokens)}</dd></div></dl>
          <p>{t("已获取 {0} / {1} 个会话",data.observedSessions,data.totalSessions)}</p><p>{t("开始记录：{0}",data.firstObservedAt?date(data.firstObservedAt):"—")}<br/>{t("最近上报：{0}",data.lastObservedAt?date(data.lastObservedAt):"—")}</p></>:<p>{t("尚无用量数据。升级 Agent 后，新产生的原生用量通知会开始记录；未获取不代表零消耗。")}</p>}
          {!!data?.discontinuities&&<p>{t("检测到计数不连续，缺失区间未估算。")}</p>}
          <p className="usage-note">{t("仅统计收到的用量通知；接入前历史、独立 CLI 中的请求和未同步内容的会话可能缺失。最近 7 天并非账号额度重置周期。缓存和推理明细不能再次加到总量。")}</p>
          {data?.last&&<details><summary>{t("最近请求与原生累计")}</summary><p>{t("最近请求：{0} tokens",number(data.last.totalTokens))}</p><p>{t("原生累计：{0} tokens",number(data.nativeTotal?.totalTokens??0))}</p><p>{t("原生累计可能包含接入前或分支继承的历史，不计入项目已记录总量。")}</p></details>}
        </section>
        {scope==="machine"&&!!data?.topProjects?.length&&<section><h3>{t("消耗最多的项目（前 10）")}</h3><ol className="usage-ranking">{data.topProjects.map(p=><li key={p.id}>{p.title}<strong>{number(p.totalTokens)} tokens</strong></li>)}</ol></section>}
        {scope!=="session"&&!!data?.topSessions.length&&<section><h3>{t("消耗最多的会话（前 10）")}</h3><ol className="usage-ranking">{data.topSessions.map(s=><li key={s.id}>{onSession?<button type="button" onClick={()=>{setOpen(false);onSession(s.id);}}>{s.title}</button>:<a href={`/sessions/${encodeURIComponent(s.id)}`}>{s.title}</a>}<strong>{number(s.totalTokens)} tokens</strong></li>)}</ol></section>}
      </div>
    </dialog>
  </>;
}
