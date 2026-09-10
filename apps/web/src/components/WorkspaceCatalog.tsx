import { UsageButton } from "./UsageButton";
import { t, locale, systemText } from "../i18n";
import { ChevronLeft, ChevronRight, FolderGit2, LoaderCircle, Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { FleetSession, Page, Project } from "../lib/types";

function SessionRows({ sessions, selectedId, onSelect }: { sessions: FleetSession[]; selectedId?: string; onSelect: (id: string) => void }) {
  return <div className="session-list">{sessions.map((session) => <button type="button" key={session.id} className={`session-row${selectedId === session.id ? " session-row--active" : ""}`} onClick={() => onSelect(session.id)}>
    <div className="session-row__top"><strong>{session.title}</strong><span className="session-time">{new Date(session.lastActivityAt).toLocaleDateString(locale(), { month: "numeric", day: "numeric" })}</span></div>
    <div className="session-row__meta"><span>{session.machineName} · {session.projectAlias}</span></div>
    <div className="session-row__bottom"><span className="state-pill">{session.state.unknownFreeze ? t("结果待核验") : session.state.reachability !== "live" ? t("离线") : session.state.waitReason === "approval" ? t("等待确认") : session.state.waitReason === "user_input" ? t("等待回答") : session.state.currentTurn === "in_progress" ? t("正在执行") : t("空闲")}</span><span className="history-mark">{session.state.history === "complete" ? t("完整历史") : session.state.history === "partial" ? t("部分历史") : t("历史摘要")}</span><span className="session-row__tokens" title={t("总消耗 {0} tokens",session.recordedTokens==null?"—":new Intl.NumberFormat(locale()).format(session.recordedTokens))+" · "+t("本周消耗 {0} tokens",session.weeklyTokens==null?"—":new Intl.NumberFormat(locale()).format(session.weeklyTokens))+(session.weeklyBoundaryIncomplete?" · "+t("跨越重置时刻且无法精确拆分的用量未计入本轮。"):"")}>{t("总消耗 {0} tokens",session.recordedTokens==null?"—":new Intl.NumberFormat(locale(),{notation:"compact",maximumFractionDigits:1}).format(session.recordedTokens))}{" · "}{t("本周消耗 {0} tokens",session.weeklyTokens==null?"—":new Intl.NumberFormat(locale(),{notation:"compact",maximumFractionDigits:1}).format(session.weeklyTokens))}{session.weeklyBoundaryIncomplete?" *":""}</span></div>
  </button>)}</div>;
}

function ProjectGroup({ project, expanded, selectedId, refreshKey, onToggle, onSelect, onCreate }: { project: Project; expanded: boolean; selectedId?: string; refreshKey: string; onToggle: () => void; onSelect: (id: string) => void; onCreate: (project: Project) => void }) {
  const [page, setPage] = useState<Page<FleetSession>>({ items: [], nextCursor: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [pageCount, setPageCount] = useState(1);
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    setLoading(true);
    // Refresh the whole loaded window atomically, not just its first 30 rows.
    // Aborted requests never replace rows, cursors or the latest loading state.
    void (async () => {
      const items = new Map<string, FleetSession>();
      let cursor: string | null = null;
      for (let index = 0; index < pageCount; index += 1) {
        const next = await api.sessions({ projectId: project.id, limit: 30, ...(cursor ? { cursor } : {}) }, controller.signal);
        if (controller.signal.aborted) return;
        for (const item of next.items) items.set(item.id, item);
        cursor = next.nextCursor;
        if (!cursor) break;
      }
      setPage({ items: [...items.values()], nextCursor: cursor });
      setLoaded(true); setError("");
    })().catch((reason) => { if (!controller.signal.aborted) setError(reason.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [project.id, expanded, refreshKey, retry, pageCount]);
  return <section className="project-session-group" aria-busy={loading}>
    <div className="catalog-project-heading"><button className="project-session-group__heading" type="button" aria-expanded={expanded} onClick={onToggle}><FolderGit2 size={16} /><span className="project-session-group__copy"><strong>{project.alias}</strong><span>{project.pathHint}</span></span><ChevronRight className={expanded ? "catalog-expanded" : ""} size={17} /></button><button type="button" className="icon-button" aria-label={t("在 {0} 新建会话", project.alias)} onClick={() => onCreate(project)}><Plus size={15} /></button></div>
    <div className="project-usage"><UsageButton scope="project" id={project.id} onSession={onSelect}/></div>
    {expanded && <>{error && <p className="catalog-error" role="alert">{systemText(error)}<button type="button" onClick={() => setRetry((value) => value + 1)}>{t("重试")}</button></p>}<SessionRows sessions={page.items} selectedId={selectedId} onSelect={onSelect} />{loading && !loaded ? <div className="catalog-loading"><LoaderCircle className="spin" size={16} />{t("正在读取会话")}</div> : loaded && page.items.length === 0 && !error ? <p className="catalog-empty">{t("此项目还没有会话，可以点击右侧 + 新建。")}</p> : null}{page.nextCursor && <button className="catalog-more" type="button" disabled={loading} onClick={() => setPageCount((count) => count + 1)}>{t("加载更多会话")}</button>}</>}
  </section>;
}

export function WorkspaceCatalog({ machineId, selectedSession, refreshKey, onSelect, onCreate }: { machineId?: string; selectedSession?: FleetSession; refreshKey: string; onSelect: (id: string) => void; onCreate: (project?: Project) => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const [projects, setProjects] = useState<Page<Project>>({ items: [], nextCursor: null });
  const [matches, setMatches] = useState<Page<FleetSession>>({ items: [], nextCursor: null });
  const [expanded, setExpanded] = useState(new Set<string>());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [loadedKey, setLoadedKey] = useState<string>();
  const scopeKey = JSON.stringify([machineId, query, filter, cursor]);
  const loaded = loadedKey === scopeKey;
  const searching = Boolean(query.trim() || filter);
  useEffect(() => { setCursor(null); setPrevious([]); setExpanded(new Set()); setQuery(""); setFilter(""); }, [machineId]);
  useEffect(() => { if (selectedSession) setExpanded((current) => new Set([...current, selectedSession.projectId])); }, [selectedSession?.id]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        if (searching) { const next = await api.sessions({ machineId, q: query.trim(), executionState: filter || undefined, cursor, limit: 30 }, controller.signal); if (!controller.signal.aborted) setMatches(next); }
        else { const next = await api.projects({ machineId, cursor, limit: 8 }, controller.signal); if (!controller.signal.aborted) setProjects(next); }
        if (!controller.signal.aborted) { setLoadedKey(scopeKey); setError(""); }
      } catch (reason) { if (!controller.signal.aborted) setError((reason as Error).message); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, query ? 200 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [machineId, query, filter, cursor, refreshKey, retry, scopeKey]);
  const nextCursor = searching ? matches.nextCursor : projects.nextCursor;
  const visibleProjects = [...projects.items];
  if (selectedSession && selectedSession.machineId === machineId && !visibleProjects.some((project) => project.id === selectedSession.projectId)) visibleProjects.unshift({ id: selectedSession.projectId, machineId, alias: selectedSession.projectAlias, pathHint: t("当前打开的会话项目"), syncContent: true, retentionDays: 7 });
  return <section className="session-list-panel workspace-catalog" aria-busy={loading}>
    <div className="section-heading"><div><div className="eyebrow">{t("当前主机")}</div><h2>{t("项目与会话")}</h2></div><button type="button" className="button button--quiet" onClick={() => onCreate()}><Plus size={15} />{t("新会话")}</button></div>
    <div className="catalog-search"><label><Search size={15} /><input aria-label={t("搜索项目或会话")} placeholder={t("搜索项目或会话…")} value={query} onChange={(event) => { setQuery(event.target.value); setCursor(null); setPrevious([]); }} /></label><select aria-label={t("筛选会话状态")} value={filter} onChange={(event) => { setFilter(event.target.value); setCursor(null); setPrevious([]); }}><option value="">{t("全部状态")}</option><option value="running">{t("正在执行")}</option><option value="awaiting_approval">{t("等待确认")}</option><option value="idle">{t("空闲")}</option><option value="unknown">{t("待核验")}</option></select></div>
    {error && <p className="catalog-error" role="alert">{systemText(error)}<button type="button" onClick={() => setRetry((value) => value + 1)}><RefreshCw size={13} />{t("重试")}</button></p>}
    {loading && !loaded && <div className="catalog-loading"><LoaderCircle className="spin" size={15} />{t("正在更新列表")}</div>}
    {searching ? <SessionRows sessions={matches.items} selectedId={selectedSession?.id} onSelect={onSelect} /> : visibleProjects.map((project) => <ProjectGroup key={project.id} project={project} expanded={expanded.has(project.id)} selectedId={selectedSession?.id} refreshKey={refreshKey} onToggle={() => setExpanded((current) => { const next = new Set(current); if (next.has(project.id)) next.delete(project.id); else next.add(project.id); return next; })} onSelect={onSelect} onCreate={onCreate} />)}
    {loaded && !error && (searching ? matches.items.length === 0 : projects.items.length === 0) && <p className="catalog-empty">{searching ? t("没有匹配的会话，试试其他关键词或状态。") : t("暂无项目。连接主机后会自动发现已有 Codex 项目。")}</p>}
    {(previous.length > 0 || nextCursor) && <nav className="project-pagination" aria-label={t("项目分页")}><span>{t("第 {0} 页", previous.length + 1)}</span><span className="project-pagination__actions"><button type="button" aria-label={t("上一页")} disabled={!previous.length || loading} onClick={() => { setCursor(previous.at(-1) ?? null); setPrevious((current) => current.slice(0, -1)); }}><ChevronLeft size={15} /></button><button type="button" aria-label={t("下一页")} disabled={!nextCursor || loading} onClick={() => { setPrevious((current) => [...current, cursor]); setCursor(nextCursor); }}><ChevronRight size={15} /></button></span></nav>}
  </section>;
}
