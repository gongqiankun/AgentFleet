import { invariant } from "./errors.js";

export interface ListOptions {
  limit: number;
  cursor?: string;
  machineId?: string;
  projectId?: string;
  q?: string;
  executionState?: string;
  managed?: boolean;
}

export function pageLimit(value: unknown, defaultValue = 100): number {
  const limit = value === undefined ? defaultValue : Number(value);
  invariant(Number.isSafeInteger(limit) && limit >= 1 && limit <= 200, 400, "INVALID_LIMIT", "limit must be between 1 and 200");
  return limit;
}

export function pageCursor(scope: string, values: string[]): string {
  return Buffer.from(JSON.stringify({ scope, values })).toString("base64url");
}

export function parsePageCursor(cursor: string | undefined, scope: string): string[] | null {
  if (!cursor) return null;
  invariant(cursor.length <= 8192, 400, "INVALID_CURSOR", "cursor is invalid");
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { /* invalid below */ }
  const value = decoded as { scope?: unknown; values?: unknown } | undefined;
  invariant(value?.scope === scope && Array.isArray(value.values) && value.values.length === 2 && value.values.every((entry) => typeof entry === "string"), 400, "INVALID_CURSOR", "cursor does not belong to this query");
  return value.values as string[];
}
