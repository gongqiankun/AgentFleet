import { t, locale, localized, systemText } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { CommandReceipt, FleetSession } from "../lib/types";
const sections: Record<string, string> = localized(() => ({ account: t("账号"), usage: t("用量窗口"), config: t("配置来源"), skills: t("技能"), mcp: "MCP", apps: t("应用"), plugins: t("已安装插件"), hooks: t("钩子"), terminals: t("后台终端"), goal: t("任务目标（只读）"), permissions: t("权限档案（只读）"), experimental: t("实验功能（只读）") }));
export function CodexInspectionPanel({ session, commands, request, onChanged }: { session: FleetSession; commands: CommandReceipt[]; request?: { section: string; nonce: number }; onChanged: () => void }) {
  const panel = useRef<HTMLDetailsElement>(null);
  const [section, setSection] = useState("config");
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  useEffect(() => { if (request) { setSection(request.section); if (panel.current) panel.current.open = true; } }, [request]);
  const snapshot = commands.find((c) => c.type === "codex.inspect" && c.inspection && c.outcome === "succeeded")?.inspection;
  const data = snapshot?.sections[section];
  const pending = commands.some((c) => c.type === "codex.inspect" && ["accepted", "dispatching"].includes(c.state));
  async function refresh() {
    if (busy || pending || !session.actions?.inspect?.allowed) return;
    setBusy(true); setMessage("");
    try { await api.command(session.id, { type: "codex.inspect", clientMutationId: crypto.randomUUID(), payload: {}, precondition: { executionSegmentId: session.executionSegmentId, projectLeaseVersion: session.projectLeaseVersion } }); setMessage(t("正在向宿主机读取，结果将自动显示。")); onChanged(); }
    catch (e) { setMessage(e instanceof Error ? e.message : t("读取失败")); }
    finally { setBusy(false); }
  }
  return <details ref={panel} className="codex-settings-panel codex-inspection-panel">
    <summary>{t("Codex 环境与集成 · 只读")}</summary>
    <p>{t("查询这台主机、当前项目目录下的环境。不会安装插件、修改配置或重新登录。")}</p>
    <label>{t("查看")}<select aria-label={t("Codex 环境分类")} value={section} onChange={(e) => setSection(e.target.value)}>{Object.entries(sections).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <button type="button" className="button button--quiet" disabled={busy || pending || !session.actions?.inspect?.allowed} onClick={() => void refresh()}>{busy || pending ? t("正在读取…") : t("从宿主机读取")}</button>
    {!session.actions?.inspect?.allowed && <p>{session.actions?.inspect?.message ?? t("此主机尚未报告查询能力，请更新连接服务。")}</p>}
    {snapshot && <p>{t("读取于")}{locale() === "en" ? " " : ""}{new Date(snapshot.observedAt).toLocaleString(locale())} · {snapshot.cwd}</p>}
    {data ? !data.available ? <p>{t("此项读取失败或当前 Codex 不支持（")}{locale() === "en" ? " " : ""}{data.errorCode}{locale() === "en" ? " " : ""}{t("）。不会将读取失败显示为“未安装”。")}</p> : <>
      {data.rows.length ? <dl>{data.rows.map((row, i) => <div key={i}><dt>{row.name}<small>{systemText(row.status)}</small></dt><dd>{row.detail}</dd></div>)}</dl> : <p>{t("本次查询没有返回条目。")}</p>}
      {data.truncated && <p>{t("结果较多，仅显示部分条目，不代表完整清单。")}</p>}
    </> : <p>{t("尚无这类环境快照，请读取宿主机。")}</p>}
    {section === "config" && <p>{t("这是目录配置来源，不是某一历史轮次的实际模型；面板的会话覆盖单独保存在运行配置中。")}</p>}
    {section === "mcp" && <p>{t("MCP 连接状态由当前 App Server 报告，不代表其他终端进程的连接。")}</p>}
    {section === "terminals" && <p>{t("仅列出当前 App Server 中属于此会话的后台终端；不是系统进程列表。此接口未返回历史输出，输出请看已同步的时间线。可通过 /stop 确认停止。")}</p>}
    {section === "goal" && <p>{t("这里只读取现有目标，不创建或自动续跑任务。目标设置、暂停、恢复仍待接入。")}</p>}
    {section === "permissions" && <p>{t("这里只显示原生权限档案。面板任务使用「执行权限」中的主机、项目、会话继承配置，不会仅因检测到本机档案而自动扩大权限。")}</p>}
    {section === "experimental" && <p>{t("这里只读取运行时功能状态，不切换开关或改写宿主机配置文件。")}</p>}
    {message && <p role="status">{systemText(message)}</p>}
  </details>;
}
