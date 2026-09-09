// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodexInputCard } from "./components/CodexInputCard";
import { api } from "./lib/api";
import type { Approval } from "./lib/types";
vi.mock("./lib/api", () => ({ api: { command: vi.fn() } }));
const request: Approval = { id: "input-a", logicalSessionId: "session-a", approvalVersion: 1, type: "user_input", status: "pending", machineName: "Host A", projectAlias: "Project", cwd: "/project", summary: "问题", risk: "low", policyVersion: "remote-restricted-v1", actionHash: "hash-a", appServerEpoch: "epoch-a", expiresAt: "2099-01-01T00:00:00Z", questions: [{ id: "scope", header: "范围", question: "处理哪里？", options: [{ label: "当前项目", description: "只处理当前目录" }] }] };
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("requires an explicit answer and sends the exact original request identity, once", async () => {
  vi.mocked(api.command).mockResolvedValue({ command: { id: "cmd", type: "input.respond", state: "accepted", createdAt: "now" } });
  const changed = vi.fn(); render(<CodexInputCard request={request} onChanged={changed} />);
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("radio")); fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(api.command).toHaveBeenCalledWith("session-a", expect.objectContaining({ type: "input.respond", precondition: { approvalId: "input-a", approvalVersion: 1, actionHash: "hash-a", appServerEpoch: "epoch-a" }, payload: { answers: { scope: { answers: ["当前项目"] } } } }));
  fireEvent.click(screen.getByRole("button")); expect(api.command).toHaveBeenCalledOnce();
});
it("accepts free text, preserves it on failure and never uses permission approval", async () => {
  vi.mocked(api.command).mockRejectedValue(new Error("请求已经结束"));
  render(<CodexInputCard request={request} onChanged={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("范围 的回答"), { target: { value: "只更新文档" } });
  fireEvent.click(screen.getByRole("button"));
  await screen.findByRole("alert");
  expect((screen.getByLabelText("范围 的回答") as HTMLTextAreaElement).value).toBe("只更新文档");
});
it("expired questions cannot be answered", () => {
  render(<CodexInputCard request={{ ...request, expiresAt: "2020-01-01T00:00:00Z" }} onChanged={vi.fn()} />);
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button")); expect(api.command).not.toHaveBeenCalled();
});
