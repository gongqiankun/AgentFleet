import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { release as platformRelease, tmpdir, homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  isSupportedCodexVersion,
  MINIMUM_MACOS_MAJOR,
  MINIMUM_CODEX_VERSION,
  MINIMUM_WINDOWS_BUILD,
  expectedCodexSchemaHash,
  REQUIRED_NODE_MAJOR,
} from "./constants.js";
import type { CredentialProtectionLevel, SupportReport } from "./types.js";
import { resolveCodexExecutable } from "./service.js";
import { detectHostCodex } from "./host-codex.js";
import { check, checkCodexHome, checkSandbox, checkCodeMode } from "./preflight.js";

const execFileAsync = promisify(execFile);

function parseOsRelease(contents: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of contents.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key !== undefined) result[key] = value;
  }
  return result;
}

export interface PlatformInputs {
  platform: NodeJS.Platform;
  architecture: string;
  uid: number | null;
  nodeVersion: string;
  osRelease: string;
  codexVersion: string | null;
  codexSchemaHash: string | null;
  credentialProtectionLevel: CredentialProtectionLevel;
}

export function evaluateSupport(inputs: PlatformInputs): SupportReport {
  const os = parseOsRelease(inputs.osRelease);
  const reasons: string[] = [];
  if (inputs.platform === "linux") {
    if (inputs.architecture !== "x64") reasons.push("Linux write mode currently requires x86_64");
    // Distribution labels are inventory, not runtime compatibility evidence.
    // Keep architecture, Node, protocol and runtime readiness gates below.
  } else if (inputs.platform === "darwin") {
    if (inputs.architecture !== "x64" && inputs.architecture !== "arm64") {
      reasons.push("macOS write mode requires Apple Silicon or x86_64");
    }
    const major = Number.parseInt((os.VERSION_ID ?? "").split(".")[0] ?? "", 10);
    if (os.ID !== "macos" || !Number.isSafeInteger(major) || major < MINIMUM_MACOS_MAJOR) {
      reasons.push(`macOS ${MINIMUM_MACOS_MAJOR} or newer is required`);
    }
  } else if (inputs.platform === "win32") {
    if (inputs.architecture !== "x64") reasons.push("Windows write mode currently requires x86_64");
    const build = Number.parseInt((os.VERSION_ID ?? "").split(".")[2] ?? "", 10);
    if (os.ID !== "windows" || !Number.isSafeInteger(build) || build < MINIMUM_WINDOWS_BUILD) {
      reasons.push(`Windows 10 build ${MINIMUM_WINDOWS_BUILD} or newer is required`);
    }
  } else {
    reasons.push("AgentFleet P0b supports Linux, macOS, and Windows only");
  }
  const nodeMajor = Number.parseInt(inputs.nodeVersion.replace(/^v/, "").split(".")[0] ?? "", 10);
  if (nodeMajor !== REQUIRED_NODE_MAJOR) reasons.push(`Node ${REQUIRED_NODE_MAJOR} is required`);
  if (inputs.codexVersion === null || !isSupportedCodexVersion(inputs.codexVersion)) {
    reasons.push(`codex-cli ${MINIMUM_CODEX_VERSION} or newer is required`);
  }
  const expectedSchemaHash = expectedCodexSchemaHash();
  if (inputs.codexSchemaHash !== expectedSchemaHash) {
    reasons.push("codex app-server v2 schema hash does not match the pinned compatibility profile");
  }
  if (inputs.credentialProtectionLevel === "unknown") {
    reasons.push("machine credential protection could not be verified");
  }
  return {
    supported: reasons.length === 0,
    writable: reasons.length === 0,
    readOnlyReasons: reasons,
    platform: inputs.platform,
    architecture: inputs.architecture,
    osId: os.ID ?? "unknown",
    osVersion: os.VERSION_ID ?? "unknown",
    uid: inputs.uid,
    nodeVersion: inputs.nodeVersion,
    codexVersion: inputs.codexVersion,
    codexSchemaHash: inputs.codexSchemaHash,
    expectedCodexSchemaHash: expectedSchemaHash,
    // Read-only adapters do not require the OS sandbox write profile. Unknown
    // schemas still remain closed until a separately validated adapter exists.
    readable: nodeMajor === REQUIRED_NODE_MAJOR && inputs.codexVersion !== null &&
      isSupportedCodexVersion(inputs.codexVersion) && inputs.codexSchemaHash === expectedSchemaHash,
    ...(inputs.codexSchemaHash === expectedSchemaHash ? {} : { readCompatibilityReason: "No validated read adapter is available for this Codex schema" }),
  };
}

async function detectCodexSchemaHash(codexExecutable: string): Promise<string | null> {
  const directory = await mkdtemp(join(tmpdir(), "agentfleet-codex-schema-"));
  try {
    await execFileAsync(codexExecutable, ["app-server", "generate-json-schema", "--out", directory], {
      timeout: 15_000,
      maxBuffer: 64 * 1_024,
      encoding: "utf8",
    });
    const contents = await readFile(join(directory, "codex_app_server_protocol.v2.schemas.json"));
    return createHash("sha256").update(contents).digest("hex");
  } catch {
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function detectSupport(
  credentialProtectionLevel: CredentialProtectionLevel,
): Promise<SupportReport> {
  let osRelease = "";
  let codexVersion: string | null = null;
  let codexSchemaHash: string | null = null;
  let runtimePath: string | null = null;
  if (process.platform === "linux") {
    try {
      osRelease = await readFile("/etc/os-release", "utf8");
    } catch {
      // Linux distro labels are optional inventory, not compatibility gates.
    }
  } else if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("/usr/bin/sw_vers", ["-productVersion"], {
        timeout: 5_000,
        maxBuffer: 16_384,
        encoding: "utf8",
      });
      osRelease = `ID=macos\nVERSION_ID=${stdout.trim()}\n`;
    } catch {
      osRelease = `ID=macos\nVERSION_ID=${platformRelease()}\n`;
    }
  } else if (process.platform === "win32") {
    osRelease = `ID=windows\nVERSION_ID=${platformRelease()}\n`;
  }
  try {
    const codexExecutable = await resolveCodexExecutable();
    runtimePath = codexExecutable;
    const { stdout } = await execFileAsync(codexExecutable, ["--version"], {
      timeout: 5_000,
      maxBuffer: 16_384,
      encoding: "utf8",
    });
    const match = /^codex-cli\s+([^\s]+)\s*$/m.exec(stdout);
    codexVersion = match?.[1] ?? null;
    if (codexVersion !== null) codexSchemaHash = await detectCodexSchemaHash(codexExecutable);
  } catch {
    codexVersion = null;
  }
  const support = evaluateSupport({
    platform: process.platform,
    architecture: process.arch,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    nodeVersion: process.version,
    osRelease,
    codexVersion,
    codexSchemaHash,
    credentialProtectionLevel,
  });
  const source = process.env.AGENTFLEET_RUNTIME_SOURCE === "managed" || /[\\/]agentfleet[\\/]codex[\\/]/i.test(runtimePath ?? "") ? "managed" : "host";
  const host = await detectHostCodex({ runtimePath, source });
  support.codexProfile = { id: "default", osAccount: userInfo().username,
    codexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"), ...host,
    runtimePath, runtimeVersion: codexVersion, source };
  const environmentReasons = support.readOnlyReasons.filter(reason => !reason.startsWith("codex"));
  support.checks = [
    check("environment", environmentReasons.length ? "failed" : "passed", environmentReasons.length ? "ENVIRONMENT_UNSUPPORTED" : "ENVIRONMENT_SUPPORTED",
      environmentReasons.join("; ") || `连接服务运行正常 · ${process.platform} ${process.arch} · Node ${process.version}`, "agent.update"),
    check("runtime", codexVersion ? "passed" : "failed", codexVersion ? "RUNTIME_STARTED" : "RUNTIME_UNAVAILABLE",
      codexVersion ? `面板使用的 Codex ${codexVersion} 可启动（${source === "managed" ? "独立托管" : "主机自装"}）` : "面板使用的 Codex 无法启动，请检查并更新连接服务", "agent.update"),
    check("protocol", support.readable ? "passed" : "failed", support.readable ? "PROTOCOL_VERIFIED" : "PROTOCOL_UNSUPPORTED",
      support.readable ? "Codex 接口与已验证适配器一致" : "尚无可用的已验证接口适配器，请检查并更新", "agent.update"),
  ];
  await refreshEnvironmentChecks(support);
  return support;
}

export async function refreshEnvironmentChecks(support: SupportReport): Promise<void> {
  if (!support.codexProfile) return;
  const data = await checkCodexHome(support.codexProfile.codexHome);
  const sandbox = support.readable && support.codexProfile.runtimePath
    ? await checkSandbox(support.codexProfile.runtimePath)
    : check("sandbox", "skipped", "RUNTIME_REQUIRED", "等待 Codex 运行环境通过检查");
  const tools = support.readable && support.codexProfile.runtimePath
    ? await checkCodeMode(support.codexProfile.runtimePath)
    : check("tools", "skipped", "RUNTIME_REQUIRED", "等待 Codex 运行环境通过检查");
  support.checks = [...(support.checks ?? []).filter(item => !["data", "sandbox", "tools"].includes(item.id)), data, sandbox, tools];
  support.readOnlyReasons = support.readOnlyReasons.filter(reason => !reason.startsWith("[preflight]"));
  for (const item of [data, sandbox, tools]) if (item.state === "failed") support.readOnlyReasons.push(`[preflight] ${item.code}: ${item.message}`);
  support.writable = support.supported && ![data, sandbox, tools].some(item => item.state === "failed");
}
