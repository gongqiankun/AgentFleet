// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HostImageStorage } from "./components/HostImageStorage";
import type { CloudImageUsage } from "./lib/types";
const mocks = vi.hoisted(() => ({ imageSessions:vi.fn(async()=>({sessions:[],nextCursor:null})),machineImages: vi.fn() }));
vi.mock("./lib/api", () => ({ api: mocks }));
const usage: CloudImageUsage = { machineId: "a", usedBytes: 50e6, quotaBytes: 50e6, imageCount: 5, revision: 8, level: "full", pendingImageCommands: 0, canClear: true };
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("显示 50 MB 上限和文字不受影响，使用按会话的两端清理入口", async () => {
  mocks.machineImages.mockResolvedValue(usage);
  render(<HostImageStorage machineId="a" name="工作机器" />);
  await screen.findByText("50.0 MB");
  expect(screen.getByText("/ 50.0 MB")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("文字消息不受影响");
  expect(screen.queryByRole("button",{name:"清理云端图片"})).toBeNull();
  expect(screen.getByRole("region",{name:"按会话清理图片"})).toBeTruthy();
});
it("80% 预警和未完成图片命令保护可见", async () => {
  mocks.machineImages.mockResolvedValue({ ...usage, usedBytes: 40e6, level: "warning", pendingImageCommands: 1, canClear: false });
  render(<HostImageStorage machineId="a" name="工作机器" />);
  await screen.findByText(/云端图片空间使用量已达到 80%/);
  expect(screen.getByText(/对应会话暂不能清理/)).toBeTruthy();
});
