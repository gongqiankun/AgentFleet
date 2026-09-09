import type { ControlPlaneDatabase } from "./db.js";
import { sameLeaseAccount } from "./lease-ownership.js";
import type { ActionAvailability, CommandType, SessionAction, SessionActions } from "./api-schema.js";
import { COMMAND_TYPES } from "./api-schema.js";

export const ACTION_COMMANDS: Record<Exclude<SessionAction, "read">, CommandType> = {
  deletePreview: "thread.delete.preview", delete: "thread.delete",
  claim: "thread.claim", release: "thread.release", start: "turn.start", queue: "turn.queue",
  steer: "turn.steer", cancel: "turn.cancel", approve: "approval.decide_once",
  rename: "thread.rename", archive: "thread.archive", unarchive: "thread.unarchive", fork: "thread.fork",
  compact: "turn.compact", review: "turn.review",
  inspect: "codex.inspect",
  stop: "thread.terminals.stop",
};

/** Legacy protocol v1 has no release negotiation. New capabilities are never inferred from semver. */
export function supportsCommand(reported: string | null, type: CommandType): boolean {
  if (reported === null) return ["thread.claim", "turn.start", "turn.queue", "turn.steer", "turn.cancel", "approval.decide_once"].includes(type);
  const commands: unknown = JSON.parse(reported);
  return Array.isArray(commands) && commands.includes(type);
}

const allowed: ActionAvailability = { allowed: true, reasonCode: null, message: null };
const blocked = (reasonCode: string, message: string): ActionAvailability => ({ allowed: false, reasonCode, message });

export function sessionActions(db: ControlPlaneDatabase, sessionId: string, clientSessionId: string): SessionActions {
  const row = db.get<{
    managed: number; execution_state: string; active_turn_id: string | null; reachability: string;
    native_thread_id: string | null; history_mode: string | null; machine_reachability: string;
    identity_state: string; security_state: string; compatibility: string; runtime_read_only: number;
    command_types_json: string | null; holder: string | null; pending_approvals: number; queued: number; frozen: number;
    runtime_settings_json: string | null;
    paginated_history: number;
  }>(`SELECT s.*,e.native_thread_id,e.history_mode,m.reachability AS machine_reachability,
      m.identity_state,m.security_state,m.compatibility,m.runtime_read_only,m.command_types_json,m.paginated_history,
      (SELECT holder_client_session_id FROM control_leases WHERE logical_session_id=s.logical_session_id
        AND state='active' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY acquired_at DESC LIMIT 1) AS holder,
      (SELECT count(*) FROM approvals WHERE logical_session_id=s.logical_session_id AND state='pending') AS pending_approvals,
      (SELECT count(*) FROM turn_queue WHERE logical_session_id=s.logical_session_id AND state IN ('queued','dispatching','unknown')) AS queued,
      EXISTS(SELECT 1 FROM project_turn_reservations WHERE project_id=s.project_id AND state IN ('unknown','migration_conflict')) AS frozen
    FROM logical_sessions s JOIN machines m ON m.machine_id=s.machine_id
    JOIN execution_segments e ON e.logical_session_id=s.logical_session_id AND e.ended_at IS NULL
    WHERE s.logical_session_id=? ORDER BY e.created_at DESC LIMIT 1`, sessionId);
  const actions = {} as SessionActions;
  const heldElsewhere = row?.holder && !sameLeaseAccount(db, row.holder, clientSessionId);
  actions.read = allowed;
  for (const [actionName, command] of Object.entries(ACTION_COMMANDS)) {
    const action = actionName as Exclude<SessionAction, "read">;
    let availability = allowed;
    if (!row) availability = blocked("SESSION_NOT_FOUND", "会话不存在");
    else if (!supportsCommand(row.command_types_json, command)) availability = blocked("AGENT_CAPABILITY_UNAVAILABLE", "主机尚未报告支持此操作，请更新连接服务");
    else if (row.identity_state !== "active") availability = blocked("MACHINE_REVOKED", "主机连接已移除");
    else if (row.machine_reachability !== "online") availability = blocked("MACHINE_OFFLINE", "等待主机重新连接");
    else if (row.reachability !== "live") availability = blocked("SESSION_RECONCILING", "会话正在同步");
    else if (row.security_state !== "normal" || row.runtime_read_only) availability = blocked("MACHINE_READ_ONLY", "主机当前只能读取会话");
    else if (row.compatibility !== "compatible") availability = blocked("MACHINE_INCOMPATIBLE", "当前运行环境尚未验证此操作");
    else if (row.frozen) availability = blocked("PROJECT_OUTCOME_UNKNOWN", "需要核验上一次操作结果");
    else if (heldElsewhere) availability = blocked("CONTROL_HELD_ELSEWHERE", "另一个账号正在操作此会话");
    else if (action === "claim" && row.managed) availability = blocked("SESSION_ALREADY_MANAGED", "会话已可在面板操作");
    else if (action !== "claim" && !row.managed) availability = blocked("EXTERNAL_SESSION_READ_ONLY", "先连接此会话的操作能力");
    else if (action === "claim" && row.history_mode !== "legacy" && !(row.history_mode === "paginated" && row.paginated_history)) availability = blocked("THREAD_HISTORY_UNSUPPORTED", "请更新主机连接服务以恢复原会话；不会替换原上下文");
    else if ((action === "claim" || action === "release") && !row.native_thread_id) availability = blocked("THREAD_NOT_AVAILABLE", "宿主机会话尚未建立");
    else if (["deletePreview", "delete", "claim", "release", "start", "rename", "archive", "unarchive", "fork", "compact", "review"].includes(action) &&
      (row.active_turn_id !== null || !["idle", "completed", "failed", "interrupted"].includes(row.execution_state))) availability = blocked("THREAD_BUSY", "等待当前任务完成");
    else if (["cancel", "steer"].includes(action) && !row.active_turn_id) availability = blocked("NO_ACTIVE_TURN", "当前没有运行中的任务");
    else if (["deletePreview", "delete", "release", "rename", "archive", "unarchive", "fork"].includes(action) && (row.pending_approvals || row.queued)) availability = blocked("SESSION_HAS_PENDING_WORK", "请先处理待审批与排队任务");
    else if (["deletePreview", "delete", "rename", "archive", "unarchive", "fork", "compact", "review", "stop"].includes(action) && !row.native_thread_id) availability = blocked("THREAD_NOT_AVAILABLE", "先发送一条消息建立宿主机会话");
    else if (["claim", "start", "queue", "release", "archive", "fork", "compact", "review"].includes(action) && row.runtime_settings_json && JSON.parse(row.runtime_settings_json)?.archived === true) availability = blocked("THREAD_ARCHIVED", row.managed ? "先恢复宿主机归档会话" : "请先在宿主机恢复归档，再接管原会话");
    else if (action === "approve" && !row.pending_approvals) availability = blocked("NO_PENDING_APPROVAL", "当前没有待审批操作");
    actions[action] = availability;
  }
  return actions;
}

export function parseCommandCapabilities(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 64 || value.some((entry) => typeof entry !== "string")) {
    throw new Error("capabilities.commandTypes must be an array of strings");
  }
  return JSON.stringify([...new Set(value.filter((entry) => COMMAND_TYPES.includes(entry as CommandType)))]);
}
