import { Settings2, ChevronRight } from "lucide-react";
import { t } from "../i18n";
import type { RuntimeSettings } from "../lib/codex-settings";
import type { RuntimeSummary } from "./CodexSettingsPanel";

export function RuntimeSettingsShortcut({sessionId,summary,observed,running,activeTurnId,onOpen}:{sessionId:string;summary?:RuntimeSummary;observed?:RuntimeSettings|null;running:boolean;activeTurnId?:string|null;onOpen:()=>void}) {
  const current=summary?.sessionId===sessionId?summary:undefined;
  const native=observed?.accepted && (!observed.observed || Date.parse(observed.accepted.acceptedAt)>Date.parse(observed.observed.observedAt))?observed.accepted:observed?.observed;
  const model=current?.settings?.model??native?.model;
  const effort=current?.settings?current.settings.effort:native?.effort;
  const source=current?.changed?t("本次"):current?.source==="session"?t("会话覆盖"):t("继承");
  const detail=current?.source==="machine"?t("主机默认"):current?.source==="project"?t("项目默认"):current?.source==="session"?t("会话覆盖"):t("Codex 自身配置");
  const text=current?.loaded?`${source} · ${model??t("模型未上报")} · ${effort??t("继承强度")}`:current?.failed?t("模型配置暂不可用"):t("读取模型配置…");
  const title=`${detail} · ${t("点击配置下次发送的模型与推理强度")} · ${t("首次发送即采用所选配置；正在执行的任务及其补充指令不会切换模型。")}${!current?.settings&&native?` · ${t("模型信息来自最近一次主机记录")}`:""}`;
  // Only a receipt bound to this exact native turn can describe the running task.
  const accepted=activeTurnId && observed?.accepted?.nativeTurnId===activeTurnId?observed.accepted:undefined;
  const same=Boolean(current?.loaded && current.settings && accepted && current.settings.model===accepted.model && current.settings.effort===accepted.effort);
  const activeText=accepted?`${accepted.model} · ${accepted.effort??t("强度未确认")}`:t("未确认");
  return <button type="button" className="runtime-settings-shortcut" aria-label={t("快速配置模型与推理强度")} aria-haspopup="dialog" title={title} onClick={onOpen}><Settings2 size={13}/><span className="runtime-settings-lines">{running?<><span className="runtime-settings-line" title={t("当前任务显示主机已接受的配置，不代表供应商最终模型确认。")}><small>{t("当前任务")}</small><span>{activeText}</span></span>{!same&&<span className="runtime-settings-line"><small>{t("后续任务")}</small><span>{text}</span></span>}</>:<span className="runtime-settings-line"><small>{t("发送使用")}</small><span>{text}</span></span>}</span><ChevronRight size={13}/></button>;
}
