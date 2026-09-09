import type { ControlPlaneDatabase } from "./db.js";

/** Credentials stay browser-specific; operation access is shared only within one account. */
export function sameLeaseAccount(db: ControlPlaneDatabase, holder: string, client: string): boolean {
  return Boolean(db.get(`SELECT 1 FROM client_sessions a JOIN client_sessions b
    ON a.user_id=b.user_id AND a.workspace_id=b.workspace_id
    WHERE a.client_session_id=? AND b.client_session_id=?
      AND a.revoked_at IS NULL AND b.revoked_at IS NULL
      AND a.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND b.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`, holder, client));
}
