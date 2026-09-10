// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceCatalog } from "./components/WorkspaceCatalog";
import { api } from "./lib/api";
import type { FleetSession, Page, Project } from "./lib/types";

vi.mock("./lib/api", () => ({ api: { projects: vi.fn(), sessions: vi.fn() } }));
const project: Project = { id: "p", machineId: "m", alias: "测试项目", pathHint: "/srv/test", syncContent: true, retentionDays: 7 };
const row = (id: string) => ({ id, title: `会话 ${id}`, machineName: "主机", projectAlias: "测试项目", lastActivityAt: "2026-09-05T00:00:00Z", state: { reachability: "live", history: "complete" } } as FleetSession);
const props = { machineId: "m", onSelect: vi.fn(), onCreate: vi.fn() };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.mocked(api.projects).mockResolvedValue({ items: [project], nextCursor: null });
  vi.mocked(api.sessions).mockResolvedValue({ items: [row("1")], nextCursor: null });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("后台刷新不插入加载行，保留已有项目和会话 DOM", async () => {
  const { rerender, container } = render(<WorkspaceCatalog {...props} refreshKey="1" />);
  fireEvent.click(await screen.findByRole("button", { name: /测试项目 \/srv/ }));
  const original = await screen.findByText("会话 1");
  const pending = deferred<Page<FleetSession>>();
  vi.mocked(api.sessions).mockReturnValue(pending.promise);
  rerender(<WorkspaceCatalog {...props} refreshKey="2" />);
  await waitFor(() => expect(api.sessions).toHaveBeenCalledTimes(2));
  expect(container.querySelectorAll(".catalog-loading").length).toBe(0);
  expect(screen.getByText("会话 1")).toBe(original);
  await act(async () => pending.resolve({ items: [row("1")], nextCursor: null }));
  expect(screen.getByText("会话 1")).toBe(original);
});

it("后台刷新保留所有已加载页，较晚页失败也不提交半份列表", async () => {
  vi.mocked(api.sessions).mockImplementation(async ({ cursor }) => cursor ? { items: [row("31")], nextCursor: null } : { items: [row("1")], nextCursor: "page-2" });
  const { rerender } = render(<WorkspaceCatalog {...props} refreshKey="1" />);
  fireEvent.click(await screen.findByRole("button", { name: /测试项目 \/srv/ }));
  fireEvent.click(await screen.findByRole("button", { name: "加载更多会话" }));
  await screen.findByText("会话 31");
  rerender(<WorkspaceCatalog {...props} refreshKey="2" />);
  await waitFor(() => expect(api.sessions).toHaveBeenCalledTimes(5));
  expect(screen.getByText("会话 31")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "加载更多会话" })).toBeNull();
  vi.mocked(api.sessions).mockImplementation(async ({ cursor }) => {
    if (cursor) throw new Error("网络暂时不可用");
    return { items: [row("new")], nextCursor: "page-2" };
  });
  rerender(<WorkspaceCatalog {...props} refreshKey="3" />);
  await screen.findByText("网络暂时不可用");
  expect(screen.getByText("会话 1")).toBeTruthy();
  expect(screen.getByText("会话 31")).toBeTruthy();
  expect(screen.queryByText("会话 new")).toBeNull();
});

it("空项目后台刷新时空状态不消失", async () => {
  vi.mocked(api.projects).mockResolvedValue({ items: [], nextCursor: null });
  const { rerender, container } = render(<WorkspaceCatalog {...props} refreshKey="1" />);
  const empty = await screen.findByText(/暂无项目/);
  vi.mocked(api.projects).mockReturnValue(new Promise(() => undefined));
  rerender(<WorkspaceCatalog {...props} refreshKey="2" />);
  await waitFor(() => expect(api.projects).toHaveBeenCalledTimes(2));
  expect(screen.getByText(/暂无项目/)).toBe(empty);
  expect(container.querySelector(".catalog-loading")).toBeNull();
});

it("项目刷新失败不会卸载已展开的会话", async () => {
  const { rerender } = render(<WorkspaceCatalog {...props} refreshKey="1" />);
  fireEvent.click(await screen.findByRole("button", { name: /测试项目 \/srv/ }));
  const original = await screen.findByText("会话 1");
  vi.mocked(api.projects).mockRejectedValue(new Error("项目请求失败"));
  rerender(<WorkspaceCatalog {...props} refreshKey="2" />);
  await screen.findByText("项目请求失败");
  expect(screen.getByText("会话 1")).toBe(original);
});

it("已取消的慢刷新不会覆盖最新会话", async () => {
  const { rerender } = render(<WorkspaceCatalog {...props} refreshKey="1" />);
  fireEvent.click(await screen.findByRole("button", { name: /测试项目 \/srv/ }));
  await screen.findByText("会话 1");
  const pending = deferred<Page<FleetSession>>();
  vi.mocked(api.sessions).mockReturnValueOnce(pending.promise);
  rerender(<WorkspaceCatalog {...props} refreshKey="2" />);
  await waitFor(() => expect(api.sessions).toHaveBeenCalledTimes(2));
  vi.mocked(api.sessions).mockResolvedValue({ items: [row("latest")], nextCursor: null });
  rerender(<WorkspaceCatalog {...props} refreshKey="3" />);
  await screen.findByText("会话 latest");
  await act(async () => pending.resolve({ items: [row("stale")], nextCursor: null }));
  expect(screen.getByText("会话 latest")).toBeTruthy();
  expect(screen.queryByText("会话 stale")).toBeNull();
});

it("会话行在历史标记右侧展示独立 token 数，并区分零和未记录", async () => {
  vi.mocked(api.sessions).mockResolvedValue({ items: [{...row("used"),recordedTokens:1200},{...row("zero"),recordedTokens:0},row("missing")], nextCursor:null });
  const {container}=render(<WorkspaceCatalog {...props} refreshKey="usage" />);
  fireEvent.click(await screen.findByRole("button",{name:/测试项目 \/srv/}));
  await screen.findByText("会话 used");
  const labels=container.querySelectorAll(".session-row__tokens");
  expect(labels).toHaveLength(3);
  expect(labels[0].getAttribute("title")).toBe("总消耗 1,200 tokens · 本周消耗 — tokens");
  expect(labels[0].previousElementSibling?.className).toBe("history-mark");
  expect(labels[1].textContent).toBe("总消耗 0 tokens · 本周消耗 — tokens");
  expect(labels[2].textContent).toBe("总消耗 — tokens · 本周消耗 — tokens");
});
