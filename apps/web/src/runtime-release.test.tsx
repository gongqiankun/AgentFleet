// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RuntimeReleasePanel } from "./components/RuntimeReleasePanel";
import { api, type RuntimeReleaseStatus } from "./lib/api";
import type { Machine } from "./lib/types";
vi.mock("./lib/api", () => ({ api: { runtimeRelease: vi.fn(), runtimeReleaseControl: vi.fn() } }));
const machine: Machine = { id: "work", name: "工作机器", hostname: "work", os: "Linux", arch: "x64", identity: "paired", compatibility: "compatible", credentialProtectionLevel: "software_protected", projects: [], agentVersion: "0.21.0", codexVersion: "0.153.2", reachability: "live", capacity: "busy", codexProfile: { source: "managed" } };
const state: RuntimeReleaseStatus = { configured: true, paused: false, workerOnline: true, phase: "blocked", message: "需要适配：协议不兼容，原目标未改变", latestVersion: "0.153.4", target: { version: "0.153.2" }, previous: { version: "0.153.1" }, checks: [{ name: "协议验证", state: "failed", detail: "SHA-256 不一致" }], history: [] };
beforeEach(() => { vi.mocked(api.runtimeRelease).mockResolvedValue(state); vi.mocked(api.runtimeReleaseControl).mockResolvedValue({ ...state, paused: true }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("shows why a release was blocked instead of claiming the latest version is running", async () => {
  render(<RuntimeReleasePanel machine={machine} />);
  expect(await screen.findByText("需要适配：协议不兼容，原目标未改变")).toBeTruthy();
  expect(screen.getByText("0.153.4")).toBeTruthy(); expect(screen.getByText("0.153.2")).toBeTruthy();
  expect(screen.getByText(/已运行当前托管目标/)).toBeTruthy();
});
it("rollback requires an in-page confirmation and invokes the rollback action only once", async () => {
  render(<RuntimeReleasePanel machine={machine} />); fireEvent.click(await screen.findByRole("button", { name: "回退托管目标" }));
  expect(api.runtimeReleaseControl).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认回退并暂停晋升" }));
  await waitFor(() => expect(api.runtimeReleaseControl).toHaveBeenCalledTimes(1));
  expect(api.runtimeReleaseControl).toHaveBeenCalledWith("rollback");
});
it("self-installed runtimes are never described as pending managed upgrades", async () => {
  render(<RuntimeReleasePanel machine={{ ...machine, codexProfile: { source: "host" } }} />);
  expect(await screen.findByText(/使用自装 Codex，不参与托管切换/)).toBeTruthy();
});
