import { isIP } from "node:net";
import { resolve } from "node:path";

export interface ControlPlaneConfig {
  host: string;
  port: number;
  databasePath: string;
  webDistDir?: string;
  runtimeReleaseDir?: string;
  trustedProxies?: string[];
  publicOrigin: string;
  allowedOrigins: Set<string>;
  adminEmail: string;
  adminPassword: string;
  cookieName: string;
  cookieSecure: boolean;
  sessionTtlSeconds: number;
  controlLeaseTtlSeconds: number;
  pairTtlSeconds: number;
  challengeTtlSeconds: number;
  ticketTtlSeconds: number;
  heartbeatOfflineSeconds: number;
  logLevel: string;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`Expected boolean, got ${value}`);
}

function trustedProxies(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split("/");
    const family = address ? isIP(address) : 0;
    if (family === 0 || extra !== undefined) throw new Error(`TRUSTED_PROXIES contains an invalid IP/CIDR: ${entry}`);
    if (prefix !== undefined) {
      const bits = Number(prefix);
      const maximum = family === 4 ? 32 : 128;
      if (!Number.isInteger(bits) || bits < 0 || bits > maximum) {
        throw new Error(`TRUSTED_PROXIES contains an invalid IP/CIDR: ${entry}`);
      }
    }
  }
  return entries.length > 0 ? entries : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControlPlaneConfig {
  const adminEmail = env.ADMIN_EMAIL?.trim().toLowerCase();
  const adminPassword = env.ADMIN_PASSWORD;
  if (!adminEmail) throw new Error("ADMIN_EMAIL is required");
  if (
    !adminPassword
    || adminPassword.length < 12
    || adminPassword === "replace-with-a-long-random-password"
    || adminPassword === "use-a-long-random-password"
  ) {
    throw new Error("ADMIN_PASSWORD is required and must be at least 12 characters");
  }

  const publicOrigin = new URL(env.PUBLIC_ORIGIN ?? "http://127.0.0.1:3000").origin;
  const allowedOrigins = new Set(
    (env.ALLOWED_ORIGINS ?? publicOrigin)
      .split(",")
      .map((origin) => new URL(origin.trim()).origin),
  );
  const proxyTrust = trustedProxies(env.TRUSTED_PROXIES);

  return {
    host: env.HOST ?? "127.0.0.1",
    port: positiveInt(env.PORT, 3000, "PORT"),
    databasePath: resolve(env.DATABASE_PATH ?? "data/control-plane.sqlite"),
    ...(env.WEB_DIST_DIR ? { webDistDir: resolve(env.WEB_DIST_DIR) } : {}),
    ...(env.RUNTIME_RELEASE_DIR ? { runtimeReleaseDir: resolve(env.RUNTIME_RELEASE_DIR) } : {}),
    ...(proxyTrust ? { trustedProxies: proxyTrust } : {}),
    publicOrigin,
    allowedOrigins,
    adminEmail,
    adminPassword,
    cookieName: env.SESSION_COOKIE_NAME ?? "agentfleet_session",
    cookieSecure: bool(env.COOKIE_SECURE, true),
    sessionTtlSeconds: positiveInt(env.SESSION_TTL_SECONDS, 60 * 60 * 24 * 30, "SESSION_TTL_SECONDS"),
    controlLeaseTtlSeconds: positiveInt(env.CONTROL_LEASE_TTL_SECONDS, 45, "CONTROL_LEASE_TTL_SECONDS"),
    pairTtlSeconds: positiveInt(env.PAIR_TTL_SECONDS, 600, "PAIR_TTL_SECONDS"),
    challengeTtlSeconds: positiveInt(env.CHALLENGE_TTL_SECONDS, 60, "CHALLENGE_TTL_SECONDS"),
    ticketTtlSeconds: positiveInt(env.WS_TICKET_TTL_SECONDS, 30, "WS_TICKET_TTL_SECONDS"),
    heartbeatOfflineSeconds: positiveInt(env.HEARTBEAT_OFFLINE_SECONDS, 45, "HEARTBEAT_OFFLINE_SECONDS"),
    logLevel: env.LOG_LEVEL ?? "info",
  };
}
