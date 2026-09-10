import type { ControlPlaneDatabase } from "./db.js";
import { invariant } from "./errors.js";
const keys = ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens", "totalTokens"] as const;
type Counts = Record<(typeof keys)[number], number>;
const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const zero = (): Counts => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 });
function counts(v: unknown): Counts | undefined {
  const raw = object(v); if (!raw) return;
  const result = zero();
  for (const key of keys) { if (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < 0) return; result[key] = Number(raw[key]); }
  return result;
}
interface Row { logical_session_id: string; native_thread_id: string; epoch: string; counters_json: string; last_json: string; recorded_json: string; first_at: string; observed_at: string; context_window: number | null; discontinuities: number }
export class UsageService {
  constructor(private readonly db: ControlPlaneDatabase) {}
  record(event: { logicalSessionId: string; nativeThreadId?: string; appServerEpoch?: string; occurredAt: string; payload?: unknown }): void {
    const usage = object(object(event.payload)?.usage); if (!usage || !event.nativeThreadId || !event.appServerEpoch) return;
    if (this.db.get("SELECT 1 FROM logical_sessions WHERE logical_session_id=? AND deleted_at IS NOT NULL",event.logicalSessionId)) return;
    const total = counts(usage.total), last = counts(usage.last); if (!total || !last) return;
    if (keys.some(key => last[key] > total[key])) return;
    const previous = this.db.get<Row>("SELECT * FROM session_usage WHERE logical_session_id=?", event.logicalSessionId);
    if (previous && object(event.payload)?.synchronizedFromHost === true && event.occurredAt < previous.observed_at) return;
    const old = previous ? counts(JSON.parse(previous.counters_json))! : undefined;
    let delta = zero(), gaps = previous?.discontinuities ?? 0;
    if (!previous) {
      // First live notification provides only the latest request, not an attributable history.
      delta = last;
    } else if (previous.native_thread_id !== event.nativeThreadId) {
      gaps++;
    } else if (old && keys.some(key => total[key] < old[key])) {
      if (previous.epoch === event.appServerEpoch) return; // Late or reordered snapshot.
      gaps++; // New runtime counter baseline; do not invent the missing interval.
    } else if (old) {
      for (const key of keys) delta[key] = total[key] - old[key];
      if (delta.totalTokens === 0) return; // Retransmission or repeated cumulative notification.
    }
    const recorded = previous ? counts(JSON.parse(previous.recorded_json))! : zero();
    if (keys.some(key => !Number.isSafeInteger(recorded[key] + delta[key]))) return;
    for (const key of keys) recorded[key] += delta[key];
    const context = Number.isSafeInteger(usage.modelContextWindow) && Number(usage.modelContextWindow) > 0 ? Number(usage.modelContextWindow) : null;
    this.db.run(`INSERT INTO session_usage(logical_session_id,native_thread_id,epoch,counters_json,last_json,recorded_json,first_at,observed_at,context_window,discontinuities)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(logical_session_id) DO UPDATE SET native_thread_id=excluded.native_thread_id,epoch=excluded.epoch,counters_json=excluded.counters_json,last_json=excluded.last_json,recorded_json=excluded.recorded_json,observed_at=excluded.observed_at,context_window=excluded.context_window,discontinuities=excluded.discontinuities`,
      event.logicalSessionId,event.nativeThreadId,event.appServerEpoch,JSON.stringify(total),JSON.stringify(last),JSON.stringify(recorded),previous?.first_at ?? event.occurredAt,event.occurredAt,context,gaps);
    if (delta.totalTokens > 0) this.db.run("INSERT INTO usage_intervals(logical_session_id,starts_at,ends_at,total_tokens,precision) VALUES(?,?,?,?, 'observation')",
      event.logicalSessionId, previous && delta.totalTokens !== last.totalTokens ? previous.observed_at : event.occurredAt, event.occurredAt, delta.totalTokens);
    if (delta.totalTokens > 0) this.db.run(`INSERT INTO usage_days(logical_session_id,day,input_tokens,output_tokens,cached_input_tokens,reasoning_output_tokens,total_tokens)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(logical_session_id,day) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,cached_input_tokens=cached_input_tokens+excluded.cached_input_tokens,reasoning_output_tokens=reasoning_output_tokens+excluded.reasoning_output_tokens,total_tokens=total_tokens+excluded.total_tokens`,
      event.logicalSessionId,event.occurredAt.slice(0,10),delta.inputTokens,delta.outputTokens,delta.cachedInputTokens,delta.reasoningOutputTokens,delta.totalTokens);
  }
  quota(machineId: string, value: unknown): void {
    if (value === null) { this.db.run("DELETE FROM machine_usage WHERE machine_id=?",machineId); return; }
    const raw = object(value); if (!raw || !Array.isArray(raw.windows) || typeof raw.observedAt !== "string") return;
    const at = Date.parse(raw.observedAt); if (!Number.isFinite(at) || at > Date.now()+60_000) return;
    const windows = raw.windows.slice(0,32).flatMap(value => {
      const w = object(value); if (!w || typeof w.bucket !== "string" || w.bucket.length>100 || !["primary","secondary"].includes(String(w.window))) return [];
      if (typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent) || w.usedPercent<0 || w.usedPercent>100 || !Number.isSafeInteger(w.windowMinutes) || Number(w.windowMinutes)<=0) return [];
      return [{ bucket:w.bucket,window:w.window,usedPercent:w.usedPercent,remainingPercent:100-w.usedPercent,windowMinutes:w.windowMinutes,
        resetsAt:Number.isSafeInteger(w.resetsAt) && Number(w.resetsAt)>0 && Number(w.resetsAt)<1e11 ? w.resetsAt : null }];
    });
    const accountKey=typeof raw.accountKey === "string" && /^[a-f0-9]{64}$/.test(raw.accountKey) ? raw.accountKey : null;
    this.db.run(`INSERT INTO machine_usage(machine_id,account_key,observed_at,windows_json) VALUES(?,?,?,?)
      ON CONFLICT(machine_id) DO UPDATE SET account_key=excluded.account_key,observed_at=excluded.observed_at,windows_json=excluded.windows_json WHERE excluded.observed_at>=machine_usage.observed_at`,machineId,accountKey,new Date(at).toISOString(),JSON.stringify(windows));
  }
  read(workspaceId: string, scope: "session" | "project" | "machine", id: string) {
    const table=scope==="session"?"logical_sessions":scope==="project"?"projects":"machines";
    const column=scope==="session"?"logical_session_id":scope==="project"?"project_id":"machine_id";
    invariant(this.db.get(`SELECT 1 FROM ${table} WHERE ${column}=? AND workspace_id=?${scope==="session"?" AND deleted_at IS NULL":""}`,id,workspaceId),404,"USAGE_SCOPE_NOT_FOUND","Usage scope was not found");
    const sessions=this.db.all<{logical_session_id:string;machine_id:string;title:string}>(`SELECT logical_session_id,machine_id,title FROM logical_sessions WHERE workspace_id=? AND ${column}=? AND deleted_at IS NULL`,workspaceId,id);
    const rows=this.db.all<Row & {title:string;project_id:string;project_title:string}>(`SELECT u.*,s.title,s.project_id,p.alias AS project_title FROM session_usage u JOIN logical_sessions s USING(logical_session_id) JOIN projects p ON p.project_id=s.project_id WHERE s.workspace_id=? AND s.${column}=? AND s.deleted_at IS NULL`,workspaceId,id);
    const recorded=zero(); for(const row of rows) { const c=counts(JSON.parse(row.recorded_json))!; for(const key of keys) recorded[key]+=c[key]; }
    const machineIds=new Set(sessions.map(s=>s.machine_id)); if(scope==="machine")machineIds.add(id);
    if(scope==="project") { const project=this.db.get<{machine_id:string}>("SELECT machine_id FROM projects WHERE project_id=?",id); if(project)machineIds.add(project.machine_id); }
    const quotaRows=this.db.all<{machine_id:string;name:string;account_key:string|null;observed_at:string;windows_json:string}>(`SELECT u.*,m.name FROM machine_usage u JOIN machines m USING(machine_id) WHERE m.workspace_id=? AND m.identity_state='active' ORDER BY u.observed_at DESC`,workspaceId);
    const targetKeys=new Set(quotaRows.filter(r=>machineIds.has(r.machine_id)).map(r=>r.account_key??r.machine_id));
    const seen=new Set<string>();const accounts=quotaRows.flatMap(r=>{const key=r.account_key??r.machine_id;if(!targetKeys.has(key)||seen.has(key))return [];seen.add(key);return [{sourceMachine:r.name,identityKnown:r.account_key!==null,observedAt:r.observed_at,stale:Date.now()-Date.parse(r.observed_at)>180_000,windows:JSON.parse(r.windows_json)}];});
    const weekly = accounts.flatMap(account => account.windows.filter((w: { bucket: string; windowMinutes: number; resetsAt: number | null }) =>
      w.bucket === "codex" && w.windowMinutes === 10080 && w.resetsAt !== null && w.resetsAt * 1000 > Date.now() && w.resetsAt * 1000 - 10080 * 60_000 <= Date.now()));
    let quotaCycle: { startsAt: string; resetsAt: string; recordedTokens: number | null; boundaryIncomplete: boolean } | null = null;
    if (weekly.length === 1) {
      const resetsAt = new Date(weekly[0].resetsAt * 1000).toISOString();
      const startsAt = new Date(weekly[0].resetsAt * 1000 - weekly[0].windowMinutes * 60_000).toISOString();
      const period = this.db.get<{ total: number; uncertain: number }>(`SELECT
        COALESCE(SUM(CASE WHEN d.starts_at>=? AND d.ends_at<? THEN d.total_tokens ELSE 0 END),0) AS total,
        COALESCE(SUM(CASE WHEN d.starts_at<? OR d.ends_at>=? THEN 1 ELSE 0 END),0) AS uncertain
        FROM usage_intervals d JOIN logical_sessions s USING(logical_session_id)
        WHERE s.workspace_id=? AND s.${column}=? AND s.deleted_at IS NULL AND d.ends_at>=? AND d.starts_at<?`,
        startsAt,resetsAt,startsAt,resetsAt,workspaceId,id,startsAt,resetsAt)!;
      quotaCycle = { startsAt,resetsAt,recordedTokens:rows.length ? period.total : null,boundaryIncomplete:period.uncertain>0 };
    }
    const projectTotals=new Map<string,{id:string;title:string;totalTokens:number}>();
    if(scope==="machine") for(const row of rows) {
      const project={id:row.project_id,title:row.project_title};
      const aggregate=projectTotals.get(project.id)??{...project,totalTokens:0};aggregate.totalTokens+=JSON.parse(row.recorded_json).totalTokens;projectTotals.set(project.id,aggregate);
    }
    return { topProjects:[...projectTotals.values()].sort((a,b)=>b.totalTokens-a.totalTokens).slice(0,10), scope, observedSessions:rows.length,totalSessions:sessions.length,recorded:rows.length?recorded:null,quotaCycle,
      firstObservedAt:rows.map(r=>r.first_at).sort()[0]??null,lastObservedAt:rows.map(r=>r.observed_at).sort().at(-1)??null,
      coverage:"observed-only",accounts,discontinuities:rows.reduce((n,r)=>n+r.discontinuities,0),
      last:scope==="session" && rows[0]?JSON.parse(rows[0].last_json):null,nativeTotal:scope==="session" && rows[0]?JSON.parse(rows[0].counters_json):null,
      modelContextWindow:scope==="session"?rows[0]?.context_window??null:null,
      topSessions:rows.sort((a,b)=>JSON.parse(b.recorded_json).totalTokens-JSON.parse(a.recorded_json).totalTokens).slice(0,10).map(r=>({id:r.logical_session_id,title:r.title,totalTokens:JSON.parse(r.recorded_json).totalTokens})) };
  }
}
