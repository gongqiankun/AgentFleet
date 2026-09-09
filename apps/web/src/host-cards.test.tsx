// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HostCards, hostCardState } from "./components/HostCards";
import { HostDisclosure } from "./components/HostDisclosure";
import { CodexCommandGuide } from "./components/CodexCommandGuide";
import { HostCodexInventory } from "./components/HostCodexInventory";
import type { Machine } from "./lib/types";

const host: Machine = { id: "a", name: "工作主机", hostname: "host-a", os: "Linux", arch: "x64", identity: "paired", reachability: "live", compatibility: "compatible", capacity: "idle", credentialProtectionLevel: "software_protected", agentVersion: "0.20.0", codexVersion: "0.153.2", projects: [] };
afterEach(cleanup);

it("在线但隔离失败显示实际原因，不冒充仍在等待状态更新", () => {
  const discovery = { state: "ready" as const, readiness: "action_required" as const, discoveredProjects: 3, discoveredSessions: 44, scannedPages: 1, scannedCount: 44,
    checks: [{ id: "sandbox", state: "failed" as const, code: "SANDBOX_START_FAILED", message: "helper missing", checkedAt: "2026-09-06T14:00:00Z" }] };
  expect(hostCardState({ ...host, capacity: "unknown", discovery })).toMatchObject({ connection: "已连接", activity: "隔离检查未通过 · 仅可查看" });
  expect(hostCardState({ ...host, reachability: "unreachable", discovery })).toMatchObject({ connection: "未连接", activity: "运行状态未知" });
  expect(hostCardState({ ...host, discovery: { ...discovery, readiness: "checking", state: "scanning", checks: [] } })).toMatchObject({ activity: "正在自检与扫描" });
  expect(hostCardState({ ...host, compatibility: "degraded_read_only" })).toMatchObject({ activity: "需要处理 · 查看自检详情" });
});

it("安装记录可以显示自装版本，但不冒充程序运行核验", () => {
  render(<HostCodexInventory machine={{ ...host, codexProfile: { hostCodexDetection: "highest-detected", hostCodexVersion: "0.153.4", hostCodexVersionSource: "package-record", hostCodexPath: "/root/.local/bin/codex", hostCodexMetadataPath: "/root/.codex/packages/standalone/current/codex-package.json" } }} />);
  expect(screen.getByText("0.153.4")).toBeTruthy();
  expect(screen.getByText(/版本来源：安装包记录，未启动自装程序核验/)).toBeTruthy();
  expect(screen.queryByText("尚未检测到")).toBeNull();
});

it("已找到程序但未知版本，不显示成未安装", () => {
  render(<HostCodexInventory machine={{ ...host, codexProfile: { hostCodexDetection: "highest-detected", hostCodexVersion: null, hostCodexPath: "/root/.local/bin/codex" } }} />);
  expect(screen.getByText("已找到安装，版本未识别")).toBeTruthy();
  expect(screen.queryByText("尚未检测到")).toBeNull();
});

it("自装版本展示检测路径、旧 PATH 安装和检测时间，不冒充终端当前版本", () => {
  render(<HostCodexInventory machine={{ ...host, codexProfile: { hostCodexDetection: "highest-detected", hostCodexVersion: "0.153.4", hostCodexPath: "/home/developer/.nvm/versions/node/v24/bin/codex", hostCodexDefaultVersion: "0.145.0", hostCodexDefaultPath: "/home/developer/.local/bin/codex", hostCodexCheckedAt: "2026-09-06T10:00:00Z" } }} />);
  expect(screen.getByText("0.153.4")).toBeTruthy();
  expect(screen.getByText(/另有旧安装.*0.145.0/)).toBeTruthy();
  expect(screen.getByText(/不代表终端当前选用/)).toBeTruthy();
  expect(screen.getByText(/最近检测/)).toBeTruthy();
});

it("旧 Agent 的 PATH 单点检测不标成最高版本", () => {
  render(<HostCodexInventory machine={{ ...host, codexProfile: { hostCodexVersion: "0.145.0", hostCodexPath: "/home/developer/.local/bin/codex" } }} />);
  expect(screen.getByText("服务 PATH 中的 Codex")).toBeTruthy();
  expect(screen.queryByText("检测到的自装 Codex")).toBeNull();
  expect(screen.getByText(/可能与终端不同/)).toBeTruthy();
});

it.each([
  ["idle", "idle", "当前空闲"], ["busy", "running", "任务运行中"], ["saturated", "running", "任务运行中"], ["unknown", "unknown", "运行状态待更新"],
] as const)("在线主机正确显示 %s 状态", (capacity, tone, activity) => {
  expect(hostCardState({ ...host, capacity })).toEqual({ tone, connection: "已连接", activity });
});

it.each([
  ["unreachable", "offline", "未连接"], ["connecting", "connecting", "正在连接"], ["reconciling", "connecting", "正在同步"],
] as const)("%s 优先于残留的运行状态", (reachability, tone, connection) => {
  expect(hostCardState({ ...host, reachability, capacity: "busy" })).toMatchObject({ tone, connection });
});

it("撤销连接后不显示在线或空闲", () => {
  expect(hostCardState({ ...host, identity: "revoked" })).toEqual({ tone: "offline", connection: "未连接", activity: "运行状态未知" });
});

it("卡片可切换离线主机，更新状态保留同一个按钮且不重复执行其他操作", () => {
  const select = vi.fn();
  const offline = { ...host, id: "b", name: "离线工作主机", reachability: "unreachable" as const, capacity: "busy" as const };
  const { container, rerender } = render(<HostCards machines={[host, offline]} selectedId="a" onSelect={select} />);
  const button = screen.getByRole("button", { name: "工作主机，已连接，当前空闲" });
  expect(button.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: /离线工作主机，未连接/ }));
  expect(select).toHaveBeenCalledTimes(1);
  expect(select).toHaveBeenCalledWith("b");
  expect(container.querySelectorAll(".host-card__bars")).toHaveLength(0);
  rerender(<HostCards machines={[{ ...host, capacity: "busy" }, offline]} selectedId="b" onSelect={select} />);
  expect(screen.getByRole("button", { name: "工作主机，已连接，任务运行中" })).toBe(button);
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(container.querySelectorAll(".host-card__bars i")).toHaveLength(5);
  expect(screen.getByText(/任务状态仅针对面板接管的会话/)).toBeTruthy();
});

it("长主机名保留完整提示和可访问名称", () => {
  const name = "用于跨区域项目部署的非常长的自定义主机名称";
  render(<HostCards machines={[{ ...host, name }]} selectedId="a" onSelect={vi.fn()} />);
  expect(screen.getByRole("button", { name: `${name}，已连接，当前空闲` }).title).toBe(name);
});

it("主机折叠卡片使用原生展开语义，内容不使用紧凑面板限高样式", () => {
  const { container } = render(<HostDisclosure title="后台版本信息" description="查看版本" icon={<span />}><p>构建信息</p></HostDisclosure>);
  const details = container.querySelector("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByText("后台版本信息"));
  expect(details.open).toBe(true);
  fireEvent.click(screen.getByText("后台版本信息"));
  expect(details.open).toBe(false);
  expect(details.classList.contains("codex-settings-panel")).toBe(false);
});

it("宽版命令范围可搜索，并显示无匹配提示", () => {
  const { container } = render(<CodexCommandGuide spacious />);
  fireEvent.click(screen.getByText("全部 / 命令 · 支持范围"));
  expect(container.querySelector("details")!.open).toBe(true);
  expect(container.querySelector(".codex-settings-panel")).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "查找 Codex 命令" }), { target: { value: "/nonexistent-command-000" } });
  expect(screen.getByRole("status").textContent).toContain("没有找到");
  fireEvent.change(screen.getByRole("textbox", { name: "查找 Codex 命令" }), { target: { value: "model" } });
  expect(screen.getByText("/model")).toBeTruthy();
});
