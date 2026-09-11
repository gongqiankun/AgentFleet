// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PairMachineDialog } from "./components/PairMachineDialog";
import { api } from "./lib/api";

vi.mock("./lib/api", () => ({ api: { createEnrollment: vi.fn(), enrollment: vi.fn(), cancelEnrollment: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("三个系统的复制命令说明具体运行位置，并随系统选择切换", async () => {
  const enrollment = { id: "enroll_test", bootstrapSecret: "test-only", status: "pending" as const, expiresAt: "2099-01-01T00:00:00Z" };
  vi.mocked(api.createEnrollment).mockResolvedValue({ enrollment });
  vi.mocked(api.enrollment).mockResolvedValue({ enrollment });
  render(<PairMachineDialog open onClose={vi.fn()} onPaired={vi.fn()} onToast={vi.fn()} />);
  const copy = await screen.findByRole("button", { name: "复制安装命令" });
  expect(copy.getAttribute("aria-describedby")).toBe("install-run-location");
  expect(screen.getByText(/Linux 主机上打开终端.*SSH/)).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "macOS" }));
  expect(screen.getByText(/Mac 上打开「终端」.*应用程序 → 实用工具/)).toBeTruthy();
  expect(screen.queryByText(/Linux 主机上打开终端/)).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Windows" }));
  expect(screen.getByText(/Windows 主机上打开 PowerShell.*不要在 CMD 中运行/)).toBeTruthy();
  expect(screen.queryByText(/Mac 上打开「终端」/)).toBeNull();
  const windows = screen.getByRole("tab", { name: "Windows" });
  expect(windows.getAttribute("aria-selected")).toBe("true");
  expect(windows.textContent).toContain("已选择");
  expect(windows.className).toContain("platform-tab--active");
  expect(screen.getByRole("tab", { name: "Linux" }).getAttribute("aria-selected")).toBe("false");
  fireEvent.keyDown(windows, { key: "ArrowLeft" });
  const macos = screen.getByRole("tab", { name: "macOS" });
  expect(macos.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(macos);
  expect(screen.getByText(/Mac 上打开「终端」/)).toBeTruthy();
});

it("shows a purging uninstall command directly below install for the selected system", async () => {
  const enrollment = { id: "enroll_test", bootstrapSecret: "test-only", status: "pending" as const, expiresAt: "2099-01-01T00:00:00Z" };
  vi.mocked(api.createEnrollment).mockResolvedValue({ enrollment });
  vi.mocked(api.enrollment).mockResolvedValue({ enrollment });
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: copy }, configurable: true });
  render(<PairMachineDialog open onClose={vi.fn()} onPaired={vi.fn()} onToast={vi.fn()} />);
  const installCopy = await screen.findByRole("button", { name: "复制安装命令" });
  const uninstallCopy = screen.getByRole("button", { name: "复制卸载命令" });
  expect(installCopy.compareDocumentPosition(uninstallCopy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "卸载目标系统" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Windows" }));
  fireEvent.click(screen.getByRole("button", { name: "复制卸载命令" }));
  expect(copy).toHaveBeenCalledWith(expect.stringContaining("-Mode Uninstall -Purge"));
  expect(copy.mock.calls[0][0]).not.toContain("test-only");
});
