import { memo, useMemo, useState } from "react";
import { Copy, Check } from "lucide-react";
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import stripAnsi from "strip-ansi";
import type { RootContent } from "hast";
import { t, useLocale } from "../i18n";

const syntax = createLowlight({ bash, json });
function nodes(items: RootContent[]): React.ReactNode {
  return items.map((node, i) => node.type === "text" ? node.value : node.type === "element" ? <span key={i} className={Array.isArray(node.properties.className) ? node.properties.className.join(" ") : undefined}>{nodes(node.children)}</span> : null);
}
export const ExecutionCode = memo(function ExecutionCode({ text, command = false }: { text: string; command?: boolean }) {
  useLocale();
  const clean = useMemo(() => stripAnsi(text), [text]);
  const highlighted = useMemo(() => {
    if (clean.length > 32_000) return clean;
    let language = command ? "bash" : undefined;
    if (!command && /^[\s]*[\[{]/.test(clean)) { try { JSON.parse(clean); language = "json"; } catch { /* Partial output remains literal. */ } }
    try { return language ? nodes(syntax.highlight(language, clean).children) : clean; } catch { return clean; }
  }, [clean, command]);
  const [copied, setCopied] = useState<string>();
  const [failed, setFailed] = useState(false);
  async function copy() { try { await navigator.clipboard.writeText(clean); setCopied(clean); setFailed(false); } catch { setFailed(true); } }
  return <div className="execution-code">
    <div className="execution-code__label"><span>{command ? "Shell" : t("输出")}</span><button type="button" onClick={() => void copy()} aria-label={command ? t("复制命令") : t("复制输出")}>{copied === clean ? <Check size={14} /> : <Copy size={14} />}<span>{copied === clean ? t("已复制") : t("复制")}</span></button></div>
    {failed && <div role="status" className="execution-code__notice">{t("复制失败，请手动选择代码复制。")}</div>}
    <pre className={command ? "command-block" : "output-block"}>{command && <span className="execution-code__prompt" aria-hidden="true">$ </span>}<code>{highlighted}</code></pre>
  </div>;
});
