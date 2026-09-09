import { t, systemText } from "../i18n";
import { useState } from "react";
import { Terminal } from "lucide-react";
import { codexCommands, coverageLabels } from "../lib/codex-commands";
import { HostDisclosure } from "./HostDisclosure";
export function CodexCommandGuide({ spacious = false }: { spacious?: boolean }) {
  const [search, setSearch] = useState("");
  const visible = codexCommands.filter(c => `${c.name} ${c.label} ${c.note}`.toLowerCase().includes(search.toLowerCase()));
  const content = <>
    <p>{t("菜单已登记不代表功能已完整实现。部分支持项列出具体差异，主机最终能力以实际回执为准。")}</p>
    <label>{t("查找")}<input aria-label={t("查找 Codex 命令")} value={search} onChange={e=>setSearch(e.target.value)} placeholder={t("命令、功能或限制")} /></label>
    <ul>{visible.map(c=><li key={c.name}><strong><code>/{c.name}</code><span>{coverageLabels[c.coverage]}</span></strong><p>{c.label} · {systemText(c.note)}</p></li>)}</ul>
    {visible.length === 0 && <p role="status">{t("没有找到匹配的命令，试试其他关键词。")}</p>}
  </>;
  return spacious ? <HostDisclosure className="codex-command-guide" title={t("全部 / 命令 · 支持范围")} description={t("查找命令，了解面板已支持的操作和限制")} icon={<Terminal size={21} />}>{content}</HostDisclosure>
    : <details className="codex-settings-panel codex-command-guide"><summary>{t("全部 / 命令 · 支持范围")}</summary>{content}</details>;
}
