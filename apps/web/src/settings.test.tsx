// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsView } from "./components/SettingsView";
import { api } from "./lib/api";
import type { ClientSessionInfo, Dashboard, Page, Project } from "./lib/types";
vi.mock("./lib/api", () => ({ api: { projects: vi.fn(), clientSessions: vi.fn(), revokeClientSession: vi.fn(), updateProjectContentPolicy: vi.fn() } }));
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.clientSessions).mockResolvedValue({ sessions: [] }); });
const project = (id: string, machineId = "a"): Project => ({ id, machineId, alias: id, pathHint: `/work/${id}`, syncContent: true, retentionDays: 7 });
const dashboard = { machines: [{ id: "a", name: "Host A", identity: "paired" }, { id: "b", name: "Host B", identity: "paired" }], serverTime: "one" } as Dashboard;
const onUpdated = vi.fn().mockResolvedValue(undefined), onToast = vi.fn();

it("loads all project pages and saves only the selected project after explicit submission", async () => {
 vi.mocked(api.projects).mockResolvedValueOnce({ items: [project("first")], nextCursor: "next" }).mockResolvedValueOnce({ items: [project("second")], nextCursor: null });
 vi.mocked(api.updateProjectContentPolicy).mockResolvedValue({ project: {} });
 render(<SettingsView dashboard={dashboard} onUpdated={onUpdated} onToast={onToast} />);
 await screen.findByRole("option", { name: "second · /work/second" });
 fireEvent.change(screen.getByLabelText("历史设置项目"), { target: { value: "second" } });
 fireEvent.change(screen.getByLabelText("历史保存时长"), { target: { value: "30" } });
 expect(api.updateProjectContentPolicy).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
 await waitFor(() => expect(api.updateProjectContentPolicy).toHaveBeenCalledWith("second", true, 30));
 expect(api.updateProjectContentPolicy).toHaveBeenCalledTimes(1);
 await waitFor(() => expect((screen.getByRole("button", { name: "保存设置" }) as HTMLButtonElement).disabled).toBe(true));
});

it("late project responses from another host cannot replace the selected host or its policy", async () => {
 let resolveOld!: (value: Page<Project>) => void;
 vi.mocked(api.projects).mockImplementation(options => options.machineId === "a" ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve({ items: [project("new-host", "b")], nextCursor: null }));
 render(<SettingsView dashboard={dashboard} onUpdated={onUpdated} onToast={onToast} />);
 fireEvent.change(screen.getByLabelText("历史设置主机"), { target: { value: "b" } });
 await screen.findByRole("option", { name: "new-host · /work/new-host" });
 await act(async () => resolveOld({ items: [project("stale")], nextCursor: null }));
 expect((screen.getByLabelText("历史设置项目") as HTMLSelectElement).value).toBe("new-host");
 expect(screen.queryByRole("option", { name: "stale · /work/stale" })).toBeNull();
 expect(api.updateProjectContentPolicy).not.toHaveBeenCalled();
});

it("dashboard heartbeats preserve unsaved policy choices and do not reload project settings", async () => {
 vi.mocked(api.projects).mockResolvedValue({ items: [project("first")], nextCursor: null });
 const view = render(<SettingsView dashboard={dashboard} onUpdated={onUpdated} onToast={onToast} />);
 await screen.findByLabelText("历史保存时长");
 fireEvent.change(screen.getByLabelText("历史保存时长"), { target: { value: "14" } });
 view.rerender(<SettingsView dashboard={{ ...dashboard, serverTime: "two" }} onUpdated={onUpdated} onToast={onToast} />);
 expect((screen.getByLabelText("历史保存时长") as HTMLSelectElement).value).toBe("14");
 expect(api.projects).toHaveBeenCalledTimes(1); expect(api.updateProjectContentPolicy).not.toHaveBeenCalled();
});

it("browser logout targets the chosen login and leaves the current login visible", async () => {
 vi.mocked(api.projects).mockResolvedValue({ items: [], nextCursor: null });
 vi.mocked(api.clientSessions).mockResolvedValue({ sessions: [{ id: "current", current: true }, { id: "other", current: false }] as ClientSessionInfo[] });
 vi.mocked(api.revokeClientSession).mockResolvedValue({});
 render(<SettingsView dashboard={dashboard} onUpdated={onUpdated} onToast={onToast} />);
 fireEvent.click(await screen.findByRole("button", { name: "退出浏览器 2" }));
 await waitFor(() => expect(api.revokeClientSession).toHaveBeenCalledWith("other"));
 await waitFor(() => expect(screen.queryByRole("button", { name: "退出浏览器 2" })).toBeNull());
 expect(screen.getByText("当前浏览器")).toBeTruthy();
});
