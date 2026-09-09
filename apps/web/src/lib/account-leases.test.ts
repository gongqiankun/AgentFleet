// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each(["turn.start", "thread.delete.preview", "thread.delete"] as const)("%s 执行前自动取得账号操作资格，不沿用旧窗口或已过期租约", async type => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ leaseId: "fresh", holderClientSessionId: "other-browser", isMine: true })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ command: { commandId: "command" } })));
  vi.stubGlobal("fetch", fetch);
  await api.command("session", { type, controlLeaseId: "expired", clientMutationId: "stable-mutation", payload: { prompt: "hello" }, precondition: {} });
  expect(fetch.mock.calls[0][0]).toContain("/control-lease");
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({});
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ controlLeaseId: "fresh", clientMutationId: "stable-mutation" });
});
it("其他账号占用时不提交任务，也不自动重试执行请求", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "CONTROL_LEASE_HELD", message: "occupied" } }), { status: 409 }));
  vi.stubGlobal("fetch", fetch);
  await expect(api.command("session", { type: "turn.cancel", clientMutationId: "cancel", payload: {}, precondition: {} })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("只读查询和排队等不需要租约的操作不附加租约", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ command: { commandId: "command" } })));
  vi.stubGlobal("fetch", fetch);
  await api.command("session", { type: "codex.inspect", clientMutationId: "inspect", payload: {}, precondition: {} });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toContain("/commands");
  expect(JSON.parse(fetch.mock.calls[0][1].body).controlLeaseId).toBeUndefined();
});
