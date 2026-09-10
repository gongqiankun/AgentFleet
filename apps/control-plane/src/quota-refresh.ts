import type { ControlPlaneDatabase } from "./db.js";

/** Demand-driven, account-coalesced telemetry. No background polling or session scans. */
export class QuotaRefreshService {
  private attempts = new Map<string,{at:number;observedAt:string;failures:number}>();
  constructor(private readonly db:ControlPlaneDatabase,private readonly send:(machineId:string)=>boolean) {}
  request(workspaceId:string,scope:"machine"|"project"|"session",id:string,force=false):boolean {
    const table=scope==="machine"?"machines":scope==="project"?"projects":"logical_sessions";
    const column=scope==="machine"?"machine_id":scope==="project"?"project_id":"logical_session_id";
    const target=this.db.get<{machine_id:string}>(`SELECT machine_id FROM ${table} WHERE workspace_id=? AND ${column}=?`,workspaceId,id);
    if(!target)return false;
    const rows=this.db.all<{machine_id:string;account_key:string|null;observed_at:string|null;agent_version:string;reachability:string}>(`SELECT m.machine_id,m.agent_version,m.reachability,u.account_key,u.observed_at FROM machines m LEFT JOIN machine_usage u USING(machine_id) WHERE m.workspace_id=? AND m.identity_state='active'`,workspaceId);
    const source=rows.find(r=>r.machine_id===target.machine_id);if(!source)return false;
    const peers=rows.filter(r=>source.account_key?r.account_key===source.account_key:r.machine_id===source.machine_id);
    const observedAt=peers.map(r=>r.observed_at??"").sort().at(-1)??"";
    const now=Date.now();
    if(!force&&now-Date.parse(observedAt)<300_000)return false;
    const key=workspaceId+":"+(source.account_key??source.machine_id);
    const previous=this.attempts.get(key);
    const failures=previous&&observedAt<=previous.observedAt?Math.min(previous.failures+1,3):0;
    const cooldown=force?10_000:Math.min(300_000*2**failures,1800_000);
    if(previous&&now-previous.at<cooldown)return false;
    // Only send to agents implementing this telemetry-only frame; older agents keep cached data.
    const candidates=peers.filter(r=>{const [major,minor,patch]=r.agent_version.split(".").map(Number);return r.reachability==="online"&&(major!>0||major===0&&(minor!>30||minor===30&&patch!>=12));});
    for(const candidate of candidates)if(this.send(candidate.machine_id)) {
      for(const [oldKey,value] of this.attempts)if(now-value.at>3600_000)this.attempts.delete(oldKey);
      this.attempts.set(key,{at:now,observedAt,failures});return true;
    }
    return false;
  }
}
