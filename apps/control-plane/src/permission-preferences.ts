import type { ControlPlaneDatabase } from "./db.js";
import type { Principal } from "./auth.js";
import { invariant } from "./errors.js";
import { nowIso } from "./crypto.js";

export type PermissionProfile = "project" | "network" | "full";
type Scope = "machine" | "project" | "session";
type Preference = { profile: PermissionProfile | null; revision: number };

/** Independent of model overrides: choosing a model must not freeze host permissions. */
export class PermissionPreferencesService {
  constructor(private readonly db: ControlPlaneDatabase) {}
  read(principal: Principal, kind: "machines" | "sessions", id: string) {
    const target = kind === "machines"
      ? this.db.get<{ machine_id: string; project_id?: string; permission_profiles: number }>("SELECT machine_id,permission_profiles FROM machines WHERE machine_id=? AND workspace_id=? AND identity_state='active'", id, principal.workspaceId)
      : this.db.get<{ machine_id: string; project_id: string; permission_profiles: number }>(`SELECT s.machine_id,s.project_id,m.permission_profiles FROM logical_sessions s JOIN machines m ON m.machine_id=s.machine_id WHERE s.logical_session_id=? AND s.workspace_id=? AND m.identity_state='active'`, id, principal.workspaceId);
    invariant(target, 404, "PERMISSION_TARGET_NOT_FOUND", "主机或会话不存在");
    const targets = { machine: target.machine_id, project: target.project_id, session: kind === "sessions" ? id : undefined };
    const preferences = Object.fromEntries((["machine", "project", "session"] as const).map(scope => {
      const row = targets[scope] ? this.db.get<Preference>("SELECT profile,revision FROM permission_preferences WHERE workspace_id=? AND scope=? AND target_id=?", principal.workspaceId, scope, targets[scope]!) : undefined;
      return [scope, row ?? { profile: null, revision: 0 }];
    })) as Record<Scope, Preference>;
    const source = preferences.session.profile ? "session" : preferences.project.profile ? "project" : preferences.machine.profile ? "machine" : "default";
    return { preferences, source, profile: source === "default" ? "project" as const : preferences[source].profile!, supported: target.permission_profiles === 1, targets };
  }
  write(principal: Principal, kind: "machines" | "sessions", id: string, input: Record<string, unknown>) {
    return this.db.transaction(() => {
      const current = this.read(principal, kind, id);
      const scope = input.scope;
      invariant(scope === "machine" || (kind === "sessions" && (scope === "project" || scope === "session")), 400, "INVALID_PERMISSION_SCOPE", "请选择主机、项目或会话");
      const profile = input.profile;
      invariant(profile === null || profile === "project" || profile === "network" || profile === "full", 400, "INVALID_PERMISSION_PROFILE", "请选择有效的权限配置或继承");
      invariant(Number.isSafeInteger(input.revision) && input.revision === current.preferences[scope].revision, 409, "PERMISSION_REVISION_CONFLICT", "权限已在其他页面修改，请刷新后再保存");
      invariant(profile !== "full" || input.confirmFullAccess === true, 400, "FULL_ACCESS_CONFIRMATION_REQUIRED", "请明确确认主机完整访问权限");
      invariant(current.supported || profile === null || profile === "project", 409, "PERMISSION_AGENT_UPDATE_REQUIRED", "请先更新主机连接服务，再配置扩展权限");
      this.db.run(`INSERT INTO permission_preferences(workspace_id,scope,target_id,profile,revision,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,scope,target_id) DO UPDATE SET profile=excluded.profile,revision=excluded.revision,updated_at=excluded.updated_at`, principal.workspaceId, scope, current.targets[scope]!, profile, current.preferences[scope].revision + 1, nowIso());
      this.db.audit({ workspaceId: principal.workspaceId, actorUserId: principal.userId, action: "permissions.save", metadata: { scope, targetId: current.targets[scope], profile, revision: current.preferences[scope].revision + 1 } });
      return this.read(principal, kind, id);
    });
  }
}
