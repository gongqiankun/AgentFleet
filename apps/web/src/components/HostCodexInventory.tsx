import { t, locale } from "../i18n";
import type { Machine } from "../lib/types";

export function HostCodexInventory({ machine }: { machine: Machine }) {
  const profile = machine.codexProfile;
  const text = (key: string) => typeof profile?.[key] === "string" ? profile[key] as string : undefined;
  const detected = text("hostCodexDetection") === "highest-detected";
  const version = text("hostCodexVersion");
  const checkedAt = text("hostCodexCheckedAt");
  const defaultVersion = text("hostCodexDefaultVersion");
  const recorded = text("hostCodexVersionSource") === "package-record";
  return <section aria-label={t("自装 Codex 检测")}>
    <dl><div><dt>{detected ? t("检测到的自装 Codex") : t("服务 PATH 中的 Codex")}</dt><dd>{version ?? (text("hostCodexPath") ? t("已找到安装，版本未识别") : t("尚未检测到"))}</dd></div></dl>
    {recorded && <p className="host-help">{t("版本来源：安装包记录，未启动自装程序核验。面板实际运行版本以「面板使用的 Codex」为准。")}</p>}
    {text("hostCodexVersionSource") === "command" && <p className="host-help">{t("版本来源：已执行程序版本查询。")}</p>}
    <p className="host-help">{detected ? t("展示常见安装位置中检测到的最高稳定版本，不代表终端当前选用的版本，也不会切换面板运行时。") : t("此版本来自连接服务的程序搜索路径，可能与终端不同；更新连接服务后支持多安装位置检测。")}</p>
    {text("hostCodexPath") && <p className="host-help">{t("检测路径：")}<code>{text("hostCodexPath")}</code></p>}
    {recorded && text("hostCodexMetadataPath") && <p className="host-help">{t("安装记录：")}<code>{text("hostCodexMetadataPath")}</code></p>}
    {defaultVersion && defaultVersion !== version && <p className="host-help">{t("另有旧安装：服务 PATH 默认 Codex")}{locale() === "en" ? " " : ""}{defaultVersion}（{text("hostCodexDefaultPath")}{locale() === "en" ? " " : ""}{t("）。终端可能使用不同路径。")}</p>}
    {checkedAt && Number.isFinite(Date.parse(checkedAt)) && <p className="host-help">{t("最近检测：")}{locale() === "en" ? " " : ""}{new Date(checkedAt).toLocaleString(locale())}{locale() === "en" ? " " : ""}{t("。在线时约每 5 分钟自动检测，也可点击「检查连接」立即检测。")}</p>}
  </section>;
}
