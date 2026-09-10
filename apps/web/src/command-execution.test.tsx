// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CommandExecution } from "./components/CommandExecution";
afterEach(cleanup);

it("默认显示预览和换行，流式更新与展开保留同一个日志节点", () => {
 const {rerender}=render(<CommandExecution command="npm run build" output="first"/>);
 const log=screen.getByRole('region',{name:'命令与输出内容'});
 expect(log.hidden).toBe(false);
 expect(screen.getByRole('button',{name:'自动换行'}).getAttribute('aria-pressed')).toBe('true');
 rerender(<CommandExecution command="npm run build" output="next chunk"/>);
 expect(screen.getByRole('region',{name:'命令与输出内容'})).toBe(log);
 expect(log.textContent).toContain('next chunk');
 fireEvent.click(screen.getByRole('button',{name:'展开全部'}));
 expect(log.closest('.command-execution--expanded')).not.toBeNull();
 rerender(<CommandExecution command="npm run build" output="completed"/>);
 expect(screen.getByRole('region',{name:'命令与输出内容'})).toBe(log);
 expect(log.closest('.command-execution--expanded')).not.toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'恢复预览'}));
 expect(log.closest('.command-execution--expanded')).toBeNull();
 expect(log.hidden).toBe(false);
});
it("标题、图标和空白切换完整日志与预览，换行按钮不触发展开",()=>{
 const {container}=render(<CommandExecution command="echo hello" output="hello"/>);
 const title=screen.getByRole('button',{name:'命令执行'});
 fireEvent.click(title.querySelector('svg')!);
 expect(title.getAttribute('aria-expanded')).toBe('true');
 fireEvent.click(screen.getByRole('button',{name:'自动换行'}));
 expect(title.getAttribute('aria-expanded')).toBe('true');
 fireEvent.click(container.querySelector('.command-execution__header')!);
 expect(title.getAttribute('aria-expanded')).toBe('false');
 expect(screen.getByRole('region',{name:'命令与输出内容'}).hidden).toBe(false);
});
it("支持空记录、单独输出、安全高亮及终端转义清理",()=>{
 const {container,rerender}=render(<CommandExecution/>);expect(container.textContent).toBe('');
 rerender(<CommandExecution output="<script>literal</script>"/>);expect(container.querySelector('script')).toBeNull();
 const command='echo "hello" # 注释';rerender(<CommandExecution command={command} output={'\u001b[32mPASS\u001b[0m'}/>);
 expect(container.querySelector('.command-block code')?.textContent).toBe(command);
 expect(container.querySelector('.hljs-string')).not.toBeNull();
 expect(container.querySelector('.output-block')?.textContent).toBe('PASS');
});
