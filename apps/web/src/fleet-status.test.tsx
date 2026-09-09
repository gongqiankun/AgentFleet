// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FleetStatus } from "./components/FleetStatus";
import type { FleetSession, Machine } from "./lib/types";
const state: FleetSession["state"] = {ownership:"agentfleet_owned",threadRuntime:"idle",currentTurn:"none",waitReason:"none",reachability:"live",history:"complete",unknownFreeze:false};
function session(id:string,patch:Partial<FleetSession["state"]>={}):FleetSession {
  return {id,title:`会话 ${id}`,machineId:"host",machineName:"开发主机",projectId:"project",projectAlias:"项目",nativeThreadId:id,historyMode:"legacy",state:{...state,...patch},lastActivityAt:"2026-09-08T00:00:00Z",sessionSeq:1,projectionEpoch:1,contentEpoch:1,executionSegmentId:id,threadControlVersion:1,turnControlVersion:1,projectLeaseVersion:1,controlLeaseVersion:1,queueVersion:0};
}
const host:Machine={id:"host",name:"开发主机",hostname:"host",os:"Linux",arch:"x64",identity:"paired",reachability:"live",capacity:"busy",compatibility:"compatible",agentVersion:"0.28.0",codexVersion:"0.153.4",credentialProtectionLevel:"software_protected",projects:[]};
afterEach(cleanup);
it("列表与数量一致，包含等待回答的运行轮次，排除未接管和离线主机",()=>{
 const onSession=vi.fn(),onMachine=vi.fn();
 render(<FleetStatus machines={[host,{...host,id:"offline",reachability:"unreachable"}]} sessions={[session("running",{currentTurn:"in_progress"}),session("waiting",{currentTurn:"in_progress",waitReason:"user_input"}),session("idle"),session("external",{ownership:"claimable"})]} connected onSession={onSession} onMachine={onMachine}/>);
 fireEvent.click(screen.getByRole("button",{name:"查看运行中的会话（2）"}));
 const dialog=screen.getByRole("dialog");
 expect(dialog.querySelectorAll(".activity-item")).toHaveLength(2);
 expect(within(dialog).getByText("等待回答")).toBeTruthy();
 fireEvent.click(within(dialog).getByRole("button",{name:/已接管\s*3/}));
 expect(dialog.querySelectorAll(".activity-item")).toHaveLength(3);
 expect(within(dialog).queryByText("会话 external")).toBeNull();
 fireEvent.click(within(dialog).getByRole("button",{name:/在线主机\s*1/}));
 expect(dialog.querySelectorAll(".activity-item")).toHaveLength(1);
 fireEvent.click(within(dialog).getByRole("button",{name:/开发主机.*Linux/}));
 expect(onMachine).toHaveBeenCalledWith("host");
 expect(onSession).not.toHaveBeenCalled();
});
it("实时变化更新打开的列表，不留下幽灵运行项；空列表可关闭并恢复键盘焦点",()=>{
 const props={machines:[host],sessions:[session("running",{currentTurn:"in_progress"})],connected:true,onSession:vi.fn(),onMachine:vi.fn()};
 const view=render(<FleetStatus {...props}/>);
 const trigger=screen.getByRole("button",{name:"查看运行中的会话（1）"});
 fireEvent.click(trigger);
 expect(document.activeElement).toBe(screen.getByRole("button",{name:"关闭快捷列表"}));
 (screen.getByRole("dialog").querySelector(".activity-item") as HTMLButtonElement).focus();
 view.rerender(<FleetStatus {...props} sessions={[session("running")]}/>);
 fireEvent.keyDown(document,{key:"Tab"});
 expect(document.activeElement).toBe(screen.getByRole("button",{name:"关闭快捷列表"}));
 expect(screen.getByText("暂无运行中的会话")).toBeTruthy();
 expect(screen.getByRole("dialog").querySelectorAll(".activity-item")).toHaveLength(0);
 fireEvent.keyDown(document,{key:"Escape"});
 expect(screen.queryByRole("dialog")).toBeNull();
 expect(document.activeElement).toBe(trigger);
 expect(document.body.style.overflow).toBe("");
});
it("键盘焦点留在列表内，退出时不触发会话操作",()=>{
 const onSession=vi.fn();
 render(<FleetStatus machines={[]} sessions={[]} connected={false} onSession={onSession} onMachine={vi.fn()}/>);
 fireEvent.click(screen.getByRole("button",{name:"查看已接管的会话（0）"}));
 const dialog=screen.getByRole("dialog");const buttons=within(dialog).getAllByRole("button");
 fireEvent.keyDown(document,{key:"Tab",shiftKey:true});expect(document.activeElement).toBe(buttons.at(-1));
 fireEvent.keyDown(document,{key:"Tab"});expect(document.activeElement).toBe(buttons[0]);
 fireEvent.keyDown(document,{key:"Escape"});expect(onSession).not.toHaveBeenCalled();
});
