import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, link, copyFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { CODEX_COMPATIBILITY_PROFILE, validatedCodexSchemaHash } from "./api-schema.js";
import { channelControl, channelState, writeChannelJson, type RuntimeChannelState, type RuntimeTarget } from "./runtime-channel.js";
import { downloadVerified, unpackRuntime, validateRuntime, sha256File, MAX_RUNTIME_BYTES } from "./runtime-validation.js";
import { probeCodeModeHost } from "./code-mode-probe.js";

export const RUNTIME_PLATFORMS: Record<string, string> = {
  "linux-x64": "codex-x86_64-unknown-linux-musl",
  "darwin-arm64": "codex-aarch64-apple-darwin",
  "darwin-x64": "codex-x86_64-apple-darwin",
  "win32-x64": "codex-x86_64-pc-windows-msvc.exe",
};
export const CODE_MODE_PLATFORMS = Object.fromEntries(Object.entries(RUNTIME_PLATFORMS).map(([platform, name]) => [platform, name.replace("codex-", "codex-code-mode-host-")]));
const completeHelpers = (target: RuntimeTarget) => Object.keys(RUNTIME_PLATFORMS).every(platform => target.codeModeHosts?.[platform]);
interface OfficialRelease { tag_name: string; draft: boolean; prerelease: boolean; assets: { name: string; size: number; digest: string }[] }
export function stableRelease(input: unknown): { version: string; assets: OfficialRelease["assets"] } {
  const release = input as OfficialRelease;
  const match = /^rust-v(\d+\.\d+\.\d+)$/.exec(release?.tag_name ?? "");
  if (!match || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) throw new Error("官方发布不是完整稳定版，跳过晋升");
  for (const entry of [...Object.values(RUNTIME_PLATFORMS), ...Object.values(CODE_MODE_PLATFORMS), "bwrap-x86_64-unknown-linux-musl"]) {
    const assets = release.assets.filter(asset => asset.name === `${entry}.tar.gz`);
    if (assets.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(assets[0]?.digest ?? "") || !Number.isSafeInteger(assets[0]?.size) || assets[0]!.size <= 0 || assets[0]!.size > MAX_RUNTIME_BYTES) throw new Error("官方稳定版缺少完整的平台安装包或 SHA-256，等待发布完成");
  }
  return { version: match[1]!, assets: release.assets };
}
export function newerVersion(left: string, right: string): boolean {
  const a = left.split(".").map(Number); const b = right.split(".").map(Number);
  return a.some((value, index) => value > b[index]! && a.slice(0, index).every((part, i) => part === b[i]));
}
export class RuntimePromotion {
  private active = false;
  constructor(readonly directory: string, readonly baselineDirectory: string, private readonly dependencies: {
    discover?: () => Promise<unknown>;
    prepare?: (version: string, assets: OfficialRelease["assets"], progress: (state: RuntimeChannelState["phase"], message: string) => void) => Promise<RuntimeTarget>;
  } = {}) {}
  save(state: RuntimeChannelState): void { writeChannelJson(this.directory, "state.json", state); }
  heartbeat(): void { const state = channelState(this.directory); state.workerHeartbeatAt = new Date().toISOString(); this.save(state); }
  async bootstrap(): Promise<void> {
    const existing = channelState(this.directory);
    if (existing.target) {
      if (!completeHelpers(existing.target)) { delete existing.nextCheckAt; this.save(existing); }
      return;
    }
    const manifest = JSON.parse(await readFile(join(this.baselineDirectory, "codex-manifest.json"), "utf8"));
    if (manifest.version !== CODEX_COMPATIBILITY_PROFILE.managedCodexVersion) throw new Error("内置托管基线版本不一致");
    const target = await this.prepare(manifest.version, [], () => undefined, manifest);
    this.save({ ...channelState(this.directory), target, message: "已载入经过发布验证的托管基线" });
  }
  async run(force = false): Promise<void> {
    if (this.active) return;
    this.active = true;
    let state = channelState(this.directory);
    let attempted = false;
    const control = channelControl(this.directory);
    const update = (phase: RuntimeChannelState["phase"], message: string) => { state = { ...state, phase, message, workerHeartbeatAt: new Date().toISOString() }; this.save(state); };
    try {
      if (control.rollbackId && control.rollbackId !== state.handledRollback) {
        state.handledRollback = control.rollbackId;
        if (!state.previous) { update("blocked", "没有可回退的已验证版本"); return; }
        const prior = state.target;
        state.target = { ...state.previous, revision: randomUUID(), rollback: true };
        if (prior) state.previous = prior;
        state.history = [{ at: new Date().toISOString(), version: state.target.version, result: "rollback", message: "已回退托管目标；主机在空闲时应用，自动晋升保持暂停" }, ...state.history].slice(0, 20);
        update("paused", "已回退到上一个验证版本，自动晋升已暂停"); return;
      }
      if (control.paused) { update("paused", "自动晋升已暂停；已发布的托管目标仍可分发"); return; }
      if (!force && state.handledCheck === control.checkId && state.nextCheckAt && Date.parse(state.nextCheckAt) > Date.now()) return;
      attempted = true;
      state.handledCheck = control.checkId; state.checks = []; state.lastCheckedAt = new Date().toISOString();
      update("checking", "正在检查 OpenAI 官方稳定版");
      const raw = await (this.dependencies.discover ?? (async () => {
        const response = await fetch("https://api.github.com/repos/openai/codex/releases/latest", { headers: { accept: "application/vnd.github+json", "user-agent": "AgentFleet-runtime-validator" }, redirect: "error", signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`官方版本检查失败 HTTP ${response.status}`);
        const text = await response.text(); if (text.length > 2_000_000) throw new Error("官方版本信息超过限制"); return JSON.parse(text);
      }))();
      const release = stableRelease(raw); state.latestVersion = release.version;
      state.checks.push({ name: "官方稳定版", state: "passed", detail: `OpenAI rust-v${release.version}，4 个平台提供 SHA-256` });
      if (state.target && !newerVersion(release.version, state.target.version) && (release.version !== state.target.version || completeHelpers(state.target))) { update("idle", "当前托管目标已是已发现的最新稳定版"); return; }
      const target = await (this.dependencies.prepare ?? this.prepare.bind(this))(release.version, release.assets, update);
      const latestControl = channelControl(this.directory);
      if (latestControl.paused || latestControl.rollbackId !== control.rollbackId) { update("paused", "验证已结束，但自动晋升已暂停，保留原目标"); return; }
      if (state.target) state.previous = state.target;
      state.target = target;
      state.checks.push({ name: "兼容性与执行测试", state: "passed", detail: "Linux schema、会话接口和 Code Mode 实际执行通过；4 平台主程序及执行依赖摘要通过，各主机应用前再次本地验证" });
      state.history = [{ at: target.validatedAt, version: target.version, result: "promoted", message: "自动验证通过并晋升" }, ...state.history].slice(0, 20);
      update("promoted", `Codex ${target.version} 已自动晋升，等待主机空闲更新`);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1200) : "自动验证失败";
      state.checks.push({ name: "验证未通过", state: "failed", detail: message });
      state.history = [{ at: new Date().toISOString(), version: state.latestVersion ?? "unknown", result: "blocked", message }, ...state.history].slice(0, 20);
      update(message.includes("需要适配") ? "blocked" : "failed", message);
    } finally {
      if (attempted) { state.nextCheckAt = new Date(Date.now() + 6 * 60 * 60_000).toISOString(); this.save(state); }
      this.active = false;
    }
  }
  private async prepare(version: string, assets: OfficialRelease["assets"], progress: (phase: RuntimeChannelState["phase"], message: string) => void, baseline?: { artifacts: Record<string, { file: string; sha256: string }>; codeModeHosts?: Record<string, { file: string; sha256: string }> }): Promise<RuntimeTarget> {
    await mkdir(join(this.directory, "staging"), { recursive: true, mode: 0o700 });
    await mkdir(join(this.directory, "public"), { recursive: true, mode: 0o700 });
    const stage = await mkdtemp(join(this.directory, "staging", "runtime-"));
    const target: RuntimeTarget = { schemaVersion: 1, revision: randomUUID(), version, schemaHash: validatedCodexSchemaHash(version), validatedAt: new Date().toISOString(), artifacts: {} };
    try {
      const resources = join(stage, "codex-resources");
      await mkdir(resources);
      const helper = join(resources, "bwrap");
      let helperContent: { sha256: string; size: number };
      if (baseline) {
        const source = join(this.baselineDirectory, `codex-bwrap-linux-x64-${version}`);
        if (!["0.153.2", "0.154.0"].includes(version) || await sha256File(source) !== "01fb705f067bd5365b63d8ad2323a61c8d007733ca5e649437e086f3fb9935d8") throw new Error("内置隔离辅助程序校验失败");
        await copyFile(source, helper);
        helperContent = { sha256: await sha256File(helper), size: (await stat(helper)).size };
      } else {
        const entry = "bwrap-x86_64-unknown-linux-musl";
        const asset = assets.find(item => item.name === `${entry}.tar.gz`);
        if (!asset || asset.size > 1024 * 1024) throw new Error("官方隔离辅助程序缺失或大小超限，未晋升");
        const archive = join(stage, "helper.tar.gz");
        await downloadVerified(`https://github.com/openai/codex/releases/download/rust-v${version}/${entry}.tar.gz`, archive, { size: asset.size, sha256: asset.digest.slice(7) });
        helperContent = await unpackRuntime(archive, entry, helper);
      }
      if (helperContent.size > 1024 * 1024) throw new Error("隔离辅助程序解压后超限，未晋升");
      const helperFile = `codex-bwrap-linux-x64-${version}-${helperContent.sha256.slice(0, 16)}`;
      const helperDestination = join(this.directory, "public", helperFile);
      try { await link(helper, helperDestination); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await sha256File(helperDestination) !== helperContent.sha256) throw error; }
      target.sandboxHelper = { file: helperFile, ...helperContent, format: "raw" };
      target.codeModeHosts = {};
      for (const [platform, entry] of Object.entries(CODE_MODE_PLATFORMS)) {
        const bundled = baseline?.codeModeHosts?.[platform];
        if (baseline && !bundled) throw new Error("内置 Code Mode 执行依赖不完整，未晋升");
        const archive = bundled ? join(this.baselineDirectory, bundled.file) : join(stage, `code-mode-${platform}.tar.gz`);
        if (bundled) {
          if (await sha256File(archive) !== bundled.sha256) throw new Error("内置 Code Mode 执行依赖校验失败");
        } else {
          const asset = assets.find(item => item.name === `${entry}.tar.gz`)!;
          await downloadVerified(`https://github.com/openai/codex/releases/download/rust-v${version}/${entry}.tar.gz`, archive, { size: asset.size, sha256: asset.digest.slice(7) });
        }
        const binary = join(stage, platform === "linux-x64" ? "codex-code-mode-host" : `code-mode-${platform}`);
        const content = bundled
          ? (await copyFile(archive, binary), { sha256: await sha256File(binary), size: (await stat(binary)).size })
          : await unpackRuntime(archive, entry, binary);
        if (platform === "linux-x64") { progress("validating", "正在实际执行 Code Mode 隔离探针（不调用模型）"); await probeCodeModeHost(binary); }
        const file = `codex-code-mode-host-${platform}-${version}-${content.sha256.slice(0, 16)}${platform === "win32-x64" ? ".exe" : ""}`;
        const destination = join(this.directory, "public", file);
        try { await link(binary, destination); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await sha256File(destination) !== content.sha256) throw error; }
        target.codeModeHosts[platform] = { file, ...content, format: "raw" };
      }
      for (const [platform, entry] of Object.entries(RUNTIME_PLATFORMS)) {
        const archive = baseline ? join(this.baselineDirectory, baseline.artifacts[platform]!.file) : join(stage, `${platform}.tar.gz`);
        progress("downloading", `正在校验 ${platform} 官方安装包`);
        if (baseline) {
          if (await sha256File(archive) !== baseline.artifacts[platform]!.sha256) throw new Error("内置基线安装包校验失败");
        } else {
          const asset = assets.find(item => item.name === `${entry}.tar.gz`)!;
          await downloadVerified(`https://github.com/openai/codex/releases/download/rust-v${version}/${entry}.tar.gz`, archive, { size: asset.size, sha256: asset.digest.slice(7) });
        }
        const binary = join(stage, platform);
        const content = await unpackRuntime(archive, entry, binary);
        if (platform === "linux-x64") { progress("validating", "正在隔离环境验证版本、协议、启动与会话接口"); await validateRuntime(binary, version, target.schemaHash, stage); }
        const file = `codex-${platform}-${version}-${content.sha256.slice(0, 16)}${platform === "win32-x64" ? ".exe" : ""}`;
        const destination = join(this.directory, "public", file);
        try { await link(binary, destination); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await sha256File(destination) !== content.sha256) throw error; }
        target.artifacts[platform] = { file, ...content, format: "raw" };
      }
      return target;
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
}
