// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HostReadiness } from "./components/HostReadiness";
import { DiscoveryStatus } from "./components/DiscoveryStatus";
import type { DiscoveryProgress } from "./lib/types";
afterEach(cleanup);
const discovery: DiscoveryProgress = { state: "ready", readiness: "ready", discoveredProjects: 0, discoveredSessions: 0, scannedCount: 0, scannedPages: 1,
  checks: [{ id: "sandbox", state: "passed", code: "SANDBOX_VERIFIED", message: "已验证", checkedAt: "2026-09-06T00:00:00Z", action: "agent.update" }] };
it("空会话自检通过；离线时不会冒充当前可用", () => {
  const { rerender } = render(<HostReadiness discovery={discovery} online />);
  expect(screen.getByText("接入自检通过")).toBeTruthy();
  rerender(<HostReadiness discovery={discovery} online={false} />);
  expect(screen.getByText(/不代表当前在线/)).toBeTruthy();
  expect(screen.queryByText("接入自检通过")).toBeNull();
});
it("失败检查提供对应操作，忙碌或离线时禁用", () => {
  const onAction = vi.fn();
  const failed = { ...discovery, readiness: "action_required" as const, checks: [{ ...discovery.checks![0], state: "failed" as const }] };
  const { rerender } = render(<HostReadiness discovery={failed} online onAction={onAction} capabilities={["agent.update", "diagnostics.collect"]} />);
  fireEvent.click(screen.getByRole("button", { name: "检查并更新" }));
  expect(onAction).toHaveBeenCalledWith("agent.update");
  rerender(<HostReadiness discovery={failed} online disabled onAction={onAction} capabilities={["agent.update"]} />);
  expect((screen.getByRole("button", { name: "检查并更新" }) as HTMLButtonElement).disabled).toBe(true);
});
it("旧版缺少自检不会伪造成功，也不会要求重新配对", () => {
  render(<HostReadiness online />);
  expect(screen.getByText(/无需删除主机或重新配对/)).toBeTruthy();
  expect(screen.queryByText("接入自检通过")).toBeNull();
});
it("不可用目录不再被静默跳过", () => {
  render(<DiscoveryStatus discovery={{ ...discovery, skippedCount: 3 }} />);
  expect(screen.getByText(/有 3 个会话的项目目录/)).toBeTruthy();
});
it("事件监听和降级校准均如实展示，旧 Agent 不冒充事件驱动", () => {
  const { rerender } = render(<DiscoveryStatus discovery={{ ...discovery, syncMode: "events" }} />);
  expect(screen.getByText(/事件驱动同步/)).toBeTruthy();
  rerender(<DiscoveryStatus discovery={{ ...discovery, syncMode: "fallback" }} />);
  expect(screen.getByText(/文件监听暂不可用/)).toBeTruthy();
  expect(screen.queryByText(/事件驱动同步/)).toBeNull();
  rerender(<DiscoveryStatus discovery={discovery} />);
  expect(screen.queryByText(/事件驱动同步/)).toBeNull();
});
it("日常后台同步保留完成状态，首次扫描和失败仍明确显示", () => {
  const ready = { ...discovery, discoveredProjects: 6, discoveredSessions: 34, backgroundSync: true };
  const { rerender, container } = render(<DiscoveryStatus discovery={ready} />);
  expect(screen.getByText("项目和会话已同步")).toBeTruthy();
  expect(screen.getByText("6 个项目 · 34 个会话")).toBeTruthy();
  expect(screen.queryByText(/已读取 0 页/)).toBeNull();
  expect(container.querySelector(".spin")).toBeNull();
  rerender(<DiscoveryStatus discovery={{ ...ready, state: "scanning", backgroundSync: false, scannedPages: 0 }} />);
  expect(screen.getByText("正在发现 Codex 项目和会话")).toBeTruthy();
  rerender(<DiscoveryStatus discovery={{ ...ready, state: "error", backgroundSync: false, error: "扫描失败" }} />);
  expect(screen.getByText("本次扫描未完成")).toBeTruthy();
});
