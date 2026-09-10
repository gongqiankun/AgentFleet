import { Children, isValidElement, memo, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";
import { t, useLocale } from "../i18n";
import "./markdown-message.css";

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find(child => isValidElement(child));
  const props = isValidElement<{ children?: ReactNode; className?: string }>(code) ? code.props : {};
  const text = typeof props.children === "string" ? props.children : "";
  const language = /language-([^\s]+)/.exec(props.className ?? "")?.[1];
  const [copiedText, setCopiedText] = useState<string>();
  const [failed, setFailed] = useState(false);
  const copied = copiedText === text;
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopiedText(text); setFailed(false); }
    catch { setFailed(true); }
  }
  return <div className="markdown-code">
    <div className="markdown-code__header"><span>{language || t("代码")}</span><button type="button" onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? t("已复制") : t("复制代码")}</button></div>
    {failed && <span className="markdown-code__notice" role="status">{t("复制失败，请手动选择代码复制。")}</span>}
    <pre tabIndex={0} aria-label={t("代码")}>{children}</pre>
  </div>;
}

const components: Components = {
  pre: CodeBlock,
  table: ({ children }) => <div className="markdown-table" role="region" aria-label={t("表格")} tabIndex={0}><table>{children}</table></div>,
  a: ({ node: _node, href, children, ...props }) => href ? <a {...props} href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
  img: ({ src, alt }) => src ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || t("查看图片")}</a> : <span>{alt}</span>,
};

/** Parse assistant prose only; raw view and execution logs retain their original bytes. */
export const MarkdownMessage = memo(function MarkdownMessage({ body }: { body: string }) {
  useLocale();
  return <div className="message-markdown"><Markdown remarkPlugins={[remarkGfm]} components={components} skipHtml>{body}</Markdown></div>;
});
