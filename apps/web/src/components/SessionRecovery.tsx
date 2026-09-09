import { t, systemText } from "../i18n";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { HostOperation } from "../lib/types";

export function SessionRecovery({ machineId, sessionId, online, supported, onChanged }: {
  machineId: string; sessionId: string; online: boolean; supported: boolean; onChanged: () => void;
}) {
  const [operation, setOperation] = useState<HostOperation>();
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const pending = operation && ["accepted", "running"].includes(operation.state);
  useEffect(() => {
    if (!pending) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const operations = await api.hostOperations(machineId, controller.signal);
        if (controller.signal.aborted) return;
        const current = operations.find(item => item.id === operation.id);
        if (current) {
          setOperation(current);
          if (!["accepted", "running"].includes(current.state)) {
            setMessage(current.state === "succeeded" ? String(current.result?.reason ?? t("核验完成，正在同步会话状态；若仍冻结，请稍后刷新查看。")) : current.error?.message ?? t("核验暂未完成，可以稍后重新查询；原命令没有重发。"));
            onChanged();
            return;
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : t("暂时无法读取核验进度"));
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [pending, operation?.id, machineId, onChanged]);
  return <div className="command-recovery">
    <button type="button" className="button button--quiet" disabled={!online || !supported || submitting || Boolean(pending)} onClick={async () => {
      setSubmitting(true); setMessage("");
      try { setOperation(await api.hostOperation(machineId, "session.reconcile", crypto.randomUUID(), sessionId)); }
      catch (error) { setMessage(error instanceof Error ? error.message : t("核验请求失败")); }
      finally { setSubmitting(false); }
    }}>{submitting || pending ? t("正在核验…") : t("解除冻结")}</button>
    <p>{!supported ? t("请先在主机页面检查更新，以支持解除冻结。") : !online ? t("等待主机在线后核验。") : t("核验主机保存的执行结果，确认结束或中断后解除冻结，不会重发原命令。")}</p>
    {message && <p role="status">{systemText(message)}</p>}
  </div>;
}
