import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, open, readFile, readlink, realpath, rename, symlink, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isSea } from "node:sea";
import { AgentError } from "./errors.js";
import { syncDirectory } from "./durable-file.js";
import { isPathInside } from "./util.js";
import { loadRuntimeProfile, requireRootControlledPath } from "./runtime-profile.js";

export const USER_SERVICE_NAME = "agentfleet.service";
export type ServiceScope = "user" | "system" | "launchd-user" | "launchd-system" | "windows-user";
export const ROOT_HOME = "/root";
export const ROOT_DATA_HOME = "/root/.local/share";
export const ROOT_CONFIG_HOME = "/root/.config";
export const ROOT_AGENT_DATA_DIR = "/root/.local/share/agentfleet";
export const ROOT_CODEX_HOME = "/root/.codex";
export const ROOT_MANAGED_CODEX_EXECUTABLE = `${ROOT_AGENT_DATA_DIR}/codex/codex`;
export const TRUSTED_SYSTEM_PATH = "/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

const defaultRunner: CommandRunner = (file, args) =>
  new Promise((finish) => {
    execFile(file, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1_024 }, (error, stdout, stderr) => {
      const rawCode = error === null ? undefined : (error as unknown as { code?: unknown }).code;
      const numericCode = typeof rawCode === "number"
        ? rawCode
        : error
          ? 1
          : 0;
      finish({ exitCode: numericCode, stdout, stderr });
    });
  });

function configHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.XDG_CONFIG_HOME;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new AgentError("CONFIG_DIR_INVALID", "XDG_CONFIG_HOME must be absolute");
    return configured;
  }
  return join(homedir(), ".config");
}

export function userServicePath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(configHome(environment), "systemd", "user", USER_SERVICE_NAME);
}

export function systemServicePath(environment: NodeJS.ProcessEnv = process.env): string {
  const directory = environment.AGENTFLEET_SYSTEMD_UNIT_DIR ?? "/etc/systemd/system";
  if (!isAbsolute(directory)) throw new AgentError("CONFIG_DIR_INVALID", "AGENTFLEET_SYSTEMD_UNIT_DIR must be absolute");
  return join(directory, USER_SERVICE_NAME);
}

interface ServiceContext {
  scope: ServiceScope;
  unitPath: string;
  systemctlPrefix: string[];
}

function serviceContext(uid: number | null, environment?: NodeJS.ProcessEnv): ServiceContext {
  if (uid === 0) {
    return {
      scope: "system",
      unitPath: systemServicePath(environment),
      systemctlPrefix: [],
    };
  }
  return {
    scope: "user",
    unitPath: userServicePath(environment),
    systemctlPrefix: ["--user"],
  };
}

/** A root-owned system service always consumes state below /root, regardless of argv. */
export function resolveServiceDataDir(
  dataDir: string,
  uid: number | null = typeof process.getuid === "function" ? process.getuid() : null,
): string {
  return process.platform === "linux" && uid === 0 ? ROOT_AGENT_DATA_DIR : resolve(dataDir);
}

/** Quote one systemd ExecStart/Environment argument without invoking a shell. */
export function quoteSystemdArgument(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new AgentError("SERVICE_ARGUMENT_INVALID", "service arguments must be single-line strings");
  }
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildServiceUnit(options: {
  launch: string[];
  dataDir: string;
  path?: string;
  codexExecutable?: string;
  codexHome?: string;
  scope?: ServiceScope;
}): string {
  if (options.launch.length === 0 || !options.launch.every(isAbsolute)) {
    throw new AgentError("SERVICE_EXECUTABLE_INVALID", "service launch paths must be absolute");
  }
  const command = [...options.launch, "run", "--data-dir", resolve(options.dataDir)]
    .map(quoteSystemdArgument)
    .join(" ");
  if (options.codexExecutable !== undefined && !isAbsolute(options.codexExecutable)) {
    throw new AgentError("SERVICE_EXECUTABLE_INVALID", "Codex service executable must be absolute");
  }
  const codexEnvironment = options.codexExecutable === undefined
    ? []
    : [`Environment=${quoteSystemdArgument(`AGENTFLEET_CODEX_EXECUTABLE=${options.codexExecutable}`)}`];
  if (options.codexHome !== undefined) {
    if (!isAbsolute(options.codexHome)) throw new AgentError("SERVICE_ARGUMENT_INVALID", "CODEX_HOME must be absolute");
    codexEnvironment.push(`Environment=${quoteSystemdArgument(`CODEX_HOME=${options.codexHome}`)}`);
  }
  const environmentLines = options.scope === "system"
    ? [
        `Environment=${quoteSystemdArgument(`HOME=${ROOT_HOME}`)}`,
        `Environment=${quoteSystemdArgument(`XDG_DATA_HOME=${ROOT_DATA_HOME}`)}`,
        `Environment=${quoteSystemdArgument(`XDG_CONFIG_HOME=${ROOT_CONFIG_HOME}`)}`,
        ...(options.codexHome === undefined ? [`Environment=${quoteSystemdArgument(`CODEX_HOME=${ROOT_CODEX_HOME}`)}`] : []),
        `Environment=${quoteSystemdArgument(`PATH=${TRUSTED_SYSTEM_PATH}`)}`,
        "UnsetEnvironment=NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH",
        ...codexEnvironment,
      ]
    : options.path === undefined
      ? codexEnvironment
      : [`Environment=${quoteSystemdArgument(`PATH=${options.path}`)}`, ...codexEnvironment];
  return [
    "# Managed by AgentFleet. Use `agentfleet service update` to regenerate this unit.",
    "[Unit]",
    "Description=AgentFleet Local Agent",
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${command}`,
    "Environment=NODE_ENV=production",
    "Environment=NODE_NO_WARNINGS=1",
    "Environment=AGENTFLEET_AUTO_UPDATE=1",
    ...environmentLines,
    "Restart=on-failure",
    "RestartSec=5s",
    "TimeoutStopSec=30s",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "UMask=0077",
    "",
    "[Install]",
    `WantedBy=${options.scope === "system" ? "multi-user.target" : "default.target"}`,
    "",
  ].join("\n");
}

export function buildUserServiceUnit(options: {
  launch: string[];
  dataDir: string;
  path?: string;
  codexExecutable?: string;
  codexHome?: string;
}): string {
  return buildServiceUnit({ ...options, scope: "user" });
}

async function executablePath(path: string): Promise<string> {
  const canonical = await realpath(resolve(path)).catch(() => {
    throw new AgentError("SERVICE_EXECUTABLE_INVALID", `executable does not exist: ${path}`);
  });
  const metadata = await lstat(canonical);
  if (!metadata.isFile()) throw new AgentError("SERVICE_EXECUTABLE_INVALID", `executable is not a file: ${path}`);
  await access(canonical, fsConstants.X_OK).catch(() => {
    throw new AgentError("SERVICE_EXECUTABLE_INVALID", `file is not executable: ${path}`);
  });
  return canonical;
}

export async function resolveCodexExecutable(
  uid: number | null = typeof process.getuid === "function" ? process.getuid() : null,
  environment: NodeJS.ProcessEnv = process.env,
  managedRootExecutable: string = ROOT_MANAGED_CODEX_EXECUTABLE,
): Promise<string> {
  if (process.platform !== "linux" || uid !== 0) return environment.AGENTFLEET_CODEX_EXECUTABLE ?? "codex";
  if (environment.AGENTFLEET_CODEX_EXECUTABLE !== undefined) {
    if (!isAbsolute(environment.AGENTFLEET_CODEX_EXECUTABLE)) throw new AgentError("SERVICE_EXECUTABLE_INVALID", "AGENTFLEET_CODEX_EXECUTABLE must be absolute");
    const explicit = await executablePath(environment.AGENTFLEET_CODEX_EXECUTABLE);
    await requireRootControlledPath(explicit);
    return explicit;
  }
  const candidates = [managedRootExecutable, ...TRUSTED_SYSTEM_PATH.split(":").map((directory) => join(directory, "codex"))];
  let unsafeError: AgentError | undefined;
  for (const candidate of candidates) {
    try {
      const canonical = await executablePath(candidate);
      await requireRootControlledPath(canonical);
      return canonical;
    } catch (error) {
      if (error instanceof AgentError && error.code === "SERVICE_EXECUTABLE_UNSAFE") unsafeError ??= error;
    }
  }
  if (unsafeError) throw unsafeError;
  throw new AgentError("CODEX_NOT_FOUND", "codex was not found on the trusted root service PATH");
}

export async function resolveServiceLaunch(explicitExecutable?: string, scope: ServiceScope = "user"): Promise<string[]> {
  const validate = async (path: string): Promise<string> => {
    const requested = resolve(path);
    const canonical = await executablePath(path);
    const requestedMetadata = await lstat(requested);
    if (scope === "system") {
      await requireRootControlledPath(canonical);
      if (requestedMetadata.isSymbolicLink()) {
        if (requestedMetadata.uid !== 0) {
          throw new AgentError("SERVICE_EXECUTABLE_UNSAFE", "system service executable symlink must be root-owned");
        }
        await requireRootControlledPath(await realpath(dirname(requested)));
      }
    }
    return requestedMetadata.isSymbolicLink() ? requested : canonical;
  };
  if (explicitExecutable !== undefined) return [await validate(explicitExecutable)];
  if (isSea()) return [await validate(process.execPath)];
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    throw new AgentError("SERVICE_EXECUTABLE_INVALID", "cannot determine the current AgentFleet entrypoint; use --executable");
  }
  return [await validate(process.execPath), await validate(entrypoint)];
}

async function ensureRegularUnit(path: string): Promise<"missing" | "regular"> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new AgentError("SERVICE_UNIT_UNSAFE", "refusing to replace a non-regular or symlinked service unit");
    }
    return "regular";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const directory = resolve(path, "..");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await syncDirectory(directory);
}

function commandFailure(operation: string, result: CommandResult): AgentError {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  return new AgentError("SYSTEMD_FAILED", `${operation} failed: ${detail}`);
}

async function requireManager(runCommand: CommandRunner, context: ServiceContext): Promise<void> {
  const result = await runCommand("systemctl", [...context.systemctlPrefix, "show-environment"]);
  if (result.exitCode !== 0) {
    throw new AgentError(
      "SYSTEMD_UNAVAILABLE",
      `${context.scope} systemd manager is unavailable`,
    );
  }
}

export type LingerState = "enabled" | "disabled" | "unknown" | "not_applicable";

export async function detectUserLinger(
  runCommand: CommandRunner = defaultRunner,
  uid: number | null = typeof process.getuid === "function" ? process.getuid() : null,
): Promise<LingerState> {
  if (uid === null) return "unknown";
  if (uid === 0) return "not_applicable";
  const result = await runCommand("loginctl", ["show-user", String(uid), "--property=Linger", "--value"]);
  if (result.exitCode !== 0) return "unknown";
  const value = result.stdout.trim().toLowerCase();
  if (value === "yes") return "enabled";
  if (value === "no") return "disabled";
  return "unknown";
}

export interface UserServiceStatus {
  scope: ServiceScope;
  installed: boolean;
  active: boolean;
  enabled: boolean;
  managerAvailable: boolean;
  linger: LingerState;
  unitPath: string;
  persistenceWarning?: string;
}

const LAUNCHD_LABEL = "cn.agentfleets.agent";
const WINDOWS_TASK_NAME = "AgentFleet-Background";

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function launchdPath(uid: number | null, environment: NodeJS.ProcessEnv = process.env): string {
  return uid === 0
    ? `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`
    : join(userHome(environment), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function launchdDomain(uid: number | null): string {
  return uid === 0 ? "system" : `gui/${uid ?? process.pid}`;
}

export function buildLaunchdPlist(options: { launch: string[]; dataDir: string; codexExecutable?: string; codexHome?: string }): string {
  if (options.launch.length === 0 || !options.launch.every(isAbsolute)) {
    throw new AgentError("SERVICE_EXECUTABLE_INVALID", "launchd program paths must be absolute");
  }
  const args = [...options.launch, "run", "--data-dir", resolve(options.dataDir)];
  const argumentXml = args.map((value) => `      <string>${xmlEscape(value)}</string>`).join("\n");
  const environment = {
    NODE_ENV: "production",
    NODE_NO_WARNINGS: "1",
    AGENTFLEET_AUTO_UPDATE: "1",
    ...(options.codexExecutable === undefined ? {} : { AGENTFLEET_CODEX_EXECUTABLE: options.codexExecutable }),
    ...(options.codexHome === undefined ? {} : { CODEX_HOME: options.codexHome }),
  };
  const environmentXml = Object.entries(environment)
    .map(([key, value]) => `      <key>${xmlEscape(key)}</key>\n      <string>${xmlEscape(value)}</string>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    argumentXml,
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    environmentXml,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict><key>SuccessfulExit</key><false/></dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>5</integer>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '</dict>',
    '</plist>',
    '',
  ].join("\n");
}

function windowsServicePath(dataDir: string): string {
  return join(resolve(dataDir), "agentfleet-service.cmd");
}

function quoteWindowsBatch(value: string): string {
  if (/[\0\r\n"]/u.test(value)) throw new AgentError("SERVICE_ARGUMENT_INVALID", "Windows service paths contain invalid characters");
  return `"${value.replaceAll("%", "%%")}"`;
}

export function buildWindowsServiceLauncher(options: { launch: string[]; dataDir: string; codexExecutable?: string; codexHome?: string }): string {
  if (options.launch.length === 0 || !options.launch.every(isAbsolute)) {
    throw new AgentError("SERVICE_EXECUTABLE_INVALID", "Windows service program paths must be absolute");
  }
  const command = [...options.launch, "run", "--data-dir", resolve(options.dataDir)].map(quoteWindowsBatch).join(" ");
  const invoke = /\.(?:cmd|bat)$/iu.test(options.launch[0] ?? "") ? `call ${command}` : command;
  return [
    "@echo off",
    "setlocal",
    'set "NODE_ENV=production"',
    'set "NODE_NO_WARNINGS=1"',
    'set "AGENTFLEET_AUTO_UPDATE=1"',
    ...(options.codexExecutable === undefined ? [] : [`set "AGENTFLEET_CODEX_EXECUTABLE=${options.codexExecutable.replaceAll("%", "%%")}"`]),
    ...(options.codexHome === undefined ? [] : [`set "CODEX_HOME=${options.codexHome.replaceAll("%", "%%")}"`]),
    ":agentfleet_restart",
    invoke,
    'set "AGENTFLEET_EXIT=%errorlevel%"',
    'if "%AGENTFLEET_EXIT%"=="0" exit /b 0',
    'timeout /t 5 /nobreak >nul',
    "goto agentfleet_restart",
    "exit /b %AGENTFLEET_EXIT%",
    "",
  ].join("\r\n");
}

export function buildWindowsTaskRegistration(path: string, deferred = false): string {
  quoteWindowsBatch(path); // Reject newlines/quotes before embedding a command path.
  const argument = `/d /s /c ""${path}""`.replaceAll("'", "''");
  const background = [
    "$ErrorActionPreference = 'Stop'",
    // The new task owns its process tree; retire the legacy visible task first.
    "Stop-ScheduledTask -TaskName 'AgentFleet' -ErrorAction SilentlyContinue",
    "Unregister-ScheduledTask -TaskName 'AgentFleet' -Confirm:$false -ErrorAction SilentlyContinue",
    `$service = '${path.replaceAll("'", "''")}'`,
    "$log = $service + '.log'",
    "$err = $service + '.error.log'",
    "foreach ($file in @($log, $err)) { if (Test-Path -LiteralPath $file) { Move-Item -LiteralPath $file -Destination ($file + '.previous') -Force } }",
    `$child = Start-Process -FilePath $env:ComSpec -ArgumentList '${argument}' -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $log -RedirectStandardError $err`,
    "exit $child.ExitCode",
  ].join("\n");
  const encoded = Buffer.from(background, "utf16le").toString("base64");
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    "try {",
    "  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    // An all-users logon trigger requires privileges that a per-user agent lacks.
    "  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid",
    "  $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited",
    ...(deferred ? ["  $trigger = @($trigger, (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1)))"] : []),
    `  $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -Argument '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}'`,
    "  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
    `  Stop-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}' -ErrorAction SilentlyContinue`,
    `  Register-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
    ...(deferred ? [] : [`  Start-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}'`]),
    "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
  ].join("\n");
}

async function getLaunchdStatus(options: {
  environment?: NodeJS.ProcessEnv;
  runCommand?: CommandRunner;
  uid?: number | null;
} = {}): Promise<UserServiceStatus> {
  const uid = options.uid === undefined ? typeof process.getuid === "function" ? process.getuid() : null : options.uid;
  const path = launchdPath(uid, options.environment);
  const installed = (await ensureRegularUnit(path)) === "regular";
  const runCommand = options.runCommand ?? defaultRunner;
  const result = await runCommand("launchctl", ["print", `${launchdDomain(uid)}/${LAUNCHD_LABEL}`]);
  return {
    scope: uid === 0 ? "launchd-system" : "launchd-user",
    installed,
    active: result.exitCode === 0,
    enabled: installed,
    managerAvailable: result.exitCode === 0 || installed,
    linger: "not_applicable",
    unitPath: path,
  };
}

async function writeAndActivateLaunchd(options: {
  action: "install" | "update";
  dataDir: string;
  executable?: string;
  environment?: NodeJS.ProcessEnv;
  runCommand?: CommandRunner;
  uid?: number | null;
}): Promise<UserServiceStatus> {
  const uid = options.uid === undefined ? typeof process.getuid === "function" ? process.getuid() : null : options.uid;
  const path = launchdPath(uid, options.environment);
  const priorState = await ensureRegularUnit(path);
  if (options.action === "update" && priorState === "missing") throw new AgentError("SERVICE_NOT_INSTALLED", "the AgentFleet launchd job is not installed");
  const priorContents = priorState === "regular" ? await readFile(path, "utf8") : undefined;
  const launch = await resolveServiceLaunch(options.executable, uid === 0 ? "system" : "user");
  const profile = await loadRuntimeProfile(options.dataDir, uid);
  const managedCodex = join(resolve(options.dataDir), "codex", "codex");
  const codexExecutable = profile?.codexExecutable ?? await executablePath(managedCodex).catch(() => undefined);
  await atomicWrite(path, buildLaunchdPlist({ launch, dataDir: options.dataDir, ...(codexExecutable ? { codexExecutable } : {}), ...(profile ? { codexHome: profile.codexHome } : {}) }));
  const runCommand = options.runCommand ?? defaultRunner;
  const domain = launchdDomain(uid);
  try {
    await runCommand("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
    const bootstrap = await runCommand("launchctl", ["bootstrap", domain, path]);
    if (bootstrap.exitCode !== 0) throw commandFailure("launchd bootstrap", bootstrap);
    const enable = await runCommand("launchctl", ["enable", `${domain}/${LAUNCHD_LABEL}`]);
    if (enable.exitCode !== 0) throw commandFailure("launchd enable", enable);
    const kickstart = await runCommand("launchctl", ["kickstart", "-k", `${domain}/${LAUNCHD_LABEL}`]);
    if (kickstart.exitCode !== 0) throw commandFailure("launchd kickstart", kickstart);
    return getLaunchdStatus({ ...(options.environment ? { environment: options.environment } : {}), runCommand, uid });
  } catch (error) {
    if (priorContents === undefined) await unlink(path).catch(() => undefined);
    else await atomicWrite(path, priorContents);
    throw error;
  }
}

async function getWindowsStatus(options: { runCommand?: CommandRunner; dataDir?: string } = {}): Promise<UserServiceStatus> {
  const dataDir = resolve(options.dataDir ?? join(process.env.LOCALAPPDATA ?? homedir(), "AgentFleet"));
  const path = windowsServicePath(dataDir);
  const installed = (await ensureRegularUnit(path)) === "regular";
  const result = await (options.runCommand ?? defaultRunner)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$task=Get-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}' -ErrorAction Stop; Write-Output $task.State`]);
  return {
    scope: "windows-user",
    installed,
    active: result.exitCode === 0 && result.stdout.trim().toLowerCase() === "running",
    enabled: result.exitCode === 0,
    managerAvailable: true,
    linger: "not_applicable",
    unitPath: path,
  };
}

async function writeAndActivateWindows(options: {
  action: "install" | "update";
  dataDir: string;
  executable?: string;
  runCommand?: CommandRunner;
  deferred?: boolean;
}): Promise<UserServiceStatus> {
  const path = windowsServicePath(options.dataDir);
  const priorState = await ensureRegularUnit(path);
  if (options.action === "update" && priorState === "missing") throw new AgentError("SERVICE_NOT_INSTALLED", "the AgentFleet scheduled task is not installed");
  const launch = await resolveServiceLaunch(options.executable);
  const profile = await loadRuntimeProfile(options.dataDir);
  const managedCodex = join(resolve(options.dataDir), "codex", "codex.exe");
  const codexExecutable = profile?.codexExecutable ?? await executablePath(managedCodex).catch(() => undefined);
  await atomicWrite(path, buildWindowsServiceLauncher({ launch, dataDir: options.dataDir, ...(codexExecutable ? { codexExecutable } : {}), ...(profile ? { codexHome: profile.codexHome } : {}) }));
  const runCommand = options.runCommand ?? defaultRunner;
  const created = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(buildWindowsTaskRegistration(path, options.deferred), "utf16le").toString("base64")]);
  if (created.exitCode !== 0) throw new AgentError("WINDOWS_TASK_FAILED",
    `Windows scheduled-task installation failed: ${created.stderr.trim() || created.stdout.trim() || `exit ${created.exitCode}`}`);
  return getWindowsStatus({ runCommand, dataDir: options.dataDir });
}

// Called only by staged Windows installs: the scheduler performs the handoff
// after the installer has returned and the update transaction has been saved.
export async function stageWindowsBackgroundService(dataDir: string, executable: string): Promise<void> {
  if (process.platform !== "win32") throw new AgentError("SERVICE_PLATFORM_INVALID", "Windows only");
  const result = await defaultRunner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `if (Get-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}' -ErrorAction SilentlyContinue) { exit 0 }; if (Get-ScheduledTask -TaskName 'AgentFleet' -ErrorAction SilentlyContinue) { exit 2 }; exit 0`]);
  if (result.exitCode === 2) await writeAndActivateWindows({ action: "install", dataDir, executable, deferred: true });
  else if (result.exitCode !== 0) throw new AgentError("WINDOWS_TASK_FAILED", "Unable to inspect service migration state");
}

export async function getUserServiceStatus(options: {
  environment?: NodeJS.ProcessEnv;
  runCommand?: CommandRunner;
  uid?: number | null;
} = {}): Promise<UserServiceStatus> {
  if (process.platform === "darwin") return getLaunchdStatus(options);
  if (process.platform === "win32") return getWindowsStatus({ ...(options.runCommand ? { runCommand: options.runCommand } : {}) });
  const uid = options.uid === undefined
    ? typeof process.getuid === "function" ? process.getuid() : null
    : options.uid;
  const runCommand = options.runCommand ?? defaultRunner;
  const context = serviceContext(uid, options.environment);
  const installed = (await ensureRegularUnit(context.unitPath)) === "regular";
  const manager = await runCommand("systemctl", [...context.systemctlPrefix, "show-environment"]);
  const managerAvailable = manager.exitCode === 0;
  const activeResult = managerAvailable
    ? await runCommand("systemctl", [...context.systemctlPrefix, "is-active", USER_SERVICE_NAME])
    : { exitCode: 1, stdout: "", stderr: "" };
  const enabledResult = managerAvailable
    ? await runCommand("systemctl", [...context.systemctlPrefix, "is-enabled", USER_SERVICE_NAME])
    : { exitCode: 1, stdout: "", stderr: "" };
  const linger = context.scope === "system" ? "not_applicable" : await detectUserLinger(runCommand, uid);
  return {
    scope: context.scope,
    installed,
    active: activeResult.exitCode === 0 && activeResult.stdout.trim() === "active",
    enabled: enabledResult.exitCode === 0 && enabledResult.stdout.trim() === "enabled",
    managerAvailable,
    linger,
    unitPath: context.unitPath,
    ...(context.scope === "user" && linger === "disabled"
      ? { persistenceWarning: "user lingering is disabled; the agent may stop after logout. Ask an administrator to enable linger for this user." }
      : context.scope === "user" && linger === "unknown"
        ? { persistenceWarning: "could not determine user lingering; verify it before relying on the agent after logout." }
        : {}),
  };
}

async function writeAndActivate(options: {
  action: "install" | "update";
  dataDir: string;
  executable?: string;
  environment?: NodeJS.ProcessEnv;
  runCommand?: CommandRunner;
  uid?: number | null;
}): Promise<UserServiceStatus> {
  const uid = options.uid === undefined
    ? typeof process.getuid === "function" ? process.getuid() : null
    : options.uid;
  const runCommand = options.runCommand ?? defaultRunner;
  const context = serviceContext(uid, options.environment);
  const dataDir = resolveServiceDataDir(options.dataDir, uid);
  await requireManager(runCommand, context);
  const priorState = await ensureRegularUnit(context.unitPath);
  if (options.action === "update" && priorState === "missing") {
    throw new AgentError("SERVICE_NOT_INSTALLED", "the AgentFleet service is not installed");
  }
  const priorContents = priorState === "regular" ? await readFile(context.unitPath, "utf8") : undefined;
  const launch = await resolveServiceLaunch(options.executable, context.scope);
  let codexExecutable: string | undefined;
  const profile = await loadRuntimeProfile(dataDir, uid);
  const codexHome = profile?.codexHome ?? options.environment?.CODEX_HOME ?? process.env.CODEX_HOME;
  {
    const configuredCodex = profile?.codexExecutable ?? options.environment?.AGENTFLEET_CODEX_EXECUTABLE
      ?? process.env.AGENTFLEET_CODEX_EXECUTABLE;
    if (configuredCodex !== undefined) {
      if (!isAbsolute(configuredCodex)) {
        throw new AgentError("SERVICE_EXECUTABLE_INVALID", "AGENTFLEET_CODEX_EXECUTABLE must be absolute");
      }
      codexExecutable = await executablePath(configuredCodex);
      if (context.scope === "system") await requireRootControlledPath(codexExecutable);
    } else {
      const managedCodex = join(dataDir, "codex", "codex");
      codexExecutable = await executablePath(managedCodex).catch(() => undefined);
    }
  }
  if (context.scope === "system" && codexHome !== undefined) await requireRootControlledPath(await realpath(codexHome));
  const contents = buildServiceUnit({
    launch,
    dataDir,
    scope: context.scope,
    ...(codexExecutable === undefined ? {} : { codexExecutable }),
    ...(codexHome === undefined ? {} : { codexHome }),
    ...(context.scope === "system" || (options.environment?.PATH ?? process.env.PATH) === undefined
      ? {}
      : { path: (options.environment?.PATH ?? process.env.PATH)! }),
  });
  await atomicWrite(context.unitPath, contents);
  try {
    const reload = await runCommand("systemctl", [...context.systemctlPrefix, "daemon-reload"]);
    if (reload.exitCode !== 0) throw commandFailure("systemd daemon-reload", reload);
    const activation = await runCommand(
      "systemctl",
      options.action === "install"
        ? [...context.systemctlPrefix, "enable", "--now", USER_SERVICE_NAME]
        : [...context.systemctlPrefix, "enable", USER_SERVICE_NAME],
    );
    if (activation.exitCode !== 0) throw commandFailure("systemd service activation", activation);
    if (options.action === "update" || priorState === "regular") {
      const restart = await runCommand("systemctl", [...context.systemctlPrefix, "restart", USER_SERVICE_NAME]);
      if (restart.exitCode !== 0) throw commandFailure("systemd service restart", restart);
    }
    const report = await getUserServiceStatus({
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      runCommand,
      uid,
    });
    if (!report.enabled || !report.active) {
      throw new AgentError("SYSTEMD_FAILED", "the AgentFleet service did not remain enabled and active");
    }
    return report;
  } catch (error) {
    if (priorContents === undefined) await unlink(context.unitPath).catch(() => undefined);
    else await atomicWrite(context.unitPath, priorContents);
    await runCommand("systemctl", [...context.systemctlPrefix, "daemon-reload"]);
    if (priorContents === undefined) {
      await runCommand("systemctl", [...context.systemctlPrefix, "disable", "--now", USER_SERVICE_NAME]);
    } else {
      await runCommand("systemctl", [...context.systemctlPrefix, "restart", USER_SERVICE_NAME]);
    }
    throw error;
  }
}

export async function installUserService(options: {
  dataDir: string;
  executable?: string;
  environment?: NodeJS.ProcessEnv;
  runCommand?: CommandRunner;
  uid?: number | null;
}): Promise<UserServiceStatus> {
  if (process.platform === "darwin") return writeAndActivateLaunchd({ action: "install", ...options });
  if (process.platform === "win32") return writeAndActivateWindows({ action: "install", ...options });
  return writeAndActivate({ action: "install", ...options });
}

export async function updateUserService(options: {
  dataDir: string;
  executable?: string;
  environment?: NodeJS.ProcessEnv;
  runCommand?: CommandRunner;
  uid?: number | null;
}): Promise<UserServiceStatus> {
  if (process.platform === "darwin") return writeAndActivateLaunchd({ action: "update", ...options });
  if (process.platform === "win32") return writeAndActivateWindows({ action: "update", ...options });
  return writeAndActivate({ action: "update", ...options });
}

export async function uninstallUserService(options: {
  environment?: NodeJS.ProcessEnv;
  runCommand?: CommandRunner;
  uid?: number | null;
} = {}): Promise<UserServiceStatus> {
  if (process.platform === "darwin") {
    const uid = options.uid === undefined ? typeof process.getuid === "function" ? process.getuid() : null : options.uid;
    const path = launchdPath(uid, options.environment);
    const runCommand = options.runCommand ?? defaultRunner;
    await runCommand("launchctl", ["bootout", `${launchdDomain(uid)}/${LAUNCHD_LABEL}`]);
    await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    return getLaunchdStatus({ ...(options.environment ? { environment: options.environment } : {}), runCommand, uid });
  }
  if (process.platform === "win32") {
    const runCommand = options.runCommand ?? defaultRunner;
    await runCommand("schtasks.exe", ["/End", "/TN", WINDOWS_TASK_NAME]);
    await runCommand("schtasks.exe", ["/Delete", "/F", "/TN", WINDOWS_TASK_NAME]);
    await runCommand("schtasks.exe", ["/End", "/TN", "AgentFleet"]);
    await runCommand("schtasks.exe", ["/Delete", "/F", "/TN", "AgentFleet"]);
    const dataDir = join(process.env.LOCALAPPDATA ?? homedir(), "AgentFleet");
    await unlink(windowsServicePath(dataDir)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    return getWindowsStatus({ runCommand, dataDir });
  }
  const uid = options.uid === undefined
    ? typeof process.getuid === "function" ? process.getuid() : null
    : options.uid;
  const runCommand = options.runCommand ?? defaultRunner;
  const context = serviceContext(uid, options.environment);
  await requireManager(runCommand, context);
  const state = await ensureRegularUnit(context.unitPath);
  if (state === "regular") {
    const disable = await runCommand("systemctl", [...context.systemctlPrefix, "disable", "--now", USER_SERVICE_NAME]);
    if (disable.exitCode !== 0 && !disable.stderr.includes("does not exist")) {
      throw commandFailure("systemd service removal", disable);
    }
    await unlink(context.unitPath);
    const reload = await runCommand("systemctl", [...context.systemctlPrefix, "daemon-reload"]);
    if (reload.exitCode !== 0) throw commandFailure("systemd daemon-reload", reload);
    await runCommand("systemctl", [...context.systemctlPrefix, "reset-failed", USER_SERVICE_NAME]);
  }
  return getUserServiceStatus({
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    runCommand,
    uid,
  });
}

function userHome(environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment.HOME ?? homedir();
  if (!isAbsolute(value)) throw new AgentError("HOME_INVALID", "HOME must be absolute");
  return value;
}

async function managedLinkTarget(linkPath: string, binaryRoot: string): Promise<{ raw: string; canonical: string }> {
  let metadata;
  try {
    metadata = await lstat(linkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AgentError("ROLLBACK_UNAVAILABLE", `missing managed link: ${linkPath}`);
    }
    throw error;
  }
  if (!metadata.isSymbolicLink()) {
    throw new AgentError("ROLLBACK_UNSAFE", `refusing to replace non-symlink path: ${linkPath}`);
  }
  const raw = await readlink(linkPath);
  const unresolved = isAbsolute(raw) ? raw : resolve(dirname(linkPath), raw);
  const canonical = await executablePath(unresolved);
  const canonicalRoot = await realpath(binaryRoot).catch(() => resolve(binaryRoot));
  if (!isPathInside(canonicalRoot, canonical)) {
    throw new AgentError("ROLLBACK_UNSAFE", "rollback target is outside the managed AgentFleet binary directory");
  }
  return { raw, canonical };
}

async function atomicSymlink(linkPath: string, target: string): Promise<void> {
  const temporary = `${linkPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await symlink(target, temporary);
    await rename(temporary, linkPath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Swap installer-managed current/previous binaries, regenerate the unit, and restart atomically on failure. */
export async function rollbackWindowsService(options: {
  dataDir: string;
  runCommand?: CommandRunner;
}): Promise<UserServiceStatus> {
  const bin = join(resolve(options.dataDir), "bin");
  const currentPath = join(bin, "current.txt");
  const previousPath = join(bin, "previous.txt");
  if (await ensureRegularUnit(currentPath) !== "regular" || await ensureRegularUnit(previousPath) !== "regular") {
    throw new AgentError("ROLLBACK_UNAVAILABLE", "Windows current and previous release pointers are required");
  }
  const current = (await readFile(currentPath, "utf8")).trim();
  const previous = (await readFile(previousPath, "utf8")).trim();
  if (!/^\d+\.\d+\.\d+$/.test(current) || !/^\d+\.\d+\.\d+$/.test(previous) || current === previous) {
    throw new AgentError("ROLLBACK_UNSAFE", "Windows release pointers must identify two different managed versions");
  }
  await executablePath(join(bin, previous, "agentfleet.cmd"));
  await atomicWrite(currentPath, previous);
  try {
    await atomicWrite(previousPath, current);
    return await writeAndActivateWindows({ action: "update", dataDir: options.dataDir,
      executable: join(options.dataDir, "agentfleet.cmd"), ...(options.runCommand ? { runCommand: options.runCommand } : {}) });
  } catch (error) {
    await atomicWrite(currentPath, current);
    await atomicWrite(previousPath, previous);
    throw error;
  }
}

export async function rollbackUserService(options: {
  dataDir: string;
  environment?: NodeJS.ProcessEnv;
  runCommand?: CommandRunner;
  uid?: number | null;
}): Promise<UserServiceStatus> {
  if (process.platform === "win32") return rollbackWindowsService(options);
  const uid = options.uid === undefined
    ? typeof process.getuid === "function" ? process.getuid() : null
    : options.uid;
  const environment = options.environment ?? process.env;
  const home = uid === 0 && process.platform === "linux" ? ROOT_HOME : userHome(environment);
  const dataHome = uid === 0 && process.platform === "linux" ? ROOT_DATA_HOME : environment.XDG_DATA_HOME ?? join(home, ".local", "share");
  if (!isAbsolute(dataHome)) throw new AgentError("DATA_DIR_INVALID", "XDG_DATA_HOME must be absolute");
  const binaryRoot = join(dataHome, "agentfleet", "bin");
  const currentLink = join(home, ".local", "bin", "agentfleet");
  const previousLink = join(home, ".local", "bin", "agentfleet.previous");
  const current = await managedLinkTarget(currentLink, binaryRoot);
  const previous = await managedLinkTarget(previousLink, binaryRoot);
  if (current.canonical === previous.canonical) {
    throw new AgentError("ROLLBACK_UNAVAILABLE", "current and previous AgentFleet binaries are the same version");
  }
  const runCommand = options.runCommand ?? defaultRunner;
  if (process.platform === "linux") await requireManager(runCommand, serviceContext(uid, options.environment));
  await atomicSymlink(currentLink, previous.raw);
  try {
    await atomicSymlink(previousLink, current.raw);
  } catch (error) {
    await atomicSymlink(currentLink, current.raw);
    throw error;
  }
  try {
    return await updateUserService({
      dataDir: resolveServiceDataDir(options.dataDir, uid),
      executable: currentLink,
      environment,
      runCommand,
      uid,
    });
  } catch (error) {
    await atomicSymlink(currentLink, current.raw);
    await atomicSymlink(previousLink, previous.raw);
    throw error;
  }
}
