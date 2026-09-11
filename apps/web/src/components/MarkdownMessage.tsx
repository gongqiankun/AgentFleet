import { Children, isValidElement, memo, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";
import { t, useLocale } from "../i18n";
import "./markdown-message.css";

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const temporary = document.createElement("textarea");
  temporary.value = text;
  temporary.setAttribute("readonly", "");
  temporary.style.position = "fixed";
  temporary.style.opacity = "0";
  document.body.appendChild(temporary);
  temporary.select();
  const copied = document.execCommand("copy");
  temporary.remove();
  if (!copied) throw new Error("copy failed");
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find(child => isValidElement(child));
  const props = isValidElement<{ children?: ReactNode; className?: string }>(code) ? code.props : {};
  const text = typeof props.children === "string" ? props.children : "";
  const language = /language-([^\s]+)/.exec(props.className ?? "")?.[1];
  const [copiedText, setCopiedText] = useState<string>();
  const [failed, setFailed] = useState(false);
  const copied = copiedText === text;
  async function copy() {
    try { await copyText(text); setCopiedText(text); setFailed(false); }
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
  const [copiedText, setCopiedText] = useState<string>();
  const [failed, setFailed] = useState(false);
  const copied = copiedText === body;
  async function copyReply() {
    try { await copyText(body); setCopiedText(body); setFailed(false); }
    catch { setFailed(true); }
  }
  return <div className="message-markdown">
    <div className="message-markdown__body"><Markdown remarkPlugins={[remarkGfm]} components={components} skipHtml>{body}</Markdown></div>
    <div className="message-markdown__actions">
      <button type="button" onClick={() => void copyReply()} aria-label={copied ? t("回复已复制") : t("复制回复")}>
        {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? t("已复制") : t("复制回复")}
      </button>
      {failed && <span role="status">{t("复制失败，请手动选择回复内容。")}</span>}
    </div>
  </div>;
});
