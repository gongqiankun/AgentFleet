// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UsageButton } from "./components/UsageButton";
import { api } from "./lib/api";
import type { UsageSummary } from "./lib/usage";
import { setLocale } from "./i18n";
vi.mock("./lib/api",()=>({api:{usage:vi.fn()}}));
const counts={inputTokens:800,outputTokens:200,cachedInputTokens:300,reasoningOutputTokens:100,totalTokens:1000};
const data:UsageSummary={scope:"project",recorded:counts,recentSevenDaysTokens:1000,observedSessions:1,totalSessions:3,firstObservedAt:"2026-09-10T00:00:00Z",lastObservedAt:"2026-09-10T00:00:00Z",coverage:"observed-only",discontinuities:0,last:null,nativeTotal:null,modelContextWindow:null,topProjects:[],topSessions:[{id:"s1",title:"Example task",totalTokens:1000}],accounts:[{sourceMachine:"Demo host",identityKnown:true,observedAt:new Date().toISOString(),stale:false,windows:[{bucket:"codex",window:"secondary",windowMinutes:10080,usedPercent:62,remainingPercent:38,resetsAt:1900000000}]}]};
beforeEach(()=>{
 setLocale("zh-CN");
 if(!HTMLDialogElement.prototype.showModal)Object.defineProperty(HTMLDialogElement.prototype,"showModal",{configurable:true,writable:true,value:function(){}});
 if(!HTMLDialogElement.prototype.close)Object.defineProperty(HTMLDialogElement.prototype,"close",{configurable:true,writable:true,value:function(){}});
 vi.spyOn(HTMLDialogElement.prototype,"showModal").mockImplementation(function(this:HTMLDialogElement){this.setAttribute("open","");});
 vi.spyOn(HTMLDialogElement.prototype,"close").mockImplementation(function(this:HTMLDialogElement){this.removeAttribute("open");});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.resetAllMocks();});
it("separates shared remaining quota from measured project tokens and opens the consuming session",async()=>{
 vi.mocked(api.usage).mockResolvedValue(data);const select=vi.fn();render(<UsageButton scope="project" id="p1" onSession={select}/>);
 fireEvent.click(await screen.findByRole("button",{name:/已记录/}));
 expect(await screen.findByRole("dialog",{name:"用量与剩余额度"})).toBeTruthy();
 expect(screen.getByText("已用 62% · 剩余 38%")).toBeTruthy();expect(screen.getByText("已获取 1 / 3 个会话")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Example task"}));expect(select).toHaveBeenCalledWith("s1");
});
it("does not turn missing telemetry into zero or retain another scope's result",async()=>{
 vi.mocked(api.usage).mockResolvedValueOnce(data).mockResolvedValue({...data,recorded:null,accounts:[],topSessions:[]});
 const view=render(<UsageButton scope="project" id="p1"/>);await screen.findByRole("button",{name:/已记录/});
 view.rerender(<UsageButton scope="session" id="s2"/>);await waitFor(()=>expect(screen.queryByRole("button",{name:/已记录/})).toBeNull());
 fireEvent.click(screen.getByRole("button",{name:"用量未上报"}));expect(await screen.findByText(/未获取不代表零消耗/)).toBeTruthy();expect(screen.queryByText("已用 62% · 剩余 38%")).toBeNull();
});
it("labels stale account snapshots and English UI explicitly",async()=>{
 setLocale("en");vi.mocked(api.usage).mockResolvedValue({...data,scope:"machine",accounts:[{...data.accounts[0],stale:true}]});
 render(<UsageButton scope="machine" id="m1"/>);fireEvent.click(await screen.findByRole("button",{name:"Weekly quota: 38% remaining"}));
 expect(await screen.findByText(/Out of date/)).toBeTruthy();expect(screen.getByText("Account quota (shared)")).toBeTruthy();
});

it("keeps quota discoverable with multiple model windows and no session token reports",async()=>{
 const account={...data.accounts[0],windows:[data.accounts[0].windows[0],{...data.accounts[0].windows[0],bucket:"model-specific",usedPercent:0,remainingPercent:100}]};
 vi.mocked(api.usage).mockResolvedValue({...data,scope:"machine",recorded:null,accounts:[account]});
 render(<UsageButton scope="machine" id="m1"/>);
 expect(await screen.findByRole("button",{name:"周额度剩余 38%"})).toBeTruthy();
});
