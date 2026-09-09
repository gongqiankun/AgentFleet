// @vitest-environment jsdom
import { expect, it } from "vitest";
import { mapEvent } from "./lib/api";
import { timelineItems } from "./lib/timeline-items";
import type { TimelineEvent } from "./lib/types";
const start: TimelineEvent = { id: "start", type: "item.started", sessionSeq: 304, occurredAt: "2026-09-07T11:29:07Z", nativeThreadId: "thread", nativeTurnId: "turn", nativeItemId: "item", actor: "user", body: "这是什么图片", payloadState: "present", images: ["image"] };
const done: TimelineEvent = { ...start, id: "done", type: "item.completed", sessionSeq: 305 };

it("同一原生消息的开始、完成和重复导入仅显示一次，使用稳定滚动锚点", () => {
  const result = timelineItems([start, done, { ...done, id: "imported", sessionSeq: 310 }]);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ type: "item.completed", body: "这是什么图片", images: ["image"] });
  expect(result[0].id).toBe(timelineItems([start])[0].id);
  expect(result[0].id).toBe(timelineItems([done])[0].id);
  expect(timelineItems([done, start])[0].type).toBe("item.completed");
});
it("相同文字但不同消息、轮次或线程不能误合并；缺失身份的事件保留", () => {
  const events = [start, { ...done, nativeItemId: "second" }, { ...done, nativeTurnId: "second" }, { ...done, nativeThreadId: "second" }, { ...done, nativeItemId: undefined }, { ...done, nativeTurnId: undefined }];
  expect(timelineItems(events)).toHaveLength(events.length);
});
it("命令完成更新原卡片输出，删除记录不被旧事件恢复", () => {
  const output = timelineItems([{ ...start, command: "test", output: null }, { ...done, command: "test", output: "passed" }]);
  expect(output).toHaveLength(1); expect(output[0].output).toBe("passed");
  const deleted = { ...done, payloadState: "deleted" as const, images: [], body: null };
  expect(timelineItems([deleted, start])[0]).toMatchObject({ payloadState: "deleted", body: null, images: [] });
});
it("API 保留原生身份以合并真实 started/completed 图文事件", () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  const events = ["item.started", "item.completed"].map((type, i) => mapEvent({ eventId: `event-${i}`, type, sessionSeq: i + 1, nativeThreadId: "thread", nativeTurnId: "turn", payloadState: "present", payload: { item: { id: "native-item", type: "userMessage", content: [{ type: "text", text: "这是什么图片" }, { type: "image", url: png }] } } }));
  expect(timelineItems(events)).toHaveLength(1);
  expect(timelineItems(events)[0]).toMatchObject({ nativeItemId: "native-item", images: [png], body: "这是什么图片" });
});
