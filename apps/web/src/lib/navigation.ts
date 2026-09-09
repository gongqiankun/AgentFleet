import { sessionFromPath, sessionPath } from "./session-workspace";

export type View = "fleet" | "hosts" | "approvals" | "security";
export interface AppRoute { view: View; machineId?: string; sessionId?: string }

export function routeFromPath(pathname: string): AppRoute {
  const sessionId = sessionFromPath(pathname);
  if (sessionId) return { view: "fleet", sessionId };
  if (/^\/settings\/?$/.test(pathname)) return { view: "security" };
  if (/^\/approvals\/?$/.test(pathname)) return { view: "approvals" };
  const match = /^\/(hosts|workbench)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (match) {
    const view = match[1] === "hosts" ? "hosts" : "fleet";
    try { return { view, ...(match[2] ? { machineId: decodeURIComponent(match[2]) } : {}) }; }
    catch { return { view }; }
  }
  return { view: "fleet" };
}

export function routePath(route: AppRoute): string {
  if (route.view === "security") return "/settings";
  if (route.view === "approvals") return "/approvals";
  if (route.view === "fleet" && route.sessionId) return sessionPath(route.sessionId);
  const base = route.view === "hosts" ? "/hosts" : "/workbench";
  return route.machineId ? `${base}/${encodeURIComponent(route.machineId)}` : base;
}
