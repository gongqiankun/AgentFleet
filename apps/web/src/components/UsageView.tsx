import { useEffect, useState } from "react";
import { BarChart3, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import type { Machine } from "../lib/types";
import type { UsageBreakdownEntry, UsageSummary } from "../lib/usage";
import { locale, t } from "../i18n";

const cacheRate=(input:number|null|undefined,cached:number|null|undefined)=>input&&cached!=null?cached/input*100:null;

export function UsageView({machines,selectedId,onSelect,onSession}:{machines:Machine[];selectedId?:string;onSelect:(id:string)=>void;onSession:(id:string)=>void}) {
  const machine=machines.find(item=>item.id===selectedId)??machines[0];
  const [data,setData]=useState<UsageSummary>();
  const [loading,setLoading]=useState(false);
  const [failed,setFailed]=useState(false);
  const [refreshing,setRefreshing]=useState(false);
  const number=(value:number|null|undefined)=>value==null?"—":new Intl.NumberFormat(locale()).format(value);
  const percent=(value:number|null)=>value==null?t("未记录"):t("{0}%",new Intl.NumberFormat(locale(),{maximumFractionDigits:1}).format(value));
  const date=(value:string)=>new Date(value).toLocaleString(locale());
  const load=async(signal?:AbortSignal)=>{if(!machine)return;setLoading(true);try{setData(await api.usage("machine",machine.id,signal));setFailed(false);}catch(error){if(!(error instanceof DOMException&&error.name==="AbortError"))setFailed(true);}finally{if(!signal?.aborted)setLoading(false);}};
  useEffect(()=>{setData(undefined);setFailed(false);const controller=new AbortController();void load(controller.signal);return()=>controller.abort();},[machine?.id]);
  async function refresh(){if(!machine)return;setRefreshing(true);try{await api.refreshQuota(machine.id);await load();}finally{setRefreshing(false);}}
  const weeklyRate=cacheRate(data?.quotaCycle?.inputTokens,data?.quotaCycle?.cachedInputTokens);
  const weekly=data?.accounts.flatMap(account=>account.windows.filter(window=>window.bucket==="codex"&&window.windowMinutes===10080).map(window=>({account,window})))??[];
  const rows=(entries:UsageBreakdownEntry[]|undefined,session=false)=><div className="usage-table-wrap"><table className="usage-table"><thead><tr><th>{session?t("会话"):t("项目")}</th><th>{t("总消耗")}</th><th>{t("本周消耗")}</th><th>{t("周命中率")}</th></tr></thead><tbody>{entries?.length?entries.map(entry=><tr key={entry.id}><td>{session?<button type="button" onClick={()=>onSession(entry.id)}>{entry.title}</button>:entry.title}</td><td>{number(entry.totalTokens)} <small>tokens</small></td><td>{number(entry.weeklyTokens)} <small>tokens</small></td><td>{percent(cacheRate(entry.weeklyInputTokens,entry.weeklyCachedInputTokens))}</td></tr>):<tr><td colSpan={4} className="usage-table-empty">{loading?t("正在读取用量…"):t("尚无已记录用量")}</td></tr>}</tbody></table></div>;
  return <section className="wide-view usage-view">
    <div className="wide-view__heading"><div><h1>{t("消耗")}</h1><p>{t("查看本周额度、项目与会话的 token 消耗和缓存效率。")}</p></div><BarChart3 size={30}/></div>
    {!machine?<div className="usage-empty"><h2>{t("暂无主机")}</h2><p>{t("连接主机后，用量会在这里按项目和会话汇总。")}</p></div>:<>
      <div className="usage-toolbar"><label><span>{t("主机")}</span><select value={machine.id} onChange={event=>onSelect(event.target.value)}>{machines.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button className="button button--quiet" type="button" disabled={refreshing||loading} onClick={()=>void refresh()}><RefreshCw className={refreshing?"spin":undefined} size={15}/>{t("刷新消耗")}</button></div>
      {failed&&<p className="usage-error" role="status">{t("用量读取失败，请稍后重试。")}</p>}
      <div className="usage-overview-cards">
        <article><span>{t("官方周额度剩余")}</span><strong>{weekly.length===1?t("{0}%",weekly[0].window.remainingPercent):"—"}</strong><small>{weekly.length===1&&weekly[0].window.resetsAt?t("重置于 {0}",date(new Date(weekly[0].window.resetsAt*1000).toISOString())):t("等待额度上报")}</small></article>
        <article><span>{t("已记录总消耗")}</span><strong>{number(data?.recorded?.totalTokens)}</strong><small>tokens</small></article>
        <article><span>{t("本周消耗")}</span><strong>{number(data?.quotaCycle?.recordedTokens)}</strong><small>tokens{data?.quotaCycle?.boundaryIncomplete?" *":""}</small></article>
        <article><span>{t("周缓存命中率")}</span><strong>{percent(weeklyRate)}</strong><small>{t("缓存输入 ÷ 输入 token")}</small></article>
      </div>
      <div className="usage-section-head"><div><h2>{t("项目消耗")}</h2><p>{t("按本周消耗从高到低排列")}</p></div></div>{rows(data?.projects)}
      <div className="usage-section-head"><div><h2>{t("会话消耗")}</h2><p>{t("点击会话名称可直接进入")}</p></div></div>{rows(data?.sessions,true)}
      <p className="usage-footnote">{t("本周按账号上报的周额度重置周期计算。旧记录缺少分项时，周命中率显示为未记录。")}</p>
    </>}
  </section>;
}
