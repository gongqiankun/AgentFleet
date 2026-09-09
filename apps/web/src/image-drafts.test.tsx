// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useImageDraft, isInlineImage } from "./lib/image-drafts";
const png="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
afterEach(()=>{cleanup();localStorage.clear();vi.restoreAllMocks();vi.unstubAllGlobals();});
function Draft({session="a"}:{session?:string}) {const draft=useImageDraft("user",session); return <><textarea aria-label="paste" onPaste={draft.onPaste}/><span>{draft.processing?"processing":"ready"}</span><output>{JSON.stringify(draft.images)}</output><p>{draft.error}</p><button onClick={()=>draft.remove(0)}>remove</button></>;}
function clipboard() {return {items:[{kind:"file",type:"image/png",getAsFile:()=>new File(["fixture"],"clipboard.png",{type:"image/png"})}]};}
function mocks(decode:()=>Promise<void>=async()=>{}) {
  vi.stubGlobal("Image",class {src="";naturalWidth=1;naturalHeight=1;decode=decode;});
  vi.stubGlobal("URL",{createObjectURL:()=>"blob:fixture",revokeObjectURL:vi.fn()});
  vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue({drawImage:()=>{}} as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype,"toBlob").mockImplementation(callback=>callback(new Blob([Uint8Array.from(atob(png.split(",")[1]),c=>c.charCodeAt(0))],{type:"image/png"})));
}
it("pastes raster bytes, persists preview and removes it without changing text paste",async()=>{
  mocks();render(<Draft/>);fireEvent.paste(screen.getByRole("textbox"),{clipboardData:clipboard()});
  await waitFor(()=>expect(screen.getByRole("status").textContent).toContain("data:image/png"));
  expect(localStorage.getItem("agentfleet.images:user:a")).toContain("data:image/png");
  fireEvent.click(screen.getByText("remove"));expect(localStorage.getItem("agentfleet.images:user:a")).toBeNull();
  expect(fireEvent.paste(screen.getByRole("textbox"),{clipboardData:{items:[]}})).toBe(true);
});
it("a paste finishing after switching sessions cannot attach to the new conversation",async()=>{
  let finish!:()=>void;mocks(()=>new Promise(resolve=>{finish=resolve;}));
  const view=render(<Draft/>);fireEvent.paste(screen.getByRole("textbox"),{clipboardData:clipboard()});
  view.rerender(<Draft session="b"/>);finish();
  await waitFor(()=>expect(screen.getByText("ready")).toBeTruthy());
  expect(screen.getByRole("status").textContent).toBe("[]");expect(localStorage.getItem("agentfleet.images:user:b")).toBeNull();
});
it("restored image drafts remain isolated and reject remote URLs or too many images",()=>{
  localStorage.setItem("agentfleet.images:user:a",JSON.stringify([png]));
  const view=render(<Draft/>);expect(screen.getByRole("status").textContent).toContain(png);
  view.rerender(<Draft session="b"/>);expect(screen.getByRole("status").textContent).toBe("[]");
  expect(isInlineImage("https://tracking.test/pixel.png")).toBe(false);
  localStorage.setItem("agentfleet.images:user:b",JSON.stringify(Array(4).fill(png)));view.rerender(<Draft session="b"/>);
  fireEvent.paste(screen.getByRole("textbox"),{clipboardData:clipboard()});expect(screen.getByText(/最多 4 张/)).toBeTruthy();
});
