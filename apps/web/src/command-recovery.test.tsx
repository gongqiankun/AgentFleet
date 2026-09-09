// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommandRecovery } from "./components/CommandRecovery";
import { api } from "./lib/api";
vi.mock("./lib/api",()=>({api:{hostOperation:vi.fn(),hostOperations:vi.fn(),command:vi.fn()}}));
afterEach(cleanup);beforeEach(()=>vi.clearAllMocks());
it("核验只请求主机持久记录，完成后刷新，原命令绝不重发",async()=>{
 const changed=vi.fn();const operation={id:"probe",type:"commands.reconcile" as const,state:"accepted" as const,createdAt:"",updatedAt:""};
 vi.mocked(api.hostOperation).mockResolvedValue(operation);
 vi.mocked(api.hostOperations).mockResolvedValue([{...operation,state:"succeeded"}]);
 render(<CommandRecovery machineId="machine" online supported onChanged={changed}/>);
 fireEvent.click(screen.getByRole("button",{name:"核验主机回执"}));
 await waitFor(()=>expect(changed).toHaveBeenCalledOnce());
 expect(api.hostOperation).toHaveBeenCalledWith("machine","commands.reconcile",expect.any(String));
 expect(api.command).not.toHaveBeenCalled();
 expect(screen.getByRole("status").textContent).toContain("缺少明确证据");
});
it.each([{online:false,supported:true},{online:true,supported:false}])("离线或旧主机不能提交核验请求：%j",props=>{
 render(<CommandRecovery machineId="machine" {...props} onChanged={()=>{}}/>);
 fireEvent.click(screen.getByRole("button",{name:"核验主机回执"}));expect(api.hostOperation).not.toHaveBeenCalled();
});
