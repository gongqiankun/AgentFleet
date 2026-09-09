import { CloudImages } from "./cloud-images.js";
import type { ControlPlaneDatabase } from "./db.js";
import type { Principal } from "./auth.js";
import { invariant } from "./errors.js";
import { futureIso, newId, nowIso } from "./crypto.js";

export const MAINTENANCE_TYPES = ["catalog.refresh", "agent.update", "runtime.reconnect", "diagnostics.collect", "session.reconcile", "commands.reconcile", "images.preview", "images.clean"] as const;
export type MaintenanceType = (typeof MAINTENANCE_TYPES)[number];

export class MaintenanceService {
  constructor(private readonly db: ControlPlaneDatabase) {}

  create(principal: Principal, machineId: string, type: string, mutationId: string, logicalSessionId?: string, previewOperationId?: string): Record<string, unknown> {
    invariant(MAINTENANCE_TYPES.includes(type as MaintenanceType),400,"INVALID_OPERATION","Unsupported machine operation");
    invariant(mutationId.length>=8 && mutationId.length<=200,400,"INVALID_MUTATION_ID","clientMutationId must be between 8 and 200 characters");
    return this.db.transaction(()=>{
      const previous=this.db.get<{operation_id:string;type:string;request_json:string|null}>("SELECT operation_id,type,request_json FROM machine_operations WHERE machine_id=? AND actor_client_session_id=? AND client_mutation_id=?",machineId,principal.clientSessionId,mutationId);
      if(previous) {
        invariant(previous.type===type && (type!=="images.clean" || JSON.parse(previous.request_json??"{}").previewOperationId===previewOperationId) && (previous.request_json ? JSON.parse(previous.request_json).logicalSessionId : undefined) === logicalSessionId,409,"IDEMPOTENCY_KEY_REUSE","clientMutationId belongs to another operation");
        return this.get(principal,previous.operation_id);
      }
      const machine=this.db.get<{identity_state:string;reachability:string;maintenance_types_json:string}>("SELECT identity_state,reachability,maintenance_types_json FROM machines WHERE machine_id=? AND workspace_id=?",machineId,principal.workspaceId);
      invariant(machine,404,"MACHINE_NOT_FOUND","Machine was not found");
      invariant(machine.identity_state==="active",409,"MACHINE_REVOKED","Machine was removed");
      invariant(machine.reachability==="online",409,"MACHINE_OFFLINE","Machine must be online");
      invariant((JSON.parse(machine.maintenance_types_json) as string[]).includes(type),409,"AGENT_CAPABILITY_UNAVAILABLE","Update the connection service to use this operation");
      let target: Record<string,unknown> | null = null;
      if(type === "images.preview" || type === "images.clean") {
        invariant(typeof logicalSessionId === "string",400,"IMAGE_TARGET_REQUIRED","请选择有图会话");
        target=new CloudImages(this.db).target(principal,machineId,logicalSessionId);
        if(type === "images.clean") {
          const preview=this.db.get<{request_json:string;result_json:string;expires_at:string}>("SELECT request_json,result_json,expires_at FROM machine_operations WHERE operation_id=? AND machine_id=? AND workspace_id=? AND type='images.preview' AND state='succeeded'",previewOperationId??"",machineId,principal.workspaceId);
          invariant(preview && Date.parse(preview.expires_at)>Date.now(),409,"IMAGE_PREVIEW_REQUIRED","请先预览，再确认清理");
          const request=JSON.parse(preview.request_json);const result=JSON.parse(preview.result_json);
          invariant(JSON.stringify(request)===JSON.stringify(target) && result.threadId===target.nativeThreadId && Array.isArray(result.targets) && typeof result.beforeSha256==="string",409,"IMAGE_SCOPE_CHANGED","会话图片已变化，请重新预览");
          target={...target,expectedDigest:result.beforeSha256,turns:result.targets,previewOperationId};
        }
      } else if(type === "session.reconcile") {
        invariant(typeof logicalSessionId === "string",400,"RECOVERY_TARGET_REQUIRED","Choose a session to recover");
        const session=this.db.get<{logical_session_id:string;content_epoch:number;execution_segment_id:string;native_thread_id:string|null}>(`SELECT s.logical_session_id,s.content_epoch,e.execution_segment_id,e.native_thread_id FROM logical_sessions s JOIN execution_segments e ON e.logical_session_id=s.logical_session_id AND e.ended_at IS NULL WHERE s.logical_session_id=? AND s.machine_id=? AND s.workspace_id=?`,logicalSessionId,machineId,principal.workspaceId);
        invariant(session?.native_thread_id,404,"SESSION_NOT_FOUND","Session was not found on this host");
        invariant(!this.db.get("SELECT 1 FROM commands c JOIN command_projection p USING(command_id) WHERE c.logical_session_id=? AND p.state IN ('unknown','accepted','dispatching') LIMIT 1",logicalSessionId),409,"RECOVERY_RECEIPT_UNKNOWN","仍有结果待确认的操作，请先核验原操作回执");
        const connection = this.db.get<{app_server_epoch:string}>("SELECT app_server_epoch FROM agent_connections WHERE machine_id=? AND disconnected_at IS NULL AND app_server_epoch IS NOT NULL ORDER BY transport_generation DESC LIMIT 1",machineId);
        invariant(connection,409,"MACHINE_RECONNECTING","Wait for the host to finish reconnecting");
        target={appServerEpoch:connection.app_server_epoch,logicalSessionId:session.logical_session_id,contentEpoch:session.content_epoch,executionSegmentId:session.execution_segment_id,nativeThreadId:session.native_thread_id};
      } else invariant(logicalSessionId === undefined,400,"INVALID_OPERATION_TARGET","This operation does not accept a session target");
      const timestamp=nowIso();const operationId=newId("op");
      this.db.run("INSERT INTO machine_operations(operation_id,machine_id,workspace_id,actor_client_session_id,client_mutation_id,type,state,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,'accepted',?,?,?)",operationId,machineId,principal.workspaceId,principal.clientSessionId,mutationId,type,timestamp,timestamp,futureIso(["session.reconcile","images.preview","images.clean"].includes(type) ? 300 : 3600));
      if(target) this.db.run("UPDATE machine_operations SET request_json=? WHERE operation_id=?",JSON.stringify(target),operationId);
      this.db.audit({workspaceId:principal.workspaceId,actorUserId:principal.userId,actorClientSessionId:principal.clientSessionId,machineId,action:"machine.operation.request",metadata:{operationId,type}});
      return this.get(principal,operationId);
    });
  }

  get(principal: Principal, operationId: string): Record<string, unknown> {
    this.expire();
    const row=this.db.get<{operation_id:string;machine_id:string;type:string;state:string;result_json:string|null;error_json:string|null;created_at:string;updated_at:string;expires_at:string}>("SELECT * FROM machine_operations WHERE operation_id=? AND workspace_id=?",operationId,principal.workspaceId);
    invariant(row,404,"OPERATION_NOT_FOUND","Operation was not found");
    return {operationId:row.operation_id,machineId:row.machine_id,type:row.type,state:row.state,result:row.result_json?JSON.parse(row.result_json):null,error:row.error_json?JSON.parse(row.error_json):null,createdAt:row.created_at,updatedAt:row.updated_at,expiresAt:row.expires_at};
  }

  list(principal: Principal, machineId: string): Record<string, unknown>[] {
    invariant(this.db.get("SELECT 1 FROM machines WHERE machine_id=? AND workspace_id=?",machineId,principal.workspaceId),404,"MACHINE_NOT_FOUND","Machine was not found");
    return this.db.all<{operation_id:string}>("SELECT operation_id FROM machine_operations WHERE machine_id=? ORDER BY created_at DESC LIMIT 100",machineId).map(row=>this.get(principal,row.operation_id));
  }

  offers(machineId: string): Record<string, unknown>[] {
    this.expire();
    const machine=this.db.get<{maintenance_types_json:string}>("SELECT maintenance_types_json FROM machines WHERE machine_id=? AND identity_state='active'",machineId);
    const supported:string[]=machine?JSON.parse(machine.maintenance_types_json):[];
    return this.db.all<{operation_id:string;type:string;expires_at:string;request_json:string|null}>("SELECT operation_id,type,expires_at,request_json FROM machine_operations WHERE machine_id=? AND state IN ('accepted','running') AND expires_at>? ORDER BY created_at LIMIT 25",machineId,nowIso())
      .filter(row=>supported.includes(row.type))
      .map(row=>({type:"maintenance.offer",operationId:row.operation_id,operationType:row.type,expiresAt:row.expires_at,...(row.request_json ? {recoveryTarget:JSON.parse(row.request_json)} : {}),
        ...(row.type === "commands.reconcile" ? {commands:this.db.all<{command_id:string}>(
          `SELECT c.command_id FROM commands c JOIN command_projection p ON p.command_id=c.command_id JOIN logical_sessions s ON s.logical_session_id=c.logical_session_id
           WHERE s.machine_id=? AND p.state='unknown' ORDER BY c.created_at LIMIT 20`,machineId).map(c=>c.command_id)} : {})}));
  }

  private expire(): void {
    const timestamp=nowIso();
    this.db.run(`UPDATE machine_operations SET state=CASE WHEN state='accepted' THEN 'expired' ELSE 'unknown' END,
      error_json=?,updated_at=? WHERE state IN ('accepted','running') AND expires_at<=?`,
      JSON.stringify({code:"OPERATION_EXPIRED",message:"操作有效期已过；未执行的操作不会在重连后自动运行"}),timestamp,timestamp);
  }

  result(machineId: string, operationId: string, state: string, result: unknown, error: unknown): void {
    this.expire();
    invariant(["running","succeeded","failed"].includes(state),400,"INVALID_OPERATION_STATE","Invalid machine operation state");
    const row=this.db.get<{state:string;workspace_id:string;type:string;request_json:string|null}>("SELECT state,workspace_id,type,request_json FROM machine_operations WHERE operation_id=? AND machine_id=?",operationId,machineId);
    invariant(row,404,"OPERATION_NOT_FOUND","Operation does not belong to this machine");
    invariant(row.state!=="expired",409,"OPERATION_EXPIRED","Operation expired before execution");
    if(row.state==="unknown" && state==="running") return;
    if(["succeeded","failed"].includes(row.state)) {
      invariant(row.state===state,409,"OPERATION_ALREADY_TERMINAL","Operation already completed with a different outcome");return;
    }
    const resultJson=result===undefined?null:JSON.stringify(result);
    invariant(resultJson===null||Buffer.byteLength(resultJson)<=32_000,400,"OPERATION_RESULT_TOO_LARGE","Operation result exceeds limit");
    let safeError: {code:string;message:string}|null=null;
    if(error!==undefined&&error!==null) {
      invariant(typeof error==="object"&&!Array.isArray(error),400,"INVALID_OPERATION_ERROR","error must be an object");
      const value=error as Record<string,unknown>;
      safeError={code:typeof value.code==="string"?value.code.slice(0,100):"OPERATION_FAILED",message:typeof value.message==="string"?value.message.slice(0,2000):"主机操作失败"};
    }
    this.db.transaction(() => {
      let persistedResult=resultJson;
      if(row.type === "images.clean" && state === "succeeded" && row.request_json && result && typeof result === "object") {
        persistedResult=JSON.stringify(new CloudImages(this.db).complete(machineId,JSON.parse(row.request_json),result as Record<string,unknown>));
      }
      if (row.type === "session.reconcile" && state === "succeeded" && row.request_json && result && typeof result === "object") {
        const proof=result as Record<string,unknown>; const target=JSON.parse(row.request_json);
        if (proof.recovered === true) {
          const session=this.db.get<{project_id:string;active_turn_id:string|null}>(`SELECT s.project_id,s.active_turn_id FROM logical_sessions s JOIN execution_segments e ON e.logical_session_id=s.logical_session_id AND e.ended_at IS NULL JOIN agent_connections a ON a.machine_id=s.machine_id AND a.disconnected_at IS NULL WHERE s.logical_session_id=? AND s.machine_id=? AND s.workspace_id=? AND s.content_epoch=? AND e.execution_segment_id=? AND e.native_thread_id=? AND a.app_server_epoch=?`,target.logicalSessionId,machineId,row.workspace_id,target.contentEpoch,target.executionSegmentId,target.nativeThreadId,target.appServerEpoch);
          const pending=this.db.get("SELECT 1 FROM commands c JOIN command_projection p USING(command_id) WHERE c.logical_session_id=? AND p.state IN ('unknown','accepted','dispatching') LIMIT 1",target.logicalSessionId);
          const reservation=session?this.db.get<{logical_session_id:string;native_turn_id:string|null;bound_app_server_epoch:string|null;binding_state:string}>("SELECT logical_session_id,native_turn_id,bound_app_server_epoch,binding_state FROM project_turn_reservations WHERE project_id=?",session.project_id):undefined;
          const valid = session && !pending && proof.nativeThreadId === target.nativeThreadId && typeof proof.nativeTurnId === "string" && ["completed","failed","interrupted"].includes(String(proof.status)) && (!session.active_turn_id || session.active_turn_id === proof.nativeTurnId) && (!reservation || (reservation.logical_session_id === target.logicalSessionId && reservation.native_turn_id === proof.nativeTurnId && reservation.binding_state === "bound" && reservation.bound_app_server_epoch === proof.previousAppServerEpoch));
          if (valid) {
            this.db.run("DELETE FROM project_turn_reservations WHERE project_id=? AND logical_session_id=? AND native_turn_id=?",session.project_id,target.logicalSessionId,proof.nativeTurnId as string);
            this.db.run("UPDATE logical_sessions SET execution_state=?,active_turn_id=NULL,turn_control_version=turn_control_version+1,updated_at=? WHERE logical_session_id=?",String(proof.status),nowIso(),target.logicalSessionId);
            this.db.audit({workspaceId:row.workspace_id,machineId,logicalSessionId:target.logicalSessionId,action:"session.manually_recovered",outcome:String(proof.status),metadata:{operationId,nativeTurnId:proof.nativeTurnId,source:"native_turn_history"}});
          } else persistedResult=JSON.stringify({...proof,recovered:false,reason:"会话状态已变化或仍有未确认操作，继续保持冻结，请刷新后核验"});
        }
      }
      this.db.run("UPDATE machine_operations SET state=?,result_json=?,error_json=?,updated_at=? WHERE operation_id=?",state,persistedResult,safeError?JSON.stringify(safeError):null,nowIso(),operationId);
      this.db.audit({workspaceId:row.workspace_id,machineId,action:"machine.operation.result",outcome:state,metadata:{operationId}});
    });
  }
}
