import { t, localized } from "../i18n";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Activity, ArrowUpRight, ChevronRight, Layers3, Server, X } from "lucide-react";
import type { FleetSession, Machine } from "../lib/types";
import { hostCardState } from "./HostCards";

type Category = "hosts" | "running" | "managed";
const categories = localized(() => ([
  { id: "hosts", label: t("在线主机"), title: t("在线主机"), icon: Server },
  { id: "running", label: t("运行中"), title: t("运行中的会话"), icon: Activity },
  { id: "managed", label: t("已接管"), title: t("已接管的会话"), icon: Layers3 },
] as const));

export function FleetStatus({ machines, sessions, connected, onSession, onMachine, utility }: {
  machines: Machine[]; sessions: FleetSession[]; connected: boolean;
  onSession: (id: string) => void; onMachine: (id: string) => void; utility?: ReactNode;
}) {
  const [category, setCategory] = useState<Category>();
  const dialog = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const online = machines.filter(machine => machine.identity === "paired" && machine.reachability === "live");
  const running = sessions.filter(session => session.state.currentTurn === "in_progress");
  const managed = sessions.filter(session => session.state.ownership === "agentfleet_owned");
  const counts = { hosts: online.length, running: running.length, managed: managed.length };
  const close = () => { setCategory(undefined); trigger.current?.focus(); };
  const open = category !== undefined;
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setCategory(undefined); trigger.current?.focus(); }
      if (event.key === "Tab") {
        const controls = dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
        const first = controls?.[0], last = controls?.[controls.length - 1];
        if (!dialog.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener("keydown", keydown); };
  }, [open]);
  const selected = categories.find(item => item.id === category);
  const visible = category === "running" ? running : managed;
  return <>
    <div className="rail-status" aria-label={t("Fleet 摘要")}>
      {categories.map(({ id, label, title, icon: Icon }) => <button key={id} type="button" className={`fleet-shortcut fleet-shortcut--${id}`} aria-label={t("查看{0}（{1}）", title, counts[id])} aria-haspopup="dialog" aria-expanded={category === id} onClick={event => { trigger.current = event.currentTarget; setCategory(id); }}>
        <span className="stat-value">{counts[id]}</span><span>{label}</span><Icon className="fleet-shortcut__icon" size={14} aria-hidden="true" /><ChevronRight size={13} aria-hidden="true" />
      </button>)}
      {utility && <div className="rail-theme">{utility}</div>}
      <div className="relay-state"><span className={`status-dot status-dot--${connected ? "live" : "warning"}`} aria-hidden="true" /><span>{connected ? t("连接正常") : t("正在重新连接")}</span></div>
    </div>
    {selected && createPortal(<div className="activity-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <section className="activity-panel" role="dialog" aria-modal="true" aria-labelledby="activity-title" ref={dialog}>
        <header className="activity-panel__head"><div><span className="eyebrow">{t("快捷访问")}</span><h2 id="activity-title">{selected.title}<span>{counts[selected.id]}</span></h2></div><button className="icon-button" type="button" aria-label={t("关闭快捷列表")} onClick={close}><X size={19} /></button></header>
        <div className="activity-tabs" role="group" aria-label={t("快捷列表分类")}>{categories.map(({id,label}) => <button type="button" key={id} aria-pressed={category === id} onClick={() => setCategory(id)}>{label}<span>{counts[id]}</span></button>)}</div>
        <div className="activity-list">
          {category === "hosts" ? online.map(machine => {
            const state = hostCardState(machine);
            return <button className="activity-item" type="button" key={machine.id} onClick={() => { close(); onMachine(machine.id); }}>
              <span className={`activity-item__icon${state.tone === "running" ? " activity-item__icon--running" : ""}`}><Server size={20} /></span>
              <span className="activity-item__copy"><strong>{machine.name}</strong><small>{machine.os} · {machine.arch}</small><em>{state.activity}</em></span><ArrowUpRight size={17} aria-hidden="true" />
            </button>;
          }) : visible.map(session => <button className="activity-item" type="button" key={session.id} onClick={() => { close(); onSession(session.id); }}>
            <span className={`activity-item__icon${session.state.currentTurn === "in_progress" && session.state.reachability === "live" ? " activity-item__icon--running" : ""}`}><Activity size={20} /></span>
            <span className="activity-item__copy"><strong>{session.title}</strong><small>{session.machineName} · {session.projectAlias}</small><em>{session.state.unknownFreeze ? t("结果待核验") : session.state.reachability !== "live" ? t("等待主机连接") : session.state.waitReason === "approval" ? t("等待确认") : session.state.waitReason === "user_input" ? t("等待回答") : session.state.currentTurn === "in_progress" ? t("任务运行中") : t("已接管 · 可打开会话")}</em></span><ArrowUpRight size={17} aria-hidden="true" />
          </button>)}
          {counts[selected.id] === 0 && <div className="activity-empty"><selected.icon size={30} /><h3>{category === "hosts" ? t("暂无在线主机") : category === "running" ? t("暂无运行中的会话") : t("暂无已接管的会话")}</h3><p>{category === "hosts" ? t("主机连接后会显示在这里。") : category === "running" ? t("开始任务后，可从这里快速回到会话。") : t("在会话中点击接管，即可在这里集中访问。")}</p></div>}
        </div>
        <footer className="activity-panel__foot">{category === "hosts" ? t("选择主机，查看配置与连接状态") : t("选择会话，直接回到对话")}</footer>
      </section>
    </div>, document.body)}
  </>;
}
