import { t } from "../i18n";
import { ChevronDown, ChevronUp, Maximize2, Minimize2, TerminalSquare } from "lucide-react";
import { useId, useState } from "react";
import { useFollowScroll } from "../lib/follow-scroll";

/** Viewing output never executes or replays a command. Keep the log mounted while resizing. */
export function CommandExecution({ command, output }: { command?: string | null; output?: string | null }) {
  if (!command && !output) return null;
  return <ExecutionCard command={command} output={output} />;
}

function ExecutionCard({ command, output }: { command?: string | null; output?: string | null }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const outputId = useId();
  const scroll = useFollowScroll(JSON.stringify([command, output]));
  return <section className={`command-execution${expanded ? " command-execution--expanded" : ""}`} aria-label={t("命令执行记录")}>
    <header className="command-execution__header">
      <span><TerminalSquare size={15} aria-hidden="true" />{command ? t("命令执行") : t("执行输出")}</span>
      <div className="command-execution__actions">
      {open && !scroll.following && <button type="button" onClick={scroll.jumpToLatest}>{scroll.hasNewContent ? t("新输出 ↓") : t("最新输出 ↓")}</button>}
      {open && <button type="button" aria-expanded={expanded} aria-controls={outputId} onClick={() => setExpanded(value => !value)}>
        {expanded ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}{expanded ? t("恢复高度") : t("放大输出")}
      </button>}
      <button type="button" aria-expanded={open} aria-controls={outputId} onClick={() => setOpen(value => !value)}>
        {open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}{open ? t("收起代码") : t("展开代码")}
      </button>
      </div>
    </header>
    <div id={outputId} hidden={!open} className="command-execution__log" ref={scroll.viewport} onScroll={scroll.onScroll} onWheel={event => { if (event.deltaY < 0) scroll.pause(); }} role="region" aria-label={t("命令与输出内容")} tabIndex={0}>
      <div ref={scroll.content}>
      {command && <pre className="command-block"><span aria-hidden="true">$ </span>{command}</pre>}
      {output && <pre className="output-block">{output}</pre>}
      </div>
    </div>
  </section>;
}
