import { AgentError } from "./errors.js";
import { AGENT_VERSION } from "./constants.js";
import { isRecord } from "./util.js";

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export function normalizeControlPlaneUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new AgentError("URL_INVALID", "control-plane URL must not contain credentials, query, or fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new AgentError("URL_INSECURE", "control-plane URL must use HTTPS (HTTP is allowed only on loopback)");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function apiUrl(base: string, path: string): URL {
  const url = new URL(base);
  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix}${path.startsWith("/") ? path : `/${path}`}`;
  url.search = "";
  url.hash = "";
  return url;
}

export interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
  retryAfterMs?: number;
}

export function responseError(response: JsonResponse): { code?: string; message?: string } {
  const nested = isRecord(response.body.error) ? response.body.error : {};
  const code = typeof nested.code === "string"
    ? nested.code
    : typeof response.body.code === "string"
      ? response.body.code
      : undefined;
  const message = typeof nested.message === "string"
    ? nested.message
    : typeof response.body.message === "string"
      ? response.body.message
      : undefined;
  return { ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) };
}

export async function postJson(
  url: URL,
  body: Record<string, unknown>,
  options: { bearer?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<JsonResponse> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": `agentfleet-local/${AGENT_VERSION}`,
  };
  if (options.bearer !== undefined) headers.authorization = `Bearer ${options.bearer}`;
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
    text = await response.text();
  } catch (error) {
    throw new AgentError("HTTP_FAILED", `request to ${url.origin} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (text.length === 0 && response.status >= 200 && response.status < 300) {
    throw new AgentError("HTTP_FAILED", `control plane returned an incomplete success response (HTTP ${response.status})`);
  }
  let decoded: unknown = {};
  if (text.length > 0) {
    try {
      decoded = JSON.parse(text) as unknown;
    } catch {
      if ((response.status >= 200 && response.status < 300) || response.status >= 500) {
        throw new AgentError("HTTP_FAILED", `control plane response was interrupted or invalid (HTTP ${response.status})`);
      }
      throw new AgentError("HTTP_INVALID_JSON", `control plane returned invalid JSON (HTTP ${response.status})`);
    }
  }
  if (!isRecord(decoded)) throw new AgentError("HTTP_INVALID_JSON", "control plane response must be a JSON object");
  const retryHeader = response.headers.get("retry-after");
  const retrySeconds = retryHeader === null ? Number.NaN : Number(retryHeader);
  return {
    status: response.status,
    body: decoded,
    ...(Number.isFinite(retrySeconds) ? { retryAfterMs: Math.max(0, retrySeconds * 1_000) } : {}),
  };
}

export function requireSuccess(response: JsonResponse, operation: string): Record<string, unknown> {
  if (response.status >= 200 && response.status < 300) return response.body;
  const failure = responseError(response);
  const code = failure.code ?? "CONTROL_PLANE_ERROR";
  const message = failure.message ?? `${operation} failed with HTTP ${response.status}`;
  throw new AgentError(code, message);
}

export function validateWebSocketUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new AgentError("RELAY_URL_INVALID", "relay URL is malformed");
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && isLoopback(url.hostname))) {
    throw new AgentError("RELAY_URL_INSECURE", "relay URL must use WSS (WS is allowed only on loopback)");
  }
  return url;
}
