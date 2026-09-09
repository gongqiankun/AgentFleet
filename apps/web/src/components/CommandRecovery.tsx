import { t, systemText } from "../i18n";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { HostOperation } from "../lib/types";

export function CommandRecovery({ machineId, online, supported, onChanged }: {
  machineId: string; online: boolean; supported: boolean; onChanged: () => void;
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
            setMessage(current.state === "succeeded" ? t("已读取主机回执并刷新结果。仍待核验的操作缺少明确证据，请继续在主机检查。") : current.error?.message ?? t("核验暂未完成，可以稍后重新查询；原命令没有重发。"));
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
      try { setOperation(await api.hostOperation(machineId, "commands.reconcile", crypto.randomUUID())); }
      catch (error) { setMessage(error instanceof Error ? error.message : t("核验请求失败")); }
      finally { setSubmitting(false); }
    }}>{submitting || pending ? t("正在核验主机回执…") : t("核验主机回执")}</button>
    <p>{!supported ? t("请先更新主机连接服务以使用回执核验。") : !online ? t("等待主机在线后核验。") : t("查询此主机最多 20 条待确认操作的持久记录，不会重新执行原命令。")}</p>
    {message && <p role="status">{systemText(message)}</p>}
  </div>;
}
