import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { MAX_PROJECTS, STATE_SCHEMA_VERSION } from "./constants.js";
import { AgentError } from "./errors.js";
import type {
  AgentState,
  ApprovalRecord,
  DiscoveredThread,
  DurableAgentEvent,
  FleetCommand,
  InboxEntry,
  InboxState,
  ManagedThread,
  NativeThreadBinding,
  MaintenanceOperation,
  PairingCredential,
  ProjectCommandReservation,
  ProjectDiscoveryStatus,
  ProjectRecord,
} from "./types.js";
import { canonicalJson, identifier, isRecord, nowIso, sha256 } from "./util.js";

const execFileAsync = promisify(execFile);

function emptyState(): AgentState {
  return {
    nativeDeletionTombstones: {},
    schemaVersion: STATE_SCHEMA_VERSION,
    projects: [],
    lastTransportGeneration: 0,
    producerStreams: {},
    inbox: {},
    commandJournal: {},
    projectReservations: {},
    outbox: [],
    approvals: {},
    managedThreads: {},
    discoveredThreads: {},
    projectDiscovery: {},
    projectContentPolicies: {},
    nativeThreadBindings: {},
    maintenanceOperations: {},
  };
}

function externalProjectActivity(
  state: AgentState,
  projectId: string,
  appServerEpoch: string,
): DiscoveredThread | undefined {
  const discovery = state.projectDiscovery[projectId];
  if (
    !discovery ||
    discovery.projectId !== projectId ||
    discovery.appServerEpoch !== appServerEpoch ||
    discovery.state !== "healthy"
  ) {
    throw new AgentError(
      "PROJECT_DISCOVERY_UNAVAILABLE",
      "the current App Server epoch has not completed a successful thread discovery for this project",
    );
  }
  return Object.values(state.discoveredThreads).find(
    (thread) =>
      thread.projectId === projectId &&
      thread.availability === "available" &&
      (thread.executionState === "running" || thread.executionState === "unknown"),
  );
}

function validateState(value: unknown): AgentState {
  if (typeof value !== "object" || value === null) throw new AgentError("STATE_CORRUPT", "state is not an object");
  const candidate = value as Omit<Partial<AgentState>, "schemaVersion"> & { schemaVersion?: number };
  if (candidate.schemaVersion !== 1 && candidate.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new AgentError("STATE_VERSION_UNSUPPORTED", `unsupported state schema ${String(candidate.schemaVersion)}`);
  }
  if (
    !Array.isArray(candidate.projects) ||
    typeof candidate.producerStreams !== "object" ||
    candidate.producerStreams === null ||
    typeof candidate.inbox !== "object" ||
    candidate.inbox === null ||
    !Array.isArray(candidate.outbox) ||
    typeof candidate.approvals !== "object" ||
    candidate.approvals === null ||
    typeof candidate.managedThreads !== "object" ||
    candidate.managedThreads === null
  ) {
    throw new AgentError("STATE_CORRUPT", "state is missing a required collection");
  }
  if (candidate.discoveredThreads === undefined) candidate.discoveredThreads = {};
  if (candidate.projectDiscovery === undefined) candidate.projectDiscovery = {};
  if (candidate.projectContentPolicies === undefined) candidate.projectContentPolicies = {};
  if (candidate.nativeThreadBindings === undefined) candidate.nativeThreadBindings = {};
  if (candidate.maintenanceOperations === undefined) candidate.maintenanceOperations = {};
  if (typeof candidate.nativeThreadBindings !== "object" || candidate.nativeThreadBindings === null) {
    throw new AgentError("STATE_CORRUPT", "state nativeThreadBindings is invalid");
  }
  if (typeof candidate.discoveredThreads !== "object" || candidate.discoveredThreads === null) {
    throw new AgentError("STATE_CORRUPT", "state discoveredThreads is invalid");
  }
  if (typeof candidate.projectDiscovery !== "object" || candidate.projectDiscovery === null) {
    throw new AgentError("STATE_CORRUPT", "state projectDiscovery is invalid");
  }
  if (typeof candidate.projectContentPolicies !== "object" || candidate.projectContentPolicies === null) {
    throw new AgentError("STATE_CORRUPT", "state projectContentPolicies is invalid");
  }
  for (const [projectId, rawStatus] of Object.entries(candidate.projectDiscovery)) {
    const status = rawStatus as Partial<ProjectDiscoveryStatus> | null;
    if (
      typeof status !== "object" ||
      status === null ||
      status.projectId !== projectId ||
      typeof status.appServerEpoch !== "string" ||
      (status.state !== "healthy" && status.state !== "unavailable") ||
      typeof status.lastAttemptAt !== "string" ||
      (status.lastSuccessfulAt !== undefined && typeof status.lastSuccessfulAt !== "string")
    ) {
      throw new AgentError("STATE_CORRUPT", `state projectDiscovery entry ${projectId} is invalid`);
    }
  }
  if (!Number.isSafeInteger(candidate.lastTransportGeneration) || Number(candidate.lastTransportGeneration) < 0) {
    candidate.lastTransportGeneration = 0;
  }
  if (candidate.nativeDeletionTombstones === undefined) candidate.nativeDeletionTombstones = {};
  if (!isRecord(candidate.nativeDeletionTombstones) || Object.entries(candidate.nativeDeletionTombstones).some(([id, timestamp]) => !id || typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp)))) throw new AgentError("STATE_CORRUPT", "state native deletion tombstones are invalid");
  if (candidate.commandJournal === undefined) candidate.commandJournal = {};
  if (candidate.projectReservations === undefined) candidate.projectReservations = {};
  if (
    typeof candidate.commandJournal !== "object" || candidate.commandJournal === null ||
    typeof candidate.projectReservations !== "object" || candidate.projectReservations === null
  ) {
    throw new AgentError("STATE_CORRUPT", "state command journal or project reservations are invalid");
  }
  if (candidate.schemaVersion === 1) {
    for (const entry of Object.values(candidate.inbox)) {
      const legacy = entry as InboxEntry & { payloadHash?: string };
      if (typeof legacy.envelopeHash !== "string") {
        legacy.envelopeHash = `legacy:${legacy.payloadHash ?? "unknown"}`;
      }
    }
    candidate.schemaVersion = STATE_SCHEMA_VERSION;
  }
  for (const thread of Object.values(candidate.managedThreads)) {
    if (!thread.logicalSessionId || !thread.executionSegmentId) continue;
    candidate.nativeThreadBindings[thread.nativeThreadId] ??= {
      nativeThreadId: thread.nativeThreadId,
      codexProfileId: thread.codexProfileId ?? "default",
      projectId: thread.projectId,
      logicalSessionId: thread.logicalSessionId,
      executionSegmentId: thread.executionSegmentId,
      managementRevision: thread.managementRevision ?? 1,
      managed: true,
      contentEpoch: thread.contentEpoch ?? 1,
      ...(thread.sessionCwd === undefined ? {} : { sessionCwd: thread.sessionCwd }),
    };
  }
  return candidate as AgentState;
}

interface StateRow {
  schema_version: number;
  state_json: string;
}

interface RuntimeOwnerRow {
  owner_token: string;
  pid: number;
  process_start_token: string;
  acquired_at: string;
}

export interface RuntimeOwnershipLease {
  ownerToken: string;
  pid: number;
  processStartToken: string;
  acquiredAt: string;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}

function sameRuntimeOwner(left: RuntimeOwnerRow | undefined, right: RuntimeOwnerRow | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.owner_token === right.owner_token &&
    left.pid === right.pid &&
    left.process_start_token === right.process_start_token &&
    left.acquired_at === right.acquired_at
  );
}

/** Linux /proc field 22 identifies a process incarnation and defeats PID reuse. */
export async function linuxProcessStartToken(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const statLine = await readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = statLine.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    const fieldsAfterCommand = statLine.slice(commandEnd + 1).trim().split(/\s+/u);
    // fieldsAfterCommand[0] is field 3 (state), so field 22 is index 19.
    const token = fieldsAfterCommand[19];
    return token && /^\d+$/u.test(token) ? token : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Stable-enough process incarnation token for the three P0b host families. */
export async function platformProcessStartToken(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") return linuxProcessStartToken(pid);
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        timeout: 5_000,
        maxBuffer: 16_384,
        encoding: "utf8",
      });
      const started = stdout.trim();
      return started ? `darwin:${started}` : undefined;
    }
    if (process.platform === "win32") {
      const script = `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").CreationDate.ToUniversalTime().Ticks`;
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { timeout: 8_000, windowsHide: true, maxBuffer: 16_384, encoding: "utf8" },
      );
      const started = stdout.trim();
      return /^\d+$/u.test(started) ? `windows:${started}` : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export interface EventInput {
  machineId: string;
  producerEpoch: string;
  appServerEpoch?: string;
  type: string;
  payload: Record<string, unknown>;
  logicalSessionId?: string;
  executionSegmentId?: string;
  projectId?: string;
  nativeThreadId?: string;
  nativeTurnId?: string;
  nativeItemId?: string;
  contentEpoch?: number;
}

function appendEventToState(state: AgentState, input: EventInput): DurableAgentEvent {
  const stream = state.producerStreams[input.producerEpoch];
  if (!stream) throw new AgentError("PRODUCER_EPOCH_UNKNOWN", "producer epoch has not been initialized");
  const contentEpoch = input.contentEpoch ?? 1;
  if (!Number.isSafeInteger(contentEpoch) || contentEpoch < 1) {
    throw new AgentError("CONTENT_EPOCH_INVALID", "event content epoch must be a positive integer");
  }
  const syncContent = ["thread.released", "thread.claimed"].includes(input.type) ||
    input.projectId === undefined || state.projectContentPolicies[input.projectId]?.syncContent !== false;
  const payload = syncContent ? structuredClone(input.payload) : { suppressed: true };
  const event: DurableAgentEvent = {
    ...input,
    eventId: identifier("evt"),
    sourceKind: "agent",
    hostSeq: stream.lastProducedSeq + 1,
    schemaVersion: "1.0",
    contentEpoch,
    occurredAt: nowIso(),
    payload,
    payloadHash: sha256(canonicalJson(payload)),
    ...(syncContent ? {} : { payloadState: "suppressed" as const }),
  };
  stream.lastProducedSeq = event.hostSeq;
  state.outbox.push(event);
  return structuredClone(event);
}

function bindDiscovery(state: AgentState, thread: Omit<DiscoveredThread, "firstSeenAt" | "lastSeenAt" | "lastReconciledAt">): NativeThreadBinding {
  const existing = state.nativeThreadBindings[thread.nativeThreadId];
  const binding: NativeThreadBinding = {
    nativeThreadId: thread.nativeThreadId,
    codexProfileId: thread.codexProfileId ?? existing?.codexProfileId ?? "default",
    projectId: thread.projectId,
    logicalSessionId: existing?.logicalSessionId ?? thread.externalId,
    executionSegmentId: existing?.executionSegmentId ?? thread.executionSegmentExternalId,
    managementRevision: existing?.managementRevision ?? 1,
    managed: existing?.managed ?? false,
    contentEpoch: existing?.contentEpoch ?? 1,
    ...(thread.sessionCwd === undefined ? {} : { sessionCwd: thread.sessionCwd }),
    title: thread.title,
  };
  state.nativeThreadBindings[thread.nativeThreadId] = binding;
  return binding;
}

export class StateStore {
  readonly dataDir: string;
  readonly statePath: string;
  readonly legacyStatePath: string;
  readonly legacyBackupPath: string;
  readonly privateKeyPath: string;
  private state: AgentState = emptyState();
  private database: DatabaseSync | undefined;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.statePath = join(dataDir, "state.sqlite");
    this.legacyStatePath = join(dataDir, "state.json");
    this.legacyBackupPath = join(dataDir, "state.json.imported.bak");
    this.privateKeyPath = join(dataDir, "machine-ed25519.pem");
  }

  async initialize(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.dataDir, 0o700);
    if (this.database?.isOpen) {
      this.state = this.readCurrentState();
      return;
    }

    const databaseFile = await open(this.statePath, "a", 0o600);
    await databaseFile.close();
    await chmod(this.statePath, 0o600);

    const database = new DatabaseSync(this.statePath, { allowExtension: false });
    this.database = database;
    try {
      database.exec("PRAGMA foreign_keys = ON");
      database.exec("PRAGMA busy_timeout = 5000");
      database.exec("PRAGMA journal_mode = WAL");
      database.exec("PRAGMA synchronous = FULL");
      const foreignKeys = database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
      const busyTimeout = database.prepare("PRAGMA busy_timeout").get() as { timeout: number };
      const journalMode = database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      const synchronous = database.prepare("PRAGMA synchronous").get() as { synchronous: number };
      if (
        foreignKeys.foreign_keys !== 1 ||
        busyTimeout.timeout !== 5_000 ||
        journalMode.journal_mode.toLowerCase() !== "wal" ||
        synchronous.synchronous !== 2
      ) {
        throw new AgentError("SQLITE_CONFIGURATION_FAILED", "required durable SQLite pragmas could not be enabled");
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS agent_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          schema_version INTEGER NOT NULL,
          state_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS history_item_receipts (
          native_thread_id TEXT NOT NULL, content_epoch INTEGER NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
          PRIMARY KEY(native_thread_id, content_epoch, turn_id, item_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS runtime_owner (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          owner_token TEXT NOT NULL UNIQUE,
          pid INTEGER NOT NULL CHECK (pid > 0),
          process_start_token TEXT NOT NULL,
          acquired_at TEXT NOT NULL
        ) STRICT;
      `);

      const existingBeforeImport = this.readStateRow();
      const legacy = existingBeforeImport ? undefined : await this.readLegacyState();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = this.readStateRow();
        if (!row) {
          const initial = legacy?.state ?? emptyState();
          database.prepare(
            "INSERT INTO agent_state (singleton, schema_version, state_json, updated_at) VALUES (1, ?, ?, ?)",
          ).run(STATE_SCHEMA_VERSION, JSON.stringify(initial), nowIso());
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      this.state = this.readCurrentState();
      await chmod(this.statePath, 0o600);
      if (legacy?.sourcePath === this.legacyStatePath || existingBeforeImport) await this.preserveLegacyBackupIfPresent();
    } catch (error) {
      database.close();
      this.database = undefined;
      throw error;
    }
  }

  snapshot(): AgentState {
    this.state = this.readCurrentState();
    return structuredClone(this.state);
  }

  externalProjectActivity(projectId: string, appServerEpoch: string): DiscoveredThread | undefined {
    const activity = externalProjectActivity(this.snapshot(), projectId, appServerEpoch);
    return activity ? structuredClone(activity) : undefined;
  }

  update<T>(mutator: (draft: AgentState) => T | Promise<T>): Promise<T> {
    const database = this.requireDatabase();
    try {
      database.exec("BEGIN IMMEDIATE");
      try {
        const draft = structuredClone(this.readCurrentState());
        const value = mutator(draft);
        if (isPromiseLike(value)) {
          void Promise.resolve(value).catch(() => undefined);
          throw new AgentError(
            "ASYNC_STATE_MUTATOR_UNSUPPORTED",
            "state update callbacks must be synchronous so the SQLite write transaction cannot span an event-loop turn",
          );
        }
        const validated = validateState(draft);
        const result = database.prepare(
          "UPDATE agent_state SET schema_version = ?, state_json = ?, updated_at = ? WHERE singleton = 1",
        ).run(STATE_SCHEMA_VERSION, JSON.stringify(validated), nowIso());
        if (Number(result.changes) !== 1) throw new AgentError("STATE_CORRUPT", "SQLite state snapshot is missing");
        database.exec("COMMIT");
        this.state = validated;
        return Promise.resolve(value);
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async acquireRuntimeOwnership(): Promise<RuntimeOwnershipLease> {
    const database = this.requireDatabase();
    const processStartToken = await platformProcessStartToken(process.pid);
    if (!processStartToken) {
      throw new AgentError("PROCESS_IDENTITY_UNAVAILABLE", "cannot read the current process start token");
    }

    for (;;) {
      const observed = this.readRuntimeOwner();
      const observedStart = observed === undefined ? undefined : await platformProcessStartToken(observed.pid);
      const observedIsLive = observed !== undefined && observedStart === observed.process_start_token;
      database.exec("BEGIN IMMEDIATE");
      try {
        const locked = this.readRuntimeOwner();
        if (!sameRuntimeOwner(observed, locked)) {
          database.exec("ROLLBACK");
          continue;
        }
        if (locked && observedIsLive) {
          throw new AgentError(
            "RUNTIME_ALREADY_RUNNING",
            `another agentfleet runtime owns this data directory (pid ${locked.pid})`,
          );
        }
        if (locked) database.prepare("DELETE FROM runtime_owner WHERE singleton = 1").run();
        const lease: RuntimeOwnershipLease = {
          ownerToken: randomUUID(),
          pid: process.pid,
          processStartToken,
          acquiredAt: nowIso(),
        };
        database.prepare(
          "INSERT INTO runtime_owner (singleton, owner_token, pid, process_start_token, acquired_at) VALUES (1, ?, ?, ?, ?)",
        ).run(lease.ownerToken, lease.pid, lease.processStartToken, lease.acquiredAt);
        database.exec("COMMIT");
        return lease;
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    }
  }

  async releaseRuntimeOwnership(lease: RuntimeOwnershipLease): Promise<boolean> {
    const database = this.requireDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = database.prepare(
        "DELETE FROM runtime_owner WHERE singleton = 1 AND owner_token = ? AND pid = ? AND process_start_token = ?",
      ).run(lease.ownerToken, lease.pid, lease.processStartToken);
      database.exec("COMMIT");
      return Number(result.changes) === 1;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (!this.database?.isOpen) return;
    if (this.database.isTransaction) this.database.exec("ROLLBACK");
    this.database.close();
    this.database = undefined;
  }

  private requireDatabase(): DatabaseSync {
    if (!this.database?.isOpen) throw new AgentError("STATE_NOT_INITIALIZED", "state store has not been initialized");
    return this.database;
  }

  private readStateRow(): StateRow | undefined {
    return this.requireDatabase().prepare(
      "SELECT schema_version, state_json FROM agent_state WHERE singleton = 1",
    ).get() as StateRow | undefined;
  }

  private readCurrentState(): AgentState {
    const row = this.readStateRow();
    if (!row) throw new AgentError("STATE_CORRUPT", "SQLite state snapshot is missing");
    if (row.schema_version !== STATE_SCHEMA_VERSION) {
      throw new AgentError("STATE_VERSION_UNSUPPORTED", `unsupported SQLite state schema ${row.schema_version}`);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.state_json) as unknown;
    } catch {
      throw new AgentError("STATE_CORRUPT", "SQLite state snapshot is not valid JSON");
    }
    const validated = validateState(decoded);
    if (validated.schemaVersion !== row.schema_version) {
      throw new AgentError("STATE_CORRUPT", "SQLite state row and snapshot schema versions disagree");
    }
    return validated;
  }

  private readRuntimeOwner(): RuntimeOwnerRow | undefined {
    return this.requireDatabase().prepare(
      "SELECT owner_token, pid, process_start_token, acquired_at FROM runtime_owner WHERE singleton = 1",
    ).get() as RuntimeOwnerRow | undefined;
  }

  private async readLegacyState(): Promise<{ state: AgentState; sourcePath: string } | undefined> {
    // Once a backup exists it is the immutable import source; a leftover
    // state.json may have been changed after an earlier successful migration.
    for (const sourcePath of [this.legacyBackupPath, this.legacyStatePath]) {
      try {
        const decoded = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
        await chmod(sourcePath, 0o600);
        return { state: validateState(decoded), sourcePath };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    return undefined;
  }

  private async preserveLegacyBackupIfPresent(): Promise<void> {
    try {
      const existing = await open(this.legacyBackupPath, "r");
      await existing.close();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      let contents: Buffer;
      try {
        contents = await readFile(this.legacyStatePath);
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") return;
        throw readError;
      }
      const temporaryPath = `${this.legacyBackupPath}.tmp-${process.pid}-${randomUUID()}`;
      const temporary = await open(temporaryPath, "wx", 0o600);
      try {
        await temporary.writeFile(contents);
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.legacyBackupPath);
      const directory = await open(this.dataDir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    await chmod(this.legacyBackupPath, 0o600);
    try {
      await chmod(this.legacyStatePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async setIdentity(identity: NonNullable<AgentState["identity"]>): Promise<void> {
    await this.update((state) => {
      state.identity = identity;
    });
  }

  async setPairing(pairing: PairingCredential): Promise<void> {
    await this.update((state) => {
      state.pairing = pairing;
    });
  }

  async recordMaintenance(operation: MaintenanceOperation): Promise<void> {
    await this.update((state) => {
      const previous = state.maintenanceOperations[operation.operationId];
      if (previous && previous.operationType !== operation.operationType) throw new AgentError("MAINTENANCE_CONFLICT", "operation id was already used for a different action");
      state.maintenanceOperations[operation.operationId] = structuredClone(operation);
      const terminal = Object.values(state.maintenanceOperations).filter((item) => item.state !== "running").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      for (const old of terminal.slice(200)) if (old.operationType !== "images.clean") delete state.maintenanceOperations[old.operationId];
    });
  }

  async setMaintenanceDrain(operationId: string | undefined): Promise<void> {
    await this.update((state) => {
      if (operationId === undefined) delete state.maintenanceDrain;
      else if (state.maintenanceDrain && state.maintenanceDrain.operationId !== operationId) throw new AgentError("MAINTENANCE_BUSY", "another maintenance operation is draining the agent");
      else state.maintenanceDrain = { operationId, startedAt: nowIso() };
    });
  }

  canSafelyRestart(): boolean {
    const state = this.snapshot();
    return !Object.values(state.maintenanceOperations).some(operation => operation.state === "running" && ["images.preview", "images.clean"].includes(operation.operationType)) &&
      !Object.values(state.managedThreads).some((thread) => thread.activeTurnId !== undefined) &&
      !Object.values(state.approvals).some((approval) => approval.state === "pending" || approval.state === "delivery_unknown") &&
      !Object.values(state.commandJournal).some((command) => ["claimed", "invoking", "responded", "unknown"].includes(command.state)) &&
      Object.keys(state.projectReservations).length === 0;
  }

  async addProject(project: ProjectRecord): Promise<void> {
    await this.update((state) => {
      const sameAlias = state.projects.find(
        (entry) => (entry.source ?? "explicit") === "explicit" && entry.alias === project.alias,
      );
      if (sameAlias && sameAlias.root !== project.root) {
        throw new AgentError("PROJECT_ALIAS_EXISTS", `project alias '${project.alias}' is already in use`);
      }
      const existing = state.projects.find((entry) => entry.root === project.root);
      if (existing) {
        existing.alias = project.alias;
        existing.device = project.device;
        existing.inode = project.inode;
        existing.identityVersion += 1;
        if (project.source !== "bootstrap_fallback") existing.source = project.source ?? "explicit";
        return;
      }
      if (state.projects.length >= MAX_PROJECTS) {
        throw new AgentError("PROJECT_LIMIT_REACHED", `P0a supports at most ${MAX_PROJECTS} authorized projects`);
      }
      state.projects.push(project);
    });
  }

  async beginProducerEpoch(epoch: string): Promise<void> {
    await this.update((state) => {
      state.activeProducerEpoch = epoch;
      state.producerStreams[epoch] = { lastProducedSeq: 0, lastAckedSeq: 0 };
    });
  }

  async reserveTransportGeneration(): Promise<number> {
    return this.update((state) => {
      state.lastTransportGeneration += 1;
      return state.lastTransportGeneration;
    });
  }

  async appendEvent(input: EventInput): Promise<DurableAgentEvent> {
    return this.update((state) => {
      const event = appendEventToState(state,input);
      if (input.type === "item.completed" && input.nativeThreadId && input.nativeTurnId && input.nativeItemId) this.rememberHistoryItem(input);
      return event;
    });
  }

  async setProjectContentPolicy(projectId: string, syncContent: boolean, retentionDays: number): Promise<void> {
    await this.update((state) => {
      state.projectContentPolicies[projectId] = { syncContent, retentionDays };
      if (syncContent) return;
      for (const event of state.outbox) {
        if (event.projectId !== projectId || event.payloadState === "suppressed" || ["thread.released", "thread.claimed"].includes(event.type)) continue;
        event.payload = { suppressed: true };
        event.payloadState = "suppressed";
        event.payloadHash = sha256(canonicalJson({ suppressed: true }));
      }
    });
  }

  async acknowledge(epoch: string, throughHostSeq: number): Promise<void> {
    await this.update((state) => {
      const stream = state.producerStreams[epoch];
      if (!stream) throw new AgentError("ACK_EPOCH_UNKNOWN", "ack references an unknown producer epoch");
      if (!Number.isSafeInteger(throughHostSeq) || throughHostSeq < stream.lastAckedSeq || throughHostSeq > stream.lastProducedSeq) {
        throw new AgentError("ACK_RANGE_INVALID", "ack is outside the produced sequence range");
      }
      stream.lastAckedSeq = throughHostSeq;
      state.outbox = state.outbox.filter(
        (event) => event.producerEpoch !== epoch || event.hostSeq > throughHostSeq,
      );
    });
  }

  private rememberHistoryItem(event: Pick<EventInput,"nativeThreadId"|"contentEpoch"|"nativeTurnId"|"nativeItemId">): boolean {
    return Number(this.requireDatabase().prepare("INSERT OR IGNORE INTO history_item_receipts(native_thread_id,content_epoch,turn_id,item_id) VALUES(?,?,?,?)")
      .run(event.nativeThreadId!,event.contentEpoch ?? 1,event.nativeTurnId!,event.nativeItemId!).changes) === 1;
  }

  async appendHistoryBatch(nativeThreadId: string, events: EventInput[], cursor: string, checkpoint?: ManagedThread["historyPage"], skipped: {nativeTurnId:string;nativeItemId:string}[] = []): Promise<number> {
    return this.update((state) => {
      const thread = state.managedThreads[nativeThreadId];
      if (!thread) throw new AgentError("THREAD_NOT_MANAGED", "History target was released");
      let imported = 0;
      for (const item of skipped) this.rememberHistoryItem({...item,nativeThreadId,contentEpoch:thread.contentEpoch ?? 1});
      for (const event of events) {
        if (event.nativeThreadId !== nativeThreadId || event.executionSegmentId !== thread.executionSegmentId ||
          event.contentEpoch !== (thread.contentEpoch ?? 1)) {
          throw new AgentError("PRECONDITION_INVALID", "History target changed during import");
        }
        if (this.rememberHistoryItem(event)) { appendEventToState(state, event); imported++; }
      }
      if (checkpoint) { thread.historyPage = checkpoint; thread.historySyncInitialized = thread.historySyncInitialized || checkpoint.complete; thread.historyItemCount = (thread.historyItemCount ?? 0) + imported; }
      // Commit the cursor with its events so interruption cannot duplicate a batch.
      if (cursor) thread.historyCursor = cursor;
      return imported;
    });
  }

  async acknowledgeEvents(eventIds: ReadonlySet<string>): Promise<void> {
    await this.update(state => {
      const through = new Map<string, number>();
      for (const event of state.outbox) {
        if (eventIds.has(event.eventId)) through.set(event.producerEpoch, Math.max(through.get(event.producerEpoch) ?? 0, event.hostSeq));
      }
      for (const [epoch, seq] of through) state.producerStreams[epoch]!.lastAckedSeq = seq;
      state.outbox = state.outbox.filter(event => event.hostSeq > (through.get(event.producerEpoch) ?? 0));
    });
  }

  async claimCommand(command: FleetCommand, envelopeHash: string): Promise<{ entry: InboxEntry; isNew: boolean }> {
    return this.update((state) => {
      const existing = state.inbox[command.attemptId];
      if (existing) {
        const journal = state.commandJournal[command.commandId];
        if (!journal || existing.envelopeHash.startsWith("legacy:")) {
          throw new AgentError("LEGACY_COMMAND_REPLAY_UNSAFE", "legacy command state cannot prove an immutable replay envelope");
        }
        if (
          existing.envelopeHash !== envelopeHash ||
          journal.envelopeHash !== envelopeHash ||
          existing.commandId !== command.commandId
        ) {
          throw new AgentError("INBOX_CORRUPTION", "attempt id was reused with different immutable content");
        }
        if (!["applied", "rejected", "unknown"].includes(journal.state)) {
          const timestamp = nowIso();
          const failure = {
            code: "COMMAND_OUTCOME_UNCERTAIN",
            message: `command replay encountered persisted non-terminal state '${journal.state}'`,
          };
          journal.state = "unknown";
          journal.error = failure;
          journal.updatedAt = timestamp;
          for (const item of Object.values(state.inbox)) {
            if (item.commandId !== command.commandId) continue;
            item.state = "unknown";
            item.error = failure;
            item.updatedAt = timestamp;
          }
          const reservation = Object.values(state.projectReservations).find(
            (candidate) => candidate.commandId === command.commandId,
          );
          if (reservation) {
            reservation.state = "unknown";
            reservation.updatedAt = timestamp;
          }
        }
        return { entry: structuredClone(existing), isNew: false };
      }
      const journal = state.commandJournal[command.commandId];
      if (journal) {
        if (journal.envelopeHash !== envelopeHash) {
          throw new AgentError("COMMAND_ENVELOPE_CONFLICT", "command id was reused with different immutable content");
        }
        if (!["applied", "rejected", "unknown"].includes(journal.state)) {
          const failure = {
            code: "COMMAND_OUTCOME_UNCERTAIN",
            message: `command replay encountered persisted non-terminal state '${journal.state}'`,
          };
          journal.state = "unknown";
          journal.error = failure;
          journal.updatedAt = nowIso();
          for (const item of Object.values(state.inbox)) {
            if (item.commandId === command.commandId && !["applied", "rejected", "unknown"].includes(item.state)) {
              item.state = "unknown";
              item.error = failure;
              item.updatedAt = journal.updatedAt;
            }
          }
          const reservation = state.projectReservations[command.projectId];
          if (reservation?.commandId === command.commandId) {
            reservation.state = "unknown";
            reservation.updatedAt = journal.updatedAt;
          }
        }
        const receivedAt = nowIso();
        const replay: InboxEntry = {
          attemptId: command.attemptId,
          commandId: command.commandId,
          commandType: command.type,
          envelopeHash,
          state: journal.state,
          receivedAt,
          updatedAt: receivedAt,
          replayedFromAttemptId: journal.canonicalAttemptId,
          ...(journal.invokingAt === undefined ? {} : { invokingAt: journal.invokingAt }),
          ...(journal.response === undefined ? {} : { response: structuredClone(journal.response) }),
          ...(journal.error === undefined ? {} : { error: structuredClone(journal.error) }),
        };
        state.inbox[command.attemptId] = replay;
        return { entry: structuredClone(replay), isNew: false };
      }
      const legacy = Object.values(state.inbox).find((entry) => entry.commandId === command.commandId);
      if (legacy) {
        throw new AgentError("LEGACY_COMMAND_REPLAY_UNSAFE", "legacy command state cannot prove an immutable replay envelope");
      }
      const now = nowIso();
      const entry: InboxEntry = {
        attemptId: command.attemptId,
        commandId: command.commandId,
        commandType: command.type,
        envelopeHash,
        state: "claimed",
        receivedAt: now,
        updatedAt: now,
      };
      state.inbox[command.attemptId] = entry;
      state.commandJournal[command.commandId] = {
        commandId: command.commandId,
        commandType: command.type,
        envelopeHash,
        canonicalAttemptId: command.attemptId,
        state: "claimed",
        receivedAt: now,
        updatedAt: now,
      };
      return { entry: structuredClone(entry), isNew: true };
    });
  }

  async transitionCommand(
    attemptId: string,
    expected: InboxState | InboxState[],
    next: InboxState,
    fields: Pick<InboxEntry, "response" | "error"> = {},
  ): Promise<InboxEntry> {
    return this.update((state) => {
      const entry = state.inbox[attemptId];
      if (!entry) throw new AgentError("ATTEMPT_NOT_FOUND", "attempt is not in the durable inbox");
      const journal = state.commandJournal[entry.commandId];
      if (!journal || journal.canonicalAttemptId !== attemptId || journal.envelopeHash !== entry.envelopeHash) {
        throw new AgentError("COMMAND_JOURNAL_CONFLICT", "attempt is not the canonical command execution");
      }
      const allowed = Array.isArray(expected) ? expected : [expected];
      if (!allowed.includes(entry.state)) {
        throw new AgentError("ATTEMPT_STATE_CONFLICT", `cannot move attempt from ${entry.state} to ${next}`);
      }
      entry.state = next;
      entry.updatedAt = nowIso();
      if (next === "invoking") entry.invokingAt = entry.updatedAt;
      if (fields.response !== undefined) entry.response = structuredClone(fields.response);
      if (fields.error !== undefined) entry.error = structuredClone(fields.error);
      journal.state = next;
      journal.updatedAt = entry.updatedAt;
      if (entry.invokingAt !== undefined) journal.invokingAt = entry.invokingAt;
      if (fields.response !== undefined) journal.response = structuredClone(fields.response);
      if (fields.error !== undefined) journal.error = structuredClone(fields.error);
      return structuredClone(entry);
    });
  }

  async reserveProjectCommand(
    input: Omit<ProjectCommandReservation, "state" | "createdAt" | "updatedAt">,
    requireIdleProject = false,
  ): Promise<ProjectCommandReservation> {
    return this.update((state) => {
      const journal = state.commandJournal[input.commandId];
      if (!journal || journal.canonicalAttemptId !== input.attemptId || journal.envelopeHash !== input.envelopeHash) {
        throw new AgentError("COMMAND_JOURNAL_CONFLICT", "project reservation is not owned by the canonical command attempt");
      }
      const existing = state.projectReservations[input.projectId];
      if (existing) {
        if (
          existing.commandId === input.commandId &&
          existing.attemptId === input.attemptId &&
          existing.envelopeHash === input.envelopeHash &&
          existing.appServerEpoch === input.appServerEpoch
        ) {
          if (existing.state === "unknown") {
            throw new AgentError("PROJECT_OUTCOME_UNKNOWN", "the command reservation has an uncertain outcome");
          }
          return structuredClone(existing);
        }
        throw new AgentError(
          existing.state === "unknown" ? "PROJECT_OUTCOME_UNKNOWN" : "PROJECT_BUSY",
          existing.state === "unknown"
            ? "a prior command has an uncertain outcome for this project"
            : "another command is starting on this project",
        );
      }
      if (
        requireIdleProject &&
        Object.values(state.managedThreads).some(
          (thread) => thread.projectId === input.projectId && thread.activeTurnId !== undefined,
        )
      ) {
        throw new AgentError("PROJECT_BUSY", "project already has an active AgentFleet turn");
      }
      if (requireIdleProject) {
        const external = externalProjectActivity(state, input.projectId, input.appServerEpoch);
        if (external) {
          throw new AgentError(
            "PROJECT_EXTERNAL_ACTIVITY",
            `existing Codex thread ${external.nativeThreadId} is ${external.executionState} on this project`,
          );
        }
      }
      const timestamp = nowIso();
      const reservation: ProjectCommandReservation = {
        ...input,
        state: "starting",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.projectReservations[input.projectId] = reservation;
      return structuredClone(reservation);
    });
  }

  async releaseProjectCommand(owner: Omit<ProjectCommandReservation, "state" | "createdAt" | "updatedAt">): Promise<boolean> {
    return this.update((state) => {
      const existing = state.projectReservations[owner.projectId];
      if (!existing) return false;
      if (
        existing.commandId !== owner.commandId ||
        existing.attemptId !== owner.attemptId ||
        existing.envelopeHash !== owner.envelopeHash ||
        existing.appServerEpoch !== owner.appServerEpoch
      ) {
        throw new AgentError("PROJECT_RESERVATION_CONFLICT", "project reservation owner changed");
      }
      delete state.projectReservations[owner.projectId];
      return true;
    });
  }

  async markCommandUnknown(
    attemptId: string,
    error: { code: string; message: string },
  ): Promise<InboxEntry> {
    return this.update((state) => {
      const entry = state.inbox[attemptId];
      if (!entry) throw new AgentError("ATTEMPT_NOT_FOUND", "attempt is not in the durable inbox");
      const journal = state.commandJournal[entry.commandId];
      if (!journal || journal.canonicalAttemptId !== attemptId) {
        throw new AgentError("COMMAND_JOURNAL_CONFLICT", "attempt is not the canonical command execution");
      }
      const timestamp = nowIso();
      entry.state = "unknown";
      entry.error = structuredClone(error);
      entry.updatedAt = timestamp;
      journal.state = "unknown";
      journal.error = structuredClone(error);
      journal.updatedAt = timestamp;
      const reservation = Object.values(state.projectReservations).find(
        (candidate) => candidate.commandId === entry.commandId && candidate.attemptId === attemptId,
      );
      if (reservation) {
        reservation.state = "unknown";
        reservation.updatedAt = timestamp;
      }
      return structuredClone(entry);
    });
  }

  async handleAppServerExit(appServerEpoch: string, projectId?: string): Promise<{ unknownReservations: number; unknownCommands: number }> {
    return this.update((state) => {
      const reservations = Object.values(state.projectReservations).filter(
        (reservation) => reservation.appServerEpoch === appServerEpoch && (projectId === undefined || reservation.projectId === projectId),
      );
      const timestamp = nowIso();
      let unknownCommands = 0;
      let unknownReservations = 0;
      for (const reservation of reservations) {
        const journal = state.commandJournal[reservation.commandId];
        if (journal && ["applied", "rejected"].includes(journal.state)) {
          delete state.projectReservations[reservation.projectId];
          continue;
        }
        if (journal && !["applied", "rejected", "unknown"].includes(journal.state)) {
          const error = { code: "APP_SERVER_EXITED", message: "app-server exited before command completion was proven" };
          journal.state = "unknown";
          journal.error = error;
          journal.updatedAt = timestamp;
          const entry = state.inbox[journal.canonicalAttemptId];
          if (entry) {
            entry.state = "unknown";
            entry.error = error;
            entry.updatedAt = timestamp;
          }
          unknownCommands += 1;
        }
        reservation.state = "unknown";
        reservation.updatedAt = timestamp;
        unknownReservations += 1;
      }
      return { unknownReservations, unknownCommands };
    });
  }

  async recoverPreviousRuntimeTurn(expected: ManagedThread, event: EventInput, status: string): Promise<boolean> {
    return this.update(state => {
      const current = state.managedThreads[expected.nativeThreadId];
      if (!current || !event.appServerEpoch || !["completed", "failed", "interrupted"].includes(status) ||
          current.appServerEpoch !== expected.appServerEpoch || current.appServerEpoch === event.appServerEpoch ||
          !current.activeTurnId || current.activeTurnId !== expected.activeTurnId ||
          current.contentEpoch !== expected.contentEpoch || current.logicalSessionId !== expected.logicalSessionId ||
          current.executionSegmentId !== expected.executionSegmentId || current.projectId !== expected.projectId ||
          current.sessionCwd !== expected.sessionCwd || state.projectReservations[current.projectId]) return false;
      // Persist the proof and projection together, so a crash cannot lose the terminal event.
      appendEventToState(state, event);
      current.lastTurnId = current.activeTurnId;
      current.lastTurnStatus = status;
      delete current.activeTurnId;
      current.appServerEpoch = event.appServerEpoch;
      current.policyVerified = false;
      current.subscribed = false;
      for (const approval of Object.values(state.approvals)) {
        if (approval.nativeThreadId === current.nativeThreadId && approval.appServerEpoch === expected.appServerEpoch && approval.state === "pending") approval.state = "invalidated";
      }
      return true;
    });
  }

  async reconcileInterruptedWork(): Promise<{ unknownReservations: number; unknownCommands: number }> {
    return this.update((state) => {
      const timestamp = nowIso();
      let unknownCommands = 0;
      for (const journal of Object.values(state.commandJournal)) {
        if (["applied", "rejected", "unknown"].includes(journal.state)) continue;
        const error = { code: "AGENT_RESTARTED_DURING_COMMAND", message: "agent restarted before command completion was proven" };
        journal.state = "unknown";
        journal.error = error;
        journal.updatedAt = timestamp;
        const entry = state.inbox[journal.canonicalAttemptId];
        if (entry) {
          entry.state = "unknown";
          entry.error = error;
          entry.updatedAt = timestamp;
        }
        unknownCommands += 1;
      }
      let unknownReservations = 0;
      for (const reservation of Object.values(state.projectReservations)) {
        const journal = state.commandJournal[reservation.commandId];
        if (journal && ["applied", "rejected"].includes(journal.state)) {
          delete state.projectReservations[reservation.projectId];
          continue;
        }
        reservation.state = "unknown";
        reservation.updatedAt = timestamp;
        unknownReservations += 1;
      }
      return { unknownReservations, unknownCommands };
    });
  }

  async upsertApproval(approval: ApprovalRecord): Promise<void> {
    await this.update((state) => {
      const existing = state.approvals[approval.approvalId];
      if (existing && (existing.actionHash !== approval.actionHash || existing.appServerEpoch !== approval.appServerEpoch)) {
        throw new AgentError("APPROVAL_ID_COLLISION", "approval id was reused with different content");
      }
      state.approvals[approval.approvalId] = structuredClone(existing ?? approval);
    });
  }

  async decideApproval(
    approvalId: string,
    decision: NonNullable<ApprovalRecord["decision"]>,
  ): Promise<ApprovalRecord> {
    return this.update((state) => {
      const approval = state.approvals[approvalId];
      if (!approval) throw new AgentError("APPROVAL_NOT_FOUND", "approval is not pending on this agent");
      if (approval.state !== "pending") throw new AgentError("APPROVAL_ALREADY_RESOLVED", "approval is no longer pending");
      approval.state = "decided";
      approval.decision = decision;
      approval.updatedAt = nowIso();
      return structuredClone(approval);
    });
  }

  async setApprovalState(
    approvalId: string,
    stateValue: ApprovalRecord["state"],
  ): Promise<ApprovalRecord> {
    return this.update((state) => {
      const approval = state.approvals[approvalId];
      if (!approval) throw new AgentError("APPROVAL_NOT_FOUND", "approval does not exist");
      approval.state = stateValue;
      approval.updatedAt = nowIso();
      return structuredClone(approval);
    });
  }

  async invalidateApprovals(appServerEpoch: string, threadId?: string): Promise<ApprovalRecord[]> {
    return this.update((state) => {
      const invalidated: ApprovalRecord[] = [];
      for (const approval of Object.values(state.approvals)) {
        if (approval.appServerEpoch === appServerEpoch && approval.state === "pending" && (threadId === undefined || approval.nativeThreadId === threadId)) {
          approval.state = "invalidated";
          approval.updatedAt = nowIso();
          invalidated.push(structuredClone(approval));
        }
      }
      return invalidated;
    });
  }

  async setManagedThread(thread: ManagedThread): Promise<ManagedThread> {
    return this.update((state) => {
      const previous = state.nativeThreadBindings[thread.nativeThreadId];
      const revision = previous === undefined ? 1 : previous.managementRevision + (previous.managed ? 0 : 1);
      const managed = { ...structuredClone(thread), managementRevision: revision, codexProfileId: thread.codexProfileId ?? "default" };
      state.managedThreads[thread.nativeThreadId] = managed;
      if (thread.logicalSessionId && thread.executionSegmentId) {
        state.nativeThreadBindings[thread.nativeThreadId] = {
          nativeThreadId: thread.nativeThreadId,
          codexProfileId: managed.codexProfileId,
          projectId: thread.projectId,
          logicalSessionId: thread.logicalSessionId,
          executionSegmentId: thread.executionSegmentId,
          managementRevision: revision,
          managed: true,
          contentEpoch: thread.contentEpoch ?? 1,
          ...(thread.sessionCwd === undefined ? {} : { sessionCwd: thread.sessionCwd }),
          ...(previous?.title === undefined ? {} : { title: previous.title }),
        };
      }
      delete state.discoveredThreads[thread.nativeThreadId];
      return structuredClone(managed);
    });
  }

  async commitNativeDeletion(command:FleetCommand,ids:string[]):Promise<Record<string,unknown>> {
    return this.update(state=>{
      const entry=state.inbox[command.attemptId];const journal=state.commandJournal[command.commandId];
      if(entry?.state!=="invoking" || journal?.state!=="invoking" || journal.canonicalAttemptId!==command.attemptId)throw new AgentError("COMMAND_STATE_CONFLICT","删除执行记录已改变");
      const timestamp=nowIso();const response={nativeThreadId:command.precondition.nativeThreadId,deletedNativeThreadIds:ids};
      if (command.type !== "thread.delete" || ids.length < 1 || ids.length > 50 || new Set(ids).size !== ids.length || !ids.includes(String(command.precondition.nativeThreadId))) throw new AgentError("DELETE_RECEIPT_INVALID", "Native deletion receipt does not match its command");
      for (const id of ids) {
        state.nativeDeletionTombstones[id] = timestamp;
        delete state.managedThreads[id]; delete state.discoveredThreads[id];
        const binding = state.nativeThreadBindings[id];
        if (binding) { binding.managed = false; binding.managementRevision += 1; }
        this.requireDatabase().prepare("DELETE FROM history_item_receipts WHERE native_thread_id=?").run(id);
        for (const event of state.outbox) if (event.nativeThreadId === id) { event.payload = {}; event.payloadState = "suppressed"; }
      }
      for(const item of [entry,journal]) {item.state="applied";item.response=response;item.updatedAt=timestamp;}
      if(state.projectReservations[command.projectId]?.commandId===command.commandId)delete state.projectReservations[command.projectId];
      return response;
    });
  }

  async releaseManagedThread(nativeThreadId: string, event: EventInput, command: FleetCommand): Promise<Record<string, unknown>> {
    return this.update((state) => {
      const thread = state.managedThreads[nativeThreadId];
      if (!thread) throw new AgentError("THREAD_NOT_MANAGED", "thread is not managed by AgentFleet");
      if (thread.activeTurnId !== undefined) {
        throw new AgentError("THREAD_BUSY", "an active turn must finish before releasing the thread");
      }
      if (Object.values(state.approvals).some((approval) => approval.nativeThreadId === nativeThreadId && approval.state === "pending")) {
        throw new AgentError("THREAD_BUSY", "pending approvals must finish before releasing the thread");
      }
      const binding = state.nativeThreadBindings[nativeThreadId];
      if (!binding) throw new AgentError("SESSION_BINDING_UNKNOWN", "native thread has no durable identity binding");
      const entry = state.inbox[command.attemptId];
      const journal = state.commandJournal[command.commandId];
      if (entry?.state !== "invoking" || journal?.state !== "invoking") {
        throw new AgentError("COMMAND_STATE_CONFLICT", "release command is no longer invoking");
      }
      binding.managed = false;
      binding.managementRevision += 1;
      binding.contentEpoch = thread.contentEpoch;
      const timestamp = nowIso();
      state.discoveredThreads[nativeThreadId] = {
        nativeThreadId,
        externalId: binding.logicalSessionId,
        executionSegmentExternalId: binding.executionSegmentId,
        projectId: thread.projectId,
        title: thread.title ?? binding.title ?? `Codex thread ${nativeThreadId.slice(0, 8)}`,
        ...(thread.titleSource ? { titleSource: thread.titleSource } : {}),
        archived: false,
        availability: "available",
        executionState: "idle",
        historyCompleteness: "partial",
        historyMode: thread.historyMode ?? "legacy",
        codexProfileId: binding.codexProfileId,
        managementRevision: binding.managementRevision,
        ...(thread.sessionCwd === undefined ? {} : { sessionCwd: thread.sessionCwd }),
        firstSeenAt: thread.createdAt,
        lastSeenAt: timestamp,
        lastReconciledAt: timestamp,
      };
      const response = { nativeThreadId, released: true, hostThreadPreserved: true, managementRevision: binding.managementRevision,
        ...(event.payload.writerReleased === true ? { writerReleased: true } : {}) };
      // This transaction is the release linearization point. Its event, native
      // binding and terminal command journal either all commit or all roll back.
      appendEventToState(state, { ...event, payload: { ...event.payload, managementRevision: binding.managementRevision, codexProfileId: binding.codexProfileId } });
      for (const item of [entry, journal]) {
        item.state = "applied";
        item.response = response;
        item.updatedAt = timestamp;
      }
      if (state.projectReservations[thread.projectId]?.commandId === command.commandId) delete state.projectReservations[thread.projectId];
      delete state.managedThreads[nativeThreadId];
      return response;
    });
  }

  async reconcileDiscoveredThreads(
    projectId: string,
    observed: Array<Omit<DiscoveredThread, "firstSeenAt" | "lastSeenAt" | "lastReconciledAt">>,
    appServerEpoch: string,
  ): Promise<boolean> {
    return this.update((state) => {
      const before = canonicalJson(
        Object.values(state.discoveredThreads)
          .filter((thread) => thread.projectId === projectId)
          .map(({ firstSeenAt: _firstSeenAt, lastSeenAt: _lastSeenAt, lastReconciledAt: _lastReconciledAt, ...thread }) => thread)
          .sort((left, right) => left.nativeThreadId.localeCompare(right.nativeThreadId)),
      );
      const timestamp = nowIso();
      state.projectDiscovery[projectId] = {
        projectId,
        appServerEpoch,
        state: "healthy",
        lastAttemptAt: timestamp,
        lastSuccessfulAt: timestamp,
      };
      const seen = new Set(observed.map((thread) => thread.nativeThreadId));
      for (const thread of Object.values(state.discoveredThreads)) {
        if (thread.projectId !== projectId || seen.has(thread.nativeThreadId)) continue;
        thread.availability = "unavailable";
        thread.executionState = "unknown";
        thread.historyCompleteness = "unknown";
        thread.lastReconciledAt = timestamp;
      }
      for (const thread of observed) {
        if (state.nativeDeletionTombstones[thread.nativeThreadId]) continue;
        if (state.managedThreads[thread.nativeThreadId]) {
          const managed = state.managedThreads[thread.nativeThreadId]!;
          if (thread.titleSource === "name" || !managed.title) { managed.title = thread.title; managed.titleSource = thread.titleSource ?? "preview"; }
          delete state.discoveredThreads[thread.nativeThreadId];
          continue;
        }
        const existing = state.discoveredThreads[thread.nativeThreadId];
        const binding = bindDiscovery(state, thread);
        state.discoveredThreads[thread.nativeThreadId] = {
          ...structuredClone(thread),
          externalId: binding.logicalSessionId,
          executionSegmentExternalId: binding.executionSegmentId,
          managementRevision: binding.managementRevision,
          codexProfileId: binding.codexProfileId,
          firstSeenAt: existing?.firstSeenAt ?? timestamp,
          lastSeenAt: timestamp,
          lastReconciledAt: timestamp,
        };
      }
      const after = canonicalJson(
        Object.values(state.discoveredThreads)
          .filter((thread) => thread.projectId === projectId)
          .map(({ firstSeenAt: _firstSeenAt, lastSeenAt: _lastSeenAt, lastReconciledAt: _lastReconciledAt, ...thread }) => thread)
          .sort((left, right) => left.nativeThreadId.localeCompare(right.nativeThreadId)),
      );
      return before !== after;
    });
  }

  async reconcileDiscoveredCatalog(
    discoveredProjects: ProjectRecord[],
    observed: Array<Omit<DiscoveredThread, "firstSeenAt" | "lastSeenAt" | "lastReconciledAt">>,
    appServerEpoch: string,
    scan: { complete: boolean; seenNativeThreadIds?: readonly string[]; metadataRevisions?: Record<string, number> } = { complete: true },
  ): Promise<boolean> {
    return this.update((state) => {
      const snapshotForChange = () => canonicalJson({
        titles: Object.values(state.managedThreads).map(thread => ({ id: thread.nativeThreadId, title: thread.title, source: thread.titleSource, archived: thread.archived })),
        projects: state.projects.map((project) => ({
          id: project.id,
          alias: project.alias,
          root: project.root,
          device: project.device,
          inode: project.inode,
          identityVersion: project.identityVersion,
          source: project.source ?? "explicit",
        })).sort((left, right) => left.id.localeCompare(right.id)),
        threads: Object.values(state.discoveredThreads).map(({
          firstSeenAt: _firstSeenAt,
          lastSeenAt: _lastSeenAt,
          lastReconciledAt: _lastReconciledAt,
          ...thread
        }) => thread).sort((left, right) => left.nativeThreadId.localeCompare(right.nativeThreadId)),
      });
      const before = snapshotForChange();
      const timestamp = nowIso();

      for (const project of discoveredProjects) {
        const existing = state.projects.find((entry) => entry.root === project.root);
        if (existing) {
          if (existing.device !== project.device || existing.inode !== project.inode) {
            existing.device = project.device;
            existing.inode = project.inode;
            existing.identityVersion += 1;
          }
          if ((existing.source ?? "explicit") === "session_discovery") existing.alias = project.alias;
          continue;
        }
        if (state.projects.length >= MAX_PROJECTS) {
          throw new AgentError("PROJECT_LIMIT_REACHED", `at most ${MAX_PROJECTS} projects can be discovered`);
        }
        state.projects.push(structuredClone(project));
      }

      for (const project of state.projects) {
        state.projectDiscovery[project.id] = {
          projectId: project.id,
          appServerEpoch,
          state: scan.complete ? "healthy" : "unavailable",
          lastAttemptAt: timestamp,
          ...(scan.complete ? { lastSuccessfulAt: timestamp } : {}),
        };
      }

      const seen = new Set(scan.seenNativeThreadIds ?? observed.map((thread) => thread.nativeThreadId));
      for (const thread of Object.values(state.discoveredThreads)) {
        if (!scan.complete || seen.has(thread.nativeThreadId)) continue;
        thread.availability = "unavailable";
        thread.executionState = "unknown";
        thread.historyCompleteness = "unknown";
        thread.lastReconciledAt = timestamp;
      }
      for (const thread of observed) {
        if (state.nativeDeletionTombstones[thread.nativeThreadId]) continue;
        if (state.managedThreads[thread.nativeThreadId]) {
          const managed = state.managedThreads[thread.nativeThreadId]!;
          // A delayed scan cannot undo an operation that completed after the
          // read started, nor import metadata from a moved session directory.
          const current = scan.metadataRevisions === undefined || scan.metadataRevisions[thread.nativeThreadId] === (managed.metadataRevision ?? 0);
          const sameTarget = managed.projectId === thread.projectId && (managed.sessionCwd ?? state.projects.find(project => project.id === managed.projectId)?.root) === (thread.sessionCwd ?? state.projects.find(project => project.id === thread.projectId)?.root);
          if (current && sameTarget && !managed.activeTurnId && !state.projectReservations[managed.projectId]) {
            const beforeMetadata = canonicalJson({ title: managed.title, source: managed.titleSource, archived: managed.archived });
            if (thread.titleSource === "name" || !managed.title) { managed.title = thread.title; managed.titleSource = thread.titleSource ?? "preview"; }
            managed.archived = thread.archived;
            if (beforeMetadata !== canonicalJson({ title: managed.title, source: managed.titleSource, archived: managed.archived })) managed.metadataRevision = (managed.metadataRevision ?? 0) + 1;
          }
          delete state.discoveredThreads[thread.nativeThreadId];
          continue;
        }
        const existing = state.discoveredThreads[thread.nativeThreadId];
        const binding = bindDiscovery(state, thread);
        state.discoveredThreads[thread.nativeThreadId] = {
          ...structuredClone(thread),
          externalId: binding.logicalSessionId,
          executionSegmentExternalId: binding.executionSegmentId,
          managementRevision: binding.managementRevision,
          codexProfileId: binding.codexProfileId,
          firstSeenAt: existing?.firstSeenAt ?? timestamp,
          lastSeenAt: timestamp,
          lastReconciledAt: timestamp,
        };
      }
      return before !== snapshotForChange();
    });
  }

  async markAllDiscoveryUnavailable(appServerEpoch: string): Promise<boolean> {
    return this.update((state) => {
      const timestamp = nowIso();
      let changed = false;
      for (const project of state.projects) {
        const previous = state.projectDiscovery[project.id];
        state.projectDiscovery[project.id] = {
          projectId: project.id,
          appServerEpoch,
          state: "unavailable",
          lastAttemptAt: timestamp,
          ...(previous?.lastSuccessfulAt === undefined ? {} : { lastSuccessfulAt: previous.lastSuccessfulAt }),
        };
      }
      // Keep last-known catalog visible on transient scan failures. Project
      // discovery remains unavailable, so this cannot enable remote writes.
      return changed || state.projects.length > 0;
    });
  }

  async markDiscoveryUnavailable(projectId: string, appServerEpoch: string): Promise<boolean> {
    return this.update((state) => {
      const previousDiscovery = state.projectDiscovery[projectId];
      let changed = false;
      const timestamp = nowIso();
      state.projectDiscovery[projectId] = {
        projectId,
        appServerEpoch,
        state: "unavailable",
        lastAttemptAt: timestamp,
        ...(previousDiscovery?.lastSuccessfulAt === undefined
          ? {}
          : { lastSuccessfulAt: previousDiscovery.lastSuccessfulAt }),
      };
      for (const thread of Object.values(state.discoveredThreads)) {
        if (thread.projectId !== projectId) continue;
        if (thread.availability !== "unavailable" || thread.executionState !== "unknown") changed = true;
        thread.availability = "unavailable";
        thread.executionState = "unknown";
        thread.historyCompleteness = "unknown";
        thread.lastReconciledAt = timestamp;
      }
      return changed;
    });
  }

  async updateManagedThread(
    threadId: string,
    mutator: (thread: ManagedThread) => void,
  ): Promise<ManagedThread> {
    return this.update((state) => {
      const thread = state.managedThreads[threadId];
      if (!thread) throw new AgentError("THREAD_NOT_MANAGED", "thread was not created and owned by AgentFleet");
      mutator(thread);
      const binding = state.nativeThreadBindings[threadId];
      if (binding) {
        binding.contentEpoch = thread.contentEpoch;
        binding.projectId = thread.projectId;
        if (thread.sessionCwd !== undefined) binding.sessionCwd = thread.sessionCwd;
      }
      return structuredClone(thread);
    });
  }
}
