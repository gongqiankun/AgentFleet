import type { FastifyRequest } from "fastify";
import type { ControlPlaneConfig } from "./config.js";
import { newId, futureIso, nowIso, randomToken, sha256, verifyPassword } from "./crypto.js";
import type { ControlPlaneDatabase } from "./db.js";
import { AppError, invariant } from "./errors.js";

export interface Principal {
  userId: string;
  workspaceId: string;
  clientSessionId: string;
  email: string;
  csrfHash: string;
  expiresAt: string;
}

interface SessionRow {
  user_id: string;
  workspace_id: string;
  client_session_id: string;
  email: string;
  csrf_hash: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface SessionCredentials {
  principal: Principal;
  sessionToken: string;
  csrfToken: string;
}

export class AuthService {
  constructor(
    private readonly db: ControlPlaneDatabase,
    private readonly config: ControlPlaneConfig,
  ) {}

  login(email: string, password: string, ip: string, userAgent: string): SessionCredentials {
    const user = this.db.get<{
      user_id: string;
      workspace_id: string;
      email: string;
      password_hash: string;
    }>("SELECT user_id,workspace_id,email,password_hash FROM users WHERE email=? COLLATE NOCASE", email.trim());
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
    }

    const clientSessionId = newId("csess");
    const sessionToken = randomToken(32);
    const csrfToken = randomToken(32);
    const createdAt = nowIso();
    const expiresAt = futureIso(this.config.sessionTtlSeconds);
    const ipHash = sha256(ip);
    const userAgentHash = sha256(userAgent);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO client_sessions(
          client_session_id,workspace_id,user_id,token_hash,csrf_hash,created_at,last_seen_at,
          expires_at,ip_hash,user_agent_hash
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        clientSessionId,
        user.workspace_id,
        user.user_id,
        sha256(sessionToken),
        sha256(csrfToken),
        createdAt,
        createdAt,
        expiresAt,
        ipHash,
        userAgentHash,
      );
      this.db.audit({
        workspaceId: user.workspace_id,
        actorUserId: user.user_id,
        actorClientSessionId: clientSessionId,
        action: "client_session.login",
        ipHash,
        userAgentHash,
      });
    });
    return {
      principal: {
        userId: user.user_id,
        workspaceId: user.workspace_id,
        clientSessionId,
        email: user.email,
        csrfHash: sha256(csrfToken),
        expiresAt,
      },
      sessionToken,
      csrfToken,
    };
  }

  authenticateToken(token: string | undefined): Principal {
    invariant(token, 401, "AUTH_REQUIRED", "Authentication is required");
    const row = this.db.get<SessionRow>(
      `SELECT s.user_id,s.workspace_id,s.client_session_id,u.email,s.csrf_hash,s.expires_at,s.revoked_at
       FROM client_sessions s JOIN users u ON u.user_id=s.user_id WHERE s.token_hash=?`,
      sha256(token),
    );
    invariant(row && !row.revoked_at && row.expires_at > nowIso(), 401, "SESSION_INVALID", "Session is expired or revoked");
    this.db.run("UPDATE client_sessions SET last_seen_at=? WHERE client_session_id=?", nowIso(), row.client_session_id);
    return {
      userId: row.user_id,
      workspaceId: row.workspace_id,
      clientSessionId: row.client_session_id,
      email: row.email,
      csrfHash: row.csrf_hash,
      expiresAt: row.expires_at,
    };
  }

  authenticateRequest(request: FastifyRequest): Principal {
    return this.authenticateToken(request.cookies[this.config.cookieName]);
  }

  requireOrigin(request: FastifyRequest): void {
    const origin = request.headers.origin;
    invariant(origin, 403, "ORIGIN_REQUIRED", "Origin header is required");
    let normalized: string;
    try {
      normalized = new URL(origin).origin;
    } catch {
      throw new AppError(403, "ORIGIN_INVALID", "Origin header is invalid");
    }
    invariant(this.config.allowedOrigins.has(normalized), 403, "ORIGIN_DENIED", "Origin is not allowed");
  }

  requireCsrf(request: FastifyRequest, principal: Principal): void {
    this.requireOrigin(request);
    const token = request.headers["x-csrf-token"];
    invariant(typeof token === "string" && sha256(token) === principal.csrfHash, 403, "CSRF_INVALID", "CSRF token is missing or invalid");
  }

  listSessions(principal: Principal): Array<Record<string, unknown>> {
    return this.db
      .all<{
        client_session_id: string;
        created_at: string;
        last_seen_at: string;
        expires_at: string;
        revoked_at: string | null;
        ip_hash: string | null;
        user_agent_hash: string | null;
      }>(
        `SELECT client_session_id,created_at,last_seen_at,expires_at,revoked_at,ip_hash,user_agent_hash
         FROM client_sessions WHERE user_id=? ORDER BY created_at DESC`,
        principal.userId,
      )
      .map((row) => ({
        clientSessionId: row.client_session_id,
        current: row.client_session_id === principal.clientSessionId,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        ipHash: row.ip_hash,
        userAgentHash: row.user_agent_hash,
      }));
  }

  revokeSession(principal: Principal, targetClientSessionId: string): void {
    this.db.transaction(() => {
      const target = this.db.get<{ client_session_id: string; revoked_at: string | null }>(
        "SELECT client_session_id,revoked_at FROM client_sessions WHERE client_session_id=? AND user_id=?",
        targetClientSessionId,
        principal.userId,
      );
      invariant(target, 404, "CLIENT_SESSION_NOT_FOUND", "Client Session was not found");
      if (target.revoked_at) return;
      const timestamp = nowIso();
      const leases = this.db.all<{ control_lease_id: string; logical_session_id: string }>(
        `SELECT control_lease_id,logical_session_id FROM control_leases
         WHERE holder_client_session_id=? AND state='active'`,
        targetClientSessionId,
      );
      const enrollments = this.db.all<{ enrollment_id: string }>(
        `SELECT enrollment_id FROM enrollment_transactions
         WHERE client_session_id=? AND status IN ('created','claimed','confirmed')`,
        targetClientSessionId,
      );
      this.db.run("UPDATE client_sessions SET revoked_at=? WHERE client_session_id=?", timestamp, targetClientSessionId);
      this.db.run(
        `UPDATE enrollment_transactions SET status='cancelled',cancelled_at=?
         WHERE client_session_id=? AND status IN ('created','claimed','confirmed')`,
        timestamp,
        targetClientSessionId,
      );
      this.db.run(
        `UPDATE control_leases SET state='revoked',version=version+1,ended_at=?
         WHERE holder_client_session_id=? AND state='active'`,
        timestamp,
        targetClientSessionId,
      );
      for (const lease of leases) {
        this.db.run(
          `UPDATE logical_sessions SET control_lease_version=control_lease_version+1,updated_at=?
           WHERE logical_session_id=?`,
          timestamp,
          lease.logical_session_id,
        );
        this.db.audit({
          workspaceId: principal.workspaceId,
          actorUserId: principal.userId,
          actorClientSessionId: principal.clientSessionId,
          logicalSessionId: lease.logical_session_id,
          controlLeaseId: lease.control_lease_id,
          action: "control_lease.revoke",
          metadata: { targetClientSessionId },
        });
      }
      for (const enrollment of enrollments) {
        this.db.audit({
          workspaceId: principal.workspaceId,
          actorUserId: principal.userId,
          actorClientSessionId: principal.clientSessionId,
          action: "machine.enrollment.cancel",
          metadata: {
            enrollmentId: enrollment.enrollment_id,
            reason: "client_session_revoked",
            targetClientSessionId,
          },
        });
      }
      this.db.audit({
        workspaceId: principal.workspaceId,
        actorUserId: principal.userId,
        actorClientSessionId: principal.clientSessionId,
        action: "client_session.revoke",
        metadata: { targetClientSessionId },
      });
    });
  }
}
