import { t, locale, localized, systemText } from "../i18n";
import { AlertTriangle, Check, Circle, LoaderCircle } from "lucide-react";
import type { DiscoveryProgress, MaintenanceType } from "../lib/types";

const titles: Record<string, string> = localized(() => ({ environment: t("连接服务环境"), runtime: t("面板 Codex"), protocol: t("接口适配"), data: t("原有 Codex 数据"), sandbox: t("工作目录写入隔离"), tools: t("开发工具执行"), server: t("会话服务"), catalog: t("项目与会话扫描") }));
const actions: Record<MaintenanceType, string> = localized(() => ({ "images.preview": t("预览会话图片"), "images.clean": t("清理会话图片"), "commands.reconcile": t("核验主机回执"), "session.reconcile": t("解除冻结"), "agent.update": t("检查并更新"), "runtime.reconnect": t("重新连接 Codex"), "catalog.refresh": t("重新扫描"), "diagnostics.collect": t("重新自检") }));
export function HostReadiness({ discovery, online, onAction, disabled, capabilities }: { discovery?: DiscoveryProgress; online: boolean; onAction?: (type: MaintenanceType) => void; disabled?: boolean; capabilities?: string[] }) {
  const checks = discovery?.checks ?? [];
  const failed = checks.some(item => item.state === "failed");
  const title = !online ? t("等待主机连接") : failed || discovery?.readiness === "action_required" ? t("已连接，需要处理以下问题") : discovery?.readiness === "ready" ? t("接入自检通过") : discovery?.readiness === "read_only" ? t("已连接，当前仅可查看") : t("正在确认是否可用");
  return <section className="host-readiness" aria-label={t("接入自检")}><header><div><span className="host-readiness__label">{t("接入自检")}</span><h3>{title}</h3></div>{onAction && <button type="button" className="button button--quiet" disabled={disabled || !online || !capabilities?.includes("diagnostics.collect")} onClick={() => onAction("diagnostics.collect")}>{t("重新自检")}</button>}</header>
    <p>{!online ? t("以下是主机最近上报的结果，不代表当前在线。") : t("分别检查连接服务、面板运行环境和原有会话。自装 Codex 的识别结果不影响托管运行环境。")}</p>
    {checks.length === 0 ? <p>{t("尚未收到详细自检结果。旧版连接服务请先「检查并更新」，无需删除主机或重新配对。")}</p> : <ul>{checks.map(item => <li key={item.id} data-state={item.state}>
      {item.state === "passed" ? <Check size={18} /> : item.state === "failed" ? <AlertTriangle size={18} /> : item.state === "checking" && online ? <LoaderCircle className="spin" size={18} /> : <Circle size={18} />}
      <div><strong>{titles[item.id] ?? item.id}<span>{item.state === "passed" ? t("已通过") : item.state === "failed" ? t("需处理") : item.state === "checking" ? t("检查中") : t("待检查")}</span></strong><p>{systemText(item.message)}</p>{item.state === "failed" && <small>{item.code}</small>}</div>
      {item.state === "failed" && item.action && onAction && <button type="button" className="button button--quiet" disabled={disabled || !online || !capabilities?.includes(item.action)} onClick={() => onAction(item.action!)}>{actions[item.action]}</button>}
    </li>)}</ul>}
    {checks[0]?.checkedAt && <small>{t("环境检查时间")}{locale() === "en" ? " " : ""}{new Date(checks[0].checkedAt).toLocaleString(locale())}</small>}
  </section>;
}
