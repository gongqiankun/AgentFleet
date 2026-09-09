import { t, locale, systemText } from "../i18n";
import { AlertTriangle, Check, LoaderCircle, FolderGit2 } from "lucide-react";
import type { DiscoveryProgress } from "../lib/types";

export function DiscoveryStatus({ discovery }: { discovery?: DiscoveryProgress }) {
  return <div className={`discovery-status discovery-status--${discovery?.state ?? "waiting"}`} role="status">
    {discovery?.state === "scanning" ? <LoaderCircle className="spin" size={17} /> : discovery?.state === "error" ? <AlertTriangle size={17} /> : discovery?.state === "ready" ? <Check size={17} /> : <FolderGit2 size={17} />}
    <div><strong>{!discovery ? t("等待主机上报扫描进度") : discovery.state === "scanning" ? t("正在发现 Codex 项目和会话") : discovery.state === "error" ? t("本次扫描未完成") : discovery.discoveredSessions === 0 ? t("扫描完成，未发现已有会话") : t("项目和会话已同步")}</strong>
      {discovery && <span>{t("{0} 个项目 · {1} 个会话", discovery.discoveredProjects, discovery.discoveredSessions)}{discovery.state === "scanning" ? t(" · 已读取 {0} 页", discovery.scannedPages) : ""}</span>}
      {discovery?.error && <p>{systemText(discovery.error)}</p>}
      {!!discovery?.skippedCount && <p>{t("有 {0} 个会话的项目目录已不存在或无法读取，暂未加入可用项目。原始会话不会被删除。", discovery.skippedCount)}</p>}
      {discovery?.lastSuccessfulAt && <small>{t("最近成功同步")}{locale() === "en" ? " " : ""}{new Date(discovery.lastSuccessfulAt).toLocaleString(locale())}</small>}
      {discovery?.state === "ready" && <small>{discovery.syncMode === "events" ? t("事件驱动同步 · 有变化时自动更新，每 5 分钟后台校准。") : discovery.syncMode === "fallback" ? t("文件监听暂不可用 · 已启用定时校准，可手动刷新。") : t("后续变化自动在后台同步，无需重复扫描。")}</small>}
    </div>
  </div>;
}
