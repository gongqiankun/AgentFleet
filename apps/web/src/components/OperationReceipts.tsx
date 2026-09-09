import { t, locale, localized, systemText } from "../i18n";
import { Check, Clock3, AlertTriangle, LoaderCircle } from "lucide-react";
import type { CommandReceipt } from "../lib/types";

export function commandPending(command: CommandReceipt) {
  return ["accepted", "dispatching"].includes(command.state);
}

const commandLabels: Record<string, string> = localized(() => ({
  "thread.delete.preview": t("核验删除范围"), "thread.delete": t("永久删除会话"),
  "thread.terminals.stop": t("停止会话后台终端"),
  "thread.claim": t("接管会话"), "thread.release": t("取消接管"), "turn.start": t("发送消息"),
  "turn.queue": t("排队消息"), "turn.steer": t("追加本轮"), "turn.cancel": t("停止本轮"),
  "thread.rename": t("重命名会话"), "thread.archive": t("宿主机归档"), "thread.unarchive": t("恢复归档"), "thread.fork": t("分支会话"),
  "turn.compact": t("上下文压缩"), "turn.review": t("代码审查"), "input.respond": t("回答问题"),
  "codex.inspect": t("查询 Codex 环境"),
}));

export function receiptStatus(command: CommandReceipt): { label: string; tone: string } {
  if (command.state === "unknown" || command.outcome === "unknown") return { label: t("结果待核验"), tone: "unknown" };
  if (["rejected", "failed", "invalidated", "expired"].includes(command.outcome ?? command.state)) return { label: command.state === "expired" ? t("已过期") : t("未完成"), tone: "failed" };
  if (command.state === "queued") return { label: t("等待上一轮结束"), tone: "pending" };
  if (command.state === "accepted") return { label: command.type === "turn.queue" ? t("等待主机派发") : t("等待主机"), tone: "pending" };
  if (command.state === "dispatching") return { label: command.type === "thread.release" ? t("正在确认释放") : t("主机处理中"), tone: "pending" };
  if (command.type === "thread.release" && command.writerReleased && command.state === "applied") return { label: t("面板写入占用已释放"), tone: "done" };
  if (["succeeded", "success", "applied"].includes(command.outcome ?? "")) return { label: t("主机已确认"), tone: "done" };
  if (command.state === "applied") return { label: t("已收到主机回执"), tone: "done" };
  return { label: t("状态待同步"), tone: "unknown" };
}

export function OperationReceipts({ commands, mode = "all" }: { commands: CommandReceipt[]; mode?: "all" | "outstanding" | "recent" }) {
  if (!commands.length && mode !== "recent") return null;
  const outstanding = commands.filter((command) => command.state === "queued" || commandPending(command) || receiptStatus(command).tone === "unknown");
  const recent = commands.filter((command) => !outstanding.includes(command)).slice(0, 5);
  function receipt(command: CommandReceipt) {
    const status = receiptStatus(command);
    return <li className={`operation-receipt operation-receipt--${status.tone}`} key={command.id}>
      {command.state === "queued" ? <Clock3 size={14} /> : status.tone === "pending" ? <LoaderCircle className="spin" size={14} /> : status.tone === "done" ? <Check size={14} /> : <AlertTriangle size={14} />}
      <div><strong>{commandLabels[command.type] ?? t("会话操作")}<span>{status.label}</span></strong>
        {command.message && <p>{systemText(command.message)}</p>}
        {["turn.compact", "turn.review"].includes(command.type) && status.tone === "done" && <p>{t("这是启动回执；任务结果请查看会话时间线。")}</p>}
        {status.tone === "unknown" && <p>{t("暂不能确认主机结果，系统不会自动重发。")}</p>}
        {command.prompt && <details><summary>{t("查看发送内容")}</summary><p className="operation-prompt">{command.prompt}</p></details>}
        <small><time dateTime={command.createdAt}>{new Date(command.createdAt).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" })}</time> · {command.id}</small>
      </div>
    </li>;
  }
  if (mode === "outstanding" && !outstanding.length) return null;
  return <section className="operation-receipts" aria-label={mode === "recent" ? t("最近操作") : t("操作进度")} aria-live="polite">
    {mode !== "recent" && outstanding.length > 0 && <><h3><Clock3 size={14} />{t("操作进度")}</h3><ol>{outstanding.map(receipt)}</ol></>}
    {mode !== "outstanding" && (recent.length > 0 || mode === "recent") && <details className={`operation-history${mode === "recent" ? " session-config-section" : ""}`}><summary>{mode === "recent" ? <span>{t("最近操作")}<small>{t("最近 {0} 项已完成的操作", recent.length)}</small></span> : <>{t("最近操作 ·")}{locale() === "en" ? " " : ""}{recent.length}</>}</summary>{recent.length ? <ol>{recent.map(receipt)}</ol> : <p>{t("暂无已完成的操作。")}</p>}</details>}
  </section>;
}
