import type { ControlPlaneDatabase } from "./db.js";
import type { Principal } from "./auth.js";
import { invariant } from "./errors.js";
import { nowIso } from "./crypto.js";
import { parseCodexCatalog, validateCodexSettings, type CodexSettings } from "./codex-settings.js";

export class CodexPreferencesService {
  constructor(private readonly db: ControlPlaneDatabase) {}
  readMachine(principal: Principal, machineId: string) {
    const host = this.db.get<{ codex_catalog_json: string | null }>("SELECT codex_catalog_json FROM machines WHERE machine_id=? AND workspace_id=? AND identity_state='active'", machineId, principal.workspaceId);
    invariant(host, 404, "MACHINE_NOT_FOUND", "Active host was not found");
    const row = this.db.get<{ settings_json: string | null; revision: number }>("SELECT settings_json,revision FROM codex_preferences WHERE workspace_id=? AND scope='machine' AND target_id=?", principal.workspaceId, machineId);
    const settings = row?.settings_json ? JSON.parse(row.settings_json) as CodexSettings : null;
    return { catalog: host.codex_catalog_json ? parseCodexCatalog(JSON.parse(host.codex_catalog_json)) : null,
      preferences: { machine: { settings, revision: row?.revision ?? 0 }, project: { settings: null, revision: 0 }, session: { settings: null, revision: 0 } },
      source: settings ? "machine" as const : "codex" as const, desired: settings };
  }
  writeMachine(principal: Principal, machineId: string, input: Record<string, unknown>) {
    invariant(input.scope === undefined || input.scope === "machine", 400, "INVALID_SETTINGS_SCOPE", "Host endpoint only accepts host defaults");
    invariant(Number.isSafeInteger(input.revision) && Number(input.revision) >= 0, 400, "INVALID_SETTINGS_REVISION", "Settings revision is required");
    invariant(input.settings !== undefined, 400, "INVALID_CODEX_SETTINGS", "Specify settings or null to inherit");
    return this.db.transaction(() => {
      const current = this.readMachine(principal, machineId);
      invariant(current.preferences.machine.revision === input.revision, 409, "SETTINGS_REVISION_CONFLICT", "Settings changed in another browser; reload before saving");
      const settings = input.settings === null ? null : validateCodexSettings(input.settings, current.catalog);
      const revision = current.preferences.machine.revision + 1;
      this.db.run(`INSERT INTO codex_preferences(workspace_id,scope,target_id,settings_json,revision,updated_at) VALUES(?,'machine',?,?,?,?)
        ON CONFLICT(workspace_id,scope,target_id) DO UPDATE SET settings_json=excluded.settings_json,revision=excluded.revision,updated_at=excluded.updated_at`, principal.workspaceId, machineId, settings ? JSON.stringify(settings) : null, revision, nowIso());
      this.db.audit({ workspaceId: principal.workspaceId, actorUserId: principal.userId, action: "codex.preferences.save", metadata: { scope: "machine", targetId: machineId, revision } });
      return this.readMachine(principal, machineId);
    });
  }
  private targets(principal: Principal, sessionId: string) {
    const row = this.db.get<{ machine_id: string; project_id: string; codex_catalog_json: string | null }>(
      `SELECT s.machine_id,s.project_id,m.codex_catalog_json FROM logical_sessions s JOIN machines m ON m.machine_id=s.machine_id
       WHERE s.logical_session_id=? AND s.workspace_id=? AND m.identity_state='active'`, sessionId, principal.workspaceId);
    invariant(row, 404, "SESSION_NOT_FOUND", "Session or active host was not found");
    return { machine: row.machine_id, project: row.project_id, session: sessionId,
      catalog: row.codex_catalog_json ? parseCodexCatalog(JSON.parse(row.codex_catalog_json)) : null };
  }
  read(principal: Principal, sessionId: string) {
    const targets = this.targets(principal, sessionId);
    const preferences = Object.fromEntries((["machine", "project", "session"] as const).map((scope) => {
      const row = this.db.get<{ settings_json: string | null; revision: number }>(
        "SELECT settings_json,revision FROM codex_preferences WHERE workspace_id=? AND scope=? AND target_id=?", principal.workspaceId, scope, targets[scope]);
      return [scope, { settings: row?.settings_json ? JSON.parse(row.settings_json) as CodexSettings : null, revision: row?.revision ?? 0 }];
    })) as Record<"machine" | "project" | "session", { settings: CodexSettings | null; revision: number }>;
    const source = preferences.session.settings ? "session" : preferences.project.settings ? "project" : preferences.machine.settings ? "machine" : "codex";
    return { catalog: targets.catalog, preferences, source, desired: source === "codex" ? null : preferences[source].settings };
  }
  write(principal: Principal, sessionId: string, input: Record<string, unknown>) {
    const targets = this.targets(principal, sessionId);
    const scope = input.scope;
    invariant(scope === "machine" || scope === "project" || scope === "session", 400, "INVALID_SETTINGS_SCOPE", "Choose host, project or session scope");
    invariant(Number.isSafeInteger(input.revision) && Number(input.revision) >= 0, 400, "INVALID_SETTINGS_REVISION", "Settings revision is required");
    invariant(input.settings !== undefined, 400, "INVALID_CODEX_SETTINGS", "Specify settings or null to inherit");
    const settings = input.settings === null ? null : validateCodexSettings(input.settings, targets.catalog);
    return this.db.transaction(() => {
      const current = this.read(principal, sessionId).preferences[scope];
      invariant(current.revision === input.revision, 409, "SETTINGS_REVISION_CONFLICT", "Settings changed in another browser; reload before saving");
      this.db.run(`INSERT INTO codex_preferences(workspace_id,scope,target_id,settings_json,revision,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(workspace_id,scope,target_id) DO UPDATE SET settings_json=excluded.settings_json,revision=excluded.revision,updated_at=excluded.updated_at`,
        principal.workspaceId, scope, targets[scope], settings ? JSON.stringify(settings) : null, current.revision + 1, nowIso());
      this.db.audit({ workspaceId: principal.workspaceId, actorUserId: principal.userId, action: "codex.preferences.save", metadata: { scope, targetId: targets[scope], revision: current.revision + 1 } });
      return this.read(principal, sessionId);
    });
  }
}
