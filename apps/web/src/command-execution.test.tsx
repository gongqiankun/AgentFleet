// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CommandExecution } from "./components/CommandExecution";

afterEach(cleanup);
it("默认收起，流式更新不自动展开，手动展开后保留选择，重新打开默认收起", () => {
  const { rerender } = render(<CommandExecution command="npm run build" output="first" />);
  const toggle = screen.getByRole("button", { name: "展开代码" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("region", { name: "命令与输出内容" })).toBeNull();
  expect(screen.queryByRole("button", { name: "放大输出" })).toBeNull();
  rerender(<CommandExecution command="npm run build" output="next chunk" />);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  toggle.focus(); fireEvent.click(toggle);
  const log = screen.getByRole("region", { name: "命令与输出内容" });
  expect(toggle.getAttribute("aria-controls")).toBe(log.id);
  expect(document.activeElement).toBe(toggle);
  expect(log.textContent).toContain("next chunk");
  rerender(<CommandExecution command="npm run build" output="completed" />);
  expect(screen.getByRole("region", { name: "命令与输出内容" })).toBe(log);
  fireEvent.click(screen.getByRole("button", { name: "收起代码" }));
  expect(log.hidden).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "展开代码" }));
  expect(screen.getByRole("region", { name: "命令与输出内容" })).toBe(log);
  rerender(<CommandExecution key="another-session" command="git status" />);
  expect(screen.queryByRole("region", { name: "命令与输出内容" })).toBeNull();
});
it("原位放大执行输出，恢复高度时不替换日志或重置滚动", () => {
  const { rerender } = render(<CommandExecution command="npm run build" output="first output" />);
  fireEvent.click(screen.getByRole("button", { name: "展开代码" }));
  const log = screen.getByRole("region", { name: "命令与输出内容" });
  log.scrollTop = 45;
  const toggle = screen.getByRole("button", { name: "放大输出" });
  toggle.focus(); fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.getAttribute("aria-controls")).toBe(log.id);
  expect(document.activeElement).toBe(toggle);
  expect(log.closest(".command-execution--expanded")).not.toBeNull();
  rerender(<CommandExecution command="npm run build" output={"first output\nnext chunk"} />);
  expect(screen.getByRole("region", { name: "命令与输出内容" })).toBe(log);
  expect(log.textContent).toContain("next chunk");
  expect(log.scrollTop).toBe(45);
  fireEvent.click(screen.getByRole("button", { name: "恢复高度" }));
  expect(log.closest(".command-execution--expanded")).toBeNull();
});
it("支持仅命令、仅输出和空记录，文本不作为 HTML 执行", () => {
  const { rerender, container } = render(<CommandExecution />);
  expect(container.textContent).toBe("");
  rerender(<CommandExecution output="<script>fake()</script>" />);
  expect(screen.getByText("执行输出")).toBeTruthy();
  expect(container.querySelector("script")).toBeNull();
  rerender(<CommandExecution command="git status" />);
  expect(screen.getByText("命令执行")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "展开代码" }));
  expect(screen.getByRole("region", { name: "命令与输出内容" }).textContent).toContain("git status");
});
