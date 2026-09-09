import { useState } from "react";

export function sessionFromPath(pathname: string): string | undefined {
  const match = /^\/sessions\/([^/]+)\/?$/.exec(pathname);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return undefined; }
}

export function sessionPath(sessionId?: string): string {
  return sessionId ? `/sessions/${encodeURIComponent(sessionId)}` : "/";
}

export function draftKey(userId: string, sessionId: string): string {
  return `agentfleet.draft:${encodeURIComponent(userId)}:${encodeURIComponent(sessionId)}`;
}

export function useSessionDraft(userId: string | undefined, sessionId: string | undefined) {
  const key = userId && sessionId ? draftKey(userId, sessionId) : undefined;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  let stored = "";
  if (key) {
    try { stored = localStorage.getItem(key) ?? ""; } catch { /* Memory remains available when storage is disabled. */ }
  }
  const value = key ? drafts[key] ?? stored : "";
  function setValue(next: string) {
    if (!key) return;
    setDrafts((current) => ({ ...current, [key]: next }));
    try {
      if (next) localStorage.setItem(key, next);
      else localStorage.removeItem(key);
    } catch { /* Sending never depends on browser storage availability. */ }
  }
  return [value, setValue] as const;
}
