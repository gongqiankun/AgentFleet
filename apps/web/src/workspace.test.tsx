// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { ApprovalsView, SessionInspector } from "./App";
import { OperationReceipts, receiptStatus } from "./components/OperationReceipts";
import { api, subscribeToFleet } from "./lib/api";
import { draftKey } from "./lib/session-workspace";
import { ApiError } from "./lib/types";
import type { Approval, Dashboard, FleetSession, SessionDetail } from "./lib/types";

vi.mock("./lib/api", () => ({
  api: { command: vi.fn(), commandReceipts: vi.fn(), permissions: vi.fn(), dashboard: vi.fn(), login: vi.fn(), clientSessions: vi.fn(), session: vi.fn(), projects: vi.fn(), sessions: vi.fn(), release: vi.fn(), hostOperations: vi.fn(), machineCodexPreferences: vi.fn() },
  subscribeToFleet: vi.fn(() => () => undefined),
}));

function session(id: string, machineId: string): FleetSession {
  return { id, title: `会话${id}`, machineId, machineName: `主机${machineId}`, projectId: `project-${machineId}`, projectAlias: `项目${machineId}`, nativeThreadId: id,
    historyMode: "legacy", state: { ownership: "agentfleet_owned", threadRuntime: "idle", currentTurn: "none", waitReason: "none", reachability: "live", history: "complete", unknownFreeze: false },
    lastActivityAt: "2026-09-05T00:00:00Z", sessionSeq: 1, projectionEpoch: 1, contentEpoch: 1, executionSegmentId: id,
    threadControlVersion: 1, turnControlVersion: 1, projectLeaseVersion: 1, controlLeaseVersion: 0, queueVersion: 0 };
}
const sessions = [session("A", "1"), session("B", "2")];
function detail(id: string): SessionDetail { return { session: sessions.find((item) => item.id === id)!, writable: true, events: [], queue: [], commands: [] }; }
function dashboard(): Dashboard {
  return { user: { id: "user-1", email: "a@example.com", displayName: "A", clientSessionId: "browser" },
    machines: ["1", "2"].map((id) => ({ id, name: `主机${id}`, hostname: `host-${id}`, os: "Linux", arch: "x64", identity: "paired", reachability: "live", compatibility: "compatible", capacity: "idle", credentialProtectionLevel: "software_protected", agentVersion: "0.16.2", codexVersion: "0.153.2", projects: [{ id: `project-${id}`, machineId: id, alias: `项目${id}`, pathHint: `/srv/${id}`, syncContent: true, retentionDays: 7 }] })), sessions,
    pendingApprovals: [], stats: { liveMachines: 2, runningTurns: 0, approvals: 0 }, serverTime: "2026-09-05T00:00:00Z", compatibilityProfile: { profileVersion: "1", validationStatus: "verified", protocol: "v2", minimumCodexVersion: "0.153.2", managedCodexVersion: "0.153.2", schemaHash: "hash", lastValidatedAt: "2026-09-05T00:00:00Z", upgradePolicy: "when-promoted" } };
}
const noop = async () => undefined;
it("同一条图文消息的 started/completed 合并为一个气泡，真实重复发送仍保留", () => {
  const props = inspectorProps("A");
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  const start = { id: "started", type: "item.started", sessionSeq: 1, occurredAt: "2026-09-07T00:00:00Z", nativeThreadId: "thread", nativeTurnId: "turn", nativeItemId: "item", actor: "user" as const, body: "这是什么图片", images: [image] };
  const view = render(<SessionInspector {...props} detail={{ ...props.detail, events: [start] }} />);
  const bubble = screen.getByText("这是什么图片").closest("article");
  const completed = { ...start, id: "completed", type: "item.completed", sessionSeq: 2 };
  view.rerender(<SessionInspector {...props} detail={{ ...props.detail, events: [start, completed] }} />);
  expect(screen.getAllByText("这是什么图片")).toHaveLength(1);
  expect(screen.getAllByRole("img", { name: "图片 1" })).toHaveLength(1);
  expect(screen.getByText("这是什么图片").closest("article")).toBe(bubble);
  view.rerender(<SessionInspector {...props} detail={{ ...props.detail, events: [start, completed, { ...completed, id: "next", nativeTurnId: "second-turn", sessionSeq: 3 }] }} />);
  expect(screen.getAllByText("这是什么图片")).toHaveLength(2);
});
it("图片消息可单独发送，失败保留图片，成功后清空；历史可显示缩略图", async () => {
  const png="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  localStorage.setItem("agentfleet.images:user-1:A",JSON.stringify([png]));
  const props=inspectorProps("A");props.detail={...props.detail,session:{...props.detail.session,imageInputSupported:true},events:[{id:"image",type:"message",occurredAt:"2026-09-07T00:00:00Z",sessionSeq:1,images:[png]}]};
  const onSend=vi.fn().mockRejectedValueOnce(new Error("发送失败，请重试")).mockResolvedValueOnce(undefined);
  render(<SessionInspector {...props} onSend={onSend}/>);
  expect(screen.getAllByRole("img",{name:"图片 1"})).toHaveLength(2);
  fireEvent.click(screen.getByRole("button",{name:"发送"}));await waitFor(()=>expect(screen.getByText("发送失败，请重试")).toBeTruthy());
  expect(localStorage.getItem("agentfleet.images:user-1:A")).toContain(png);
  fireEvent.click(screen.getByRole("button",{name:"发送"}));await waitFor(()=>expect(localStorage.getItem("agentfleet.images:user-1:A")).toBeNull());
  expect(onSend).toHaveBeenLastCalledWith("",undefined,[png]);
});
it("同账号另一个浏览器的租约不阻止发送，也不展示手动控制权按钮", () => {
  const props = inspectorProps("A");
  props.detail = { ...props.detail, releaseManagementSupported: true, session: { ...props.detail.session,
    controlLease: { id: "shared", logicalSessionId: "A", holderClientSessionId: "another-browser", version: 1,
      expiresAt: new Date(Date.now() + 45_000).toISOString(), isMine: true } } };
  render(<SessionInspector {...props} />);
  expect(screen.queryByRole("button", { name: /取得控制权|释放控制权/ })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "发送给 Codex 的消息" }), { target: { value: "继续任务" } });
  expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(false);
});
function inspectorProps(id: string) { return { detail: detail(id), loading: false, draftOwner: "user-1", onRefresh: noop, onClaim: noop, onContinueManaged: noop, onReleaseManagement: noop, onSend: noop, onQueue: noop, onSteer: noop, onCancelQueued: noop, onCancel: noop, onApproval: noop }; }

beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); history.replaceState(null, "", "/");
  vi.mocked(api.dashboard).mockResolvedValue(dashboard());
  vi.mocked(api.permissions).mockResolvedValue({ profile: "project", source: "default", supported: true, preferences: { machine: { profile: null, revision: 0 }, project: { profile: null, revision: 0 }, session: { profile: null, revision: 0 } } });
  vi.mocked(api.clientSessions).mockResolvedValue({ sessions: [] });
  vi.mocked(api.session).mockImplementation(async (id) => detail(id));
  vi.mocked(api.commandReceipts).mockResolvedValue([]);
  vi.mocked(api.release).mockRejectedValue(new Error("测试不读取发布信息"));
  vi.mocked(api.hostOperations).mockResolvedValue([]);
  vi.mocked(api.machineCodexPreferences).mockRejectedValue(new Error("未提供模型目录"));
  vi.mocked(api.projects).mockImplementation(async ({ machineId }) => ({ items: dashboard().machines.find((machine) => machine.id === machineId)?.projects ?? [], nextCursor: null }));
  vi.mocked(api.sessions).mockImplementation(async ({ projectId }) => ({ items: sessions.filter((session) => session.projectId === projectId), nextCursor: null }));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });

describe("会话工作区", () => {
  it("历史请求未完成时回执仍可结束等待，晚到的旧详情不会恢复转圈", async () => {
    history.replaceState(null, "", "/sessions/A");
    const pending = { id: "send-1", type: "turn.start", state: "accepted", outcome: "pending", createdAt: "2026-09-07T17:48:44Z", updatedAt: "2026-09-07T17:48:44Z" };
    const completed = { ...pending, state: "applied", outcome: "succeeded", updatedAt: "2026-09-07T17:48:45Z" };
    const snapshot = { ...detail("A"), commands: [pending] };
    let finishHistory!: (value: SessionDetail) => void;
    let finishReceipt!: (value: typeof completed[]) => void;
    vi.mocked(api.session).mockResolvedValueOnce(snapshot).mockImplementationOnce(() => new Promise(resolve => { finishHistory = resolve; })).mockResolvedValue({ ...snapshot, commands: [completed] });
    vi.mocked(api.commandReceipts).mockImplementationOnce(() => new Promise(resolve => { finishReceipt = resolve; }));
    render(<App />);
    await screen.findByText("等待主机");
    fireEvent.focus(window);
    await waitFor(() => expect(api.session).toHaveBeenCalledTimes(2));
    const slowSignal = vi.mocked(api.session).mock.calls[1][1]!;
    for (let index = 0; index < 5; index++) fireEvent.focus(window);
    expect(slowSignal.aborted).toBe(false);
    expect(api.session).toHaveBeenCalledTimes(2);
    await act(async () => { finishReceipt([completed]); });
    await waitFor(() => expect(screen.queryByText("等待主机")).toBeNull());
    expect(screen.getByText("主机已确认")).toBeTruthy();
    await act(async () => { finishHistory(snapshot); });
    await waitFor(() => expect(api.session).toHaveBeenCalledTimes(3));
    expect(screen.queryByText("等待主机")).toBeNull();
    expect(api.command).not.toHaveBeenCalled();
  });
  it("旧接管失败可重新请求，处理中禁止连点，再次失败后刷新仍能重试", async () => {
    history.replaceState(null, "", "/sessions/A");
    const failed = { id: "claim-old", clientMutationId: "old-mutation", type: "thread.claim", state: "applied", outcome: "failed", createdAt: "2026-09-07T11:53:37Z", message: "active writer" };
    let current: SessionDetail = { ...detail("A"), writable: false, session: { ...sessions[0], state: { ...sessions[0].state, ownership: "claimable" } }, commands: [failed] };
    const signature = JSON.stringify({ type: "thread.claim", payload: {}, precondition: { nativeThreadId: "A", threadControlVersion: 1, expectedActiveTurnId: null, projectLeaseVersion: 1 } });
    sessionStorage.setItem("agentfleet.mutation:user-1:A", JSON.stringify({ signature, id: "old-mutation" }));
    vi.mocked(api.session).mockImplementation(async () => current);
    vi.mocked(api.command).mockImplementation(async (_id, input) => {
      const command = { ...failed, id: "claim-new", clientMutationId: input.clientMutationId, state: "accepted", outcome: "pending", message: null };
      current = { ...current, commands: [command, failed] };
      return { command };
    });
    const view = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "接管并同步" }));
    await waitFor(() => expect(api.command).toHaveBeenCalledTimes(1));
    const firstId = vi.mocked(api.command).mock.calls[0][1].clientMutationId;
    expect(firstId).not.toBe("old-mutation");
    await waitFor(() => expect((screen.getByRole("button", { name: "接管并同步" }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "接管并同步" }));
    expect(api.command).toHaveBeenCalledTimes(1);
    current = { ...current, commands: [{ ...failed, id: "claim-new", clientMutationId: firstId }, failed] };
    view.unmount();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "接管并同步" }));
    await waitFor(() => expect(api.command).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.command).mock.calls[1][1].clientMutationId).not.toBe(firstId);
  });
  it("状态放在标题行、同步详情移入配置，发送与快捷键提示位于输入框内部", () => {
    render(<SessionInspector {...inspectorProps("A")} />);
    const title = screen.getByRole("heading", { name: "会话A" });
    const titleRow = title.closest(".inspector-title-row")!;
    expect(within(titleRow as HTMLElement).getByText("空闲")).toBeTruthy();
    expect(within(titleRow as HTMLElement).getByText("完整历史")).toBeTruthy();
    expect(within(titleRow as HTMLElement).queryByText("同步详情")).toBeNull();
    expect(screen.getByText("同步详情").closest("dialog")?.getAttribute("aria-label")).toBe("会话配置");
    const prompt = screen.getByLabelText("发送给 Codex 的消息") as HTMLTextAreaElement;
    expect(prompt.rows).toBe(1);
    expect(screen.getByRole("button", { name: "发送" }).closest(".composer-input")).toBe(prompt.parentElement);
    expect(screen.getByText("Enter 发送 · Ctrl / ⌘ + Enter 换行").closest(".composer-input")).toBe(prompt.parentElement);
  });
  it("中文输入法确认时不触发快捷键提交", () => {
    const send = vi.fn(noop);
    render(<SessionInspector {...inspectorProps("A")} onSend={send} />);
    const prompt = screen.getByLabelText("发送给 Codex 的消息") as HTMLTextAreaElement;
    const submit = vi.spyOn(prompt.form!, "requestSubmit").mockImplementation(() => {});
    fireEvent.change(prompt, { target: { value: "任务草稿" } });
    fireEvent.keyDown(prompt, { key: "Enter", isComposing: true });
    fireEvent.keyDown(prompt, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(prompt, { key: "Enter", repeat: true });
    fireEvent.keyDown(prompt, { key: "Enter", shiftKey: true });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(prompt, { key: "Enter" });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["ctrlKey", "metaKey"])("%s + Enter 在选区插入换行、保留光标且不发送，随后 Enter 发送完整文本", async (modifier) => {
    const send = vi.fn(async (_prompt: string) => undefined);
    render(<SessionInspector {...inspectorProps("A")} onSend={send} />);
    const prompt = screen.getByLabelText("发送给 Codex 的消息") as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "第一行替换第二行" } });
    prompt.setSelectionRange(3, 5);
    fireEvent.keyDown(prompt, { key: "Enter", [modifier]: true });
    expect(prompt.value).toBe("第一行\n第二行");
    await waitFor(() => expect(prompt.selectionStart).toBe(4));
    expect(prompt.selectionEnd).toBe(4);
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(prompt, { key: "Enter" });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toBe("第一行\n第二行");
  });
  it("第二栏收起后保留搜索、当前会话和草稿，并可原位展开", async () => {
    history.replaceState(null, "", "/sessions/A");
    render(<App />);
    await screen.findByRole("heading", { name: "会话A" });
    const catalog = document.getElementById("workbench-catalog");
    const inspector = document.querySelector(".inspector");
    const draft = screen.getByLabelText("发送给 Codex 的消息") as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "收起时保留的任务草稿" } });
    const search = screen.getByRole("textbox", { name: "搜索项目或会话" });
    fireEvent.change(search, { target: { value: "保留查询" } });
    const toggle = screen.getByRole("button", { name: "收起项目与会话" });
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(catalog?.id);
    expect(document.activeElement).toBe(toggle);
    expect(document.querySelector(".fleet-layout--catalog-collapsed")).not.toBeNull();
    expect(document.querySelector(".inspector")).toBe(inspector);
    expect(draft.value).toBe("收起时保留的任务草稿");
    expect(location.pathname).toBe("/sessions/A");
    fireEvent.click(screen.getByRole("button", { name: "展开项目与会话" }));
    expect(document.getElementById("workbench-catalog")).toBe(catalog);
    expect((search as HTMLInputElement).value).toBe("保留查询");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".fleet-layout--catalog-collapsed")).toBeNull();
  });
  it("刷新保留第二栏收起偏好，不影响主机与设置路由", async () => {
    const first = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "收起项目与会话" }));
    first.unmount();
    render(<App />);
    expect((await screen.findByRole("button", { name: "展开项目与会话" })).getAttribute("aria-expanded")).toBe("false");
    const nav = screen.getByRole("navigation", { name: "主导航" });
    fireEvent.click(within(nav).getByRole("button", { name: "主机" }));
    expect(screen.queryByRole("button", { name: "展开项目与会话" })).toBeNull();
    fireEvent.click(within(nav).getByRole("button", { name: "工作台" }));
    expect(screen.getByRole("button", { name: "展开项目与会话" })).toBeTruthy();
  });
  it("浏览器存储不可用时仍可收起和展开第二栏", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("storage disabled"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage disabled"); });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "收起项目与会话" }));
    expect(screen.getByRole("button", { name: "展开项目与会话" })).toBeTruthy();
  });
  it.each(["/workbench/2", "/hosts/2"])("%s 直接访问及刷新保持第二台主机", async (path) => {
    history.replaceState(null, "", path);
    const first = render(<App />);
    if (path.startsWith("/hosts")) {
      expect((await screen.findByRole("button", { name: /^主机2，/ })).getAttribute("aria-pressed")).toBe("true");
    } else expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("主机2");
    first.unmount();
    render(<App />);
    if (path.startsWith("/hosts")) {
      expect((await screen.findByRole("button", { name: /^主机2，/ })).getAttribute("aria-pressed")).toBe("true");
    } else expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("主机2");
    expect(location.pathname).toBe(path);
    expect(api.session).not.toHaveBeenCalled();
  });
  it("顶部导航和两个页面的主机切换都有独立地址", async () => {
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "主导航" });
    fireEvent.click(screen.getByRole("button", { name: "主机2 在线可用" }));
    expect(location.pathname).toBe("/workbench/2");
    fireEvent.click(within(nav).getByRole("button", { name: "主机" }));
    expect(location.pathname).toBe("/hosts/2");
    fireEvent.click(screen.getByRole("button", { name: /^主机1，/ }));
    expect(location.pathname).toBe("/hosts/1");
    fireEvent.click(within(nav).getByRole("button", { name: "设置" }));
    expect(location.pathname).toBe("/settings");
    expect(await screen.findByRole("heading", { name: "设置" })).toBeTruthy();
  });
  it("设置深链及跨页面 history 恢复不会重写目标地址", async () => {
    history.replaceState(null, "", "/settings");
    render(<App />);
    await screen.findByRole("heading", { name: "设置" });
    for (const path of ["/hosts/2", "/workbench/2", "/sessions/A", "/settings", "/hosts/2"]) {
      act(() => { history.replaceState(null, "", path); fireEvent.popState(window); });
      expect(location.pathname).toBe(path);
      if (path === "/hosts/2") expect((await screen.findByRole("button", { name: /^主机2，/ })).getAttribute("aria-pressed")).toBe("true");
      if (path === "/workbench/2") expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("主机2");
      if (path === "/sessions/A") await screen.findByRole("heading", { name: "会话A" });
      if (path === "/settings") await screen.findByRole("heading", { name: "设置" });
    }
  });
  it.each(["/hosts", "/workbench"])("%s 默认主机使用 replace，不添加多余的历史记录", async (path) => {
    history.replaceState(null, "", path);
    const size = history.length;
    render(<App />);
    await waitFor(() => expect(location.pathname).toBe(`${path}/1`));
    expect(history.length).toBe(size);
  });
  it.each(["/hosts/deleted", "/workbench/deleted"])("%s 不会误展示另一台主机", async (path) => {
    history.replaceState(null, "", path);
    render(<App />);
    await screen.findByRole("heading", { name: "该主机不存在或已移除" });
    expect(location.pathname).toBe(path);
    expect(api.machineCodexPreferences).not.toHaveBeenCalled();
    expect(api.projects).not.toHaveBeenCalled();
  });
  it("关闭会话回到其主机地址", async () => {
    history.replaceState(null, "", "/sessions/B");
    render(<App />);
    await screen.findByRole("heading", { name: "会话B" });
    fireEvent.click(screen.getByRole("button", { name: "关闭会话详情" }));
    expect(location.pathname).toBe("/workbench/2");
    expect(screen.getByText("选择一个会话")).toBeTruthy();
  });
  it("未登录打开第二台主机深链，登录后仍进入指定主机", async () => {
    history.replaceState(null, "", "/hosts/2");
    vi.mocked(api.dashboard).mockRejectedValueOnce(new ApiError("请登录", 401, "UNAUTHORIZED"));
    vi.mocked(api.login).mockResolvedValue({ dashboard: dashboard() });
    render(<App />);
    await screen.findByRole("heading", { name: "进入控制面" });
    fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "test-only" } });
    fireEvent.click(screen.getByRole("button", { name: "进入 AgentFleets" }));
    expect((await screen.findByRole("button", { name: /^主机2，/ })).getAttribute("aria-pressed")).toBe("true");
    expect(location.pathname).toBe("/hosts/2");
  });
  it("全局状态只在第一栏底部展示，并保留实时连接状态", async () => {
    render(<App />);
    const status = await screen.findByLabelText("Fleet 摘要");
    expect(status.closest(".machine-rail")).not.toBeNull();
    expect(status.closest(".rail-footer")?.lastElementChild).toBe(status);
    expect(status.closest(".fleet-main")).toBeNull();
    expect(screen.getAllByLabelText("Fleet 摘要")).toHaveLength(1);
    expect(screen.queryByText("P0b")).toBeNull();
    expect(screen.queryByText("remote-restricted-v1")).toBeNull();
    expect(screen.queryByText("项目内写入 · 网络关闭")).toBeNull();
    expect(Array.from(status.children).map(row => row.textContent)).toEqual(["2在线主机", "0运行中", "2已接管", "赛博朋克日光午夜森林护眼", "正在重新连接"]);
    const onConnected = vi.mocked(subscribeToFleet).mock.calls[0][2];
    act(() => onConnected(true));
    expect(status.textContent).toContain("连接正常");
  });
  it("底部已接管列出所有会话，选择后直接打开对应会话", async () => {
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "主导航" });
    expect(within(nav).queryByRole("button", { name: /待处理|审批/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看已接管的会话（2）" }));
    const list = screen.getByRole("dialog", { name: /已接管的会话\s*2/ });
    expect(within(list).getByRole("button", { name: /会话A/ })).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: /会话B/ }));
    await waitFor(() => expect(location.pathname).toBe("/sessions/B"));
    expect(await screen.findByRole("textbox", { name: "发送给 Codex 的消息" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("快捷入口使用完整活动快照，可打开最近列表以外的会话并切换在线主机", async () => {
    const old = {...session("outside-page", "2"), state:{...session("outside-page", "2").state,currentTurn:"in_progress" as const}};
    vi.mocked(api.dashboard).mockResolvedValue({...dashboard(),activitySessions:[old,...sessions]});
    vi.mocked(api.session).mockImplementation(async id => id === old.id ? {...detail("B"),session:old} : detail(id));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", {name:"查看运行中的会话（1）"}));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button",{name:/会话outside-page/}));
    await waitFor(()=>expect(location.pathname).toBe("/sessions/outside-page"));
    await screen.findByRole("textbox",{name:"发送给 Codex 的消息"});
    fireEvent.click(screen.getByRole("button",{name:"查看在线主机（2）"}));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button",{name:/主机1.*Linux/}));
    await waitFor(()=>expect(location.pathname).toBe("/hosts/1"));
    expect((await screen.findByRole("button",{name:/^主机1，/})).getAttribute("aria-pressed")).toBe("true");
  });

  it("有待办时自动显示顶部提醒，区分问题与操作并打开正确会话", async () => {
    const pending: Approval = { id: "question-1", logicalSessionId: "B", approvalVersion: 1, type: "user_input", status: "pending", machineName: "主机2", projectAlias: "项目2", cwd: "/srv/2", summary: "请选择任务范围", risk: "low", policyVersion: "test", actionHash: "test", appServerEpoch: "test", expiresAt: "2099-01-01T00:00:00Z" };
    vi.mocked(api.dashboard).mockResolvedValue({ ...dashboard(), stats: { ...dashboard().stats, approvals: 1 }, pendingApprovals: [pending] });
    render(<App />);
    const nav = await screen.findByRole("navigation", { name: "主导航" });
    fireEvent.click(within(nav).getByRole("button", { name: /待处理.*1/ }));
    expect(screen.getByText("需要回答")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /请选择任务范围/ }));
    await waitFor(() => expect(api.session).toHaveBeenCalledWith("B", expect.any(AbortSignal)));
  });
  it("待处理只打开会话，不直接批准操作", () => {
    const open = vi.fn();
    const approval = { id: "confirm", logicalSessionId: "A", type: "command", summary: "运行项目检查", machineName: "主机1", projectAlias: "项目1", risk: "medium", command: "npm test" } as Approval;
    render(<ApprovalsView approvals={[approval]} onOpen={open} onBack={vi.fn()} />);
    expect(screen.getByText("需要确认")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "仅本次允许" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /运行项目检查/ }));
    expect(open).toHaveBeenCalledWith("A");
  });
  it("会话配置默认隐藏，斜杠命令打开工具，关闭重开保留编辑", () => {
    render(<SessionInspector {...inspectorProps("A")} />);
    expect(screen.getByText("完整历史")).toBeTruthy();
    const tools = screen.getByText("更多工具与命令").closest("details")!;
    expect(tools.open).toBe(false);
    const prompt = screen.getByLabelText("发送给 Codex 的消息") as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "/help" } });
    // jsdom does not implement browser scrolling.
    const scroll = Element.prototype.scrollIntoView;
    const showModal = HTMLDialogElement.prototype.showModal;
    const close = HTMLDialogElement.prototype.close;
    Element.prototype.scrollIntoView = vi.fn();
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    HTMLDialogElement.prototype.close = function () { this.open = false; };
    expect(screen.queryByRole("dialog", {name:"会话配置"})).toBeNull();
    expect(tools.closest("form")).toBeNull();
    try {
      fireEvent.submit(prompt.form!);
      expect(tools.open).toBe(true);
      expect(screen.getByText("全部 / 命令 · 支持范围").closest("details")!.open).toBe(true);
      expect(screen.getByRole("dialog", {name:"会话配置"})).toBeTruthy();
      const title = screen.getByLabelText("宿主机会话新标题") as HTMLInputElement;
      fireEvent.change(title, {target:{value:"保留未提交的标题"}});
      fireEvent.click(screen.getByRole("button", {name:"关闭会话配置"}));
      expect(screen.queryByRole("dialog", {name:"会话配置"})).toBeNull();
      fireEvent.click(screen.getByRole("button", {name:"会话配置"}));
      expect((screen.getByLabelText("宿主机会话新标题") as HTMLInputElement).value).toBe("保留未提交的标题");
    } finally { Element.prototype.scrollIntoView = scroll; HTMLDialogElement.prototype.showModal = showModal; HTMLDialogElement.prototype.close = close; }
  });
  it("/init 只准备可编辑草稿，不自动运行；未接入命令解释原因", async () => {
    const send = vi.fn(noop);
    render(<SessionInspector {...inspectorProps("A")} onSend={send} />);
    const prompt = screen.getByLabelText("发送给 Codex 的消息") as HTMLTextAreaElement;
    fireEvent.change(prompt, { target: { value: "/init" } });
    fireEvent.submit(prompt.form!);
    expect(send).not.toHaveBeenCalled();
    expect(prompt.value).toContain("AGENTS.md");
    expect(prompt.value).toContain("不盲目覆盖");
    fireEvent.change(prompt, { target: { value: "/logout" } });
    fireEvent.submit(prompt.form!);
    expect(screen.getByText(/不是退出面板账号.*未向宿主机发送/)).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  });
  it("普通刷新不选会话，项目保持收起", async () => {
    render(<App />);
    await screen.findByText("选择一个会话");
    expect(api.session).not.toHaveBeenCalled();
    expect((await screen.findByRole("button", { name: /项目1 \/srv/ })).getAttribute("aria-expanded")).toBe("false");
  });
  it("深链定位会话所属主机", async () => {
    history.replaceState(null, "", "/sessions/B");
    render(<App />);
    await waitFor(() => expect(api.session).toHaveBeenCalledWith("B", expect.any(AbortSignal)));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("主机2");
    expect(screen.getByRole("heading", { name: "会话B" })).toBeTruthy();
  });
  it("主机页切换后，实时更新、窗口聚焦和列表重排不会被旧会话拉回", async () => {
    history.replaceState(null, "", "/sessions/A");
    render(<App />);
    await screen.findByRole("heading", { name: "会话A" });
    fireEvent.change(screen.getByLabelText("发送给 Codex 的消息"), { target: { value: "保留 A 的草稿" } });
    const nav = screen.getByRole("navigation", { name: "主导航" });
    fireEvent.click(within(nav).getByRole("button", { name: "主机" }));
    fireEvent.click(screen.getByRole("button", { name: "主机2，已连接，当前空闲" }));
    expect(location.pathname).toBe("/hosts/2");
    expect(screen.getByRole("button", { name: /^主机2，/ }).getAttribute("aria-pressed")).toBe("true");
    const [focusedSessions, onUpdate] = vi.mocked(subscribeToFleet).mock.calls[0];
    expect(typeof focusedSessions === "function" ? focusedSessions() : focusedSessions).toEqual([]);
    vi.mocked(api.session).mockClear();
    for (const machines of [dashboard().machines, [...dashboard().machines].reverse()]) {
      const next = { ...dashboard(), machines, serverTime: new Date().toISOString() };
      vi.mocked(api.dashboard).mockResolvedValue(next);
      const previousCalls = vi.mocked(api.dashboard).mock.calls.length;
      await act(async () => { fireEvent.focus(window); });
      act(() => onUpdate());
      await waitFor(() => expect(api.dashboard).toHaveBeenCalledTimes(previousCalls + 2));
      expect(screen.getByRole("button", { name: /^主机2，/ }).getAttribute("aria-pressed")).toBe("true");
      expect((screen.getByLabelText("显示名称") as HTMLInputElement).value).toBe("主机2");
    }
    expect(api.session).not.toHaveBeenCalled();
    expect(api.machineCodexPreferences).toHaveBeenLastCalledWith("2", expect.any(AbortSignal));
    fireEvent.click(within(nav).getByRole("button", { name: "工作台" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("主机2");
    expect(screen.getByText("选择一个会话")).toBeTruthy();
    expect(localStorage.getItem(draftKey("user-1", "A"))).toBe("保留 A 的草稿");
  });
  it.each(["hosts", "rail"])("%s 切换主机会取消旧详情请求，并忽略晚到的详情和概览", async (target) => {
    let finishDetail!: (value: SessionDetail) => void;
    let finishDashboard!: (value: Dashboard) => void;
    vi.mocked(api.session).mockImplementation(() => new Promise((resolve) => { finishDetail = resolve; }));
    history.replaceState(null, "", "/sessions/A");
    render(<App />);
    await waitFor(() => expect(api.session).toHaveBeenCalledWith("A", expect.any(AbortSignal)));
    vi.mocked(api.dashboard).mockImplementationOnce(() => new Promise((resolve) => { finishDashboard = resolve; }));
    fireEvent.focus(window);
    const oldSignal = vi.mocked(api.session).mock.calls.at(-1)![1]!;
    if (target === "hosts") {
      fireEvent.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: "主机" }));
      fireEvent.click(screen.getByRole("button", { name: /^主机2，/ }));
    } else {
      fireEvent.click(screen.getByRole("button", { name: "主机2 在线可用" }));
    }
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { finishDetail(detail("A")); finishDashboard(dashboard()); });
    expect(location.pathname).toBe(target === "hosts" ? "/hosts/2" : "/workbench/2");
    if (target === "hosts") expect(screen.getByRole("button", { name: /^主机2，/ }).getAttribute("aria-pressed")).toBe("true");
    else expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("主机2");
    expect(screen.queryByRole("heading", { name: "会话A" })).toBeNull();
  });
  it("旧详情请求晚到也不覆盖新会话，切换不重开实时连接", async () => {
    let finishA: (value: SessionDetail) => void = () => undefined;
    vi.mocked(api.session).mockImplementation((id) => id === "A" ? new Promise((resolve) => { finishA = resolve; }) : Promise.resolve(detail(id)));
    history.replaceState(null, "", "/sessions/A");
    render(<App />);
    await waitFor(() => expect(api.session).toHaveBeenCalledWith("A", expect.any(AbortSignal)));
    history.pushState(null, "", "/sessions/B"); fireEvent.popState(window);
    await screen.findByRole("heading", { name: "会话B" });
    finishA(detail("A"));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "会话A" })).toBeNull());
    expect(subscribeToFleet).toHaveBeenCalledTimes(1);
  });
  it("不同会话与账号草稿隔离，并跨刷新恢复", () => {
    const { rerender, unmount } = render(<SessionInspector {...inspectorProps("A")} />);
    fireEvent.change(screen.getByLabelText("发送给 Codex 的消息"), { target: { value: "只发给A" } });
    rerender(<SessionInspector {...inspectorProps("B")} />);
    expect((screen.getByLabelText("发送给 Codex 的消息") as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("发送给 Codex 的消息"), { target: { value: "只发给B" } });
    rerender(<SessionInspector {...inspectorProps("A")} draftOwner="user-2" />);
    expect((screen.getByLabelText("发送给 Codex 的消息") as HTMLTextAreaElement).value).toBe("");
    unmount(); render(<SessionInspector {...inspectorProps("A")} />);
    expect((screen.getByLabelText("发送给 Codex 的消息") as HTMLTextAreaElement).value).toBe("只发给A");
    expect(localStorage.getItem(draftKey("user-1", "B"))).toBe("只发给B");
  });
  it("不再提供单独删除云端正文的操作", () => {
    render(<SessionInspector {...inspectorProps("A")} />);
    expect(screen.queryByRole("button", { name: "删除云端会话正文" })).toBeNull();
    expect(screen.queryByText(/删除这个会话的云端正文/)).toBeNull();
  });
  it("正常入队不显示感叹号或未知结果，派发等待与未知状态分开显示", () => {
    const queued = { id: "queued", type: "turn.queue", state: "queued", outcome: "pending", createdAt: "2026-09-05T00:00:00Z" };
    const view = render(<OperationReceipts commands={[queued]} />);
    expect(screen.getByText("等待上一轮结束")).toBeTruthy();
    expect(view.container.querySelector(".operation-receipt--unknown")).toBeNull();
    expect(screen.queryByText(/系统不会自动重发/)).toBeNull();
    view.unmount();
    const props = inspectorProps("A");
    props.detail.queue = [
      {id:"waiting",commandId:"waiting-command",position:1,state:"dispatching",waitingForHost:true,prompt:"稍后执行",createdAt:queued.createdAt,expiresAt:queued.createdAt,mine:true},
      {id:"unknown",commandId:"unknown-command",position:2,state:"unknown",prompt:"待核验",createdAt:queued.createdAt,expiresAt:queued.createdAt,mine:true},
      {id:"done",commandId:"done-command",position:3,state:"applied",prompt:"已派发的旧消息",createdAt:queued.createdAt,expiresAt:queued.createdAt,mine:true},
      {id:"failed",commandId:"failed-command",position:4,state:"invalidated",prompt:"已失败的旧消息",createdAt:queued.createdAt,expiresAt:queued.createdAt,mine:true},
    ];
    render(<SessionInspector {...props} />);
    expect(screen.getByText("等待主机同步后派发")).toBeTruthy();
    expect(screen.getByText("结果待核验，不会自动重发")).toBeTruthy();
    expect(screen.queryByText("正在派发")).toBeNull();
    expect(screen.queryByText("已派发的旧消息")).toBeNull();
    expect(screen.queryByText("已失败的旧消息")).toBeNull();
  });
  it("持久回执区别已接收、失败与未知，未知操作刷新后仍有说明", () => {
    const commands = [
      { id: "cmd-1", type: "thread.release", state: "accepted", outcome: "pending", createdAt: "2026-09-05T00:00:00Z" },
      { id: "cmd-2", type: "thread.claim", state: "applied", outcome: "failed", message: "主机仍有任务", createdAt: "2026-09-05T00:00:00Z" },
      { id: "cmd-3", type: "turn.start", state: "unknown", outcome: "unknown", createdAt: "2026-09-05T00:00:00Z" },
    ];
    render(<OperationReceipts commands={commands} />);
    expect(screen.getByText("等待主机")).toBeTruthy();
    expect(screen.getByText("结果待核验")).toBeTruthy();
    expect(receiptStatus(commands[1]).tone).toBe("failed");
    expect(screen.queryByText("主机已确认")).toBeNull();
  });
});

it("切换语言保留会话、消息正文和草稿，不发送命令", async () => {
  const { setLocale } = await import("./i18n");
  history.replaceState(null, "", "/sessions/A");
  vi.mocked(api.session).mockResolvedValue({ ...detail("A"), events: [{ id: "original", type: "message", sessionSeq: 1, occurredAt: "2026-09-09T00:00:00Z", actor: "user", body: "发送" }] });
  render(<App />);
  const input = await screen.findByRole("textbox", { name: "发送给 Codex 的消息" });
  fireEvent.change(input, { target: { value: "用户草稿 /model 原样保留" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Language / 语言" }), { target: { value: "en" } });
  expect((screen.getByRole("textbox", { name: "Message to Codex" }) as HTMLTextAreaElement).value).toBe("用户草稿 /model 原样保留");
  expect(screen.getByText("发送")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "会话A" })).toBeTruthy();
  expect(location.pathname).toBe("/sessions/A");
  expect(api.command).not.toHaveBeenCalled();
  act(() => setLocale("zh-CN"));
  expect((screen.getByRole("textbox", { name: "发送给 Codex 的消息" }) as HTMLTextAreaElement).value).toBe("用户草稿 /model 原样保留");
});
