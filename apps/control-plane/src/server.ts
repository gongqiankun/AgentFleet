import { QuotaRefreshService } from "./quota-refresh.js";
import { UsageService } from "./usage.js";
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { WebSocket, type RawData } from "ws";
import type { ControlPlaneConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { ControlPlaneDatabase } from "./db.js";
import { AuthService, type Principal } from "./auth.js";
import { RegistryService, type AgentConnectionIdentity } from "./registry.js";
import { CoordinationService, type DispatchTarget } from "./coordination.js";
import { CloudImages } from "./cloud-images.js";
import { AppError, invariant } from "./errors.js";
import { apiSchemas, CODEX_COMPATIBILITY_PROFILE, type AgentToServerMessage, type ClientToServerMessage, type CreateCommandRequest } from "./api-schema.js";
import { canonicalJson, nowIso, sha256 } from "./crypto.js";
import { pageLimit, type ListOptions } from "./pagination.js";
import { MaintenanceService } from "./maintenance.js";
import { CredentialRenewalService } from "./credentials.js";
import { CodexPreferencesService } from "./codex-preferences.js";
import { PermissionPreferencesService } from "./permission-preferences.js";
import { channelControl, channelProfile, channelState, channelStatus, RUNTIME_ARTIFACT_NAME, writeChannelJson } from "./runtime-channel.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
    agentIdentity?: AgentConnectionIdentity;
  }
}

interface AgentSocketState {
  socket: WebSocket;
  identity: AgentConnectionIdentity;
  producerEpoch?: string;
  appServerEpoch?: string;
  reconciliationId?: string;
  reconciliationReady: boolean;
  dispatchPaused?: boolean;
}

interface ClientSocketState {
  socket: WebSocket;
  principal: Principal;
  sessionToken: string;
  subscriptions: Set<string>;
}

export interface ControlPlaneHandle {
  app: FastifyInstance;
  db: ControlPlaneDatabase;
  config: ControlPlaneConfig;
  runMaintenance: () => { offlineMachines: string[]; expiredContent: number; expiredAudit: number };
}

class FixedWindowLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  check(key: string, maximum: number, windowMs: number): void {
    const currentTime = Date.now();
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= currentTime) {
      this.buckets.set(key, { count: 1, resetAt: currentTime + windowMs });
      return;
    }
    existing.count += 1;
    invariant(existing.count <= maximum, 429, "RATE_LIMITED", "Too many attempts; try again later", {
      retryAfterSeconds: Math.ceil((existing.resetAt - currentTime) / 1000),
    });
  }

  prune(): void {
    const currentTime = Date.now();
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= currentTime) this.buckets.delete(key);
  }
}

function record(value: unknown, message = "Request body must be a JSON object"): Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), 400, "INVALID_BODY", message);
  return value as Record<string, unknown>;
}

function listOptions(query: Record<string, unknown>): ListOptions {
  const options: ListOptions = { limit: pageLimit(query.limit) };
  for (const name of ["cursor", "machineId", "projectId", "q", "executionState"] as const) {
    if (query[name] !== undefined) options[name] = requiredString(query[name], name, name === "cursor" ? 8192 : 500);
  }
  if (query.managed !== undefined) {
    invariant(query.managed === "true" || query.managed === "false", 400, "INVALID_FILTER", "managed must be true or false");
    options.managed = query.managed === "true";
  }
  return options;
}

function requiredString(value: unknown, field: string, max = 4096): string {
  invariant(typeof value === "string" && value.length > 0 && value.length <= max, 400, "INVALID_INPUT", `${field} is required`);
  return value;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  invariant(Number.isSafeInteger(value), 400, "INVALID_INPUT", `${field} must be an integer`);
  return value as number;
}

function routeId(request: FastifyRequest, name = "id"): string {
  const params = request.params as Record<string, unknown>;
  return requiredString(params[name], name, 300);
}

function clientIp(request: FastifyRequest): string {
  return request.ip || request.socket.remoteAddress || "unknown";
}

function userAgent(request: FastifyRequest): string {
  const value = request.headers["user-agent"];
  return typeof value === "string" ? value.slice(0, 1000) : "unknown";
}

function sendJson(socket: WebSocket, message: unknown): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function parseWsMessage(data: RawData): unknown {
  const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8");
  invariant(Buffer.byteLength(text) <= 1_000_000, 413, "WS_MESSAGE_TOO_LARGE", "WebSocket message exceeds 1 MB");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError(400, "WS_JSON_INVALID", "WebSocket message must be valid JSON");
  }
}

export async function buildControlPlane(
  suppliedConfig?: ControlPlaneConfig,
): Promise<ControlPlaneHandle> {
  const config = suppliedConfig ?? loadConfig();
  const db = new ControlPlaneDatabase(config.databasePath);
  db.bootstrap(config);
  const auth = new AuthService(db, config);
  const registry = new RegistryService(db, config);
  const startupMachineReconciliation = registry.reconcileControlPlaneRestart();
  const coordination = new CoordinationService(db, config);
  const usage = new UsageService(db);
  const codexPreferences = new CodexPreferencesService(db);
  const machineMaintenance = new MaintenanceService(db);
  const credentials = new CredentialRenewalService(db);
  const startupAttemptReconciliation = coordination.reconcilePersistedAttempts();
  coordination.reconcileQueueStates();
  const limiter = new FixedWindowLimiter();
  let closing = false;
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustedProxies?.length ? config.trustedProxies : false,
    forceCloseConnections: true,
    bodyLimit: 1_100_000,
    requestTimeout: 15_000,
  });
  const agents = new Map<string, AgentSocketState>();
  const clients = new Map<string, Set<ClientSocketState>>();

  if (startupAttemptReconciliation.retryable > 0 || startupAttemptReconciliation.unknown > 0) {
    app.log.warn(startupAttemptReconciliation, "reconciled persisted dispatch attempts after Control Plane startup");
  }
  if (startupMachineReconciliation.machines > 0) {
    app.log.warn(startupMachineReconciliation, "marked persisted Agent reachability as reconciling after Control Plane startup");
  }

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 8 * 1024 * 1024, perMessageDeflate: false } });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    reply.header(
      "content-security-policy",
      "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; script-src 'self'; style-src 'self'",
    );
    if (
      request.url.startsWith("/api/") ||
      request.url.startsWith("/ws/") ||
      ["/live", "/ready", "/healthz"].includes(request.url)
    ) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      const retryAfterSeconds = error.details?.retryAfterSeconds;
      if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds)) {
        reply.header("retry-after", String(Math.max(0, Math.ceil(retryAfterSeconds))));
      }
      void reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
        requestId: request.id,
      });
      return;
    }
    const validation = error as { validation?: unknown; statusCode?: number };
    if (validation.validation) {
      void reply.status(400).send({
        error: { code: "VALIDATION_ERROR", message: error instanceof Error ? error.message : "Request validation failed" },
        requestId: request.id,
      });
      return;
    }
    request.log.error({ err: error }, "request failed");
    void reply.status(validation.statusCode && validation.statusCode < 500 ? validation.statusCode : 500).send({
      error: { code: "INTERNAL_ERROR", message: "The request could not be completed" },
      requestId: request.id,
    });
  });

  const authenticate = async (request: FastifyRequest): Promise<void> => {
    request.principal = auth.authenticateRequest(request);
  };
  const mutate = async (request: FastifyRequest): Promise<void> => {
    const principal = auth.authenticateRequest(request);
    auth.requireCsrf(request, principal);
    request.principal = principal;
  };

  const broadcastSession = (logicalSessionId: string, message: unknown): void => {
    for (const states of clients.values()) {
      for (const state of states) {
        if (state.subscriptions.has(logicalSessionId)) sendJson(state.socket, message);
      }
    }
  };
  const broadcastMachine = (machineId: string): void => {
    for (const states of clients.values()) {
      for (const state of states) {
        try {
          const machine = registry.getMachine(state.principal, machineId);
          sendJson(state.socket, { type: "machine.changed", machine });
        } catch {
          // The client does not own this Machine or was revoked.
        }
      }
    }
  };
  const closeClientSession = (clientSessionId: string): void => {
    const states = clients.get(clientSessionId);
    if (!states) return;
    for (const state of states) {
      sendJson(state.socket, { type: "error", code: "CLIENT_SESSION_REVOKED", message: "Client session was revoked" });
      state.socket.terminate();
    }
    clients.delete(clientSessionId);
  };
  const closeMachine = (machineId: string): void => {
    const agent = agents.get(machineId);
    if (agent) {
      sendJson(agent.socket, { type: "error", code: "MACHINE_REVOKED", message: "Machine was revoked" });
      agent.socket.terminate();
    }
    agents.delete(machineId);
  };

  const dispatchCommand = (command: Record<string, unknown>): Record<string, unknown> | null => {
    const machineId = requiredString(command.machineId ?? db.get<{ machine_id: string }>(
      "SELECT s.machine_id FROM commands c JOIN logical_sessions s ON s.logical_session_id=c.logical_session_id WHERE c.command_id=?",
      command.commandId as string,
    )?.machine_id, "machineId");
    const agent = agents.get(machineId);
    if (!agent?.producerEpoch || !agent.appServerEpoch || !agent.reconciliationReady || agent.dispatchPaused || agent.socket.readyState !== WebSocket.OPEN) return null;
    const target: DispatchTarget = {
      machineId,
      transportGeneration: agent.identity.transportGeneration,
      producerEpoch: agent.producerEpoch,
      appServerEpoch: agent.appServerEpoch,
    };
    const attempt = coordination.createDispatchAttempt(requiredString(command.commandId, "commandId"), target);
    if (!attempt) return null;
    try {
      if (!sendJson(agent.socket, {
        type: "command.offer",
        dispatchAttemptId: attempt.dispatchAttemptId,
        transportGeneration: attempt.transportGeneration,
        producerEpoch: attempt.producerEpoch,
        appServerEpoch: attempt.appServerEpoch,
        command,
      })) {
        throw new Error("Agent socket was not writable");
      }
      coordination.markOffered(attempt.dispatchAttemptId as string);
    } catch (error) {
      coordination.markDeliveryFailed(attempt.dispatchAttemptId as string, error instanceof Error ? error.message : "send failed");
    }
    return attempt;
  };

  const dispatchPendingCommands = (machineId: string, workspaceId: string): void => {
    const eligibility = db.get<{ identity_state: string; security_state: string; compatibility: string; reachability: string }>(
      "SELECT identity_state,security_state,compatibility,reachability FROM machines WHERE machine_id=?",
      machineId,
    );
    if (
      !eligibility || eligibility.identity_state !== "active" || eligibility.security_state !== "normal" ||
      eligibility.compatibility !== "compatible" || eligibility.reachability !== "online"
    ) return;
    const pending = db.all<{ command_id: string }>(
      `SELECT c.command_id FROM commands c JOIN command_projection cp ON cp.command_id=c.command_id
       JOIN logical_sessions s ON s.logical_session_id=c.logical_session_id
       WHERE s.machine_id=? AND cp.state='accepted' AND c.expires_at>? ORDER BY c.created_at LIMIT 100`,
      machineId,
      nowIso(),
    );
    const systemPrincipal = db.get<{ user_id: string; workspace_id: string; client_session_id: string; email: string; csrf_hash: string; expires_at: string }>(
      `SELECT u.user_id,u.workspace_id,c.client_session_id,u.email,c.csrf_hash,c.expires_at
       FROM users u JOIN client_sessions c ON c.user_id=u.user_id
       WHERE u.workspace_id=? ORDER BY c.created_at DESC LIMIT 1`,
      workspaceId,
    );
    if (!systemPrincipal) return;
    const principal: Principal = {
      userId: systemPrincipal.user_id,
      workspaceId: systemPrincipal.workspace_id,
      clientSessionId: systemPrincipal.client_session_id,
      email: systemPrincipal.email,
      csrfHash: systemPrincipal.csrf_hash,
      expiresAt: systemPrincipal.expires_at,
    };
    for (const item of pending) {
      const command = coordination.getCommand(principal, item.command_id);
      dispatchCommand(command);
    }
  };

  const dispatchReadyQueues = (machineId: string, workspaceId: string): void => {
    const agent = agents.get(machineId);
    if (!agent?.reconciliationReady || agent.dispatchPaused || agent.socket.readyState !== WebSocket.OPEN) return;
    const sessions = db.all<{ logical_session_id: string }>(
      `SELECT DISTINCT s.logical_session_id FROM logical_sessions s JOIN turn_queue q
       ON q.logical_session_id=s.logical_session_id WHERE s.machine_id=? AND s.active_turn_id IS NULL AND q.state='queued'`, machineId,
    );
    for (const session of sessions) {
      const promoted = coordination.activateNextQueued(session.logical_session_id);
      if (!promoted) continue;
      const owner = db.get<{ actor_user_id: string; actor_client_session_id: string }>(
        "SELECT actor_user_id,actor_client_session_id FROM commands WHERE command_id=?", promoted.commandId,
      )!;
      dispatchCommand(coordination.getCommand({
        userId: owner.actor_user_id, workspaceId, clientSessionId: owner.actor_client_session_id,
        email: "queue-dispatch@internal.invalid", csrfHash: "", expiresAt: "",
      }, promoted.commandId));
      broadcastSession(session.logical_session_id, { type: "queue.changed", logicalSessionId: session.logical_session_id });
    }
  };

  const readiness = (): Record<string, unknown> => {
    const check = db.get<{ ok: number }>("SELECT 1 AS ok");
    return {
      status: check?.ok === 1 ? "ok" : "degraded",
      service: "agentfleet-control-plane",
      schemaVersion: Number((db.sqlite.prepare("PRAGMA user_version").get() as { user_version: number }).user_version),
      serverTime: nowIso(),
      uptimeSeconds: Math.floor(process.uptime()),
    };
  };
  app.get("/healthz", async () => readiness());
  app.get("/ready", async () => readiness());
  app.get("/live", async () => ({
    status: "ok",
    service: "agentfleet-control-plane",
    serverTime: nowIso(),
    uptimeSeconds: Math.floor(process.uptime()),
  }));

  app.get("/api/schema", async () => ({ apiVersion: "p0b-v1", schemas: apiSchemas }));
  let agentManifestVersion: string|null=null;
  let manifestStatus: "ready"|"unavailable"|"invalid"="unavailable";
  if(config.webDistDir) {
    const manifestPath=resolve(config.webDistDir,"downloads/manifest.json");
    if(existsSync(manifestPath)) {
      manifestStatus="invalid";
      try {
        invariant(statSync(manifestPath).size<=1_000_000,500,"INVALID_RELEASE_MANIFEST","Release manifest exceeds limit");
        const manifest=JSON.parse(readFileSync(manifestPath,"utf8")) as Record<string,unknown>;
        if(manifest.schemaVersion===1 && typeof manifest.version==="string" && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(manifest.version) && manifest.artifacts && typeof manifest.artifacts==="object") {
          const artifacts=Object.values(manifest.artifacts as Record<string,unknown>);
          if(artifacts.length>0 && artifacts.every(artifact=>{
            if(!artifact || typeof artifact!=="object") return false;
            const value=artifact as Record<string,unknown>;
            return typeof value.file==="string" && !value.file.includes("/") && !value.file.includes("\\") && typeof value.sha256==="string" && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.size) && Number(value.size)>0;
          })) { agentManifestVersion=manifest.version;manifestStatus="ready"; }
        }
      } catch { /* Report invalid packaged metadata without exposing filesystem paths. */ }
    }
  }
  app.get("/api/release",{preHandler:authenticate},async()=>({
    controlPlaneBuild:/^[a-f0-9]{7,40}$/.test(process.env.AGENTFLEET_BUILD_SHA??"")?process.env.AGENTFLEET_BUILD_SHA:"development",
    dbSchemaVersion:Number((db.sqlite.prepare("PRAGMA user_version").get() as {user_version:number}).user_version),
    agentVersion:agentManifestVersion,
    agentManifest:{version:agentManifestVersion,status:manifestStatus},
    compatibilityProfile:channelProfile(config.runtimeReleaseDir),
  }));

  app.get("/api/runtime-release", { preHandler: authenticate }, async () => channelStatus(config.runtimeReleaseDir));
  app.post("/api/runtime-release/control", { preHandler: mutate }, async request => {
    invariant(config.runtimeReleaseDir, 409, "RUNTIME_CHANNEL_DISABLED", "自动验证服务尚未配置");
    const action = record(request.body).action;
    invariant(["check", "pause", "resume", "rollback"].includes(String(action)), 400, "INVALID_ACTION", "无效的托管升级操作");
    const control = channelControl(config.runtimeReleaseDir);
    const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (action === "pause") control.paused = true;
    if (action === "resume") { control.paused = false; control.checkId = token; }
    if (action === "check") { invariant(!control.paused, 409, "RUNTIME_CHANNEL_PAUSED", "请先恢复自动晋升"); control.checkId = token; }
    if (action === "rollback") {
      invariant(channelState(config.runtimeReleaseDir).previous, 409, "NO_PREVIOUS_RUNTIME", "没有可回退的已验证版本");
      control.paused = true; control.rollbackId = token;
    }
    writeChannelJson(config.runtimeReleaseDir, "control.json", control);
    const principal = request.principal as Principal;
    db.audit({ workspaceId: principal.workspaceId, action: "runtime.channel.control", outcome: "accepted", metadata: { action, userId: principal.userId } });
    return channelStatus(config.runtimeReleaseDir);
  });
  app.get("/api/runtime-release/target", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { target: config.runtimeReleaseDir ? channelState(config.runtimeReleaseDir).target ?? null : null };
  });
  app.get("/downloads/managed-codex/:file", async (request, reply) => {
    const file = (request.params as { file: string }).file;
    invariant(config.runtimeReleaseDir && RUNTIME_ARTIFACT_NAME.test(file), 404, "RUNTIME_NOT_FOUND", "托管安装包不存在");
    const root = resolve(config.runtimeReleaseDir, "public");
    let path: string;
    try { path = realpathSync(resolve(root, file)); } catch { throw new AppError(404, "RUNTIME_NOT_FOUND", "托管安装包不存在"); }
    invariant(path === resolve(root, file) && statSync(path).isFile(), 404, "RUNTIME_NOT_FOUND", "托管安装包不存在");
    reply.header("cache-control", "public, max-age=31536000, immutable").header("content-length", statSync(path).size).type("application/octet-stream");
    return reply.send(createReadStream(path));
  });

  app.post("/api/auth/login", { schema: apiSchemas.login }, async (request, reply) => {
    auth.requireOrigin(request);
    limiter.check(`login:${clientIp(request)}`, 10, 5 * 60_000);
    const body = record(request.body);
    const credentials = auth.login(
      requiredString(body.email, "email", 320),
      requiredString(body.password, "password", 1024),
      clientIp(request),
      userAgent(request),
    );
    reply.setCookie(config.cookieName, credentials.sessionToken, {
      path: "/",
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "strict",
      maxAge: config.sessionTtlSeconds,
    });
    return {
      user: { userId: credentials.principal.userId, email: credentials.principal.email },
      clientSessionId: credentials.principal.clientSessionId,
      csrfToken: credentials.csrfToken,
      expiresAt: credentials.principal.expiresAt,
    };
  });

  app.post("/api/auth/logout", { preHandler: mutate }, async (request, reply) => {
    const principal = request.principal as Principal;
    auth.revokeSession(principal, principal.clientSessionId);
    closeClientSession(principal.clientSessionId);
    reply.clearCookie(config.cookieName, { path: "/", secure: config.cookieSecure, sameSite: "strict" });
    return { ok: true };
  });

  app.get("/api/auth/status", async (request) => {
    try {
      const principal = auth.authenticateRequest(request);
      return {
        authenticated: true,
        user: { userId: principal.userId, email: principal.email, workspaceId: principal.workspaceId },
        clientSessionId: principal.clientSessionId,
        expiresAt: principal.expiresAt,
      };
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 401) return { authenticated: false };
      throw error;
    }
  });

  app.get("/api/auth/me", { preHandler: authenticate }, async (request) => {
    const principal = request.principal as Principal;
    return {
      user: { userId: principal.userId, email: principal.email, workspaceId: principal.workspaceId },
      clientSessionId: principal.clientSessionId,
      expiresAt: principal.expiresAt,
    };
  });

  app.get("/api/client-sessions", { preHandler: authenticate }, async (request) => ({
    clientSessions: auth.listSessions(request.principal as Principal),
  }));
  app.get("/api/client-sessions/:id", { preHandler: authenticate }, async (request) => {
    const id = routeId(request);
    const item = auth.listSessions(request.principal as Principal).find((session) => session.clientSessionId === id);
    invariant(item, 404, "CLIENT_SESSION_NOT_FOUND", "Client Session was not found");
    return item;
  });
  app.delete("/api/client-sessions/:id", { preHandler: mutate }, async (request, reply) => {
    const principal = request.principal as Principal;
    const id = routeId(request);
    auth.revokeSession(principal, id);
    closeClientSession(id);
    if (id === principal.clientSessionId) reply.clearCookie(config.cookieName, { path: "/", secure: config.cookieSecure, sameSite: "strict" });
    return { ok: true };
  });

  app.post("/api/enrollments", { preHandler: mutate }, async (request) => {
    const principal = request.principal as Principal;
    limiter.check(`enrollment-create-session:${principal.clientSessionId}`, 10, 10 * 60_000);
    limiter.check(`enrollment-create-ip:${clientIp(request)}`, 30, 10 * 60_000);
    const body=request.body===undefined?{}:record(request.body);
    invariant(body.preauthorized===undefined||typeof body.preauthorized==="boolean",400,"INVALID_INPUT","preauthorized must be boolean");
    return registry.createEnrollment(principal, clientIp(request), userAgent(request),body.preauthorized===true);
  });

  app.post("/api/agent/credentials/renew/challenge",async(request)=>{
    limiter.check(`credential-renew:${clientIp(request)}`,30,60_000);
    const body=record(request.body);
    return credentials.challenge(requiredString(body.machineId,"machineId",200),requiredString(body.agentToken,"agentToken",500));
  });
  app.post("/api/agent/credentials/renew",async(request)=>{
    limiter.check(`credential-renew-proof:${clientIp(request)}`,60,60_000);
    const body=record(request.body);
    return credentials.renew(requiredString(body.machineId,"machineId",200),requiredString(body.agentToken,"agentToken",500),requiredString(body.challengeId,"challengeId",200),requiredString(body.signature,"signature",300));
  });

  app.get("/api/enrollments/:id", { preHandler: authenticate }, async (request) => (
    registry.getEnrollment(request.principal as Principal, routeId(request))
  ));

  app.post("/api/enrollments/:id/confirm", { preHandler: mutate }, async (request) => {
    const principal = request.principal as Principal;
    limiter.check(`enrollment-confirm-session:${principal.clientSessionId}`, 20, 10 * 60_000);
    limiter.check(`enrollment-confirm-ip:${clientIp(request)}`, 40, 10 * 60_000);
    const body = record(request.body);
    return registry.confirmEnrollment(
      principal,
      routeId(request),
      requiredString(body.verificationPhrase, "verificationPhrase", 200),
      clientIp(request),
      typeof body.machineName === "string" ? body.machineName : undefined,
    );
  });

  app.delete("/api/enrollments/:id", { preHandler: mutate }, async (request) => {
    const principal = request.principal as Principal;
    limiter.check(`enrollment-cancel-session:${principal.clientSessionId}`, 20, 10 * 60_000);
    return registry.cancelEnrollment(principal, routeId(request), clientIp(request));
  });

  app.post("/api/agent/enrollments/claim", async (request) => {
    const body = record(request.body);
    const ticket = requiredString(body.ticket ?? body.enrollmentToken, "ticket", 512);
    limiter.check(`enrollment-claim:${clientIp(request)}`, 30, 10 * 60_000);
    limiter.check(`enrollment-claim-ticket:${sha256(ticket)}`, 10, 10 * 60_000);
    return registry.claimEnrollment({
      ticket,
      publicKey: requiredString(body.publicKey, "publicKey", 4096),
      name: requiredString(body.name, "name", 120),
      platform: requiredString(body.platform, "platform", 50),
      platformRelease: requiredString(body.platformRelease, "platformRelease", 100),
      architecture: requiredString(body.architecture, "architecture", 50),
      ...(typeof body.agentVersion === "string" ? { agentVersion: body.agentVersion } : {}),
      ip: clientIp(request),
    });
  });

  app.post("/api/agent/enrollments/exchange", async (request) => {
    const body = record(request.body);
    const enrollmentId = requiredString(body.enrollmentId, "enrollmentId", 200);
    const claimToken = requiredString(body.claimToken, "claimToken", 256);
    limiter.check(`enrollment-exchange:${clientIp(request)}`, 600, 60_000);
    limiter.check(`enrollment-exchange-transaction:${sha256(`${enrollmentId}\n${claimToken}`)}`, 45, 60_000);
    return registry.exchangeEnrollment(
      enrollmentId,
      claimToken,
      requiredString(body.signature, "signature", 512),
      clientIp(request),
    );
  });

  app.post("/api/agent/pairing/init", async (request) => {
    limiter.check(`pair-init:${clientIp(request)}`, 10, 10 * 60_000);
    const body = record(request.body);
    return registry.initPairing({
      deviceCode: requiredString(body.deviceCode, "deviceCode", 256),
      publicKey: requiredString(body.publicKey, "publicKey", 4096),
      name: requiredString(body.name, "name", 120),
      platform: requiredString(body.platform, "platform", 50),
      platformRelease: requiredString(body.platformRelease, "platformRelease", 100),
      architecture: requiredString(body.architecture, "architecture", 50),
      ...(typeof body.agentVersion === "string" ? { agentVersion: body.agentVersion } : {}),
      ip: clientIp(request),
    });
  });

  app.get("/api/pairings/preview", { preHandler: authenticate }, async (request) => {
    const query = request.query as Record<string, unknown>;
    return registry.pairingPreview(request.principal as Principal, requiredString(query.userCode, "userCode", 30));
  });

  app.post("/api/pairings/:id/confirm", { preHandler: mutate }, async (request) => {
    limiter.check(`pair-confirm:${clientIp(request)}`, 20, 10 * 60_000);
    const body = record(request.body);
    return registry.confirmPairing(
      request.principal as Principal,
      routeId(request),
      requiredString(body.verificationPhrase, "verificationPhrase", 200),
      clientIp(request),
      typeof body.machineName === "string" ? body.machineName : undefined,
    );
  });

  app.post("/api/agent/pairing/exchange", async (request) => {
    limiter.check(`pair-exchange:${clientIp(request)}`, 30, 10 * 60_000);
    const body = record(request.body);
    return registry.exchangePairing(
      requiredString(body.deviceCode, "deviceCode", 256),
      requiredString(body.signature, "signature", 512),
    );
  });

  app.post("/api/agent/auth/challenge", async (request) => {
    limiter.check(`agent-challenge:${clientIp(request)}`, 120, 60_000);
    const body = record(request.body);
    return registry.createChallenge(
      requiredString(body.machineId, "machineId", 200),
      requiredString(body.agentToken, "agentToken", 512),
      optionalInteger(body.transportGeneration, "transportGeneration") ?? 0,
    );
  });

  app.post("/api/agent/auth/ticket", async (request) => {
    limiter.check(`agent-ticket:${clientIp(request)}`, 120, 60_000);
    const body = record(request.body);
    return registry.exchangeChallenge({
      machineId: requiredString(body.machineId, "machineId", 200),
      challengeId: requiredString(body.challengeId, "challengeId", 200),
      transportGeneration: optionalInteger(body.transportGeneration, "transportGeneration") ?? 0,
      signature: requiredString(body.signature, "signature", 512),
    });
  });

  app.get("/api/dashboard", { preHandler: authenticate }, async (request) => ({ ...registry.dashboard(request.principal as Principal), compatibilityProfile: channelProfile(config.runtimeReleaseDir) }));
  app.get("/api/machines", { preHandler: authenticate }, async (request) => ({ machines: registry.listMachines(request.principal as Principal) }));
  app.get("/api/machines/:id", { preHandler: authenticate }, async (request) => registry.getMachine(request.principal as Principal, routeId(request)));
  app.patch("/api/machines/:id", { preHandler: mutate }, async (request) => {
    const id = routeId(request);
    const body = record(request.body);
    invariant(body.alias === null || typeof body.alias === "string", 400, "INVALID_INPUT", "alias must be a string or null");
    const machine = registry.updateMachineAlias(request.principal as Principal, id, body.alias as string | null);
    broadcastMachine(id);
    return { machine };
  });
  app.delete("/api/machines/:id", { preHandler: mutate }, async (request) => {
    const id = routeId(request);
    registry.revokeMachine(request.principal as Principal, id);
    closeMachine(id);
    broadcastMachine(id);
    return { ok: true };
  });
  app.get("/api/projects", { preHandler: authenticate }, async (request) => {
    const query = request.query as Record<string, unknown>;
    if (query.limit !== undefined || query.cursor !== undefined || query.q !== undefined) {
      const page = registry.listProjectsPage(request.principal as Principal,listOptions(query));
      return { ...page, projects: page.items };
    }
    return { projects: registry.listProjects(request.principal as Principal, typeof query.machineId === "string" ? query.machineId : undefined) };
  });
  app.get("/api/machines/:id/images", { preHandler: authenticate }, async request =>
    new CloudImages(db).stats(routeId(request), request.principal as Principal));
  app.get("/api/machines/:id/images/sessions", { preHandler: authenticate }, async request =>
    new CloudImages(db).sessions(request.principal as Principal, routeId(request), typeof (request.query as Record<string,unknown>).cursor === "string" ? String((request.query as Record<string,unknown>).cursor) : ""));
  app.post("/api/machines/:id/images/clear", { preHandler: mutate }, async request => {
    const id = routeId(request);
    const result = new CloudImages(db).clear(request.principal as Principal, id, record(request.body));
    broadcastMachine(id);
    return result;
  });
  app.get("/api/machines/:id/operations",{preHandler:authenticate},async(request)=>({
    operations:machineMaintenance.list(request.principal as Principal,routeId(request)),
  }));
  app.get("/api/operations/:id",{preHandler:authenticate},async(request)=>({
    operation:machineMaintenance.get(request.principal as Principal,routeId(request)),
  }));
  app.post("/api/machines/:id/operations",{preHandler:mutate},async(request,reply)=>{
    const body=record(request.body);const machineId=routeId(request);
    const operation=machineMaintenance.create(request.principal as Principal,machineId,requiredString(body.type,"type",100),requiredString(body.clientMutationId,"clientMutationId",200),typeof body.logicalSessionId === "string" ? body.logicalSessionId : undefined,typeof body.previewOperationId === "string" ? body.previewOperationId : undefined);
    const agent=agents.get(machineId);
    if(agent?.reconciliationReady) for(const offer of machineMaintenance.offers(machineId)) sendJson(agent.socket,offer);
    reply.code(202);return {operation};
  });
  app.patch("/api/projects/:id/content-policy", { preHandler: mutate }, async (request) => {
    const body = record(request.body);
    invariant(typeof body.syncContent === "boolean", 400, "INVALID_INPUT", "syncContent must be boolean");
    invariant([1, 3, 7, 14, 30].includes(Number(body.retentionDays)), 400, "INVALID_INPUT", "retentionDays must be 1, 3, 7, 14, or 30");
    const project = registry.updateProjectContentPolicy(request.principal as Principal, routeId(request), {
      syncContent: body.syncContent,
      retentionDays: Number(body.retentionDays) as 1 | 3 | 7 | 14 | 30,
    });
    const binding = db.get<{ external_id: string }>("SELECT external_id FROM projects WHERE project_id=?", project.projectId);
    const agent = agents.get(project.machineId);
    if (binding && agent) sendJson(agent.socket, {
      type: "project.policy",
      projectExternalId: binding.external_id,
      syncContent: project.syncContent,
      retentionDays: project.retentionDays,
    });
    broadcastMachine(project.machineId);
    return { project };
  });

  app.get("/api/sessions", { preHandler: authenticate }, async (request) => {
    const query=request.query as Record<string,unknown>;
    if(Object.keys(query).length>0) {
      const page=registry.listSessionsPage(request.principal as Principal,listOptions(query));
      return {...page,sessions:page.items};
    }
    return {sessions:registry.listSessions(request.principal as Principal)};
  });
  app.post("/api/sessions", { preHandler: mutate, schema: apiSchemas.createSession }, async (request) => {
    const body = record(request.body);
    return registry.createSession(
      request.principal as Principal,
      requiredString(body.machineId, "machineId", 200),
      requiredString(body.projectId, "projectId", 200),
      typeof body.title === "string" ? body.title : undefined,
      typeof body.clientMutationId === "string" ? body.clientMutationId : undefined,
    );
  });
  const quotaRefresh = new QuotaRefreshService(db,machineId=>{
    const agent=agents.get(machineId);if(!agent?.reconciliationReady)return false;
    sendJson(agent.socket,{type:"quota.refresh"});return true;
  });
  app.post("/api/machines/:id/usage/refresh",{preHandler:mutate},async request=>{
    const workspaceId=(request.principal as Principal).workspaceId,id=routeId(request);
    usage.read(workspaceId,"machine",id);
    return {requested:quotaRefresh.request(workspaceId,"machine",id,true)};
  });
  for (const [path,scope] of [["sessions","session"],["projects","project"],["machines","machine"]] as const) {
    app.get(`/api/${path}/:id/usage`, { preHandler: authenticate }, async request => {
      const workspaceId=(request.principal as Principal).workspaceId,id=routeId(request);
      const summary=usage.read(workspaceId,scope,id);quotaRefresh.request(workspaceId,scope,id);return summary;
    });
  }
  app.get("/api/sessions/:id", { preHandler: authenticate }, async (request) => {
    const principal = request.principal as Principal;
    const logicalSessionId = routeId(request);
    const query = request.query as Record<string, unknown>;
    const afterSeq = query.afterSeq === undefined ? undefined : Number(query.afterSeq);
    const projectionEpoch = query.projectionEpoch === undefined ? undefined : Number(query.projectionEpoch);
    return {
      session: registry.getSession(principal, logicalSessionId),
      events: afterSeq === undefined ? [] : coordination.replayEvents(principal, logicalSessionId, afterSeq, projectionEpoch),
      commands: coordination.listCommands(principal, logicalSessionId),
      queue: coordination.listQueue(principal, logicalSessionId),
    };
  });
  app.get("/api/sessions/:id/queue", { preHandler: authenticate }, async (request) => ({
    queue: coordination.listQueue(request.principal as Principal, routeId(request)),
  }));
  app.delete("/api/sessions/:id/queue/:queueItemId", { preHandler: mutate }, async (request) => {
    const logicalSessionId = routeId(request);
    const queueItemId = requiredString((request.params as Record<string, unknown>).queueItemId, "queueItemId", 200);
    const result = coordination.cancelQueueItem(request.principal as Principal, logicalSessionId, queueItemId);
    broadcastSession(logicalSessionId, { type: "queue.changed", logicalSessionId, queue: coordination.listQueue(request.principal as Principal, logicalSessionId) });
    return result;
  });
  app.get("/api/sessions/:id/events", { preHandler: authenticate }, async (request) => {
    const query = request.query as Record<string, unknown>;
    if(query.limit!==undefined || query.beforeSeq!==undefined) {
      return coordination.historyPage(request.principal as Principal,routeId(request),{
        limit:pageLimit(query.limit),
        ...(query.beforeSeq===undefined?{}:{beforeSeq:Number(query.beforeSeq)}),
        ...(query.projectionEpoch===undefined?{}:{projectionEpoch:Number(query.projectionEpoch)}),
        ...(query.contentEpoch===undefined?{}:{contentEpoch:Number(query.contentEpoch)}),
      });
    }
    return {
      events: coordination.replayEvents(
        request.principal as Principal,
        routeId(request),
        query.afterSeq === undefined ? 0 : Number(query.afterSeq),
        query.projectionEpoch === undefined ? undefined : Number(query.projectionEpoch),
      ),
    };
  });
  // Explicitly retire the endpoint so stale browser tabs cannot still erase
  // cloud-only content. Existing tombstone/retention safety remains intact.
  app.delete("/api/sessions/:id/content", { preHandler: mutate }, async () => {
    throw new AppError(410, "CLOUD_CONTENT_DELETE_REMOVED", "单独删除云端正文的功能已取消；宿主机会话和云端内容均未修改。");
  });

  const acquireOrRenewLease = async (request: FastifyRequest): Promise<unknown> => {
    const principal = request.principal as Principal;
    const logicalSessionId = routeId(request);
    const body = record(request.body);
    const expectedVersion = optionalInteger(body.expectedVersion, "expectedVersion");
    const ttlSeconds = optionalInteger(body.ttlSeconds, "ttlSeconds");
    const lease = typeof body.leaseId === "string"
      ? coordination.renewLease(principal, logicalSessionId, body.leaseId, expectedVersion ?? -1, ttlSeconds)
      : coordination.acquireLease(principal, logicalSessionId, expectedVersion, ttlSeconds);
    const { isMine: _isMine, ...broadcastLease } = lease;
    broadcastSession(logicalSessionId, { type: "lease.changed", logicalSessionId, controlLease: broadcastLease });
    return lease;
  };
  app.post("/api/sessions/:id/control-lease", { preHandler: mutate }, acquireOrRenewLease);
  app.post("/api/sessions/:id/control-lease/acquire", { preHandler: mutate }, acquireOrRenewLease);
  app.post("/api/sessions/:id/control-lease/:leaseId/renew", { preHandler: mutate }, async (request) => {
    const body = record(request.body);
    body.leaseId = routeId(request, "leaseId");
    request.body = body;
    return acquireOrRenewLease(request);
  });
  app.delete("/api/sessions/:id/control-lease/:leaseId", { preHandler: mutate }, async (request) => {
    const body = request.body === undefined ? {} : record(request.body);
    const query = request.query as Record<string, unknown>;
    const expectedVersion = Number(body.expectedVersion ?? query.expectedVersion);
    const logicalSessionId = routeId(request);
    const lease = coordination.releaseLease(
      request.principal as Principal,
      logicalSessionId,
      routeId(request, "leaseId"),
      expectedVersion,
    );
    broadcastSession(logicalSessionId, { type: "lease.changed", logicalSessionId, controlLease: null });
    return lease;
  });

  app.post("/api/sessions/:id/commands", { preHandler: mutate, schema: apiSchemas.command }, async (request, reply) => {
    const logicalSessionId = routeId(request);
    const result = coordination.createCommand(
      request.principal as Principal,
      logicalSessionId,
      request.body as CreateCommandRequest,
    );
    const attempt = result.duplicate || (result.command as { type?: unknown }).type === "turn.queue" ? null : dispatchCommand(result.command);
    broadcastSession(logicalSessionId, { type: "command.changed", logicalSessionId, command: result.command });
    reply.status(result.duplicate ? 200 : 202);
    return { ...result, dispatchAttempt: attempt };
  });

  app.get("/api/sessions/:id/codex-settings", { preHandler: authenticate }, async (request) => {
    return codexPreferences.read(request.principal as Principal, routeId(request));
  });
  for (const kind of ["machines", "sessions"] as const) {
    app.get(`/api/${kind}/:id/permissions`, { preHandler: authenticate }, async request =>
      new PermissionPreferencesService(db).read(request.principal as Principal, kind, routeId(request)));
    app.put(`/api/${kind}/:id/permissions`, { preHandler: mutate }, async request =>
      new PermissionPreferencesService(db).write(request.principal as Principal, kind, routeId(request), record(request.body)));
  }
  app.get("/api/machines/:id/codex-settings", { preHandler: authenticate }, async (request) => {
    return codexPreferences.readMachine(request.principal as Principal, routeId(request));
  });
  app.put("/api/machines/:id/codex-settings", { preHandler: mutate }, async (request) => {
    return codexPreferences.writeMachine(request.principal as Principal, routeId(request), record(request.body));
  });
  app.put("/api/sessions/:id/codex-settings", { preHandler: mutate }, async (request) => {
    return codexPreferences.write(request.principal as Principal, routeId(request), record(request.body));
  });

  app.post("/api/approvals/:id/decision", { preHandler: mutate }, async (request, reply) => {
    const body = record(request.body);
    const approvalId = routeId(request);
    const approval = db.get<{
      logical_session_id: string;
      version: number;
      action_hash: string;
      app_server_epoch: string;
    }>(
      `SELECT a.logical_session_id,a.version,a.action_hash,a.app_server_epoch FROM approvals a
       JOIN logical_sessions s ON s.logical_session_id=a.logical_session_id
       WHERE a.approval_id=? AND s.workspace_id=?`,
      approvalId,
      (request.principal as Principal).workspaceId,
    );
    invariant(approval, 404, "APPROVAL_NOT_FOUND", "Approval was not found");
    const input: CreateCommandRequest = {
      clientMutationId: typeof body.clientMutationId === "string" ? body.clientMutationId : `approval-${approvalId}-${String(body.approvalVersion ?? approval.version)}-${String(body.decision)}`,
      type: "approval.decide_once",
      precondition: {
        approvalId,
        approvalVersion: optionalInteger(body.approvalVersion, "approvalVersion") ?? approval.version,
        actionHash: typeof body.actionHash === "string" ? body.actionHash : approval.action_hash,
        appServerEpoch: typeof body.appServerEpoch === "string" ? body.appServerEpoch : approval.app_server_epoch,
      },
      payload: { decision: requiredString(body.decision, "decision", 20), scope: "once" },
      ...(typeof body.payloadHash === "string" ? { payloadHash: body.payloadHash } : {}),
    };
    const result = coordination.createCommand(request.principal as Principal, approval.logical_session_id, input);
    const attempt = result.duplicate ? null : dispatchCommand(result.command);
    broadcastSession(approval.logical_session_id, {
      type: "command.changed",
      logicalSessionId: approval.logical_session_id,
      command: result.command,
    });
    reply.status(result.duplicate ? 200 : 202);
    return { ...result, dispatchAttempt: attempt };
  });

  app.get("/api/approvals", { preHandler: authenticate }, async (request) => {
    const query = request.query as Record<string, unknown>;
    return { approvals: coordination.listApprovals(request.principal as Principal, typeof query.state === "string" ? query.state : undefined) };
  });
  app.get("/api/audit", { preHandler: authenticate }, async (request) => {
    const query = request.query as Record<string, unknown>;
    return { entries: coordination.listAudit(request.principal as Principal, query.limit === undefined ? 100 : Number(query.limit)) };
  });
  app.get("/api/security/alerts", { preHandler: authenticate }, async (request) => ({
    alerts: db.all(
      "SELECT alert_id AS alertId,machine_id AS machineId,code,detail_json AS detail,created_at AS createdAt,resolved_at AS resolvedAt FROM security_alerts WHERE workspace_id=? ORDER BY created_at DESC LIMIT 200",
      (request.principal as Principal).workspaceId,
    ),
  }));

  app.get(
    "/ws/client",
    {
      websocket: true,
      preValidation: async (request) => {
        auth.requireOrigin(request);
        request.principal = auth.authenticateRequest(request);
      },
    },
    (socket, request) => {
      const principal = request.principal as Principal;
      const sessionToken = request.cookies[config.cookieName] as string;
      const state: ClientSocketState = { socket, principal, sessionToken, subscriptions: new Set() };
      let set = clients.get(principal.clientSessionId);
      if (!set) {
        set = new Set();
        clients.set(principal.clientSessionId, set);
      }
      set.add(state);
      sendJson(socket, { type: "welcome", clientSessionId: principal.clientSessionId, serverTime: nowIso() });

      socket.on("message", (data: RawData) => {
        if (closing) return;
        try {
          const current = auth.authenticateToken(state.sessionToken);
          invariant(current.clientSessionId === state.principal.clientSessionId, 401, "SESSION_INVALID", "Client Session changed");
          const message = record(parseWsMessage(data), "WebSocket message must be an object") as unknown as ClientToServerMessage;
          if (message.type === "ping") {
            sendJson(socket, { type: "pong" });
          } else if (message.type === "subscribe") {
            const logicalSessionId = requiredString(message.logicalSessionId, "logicalSessionId", 200);
            const session = registry.getSession(current, logicalSessionId);
            const events = coordination.replayEvents(
              current,
              logicalSessionId,
              message.lastAppliedSeq ?? 0,
              message.projectionEpoch,
            );
            state.subscriptions.add(logicalSessionId);
            sendJson(socket, { type: "snapshot", session, events });
          } else if (message.type === "unsubscribe") {
            state.subscriptions.delete(requiredString(message.logicalSessionId, "logicalSessionId", 200));
          } else {
            throw new AppError(400, "WS_MESSAGE_TYPE_DENIED", "Client WebSocket only accepts subscribe, unsubscribe, and ping");
          }
        } catch (error) {
          const appError = error instanceof AppError ? error : new AppError(400, "WS_MESSAGE_INVALID", "Invalid WebSocket message");
          sendJson(socket, { type: "error", code: appError.code, message: appError.message });
          if (appError.statusCode === 401 || appError.statusCode === 403) socket.close(1008, appError.code);
        }
      });
      socket.on("close", () => {
        const currentSet = clients.get(principal.clientSessionId);
        currentSet?.delete(state);
        if (currentSet?.size === 0) clients.delete(principal.clientSessionId);
      });
    },
  );

  app.get(
    "/ws/agent",
    {
      websocket: true,
      preValidation: async (request) => {
        const query = request.query as Record<string, unknown>;
        request.agentIdentity = registry.consumeAgentTicket(requiredString(query.ticket, "ticket", 512));
      },
    },
    (socket, request) => {
      const identity = request.agentIdentity as AgentConnectionIdentity;
      const previous = agents.get(identity.machineId);
      if (previous) {
        coordination.handleConnectionLost(previous.identity);
        sendJson(previous.socket, {
          type: "error",
          code: "TRANSPORT_SUPERSEDED",
          message: "A newer Agent transport generation connected",
        });
        previous.socket.terminate();
      }
      const state: AgentSocketState = { socket, identity, reconciliationReady: false };
      agents.set(identity.machineId, state);
      sendJson(socket, {
        type: "welcome",
        machineId: identity.machineId,
        transportGeneration: identity.transportGeneration,
        serverTime: nowIso(),
      });
      broadcastMachine(identity.machineId);

      socket.on("message", (data: RawData) => {
        if (closing) return;
        try {
          const message = record(parseWsMessage(data), "WebSocket message must be an object") as unknown as AgentToServerMessage;
          if (message.type === "hello") {
            state.reconciliationReady = false;
            delete state.reconciliationId;
            delete state.producerEpoch;
            delete state.appServerEpoch;
            const mappings = registry.registerHello(identity, message);
            state.producerEpoch = message.producerEpoch;
            state.appServerEpoch = message.appServerEpoch;
            state.reconciliationId = mappings.reconciliationId;
            sendJson(socket, { type: "hello.ack", ...mappings });
            broadcastMachine(identity.machineId);
          } else if (message.type === "reconciliation.complete") {
            invariant(
              state.producerEpoch && state.appServerEpoch && state.reconciliationId,
              409,
              "AGENT_HELLO_REQUIRED",
              "Agent must send hello first",
            );
            invariant(
              message.reconciliationId === state.reconciliationId,
              409,
              "RECONCILIATION_FENCED",
              "Reconciliation acknowledgement belongs to another hello cycle",
            );
            const completed = registry.completeReconciliation(
              identity,
              message.reconciliationId,
              message.reconciliationStreams,
            );
            state.reconciliationReady = true;
            state.dispatchPaused = false;
            sendJson(socket, {
              type: "reconciliation.ack",
              reconciliationId: message.reconciliationId,
              serverTime: nowIso(),
            });
            broadcastMachine(identity.machineId);
            for(const offer of machineMaintenance.offers(identity.machineId)) sendJson(socket,offer);
            if (!completed.alreadyComplete && completed.dispatchEligible) {
              dispatchPendingCommands(identity.machineId, identity.workspaceId);
              dispatchReadyQueues(identity.machineId, identity.workspaceId);
            }
          } else if (message.type === "heartbeat") {
            invariant(state.producerEpoch, 409, "AGENT_HELLO_REQUIRED", "Agent must send hello first");
            invariant(state.reconciliationReady, 409, "RECONCILIATION_REQUIRED", "Heartbeat is disabled until reconciliation completes");
            registry.heartbeat(identity, message.capacity, message.activeTurns, message.unreachableReason, message.codexProfile, { readOnly: message.readOnly, readOnlyReasons: message.readOnlyReasons });
            usage.quota(identity.machineId,message.quota);
            if(message.discovery) registry.updateDiscovery(identity.machineId,message.discovery);
            sendJson(socket, { type: "heartbeat.ack", serverTime: nowIso() });
            dispatchPendingCommands(identity.machineId, identity.workspaceId);
            dispatchReadyQueues(identity.machineId, identity.workspaceId);
            for(const offer of machineMaintenance.offers(identity.machineId)) sendJson(socket,offer);
            broadcastMachine(identity.machineId);
          } else if(message.type==="maintenance.result") {
            invariant(state.reconciliationReady,409,"RECONCILIATION_REQUIRED","Machine must finish reconciliation");
            machineMaintenance.result(identity.machineId,requiredString(message.operationId,"operationId",200),message.state,message.result,message.error);
            for (const sessionId of coordination.recoverCommandResults(identity.machineId,message.operationId)) {
              broadcastSession(sessionId,{type:"command.changed",logicalSessionId:sessionId});
            }
            if (message.state === "succeeded" && message.result?.cleaned === true && typeof message.result.logicalSessionId === "string") {
              broadcastSession(message.result.logicalSessionId,{type:"content.deleted",logicalSessionId:message.result.logicalSessionId});
            }
            // Maintenance results are replayed idempotently by the Agent. Do not
            // introduce an unsolicited acknowledgement: released Agents through
            // 0.20 reject maintenance.ack and can crash while closing the socket.
            broadcastMachine(identity.machineId);
          } else if (message.type === "event.append") {
            invariant(state.producerEpoch, 409, "AGENT_HELLO_REQUIRED", "Agent must send hello first");
            const result = coordination.appendEvent(identity, message.event);
            if (result.ok) {
              sendJson(socket, {
                type: "event.ack",
                eventId: result.eventId,
                duplicate: result.duplicate,
                projectionEpoch: result.projectionEpoch,
                sessionSeq: result.sessionSeq,
                nextExpectedHostSeq: result.nextExpectedHostSeq,
              });
              if (!result.duplicate) {
                broadcastSession(message.event.logicalSessionId, { type: "event", event: result.event });
                if (["turn.completed", "turn.failed", "turn.interrupted"].includes(message.event.type)) {
                  dispatchReadyQueues(identity.machineId, identity.workspaceId);
                }
              }
            } else {
              sendJson(socket, { type: "event.nack", ...result });
              if (result.code === "SOURCE_STREAM_CORRUPT") broadcastMachine(identity.machineId);
            }
          } else if (message.type === "volatile") {
            invariant(state.producerEpoch && state.appServerEpoch, 409, "AGENT_HELLO_REQUIRED", "Agent must send hello first");
            invariant(state.reconciliationReady, 409, "RECONCILIATION_REQUIRED", "Volatile frames are disabled until reconciliation completes");
            invariant(
              message.producerEpoch === state.producerEpoch && message.appServerEpoch === state.appServerEpoch,
              409,
              "VOLATILE_EPOCH_FENCED",
              "Volatile frame belongs to a stale Agent or App Server epoch",
            );
            invariant(
              ["agent_message.delta", "command_output.delta", "turn_diff.delta"].includes(message.eventType),
              400,
              "VOLATILE_TYPE_DENIED",
              "Volatile event type is not allowed",
            );
            const logicalSessionId = requiredString(message.logicalSessionId, "logicalSessionId", 200);
            const executionSegmentId = requiredString(message.executionSegmentId, "executionSegmentId", 200);
            const projectId = requiredString(message.projectId, "projectId", 200);
            const nativeThreadId = requiredString(message.nativeThreadId, "nativeThreadId", 300);
            const nativeTurnId = requiredString(message.nativeTurnId, "nativeTurnId", 300);
            const binding = db.get<{ native_thread_id: string | null }>(
              `SELECT e.native_thread_id FROM logical_sessions s JOIN execution_segments e
               ON e.execution_segment_id=? AND e.logical_session_id=s.logical_session_id
               WHERE s.logical_session_id=? AND s.machine_id=? AND s.project_id=?`,
              executionSegmentId,
              logicalSessionId,
              identity.machineId,
              projectId,
            );
            invariant(binding, 403, "VOLATILE_BINDING_INVALID", "Volatile frame does not belong to this Session and Project");
            invariant(
              binding.native_thread_id === null || binding.native_thread_id === nativeThreadId,
              409,
              "VOLATILE_THREAD_FENCED",
              "Volatile frame targets a different Native Thread",
            );
            const payload = record(message.payload, "Volatile payload must be an object");
            const field = message.eventType === "turn_diff.delta" ? "diff" : "delta";
            const content = requiredString(payload[field], field, 64_000);
            invariant(Buffer.byteLength(content, "utf8") <= 32_000, 413, "VOLATILE_TOO_LARGE", "Volatile content exceeds 32 KB");
            broadcastSession(logicalSessionId, {
              type: "volatile",
              eventType: message.eventType,
              logicalSessionId,
              nativeTurnId,
              ...(typeof message.nativeItemId === "string" ? { nativeItemId: message.nativeItemId.slice(0, 300) } : {}),
              payload: { [field]: content, truncated: payload.truncated === true },
            });
          } else if (message.type === "command.ack") {
            invariant(state.producerEpoch, 409, "AGENT_HELLO_REQUIRED", "Agent must send hello first");
            const attempt = coordination.transitionAttempt(identity, message.dispatchAttemptId, message.state, message.detail);
            if (attempt.deferredUntilReconciliation === true && attempt.duplicate !== true) state.dispatchPaused = true;
            const linked = db.get<{ logical_session_id: string; command_id: string }>(
              `SELECT c.logical_session_id,c.command_id FROM dispatch_attempts a
               JOIN commands c ON c.command_id=a.command_id WHERE a.dispatch_attempt_id=?`,
              message.dispatchAttemptId,
            );
            sendJson(socket, { type: "command.ack.confirmed", ...attempt });
            if (linked) {
              broadcastSession(linked.logical_session_id, {
                type: "command.changed",
                logicalSessionId: linked.logical_session_id,
                commandId: linked.command_id,
                attempt,
              });
            }
          } else if (message.type === "ping") {
            sendJson(socket, { type: "pong" });
          } else {
            throw new AppError(400, "WS_MESSAGE_TYPE_DENIED", "Unsupported Agent message type");
          }
        } catch (error) {
          const appError = error instanceof AppError ? error : new AppError(400, "WS_MESSAGE_INVALID", "Invalid WebSocket message");
          request.log.warn({ code: appError.code, machineId: identity.machineId }, "agent message rejected");
          sendJson(socket, { type: "error", code: appError.code, message: appError.message });
          if (appError.statusCode === 401 || appError.statusCode === 403) socket.close(1008, appError.code);
        }
      });
      socket.on("close", (_code: number, reason: Buffer) => {
        if (agents.get(identity.machineId) === state) agents.delete(identity.machineId);
        if (closing) return;
        coordination.handleConnectionLost(identity);
        registry.disconnect(identity, reason.toString() || "websocket_closed");
        broadcastMachine(identity.machineId);
      });
    },
  );

  const runMaintenance = (): { offlineMachines: string[]; expiredContent: number; expiredAudit: number } => {
    db.expireTransientState();
    coordination.expireUndispatchedCommands();
    const offlineMachines = registry.sweepOffline();
    for (const machineId of offlineMachines) broadcastMachine(machineId);
    limiter.prune();
    const expiredContent = coordination.purgeExpiredContent();
    const expiredAudit = coordination.purgeExpiredAudit();
    return { offlineMachines, expiredContent, expiredAudit };
  };
  const maintenance = setInterval(() => {
    try {
      runMaintenance();
    } catch (error) {
      app.log.error({ err: error }, "maintenance sweep failed");
    }
  }, 10_000);
  maintenance.unref();

  app.addHook("onClose", async () => {
    closing = true;
    clearInterval(maintenance);
    for (const agent of agents.values()) agent.socket.terminate();
    for (const states of clients.values()) for (const state of states) state.socket.terminate();
    agents.clear();
    clients.clear();
    db.close();
  });

  if (config.webDistDir) {
    invariant(existsSync(config.webDistDir), 500, "WEB_DIST_MISSING", `WEB_DIST_DIR does not exist: ${config.webDistDir}`);
    const staticRoot = realpathSync(config.webDistDir);
    const fallback = realpathSync(resolve(staticRoot, "index.html"));
    invariant(
      fallback.startsWith(`${staticRoot}${sep}`) && statSync(fallback).isFile(),
      500,
      "WEB_INDEX_MISSING",
      "WEB_DIST_DIR must contain a regular index.html",
    );
    const mimeTypes: Record<string, string> = {
      ".css": "text/css; charset=utf-8",
      ".gif": "image/gif",
      ".html": "text/html; charset=utf-8",
      ".ico": "image/x-icon",
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".map": "application/json; charset=utf-8",
      ".png": "image/png",
      ".ps1": "text/plain; charset=utf-8",
      ".sh": "text/x-shellscript; charset=utf-8",
      ".svg": "image/svg+xml",
      ".txt": "text/plain; charset=utf-8",
      ".webmanifest": "application/manifest+json; charset=utf-8",
      ".webp": "image/webp",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    };
    const immutableReleasePath = /^downloads\/agentfleet-(?:linux-x64|darwin-(?:arm64|x64)|win32-x64)-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?:\.tar\.gz)?(?:\.sha256)?$/u;
    app.get("/*", async (request, reply) => {
      const wildcard = (request.params as { "*"?: string })["*"] ?? "";
      let relativePath: string;
      try {
        relativePath = decodeURIComponent(wildcard).replace(/^\/+/, "");
      } catch {
        throw new AppError(400, "STATIC_PATH_INVALID", "Static path is not valid UTF-8");
      }
      if (relativePath === "api" || relativePath.startsWith("api/") || relativePath === "ws" || relativePath.startsWith("ws/")) {
        throw new AppError(404, "ROUTE_NOT_FOUND", "Route was not found");
      }
      const releasePath = relativePath === "install" || relativePath === "install-macos" || relativePath === "install.ps1" || relativePath.startsWith("install/") ||
        relativePath === "downloads" || relativePath.startsWith("downloads/");
      let filePath = resolve(staticRoot, relativePath || "index.html");
      try {
        if (statSync(filePath).isDirectory()) filePath = resolve(filePath, "index.html");
        filePath = realpathSync(filePath);
      } catch {
        if (releasePath || extname(relativePath) !== "") {
          throw new AppError(404, "STATIC_FILE_NOT_FOUND", "Static file was not found");
        }
        filePath = fallback;
      }
      const withinRoot = filePath === staticRoot || filePath.startsWith(`${staticRoot}${sep}`);
      invariant(withinRoot, 404, "STATIC_FILE_NOT_FOUND", "Static file was not found");
      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        throw new AppError(404, "STATIC_FILE_NOT_FOUND", "Static file was not found");
      }
      invariant(stat.isFile(), 404, "STATIC_FILE_NOT_FOUND", "Static file was not found");
      reply.type(relativePath === "install" || relativePath === "install-macos" ? mimeTypes[".sh"]! : mimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream");
      reply.header("content-length", stat.size);
      reply.header(
        "cache-control",
        immutableReleasePath.test(relativePath)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      );
      return reply.send(createReadStream(filePath));
    });
  } else {
    app.get("/", async (_request, reply) => {
      reply.type("application/json");
      return { service: "agentfleet-control-plane", status: "ok", dashboard: "/api/dashboard" };
    });
  }

  return { app, db, config, runMaintenance };
}

export function csrfHeaders(csrfToken: string, origin: string): Record<string, string> {
  return { origin, "x-csrf-token": csrfToken, "content-type": "application/json" };
}

export function cookieFromSetCookie(header: string | string[] | undefined): string {
  invariant(header, 500, "COOKIE_MISSING", "Response did not include a cookie");
  const value = Array.isArray(header) ? header[0] : header;
  invariant(value, 500, "COOKIE_MISSING", "Response did not include a cookie");
  return value.split(";", 1)[0] as string;
}

export function requestFingerprint(request: FastifyRequest): string {
  return sha256(canonicalJson({ ip: clientIp(request), userAgent: userAgent(request) }));
}
