import { count, t, locale } from "../i18n";
import { Check, CircleDot, LoaderCircle, Server, Unplug } from "lucide-react";
import type { Machine } from "../lib/types";

export function hostCardState(machine: Machine) {
  if (machine.identity === "revoked" || machine.reachability === "unreachable") return { tone: "offline", connection: t("未连接"), activity: t("运行状态未知") };
  if (machine.reachability === "connecting") return { tone: "connecting", connection: t("正在连接"), activity: t("等待主机连接") };
  if (machine.reachability === "reconciling") return { tone: "connecting", connection: t("正在同步"), activity: t("正在更新状态") };
  if (machine.discovery?.checks?.some(check => check.id === "sandbox" && check.state === "failed")) return { tone: "unknown", connection: t("已连接"), activity: t("隔离检查未通过 · 仅可查看") };
  if (machine.discovery?.readiness === "action_required" || machine.discovery?.readiness === "read_only" || machine.compatibility === "degraded_read_only" || machine.compatibility === "incompatible") return { tone: "unknown", connection: t("已连接"), activity: t("需要处理 · 查看自检详情") };
  if (machine.discovery?.readiness === "checking" || machine.discovery?.state === "scanning") return { tone: "connecting", connection: t("已连接"), activity: t("正在自检与扫描") };
  if (machine.capacity === "busy" || machine.capacity === "saturated") return { tone: "running", connection: t("已连接"), activity: t("任务运行中") };
  if (machine.capacity === "idle") return { tone: "idle", connection: t("已连接"), activity: t("当前空闲") };
  return { tone: "unknown", connection: t("已连接"), activity: t("运行状态待更新") };
}

export function HostCards({ machines, selectedId, onSelect }: { machines: Machine[]; selectedId?: string; onSelect: (id: string) => void }) {
  return <section className="host-overview" aria-label={t("主机概览")}>
    <div className="host-overview__heading"><h2>{t("选择主机")}</h2><span>{count(machines.length, "台主机")} </span></div>
    <div className="host-cards" role="group" aria-label={t("选择主机")}>
      {machines.map(machine => {
        const state = hostCardState(machine);
        const selected = machine.id === selectedId;
        return <button type="button" key={machine.id} className={`host-card host-card--${state.tone}${selected ? " host-card--selected" : ""}`}
          aria-pressed={selected} aria-label={`${machine.name}，${state.connection}，${state.activity}`} title={machine.name} onClick={() => onSelect(machine.id)}>
          <span className="host-card__top"><span className="host-card__device" aria-hidden="true">{state.tone === "offline" ? <Unplug size={21} /> : <Server size={21} />}</span><span className="host-card__connection"><i aria-hidden="true" />{state.connection}</span></span>
          <span className="host-card__identity"><strong>{machine.name}</strong><small>{machine.os} · {machine.arch}</small></span>
          <span className="host-card__activity"><span className="host-card__signal" aria-hidden="true">{state.tone === "running" ? <span className="host-card__bars">{[0, 1, 2, 3, 4].map(i => <i key={i} />)}</span> : state.tone === "connecting" ? <LoaderCircle size={17} /> : <CircleDot size={17} />}</span><span>{state.activity}</span></span>
          <span className="host-card__selection">{selected ? <><Check size={13} aria-hidden="true" />{t("当前主机")}</> : t("查看配置 →")}</span>
        </button>;
      })}
    </div>
    <p className="host-overview__hint">{t("任务状态仅针对面板接管的会话，不包含主机上独立运行的其他 Codex 会话。")}</p>
  </section>;
}
