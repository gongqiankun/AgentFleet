import { createHmac } from "node:crypto";
import type { ControlPlaneDatabase } from "./db.js";
import { futureIso, newId, nowIso, randomToken, sha256, verifyEd25519 } from "./crypto.js";
import { invariant } from "./errors.js";

export class CredentialRenewalService {
  constructor(private readonly db: ControlPlaneDatabase) {}

  private credential(machineId: string, agentToken: string) {
    const row=this.db.get<{credential_id:string;public_key_spki:string;workspace_id:string}>(
      `SELECT c.credential_id,m.public_key_spki,m.workspace_id FROM machine_credentials c JOIN machines m ON m.machine_id=c.machine_id
       WHERE c.machine_id=? AND c.token_hash=? AND c.revoked_at IS NULL AND c.expires_at>? AND m.identity_state='active'`,machineId,sha256(agentToken),nowIso());
    invariant(row,401,"AGENT_CREDENTIAL_INVALID","Machine credential is invalid, expired, or revoked");return row;
  }

  challenge(machineId: string, agentToken: string): Record<string, unknown> {
    const credential=this.credential(machineId,agentToken);
    const challengeId=newId("renew");const expiresAt=futureIso(600);
    const message=["AgentFleet credential.renew v1",machineId,credential.credential_id,challengeId,randomToken(32),expiresAt].join("\n");
    this.db.run("INSERT INTO credential_renewal_challenges(challenge_id,machine_id,credential_id,message,expires_at) VALUES(?,?,?,?,?)",challengeId,machineId,credential.credential_id,message,expiresAt);
    return {challengeId,message,expiresAt};
  }

  renew(machineId: string, agentToken: string, challengeId: string, signature: string): Record<string, unknown> {
    return this.db.transaction(()=>{
      const credential=this.credential(machineId,agentToken);
      const challenge=this.db.get<{message:string;expires_at:string;renewed_credential_id:string|null}>("SELECT message,expires_at,renewed_credential_id FROM credential_renewal_challenges WHERE challenge_id=? AND machine_id=? AND credential_id=?",challengeId,machineId,credential.credential_id);
      invariant(challenge&&challenge.expires_at>nowIso(),401,"RENEWAL_CHALLENGE_EXPIRED","Renewal challenge is missing or expired");
      invariant(verifyEd25519(credential.public_key_spki,challenge.message,signature),401,"RENEWAL_PROOF_INVALID","Renewal proof is invalid");
      // Deterministic within a single signed challenge makes lost-response retries safe.
      const renewedToken=createHmac("sha256",agentToken).update(challenge.message).digest("base64url");
      if(challenge.renewed_credential_id) {
        const issued=this.db.get<{expires_at:string;revoked_at:string|null}>("SELECT expires_at,revoked_at FROM machine_credentials WHERE credential_id=?",challenge.renewed_credential_id);
        invariant(issued&&!issued.revoked_at,401,"AGENT_CREDENTIAL_INVALID","Renewed credential was revoked");
        return {machineId,credentialId:challenge.renewed_credential_id,agentToken:renewedToken,credentialExpiresAt:issued.expires_at};
      }
      const credentialId=newId("cred");const credentialExpiresAt=futureIso(90*24*60*60);
      this.db.run("INSERT INTO machine_credentials(credential_id,machine_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)",credentialId,machineId,sha256(renewedToken),nowIso(),credentialExpiresAt);
      this.db.run("UPDATE machine_credentials SET expires_at=MIN(expires_at,?) WHERE credential_id=?",futureIso(24*60*60),credential.credential_id);
      this.db.run("UPDATE credential_renewal_challenges SET renewed_credential_id=?,completed_at=? WHERE challenge_id=?",credentialId,nowIso(),challengeId);
      this.db.audit({workspaceId:credential.workspace_id,machineId,action:"machine.credential.renew",metadata:{credentialId,previousCredentialId:credential.credential_id}});
      return {machineId,credentialId,agentToken:renewedToken,credentialExpiresAt};
    });
  }
}
