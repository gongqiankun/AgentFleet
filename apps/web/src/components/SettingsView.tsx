import { count, t, locale } from "../i18n";
import { useEffect, useState } from "react";
import { Laptop, LoaderCircle, ShieldCheck, SunMoon } from "lucide-react";
import { api } from "../lib/api";
import type { ClientSessionInfo, Dashboard, Project } from "../lib/types";
import { ThemeSettings } from "./ThemeSwitcher";

type Notice = (tone: "info" | "success" | "danger", message: string) => void;
const errorText = (error: unknown) => error instanceof Error ? error.message : t("操作未完成，请稍后重试");
const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale()) : t("时间未记录");

function HistoryPolicy({ project, onSaved, onToast }: { project: Project; onSaved: (project: Project) => void; onToast: Notice }) {
  const [sync, setSync] = useState(project.syncContent);
  const [days, setDays] = useState(project.retentionDays);
  const [busy, setBusy] = useState(false);
  const changed = sync !== project.syncContent || days !== project.retentionDays;
  async function save() {
    if (busy || !changed) return;
    setBusy(true);
    try {
      await api.updateProjectContentPolicy(project.id, sync, days);
      onSaved({ ...project, syncContent: sync, retentionDays: days });
      onToast("success", t("已保存 {0} 的历史设置", project.alias));
    } catch (error) { onToast("danger", errorText(error)); }
    finally { setBusy(false); }
  }
  return <form className="history-policy-form" onSubmit={event => { event.preventDefault(); void save(); }}>
    <label className="history-policy-toggle"><input type="checkbox" checked={sync} disabled={busy} onChange={event => setSync(event.target.checked)} /><span>{t("保存会话内容到云端")}</span></label>
    <p className="subtle">{sync ? t("在面板查看消息、回复和执行输出。") : t("关闭后不再同步新正文，消息排队也会停用。")}</p>
    <label className="settings-field"><span>{t("保存时长")}</span><select aria-label={t("历史保存时长")} value={days} disabled={busy || !sync} onChange={event => setDays(Number(event.target.value) as Project["retentionDays"])}>{[1, 3, 7, 14, 30].map(value => <option key={value} value={value}>{count(value, "天")} </option>)}</select></label>
    <button className="button button--primary" type="submit" disabled={busy || !changed}>{busy ? t("正在保存…") : t("保存设置")}</button>
  </form>;
}

export function SettingsView({ dashboard, onUpdated, onToast }: { dashboard: Dashboard; onUpdated: () => Promise<void>; onToast: Notice }) {
  const [sessions, setSessions] = useState<ClientSessionInfo[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [sessionError, setSessionError] = useState("");
  const [revoking, setRevoking] = useState<string>();
  const [reloadSessions, setReloadSessions] = useState(0);
  useEffect(() => {
    let active = true;
    setLoadingSessions(true); setSessionError("");
    void api.clientSessions().then(result => { if (active) setSessions(result.sessions); })
      .catch(error => { if (active) setSessionError(errorText(error)); })
      .finally(() => { if (active) setLoadingSessions(false); });
    return () => { active = false; };
  }, [reloadSessions]);
  const machines = dashboard.machines.filter(machine => machine.identity === "paired");
  const [selectedMachineId, setSelectedMachineId] = useState(machines[0]?.id ?? "");
  const machineId = machines.some(machine => machine.id === selectedMachineId) ? selectedMachineId : machines[0]?.id ?? "";
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [projectError, setProjectError] = useState("");
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [reloadProjects, setReloadProjects] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setProjects([]); setProjectId(""); setProjectError(""); setLoadingProjects(Boolean(machineId));
    if (!machineId) return () => controller.abort();
    const load = async () => {
      const items: Project[] = []; const seen = new Set<string>(); let cursor: string | null = null;
      do {
        const page = await api.projects({ machineId, limit: 100, ...(cursor ? { cursor } : {}) }, controller.signal);
        if (controller.signal.aborted) return;
        items.push(...page.items); cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error(t("项目列表加载未完成，请重试"));
        if (cursor) seen.add(cursor);
      } while (cursor);
      setProjects(items); setProjectId(items[0]?.id ?? "");
    };
    void load().catch(error => { if (!controller.signal.aborted) setProjectError(errorText(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoadingProjects(false); });
    return () => controller.abort();
  }, [machineId, reloadProjects]);
  // A host switch must immediately hide the previous host's policy controls.
  const selected = projects.find(project => project.id === projectId && project.machineId === machineId);
  async function revoke(id: string) {
    if (revoking) return;
    setRevoking(id);
    try { await api.revokeClientSession(id); setSessions(items => items.filter(item => item.id !== id)); onToast("success", t("已退出该浏览器的登录")); }
    catch (error) { onToast("danger", errorText(error)); }
    finally { setRevoking(undefined); }
  }
  return <section className="wide-view settings-view">
    <div className="wide-view__heading"><div><h1>{t("设置")}</h1><p>{t("管理界面外观、浏览器登录和云端历史。")}</p></div><ShieldCheck size={30} /></div>
    <div className="settings-layout">
      <section className="settings-block theme-settings-block"><h2><SunMoon size={18} />{t("界面外观")}</h2><p className="subtle">{t("选择阅读更舒适的外观，自动保存在此浏览器。")}</p><ThemeSettings /></section>
      <section className="settings-block"><h2>{t("云端历史")}</h2><p className="subtle">{t("按项目设置保存内容和时长。宿主机上的原始会话不受影响。")}</p>
        {machines.length === 0 ? <p className="subtle">{t("添加主机并发现项目后，可以设置历史保存方式。")}</p> : <>
          <label className="settings-field"><span>{t("主机")}</span><select aria-label={t("历史设置主机")} value={machineId} onChange={event => setSelectedMachineId(event.target.value)}>{machines.map(machine => <option key={machine.id} value={machine.id}>{machine.name}</option>)}</select></label>
          <label className="settings-field"><span>{t("项目")}</span><select aria-label={t("历史设置项目")} value={selected?.id ?? ""} disabled={loadingProjects || !projects.length} onChange={event => setProjectId(event.target.value)}>{!selected && <option value="">{loadingProjects ? t("正在读取项目…") : t("暂无项目")}</option>}{projects.filter(project => project.machineId === machineId).map(project => <option key={project.id} value={project.id}>{project.alias} · {project.pathHint}</option>)}</select></label>
          {projectError && <p className="catalog-error" role="alert">{projectError} <button type="button" className="button button--quiet" onClick={() => setReloadProjects(value => value + 1)}>{t("重试")}</button></p>}
          {selected && <HistoryPolicy key={selected.id} project={selected} onToast={onToast} onSaved={project => { setProjects(items => items.map(item => item.id === project.id ? project : item)); void onUpdated().catch(() => undefined); }} />}
        </>}
      </section>
      <section className="settings-block"><h2>{t("已登录浏览器")}</h2><p className="subtle">{t("退出不再使用的浏览器登录。")}</p>
        {loadingSessions ? <div className="loading-line"><LoaderCircle className="spin" size={17} />{t("读取中")}</div> : sessionError ? <p className="catalog-error" role="alert">{sessionError} <button type="button" className="button button--quiet" onClick={() => setReloadSessions(value => value + 1)}>{t("重试")}</button></p> : sessions.map((session, index) => <div className="client-session-row" key={session.id}>
          <span className="client-icon"><Laptop size={17} /></span><div><strong>{session.current ? t("当前浏览器") : t("其他浏览器 {0}", index + 1)}</strong><span>{t("登录于")}{locale() === "en" ? " " : ""}{date(session.createdAt)}</span><span>{t("最近活动")}{locale() === "en" ? " " : ""}{date(session.lastSeenAt)}</span></div>
          {session.current ? <span className="current-label">{t("当前")}</span> : <button type="button" aria-label={t("退出浏览器 {0}", index + 1)} disabled={Boolean(revoking)} onClick={() => void revoke(session.id)}>{revoking === session.id ? t("正在退出…") : t("退出登录")}</button>}
        </div>)}
      </section>
    </div>
  </section>;
}
