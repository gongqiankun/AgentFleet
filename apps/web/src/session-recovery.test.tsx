// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionRecovery } from "./components/SessionRecovery";
import { api } from "./lib/api";
vi.mock("./lib/api",()=>({api:{hostOperation:vi.fn(),hostOperations:vi.fn(),command:vi.fn()}}));
afterEach(cleanup);beforeEach(()=>vi.clearAllMocks());
it("核验只请求主机持久记录，完成后刷新，原命令绝不重发",async()=>{
 const changed=vi.fn();const operation={id:"probe",type:"session.reconcile" as const,state:"accepted" as const,createdAt:"",updatedAt:""};
 vi.mocked(api.hostOperation).mockResolvedValue(operation);
 vi.mocked(api.hostOperations).mockResolvedValue([{...operation,state:"succeeded"}]);
 render(<SessionRecovery machineId="machine" sessionId="session" online supported onChanged={changed}/>);
 fireEvent.click(screen.getByRole("button",{name:"解除冻结"}));
 await waitFor(()=>expect(changed).toHaveBeenCalledOnce());
 expect(api.hostOperation).toHaveBeenCalledWith("machine","session.reconcile",expect.any(String),"session");
 expect(api.command).not.toHaveBeenCalled();
 expect(screen.getByRole("status").textContent).toContain("正在同步会话状态");
});
it.each([{online:false,supported:true},{online:true,supported:false}])("离线或旧主机不能提交核验请求：%j",props=>{
 render(<SessionRecovery machineId="machine" sessionId="session" {...props} onChanged={()=>{}}/>);
 fireEvent.click(screen.getByRole("button",{name:"解除冻结"}));expect(api.hostOperation).not.toHaveBeenCalled();
});
