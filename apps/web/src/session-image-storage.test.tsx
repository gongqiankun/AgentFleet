// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionImageStorage } from "./components/SessionImageStorage";
const mocks=vi.hoisted(()=>({imageSessions:vi.fn(),imageOperation:vi.fn(),readImageOperation:vi.fn()}));
vi.mock("./lib/api",()=>({api:mocks}));
afterEach(()=>{cleanup();vi.resetAllMocks();});
const row=(i:number)=>({logicalSessionId:`s${i}`,title:`会话${i}`,project:"项目",cloudBytes:100,imageCount:1});
it("跨页全选有图会话，空选不派发；逐会话失败跳过，清理需确认",async()=>{
  mocks.imageSessions.mockImplementation(async (_id:string,cursor:string)=>cursor?{sessions:[row(11)],nextCursor:null}:{sessions:Array.from({length:11},(_,i)=>row(i)),nextCursor:"next"});
  mocks.imageOperation.mockImplementation(async (_id:string,sessionId:string,previewId?:string)=>{
    if(sessionId==="s3")throw new Error("运行中，不能清理");
    return {id:`${previewId?'clean':'preview'}-${sessionId}`,type:previewId?"images.clean":"images.preview",state:"succeeded",result:previewId?{cloudCleaned:true,releasedCloudBytes:100}:{rolloutBytes:2000},createdAt:"",updatedAt:""};
  });
  render(<SessionImageStorage machineId="host"/>);
  await screen.findByText("会话0");
  expect((screen.getByRole("button",{name:"预览所选会话"}) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.imageOperation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"选择全部匹配会话（12）"}));
  fireEvent.click(screen.getByRole("button",{name:"预览所选会话"}));
  await screen.findByRole("button",{name:"清理已通过预览的 11 个会话"});
  expect(mocks.imageOperation).toHaveBeenCalledTimes(12);
  expect(mocks.imageOperation).toHaveBeenCalledWith("host","s11",undefined);
  fireEvent.click(screen.getByRole("button",{name:"清理已通过预览的 11 个会话"}));
  expect(mocks.imageOperation).toHaveBeenCalledTimes(12);
  fireEvent.click(screen.getByRole("button",{name:"确认清理两端图片"}));
  await screen.findAllByText(/两端图片已清理/);
  expect(mocks.imageOperation.mock.calls.filter(c=>c[2])).toHaveLength(11);
  expect(mocks.imageOperation.mock.calls.filter(c=>c[2]).some(c=>c[1]==="s3")).toBe(false);
});
it("失败不会显示已清理，新主机重新加载独立范围",async()=>{
  mocks.imageSessions.mockResolvedValue({sessions:[row(1)],nextCursor:null});
  mocks.imageOperation.mockRejectedValue(new Error("清理结果待核验，不会自动重试"));
  const view=render(<SessionImageStorage key="a" machineId="a"/>);
  await screen.findByText("会话1");fireEvent.click(screen.getByRole("checkbox"));fireEvent.click(screen.getByRole("button",{name:"预览所选会话"}));
  await screen.findByText("清理结果待核验，不会自动重试");expect(screen.queryByText(/两端图片已清理/)).toBeNull();
  view.rerender(<SessionImageStorage key="b" machineId="b"/>);await screen.findByText("会话1");
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  expect(mocks.imageOperation).toHaveBeenCalledTimes(1);
});
