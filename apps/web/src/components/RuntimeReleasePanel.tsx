import { t, locale, localized, systemText } from "../i18n";
import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, RefreshCw } from "lucide-react";
import { api, type RuntimeReleaseStatus } from "../lib/api";
import type { Machine } from "../lib/types";

const phases: Record<string, string> = localized(() => ({ idle: t("已检查"), checking: t("查找新版"), downloading: t("校验安装包"), validating: t("隔离验证中"), promoted: t("已晋升"), blocked: t("需要适配"), failed: t("检查未通过"), paused: t("自动晋升已暂停") }));
const date = (value?: string) => value ? new Date(value).toLocaleString(locale()) : t("尚未检查");
export function RuntimeReleasePanel({ machine }: { machine: Machine }) {
  const [data, setData] = useState<RuntimeReleaseStatus>();
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false); const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => { try { const next = await api.runtimeRelease(controller.signal); if (!controller.signal.aborted) { setData(next); setError(""); } } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t("读取升级状态失败")); } };
    void refresh(); const timer = setInterval(() => void refresh(), 10_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  useEffect(() => { setConfirm(false); }, [machine.id]);
  async function control(action: "check" | "pause" | "resume" | "rollback") {
    setBusy(true); setError(""); setNotice("");
    try { setData(await api.runtimeReleaseControl(action)); setNotice(action === "rollback" ? t("回退请求已提交，验证服务处理后主机将在空闲时应用。") : t("设置已保存，验证服务将在下一轮处理。")); setConfirm(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t("操作未完成")); }
    finally { setBusy(false); }
  }
  const profile = machine.codexProfile;
  const latestAgent = Number(machine.agentVersion.split(".")[0]) > 0 || Number(machine.agentVersion.split(".")[1]) >= 21;
  const running = ["checking", "downloading", "validating"].includes(data?.phase ?? "");
  const target = data?.target?.version;
  const rollout = profile?.source === "host" ? t("使用自装 Codex，不参与托管切换") : !latestAgent ? t("请先点击本机「检查并更新」，升级连接服务后可自动跟随托管目标") : machine.reachability !== "live" ? t("等待主机连接") : profile?.runtimeUpdateState === "rolled_back" ? t("本机更新失败，已自动回退：{0}", String(profile.runtimeUpdateError ?? t("等待修复版本"))) : profile?.runtimeUpdateState === "failed" ? t("本机更新未完成，原运行时保留：{0}", String(profile.runtimeUpdateError ?? t("请检查连接"))) : machine.codexVersion === target ? t("已运行当前托管目标") : ["busy", "saturated"].includes(machine.capacity) ? t("等待当前任务结束后更新") : t("等待主机检查更新；也可点击本机「检查并更新」");
  return <section className="runtime-release-panel" aria-label={t("托管 Codex 自动升级")}>
    <header><div><span className="eyebrow">Managed Codex</span><h2>{t("托管 Codex 自动升级")}</h2></div><span className={`runtime-release-phase${running ? " is-running" : ""}`}>{data ? phases[data.phase] ?? data.phase : t("读取状态中")}</span></header>
    <p>{t("只更新 AgentFleets 独立管理的程序，不修改你自装的 Codex。以下验证与晋升设置适用于所有主机。")}</p>
    {data && <>
      <div className="runtime-release-versions"><div><span>{t("当前托管目标")}</span><strong>{target ?? t("正在准备基线")}</strong></div><ArrowRight aria-hidden="true" size={20} /><div><span>{t("官方最新稳定版")}</span><strong>{data.latestVersion ?? t("尚未发现")}</strong></div></div>
      {!data.configured ? <p role="status">{t("自动验证服务尚未配置，继续使用内置托管版本。")}</p> : !data.workerOnline && <p className="catalog-error" role="status">{t("验证服务未连接，暂不能自动验证或晋升；已发布目标不变。")}</p>}
      <p className="runtime-release-message" role="status">{systemText(data.message)}</p>
      <div className="runtime-release-times"><span>{t("上次检查：")}{locale() === "en" ? " " : ""}{date(data.lastCheckedAt)}</span><span>{t("下次检查：")}{locale() === "en" ? " " : ""}{data.paused ? t("恢复晋升后继续") : date(data.nextCheckAt)}</span></div>
      <ul className="runtime-release-checks">{data.checks.map((check, index) => <li key={`${systemText(check.name)}:${index}`} data-state={check.state}><CheckCircle2 size={16} aria-hidden="true" /><div><strong>{systemText(check.name)}</strong><p>{systemText(check.detail)}</p></div></li>)}</ul>
      <p className="runtime-release-host"><strong>{machine.name}</strong> · {rollout}</p>
      <p className="host-help">{t("约每 6 小时检查官方版本；支持自动更新的连接服务约每 15 分钟检查托管目标。Linux 中心验证通过后，各平台主机还会校验版本、SHA-256、schema 与启动健康。不兼容的协议需要开发适配，不会强制晋升。")}</p>
      <div className="host-operation-buttons">
        <button type="button" className="button button--quiet" disabled={busy || !data.configured || !data.workerOnline || data.paused || running} onClick={() => void control("check")}><RefreshCw size={15} />{t("立即检查新版")}</button>
        <button type="button" className="button button--quiet" disabled={busy || !data.configured} onClick={() => void control(data.paused ? "resume" : "pause")}>{data.paused ? t("恢复自动晋升") : t("暂停自动晋升")}</button>
        {data.previous && <button type="button" className="button button--quiet" disabled={busy || !data.workerOnline} onClick={() => setConfirm(true)}>{t("回退托管目标")}</button>}
      </div>
      {confirm && <div className="runtime-release-confirm" role="group" aria-label={t("确认回退托管目标")}><p>{t("将所有托管主机的目标回退到")}{locale() === "en" ? " " : ""}{data.previous?.version}{locale() === "en" ? " " : ""}{t("，并暂停自动晋升。等待任务结束后切换，不中断正在运行的任务。")}</p><button type="button" className="button button--danger" disabled={busy} onClick={() => void control("rollback")}>{t("确认回退并暂停晋升")}</button><button type="button" className="button button--quiet" disabled={busy} onClick={() => setConfirm(false)}>{t("取消")}</button></div>}
      {data.history.length > 0 && <details className="runtime-release-history"><summary>{t("验证与晋升记录")}</summary>{data.history.map((item, index) => <article key={`${item.at}:${index}`}><strong>{item.version} · {item.result === "promoted" ? t("已晋升") : item.result === "rollback" ? t("已回退") : t("未晋升")}</strong><time>{date(item.at)}</time><p>{systemText(item.message)}</p></article>)}</details>}
    </>}
    {notice && <p role="status">{systemText(notice)}</p>}{error && <p role="alert" className="catalog-error">{systemText(error)}</p>}
  </section>;
}
