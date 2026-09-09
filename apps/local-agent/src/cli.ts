#!/usr/bin/env node

import { homedir, hostname } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { isSea } from "node:sea";
import { pathToFileURL } from "node:url";
import { AGENT_VERSION } from "./constants.js";
import { enrollMachine, enrollmentIdFromTicket } from "./enrollment.js";
import { AgentError, publicError } from "./errors.js";
import { normalizeControlPlaneUrl } from "./http.js";
import { loadOrCreateIdentity } from "./identity.js";
import { pairMachine } from "./pairing.js";
import { detectSupport } from "./platform.js";
import { addProject } from "./projects.js";
import { RelayConnection } from "./relay.js";
import { AgentRuntime } from "./runtime.js";
import {
  getUserServiceStatus,
  installUserService,
  ROOT_AGENT_DATA_DIR,
  ROOT_CODEX_HOME,
  ROOT_CONFIG_HOME,
  ROOT_DATA_HOME,
  ROOT_HOME,
  rollbackUserService,
  TRUSTED_SYSTEM_PATH,
  uninstallUserService,
  updateUserService,
} from "./service.js";
import { StateStore } from "./store.js";
import { AgentAutoUpdater } from "./updater.js";
import { configureRuntimeProfile } from "./runtime-profile.js";
import { repairManagedCodeMode } from "./managed-code-mode.js";
import { superviseAgent, writeWorkerHealth, readUpdateTransaction, workerStopExitCode } from "./supervisor.js";
import { AgentMaintenance } from "./maintenance.js";

function defaultDataDir(): string {
  if (process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0) return ROOT_AGENT_DATA_DIR;
  const explicit = process.env.AGENTFLEET_HOME;
  if (explicit) return resolve(explicit);
  if (process.platform === "win32") return resolve(process.env.LOCALAPPDATA ?? homedir(), "AgentFleet");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "AgentFleet");
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) {
    if (!isAbsolute(xdg)) throw new AgentError("DATA_DIR_INVALID", "XDG_DATA_HOME must be absolute");
    return join(xdg, "agentfleet");
  }
  return join(homedir(), ".local", "share", "agentfleet");
}

function requestedDataDir(args: ParsedArgs): string {
  if (process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0) return ROOT_AGENT_DATA_DIR;
  return resolve(option(args, "data-dir") ?? defaultDataDir());
}

export function normalizeRootRuntimeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  uid: number | null = typeof process.getuid === "function" ? process.getuid() : null,
): void {
  if (process.platform !== "linux" || uid !== 0) return;
  environment.HOME = ROOT_HOME;
  environment.XDG_DATA_HOME = ROOT_DATA_HOME;
  environment.XDG_CONFIG_HOME = ROOT_CONFIG_HOME;
  environment.CODEX_HOME = ROOT_CODEX_HOME;
  environment.PATH = TRUSTED_SYSTEM_PATH;
  environment.TMPDIR = "/tmp";
  for (const name of [
    "AGENTFLEET_HOME",
    "AGENTFLEET_CODEX_SCHEMA_HASH",
    "AGENTFLEET_SYSTEMD_UNIT_DIR",
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
  ]) delete environment[name];
}

interface ParsedArgs {
  words: string[];
  options: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const words: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === undefined) continue;
    if (!current.startsWith("--")) {
      words.push(current);
      continue;
    }
    const equals = current.indexOf("=");
    if (equals > 2) {
      options.set(current.slice(2, equals), current.slice(equals + 1));
      continue;
    }
    const key = current.slice(2);
    if (["help", "json", "no-service", "version"].includes(key)) {
      options.set(key, true);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new AgentError("ARGUMENT_MISSING", `--${key} requires a value`);
    options.set(key, next);
    index += 1;
  }
  return { words, options };
}

function option(args: ParsedArgs, name: string, required = false): string | undefined {
  const value = args.options.get(name);
  if (value === true) throw new AgentError("ARGUMENT_INVALID", `--${name} requires a value`);
  if (required && value === undefined) throw new AgentError("ARGUMENT_MISSING", `--${name} is required`);
  return value;
}

function ensureOptions(args: ParsedArgs, allowed: string[]): void {
  for (const key of args.options.keys()) {
    if (!allowed.includes(key)) throw new AgentError("ARGUMENT_UNKNOWN", `unknown option --${key}`);
  }
}

function usage(): string {
  return `AgentFleet Local Agent ${AGENT_VERSION} (P0b)\n\nUsage:\n  agentfleet onboard --url <https://control-plane> [--ticket <id.secret>] [--name <name>] [--project <path>] [--alias <alias>]\n  agentfleet pair --url <https://control-plane> [--name <machine-name>] [--data-dir <dir>]\n  agentfleet project add <path> [--alias <alias>] [--data-dir <dir>]\n  agentfleet run [--url <https://control-plane>] [--data-dir <dir>]\n  agentfleet status [--json] [--data-dir <dir>]\n  agentfleet service install|update [--executable <file>] [--data-dir <dir>]\n  agentfleet service status [--json]\n  agentfleet service rollback [--data-dir <dir>]\n  agentfleet service uninstall\n\nDefaults: machine name is the hostname, Project alias is the directory basename,\nand run uses the URL saved at pairing. Onboard defaults Project to the current directory.\nLinux uses systemd, macOS uses launchd, and Windows uses a per-user Scheduled Task.\n\nWrite mode supports the published Linux, macOS, and Windows P0b profiles with Node 24,\ncodex-cli 0.153.2 or newer, the pinned App Server schema, and a protected Ed25519 key.`;
}

export function defaultMachineName(): string {
  const value = hostname().trim();
  if (value.length === 0) throw new AgentError("MACHINE_NAME_INVALID", "hostname is empty; provide --name");
  return value.slice(0, 120);
}

export function defaultProjectAlias(path: string): string {
  const value = basename(resolve(path));
  if (value.length === 0) throw new AgentError("PROJECT_ALIAS_INVALID", "cannot derive an alias; provide --alias");
  return value;
}

function validateMachineName(value: string): string {
  const trimmed = value.trim();
  if (Buffer.byteLength(trimmed, "utf8") > 120 || trimmed.length === 0) {
    throw new AgentError("MACHINE_NAME_INVALID", "machine name must be 1-120 UTF-8 bytes");
  }
  return trimmed;
}

async function setup(args: ParsedArgs): Promise<{
  store: StateStore;
  identity: Awaited<ReturnType<typeof loadOrCreateIdentity>>;
  support: Awaited<ReturnType<typeof detectSupport>>;
}> {
  const store = new StateStore(requestedDataDir(args));
  await store.initialize();
  await configureRuntimeProfile(store.dataDir);
  if (["pair", "onboard"].includes(args.words[0] ?? "")) {
    const url = option(args, "url") ?? store.snapshot().pairing?.controlPlaneUrl;
    if (url) await repairManagedCodeMode(store.dataDir, url).catch(() => undefined); // Preflight exposes a failure without blocking pairing.
  }
  const identity = await loadOrCreateIdentity(store);
  const support = await detectSupport(identity.metadata.credentialProtectionLevel);
  return { store, identity, support };
}

async function pair(args: ParsedArgs): Promise<void> {
  ensureOptions(args, ["url", "name", "data-dir"]);
  if (args.words.length !== 1) throw new AgentError("ARGUMENT_INVALID", "pair takes no positional arguments");
  const url = option(args, "url", true)!;
  const name = validateMachineName(option(args, "name") ?? defaultMachineName());
  const { store, identity, support } = await setup(args);
  const abort = new AbortController();
  const stop = () => abort.abort(new AgentError("PAIRING_CANCELLED", "pairing cancelled"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const credential = await pairMachine({
      store,
      identity,
      support,
      url,
      name,
      signal: abort.signal,
      onDisplay(display) {
        process.stdout.write(
          `Open: ${display.verifyUrl}\nUser code: ${display.userCode}\nFingerprint: ${display.fingerprint}\nVerification phrase: ${display.verificationPhrase}\nExpires: ${display.expiresAt}\n`,
        );
      },
    });
    process.stdout.write(`Paired machine ${credential.machineId}.\n`);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    store.close();
  }
}

async function project(args: ParsedArgs): Promise<void> {
  ensureOptions(args, ["alias", "data-dir"]);
  if (args.words[1] !== "add" || args.words.length !== 3) {
    throw new AgentError("ARGUMENT_INVALID", "usage: project add <path> [--alias <alias>]");
  }
  const path = args.words[2]!;
  const alias = option(args, "alias") ?? defaultProjectAlias(path);
  const { store } = await setup(args);
  try {
    const added = await addProject(store, path, alias);
    process.stdout.write(`Authorized ${added.alias}: ${added.root} (${added.id})\n`);
  } finally {
    store.close();
  }
}

async function status(args: ParsedArgs): Promise<void> {
  ensureOptions(args, ["json", "data-dir"]);
  if (args.words.length !== 1) throw new AgentError("ARGUMENT_INVALID", "status takes no positional arguments");
  const { store, identity, support } = await setup(args);
  try {
    const state = store.snapshot();
    const report = {
      installed: true,
      dataDir: store.dataDir,
      identity: {
        fingerprint: identity.metadata.fingerprint,
        verificationPhrase: state.pairing?.verificationPhrase ?? identity.metadata.verificationPhrase,
        credentialProtectionLevel: identity.metadata.credentialProtectionLevel,
      },
      paired: state.pairing
        ? {
            machineId: state.pairing.machineId,
            workspaceId: state.pairing.workspaceId ?? null,
            controlPlaneUrl: state.pairing.controlPlaneUrl,
            machineName: state.pairing.machineName,
          }
        : null,
      support,
      mode: support.writable ? "write-capable" : "read-only",
      projects: state.projects.map(({ id, alias, root, identityVersion }) => ({ id, alias, root, identityVersion })),
      durable: {
        activeProducerEpoch: state.activeProducerEpoch ?? null,
        outboxDepth: state.outbox.length,
        inboxDepth: Object.keys(state.inbox).length,
        producerStreams: state.producerStreams,
      },
    };
    if (args.options.get("json") === true) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    process.stdout.write(
      [
        `Identity: ${report.identity.fingerprint}`,
        `Credential protection: ${report.identity.credentialProtectionLevel}`,
        `Pairing: ${report.paired ? `${report.paired.machineName} (${report.paired.machineId})` : "not paired"}`,
        `Mode: ${report.mode}`,
        ...(support.readOnlyReasons.length === 0 ? [] : support.readOnlyReasons.map((reason) => `  - ${reason}`)),
        `Projects: ${report.projects.length}`,
        `Outbox: ${report.durable.outboxDepth}`,
      ].join("\n") + "\n",
    );
  } finally {
    store.close();
  }
}

async function run(args: ParsedArgs): Promise<void> {
  ensureOptions(args, ["url", "data-dir"]);
  if (args.words.length !== 1) throw new AgentError("ARGUMENT_INVALID", "run takes no positional arguments");
  const dataDir = requestedDataDir(args);
  if (process.env.AGENTFLEET_AUTO_UPDATE === "1" && process.env.AGENTFLEET_SUPERVISED !== "1") {
    const controller = new AbortController();
    const stopSupervisor = () => controller.abort();
    process.once("SIGINT", stopSupervisor);
    process.once("SIGTERM", stopSupervisor);
    try { await superviseAgent(dataDir, controller.signal); }
    finally {
      process.removeListener("SIGINT", stopSupervisor);
      process.removeListener("SIGTERM", stopSupervisor);
    }
    return;
  }
  const store = new StateStore(dataDir);
  await store.initialize();
  // Acquire before identity probing, App Server startup, or any network activity.
  const ownership = await store.acquireRuntimeOwnership();
  let runtime: AgentRuntime | undefined;
  let stop: (() => void) | undefined;
  let updateStagedVersion: string | undefined;
  try {
    await configureRuntimeProfile(dataDir);
    const pairing = store.snapshot().pairing;
    if (!pairing) throw new AgentError("NOT_PAIRED", "run 'pair' before starting the agent");
    const url = option(args, "url") ?? pairing.controlPlaneUrl;
    await repairManagedCodeMode(dataDir, url).catch(() => undefined); // Stay connected read-only when repair fails.
    const identity = await loadOrCreateIdentity(store);
    const support = await detectSupport(identity.metadata.credentialProtectionLevel);
    runtime = new AgentRuntime({ store, identity, pairing, support });
    await runtime.initialize();
    const logger = {
      info: (message: string) => process.stderr.write(`${message}\n`),
      warn: (message: string) => process.stderr.write(`warning: ${message}\n`),
    };
    const abort = new AbortController();
    stop = () => {
      process.exitCode = workerStopExitCode(process.env.AGENTFLEET_SUPERVISED === "1");
      abort.abort(new AgentError("STOPPED", "agent stopping"));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const updater = process.env.AGENTFLEET_AUTO_UPDATE === "1"
      ? new AgentAutoUpdater({
          currentVersion: AGENT_VERSION,
          controlPlaneUrl: pairing.controlPlaneUrl,
          dataDir,
          store,
          ...(support.codexProfile ? { runtimeSource: support.codexProfile.source, ...(support.codexProfile.runtimeVersion ? { currentRuntimeVersion: support.codexProfile.runtimeVersion } : {}) } : {}),
          onPhase: (phase, version) => { if (support.codexProfile) { support.codexProfile.runtimeUpdateState = phase; support.codexProfile.runtimeUpdateTarget = version; support.codexProfile.runtimeUpdateError = null; } },
          onError: message => { if (support.codexProfile) { support.codexProfile.runtimeUpdateState = "failed"; support.codexProfile.runtimeUpdateError = message; } },
          canUpdate: () => store.canSafelyRestart(),
          needsRuntimeRepair: () => runtime!.support.checks?.some(check => check.id === "tools" && check.state === "failed") ?? false,
          onStaged: (version) => {
            updateStagedVersion = version;
            logger.info(`AgentFleet update staged; restarting the service with verified Agent ${version} and runtime.`);
            abort.abort(new AgentError("UPDATE_STAGED", "automatic update staged"));
          },
          logger,
        })
      : undefined;
    let connected = false;
    let maintenance!: AgentMaintenance;
    const relay = new RelayConnection({
      runtime, store, identity, pairing, requestedUrl: url, logger,
      onMaintenance: (offer) => maintenance.handle(offer),
      onReady: () => { connected = true; void maintenance.replay().catch((error) => logger.warn(publicError(error).message)); },
    });
    maintenance = new AgentMaintenance({ store, runtime, ...(updater ? { updater } : {}),
      report: (result) => relay.reportMaintenance(result), signal: abort.signal });
    let healthChecking = false;
    let handledUpdateId: string | undefined;
    const healthTimer = setInterval(() => {
      if (!connected || !runtime?.readyForHealthCheck() || healthChecking) return;
      healthChecking = true;
      void (async () => {
        const transaction = await readUpdateTransaction(dataDir);
        if (transaction?.targetRuntimeVersion && ["staged", "verifying"].includes(transaction.phase) &&
          (!runtime!.isWritable() || runtime!.support.codexVersion !== transaction.targetRuntimeVersion)) return;
        await writeWorkerHealth(dataDir, runtime!.support.codexVersion ?? undefined);
        if (transaction && transaction.updateId !== handledUpdateId && ["succeeded", "rolled_back", "failed"].includes(transaction.phase)) {
          if (runtime!.support.codexProfile && transaction.targetRuntimeVersion) {
            runtime!.support.codexProfile.runtimeUpdateState = transaction.phase;
            runtime!.support.codexProfile.runtimeUpdateTarget = transaction.targetRuntimeVersion;
            runtime!.support.codexProfile.runtimeUpdateError = transaction.error ?? null;
          }
          const drain = store.snapshot().maintenanceDrain;
          if (drain && drain.startedAt <= transaction.startedAt) await store.setMaintenanceDrain(undefined);
          await maintenance.replay();
          handledUpdateId = transaction.updateId;
        }
      })().catch((error) => logger.warn(publicError(error).message)).finally(() => { healthChecking = false; });
    }, 1_000);
    healthTimer.unref();
    updater?.start();
    if (!runtime.isWritable()) process.stderr.write(`Agent is read-only: ${runtime.readOnlyReasons().join("; ")}\n`);
    try {
      await relay.run(abort.signal);
    } finally {
      clearInterval(healthTimer);
      await updater?.stop();
    }
  } finally {
    if (stop) {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
    try {
      await runtime?.shutdown();
    } finally {
      await store.releaseRuntimeOwnership(ownership);
      store.close();
    }
  }
  if (updateStagedVersion !== undefined) process.exitCode = 75;
}

function printEnrollmentWait(display: {
  preauthorized?: boolean;
  fingerprint: string;
  verificationPhrase: string;
  expiresAt: string;
}): void {
  process.stdout.write(
    `Machine fingerprint: ${display.fingerprint}\nVerification phrase: ${display.verificationPhrase}\n${display.preauthorized ? "Installation authorized; connecting and discovering Codex projects." : "Confirm this machine in the open AgentFleet browser page."}\nExpires: ${display.expiresAt}\n`,
  );
}

async function onboard(args: ParsedArgs): Promise<void> {
  ensureOptions(args, ["url", "ticket", "name", "project", "alias", "data-dir", "no-service", "executable"]);
  if (args.words.length !== 1) throw new AgentError("ARGUMENT_INVALID", "onboard takes no positional arguments");
  const requestedUrl = option(args, "url");
  const ticket = option(args, "ticket");
  const name = validateMachineName(option(args, "name") ?? defaultMachineName());
  const projectPath = resolve(option(args, "project") ?? process.cwd());
  const alias = option(args, "alias") ?? defaultProjectAlias(projectPath);
  const { store, identity, support } = await setup(args);
  const abort = new AbortController();
  const stop = () => abort.abort(new AgentError("PAIRING_CANCELLED", "onboarding cancelled"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let dataDir = store.dataDir;
  try {
    const existing = store.snapshot().pairing;
    const url = requestedUrl ?? existing?.controlPlaneUrl;
    if (url === undefined) throw new AgentError("ARGUMENT_MISSING", "--url is required for initial onboarding");
    const normalizedUrl = normalizeControlPlaneUrl(url);
    if (existing) {
      if (existing.controlPlaneUrl !== normalizedUrl) {
        throw new AgentError("CONTROL_PLANE_MISMATCH", "--url does not match the saved pairing URL");
      }
      if (ticket !== undefined && existing.enrollmentId !== enrollmentIdFromTicket(ticket)) {
        throw new AgentError(
          "ALREADY_PAIRED",
          "this installation is already paired through a different enrollment; revoke it before adding it again",
        );
      }
      process.stdout.write(`Already paired as ${existing.machineName} (${existing.machineId}); continuing setup.\n`);
    } else if (ticket !== undefined) {
      const credential = await enrollMachine({
        store,
        identity,
        support,
        url: normalizedUrl,
        ticket,
        name,
        signal: abort.signal,
        onDisplay: printEnrollmentWait,
      });
      process.stdout.write(`Paired machine ${credential.machineId}.\n`);
    } else {
      const credential = await pairMachine({
        store,
        identity,
        support,
        url: normalizedUrl,
        name,
        signal: abort.signal,
        onDisplay(display) {
          process.stdout.write(
            `Open: ${display.verifyUrl}\nUser code: ${display.userCode}\nFingerprint: ${display.fingerprint}\nVerification phrase: ${display.verificationPhrase}\nExpires: ${display.expiresAt}\n`,
          );
        },
      });
      process.stdout.write(`Paired machine ${credential.machineId}.\n`);
    }
    const added = await addProject(store, projectPath, alias, "bootstrap_fallback");
    process.stdout.write(`Registered initial project ${added.alias}: ${added.root} (${added.id})\n`);
    dataDir = store.dataDir;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    store.close();
  }
  if (args.options.get("no-service") === true) {
    process.stdout.write(`Service installation skipped. Start with: agentfleet run --data-dir ${JSON.stringify(dataDir)}\n`);
    return;
  }
  const service = await installUserService({
    dataDir,
    ...(option(args, "executable") === undefined ? {} : { executable: option(args, "executable")! }),
  });
  process.stdout.write(`${service.scope === "system" ? "System" : "User"} service installed and ${service.active ? "running" : "starting"}.\n`);
  if (service.persistenceWarning) process.stderr.write(`warning: ${service.persistenceWarning}\n`);
}

function printServiceStatus(report: Awaited<ReturnType<typeof getUserServiceStatus>>, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `Scope: ${report.scope}`,
      `Unit: ${report.installed ? "installed" : "not installed"} (${report.unitPath})`,
      `Service manager: ${report.managerAvailable ? "available" : "unavailable"}`,
      `Enabled: ${report.enabled ? "yes" : "no"}`,
      `Active: ${report.active ? "yes" : "no"}`,
      `Linger: ${report.linger}`,
    ].join("\n") + "\n",
  );
  if (report.persistenceWarning) process.stderr.write(`warning: ${report.persistenceWarning}\n`);
}

async function service(args: ParsedArgs): Promise<void> {
  const action = args.words[1];
  if (!action || args.words.length !== 2) {
    throw new AgentError("ARGUMENT_INVALID", "usage: service install|status|update|rollback|uninstall");
  }
  if (action === "status") {
    ensureOptions(args, ["json"]);
    printServiceStatus(await getUserServiceStatus(), args.options.get("json") === true);
    return;
  }
  if (action === "uninstall") {
    ensureOptions(args, []);
    printServiceStatus(await uninstallUserService(), false);
    process.stdout.write("Service removed; machine credentials and Project authorizations were preserved.\n");
    return;
  }
  if (action === "rollback") {
    ensureOptions(args, ["data-dir"]);
    const dataDir = requestedDataDir(args);
    const report = await rollbackUserService({ dataDir });
    printServiceStatus(report, false);
    process.stdout.write("Restored the previous AgentFleet binary and restarted the service.\n");
    return;
  }
  if (action !== "install" && action !== "update") {
    throw new AgentError("ARGUMENT_INVALID", "usage: service install|status|update|rollback|uninstall");
  }
  ensureOptions(args, ["data-dir", "executable"]);
  const dataDir = requestedDataDir(args);
  const store = new StateStore(dataDir);
  await store.initialize();
  try {
    if (!store.snapshot().pairing) throw new AgentError("NOT_PAIRED", "pair this installation before enabling its service");
  } finally {
    store.close();
  }
  const common = {
    dataDir,
    ...(option(args, "executable") === undefined ? {} : { executable: option(args, "executable")! }),
  };
  const report = action === "install" ? await installUserService(common) : await updateUserService(common);
  printServiceStatus(report, false);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  normalizeRootRuntimeEnvironment();
  const args = parseArgs(argv);
  if (args.options.get("version") === true) {
    ensureOptions(args, ["version"]);
    if (args.words.length !== 0) throw new AgentError("ARGUMENT_INVALID", "--version takes no command");
    process.stdout.write(`${AGENT_VERSION}\n`);
    return;
  }
  if (args.options.get("help") === true || args.words.length === 0) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  switch (args.words[0]) {
    case "onboard":
      await onboard(args);
      return;
    case "pair":
      await pair(args);
      return;
    case "project":
      await project(args);
      return;
    case "run":
      await run(args);
      return;
    case "status":
      await status(args);
      return;
    case "service":
      await service(args);
      return;
    default:
      throw new AgentError("COMMAND_UNKNOWN", `unknown command '${args.words[0]}'`);
  }
}

const invokedDirectly = isSea() || (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    const failure = publicError(error);
    process.stderr.write(`${failure.code}: ${failure.message}\n`);
    process.exitCode = 1;
  });
}
