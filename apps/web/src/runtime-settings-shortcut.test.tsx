// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CodexSettingsPanel, type RuntimeSummary } from "./components/CodexSettingsPanel";
import { RuntimeSettingsShortcut } from "./components/RuntimeSettingsShortcut";
import { api } from "./lib/api";
import type { CodexPreferences } from "./lib/codex-settings";
vi.mock("./lib/api",()=>({api:{codexPreferences:vi.fn(),saveCodexPreferences:vi.fn()}}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
const fixture:CodexPreferences={catalog:{models:[{model:"example-model",displayName:"Example model",efforts:["low","high"],defaultEffort:"low"}],modes:[],fetchedAt:"2026-09-10T00:00:00Z"},preferences:{machine:{settings:{model:"example-model",effort:"low"},revision:1},project:{settings:null,revision:0},session:{settings:null,revision:0}},source:"machine",desired:{model:"example-model",effort:"low"}};
it("shows inherited settings and immediately reflects unsaved reasoning changes and saved overrides",async()=>{
 vi.mocked(api.codexPreferences).mockResolvedValue(fixture);
 vi.mocked(api.saveCodexPreferences).mockResolvedValue({...fixture,source:"session",desired:{model:"example-model",effort:"high"},preferences:{...fixture.preferences,session:{settings:{model:"example-model",effort:"high"},revision:1}}});
 function Harness(){const [summary,setSummary]=useState<RuntimeSummary>();return <><CodexSettingsPanel sessionId="s" onSummary={setSummary}/><RuntimeSettingsShortcut sessionId="s" summary={summary} running={false} onOpen={()=>{}}/></>;}
 render(<Harness/>);await screen.findByText("继承 · example-model · low");
 fireEvent.click(screen.getByText("运行配置"));fireEvent.change(screen.getByRole("combobox",{name:"推理强度"}),{target:{value:"high"}});
 await screen.findByText("本次 · example-model · high");fireEvent.click(screen.getByRole("button",{name:"保存为此会话配置"}));
 await screen.findByText("会话覆盖 · example-model · high");
});
it("opens quick configuration without changing settings and rejects a previous session summary",()=>{
 const open=vi.fn();const summary:RuntimeSummary={sessionId:"a",source:"session",settings:{model:"old-model",effort:"high"},changed:false,loaded:true};
 render(<RuntimeSettingsShortcut sessionId="b" summary={summary} running onOpen={open}/>);
 expect(screen.queryByText(/old-model/)).toBeNull();expect(screen.getByText("当前任务")).toBeTruthy();fireEvent.click(screen.getByRole("button",{name:"快速配置模型与推理强度"}));expect(open).toHaveBeenCalledOnce();
});
it("uses recent native model information for native inheritance and does not invent unknown effort",async()=>{
 render(<RuntimeSettingsShortcut sessionId="s" summary={{sessionId:"s",source:"codex",changed:false,loaded:true}} observed={{observed:{model:"native-model",observedAt:"2026-09-10T00:00:00Z"}}} running={false} onOpen={()=>{}}/>);
 await waitFor(()=>expect(screen.getByText("继承 · native-model · 继承强度")).toBeTruthy());expect(screen.getByRole("button").title).toContain("最近一次主机记录");
});
it("shows unavailable rather than indefinite loading after configuration fetch fails",()=>{
 render(<RuntimeSettingsShortcut sessionId="s" summary={{sessionId:"s",changed:false,loaded:false,failed:true}} running={false} onOpen={()=>{}}/>);
 expect(screen.getByText("模型配置暂不可用")).toBeTruthy();
});

it("separates the active turn receipt from newly selected settings",()=>{
 render(<RuntimeSettingsShortcut sessionId="s" activeTurnId="turn-current" running summary={{sessionId:"s",source:"session",settings:{model:"next-model",effort:"high"},changed:true,loaded:true}} observed={{accepted:{nativeTurnId:"turn-current",acceptedAt:"2026-09-10T00:00:00Z",model:"current-model",effort:"low"}}} onOpen={()=>{}}/>);
 expect(screen.getByText("current-model · low")).toBeTruthy();expect(screen.getByText("本次 · next-model · high")).toBeTruthy();expect(screen.getByText("后续任务")).toBeTruthy();
});
it("does not present a previous turn receipt or unbound observation as the current model",()=>{
 render(<RuntimeSettingsShortcut sessionId="s" activeTurnId="new-turn" running summary={{sessionId:"s",settings:{model:"next-model"},changed:false,loaded:true}} observed={{accepted:{nativeTurnId:"old-turn",acceptedAt:"2026-09-10T00:00:00Z",model:"old-model"},observed:{model:"observed-model",observedAt:"2026-09-10T01:00:00Z"}}} onOpen={()=>{}}/>);
 expect(screen.getByText("未确认")).toBeTruthy();expect(screen.queryByText(/old-model|observed-model/)).toBeNull();
});
it("hides duplicate follow-up settings and switches to send settings when the turn ends",()=>{
 const props={sessionId:"s",activeTurnId:"turn",summary:{sessionId:"s",settings:{model:"same-model",effort:"low"},changed:false,loaded:true},observed:{accepted:{nativeTurnId:"turn",acceptedAt:"2026-09-10T00:00:00Z",model:"same-model",effort:"low"}},onOpen:()=>{}};
 const view=render(<RuntimeSettingsShortcut {...props} running/>);
 expect(screen.queryByText("后续任务")).toBeNull();expect(screen.getByText("当前任务")).toBeTruthy();
 view.rerender(<RuntimeSettingsShortcut {...props} running={false}/>);
 expect(screen.getByText("发送使用")).toBeTruthy();expect(screen.queryByText("当前任务")).toBeNull();
});
