import { count, t, locale, systemText } from "../i18n";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { HostOperation, ImageSessionUsage } from "../lib/types";
import { imageSpace } from "../lib/image-space";

export function SessionImageStorage({ machineId }: { machineId: string }) {
  const [rows, setRows] = useState<ImageSessionUsage[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [operations, setOperations] = useState<Record<string, HostOperation>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sort, setSort] = useState("cloud");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setSelected([]); setConfirm(false);
    void (async () => {
      try {
        const all: ImageSessionUsage[] = []; let cursor = ""; const seen = new Set<string>();
        do {
          const result = await api.imageSessions(machineId, cursor, controller.signal);
          all.push(...result.sessions); cursor = result.nextCursor ?? "";
          if (cursor && seen.has(cursor)) throw new Error(t("会话分页未完成，请刷新后重试"));
          seen.add(cursor);
        } while (cursor && !controller.signal.aborted);
        if (!controller.signal.aborted) { setRows(all); setPage(0); }
      } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [machineId, revision]);
  const filtered = rows.filter(row => `${row.title} ${row.project}`.toLowerCase().includes(query.toLowerCase())).sort((a,b) => sort === "name" ? a.title.localeCompare(b.title) : sort === "history" ? Number(operations[b.logicalSessionId]?.result?.rolloutBytes ?? -1) - Number(operations[a.logicalSessionId]?.result?.rolloutBytes ?? -1) : b.cloudBytes - a.cloudBytes);
  const eligible = selected.filter(id => operations[id]?.type === "images.preview" && operations[id]?.state === "succeeded" && !errors[id]);
  async function run(clean: boolean) {
    setBusy(true); setConfirm(false); setError("");
    const targets = clean ? eligible : [...selected];
    for (const id of targets) {
      setErrors(previous => ({...previous, [id]: ""}));
      try {
        let operation = await api.imageOperation(machineId, id, clean ? operations[id]!.id : undefined);
        setOperations(previous => ({...previous, [id]: operation}));
        const deadline = Date.now() + 305_000;
        while (["accepted", "running"].includes(operation.state) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          operation = await api.readImageOperation(operation.id);
          setOperations(previous => ({...previous, [id]: operation}));
        }
        if (operation.state !== "succeeded") throw new Error(operation.error?.message ?? t("结果待核验；不会自动重试。可在主机操作记录查看回执。"));
      } catch (reason) { setErrors(previous => ({...previous, [id]: (reason as Error).message})); }
    }
    setBusy(false);
  }
  return <section className="host-image-storage session-image-storage" aria-label={t("按会话清理图片")}>
    <header><div><h2>{t("按会话清理图片")}</h2><p>{t("清理面板上传的图片，保留文字、会话名称和原生会话 ID。")}</p></div><button className="button button--quiet" disabled={busy || loading} onClick={() => setRevision(r => r + 1)}>{t("刷新列表")}</button></header>
    <p className="subtle">{t("先预览宿主机，再确认清理两端。当前支持 Linux、Codex 0.153.4 和 Python 3；其他格式或缺少发送记录会显示原因。原图移除后无法恢复图片内容。")}</p>
    <div className="session-image-storage__tools"><input aria-label={t("搜索有图会话")} placeholder={t("搜索会话或项目")} value={query} onChange={e => { setQuery(e.target.value); setPage(0); }} />
      <select aria-label={t("会话图片排序")} value={sort} onChange={e => { setSort(e.target.value); setPage(0); }}><option value="cloud">{t("云端占用从大到小")}</option><option value="history">{t("历史大小从大到小（已核验）")}</option><option value="name">{t("会话名称")}</option></select>
      <button className="button button--quiet" disabled={busy || loading || !!error} onClick={() => { setSelected(filtered.map(row => row.logicalSessionId)); setConfirm(false); }}>{t("选择全部匹配会话（{0}）", filtered.length)}</button>
      <button className="button button--quiet" disabled={busy} onClick={() => { setSelected([]); setConfirm(false); }}>{t("清空选择")}</button></div>
    {loading ? <p role="status">{t("正在读取全部有图会话…")}</p> : <>
      <div className="session-image-storage__list">{filtered.slice(page * 10, page * 10 + 10).map(row => {
        const operation = operations[row.logicalSessionId]; const result = operation?.result;
        const usage = result?.tokenUsage as {last_token_usage?: {input_tokens?: number; output_tokens?: number; cached_input_tokens?: number}} | undefined;
        return <article key={row.logicalSessionId}>
          <label><input type="checkbox" aria-label={t("选择 {0}", row.title)} checked={selected.includes(row.logicalSessionId)} disabled={busy} onChange={e => { setSelected(ids => e.target.checked ? [...ids, row.logicalSessionId] : ids.filter(id => id !== row.logicalSessionId)); setConfirm(false); }} /><span><strong>{row.title}</strong><small>{row.project}</small></span></label>
          <div className="session-image-storage__metrics"><span>{row.imageCount} {locale() === "en" ? " " : ""}{t("张 · 云端引用")}{locale() === "en" ? " " : ""}{imageSpace(row.cloudBytes)}</span><span>{t("历史文件：")}{locale() === "en" ? " " : ""}{typeof result?.rolloutBytes === "number" ? imageSpace(result.rolloutBytes) : t("预览后核验")}</span>
            {typeof result?.imageContentBytes === "number" && <small>{t("此次图片内容：")}{locale() === "en" ? " " : ""}{imageSpace(result.imageContentBytes)}{locale() === "en" ? " " : ""}{t("（含历史重复副本）")}</small>}
            {usage?.last_token_usage && <small>{t("最近原生用量：输入")}{locale() === "en" ? " " : ""}{usage.last_token_usage.input_tokens ?? t("未知")} {locale() === "en" ? " " : ""}{t("/ 输出")}{locale() === "en" ? " " : ""}{usage.last_token_usage.output_tokens ?? t("未知")} {locale() === "en" ? " " : ""}{t("token（历史报告）")}</small>}
            {typeof result?.measuredAt === "string" && <small>{t("核验于")}{locale() === "en" ? " " : ""}{new Date(result.measuredAt).toLocaleString(locale())}</small>}</div>
          {errors[row.logicalSessionId] ? <p role="alert">{systemText(errors[row.logicalSessionId])}</p> : operation && <p role="status">{operation.state === "succeeded" ? operation.type === "images.clean" && result?.cloudCleaned === true ? t("两端图片已清理，云端实际释放 {0}；文字和会话 ID 保留。", imageSpace(Number(result.releasedCloudBytes ?? 0))) : t("预览完成，可确认清理。") : ["accepted", "running"].includes(operation.state) ? t("等待宿主机核验…") : systemText(operation.error?.message) || t("结果待核验")}</p>}
        </article>;
      })}</div>
      {!filtered.length && <p>{t("没有匹配的有图会话。")}</p>}
      {filtered.length > 10 && <div className="session-image-storage__tools"><button disabled={page === 0 || busy} onClick={() => setPage(p => p - 1)}>{t("上一页")}</button><span>{page + 1} / {Math.ceil(filtered.length / 10)}</span><button disabled={(page + 1) * 10 >= filtered.length || busy} onClick={() => setPage(p => p + 1)}>{t("下一页")}</button></div>}
    </>}
    <p className="subtle">{t("共享图片在未选会话中保留，因此各会话云端引用之和可能大于主机配额用量。为保证恢复安全，首版保留历史文件的字节位置，清理图片内容后文件大小不会立即缩小。历史文件大小不等于 token 消耗。")}</p>
    <div className="session-image-storage__tools"><span>{t("已选")}{locale() === "en" ? " " : ""}{count(selected.length, "个会话")} </span><button className="button button--quiet" disabled={busy || loading || !selected.length} onClick={() => void run(false)}>{busy ? t("处理中…") : t("预览所选会话")}</button><button className="button button--danger" disabled={busy || !eligible.length} onClick={() => setConfirm(true)}>{t("清理已通过预览的 {0} 个会话", eligible.length)}</button></div>
    {confirm && <div className="host-image-storage__confirm" role="group" aria-label={t("确认两端图片清理")}><h3>{t("确认清理 {0} 个会话的图片？", eligible.length)}</h3><p>{t("将移除所选范围的宿主机原生历史图片及云端图片引用。文字、会话 ID 和未选会话保留；图片内容不可恢复。无法核验的会话跳过，断线不会自动重试。")}</p><button className="button button--quiet" onClick={() => setConfirm(false)}>{t("取消")}</button><button className="button button--danger" onClick={() => void run(true)}>{t("确认清理两端图片")}</button></div>}
    {error && <p role="alert">{systemText(error)}</p>}
  </section>;
}
