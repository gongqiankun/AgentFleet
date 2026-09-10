import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { windowsSandboxProbe } from "../src/preflight.js";
import { buildWindowsTaskRegistration } from "../src/service.js";

const powershell = process.env.AGENTFLEET_TEST_POWERSHELL_EXECUTABLE ??
  (process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "");
const run = promisify(execFile);
const native = { skip: !powershell || !existsSync(powershell), timeout: 20_000 };

for (const language of ["FullLanguage", "ConstrainedLanguage"]) test(`PowerShell probe handles Unicode/quotes and verifies writes in ${language}`, native, async t => {
  const root = await mkdtemp(join(tmpdir(), "agentfleet-probe-中文-'-$-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inside = join(root, "inside.txt");
  const marker = "probe-中文-'-$-marker";
  const probe = (insidePath: string, outsidePath: string) => {
    const args = windowsSandboxProbe(insidePath, outsidePath, marker);
    const script = `$ExecutionContext.SessionState.LanguageMode = '${language}'\n` + Buffer.from(args.at(-1)!, "base64").toString("utf16le");
    args[args.length - 1] = Buffer.from(script, "utf16le").toString("base64");
    return args;
  };
  // A missing outside parent models a denied write; this tests the script, not OS isolation.
  await run(powershell, probe(inside, join(root, "absent", "outside")), { timeout: 5000 });
  assert.equal((await readFile(inside, "utf8")).replace(/^\uFEFF/, ""), marker);
  await assert.rejects(run(powershell, probe(inside, join(root, "outside.txt")), { timeout: 5000 }), { code: 42 });
  await assert.rejects(run(powershell, probe(join(root, "absent", "inside"), join(root, "other.txt")), { timeout: 5000 }), error => {
    const failure = error as { code?: number; stdout?: string };
    assert.equal(failure.code, 41);
    assert.match(failure.stdout ?? "", /AGENTFLEET_PROBE_INSIDE_WRITE_FAILED:/);
    return true;
  });
});

test("task registration preserves paths and scopes both trigger and execution to the current limited user", native, async () => {
  const sid = "S-1-5-21-111-222-333-1001";
  const path = "C:\\Users\\A 'B & 中文\\AgentFleet\\agentfleet-service.cmd";
  // Execute the actual generated PowerShell with task cmdlets replaced by recorders.
  // Never register or run an OS task during this test.
  const stubs = `
$script:record = @{}
function New-ScheduledTaskTrigger { param([switch]$AtLogOn, [string]$User) $script:record.trigger = @{logon=[bool]$AtLogOn;user=$User}; return @{} }
function New-ScheduledTaskPrincipal { param([string]$UserId, [string]$LogonType, [string]$RunLevel) $script:record.principal = @{user=$UserId;logon=$LogonType;level=$RunLevel}; return @{} }
function New-ScheduledTaskAction { param([string]$Execute, [string]$Argument) $script:record.action = @{execute=$Execute;argument=$Argument}; return @{} }
function New-ScheduledTaskSettingsSet { param([TimeSpan]$ExecutionTimeLimit, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries) $script:record.settings = @{seconds=$ExecutionTimeLimit.TotalSeconds;startBattery=[bool]$AllowStartIfOnBatteries;stayBattery=[bool]$DontStopIfGoingOnBatteries}; return @{} }
function Stop-ScheduledTask { [CmdletBinding()]param([string]$TaskName) $script:record.stopped=$TaskName }
function Register-ScheduledTask { param($TaskName,$Action,$Trigger,$Principal,$Settings,[switch]$Force) $script:record.registered=$TaskName }
function Start-ScheduledTask { param($TaskName) $script:record.started=$TaskName }
`;
  const script = stubs + buildWindowsTaskRegistration(path).replace("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value", `'${sid}'`) + "\n$script:record | ConvertTo-Json -Compress";
  const { stdout } = await run(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { timeout: 5000, env: { ...process.env, ComSpec: "C:\\Windows\\System32\\cmd.exe", SystemRoot: "/windows" } });
  const record = JSON.parse(stdout);
  assert.deepEqual(record.trigger, { logon: true, user: sid });
  assert.deepEqual(record.principal, { user: sid, logon: "Interactive", level: "Limited" });
  assert.match(record.action.execute, /powershell.exe$/);
  assert.match(record.action.argument, /-WindowStyle Hidden -EncodedCommand /);
  const childScript = Buffer.from(record.action.argument.split(" ").at(-1), "base64").toString("utf16le");
  assert.ok(childScript.includes(path.replaceAll("'", "''")));
  assert.match(childScript, /-WindowStyle Hidden -Wait -PassThru/);
  assert.match(childScript, /-RedirectStandardOutput/);
  assert.match(childScript, /Stop-ScheduledTask -TaskName 'AgentFleet'/);
  assert.deepEqual(record.settings, { seconds: 0, startBattery: true, stayBattery: true });
  assert.equal(record.registered, "AgentFleet-Background");
  assert.equal(record.started, "AgentFleet-Background");
});

test("task paths cannot introduce additional PowerShell statements", () => {
  assert.throws(() => buildWindowsTaskRegistration('C:\\path";bad'), { code: "SERVICE_ARGUMENT_INVALID" });
  assert.throws(() => buildWindowsTaskRegistration("C:\\path\nbad"), { code: "SERVICE_ARGUMENT_INVALID" });
});
