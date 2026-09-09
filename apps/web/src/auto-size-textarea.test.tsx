// @vitest-environment jsdom
import { useRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoSizeTextarea } from "./lib/auto-size-textarea";

function Input({ value, context = "A", hidden = false }: { value: string; context?: string; hidden?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoSizeTextarea(ref, value, `${context}:${hidden}`);
  return hidden ? null : <textarea aria-label="draft" ref={ref} value={value} readOnly />;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("随内容增高、超过上限后滚动，清空或切换草稿时缩回", () => {
  vi.spyOn(HTMLTextAreaElement.prototype, "clientWidth", "get").mockReturnValue(300);
  vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLTextAreaElement) { return 20 + this.value.length * 5; });
  const { rerender } = render(<Input value="" />);
  const input = screen.getByLabelText("draft") as HTMLTextAreaElement;
  expect(input.style.height).toBe("40px");
  rerender(<Input value="some longer content" />);
  expect(parseFloat(input.style.height)).toBeGreaterThan(40);
  rerender(<Input value={"x".repeat(100)} />);
  expect(input.style.height).toBe("180px");
  expect(input.style.overflowY).toBe("auto");
  rerender(<Input value="" context="B" />);
  expect(input.style.height).toBe("40px");
  expect(input.style.overflowY).toBe("hidden");
});
it("加载结束和窗口变化后重新计算，不丢失输入节点", () => {
  vi.spyOn(HTMLTextAreaElement.prototype, "clientWidth", "get").mockReturnValue(300);
  let height = 60;
  vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
  const { rerender } = render(<Input value="restored draft" hidden />);
  rerender(<Input value="restored draft" />);
  const input = screen.getByLabelText("draft") as HTMLTextAreaElement;
  expect(input.style.height).toBe("60px");
  height = 120; fireEvent.resize(window);
  expect(input.style.height).toBe("120px");
  expect(screen.getByLabelText("draft")).toBe(input);
});
