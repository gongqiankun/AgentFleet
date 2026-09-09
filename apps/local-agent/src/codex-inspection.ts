import { isRecord, nowIso, redact } from "./util.js";

export interface InspectionRow { name: string; detail: string; status: string }
export interface InspectionSection { available: boolean; rows: InspectionRow[]; truncated: boolean; errorCode?: string }
export interface CodexInspection { observedAt: string; cwd: string; sections: Record<string, InspectionSection> }
const object = (v: unknown): Record<string, unknown> => isRecord(v) ? v : {};
const entries = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.filter(isRecord) : [];
const text = (v: unknown, fallback = "未上报"): string => typeof v === "string" ? redact(v).slice(0, 180) : typeof v === "number" ? String(v) : fallback;
const enabled = (v: unknown): string => v === true ? "已启用" : v === false ? "已停用" : "未上报";

/** No auth tokens, environment variables, tool schemas, hook commands or raw config leave the host. */
export function inspectionSection(kind: string, value: unknown): InspectionSection {
  const raw = object(value); let rows: InspectionRow[] = []; let truncated = false;
  if (kind === "account") {
    const account = object(raw.account);
    rows = [{ name: "认证方式", detail: text(account.type, raw.account === null ? "未登录" : "未上报"), status: text(account.planType, "") }];
  } else if (kind === "usage") {
    const limits = isRecord(raw.rateLimitsByLimitId) ? Object.values(raw.rateLimitsByLimitId).map(object) : [object(raw.rateLimits)];
    for (const limit of limits) for (const key of ["primary", "secondary"]) {
      const window = object(limit[key]); if (typeof window.usedPercent !== "number") continue;
      const reset = typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt) && Math.abs(window.resetsAt) < 8e12 ? new Date(window.resetsAt * 1000).toISOString() : "未上报";
      rows.push({ name: `${text(limit.limitName ?? limit.limitId, "Codex")} · ${key === "primary" ? "主窗口" : "次窗口"}`, detail: `已用 ${window.usedPercent}% · 重置 ${reset}`, status: `${text(window.windowDurationMins)} 分钟` });
    }
  } else if (kind === "config") {
    const config = object(raw.config); const origins = object(raw.origins);
    for (const key of ["model", "model_provider", "model_reasoning_effort", "approval_policy", "sandbox_mode", "service_tier", "personality", "web_search"]) {
      if (config[key] === undefined || config[key] === null) continue;
      const source = object(object(origins[key]).name);
      rows.push({ name: key, detail: text(config[key], "结构化策略（未展开）"), status: text(source.type, "来源未上报") });
    }
  } else if (kind === "skills" || kind === "hooks") {
    for (const scope of entries(raw.data)) {
      for (const item of entries(scope[kind])) rows.push({ name: text(item.name ?? item.eventName), detail: kind === "skills" ? text(item.shortDescription ?? item.description, "") : `${text(item.handlerType)} · ${text(item.trustStatus)}`, status: enabled(item.enabled) });
      if (entries(scope.errors).length) rows.push({ name: "部分条目读取失败", detail: "主机报告解析错误；未上传可能包含敏感内容的原始错误", status: String(entries(scope.errors).length) });
    }
  } else if (kind === "mcp") {
    rows = entries(raw.data).map((item) => ({ name: text(item.name), detail: `工具 ${Object.keys(object(item.tools)).length} · ${text(item.runtimeStatus, "连接状态未上报")}`, status: text(item.authStatus) }));
    truncated = typeof raw.nextCursor === "string" && raw.nextCursor.length > 0;
  } else if (kind === "apps") {
    rows = entries(raw.data).map((item) => ({ name: text(item.name), detail: text(item.description, ""), status: `${enabled(item.isEnabled)} · ${item.isAccessible === true ? "账号可访问" : "可访问性未确认"}` }));
    truncated = typeof raw.nextCursor === "string" && raw.nextCursor.length > 0;
  } else if (kind === "plugins") {
    rows = entries(raw.marketplaces).flatMap((market) => entries(market.plugins).filter((item) => item.installed === true).map((item) => ({ name: text(item.name), detail: `${text(market.name)} · ${text(item.localVersion ?? item.version)}`, status: enabled(item.enabled) })));
    if (entries(raw.marketplaceLoadErrors).length) rows.push({ name: "部分插件来源读取失败", detail: "当前结果不完整", status: String(entries(raw.marketplaceLoadErrors).length) });
  } else if (kind === "terminals") {
    rows = entries(raw.data).map((item) => ({ name: text(item.processId), detail: text(item.command), status: `工作目录 ${text(item.cwd)}` }));
    truncated = typeof raw.nextCursor === "string" && raw.nextCursor.length > 0;
  } else if (kind === "goal") {
    const goal = object(raw.goal);
    if (raw.goal !== null && typeof goal.objective === "string") rows = [{ name: "当前任务目标（摘要）", detail: text(goal.objective), status: text(goal.status) }, { name: "目标用量", detail: `已用 ${text(goal.tokensUsed)} tokens · ${text(goal.timeUsedSeconds)} 秒`, status: `预算 ${text(goal.tokenBudget, "未设置")}` }];
  } else if (kind === "permissions") {
    rows = entries(raw.data).map((item) => ({ name: text(item.id), detail: text(item.description, ""), status: item.allowed === true ? "原生配置允许；面板仍受固定策略约束" : "原生配置禁止" }));
    truncated = typeof raw.nextCursor === "string" && raw.nextCursor.length > 0;
  } else if (kind === "experimental") {
    rows = entries(raw.data).map((item) => ({ name: text(item.displayName ?? item.name), detail: text(item.description ?? item.name), status: `${enabled(item.enabled)} · ${text(item.stage)}` }));
    truncated = typeof raw.nextCursor === "string" && raw.nextCursor.length > 0;
  }
  return { available: true, rows: rows.slice(0, 25), truncated: truncated || rows.length > 25 };
}

export async function inspectCodex(request: (method: string, params: Record<string, unknown> | null) => Promise<unknown>, cwd: string, threadId?: string): Promise<CodexInspection> {
  const calls: [string, string, Record<string, unknown> | null][] = [
    ["account", "account/read", { refreshToken: false }], ["usage", "account/rateLimits/read", null],
    ["config", "config/read", { cwd, includeLayers: false }], ["skills", "skills/list", { cwds: [cwd], forceReload: true }],
    ["hooks", "hooks/list", { cwds: [cwd] }], ["mcp", "mcpServerStatus/list", { limit: 25 }],
    ["apps", "app/list", { limit: 25, forceRefetch: false, ...(threadId ? { threadId } : {}) }],
    ["plugins", "plugin/list", { cwds: [cwd], forceRefetch: false }],
    ["permissions", "permissionProfile/list", { limit: 25 }], ["experimental", "experimentalFeature/list", { limit: 25 }],
    ...(threadId ? [["terminals", "thread/backgroundTerminals/list", { threadId, limit: 25 }], ["goal", "thread/goal/get", { threadId }]] as [string, string, Record<string, unknown>][] : []),
  ];
  const sections: Record<string, InspectionSection> = Object.fromEntries(await Promise.all(calls.map(async ([kind, method, params]) => {
    try { return [kind, inspectionSection(kind, await request(method, params))]; }
    catch (e) { return [kind, { available: false, rows: [], truncated: false, errorCode: isRecord(e) && typeof e.code === "string" ? e.code : "CODEX_QUERY_FAILED" }]; }
  })));
  const result = { observedAt: nowIso(), cwd, sections };
  while (Buffer.byteLength(JSON.stringify(result)) > 28_000) {
    const largest = Object.values(sections).sort((a, b) => b.rows.length - a.rows.length)[0];
    if (!largest?.rows.length) break;
    largest.rows.pop(); largest.truncated = true;
  }
  return result;
}
