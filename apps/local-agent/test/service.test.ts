import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildServiceUnit,
  buildLaunchdPlist,
  buildWindowsServiceLauncher,
  buildUserServiceUnit,
  installUserService,
  quoteSystemdArgument,
  ROOT_AGENT_DATA_DIR,
  ROOT_CODEX_HOME,
  ROOT_MANAGED_CODEX_EXECUTABLE,
  resolveCodexExecutable,
  resolveServiceLaunch,
  resolveServiceDataDir,
  rollbackUserService,
  systemServicePath,
  uninstallUserService,
  updateUserService,
  userServicePath,
  type CommandRunner,
} from "../src/service.js";
import { normalizeRootRuntimeEnvironment } from "../src/cli.js";

function successfulRunner(calls: string[][]): CommandRunner {
  return async (file, args) => {
    calls.push([file, ...args]);
    if (file === "loginctl") return { exitCode: 0, stdout: "no\n", stderr: "" };
    if (args.includes("is-active")) return { exitCode: 0, stdout: "active\n", stderr: "" };
    if (args.includes("is-enabled")) return { exitCode: 0, stdout: "enabled\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

test("systemd argument quoting escapes specifiers and rejects line breaks", () => {
  assert.equal(quoteSystemdArgument('/opt/A%B/agent "one"'), '"/opt/A%%B/agent \\"one\\""');
  assert.throws(() => quoteSystemdArgument("one\ntwo"), /single-line/);
});

test("service unit contains no control-plane credential or URL", () => {
  const unit = buildUserServiceUnit({
    launch: ["/opt/agent fleet/agentfleet"],
    dataDir: "/home/person/.local/share/agentfleet",
    path: "/usr/bin:/bin",
  });
  assert.match(unit, /ExecStart="\/opt\/agent fleet\/agentfleet" "run" "--data-dir"/);
  assert.doesNotMatch(unit, /--url|token|ticket|secret/iu);
  assert.match(unit, /NoNewPrivileges=true/);
  assert.match(unit, /UMask=0077/);
  assert.match(unit, /Environment=AGENTFLEET_AUTO_UPDATE=1/);
});

test("user service pins an absolute managed Codex executable", () => {
  const unit = buildUserServiceUnit({
    launch: ["/opt/agentfleet"],
    dataDir: "/home/person/.local/share/agentfleet",
    path: "/usr/bin:/bin",
    codexExecutable: "/home/person/.local/share/agentfleet/codex/codex",
  });
  assert.match(
    unit,
    /Environment="AGENTFLEET_CODEX_EXECUTABLE=\/home\/person\/\.local\/share\/agentfleet\/codex\/codex"/,
  );
  assert.throws(
    () => buildUserServiceUnit({ launch: ["/opt/agentfleet"], dataDir: "/tmp/state", codexExecutable: "codex" }),
    /must be absolute/,
  );
});

test("macOS launchd and Windows task launchers preserve the fixed service environment", () => {
  const plist = buildLaunchdPlist({
    launch: ["/Users/person/.local/bin/agentfleet"],
    dataDir: "/Users/person/Library/Application Support/AgentFleet",
    codexExecutable: "/Users/person/Library/Application Support/AgentFleet/codex/codex",
  });
  assert.match(plist, /cn\.agentfleets\.agent/);
  assert.match(plist, /AGENTFLEET_AUTO_UPDATE/);
  assert.match(plist, /Application Support\/AgentFleet/);
  assert.doesNotMatch(plist, /ticket|secret/iu);

  const windows = buildWindowsServiceLauncher({
    launch: ["/C:/AgentFleet/runtime/node.exe", "/C:/AgentFleet/lib/dist/src/cli.js"],
    dataDir: "/C:/Users/person/AppData/Local/AgentFleet",
    codexExecutable: "/C:/Users/person/AppData/Local/AgentFleet/codex/codex.exe",
  });
  assert.match(windows, /AGENTFLEET_AUTO_UPDATE=1/);
  assert.match(windows, /node\.exe/);
  assert.doesNotMatch(windows, /ticket|secret/iu);
});

test("user service install, update, and uninstall use only systemctl --user", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-service-test-"));
  const executable = join(directory, "agentfleet-bin");
  await writeFile(executable, "binary");
  await chmod(executable, 0o700);
  const environment = { XDG_CONFIG_HOME: join(directory, "config") };
  const calls: string[][] = [];
  const runCommand = successfulRunner(calls);
  const dataDir = join(directory, "state");

  const installed = await installUserService({ executable, dataDir, environment, runCommand, uid: 1000 });
  assert.equal(installed.installed, true);
  assert.equal(installed.active, true);
  assert.equal(installed.enabled, true);
  assert.equal(installed.linger, "disabled");
  assert.match(installed.persistenceWarning ?? "", /after logout/);
  const unit = await readFile(userServicePath(environment), "utf8");
  assert.match(unit, new RegExp(executable.replaceAll("/", "\\/")));
  assert.ok(calls.every(([file, first]) => file === "loginctl" || (file === "systemctl" && first === "--user")));
  assert.ok(calls.some((call) => call.includes("--now") && call.includes("enable")));

  calls.length = 0;
  await updateUserService({ executable, dataDir, environment, runCommand, uid: 1000 });
  assert.ok(calls.some((call) => call.includes("restart")));

  calls.length = 0;
  const removed = await uninstallUserService({ environment, runCommand, uid: 1000 });
  assert.equal(removed.installed, false);
  assert.ok(calls.some((call) => call.includes("disable") && call.includes("--now")));
  assert.ok(calls.every(([file, first]) => file === "loginctl" || (file === "systemctl" && first === "--user")));
});

test("user service install persists the installer-selected Codex executable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-service-codex-test-"));
  const executable = join(directory, "agentfleet-bin");
  const codexExecutable = join(directory, "managed-codex");
  await writeFile(executable, "binary");
  await writeFile(codexExecutable, "codex");
  await chmod(executable, 0o700);
  await chmod(codexExecutable, 0o700);
  const environment = {
    XDG_CONFIG_HOME: join(directory, "config"),
    AGENTFLEET_CODEX_EXECUTABLE: codexExecutable,
  };
  await installUserService({
    executable,
    dataDir: join(directory, "state"),
    environment,
    runCommand: successfulRunner([]),
    uid: 1000,
  });
  const unit = await readFile(userServicePath(environment), "utf8");
  assert.ok(unit.includes(`Environment="AGENTFLEET_CODEX_EXECUTABLE=${codexExecutable}"`));
});

test("root lifecycle uses the system manager without user-scope flags", { skip: typeof process.getuid !== "function" || process.getuid() !== 0 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-root-service-test-"));
  const environment = { AGENTFLEET_SYSTEMD_UNIT_DIR: join(directory, "systemd") };
  const calls: string[][] = [];
  const runCommand = successfulRunner(calls);
  const installed = await installUserService({
    dataDir: join(directory, "state"),
    executable: "/bin/true",
    environment,
    runCommand,
    uid: 0,
  });
  assert.equal(installed.scope, "system");
  assert.equal(installed.linger, "not_applicable");
  assert.equal(installed.unitPath, systemServicePath(environment));
  assert.ok(calls.every(([file, first]) => file === "systemctl" && first !== "--user"));
  const unit = await readFile(systemServicePath(environment), "utf8");
  assert.ok(unit.includes(`"--data-dir" "${ROOT_AGENT_DATA_DIR}"`));
  assert.doesNotMatch(unit, new RegExp(directory.replaceAll("/", "\\/")));
  assert.match(unit, /WantedBy=multi-user\.target/);
  assert.match(unit, /Environment="HOME=\/root"/);
  assert.ok(unit.includes(`Environment="CODEX_HOME=${ROOT_CODEX_HOME}"`));
  assert.match(unit, /Environment="PATH=\/root\/\.local\/bin:\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin"/);
  assert.doesNotMatch(unit, /evil|untrusted/);

  calls.length = 0;
  const removed = await uninstallUserService({ environment, runCommand, uid: 0 });
  assert.equal(removed.scope, "system");
  assert.equal(removed.installed, false);
  assert.ok(calls.every(([file, first]) => file === "systemctl" && first !== "--user"));
});

test("root service data directory cannot be redirected by argv or API callers", () => {
  assert.equal(resolveServiceDataDir("/home/untrusted/agentfleet", 0), ROOT_AGENT_DATA_DIR);
  assert.equal(resolveServiceDataDir("./relative-state", 1000), resolve("./relative-state"));
});

test("root Codex resolution prefers the root-managed executable", async () => {
  assert.equal(ROOT_MANAGED_CODEX_EXECUTABLE, "/root/.local/share/agentfleet/codex/codex");
  assert.equal(await resolveCodexExecutable(0, {}, "/bin/true"), resolve("/usr/bin/true"));
});

test("system service unit uses the boot target", () => {
  const unit = buildServiceUnit({ launch: ["/bin/agentfleet"], dataDir: "/root/.local/share/agentfleet", path: "/evil/untrusted", scope: "system" });
  assert.match(unit, /WantedBy=multi-user\.target/);
  assert.doesNotMatch(unit, /--user/);
  assert.doesNotMatch(unit, /evil|untrusted/);
});

test("root runtime ignores inherited user HOME, XDG paths, PATH, and Node injection variables", () => {
  const environment: NodeJS.ProcessEnv = {
    HOME: "/home/untrusted",
    XDG_DATA_HOME: "/home/untrusted/data",
    XDG_CONFIG_HOME: "/home/untrusted/config",
    PATH: "/home/untrusted/bin:/usr/bin",
    NODE_OPTIONS: "--require=/home/untrusted/inject.js",
    AGENTFLEET_HOME: "/home/untrusted/state",
    CODEX_HOME: "/home/untrusted/.codex",
  };
  normalizeRootRuntimeEnvironment(environment, 0);
  assert.equal(environment.HOME, "/root");
  assert.equal(environment.XDG_DATA_HOME, "/root/.local/share");
  assert.equal(environment.XDG_CONFIG_HOME, "/root/.config");
  assert.equal(environment.PATH, "/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.AGENTFLEET_HOME, undefined);
  assert.equal(environment.CODEX_HOME, ROOT_CODEX_HOME);
});

test("system service rejects an executable reachable through a world-writable parent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-unsafe-root-exec-"));
  const executable = join(directory, "agentfleet");
  await writeFile(executable, "binary");
  await chmod(executable, 0o700);
  await assert.rejects(resolveServiceLaunch(executable, "system"), /root-owned and not group\/world writable/);
});

test("service rollback swaps only installer-managed version links and restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-rollback-test-"));
  const dataHome = join(directory, "data");
  const binaryRoot = join(dataHome, "agentfleet", "bin");
  const currentTarget = join(binaryRoot, "2.0.0", "agentfleet");
  const previousTarget = join(binaryRoot, "1.0.0", "agentfleet");
  const userBin = join(directory, ".local", "bin");
  const currentLink = join(userBin, "agentfleet");
  const previousLink = join(userBin, "agentfleet.previous");
  await mkdir(join(binaryRoot, "2.0.0"), { recursive: true });
  await mkdir(join(binaryRoot, "1.0.0"), { recursive: true });
  await mkdir(userBin, { recursive: true });
  await writeFile(currentTarget, "current");
  await writeFile(previousTarget, "previous");
  await chmod(currentTarget, 0o700);
  await chmod(previousTarget, 0o700);
  await symlink(currentTarget, currentLink);
  await symlink(previousTarget, previousLink);
  const environment = {
    HOME: directory,
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: join(directory, "config"),
    PATH: "/usr/bin:/bin",
  };
  const calls: string[][] = [];
  const runCommand = successfulRunner(calls);
  await installUserService({
    executable: currentLink,
    dataDir: join(dataHome, "agentfleet"),
    environment,
    runCommand,
    uid: 1000,
  });

  calls.length = 0;
  await rollbackUserService({
    dataDir: join(dataHome, "agentfleet"),
    environment,
    runCommand,
    uid: 1000,
  });
  assert.equal(await readlink(currentLink), previousTarget);
  assert.equal(await readlink(previousLink), currentTarget);
  assert.ok(calls.some((call) => call.includes("restart")));
  assert.match(await readFile(userServicePath(environment), "utf8"), new RegExp(currentLink.replaceAll("/", "\\/")));
});

test("failed service update restores the previous unit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-service-update-fail-"));
  const oldExecutable = join(directory, "old-agentfleet");
  const newExecutable = join(directory, "new-agentfleet");
  await writeFile(oldExecutable, "old");
  await writeFile(newExecutable, "new");
  await chmod(oldExecutable, 0o700);
  await chmod(newExecutable, 0o700);
  const environment = { XDG_CONFIG_HOME: join(directory, "config"), PATH: "/usr/bin:/bin" };
  const calls: string[][] = [];
  const goodRunner = successfulRunner(calls);
  await installUserService({
    executable: oldExecutable,
    dataDir: join(directory, "state"),
    environment,
    runCommand: goodRunner,
    uid: 1000,
  });
  const originalUnit = await readFile(userServicePath(environment), "utf8");
  const failingRunner: CommandRunner = async (file, args) => {
    if (file === "loginctl") return { exitCode: 0, stdout: "yes\n", stderr: "" };
    if (args.includes("restart")) return { exitCode: 1, stdout: "", stderr: "restart rejected" };
    if (args.includes("is-active")) return { exitCode: 0, stdout: "active\n", stderr: "" };
    if (args.includes("is-enabled")) return { exitCode: 0, stdout: "enabled\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(
    updateUserService({
      executable: newExecutable,
      dataDir: join(directory, "state"),
      environment,
      runCommand: failingRunner,
      uid: 1000,
    }),
    /restart rejected/,
  );
  assert.equal(await readFile(userServicePath(environment), "utf8"), originalUnit);
});
