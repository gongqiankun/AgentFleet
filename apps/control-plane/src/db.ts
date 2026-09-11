import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ControlPlaneConfig } from "./config.js";
import { hashPassword, newId, nowIso } from "./crypto.js";
import { CloudImages } from "./cloud-images.js";

const MIGRATION_1 = `
CREATE TABLE workspaces (
  workspace_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role = 'admin'),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE client_sessions (
  client_session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  user_id TEXT NOT NULL REFERENCES users(user_id),
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  ip_hash TEXT,
  user_agent_hash TEXT
) STRICT;
CREATE INDEX client_sessions_user_idx ON client_sessions(user_id, created_at DESC);

CREATE TABLE pairing_transactions (
  pairing_id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  public_key_spki TEXT NOT NULL,
  public_key_fingerprint TEXT NOT NULL,
  verification_phrase TEXT NOT NULL,
  proof_challenge TEXT NOT NULL,
  requested_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  platform_release TEXT NOT NULL,
  architecture TEXT NOT NULL,
  agent_version TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','redeemed','expired')),
  bound_workspace_id TEXT REFERENCES workspaces(workspace_id),
  bound_user_id TEXT REFERENCES users(user_id),
  bound_client_session_id TEXT REFERENCES client_sessions(client_session_id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  confirmed_at TEXT,
  redeemed_at TEXT,
  init_ip_hash TEXT,
  confirm_ip_hash TEXT
) STRICT;
CREATE INDEX pairing_expiry_idx ON pairing_transactions(status, expires_at);

CREATE TABLE machines (
  machine_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  public_key_spki TEXT NOT NULL,
  public_key_fingerprint TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  platform_release TEXT NOT NULL,
  architecture TEXT NOT NULL,
  agent_version TEXT,
  identity_state TEXT NOT NULL CHECK (identity_state IN ('active','revoked')) DEFAULT 'active',
  security_state TEXT NOT NULL CHECK (security_state IN ('normal','degraded_read_only')) DEFAULT 'normal',
  reachability TEXT NOT NULL CHECK (reachability IN ('offline','connecting','online','reconnecting')) DEFAULT 'offline',
  compatibility TEXT NOT NULL CHECK (compatibility IN ('unknown','compatible','incompatible')) DEFAULT 'unknown',
  compatibility_reason TEXT,
  capacity TEXT NOT NULL CHECK (capacity IN ('unknown','idle','busy','saturated')) DEFAULT 'unknown',
  unreachable_reason TEXT,
  active_turns INTEGER NOT NULL DEFAULT 0,
  last_heartbeat_at TEXT,
  last_connected_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, public_key_spki)
) STRICT;
CREATE INDEX machines_workspace_idx ON machines(workspace_id, created_at DESC);

CREATE TABLE machine_credentials (
  credential_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(machine_id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;

CREATE TABLE agent_challenges (
  challenge_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(machine_id),
  credential_id TEXT NOT NULL REFERENCES machine_credentials(credential_id),
  nonce TEXT NOT NULL,
  audience TEXT NOT NULL,
  transport_generation INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;
CREATE INDEX agent_challenges_expiry_idx ON agent_challenges(machine_id, expires_at);

CREATE TABLE agent_tickets (
  ticket_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(machine_id),
  token_hash TEXT NOT NULL UNIQUE,
  audience TEXT NOT NULL,
  transport_generation INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;

CREATE TABLE agent_connections (
  connection_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(machine_id),
  transport_generation INTEGER NOT NULL,
  producer_epoch TEXT,
  app_server_epoch TEXT,
  connected_at TEXT NOT NULL,
  hello_at TEXT,
  disconnected_at TEXT,
  close_reason TEXT,
  UNIQUE(machine_id, transport_generation)
) STRICT;

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  machine_id TEXT NOT NULL REFERENCES machines(machine_id),
  external_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  canonical_root TEXT NOT NULL,
  identity_hash TEXT NOT NULL,
  repo_root TEXT,
  branch TEXT,
  dirty INTEGER CHECK (dirty IN (0,1)),
  lease_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_reported_at TEXT NOT NULL,
  UNIQUE(machine_id, external_id),
  UNIQUE(machine_id, identity_hash)
) STRICT;
CREATE INDEX projects_workspace_idx ON projects(workspace_id, machine_id);

CREATE TABLE logical_sessions (
  logical_session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  machine_id TEXT NOT NULL REFERENCES machines(machine_id),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  external_id TEXT,
  title TEXT NOT NULL,
  managed INTEGER NOT NULL CHECK (managed IN (0,1)),
  execution_state TEXT NOT NULL CHECK (execution_state IN ('idle','running','awaiting_approval','completed','interrupted','failed','unknown')),
  reachability TEXT NOT NULL CHECK (reachability IN ('live','reconciling','unreachable')),
  thread_control_version INTEGER NOT NULL DEFAULT 1,
  turn_control_version INTEGER NOT NULL DEFAULT 1,
  active_turn_id TEXT,
  projection_epoch INTEGER NOT NULL DEFAULT 1,
  next_session_seq INTEGER NOT NULL DEFAULT 1,
  control_lease_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(machine_id, external_id)
) STRICT;
CREATE INDEX logical_sessions_workspace_idx ON logical_sessions(workspace_id, updated_at DESC);

CREATE TABLE execution_segments (
  execution_segment_id TEXT PRIMARY KEY,
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
  machine_id TEXT NOT NULL REFERENCES machines(machine_id),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  external_id TEXT,
  native_thread_id TEXT,
  history_completeness TEXT NOT NULL CHECK (history_completeness IN ('complete','partial','unknown')) DEFAULT 'unknown',
  created_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE(machine_id, external_id)
) STRICT;
CREATE INDEX execution_segments_session_idx ON execution_segments(logical_session_id, created_at);

CREATE TABLE control_leases (
  control_lease_id TEXT PRIMARY KEY,
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
  holder_client_session_id TEXT NOT NULL REFERENCES client_sessions(client_session_id),
  version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','released','expired','revoked')),
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT
) STRICT;
CREATE UNIQUE INDEX one_active_control_lease_idx
  ON control_leases(logical_session_id) WHERE state = 'active';
CREATE INDEX control_leases_holder_idx ON control_leases(holder_client_session_id, state);

CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
  execution_segment_id TEXT NOT NULL REFERENCES execution_segments(execution_segment_id),
  action_hash TEXT NOT NULL,
  app_server_epoch TEXT NOT NULL,
  version INTEGER NOT NULL,
  context_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','rejected')),
  decision_command_id TEXT,
  decided_by_client_session_id TEXT REFERENCES client_sessions(client_session_id),
  decided_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE commands (
  command_id TEXT PRIMARY KEY,
  client_mutation_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  actor_user_id TEXT NOT NULL REFERENCES users(user_id),
  actor_client_session_id TEXT NOT NULL REFERENCES client_sessions(client_session_id),
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
  execution_segment_id TEXT NOT NULL REFERENCES execution_segments(execution_segment_id),
  control_lease_id TEXT REFERENCES control_leases(control_lease_id),
  type TEXT NOT NULL CHECK (type IN ('turn.start','turn.cancel','approval.decide_once')),
  precondition_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(workspace_id, actor_client_session_id, client_mutation_id)
) STRICT;
CREATE INDEX commands_session_idx ON commands(logical_session_id, created_at);

CREATE TABLE command_projection (
  command_id TEXT PRIMARY KEY REFERENCES commands(command_id),
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE command_lifecycle (
  lifecycle_id INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL REFERENCES commands(command_id),
  state TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX command_lifecycle_command_idx ON command_lifecycle(command_id, lifecycle_id);

CREATE TABLE dispatch_attempts (
  dispatch_attempt_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL REFERENCES commands(command_id),
  attempt_no INTEGER NOT NULL,
  machine_id TEXT NOT NULL REFERENCES machines(machine_id),
  transport_generation INTEGER NOT NULL,
  producer_epoch TEXT NOT NULL,
  app_server_epoch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(command_id, attempt_no)
) STRICT;

CREATE TABLE dispatch_attempt_projection (
  dispatch_attempt_id TEXT PRIMARY KEY REFERENCES dispatch_attempts(dispatch_attempt_id),
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE dispatch_attempt_lifecycle (
  lifecycle_id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_attempt_id TEXT NOT NULL REFERENCES dispatch_attempts(dispatch_attempt_id),
  state TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX dispatch_lifecycle_attempt_idx ON dispatch_attempt_lifecycle(dispatch_attempt_id, lifecycle_id);

CREATE TABLE producer_streams (
  machine_id TEXT NOT NULL REFERENCES machines(machine_id),
  producer_epoch TEXT NOT NULL,
  next_expected_host_seq INTEGER NOT NULL DEFAULT 1,
  quarantined INTEGER NOT NULL DEFAULT 0 CHECK (quarantined IN (0,1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(machine_id, producer_epoch)
) STRICT, WITHOUT ROWID;

CREATE TABLE content_blobs (
  payload_ref TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  body_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE TABLE durable_events (
  event_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('agent','control_plane')),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
  execution_segment_id TEXT NOT NULL REFERENCES execution_segments(execution_segment_id),
  machine_id TEXT NOT NULL REFERENCES machines(machine_id),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  producer_epoch TEXT,
  app_server_epoch TEXT,
  host_seq INTEGER,
  session_seq INTEGER NOT NULL,
  projection_epoch INTEGER NOT NULL,
  native_thread_id TEXT,
  native_turn_id TEXT,
  native_item_id TEXT,
  type TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_ref TEXT REFERENCES content_blobs(payload_ref),
  payload_state TEXT NOT NULL CHECK (payload_state IN ('present','suppressed','deleted')),
  content_epoch INTEGER NOT NULL DEFAULT 1,
  UNIQUE(machine_id, producer_epoch, host_seq),
  UNIQUE(logical_session_id, projection_epoch, session_seq)
) STRICT;
CREATE INDEX durable_events_replay_idx
  ON durable_events(logical_session_id, projection_epoch, session_seq);

CREATE TABLE quarantined_events (
  quarantine_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(machine_id),
  producer_epoch TEXT NOT NULL,
  event_id TEXT NOT NULL,
  host_seq INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE security_alerts (
  alert_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  machine_id TEXT REFERENCES machines(machine_id),
  code TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;

CREATE TABLE audit_entries (
  audit_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  actor_user_id TEXT REFERENCES users(user_id),
  actor_client_session_id TEXT REFERENCES client_sessions(client_session_id),
  machine_id TEXT REFERENCES machines(machine_id),
  project_id TEXT REFERENCES projects(project_id),
  logical_session_id TEXT REFERENCES logical_sessions(logical_session_id),
  control_lease_id TEXT REFERENCES control_leases(control_lease_id),
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  ip_hash TEXT,
  user_agent_hash TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX audit_workspace_idx ON audit_entries(workspace_id, created_at DESC);

CREATE TRIGGER commands_immutable_update BEFORE UPDATE ON commands
BEGIN SELECT RAISE(ABORT, 'commands are immutable'); END;
CREATE TRIGGER commands_immutable_delete BEFORE DELETE ON commands
BEGIN SELECT RAISE(ABORT, 'commands are immutable'); END;
CREATE TRIGGER dispatch_attempts_immutable_update BEFORE UPDATE ON dispatch_attempts
BEGIN SELECT RAISE(ABORT, 'dispatch attempts are immutable'); END;
CREATE TRIGGER dispatch_attempts_immutable_delete BEFORE DELETE ON dispatch_attempts
BEGIN SELECT RAISE(ABORT, 'dispatch attempts are immutable'); END;
`;

const MIGRATION_2 = `
ALTER TABLE machines ADD COLUMN codex_version TEXT;
ALTER TABLE machines ADD COLUMN schema_hash TEXT;
ALTER TABLE machines ADD COLUMN credential_protection_level TEXT NOT NULL DEFAULT 'unknown'
  CHECK (credential_protection_level IN ('unknown','os_keychain','software_protected','file_restricted'));
ALTER TABLE machines ADD COLUMN security_reason TEXT;
`;

const MIGRATION_3 = `
ALTER TABLE machines ADD COLUMN current_producer_epoch TEXT;
ALTER TABLE producer_streams ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0,1));
ALTER TABLE producer_streams ADD COLUMN resume_through_host_seq INTEGER;
`;

const MIGRATION_4 = `
ALTER TABLE logical_sessions ADD COLUMN content_epoch INTEGER NOT NULL DEFAULT 1;
DROP TRIGGER commands_immutable_update;
ALTER TABLE commands ADD COLUMN content_epoch INTEGER NOT NULL DEFAULT 1;
CREATE TABLE command_contents (
  command_id TEXT PRIMARY KEY REFERENCES commands(command_id),
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;
INSERT INTO command_contents(command_id,body_json,created_at,expires_at)
  SELECT command_id,payload_json,created_at,datetime(created_at, '+7 days') FROM commands;
UPDATE commands SET payload_json='{}';
CREATE TRIGGER commands_immutable_update BEFORE UPDATE ON commands
BEGIN SELECT RAISE(ABORT, 'commands are immutable'); END;
CREATE TABLE content_tombstones (
  event_id TEXT PRIMARY KEY REFERENCES durable_events(event_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
  payload_hash TEXT NOT NULL,
  deleted_content_epoch INTEGER NOT NULL,
  tombstone_content_epoch INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('expired','user_deleted')),
  deleted_at TEXT NOT NULL
) STRICT;
CREATE INDEX content_tombstones_session_idx ON content_tombstones(logical_session_id, deleted_at);
CREATE TRIGGER content_tombstones_immutable_update BEFORE UPDATE ON content_tombstones
BEGIN SELECT RAISE(ABORT, 'content tombstones are immutable'); END;
CREATE TRIGGER content_tombstones_immutable_delete BEFORE DELETE ON content_tombstones
BEGIN SELECT RAISE(ABORT, 'content tombstones are immutable'); END;
`;

const MIGRATION_5 = `
CREATE TABLE project_turn_reservations (
  project_id TEXT PRIMARY KEY REFERENCES projects(project_id),
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
  command_id TEXT UNIQUE REFERENCES commands(command_id),
  native_turn_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('accepted','dispatching','active','unknown','migration_conflict')),
  conflict_count INTEGER NOT NULL DEFAULT 1 CHECK (conflict_count >= 1),
  version INTEGER NOT NULL DEFAULT 1,
  reserved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX project_turn_reservations_session_idx
  ON project_turn_reservations(logical_session_id);

CREATE TABLE project_turn_migration_members (
  project_id TEXT NOT NULL REFERENCES project_turn_reservations(project_id) ON DELETE CASCADE,
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
  command_id TEXT REFERENCES commands(command_id),
  native_turn_id TEXT,
  resolved_at TEXT,
  PRIMARY KEY(project_id, logical_session_id)
) STRICT, WITHOUT ROWID;

-- Older builds could have more than one apparently active Session for a
-- Project. Collapse those rows into an explicit migration_conflict freeze.
-- It intentionally has no command/native turn owner, so one Session's terminal
-- event cannot release the Project while another legacy turn may still run.
INSERT INTO project_turn_reservations(
  project_id,logical_session_id,command_id,native_turn_id,state,conflict_count,
  version,reserved_at,updated_at
)
SELECT
  project_id,
  logical_session_id,
  CASE WHEN conflict_count > 1 THEN NULL ELSE command_id END,
  CASE WHEN conflict_count > 1 THEN NULL ELSE active_turn_id END,
  CASE WHEN conflict_count > 1 THEN 'migration_conflict' ELSE state END,
  conflict_count,
  1,
  updated_at,
  updated_at
FROM (
  SELECT
    s.project_id,
    s.logical_session_id,
    s.active_turn_id,
    s.updated_at,
    CASE
      WHEN s.execution_state='unknown' OR s.active_turn_id IS NULL THEN 'unknown'
      ELSE 'active'
    END AS state,
    (
      SELECT c.command_id FROM commands c
      WHERE c.logical_session_id=s.logical_session_id AND c.type='turn.start'
      ORDER BY c.created_at DESC LIMIT 1
    ) AS command_id,
    COUNT(*) OVER (PARTITION BY s.project_id) AS conflict_count,
    ROW_NUMBER() OVER (
      PARTITION BY s.project_id
      ORDER BY CASE WHEN s.execution_state='unknown' THEN 0 ELSE 1 END, s.updated_at DESC
    ) AS reservation_rank
  FROM logical_sessions s
  WHERE s.managed=1
    AND s.execution_state IN ('running','awaiting_approval','unknown')
)
WHERE reservation_rank=1;

INSERT INTO project_turn_migration_members(
  project_id,logical_session_id,command_id,native_turn_id
)
SELECT
  s.project_id,
  s.logical_session_id,
  (
    SELECT c.command_id FROM commands c
    WHERE c.logical_session_id=s.logical_session_id AND c.type='turn.start'
    ORDER BY c.created_at DESC LIMIT 1
  ),
  s.active_turn_id
FROM logical_sessions s
WHERE s.managed=1
  AND s.execution_state IN ('running','awaiting_approval','unknown')
  AND (
    SELECT COUNT(*) FROM logical_sessions peers
    WHERE peers.project_id=s.project_id AND peers.managed=1
      AND peers.execution_state IN ('running','awaiting_approval','unknown')
  ) > 1;
`;

const MIGRATION_6 = `
ALTER TABLE project_turn_reservations ADD COLUMN bound_producer_epoch TEXT;
ALTER TABLE project_turn_reservations ADD COLUMN bound_app_server_epoch TEXT;
ALTER TABLE project_turn_reservations ADD COLUMN binding_state TEXT NOT NULL DEFAULT 'unbound'
  CHECK (binding_state IN ('unbound','bound','legacy_unbound'));
UPDATE project_turn_reservations SET binding_state='legacy_unbound'
  WHERE state<>'migration_conflict' AND native_turn_id IS NOT NULL;

ALTER TABLE producer_streams ADD COLUMN max_declared_host_seq INTEGER NOT NULL DEFAULT 0;
UPDATE producer_streams SET max_declared_host_seq=MAX(
  next_expected_host_seq - 1,
  COALESCE(resume_through_host_seq, 0)
);
ALTER TABLE producer_streams ADD COLUMN resume_connection_id TEXT REFERENCES agent_connections(connection_id);

CREATE TABLE reconciliation_cycles (
  reconciliation_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL UNIQUE REFERENCES agent_connections(connection_id),
  machine_id TEXT NOT NULL REFERENCES machines(machine_id),
  producer_epoch TEXT NOT NULL,
  app_server_epoch TEXT NOT NULL,
  capacity TEXT NOT NULL CHECK (capacity IN ('unknown','idle','busy','saturated')),
  state TEXT NOT NULL CHECK (state IN ('pending','complete')) DEFAULT 'pending',
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE TABLE reconciliation_stream_targets (
  reconciliation_id TEXT NOT NULL REFERENCES reconciliation_cycles(reconciliation_id) ON DELETE CASCADE,
  machine_id TEXT NOT NULL,
  producer_epoch TEXT NOT NULL,
  through_host_seq INTEGER NOT NULL CHECK (through_host_seq >= 0),
  is_current INTEGER NOT NULL CHECK (is_current IN (0,1)),
  PRIMARY KEY(reconciliation_id, producer_epoch),
  FOREIGN KEY(machine_id, producer_epoch) REFERENCES producer_streams(machine_id, producer_epoch)
) STRICT, WITHOUT ROWID;
CREATE INDEX reconciliation_stream_connection_idx
  ON reconciliation_stream_targets(reconciliation_id, machine_id);

CREATE TABLE reconciliation_session_targets (
  reconciliation_id TEXT NOT NULL REFERENCES reconciliation_cycles(reconciliation_id) ON DELETE CASCADE,
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
  PRIMARY KEY(reconciliation_id, logical_session_id)
) STRICT, WITHOUT ROWID;
`;

const MIGRATION_7 = `
CREATE TABLE enrollment_transactions (
  enrollment_id TEXT PRIMARY KEY,
  bootstrap_secret_hash TEXT NOT NULL UNIQUE,
  claim_token_hash TEXT UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  user_id TEXT NOT NULL REFERENCES users(user_id),
  client_session_id TEXT NOT NULL REFERENCES client_sessions(client_session_id),
  public_key_spki TEXT,
  public_key_fingerprint TEXT,
  verification_phrase TEXT,
  proof_challenge TEXT,
  requested_name TEXT,
  platform TEXT,
  platform_release TEXT,
  architecture TEXT,
  agent_version TEXT,
  status TEXT NOT NULL CHECK (status IN ('created','claimed','confirmed','redeemed','expired','cancelled')),
  machine_id TEXT REFERENCES machines(machine_id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  confirmed_at TEXT,
  redeemed_at TEXT,
  cancelled_at TEXT,
  create_ip_hash TEXT,
  claim_ip_hash TEXT,
  confirm_ip_hash TEXT
) STRICT;
CREATE INDEX enrollment_owner_idx
  ON enrollment_transactions(workspace_id, user_id, client_session_id, created_at DESC);
CREATE INDEX enrollment_expiry_idx ON enrollment_transactions(status, expires_at);
`;

const MIGRATION_8 = `
ALTER TABLE enrollment_transactions ADD COLUMN credential_id TEXT REFERENCES machine_credentials(credential_id);
ALTER TABLE enrollment_transactions ADD COLUMN recovery_expires_at TEXT;
CREATE UNIQUE INDEX enrollment_credential_idx
  ON enrollment_transactions(credential_id) WHERE credential_id IS NOT NULL;
`;

const MIGRATION_9 = `
ALTER TABLE machines ADD COLUMN display_alias TEXT;
`;

const MIGRATION_10 = `
ALTER TABLE execution_segments ADD COLUMN history_mode TEXT
  CHECK (history_mode IN ('legacy','paginated'));
`;

const MIGRATION_11 = `
DROP TRIGGER commands_immutable_update;
DROP TRIGGER commands_immutable_delete;
DROP INDEX commands_session_idx;
PRAGMA legacy_alter_table=ON;
ALTER TABLE commands RENAME TO commands_before_p0b;
CREATE TABLE commands (
  command_id TEXT PRIMARY KEY,
  client_mutation_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  actor_user_id TEXT NOT NULL REFERENCES users(user_id),
  actor_client_session_id TEXT NOT NULL REFERENCES client_sessions(client_session_id),
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
  execution_segment_id TEXT NOT NULL REFERENCES execution_segments(execution_segment_id),
  control_lease_id TEXT REFERENCES control_leases(control_lease_id),
  type TEXT NOT NULL CHECK (type IN ('thread.claim','turn.start','turn.queue','turn.steer','turn.cancel','approval.decide_once')),
  precondition_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_epoch INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(workspace_id, actor_client_session_id, client_mutation_id)
) STRICT;
INSERT INTO commands(
  command_id,client_mutation_id,payload_hash,workspace_id,actor_user_id,actor_client_session_id,
  logical_session_id,execution_segment_id,control_lease_id,type,precondition_json,payload_json,
  content_epoch,created_at,expires_at
)
SELECT command_id,client_mutation_id,payload_hash,workspace_id,actor_user_id,actor_client_session_id,
  logical_session_id,execution_segment_id,control_lease_id,type,precondition_json,payload_json,
  content_epoch,created_at,expires_at
FROM commands_before_p0b;
DROP TABLE commands_before_p0b;
PRAGMA legacy_alter_table=OFF;
CREATE INDEX commands_session_idx ON commands(logical_session_id, created_at);
CREATE TRIGGER commands_immutable_update BEFORE UPDATE ON commands
BEGIN SELECT RAISE(ABORT, 'commands are immutable'); END;
CREATE TRIGGER commands_immutable_delete BEFORE DELETE ON commands
BEGIN SELECT RAISE(ABORT, 'commands are immutable'); END;

ALTER TABLE logical_sessions ADD COLUMN queue_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE turn_queue (
  queue_item_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE REFERENCES commands(command_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
  actor_client_session_id TEXT NOT NULL REFERENCES client_sessions(client_session_id),
  accepted_queue_version INTEGER NOT NULL,
  position INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','dispatching','cancelled','expired','invalidated')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(logical_session_id, position)
) STRICT;
CREATE INDEX turn_queue_head_idx ON turn_queue(logical_session_id, state, position);
`;

const MIGRATION_12 = `
ALTER TABLE projects ADD COLUMN sync_content INTEGER NOT NULL DEFAULT 1 CHECK (sync_content IN (0,1));
ALTER TABLE projects ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 7 CHECK (retention_days IN (1,3,7,14,30));
`;

const MIGRATION_13 = `
DROP TRIGGER commands_immutable_update;
DROP TRIGGER commands_immutable_delete;
DROP INDEX commands_session_idx;
PRAGMA legacy_alter_table=ON;
ALTER TABLE commands RENAME TO commands_before_thread_release;
CREATE TABLE commands (
  command_id TEXT PRIMARY KEY,
  client_mutation_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  actor_user_id TEXT NOT NULL REFERENCES users(user_id),
  actor_client_session_id TEXT NOT NULL REFERENCES client_sessions(client_session_id),
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
  execution_segment_id TEXT NOT NULL REFERENCES execution_segments(execution_segment_id),
  control_lease_id TEXT REFERENCES control_leases(control_lease_id),
  type TEXT NOT NULL CHECK (type IN ('thread.claim','thread.release','turn.start','turn.queue','turn.steer','turn.cancel','approval.decide_once')),
  precondition_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_epoch INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(workspace_id, actor_client_session_id, client_mutation_id)
) STRICT;
INSERT INTO commands(
  command_id,client_mutation_id,payload_hash,workspace_id,actor_user_id,actor_client_session_id,
  logical_session_id,execution_segment_id,control_lease_id,type,precondition_json,payload_json,
  content_epoch,created_at,expires_at
)
SELECT command_id,client_mutation_id,payload_hash,workspace_id,actor_user_id,actor_client_session_id,
  logical_session_id,execution_segment_id,control_lease_id,type,precondition_json,payload_json,
  content_epoch,created_at,expires_at
FROM commands_before_thread_release;
DROP TABLE commands_before_thread_release;
PRAGMA legacy_alter_table=OFF;
CREATE INDEX commands_session_idx ON commands(logical_session_id, created_at);
CREATE TRIGGER commands_immutable_update BEFORE UPDATE ON commands
BEGIN SELECT RAISE(ABORT, 'commands are immutable'); END;
CREATE TRIGGER commands_immutable_delete BEFORE DELETE ON commands
BEGIN SELECT RAISE(ABORT, 'commands are immutable'); END;
`;

const MIGRATION_14 = `
ALTER TABLE machines ADD COLUMN command_types_json TEXT;
ALTER TABLE machines ADD COLUMN runtime_read_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE machines ADD COLUMN runtime_read_only_reasons_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE machines ADD COLUMN maintenance_types_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE machines ADD COLUMN discovery_json TEXT;
ALTER TABLE machines ADD COLUMN codex_profile_json TEXT;
ALTER TABLE enrollment_transactions ADD COLUMN preauthorized INTEGER NOT NULL DEFAULT 0;
ALTER TABLE enrollment_transactions ADD COLUMN consent_at TEXT;
ALTER TABLE logical_sessions ADD COLUMN management_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE logical_sessions ADD COLUMN codex_profile_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE logical_sessions ADD COLUMN session_cwd TEXT;
CREATE TABLE native_thread_bindings (
  machine_id TEXT NOT NULL REFERENCES machines(machine_id),
  codex_profile_id TEXT NOT NULL,
  native_thread_id TEXT NOT NULL,
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
  execution_segment_id TEXT NOT NULL REFERENCES execution_segments(execution_segment_id),
  PRIMARY KEY(machine_id,codex_profile_id,native_thread_id)
) STRICT;
INSERT INTO native_thread_bindings(machine_id,codex_profile_id,native_thread_id,logical_session_id,execution_segment_id)
SELECT machine_id,'default',native_thread_id,logical_session_id,execution_segment_id FROM (
  SELECT e.machine_id,e.native_thread_id,e.logical_session_id,e.execution_segment_id,
    row_number() OVER (PARTITION BY e.machine_id,e.native_thread_id ORDER BY
      EXISTS(SELECT 1 FROM commands c WHERE c.logical_session_id=e.logical_session_id) DESC,
      e.created_at,e.execution_segment_id) AS position
  FROM execution_segments e WHERE e.native_thread_id IS NOT NULL
) WHERE position=1;
CREATE INDEX sessions_filter_page_idx ON logical_sessions(workspace_id,project_id,updated_at,logical_session_id);
CREATE TABLE machine_operations (
  operation_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(machine_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  actor_client_session_id TEXT NOT NULL REFERENCES client_sessions(client_session_id),
  client_mutation_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('catalog.refresh','agent.update','runtime.reconnect','diagnostics.collect')),
  state TEXT NOT NULL CHECK(state IN ('accepted','running','succeeded','failed','unknown','expired')),
  result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(machine_id,actor_client_session_id,client_mutation_id)
) STRICT;
CREATE TABLE credential_renewal_challenges (
  challenge_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(machine_id),
  credential_id TEXT NOT NULL REFERENCES machine_credentials(credential_id),
  message TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  renewed_credential_id TEXT REFERENCES machine_credentials(credential_id),
  completed_at TEXT
) STRICT;
CREATE TABLE session_creation_requests (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  actor_client_session_id TEXT NOT NULL REFERENCES client_sessions(client_session_id),
  client_mutation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id),
  PRIMARY KEY(workspace_id,actor_client_session_id,client_mutation_id)
) STRICT;
`;

export type DbRow = Record<string, SQLInputValue>;

export class ControlPlaneDatabase {
  readonly sqlite: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") this.sqlite.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    const version = Number((this.sqlite.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (version > 28) throw new Error(`Database schema ${version} is newer than this binary`);
    let currentVersion = version;
    if (version < 1) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_1);
        this.sqlite.exec("PRAGMA user_version = 1");
      });
      currentVersion = 1;
    }
    if (currentVersion < 2) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_2);
        this.sqlite.exec("PRAGMA user_version = 2");
      });
      currentVersion = 2;
    }
    if (currentVersion < 3) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_3);
        this.sqlite.exec("PRAGMA user_version = 3");
      });
      currentVersion = 3;
    }
    if (currentVersion < 4) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_4);
        this.sqlite.exec("PRAGMA user_version = 4");
      });
      currentVersion = 4;
    }
    if (currentVersion < 5) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_5);
        this.sqlite.exec("PRAGMA user_version = 5");
      });
      currentVersion = 5;
    }
    if (currentVersion < 6) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_6);
        this.sqlite.exec("PRAGMA user_version = 6");
      });
      currentVersion = 6;
    }
    if (currentVersion < 7) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_7);
        this.sqlite.exec("PRAGMA user_version = 7");
      });
      currentVersion = 7;
    }
    if (currentVersion < 8) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_8);
        this.sqlite.exec("PRAGMA user_version = 8");
      });
      currentVersion = 8;
    }
    if (currentVersion < 9) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_9);
        this.sqlite.exec("PRAGMA user_version = 9");
      });
      currentVersion = 9;
    }
    if (currentVersion < 10) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_10);
        this.sqlite.exec("PRAGMA user_version = 10");
      });
      currentVersion = 10;
    }
    if (currentVersion < 11) {
      // Rebuilding the immutable commands table expands its CHECK constraint.
      // Keep child foreign keys pointed at the replacement table and verify
      // the entire graph before re-enabling enforcement.
      this.sqlite.exec("PRAGMA foreign_keys = OFF");
      try {
        this.transaction(() => {
          this.sqlite.exec(MIGRATION_11);
          this.sqlite.exec("PRAGMA user_version = 11");
        });
        const violation = this.sqlite.prepare("PRAGMA foreign_key_check").get();
        if (violation) throw new Error(`Database schema 11 foreign-key check failed: ${JSON.stringify(violation)}`);
      } finally {
        this.sqlite.exec("PRAGMA foreign_keys = ON");
      }
      currentVersion = 11;
    }
    if (currentVersion < 12) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_12);
        this.sqlite.exec("PRAGMA user_version = 12");
      });
      currentVersion = 12;
    }
    if (currentVersion < 13) {
      this.sqlite.exec("PRAGMA foreign_keys = OFF");
      try {
        this.transaction(() => {
          this.sqlite.exec(MIGRATION_13);
          this.sqlite.exec("PRAGMA user_version = 13");
        });
        const violation = this.sqlite.prepare("PRAGMA foreign_key_check").get();
        if (violation) throw new Error(`Database schema 13 foreign-key check failed: ${JSON.stringify(violation)}`);
      } finally {
        this.sqlite.exec("PRAGMA foreign_keys = ON");
      }
      currentVersion = 13;
    }
    if (currentVersion < 14) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_14);
        this.sqlite.exec("PRAGMA user_version = 14");
      });
    }
    if (currentVersion < 15) {
      this.transaction(() => {
        this.sqlite.exec("ALTER TABLE machines ADD COLUMN codex_catalog_json TEXT; ALTER TABLE logical_sessions ADD COLUMN runtime_settings_json TEXT;");
        this.sqlite.exec(`CREATE TABLE codex_preferences (
          workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
          scope TEXT NOT NULL CHECK(scope IN ('machine','project','session')),
          target_id TEXT NOT NULL, settings_json TEXT, revision INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL, PRIMARY KEY(workspace_id,scope,target_id)
        );`);
        this.sqlite.exec("PRAGMA user_version = 15");
      });
    }
    if (currentVersion < 16) {
      // Same immutable-table rebuild as v13, with a fixed v16 command vocabulary.
      const migration = MIGRATION_13.replaceAll("commands_before_thread_release", "commands_before_native_workbench")
        .replace("'thread.claim','thread.release','turn.start','turn.queue','turn.steer','turn.cancel','approval.decide_once'",
          "'thread.claim','thread.release','thread.rename','thread.archive','thread.unarchive','thread.fork','turn.start','turn.compact','turn.review','turn.queue','turn.steer','turn.cancel','approval.decide_once','input.respond','codex.inspect'");
      this.sqlite.exec("PRAGMA foreign_keys = OFF");
      try {
        this.transaction(() => {
          this.sqlite.exec(migration);
          const violation = this.sqlite.prepare("PRAGMA foreign_key_check").get();
          if (violation) throw new Error(`Database schema 16 foreign-key check failed: ${JSON.stringify(violation)}`);
          this.sqlite.exec("PRAGMA user_version = 16");
        });
      } finally { this.sqlite.exec("PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON"); }
    }
    if (currentVersion < 17) {
      const migration = MIGRATION_13.replaceAll("commands_before_thread_release", "commands_before_terminal_controls")
        .replace("'thread.claim','thread.release','turn.start','turn.queue','turn.steer','turn.cancel','approval.decide_once'",
          "'thread.claim','thread.release','thread.rename','thread.archive','thread.unarchive','thread.fork','turn.start','turn.compact','turn.review','turn.queue','turn.steer','turn.cancel','approval.decide_once','input.respond','codex.inspect','thread.terminals.stop'");
      this.sqlite.exec("PRAGMA foreign_keys = OFF");
      try {
        this.transaction(() => {
          this.sqlite.exec(migration);
          if (this.sqlite.prepare("PRAGMA foreign_key_check").get()) throw new Error("Database schema 17 foreign-key check failed");
          this.sqlite.exec("PRAGMA user_version = 17");
        });
      } finally { this.sqlite.exec("PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON"); }
    }
    if (currentVersion < 18) {
      this.transaction(() => {
        // Older-version migration fixtures may retain newer additive columns.
        const columns = this.sqlite.prepare("PRAGMA table_info(machines)").all() as { name: string }[];
        if (!columns.some(column => column.name === "paginated_history")) {
          this.sqlite.exec("ALTER TABLE machines ADD COLUMN paginated_history INTEGER NOT NULL DEFAULT 0 CHECK (paginated_history IN (0,1))");
        }
        this.sqlite.exec("PRAGMA user_version = 18");
      });
    }
    if (currentVersion < 19) {
      this.transaction(() => {
        const add = (table: string, column: string, definition: string) => {
          const columns = this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
          if (!columns.some(entry => entry.name === column)) this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        };
        add("machines", "permission_profiles", "INTEGER NOT NULL DEFAULT 0 CHECK(permission_profiles IN (0,1))");
        add("commands", "request_hash", "TEXT");
        this.sqlite.exec(`CREATE TABLE IF NOT EXISTS permission_preferences (
          workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
          scope TEXT NOT NULL CHECK(scope IN ('machine','project','session')),
          target_id TEXT NOT NULL, profile TEXT CHECK(profile IN ('project','network','full')),
          revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(workspace_id,scope,target_id)
        ); PRAGMA user_version = 19`);
      });
    }
    if (currentVersion < 20) {
      this.transaction(() => {
        const columns = this.sqlite.prepare("PRAGMA table_info(machines)").all() as { name: string }[];
        if (!columns.some(column => column.name === "cloud_image_revision")) this.sqlite.exec("ALTER TABLE machines ADD COLUMN cloud_image_revision INTEGER NOT NULL DEFAULT 0");
        this.sqlite.exec(`CREATE TABLE IF NOT EXISTS cloud_images (
            machine_id TEXT NOT NULL REFERENCES machines(machine_id), image_hash TEXT NOT NULL,
            data_url TEXT, size_bytes INTEGER NOT NULL CHECK(size_bytes>=0), created_at TEXT NOT NULL, deleted_at TEXT,
            PRIMARY KEY(machine_id,image_hash)
          ) STRICT;
          CREATE INDEX IF NOT EXISTS cloud_images_usage ON cloud_images(machine_id,size_bytes) WHERE data_url IS NOT NULL;
          CREATE TABLE IF NOT EXISTS cloud_image_refs (
            owner_type TEXT NOT NULL CHECK(owner_type IN ('command','event')), owner_id TEXT NOT NULL,
            machine_id TEXT NOT NULL, image_hash TEXT NOT NULL,
            PRIMARY KEY(owner_type,owner_id,machine_id,image_hash),
            FOREIGN KEY(machine_id,image_hash) REFERENCES cloud_images(machine_id,image_hash)
          ) STRICT;
          CREATE INDEX IF NOT EXISTS cloud_image_refs_asset ON cloud_image_refs(machine_id,image_hash);
          PRAGMA user_version = 20`);
        new CloudImages(this).migrateInlineImages();
      });
    }
    if (version < 21) {
      this.transaction(() => {
        const schema = this.get<{sql:string}>("SELECT sql FROM sqlite_master WHERE type='table' AND name='machine_operations'")!.sql;
        this.sqlite.exec("ALTER TABLE machine_operations RENAME TO machine_operations_before_recovery");
        this.sqlite.exec(schema.replace("'diagnostics.collect'", "'diagnostics.collect','session.reconcile'"));
        this.sqlite.exec("INSERT INTO machine_operations SELECT * FROM machine_operations_before_recovery; DROP TABLE machine_operations_before_recovery");
        if (!this.all<{name:string}>("PRAGMA table_info(machine_operations)").some(c=>c.name === "request_json")) this.sqlite.exec("ALTER TABLE machine_operations ADD COLUMN request_json TEXT");
        this.sqlite.exec("PRAGMA user_version = 21");
        if (this.all("PRAGMA foreign_key_check").length) throw new Error("Recovery migration violated foreign keys");
      });
    }

    if (version < 22) {
      const schema = this.get<{sql:string}>("SELECT sql FROM sqlite_master WHERE type='table' AND name='commands'")!.sql;
      const indexes = this.all<{sql:string}>("SELECT sql FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name='commands' AND sql IS NOT NULL");
      if (!schema.includes("'thread.fork'")) throw new Error("Unexpected command schema before deletion migration");
      this.sqlite.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON");
      try { this.transaction(() => {
        this.sqlite.exec("ALTER TABLE commands RENAME TO commands_before_native_deletion");
        this.sqlite.exec(schema.replace("'thread.fork'", "'thread.fork','thread.delete.preview','thread.delete'"));
        this.sqlite.exec("INSERT INTO commands SELECT * FROM commands_before_native_deletion; DROP TABLE commands_before_native_deletion");
        for (const index of indexes) this.sqlite.exec(index.sql);
        if (!this.all<{name:string}>("PRAGMA table_info(logical_sessions)").some(c=>c.name==="deleted_at")) this.sqlite.exec("ALTER TABLE logical_sessions ADD COLUMN deleted_at TEXT");
        this.sqlite.exec(`CREATE TABLE IF NOT EXISTS native_session_deletions (
          machine_id TEXT NOT NULL, codex_profile_id TEXT NOT NULL, native_thread_id TEXT NOT NULL,
          command_id TEXT NOT NULL, deleted_at TEXT NOT NULL, PRIMARY KEY(machine_id,codex_profile_id,native_thread_id)
        ) STRICT; PRAGMA user_version = 22`);
        if(this.all("PRAGMA foreign_key_check").length)throw new Error("Native deletion migration violated foreign keys");
      }); } finally {this.sqlite.exec("PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON");}
    }
    if (version < 23) {
      this.transaction(() => {
        const schema=this.get<{sql:string}>("SELECT sql FROM sqlite_master WHERE type='table' AND name='machine_operations'")!.sql;
        this.sqlite.exec("ALTER TABLE machine_operations RENAME TO machine_operations_before_journal");
        this.sqlite.exec(schema.replace("'session.reconcile'", "'session.reconcile','commands.reconcile'"));
        this.sqlite.exec("INSERT INTO machine_operations SELECT * FROM machine_operations_before_journal; DROP TABLE machine_operations_before_journal; PRAGMA user_version = 23");
        if(this.all("PRAGMA foreign_key_check").length)throw new Error("Journal recovery migration violated foreign keys");
      });
    }
    if (version < 24) {
      this.transaction(() => {
        const schema = this.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='turn_queue'")!.sql;
        this.sqlite.exec("ALTER TABLE turn_queue RENAME TO turn_queue_before_completion");
        this.sqlite.exec(schema.replace("'cancelled','expired','invalidated'", "'cancelled','expired','invalidated','applied','unknown'"));
        this.sqlite.exec(`INSERT INTO turn_queue SELECT * FROM turn_queue_before_completion;
          DROP TABLE turn_queue_before_completion;
          CREATE INDEX turn_queue_head_idx ON turn_queue(logical_session_id,state,position);
          PRAGMA user_version = 24`);
        if (this.all("PRAGMA foreign_key_check").length) throw new Error("Queue completion migration violated foreign keys");
      });
    }
    if (version < 25) {
      this.transaction(() => {
        const schema=this.get<{sql:string}>("SELECT sql FROM sqlite_master WHERE type='table' AND name='machine_operations'")!.sql;
        this.sqlite.exec("ALTER TABLE machine_operations RENAME TO machine_operations_before_images");
        this.sqlite.exec(schema.includes("'images.preview'") ? schema : schema.replace("'commands.reconcile'", "'commands.reconcile','images.preview','images.clean'"));
        this.sqlite.exec(`INSERT INTO machine_operations SELECT * FROM machine_operations_before_images;
          DROP TABLE machine_operations_before_images;
          CREATE TABLE IF NOT EXISTS image_uploads (
            machine_id TEXT NOT NULL, logical_session_id TEXT NOT NULL, execution_segment_id TEXT NOT NULL,
            command_id TEXT NOT NULL, image_hash TEXT NOT NULL, cleaned_at TEXT,
            PRIMARY KEY(machine_id,command_id,image_hash)
          ) STRICT;
          CREATE INDEX IF NOT EXISTS image_uploads_session ON image_uploads(machine_id,logical_session_id);
          CREATE TABLE IF NOT EXISTS image_cleaned_turns (
            machine_id TEXT NOT NULL, logical_session_id TEXT NOT NULL, native_thread_id TEXT NOT NULL,
            native_turn_id TEXT NOT NULL, image_hash TEXT NOT NULL,
            PRIMARY KEY(machine_id,logical_session_id,native_thread_id,native_turn_id,image_hash)
          ) STRICT;
          INSERT OR IGNORE INTO image_uploads(machine_id,logical_session_id,execution_segment_id,command_id,image_hash)
            SELECT r.machine_id,c.logical_session_id,c.execution_segment_id,c.command_id,r.image_hash
            FROM cloud_image_refs r JOIN commands c ON c.command_id=r.owner_id WHERE r.owner_type='command';
          PRAGMA user_version=25`);
        if(this.all("PRAGMA foreign_key_check").length)throw new Error("Image cleanup migration violated foreign keys");
      });
    }
    if (version < 26) this.transaction(() => {
      this.sqlite.exec(`CREATE TABLE session_usage (
        logical_session_id TEXT PRIMARY KEY REFERENCES logical_sessions(logical_session_id) ON DELETE CASCADE,
        native_thread_id TEXT NOT NULL, epoch TEXT NOT NULL, counters_json TEXT NOT NULL, last_json TEXT NOT NULL,
        recorded_json TEXT NOT NULL, first_at TEXT NOT NULL, observed_at TEXT NOT NULL, context_window INTEGER, discontinuities INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE usage_days (
        logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id) ON DELETE CASCADE, day TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL, reasoning_output_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL,
        PRIMARY KEY(logical_session_id,day)
      ) STRICT;
      CREATE TABLE machine_usage (
        machine_id TEXT PRIMARY KEY REFERENCES machines(machine_id) ON DELETE CASCADE, account_key TEXT, observed_at TEXT NOT NULL, windows_json TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version=26`);
    });
    if (version < 27) this.transaction(() => {
      this.sqlite.exec(`CREATE TABLE IF NOT EXISTS usage_intervals (
        id INTEGER PRIMARY KEY,
        logical_session_id TEXT NOT NULL REFERENCES logical_sessions(logical_session_id) ON DELETE CASCADE,
        starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, total_tokens INTEGER NOT NULL,
        precision TEXT NOT NULL CHECK(precision IN ('day','observation'))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS usage_intervals_session_time ON usage_intervals(logical_session_id,ends_at);
      INSERT INTO usage_intervals(logical_session_id,starts_at,ends_at,total_tokens,precision)
        SELECT logical_session_id,day || 'T00:00:00.000Z',day || 'T23:59:59.999Z',total_tokens,'day'
        FROM usage_days WHERE NOT EXISTS(SELECT 1 FROM usage_intervals);
      PRAGMA user_version=27`);
    });
    if (version < 28) this.transaction(() => {
      const columns=new Set(this.all<{name:string}>("PRAGMA table_info(usage_intervals)").map(column=>column.name));
      if(!columns.has("input_tokens"))this.sqlite.exec("ALTER TABLE usage_intervals ADD COLUMN input_tokens INTEGER");
      if(!columns.has("cached_input_tokens"))this.sqlite.exec("ALTER TABLE usage_intervals ADD COLUMN cached_input_tokens INTEGER");
      this.sqlite.exec("PRAGMA user_version=28");
    });
  }

  transaction<T>(operation: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  get<T extends object>(sql: string, ...values: SQLInputValue[]): T | undefined {
    return this.sqlite.prepare(sql).get(...values) as T | undefined;
  }

  all<T extends object>(sql: string, ...values: SQLInputValue[]): T[] {
    return this.sqlite.prepare(sql).all(...values) as T[];
  }

  run(sql: string, ...values: SQLInputValue[]): ReturnType<ReturnType<DatabaseSync["prepare"]>["run"]> {
    return this.sqlite.prepare(sql).run(...values);
  }

  bootstrap(config: ControlPlaneConfig): { workspaceId: string; userId: string } {
    return this.transaction(() => {
      const existing = this.get<{ user_id: string; workspace_id: string; email: string }>(
        "SELECT user_id, workspace_id, email FROM users LIMIT 1",
      );
      if (existing) {
        if (existing.email.toLowerCase() !== config.adminEmail.toLowerCase()) {
          throw new Error(
            `ADMIN_EMAIL (${config.adminEmail}) does not match bootstrapped admin (${existing.email})`,
          );
        }
        return { workspaceId: existing.workspace_id, userId: existing.user_id };
      }

      const workspaceId = newId("ws");
      const userId = newId("usr");
      const createdAt = nowIso();
      this.run(
        "INSERT INTO workspaces(workspace_id,name,created_at) VALUES(?,?,?)",
        workspaceId,
        "AgentFleet",
        createdAt,
      );
      this.run(
        "INSERT INTO users(user_id,workspace_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)",
        userId,
        workspaceId,
        config.adminEmail,
        hashPassword(config.adminPassword),
        "admin",
        createdAt,
      );
      return { workspaceId, userId };
    });
  }

  audit(input: {
    workspaceId: string;
    action: string;
    outcome?: string;
    actorUserId?: string | null;
    actorClientSessionId?: string | null;
    machineId?: string | null;
    projectId?: string | null;
    logicalSessionId?: string | null;
    controlLeaseId?: string | null;
    ipHash?: string | null;
    userAgentHash?: string | null;
    metadata?: Record<string, unknown>;
  }): string {
    const auditId = newId("audit");
    this.run(
      `INSERT INTO audit_entries(
        audit_id,workspace_id,actor_user_id,actor_client_session_id,machine_id,project_id,
        logical_session_id,control_lease_id,action,outcome,ip_hash,user_agent_hash,metadata_json,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      auditId,
      input.workspaceId,
      input.actorUserId ?? null,
      input.actorClientSessionId ?? null,
      input.machineId ?? null,
      input.projectId ?? null,
      input.logicalSessionId ?? null,
      input.controlLeaseId ?? null,
      input.action,
      input.outcome ?? "success",
      input.ipHash ?? null,
      input.userAgentHash ?? null,
      JSON.stringify(input.metadata ?? {}),
      nowIso(),
    );
    return auditId;
  }

  expireTransientState(now = nowIso()): void {
    this.transaction(() => {
      this.run(`UPDATE approvals SET state='rejected',version=version+1,decided_at=?
        WHERE state='pending' AND json_type(context_json,'$.expiresAt')='text' AND json_extract(context_json,'$.expiresAt')<=?`, now, now);
      this.run(
        "UPDATE pairing_transactions SET status='expired' WHERE status IN ('pending','confirmed') AND expires_at <= ?",
        now,
      );
      this.run(
        "UPDATE enrollment_transactions SET status='expired' WHERE status IN ('created','claimed','confirmed') AND expires_at <= ?",
        now,
      );
      const expiredLeases = this.all<{
        control_lease_id: string;
        logical_session_id: string;
        workspace_id: string;
        holder_client_session_id: string;
      }>(
        `SELECT l.control_lease_id,l.logical_session_id,s.workspace_id,l.holder_client_session_id
         FROM control_leases l JOIN logical_sessions s ON s.logical_session_id=l.logical_session_id
         WHERE l.state='active' AND l.expires_at<=?`,
        now,
      );
      for (const lease of expiredLeases) {
        this.run(
          `UPDATE control_leases SET state='expired',version=version+1,ended_at=?
           WHERE control_lease_id=? AND state='active'`,
          now,
          lease.control_lease_id,
        );
        this.run(
          `UPDATE logical_sessions SET control_lease_version=control_lease_version+1,updated_at=?
           WHERE logical_session_id=?`,
          now,
          lease.logical_session_id,
        );
        this.audit({
          workspaceId: lease.workspace_id,
          logicalSessionId: lease.logical_session_id,
          controlLeaseId: lease.control_lease_id,
          action: "control_lease.expire",
          metadata: { previousHolderClientSessionId: lease.holder_client_session_id },
        });
      }
      this.run("DELETE FROM agent_challenges WHERE expires_at <= ? OR consumed_at IS NOT NULL", now);
      this.run("DELETE FROM agent_tickets WHERE expires_at <= ? OR consumed_at IS NOT NULL", now);
    });
  }

  close(): void {
    this.sqlite.close();
  }
}
