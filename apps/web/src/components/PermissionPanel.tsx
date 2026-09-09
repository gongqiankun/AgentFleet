import { t, locale, localized, systemText } from "../i18n";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { permissionNames, permissionSources, type PermissionPreferences, type PermissionProfile, type PermissionScope } from "../lib/permissions";
import type { RuntimeSettings } from "../lib/codex-settings";

const descriptions: Record<PermissionProfile, string> = localized(() => ({
  project: t("项目内写入，默认不联网。额外访问需在面板确认。"),
  network: t("项目内写入并允许联网，可下载依赖。项目外操作仍需确认。"),
  full: t("使用安装账号的文件、网络与系统权限，不再逐次审批。可用于部署。"),
}));

export function PermissionPanel({ machineId, sessionId, observed }: { machineId?: string; sessionId?: string; observed?: RuntimeSettings | null }) {
  const kind = machineId ? "machines" : "sessions";
  const id = machineId ?? sessionId ?? "";
  const [data, setData] = useState<PermissionPreferences | null>(null);
  const [scope, setScope] = useState<PermissionScope>(machineId ? "machine" : "session");
  const [choice, setChoice] = useState<PermissionProfile | "inherit">("inherit");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError(""); setMessage(""); setConfirmed(false);
    void api.permissions(kind, id, controller.signal).then(value => {
      if (!controller.signal.aborted) { setData(value); setChoice(value.preferences[scope].profile ?? "inherit"); }
    }).catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message); });
    return () => controller.abort();
  }, [id, kind, scope, reload]);
  async function save() {
    if (!data) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const value = await api.savePermissions(kind, id, { scope, profile: choice === "inherit" ? null : choice, revision: data.preferences[scope].revision, confirmFullAccess: confirmed });
      setData(value); setConfirmed(false); setMessage(t("权限已保存，新提交的任务生效。正在执行和已排队的任务不变。"));
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  const effective = data && (data.source === "session" ? t("此会话单独设置") : t("继承自{0}", permissionSources[data.source]));
  const content = <>
    <p className="permission-chain">{t("主机默认")}<span>→</span> {t("项目")}<span>→</span> {t("会话")}<small>{t("下级默认继承，可单独覆盖")}</small></p>
    {data && <p className="permission-effective">{t("下一任务：")}<strong>{permissionNames[data.profile]}</strong><span>{machineId ? permissionSources[data.source] : effective}</span></p>}
    {observed?.permissions && <p className="subtle">{t("最近任务实际采用：")}{locale() === "en" ? " " : ""}{permissionNames[observed.permissions.profile]} · {permissionSources[observed.permissions.source] ?? observed.permissions.source} · {new Date(observed.permissions.acceptedAt).toLocaleString(locale())}</p>}
    {!machineId && <label className="permission-scope">{t("设置范围")}<select aria-label={t("权限设置范围")} disabled={busy} value={scope} onChange={event => { setScope(event.target.value as PermissionScope); setConfirmed(false); }}><option value="session">{t("此会话")}</option><option value="project">{t("此项目的所有会话")}</option><option value="machine">{t("此主机的所有项目")}</option></select></label>}
    {data && <fieldset className="permission-options" disabled={busy}>
      <legend>{t("任务执行权限")}</legend>
      <label className="permission-inherit"><input type="radio" name={`permission-${id}`} checked={choice === "inherit"} onChange={() => { setChoice("inherit"); setConfirmed(false); }} />{scope === "machine" ? t("使用系统默认（项目内开发）") : t("继承上级权限")}</label>
      <div className="permission-cards">{(["project", "network", "full"] as const).map(profile => <label key={profile} className={`permission-card${choice === profile ? " is-selected" : ""}`}>
        <span><input type="radio" name={`permission-${id}`} value={profile} checked={choice === profile} disabled={!data.supported && profile !== "project"} onChange={() => { setChoice(profile); setConfirmed(false); }} /><strong>{permissionNames[profile]}</strong></span><small>{descriptions[profile]}</small>
      </label>)}</div>
      {choice === "full" && <label className="permission-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t("我确认允许")}{locale() === "en" ? " " : ""}{scope === "machine" ? t("继承此主机配置的项目和会话") : scope === "project" ? t("继承此项目配置的会话") : t("此会话")}{locale() === "en" ? " " : ""}{t("使用安装账号的完整权限，包括修改项目外文件和执行部署。")}</label>}
    </fieldset>}
    {data && !data.supported && <p className="subtle">{t("请先在主机页更新连接服务，才能使用联网开发或主机完整访问。")}</p>}
    <div className="permission-actions"><button className="button button--primary" type="button" disabled={!data || busy || (choice === "full" && !confirmed)} onClick={() => void save()}>{busy ? t("保存中…") : t("保存权限")}</button><button className="button button--quiet" type="button" disabled={busy} onClick={() => setReload(value => value + 1)}>{t("刷新配置")}</button></div>
    {message && <p role="status">{systemText(message)}</p>}{error && <p className="catalog-error" role="alert">{systemText(error)}</p>}
  </>;
  return machineId ? <section className="permission-panel" aria-label={t("主机默认权限")}><h2>{t("主机默认权限")}</h2>{content}</section> : <details className="permission-panel session-config-section"><summary><span>{t("执行权限")}<small>{data ? `${permissionNames[data.profile]} · ${effective}` : t("读取配置中")}</small></span></summary>{content}</details>;
}
