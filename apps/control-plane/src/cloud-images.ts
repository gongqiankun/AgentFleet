import { createHash } from "node:crypto";
import type { ControlPlaneDatabase } from "./db.js";
import type { Principal } from "./auth.js";
import { invariant } from "./errors.js";
import { validImageUrl } from "./images.js";

export const CLOUD_IMAGE_QUOTA = 50_000_000; // 50 decimal MB, encoded image content, per machine.
const PREFIX = "agentfleet-image:";
const MISSING = "[云端图片已清理或未保存；宿主机原生图片不受影响]";
type Owner = "command" | "event";

/** Image bytes live only here; command/history JSON keeps bounded, owner-bound references. */
export class CloudImages {
  constructor(private readonly db: ControlPlaneDatabase) {}

  stats(machineId: string, principal?: Principal) {
    const machine = this.db.get<{ workspace_id: string; cloud_image_revision: number }>("SELECT workspace_id,cloud_image_revision FROM machines WHERE machine_id=?", machineId);
    invariant(machine && (!principal || machine.workspace_id === principal.workspaceId), 404, "MACHINE_NOT_FOUND", "主机不存在");
    const usage = this.db.get<{ usedBytes: number; imageCount: number }>("SELECT coalesce(sum(size_bytes),0) AS usedBytes,count(*) AS imageCount FROM cloud_images WHERE machine_id=? AND data_url IS NOT NULL", machineId)!;
    const pending = this.db.get<{ count: number }>(`SELECT count(DISTINCT r.owner_id) AS count FROM cloud_image_refs r JOIN command_projection p ON p.command_id=r.owner_id
      WHERE r.machine_id=? AND r.owner_type='command' AND p.state IN ('queued','accepted','dispatching','unknown')`, machineId)!.count;
    return { machineId, ...usage, quotaBytes: CLOUD_IMAGE_QUOTA, revision: machine.cloud_image_revision,
      level: usage.usedBytes >= CLOUD_IMAGE_QUOTA ? "full" : usage.usedBytes >= CLOUD_IMAGE_QUOTA * .8 ? "warning" : "normal",
      pendingImageCommands: pending, canClear: pending === 0 && usage.imageCount > 0 };
  }

  store(machineId: string, ownerType: Owner, ownerId: string, value: unknown, mode: "command" | "sync" | "migration", scope?: {logicalSessionId?: string | undefined; nativeThreadId?: string | undefined; nativeTurnId?: string | undefined}): unknown {
    const image = (url: unknown): unknown => {
      if (!validImageUrl(url)) return url;
      const hash = createHash("sha256").update(url).digest("hex");
      if (scope?.logicalSessionId && scope.nativeThreadId && scope.nativeTurnId && this.db.get("SELECT 1 FROM image_cleaned_turns WHERE machine_id=? AND logical_session_id=? AND native_thread_id=? AND native_turn_id=? AND image_hash=?", machineId, scope.logicalSessionId, scope.nativeThreadId, scope.nativeTurnId, hash)) return "[图片已按会话清理，文字保留]";
      if (mode === "command") this.db.run(`INSERT OR IGNORE INTO image_uploads(machine_id,logical_session_id,execution_segment_id,command_id,image_hash)
        SELECT ?,logical_session_id,execution_segment_id,command_id,? FROM commands WHERE command_id=?`, machineId, hash, ownerId);
      const row = this.db.get<{ data_url: string | null }>("SELECT data_url FROM cloud_images WHERE machine_id=? AND image_hash=?", machineId, hash);
      if (row?.data_url === null) {
        invariant(mode !== "command", 409, "CLOUD_IMAGE_CLEARED", "这张图片的云端副本已清理，不能从历史恢复；请重新截取需要的区域后发送");
        return MISSING;
      }
      if (!row) {
        const size = Buffer.byteLength(url);
        const usage = this.db.get<{ bytes: number }>("SELECT coalesce(sum(size_bytes),0) AS bytes FROM cloud_images WHERE machine_id=? AND data_url IS NOT NULL", machineId)!.bytes;
        if (mode !== "migration" && usage + size > CLOUD_IMAGE_QUOTA) {
          invariant(mode !== "command", 409, "CLOUD_IMAGE_QUOTA_EXCEEDED", "这台主机的云端图片空间不足（上限 50 MB），请在主机页清理云端图片后重试；文字消息不受影响");
          return "[云端图片空间已满，图片未同步；请在主机页清理云端图片，宿主机原图保留]";
        }
        this.db.run("INSERT INTO cloud_images(machine_id,image_hash,data_url,size_bytes,created_at) VALUES(?,?,?,?,?)", machineId, hash, url, size, new Date().toISOString());
        this.db.run("UPDATE machines SET cloud_image_revision=cloud_image_revision+1 WHERE machine_id=?", machineId);
      }
      this.db.run("INSERT OR IGNORE INTO cloud_image_refs(owner_type,owner_id,machine_id,image_hash) VALUES(?,?,?,?)", ownerType, ownerId, machineId, hash);
      return PREFIX + hash;
    };
    return this.walk(value, image);
  }

  hydrate(machineId: string, ownerType: Owner, ownerId: string, value: unknown): unknown {
    return this.walk(value, url => {
      if (typeof url !== "string" || !url.startsWith(PREFIX)) return url;
      const hash=url.slice(PREFIX.length);
      const cleaned=ownerType === "command" ? this.db.get("SELECT 1 FROM image_uploads WHERE machine_id=? AND command_id=? AND image_hash=? AND cleaned_at IS NOT NULL",machineId,ownerId,hash)
        : this.db.get(`SELECT 1 FROM durable_events e JOIN image_cleaned_turns t ON t.machine_id=e.machine_id AND t.logical_session_id=e.logical_session_id AND t.native_thread_id=e.native_thread_id AND t.native_turn_id=e.native_turn_id WHERE e.payload_ref=? AND e.machine_id=? AND t.image_hash=?`,ownerId,machineId,hash);
      if(cleaned) return "[图片已按会话清理，文字保留]";
      return this.db.get<{ data_url: string | null }>(`SELECT i.data_url FROM cloud_images i JOIN cloud_image_refs r
        ON r.machine_id=i.machine_id AND r.image_hash=i.image_hash
        WHERE r.owner_type=? AND r.owner_id=? AND i.machine_id=? AND i.image_hash=?`, ownerType, ownerId, machineId, url.slice(PREFIX.length))?.data_url ?? MISSING;
    }, true);
  }

  private walk(value: unknown, image: (url: unknown) => unknown, display = false): unknown {
    if (Array.isArray(value)) return value.map(entry => this.walk(entry, image, display));
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    if (object.type === "image" && typeof object.url === "string") {
      const url = image(object.url);
      if (typeof url === "string" && url.startsWith("[")) return { type: "text", text: url };
      return { ...object, url };
    }
    return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key,
      key === "images" && Array.isArray(entry) ? entry.map(image) : this.walk(entry, image, display)]));
  }

  clear(principal: Principal, machineId: string, input: Record<string, unknown>) {
    return this.db.transaction(() => {
      const before = this.stats(machineId, principal);
      invariant(input.confirmCloudOnly === true, 400, "IMAGE_CLEAR_CONFIRM_REQUIRED", "请确认仅清理云端图片，保留宿主机原图");
      invariant(input.revision === before.revision, 409, "IMAGE_USAGE_CHANGED", "图片用量已变化，请刷新后重新确认清理");
      invariant(before.pendingImageCommands === 0, 409, "IMAGE_COMMAND_PENDING", "仍有图片消息正在排队、传输或等待结果核验，请完成后再清理");
      this.db.run("UPDATE cloud_images SET data_url=NULL,size_bytes=0,deleted_at=? WHERE machine_id=? AND data_url IS NOT NULL", new Date().toISOString(), machineId);
      this.db.run("UPDATE machines SET cloud_image_revision=cloud_image_revision+1 WHERE machine_id=?", machineId);
      this.db.audit({ workspaceId: principal.workspaceId, actorUserId: principal.userId, actorClientSessionId: principal.clientSessionId, machineId,
        action: "images.clear_cloud", metadata: { deletedImages: before.imageCount, releasedBytes: before.usedBytes, nativeHistoryChanged: false } });
      return { ...this.stats(machineId, principal), deletedImages: before.imageCount, releasedBytes: before.usedBytes, nativeHistoryChanged: false };
    });
  }

  sessions(principal: Principal, machineId: string, after = "") {
    this.stats(machineId, principal);
    const rows = this.db.all<{logicalSessionId:string;title:string;project:string;cloudBytes:number;imageCount:number}>(`
      WITH refs AS (
        SELECT c.logical_session_id,r.image_hash FROM cloud_image_refs r JOIN commands c ON r.owner_type='command' AND c.command_id=r.owner_id WHERE r.machine_id=?
        UNION SELECT e.logical_session_id,r.image_hash FROM cloud_image_refs r JOIN durable_events e ON r.owner_type='event' AND e.payload_ref=r.owner_id WHERE r.machine_id=?
        UNION SELECT logical_session_id,image_hash FROM image_uploads WHERE machine_id=? AND cleaned_at IS NULL
      ) SELECT s.logical_session_id AS logicalSessionId,s.title,p.alias AS project,
        coalesce(sum(i.size_bytes),0) AS cloudBytes,count(*) AS imageCount
      FROM refs r JOIN logical_sessions s ON s.logical_session_id=r.logical_session_id JOIN projects p USING(project_id)
      LEFT JOIN cloud_images i ON i.machine_id=s.machine_id AND i.image_hash=r.image_hash
      WHERE s.machine_id=? AND s.deleted_at IS NULL AND s.logical_session_id>?
      GROUP BY s.logical_session_id ORDER BY s.logical_session_id LIMIT 51`, machineId,machineId,machineId,machineId,after);
    return { sessions: rows.slice(0,50), nextCursor: rows.length>50 ? rows[49]!.logicalSessionId : null };
  }

  target(principal: Principal, machineId: string, logicalSessionId: string) {
    this.stats(machineId, principal);
    const session=this.db.get<{contentEpoch:number;executionSegmentId:string;nativeThreadId:string}>(`SELECT s.content_epoch AS contentEpoch,e.execution_segment_id AS executionSegmentId,e.native_thread_id AS nativeThreadId
      FROM logical_sessions s JOIN execution_segments e ON e.logical_session_id=s.logical_session_id AND e.ended_at IS NULL
      WHERE s.logical_session_id=? AND s.machine_id=? AND s.deleted_at IS NULL`,logicalSessionId,machineId);
    invariant(session?.nativeThreadId,409,"IMAGE_TARGET_INVALID","会话尚未绑定原生历史");
    invariant(!this.db.get(`SELECT 1 FROM commands c JOIN command_projection p USING(command_id) WHERE c.logical_session_id=? AND p.state IN ('queued','accepted','dispatching','unknown') LIMIT 1`,logicalSessionId),409,"IMAGE_COMMAND_PENDING","会话仍有排队、执行或结果不确定的操作");
    const rows=this.db.all<{commandId:string;hash:string}>("SELECT command_id AS commandId,image_hash AS hash FROM image_uploads WHERE machine_id=? AND logical_session_id=? AND execution_segment_id=? AND cleaned_at IS NULL ORDER BY command_id,image_hash",machineId,logicalSessionId,session.executionSegmentId);
    const uploads: {commandId:string;hashes:string[]}[]=[];
    for(const row of rows) { let upload=uploads.find(u=>u.commandId===row.commandId);if(!upload){upload={commandId:row.commandId,hashes:[]};uploads.push(upload);}upload.hashes.push(row.hash); }
    invariant(uploads.length>0 && uploads.length<=50,409,"IMAGE_ORIGIN_UNPROVEN","缺少可核验的面板上传记录，或记录超过单次安全上限 50 条");
    return {logicalSessionId,...session,uploads};
  }

  complete(machineId: string, target: Record<string, unknown>, proof: Record<string, unknown>) {
    invariant(proof.cleaned===true && proof.threadId===target.nativeThreadId && proof.logicalSessionId===target.logicalSessionId && proof.beforeSha256===target.expectedDigest && proof.byteOffsetsPreserved===true && Array.isArray(proof.targets),409,"IMAGE_PROOF_INVALID","主机清理回执与确认范围不符，云端图片保持保留");
    const expected=target.turns as {turnId:string;hashes:string[]}[];
    invariant(JSON.stringify(proof.targets)===JSON.stringify(expected),409,"IMAGE_PROOF_INVALID","主机清理轮次与预览不符");
    const before=this.stats(machineId).usedBytes;
    for(const turn of expected) for(const hash of turn.hashes) {
      this.db.run("INSERT OR IGNORE INTO image_cleaned_turns VALUES(?,?,?,?,?)",machineId,String(target.logicalSessionId),String(target.nativeThreadId),turn.turnId,hash);
      this.db.run(`DELETE FROM cloud_image_refs WHERE machine_id=? AND image_hash=? AND owner_type='event' AND owner_id IN
        (SELECT payload_ref FROM durable_events WHERE machine_id=? AND logical_session_id=? AND native_thread_id=? AND native_turn_id=?)`,machineId,hash,machineId,String(target.logicalSessionId),String(target.nativeThreadId),turn.turnId);
    }
    for(const upload of target.uploads as {commandId:string;hashes:string[]}[]) for(const hash of upload.hashes) {
      this.db.run("DELETE FROM cloud_image_refs WHERE machine_id=? AND owner_type='command' AND owner_id=? AND image_hash=?",machineId,upload.commandId,hash);
      this.db.run("UPDATE image_uploads SET cleaned_at=? WHERE machine_id=? AND command_id=? AND image_hash=?",new Date().toISOString(),machineId,upload.commandId,hash);
    }
    this.db.run(`UPDATE cloud_images SET data_url=NULL,size_bytes=0,deleted_at=? WHERE machine_id=? AND data_url IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM cloud_image_refs r WHERE r.machine_id=cloud_images.machine_id AND r.image_hash=cloud_images.image_hash)`,new Date().toISOString(),machineId);
    this.db.run("UPDATE machines SET cloud_image_revision=cloud_image_revision+1 WHERE machine_id=?",machineId);
    return {...proof,cloudCleaned:true,releasedCloudBytes:before-this.stats(machineId).usedBytes};
  }

  /** Retention and content-policy removal must release images too. Keep hashes as replay tombstones. */
  collect(timestamp = new Date().toISOString()) {
    this.db.run(`DELETE FROM cloud_image_refs WHERE
      (owner_type='command' AND NOT EXISTS (SELECT 1 FROM command_contents c WHERE c.command_id=owner_id AND c.deleted_at IS NULL AND c.expires_at>?)) OR
      (owner_type='event' AND NOT EXISTS (SELECT 1 FROM content_blobs b WHERE b.payload_ref=owner_id AND b.deleted_at IS NULL AND b.expires_at>?))`, timestamp, timestamp);
    this.db.run(`UPDATE cloud_images SET data_url=NULL,size_bytes=0,deleted_at=? WHERE data_url IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM cloud_image_refs r WHERE r.machine_id=cloud_images.machine_id AND r.image_hash=cloud_images.image_hash)`, timestamp);
  }

  migrateInlineImages() {
    for (const type of ["command", "event"] as const) {
      let cursor = "";
      for (;;) {
        const rows = this.db.all<{ id: string; machine_id: string; body_json: string }>(type === "command"
          ? `SELECT cc.command_id AS id,s.machine_id,cc.body_json FROM command_contents cc JOIN commands c ON c.command_id=cc.command_id JOIN logical_sessions s ON s.logical_session_id=c.logical_session_id WHERE cc.command_id>? AND cc.deleted_at IS NULL AND cc.body_json LIKE '%data:image/%' ORDER BY cc.command_id LIMIT 200`
          : `SELECT b.payload_ref AS id,e.machine_id,b.body_json FROM content_blobs b JOIN durable_events e ON e.payload_ref=b.payload_ref WHERE b.payload_ref>? AND b.deleted_at IS NULL AND b.body_json LIKE '%data:image/%' ORDER BY b.payload_ref LIMIT 200`, cursor);
        if (!rows.length) break;
        for (const row of rows) {
          const body = this.store(row.machine_id, type, row.id, JSON.parse(row.body_json), "migration");
          this.db.run(type === "command" ? "UPDATE command_contents SET body_json=? WHERE command_id=?" : "UPDATE content_blobs SET body_json=? WHERE payload_ref=?", JSON.stringify(body), row.id);
          cursor = row.id;
        }
      }
    }
    this.collect();
  }
}
