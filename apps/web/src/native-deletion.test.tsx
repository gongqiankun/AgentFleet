// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeSessionDeletion } from "./components/NativeSessionDeletion";
import { api } from "./lib/api";
import type { CommandReceipt, FleetSession } from "./lib/types";

vi.mock("./lib/api",()=>({api:{command:vi.fn()}}));
beforeEach(()=>vi.clearAllMocks());
afterEach(()=>{cleanup();vi.useRealTimers();});
const session={id:"session",nativeThreadId:"root",machineName:"Host",projectAlias:"Project",title:"Title",actions:{deletePreview:{allowed:true},delete:{allowed:true}}} as FleetSession;
const receipt=(expiresAt=new Date(Date.now()+300000).toISOString())=>({id:"preview",type:"thread.delete.preview",state:"applied",outcome:"succeeded",deletionPreview:{nativeThreadId:"root",fingerprint:"scope",expiresAt,threads:[{id:"root",title:"Root",cwd:"/project"},{id:"child",title:"Child",cwd:"/project"}]}} as CommandReceipt);

it("opening and previewing never delete; exact displayed scope requires an explicit check and click",async()=>{
 const onChanged=vi.fn();vi.mocked(api.command).mockResolvedValue({command:{id:"preview"} as CommandReceipt});
 const view=render(<NativeSessionDeletion session={session} commands={[]} pending={false} onChanged={onChanged}/>);
 expect(api.command).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"删除会话"}));
 fireEvent.click(screen.getByRole("button",{name:"读取主机删除范围"}));
 await waitFor(()=>expect(onChanged).toHaveBeenCalledOnce());
 expect(api.command).toHaveBeenCalledWith("session",expect.objectContaining({type:"thread.delete.preview",payload:{}}));
 view.rerender(<NativeSessionDeletion session={session} commands={[receipt()]} pending={false} onChanged={onChanged}/>);
 const confirm=screen.getByRole("button",{name:"确认永久删除",hidden:true});
 expect((confirm as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(confirm);expect(api.command).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole("checkbox",{hidden:true}));fireEvent.click(confirm);
 await waitFor(()=>expect(api.command).toHaveBeenCalledTimes(2));
 expect(api.command).toHaveBeenLastCalledWith("session",expect.objectContaining({type:"thread.delete",payload:{previewCommandId:"preview",fingerprint:"scope"}}));
});

it("an expired preview disables confirmation and cannot submit deletion",async()=>{
 vi.mocked(api.command).mockResolvedValue({command:{id:"preview"} as CommandReceipt});
 const view=render(<NativeSessionDeletion session={session} commands={[]} pending={false} onChanged={()=>{}}/>);
 fireEvent.click(screen.getByRole("button",{name:"删除会话"}));
 fireEvent.click(screen.getByRole("button",{name:"读取主机删除范围"}));
 await waitFor(()=>expect(api.command).toHaveBeenCalledOnce());
 vi.useFakeTimers();const plan=receipt(new Date(Date.now()+1000).toISOString());
 view.rerender(<NativeSessionDeletion session={session} commands={[plan]} pending={false} onChanged={()=>{}}/>);
 fireEvent.click(screen.getByRole("checkbox",{hidden:true}));
 act(()=>vi.advanceTimersByTime(1100));
 const confirm=screen.getByRole("button",{name:"确认永久删除",hidden:true});
 expect((confirm as HTMLButtonElement).disabled).toBe(true);fireEvent.click(confirm);
 expect(api.command).toHaveBeenCalledTimes(1);
});

it.each([true,false])("pending work and unsupported hosts block preview: %s",pending=>{
 render(<NativeSessionDeletion session={{...session,actions:pending?session.actions:{}}} commands={[]} pending={pending} onChanged={()=>{}}/>);
 fireEvent.click(screen.getByRole("button",{name:"删除会话"}));
 fireEvent.click(screen.getByRole("button",{name:"读取主机删除范围"}));
 expect(api.command).not.toHaveBeenCalled();
});
