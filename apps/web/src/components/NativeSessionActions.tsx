import { t, locale, localized, systemText } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { FleetSession } from "../lib/types";

export type NativeOperation = "rename" | "archive" | "unarchive" | "fork" | "compact" | "review" | "stop";
const labels: Record<NativeOperation, string> = localized(() => ({ rename: t("重命名宿主机会话"), archive: t("归档宿主机会话"), unarchive: t("恢复宿主机归档"), fork: t("从当前历史创建分支"), compact: t("压缩上下文"), review: t("审查未提交修改"), stop: t("停止此会话的全部后台终端") }));
const descriptions: Record<NativeOperation, string> = localized(() => ({
  rename: t("同时修改宿主机 Codex 的标题，不只是面板别名。"),
  stop: t("停止当前会话在面板所连接 App Server 中的全部后台终端，可能中断构建或开发服务。不停止其他会话、其他 Codex 进程或主机服务，也不等于取消当前模型任务。"),
  archive: t("将宿主机会话移到归档，保留历史，不删除文件。归档后不能发送消息，可在这里恢复。"),
  unarchive: t("恢复宿主机会话，继续使用原来的历史。"),
  fork: t("复制已保存历史到新的 Codex 会话，不改变原会话。分支会在项目列表自动发现；能否接管取决于其历史格式和主机兼容能力。"),
  compact: t("让 Codex 压缩当前上下文，可能消耗模型额度。沿用当前原生配置，不应用面板的下次发送覆盖。请求接受不代表压缩完成。"),
  review: t("审查当前项目的暂存、未暂存及未跟踪修改，在此会话返回结果。可能消耗模型额度，沿用当前原生配置。"),
}));
export function NativeSessionActions({ session, request, pending, onChanged }: { session: FleetSession; request?: { action: NativeOperation; args: string; nonce: number }; pending: boolean; onChanged: () => void }) {
  const panel = useRef<HTMLDetailsElement>(null);
  const [action, setAction] = useState<NativeOperation>("rename");
  const [name, setName] = useState(session.title);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { if (request) { setAction(request.action); if (request.action === "rename" && request.args) setName(request.args); if (panel.current) panel.current.open = true; } }, [request]);
  const availability = session.actions?.[action];
  const enabled = availability?.allowed === true && !pending && !busy && (action !== "rename" || name.trim().length > 0);
  async function execute() {
    if (!enabled) return;
    setBusy(true); setMessage("");
    try {
      await api.command(session.id, { type: action === "stop" ? "thread.terminals.stop" : action === "compact" || action === "review" ? `turn.${action}` : `thread.${action}`, clientMutationId: crypto.randomUUID(),
        precondition: { nativeThreadId: session.nativeThreadId, executionSegmentId: session.executionSegmentId, threadControlVersion: session.threadControlVersion, expectedActiveTurnId: action === "stop" ? session.activeTurnId ?? null : null, projectLeaseVersion: session.projectLeaseVersion },
        payload: action === "rename" ? { name: name.trim() } : {} });
      setMessage(t("请求已提交，请在操作进度中查看宿主机回执。")); onChanged();
    } catch (e) { setMessage(e instanceof Error ? e.message : t("操作失败")); }
    finally { setBusy(false); }
  }
  return <details ref={panel} className="codex-settings-panel">
    <summary>{t("宿主机会话操作")}{locale() === "en" ? " " : ""}{session.runtimeSettings?.archived ? t(" · 已归档") : ""}</summary>
    <label>{t("操作")}<select aria-label={t("宿主机会话操作")} value={action} disabled={busy} onChange={(e) => { setAction(e.target.value as NativeOperation); setMessage(""); }}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <p>{descriptions[action]}</p>
    {action === "rename" && <label>{t("新标题")}<input aria-label={t("宿主机会话新标题")} maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></label>}
    {!availability?.allowed && <p>{systemText(availability?.message) || t("此主机尚未报告支持此操作，请更新连接服务。")}</p>}
    <button type="button" className="button button--quiet" disabled={!enabled} onClick={() => void execute()}>{t("确认")}{locale() === "en" ? " " : ""}{labels[action]}</button>
    {message && <p role="status">{systemText(message)}</p>}
  </details>;
}
