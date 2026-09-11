// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownMessage } from "./components/MarkdownMessage";

afterEach(cleanup);

describe("assistant Markdown", () => {
  it("renders headings, nested lists, GFM tables, tasks and links", () => {
    const { container } = render(<MarkdownMessage body={'## 检查结果\n\n**完成** `npm test`\n\n1. 主机\n   - 项目\n\n- [x] 已检查\n\n| 项目 | 状态 |\n| --- | --- |\n| UI | 完成 |\n\n> 引用说明\n\n[文档](https://example.com)'} />);
    expect(screen.getByRole("heading", {name:"检查结果", level:2})).toBeTruthy();
    expect(container.querySelector("ol ul li")?.textContent).toContain("项目");
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole("table").textContent).toContain("UI");
    expect(container.querySelector("blockquote")?.textContent).toContain("引用说明");
    expect(screen.getByRole("link",{name:"文档"}).getAttribute("rel")).toBe("noopener noreferrer");
  });
  it("blocks HTML and unsafe URLs and renders remote images as links", () => {
    const {container}=render(<MarkdownMessage body={'<script>alert(1)</script>\n\n[坏链接](javascript:alert%281%29)\n\n![预览](https://example.com/pixel.png)'} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link",{name:"预览"}).getAttribute("href")).toBe("https://example.com/pixel.png");
  });
  it("supports incomplete streamed code and copies the latest exact text", async () => {
    const writeText=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});
    const view=render(<MarkdownMessage body={'```sh\nprintf "hello"'} />);
    fireEvent.click(screen.getByRole("button",{name:/复制代码|Copy code/}));
    await waitFor(()=>expect(writeText).toHaveBeenCalledWith('printf "hello"\n'));
    view.rerender(<MarkdownMessage body={'```sh\nprintf "hello"\nprintf "world"\n```'} />);
    fireEvent.click(screen.getByRole("button",{name:/复制代码|Copy code/}));
    await waitFor(()=>expect(writeText).toHaveBeenLastCalledWith('printf "hello"\nprintf "world"\n'));
  });
  it("copies the complete assistant reply including prose and code", async () => {
    const writeText=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});
    const body='处理完成。\n\n```sh\nnpm test\n```';
    const view=render(<MarkdownMessage body={body} />);
    fireEvent.click(view.getByRole("button",{name:"复制回复"}));
    await waitFor(()=>expect(writeText).toHaveBeenCalledWith(body));
    expect(view.getByRole("button",{name:"回复已复制"})).toBeTruthy();
  });
});
