import assert from "node:assert/strict";
import test from "node:test";
import { sessionActions } from "../src/capabilities.js";
import type { ControlPlaneDatabase } from "../src/db.js";

test("paginated claims require an explicit agent capability, preserving busy and read-only gates", () => {
  const row = { managed: 0, execution_state: "idle", active_turn_id: null, reachability: "live", native_thread_id: "original-id",
    history_mode: "paginated", machine_reachability: "online", identity_state: "active", security_state: "normal",
    compatibility: "compatible", runtime_read_only: 0, command_types_json: JSON.stringify(["thread.claim"]), holder: null,
    pending_approvals: 0, queued: 0, frozen: 0, runtime_settings_json: null as string | null, paginated_history: 0 };
  const db = { get: () => row } as unknown as ControlPlaneDatabase;
  assert.equal(sessionActions(db, "same-session", "browser").claim.reasonCode, "THREAD_HISTORY_UNSUPPORTED");
  row.paginated_history = 1;
  assert.equal(sessionActions(db, "same-session", "browser").claim.allowed, true);
  row.runtime_settings_json = JSON.stringify({ archived: true });
  assert.equal(sessionActions(db, "same-session", "browser").claim.reasonCode, "THREAD_ARCHIVED");
  row.runtime_settings_json = null;
  row.execution_state = "running";
  assert.equal(sessionActions(db, "same-session", "browser").claim.reasonCode, "THREAD_BUSY");
  row.execution_state = "idle"; row.runtime_read_only = 1;
  assert.equal(sessionActions(db, "same-session", "browser").claim.reasonCode, "MACHINE_READ_ONLY");
});
