// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationViewport } from "./components/ConversationViewport";
import { CommandExecution } from "./components/CommandExecution";
import type { TimelineEvent } from "./lib/types";

let viewportHeight = 200;
const event = (id: string, body = id): TimelineEvent => ({ id, sessionSeq: 1, type: "message", body, occurredAt: "2026-09-07T00:00:00Z" });
const initial = ["a", "b", "c", "d", "e"].map(id => event(id));
function History({ events, session = "A" }: { events: TimelineEvent[]; session?: string }) {
  return <ConversationViewport key={session} events={events}>{events.map(item => <article key={item.id} data-scroll-anchor={item.id}>{item.body}</article>)}</ConversationViewport>;
}
beforeEach(() => {
  viewportHeight = 200;
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function(this: HTMLElement) { return this.classList.contains("timeline-scroll") || this.classList.contains("command-execution__log") ? viewportHeight : 0; });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function(this: HTMLElement) {
    return this.classList.contains("timeline-scroll") ? this.querySelectorAll("article").length * 100 : this.classList.contains("command-execution__log") ? (this.textContent?.length ?? 0) * 10 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    const parent = this.closest(".timeline-scroll") as HTMLElement | null;
    const index = parent ? Array.from(parent.querySelectorAll("article")).indexOf(this) : -1;
    const top = index < 0 ? 0 : index * 100 - parent!.scrollTop;
    return { top, bottom: top + (index < 0 ? viewportHeight : 100), left: 0, right: 400, width: 400, height: 100, x: 0, y: top, toJSON() {} };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("初次打开默认到底部，在底部时自动跟随新增记录", () => {
  const { rerender } = render(<History events={initial} />);
  const view = screen.getByRole("region", { name: "会话记录" });
  expect(view.scrollTop).toBe(300);
  rerender(<History events={[...initial, event("f")]} />);
  expect(view.scrollTop).toBe(400);
  expect(screen.queryByRole("button", { name: "新消息" })).toBeNull();
});
it("向上翻阅暂停跟随，流式内容更新出现提示，点击后恢复", () => {
  const { rerender } = render(<History events={initial} />);
  const view = screen.getByRole("region", { name: "会话记录" });
  view.scrollTop = 100; fireEvent.scroll(view);
  expect(screen.getByRole("button", { name: "回到最新" })).toBeTruthy();
  rerender(<History events={[...initial.slice(0, -1), event("e", "stream update")]} />);
  expect(view.scrollTop).toBe(100);
  fireEvent.click(screen.getByRole("button", { name: "新消息" }));
  expect(view.scrollTop).toBe(300);
  rerender(<History events={[...initial, event("f")]} />);
  expect(view.scrollTop).toBe(400);
});
it("前插旧历史并同时收到新消息时保留原可见记录的位置", () => {
  const { rerender } = render(<History events={initial} />);
  const view = screen.getByRole("region", { name: "会话记录" });
  view.scrollTop = 125; fireEvent.scroll(view);
  const anchor = screen.getByText("b");
  const top = anchor.getBoundingClientRect().top;
  rerender(<History events={[event("older-1"), event("older-2"), ...initial, event("f")]} />);
  expect(view.scrollTop).toBe(325);
  expect(anchor.getBoundingClientRect().top).toBe(top);
  expect(screen.getByRole("button", { name: "新消息" })).toBeTruthy();
});
it("仅加载旧历史或相同内容刷新不误报新消息", () => {
  const { rerender } = render(<History events={initial} />);
  const view = screen.getByRole("region", { name: "会话记录" });
  view.scrollTop = 0; fireEvent.scroll(view);
  rerender(<History events={[event("old"), ...initial.map(item => ({ ...item }))]} />);
  expect(view.scrollTop).toBe(100);
  expect(screen.queryByRole("button", { name: "新消息" })).toBeNull();
});
it("手动返回底部恢复跟随，切换会话重置定位，空历史到达后也定位最新", () => {
  const { rerender } = render(<History events={initial} />);
  const view = screen.getByRole("region", { name: "会话记录" });
  view.scrollTop = 0; fireEvent.scroll(view);
  view.scrollTop = 300; fireEvent.scroll(view);
  expect(screen.queryByRole("button", { name: "回到最新" })).toBeNull();
  rerender(<History events={[]} session="B" />);
  rerender(<History events={initial} session="B" />);
  expect(screen.getByRole("region", { name: "会话记录" }).scrollTop).toBe(300);
});
it("输入框或窗口高度变化时仅在跟随模式保持底部", () => {
  render(<History events={initial} />);
  const view = screen.getByRole("region", { name: "会话记录" });
  viewportHeight = 100; fireEvent.resize(window);
  expect(view.scrollTop).toBe(400);
  view.scrollTop = 100; fireEvent.scroll(view);
  viewportHeight = 150; fireEvent.resize(window);
  expect(view.scrollTop).toBe(100);
});
it("命令日志独立跟随末尾，向上看旧输出时不被新输出打断", () => {
  const { rerender } = render(<CommandExecution output={"x".repeat(50)} />);
  fireEvent.click(screen.getByRole("button", { name: "展开代码" }));
  const log = screen.getByRole("region", { name: "命令与输出内容" });
  expect(log.scrollTop).toBe(300);
  log.scrollTop = 100; fireEvent.scroll(log);
  rerender(<CommandExecution output={"x".repeat(60)} />);
  expect(log.scrollTop).toBe(100);
  fireEvent.click(screen.getByRole("button", { name: "新输出 ↓" }));
  expect(log.scrollTop).toBe(400);
});
