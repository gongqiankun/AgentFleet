// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PermissionPanel } from "./components/PermissionPanel";
import { api } from "./lib/api";
import type { PermissionPreferences } from "./lib/permissions";
vi.mock("./lib/api", () => ({ api: { permissions: vi.fn(), savePermissions: vi.fn() } }));
const fixture: PermissionPreferences = { supported: true, source: "machine", profile: "network", preferences: { machine: { profile: "network", revision: 1 }, project: { profile: null, revision: 0 }, session: { profile: null, revision: 0 } } };
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("host full access requires inline confirmation and sends revision", async () => {
  vi.mocked(api.permissions).mockResolvedValue(fixture); vi.mocked(api.savePermissions).mockResolvedValue({ ...fixture, profile: "full" });
  render(<PermissionPanel machineId="host" />);
  await screen.findByRole("radio", { name: /主机完整访问/ });
  fireEvent.click(screen.getByRole("radio", { name: /主机完整访问/ }));
  expect((screen.getByRole("button", { name: "保存权限" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "保存权限" }));
  await waitFor(() => expect(api.savePermissions).toHaveBeenCalledWith("machines", "host", { scope: "machine", profile: "full", revision: 1, confirmFullAccess: true }));
  await screen.findByRole("status");
});
it("session shows inheritance and accepted state separately, can configure project", async () => {
  vi.mocked(api.permissions).mockResolvedValue(fixture); vi.mocked(api.savePermissions).mockResolvedValue(fixture);
  render(<PermissionPanel sessionId="session" observed={{ permissions: { profile: "project", source: "default", acceptedAt: "2026-09-07T00:00:00Z", nativeTurnId: "turn" } }} />);
  fireEvent.click(screen.getByText(/执行权限/));
  await screen.findByText("继承自主机默认");
  expect(screen.getByText(/最近任务实际采用：项目内开发/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("权限设置范围"), { target: { value: "project" } });
  await screen.findByRole("radio", { name: "继承上级权限" });
  fireEvent.click(screen.getByRole("radio", { name: /^项目内开发/ })); fireEvent.click(screen.getByRole("button", { name: "保存权限" }));
  await waitFor(() => expect(api.savePermissions).toHaveBeenCalledWith("sessions", "session", { scope: "project", profile: "project", revision: 0, confirmFullAccess: false }));
});
it("older agents cannot select expanded access", async () => {
  vi.mocked(api.permissions).mockResolvedValue({ ...fixture, supported: false });
  render(<PermissionPanel machineId="old" />);
  const option = await screen.findByRole("radio", { name: /主机完整访问/ });
  expect((option as HTMLInputElement).disabled).toBe(true);
});
