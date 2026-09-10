import { isRecord, nowIso, sha256 } from "./util.js";
const fields = ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningOutputTokens", "totalTokens"] as const;
export function tokenUsage(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return;
  const result: Record<string, unknown> = {};
  for (const key of ["total", "last"]) {
    const raw = value[key]; if (!isRecord(raw)) return;
    const counts: Record<string, number> = {};
    for (const field of fields) {
      if (!Number.isSafeInteger(raw[field]) || Number(raw[field]) < 0) return;
      counts[field] = Number(raw[field]);
    }
    result[key] = counts;
  }
  if (Number.isSafeInteger(value.modelContextWindow) && Number(value.modelContextWindow) > 0) result.modelContextWindow = value.modelContextWindow;
  return result;
}
export function quotaSnapshot(value: unknown, identity?: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return;
  const buckets = isRecord(value.rateLimitsByLimitId) ? Object.values(value.rateLimitsByLimitId) : [value.rateLimits];
  const windows: Record<string, unknown>[] = [];
  for (const bucket of buckets.slice(0, 16)) {
    if (!isRecord(bucket)) continue;
    for (const key of ["primary", "secondary"]) {
      const window = bucket[key]; if (!isRecord(window)) continue;
      if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) continue;
      if (!Number.isSafeInteger(window.windowDurationMins) || Number(window.windowDurationMins) <= 0) continue;
      windows.push({ bucket: typeof bucket.limitId === "string" ? bucket.limitId.slice(0, 100) : "codex", window: key,
        usedPercent: window.usedPercent, windowMinutes: window.windowDurationMins,
        resetsAt: Number.isSafeInteger(window.resetsAt) && Number(window.resetsAt) > 0 && Number(window.resetsAt) < 1e11 ? window.resetsAt : null });
    }
  }
  const account = isRecord(identity) && isRecord(identity.account) ? identity.account : undefined;
  // Account/workspace identifiers alone may be shared by different workspace users.
  const email = typeof account?.email === "string" ? account.email.trim().toLowerCase() : "";
  const key = typeof value.accountId === "string" && value.accountId && email
    ? sha256(JSON.stringify(["agentfleets-usage", value.accountId, email])).replace(/^sha256:/, "") : undefined;
  return { observedAt: nowIso(), windows, ...(key ? { accountKey: key } : {}) };
}
