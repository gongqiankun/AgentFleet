import { createHash, randomUUID } from "node:crypto";
import { dirname, relative, resolve, sep } from "node:path";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireString(
  value: unknown,
  name: string,
  options: { allowEmpty?: boolean; maxLength?: number } = {},
): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  if (!options.allowEmpty && value.length === 0) throw new TypeError(`${name} must not be empty`);
  if (options.maxLength !== undefined && Buffer.byteLength(value, "utf8") > options.maxLength) {
    throw new TypeError(`${name} is too large`);
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite numbers are not canonical JSON");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`unsupported canonical JSON value: ${typeof value}`);
}

export function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function identifier(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isPathInside(root: string, candidate: string): boolean {
  const difference = relative(resolve(root), resolve(candidate));
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !difference.startsWith(sep));
}

export function parentDirectory(path: string): string {
  return dirname(path);
}

export function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const data = Buffer.from(value, "utf8");
  if (data.length <= maxBytes) return { value, truncated: false };
  return { value: data.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

const REDACTIONS: ReadonlyArray<RegExp> = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/g,
  /\b(?:Bearer\s+)[A-Za-z0-9._~+\/-]+=*\b/gi,
  /\b(?:api[_-]?key|access[_-]?token|secret)\s*[=:]\s*[^\s,;]+/gi,
];

export function redact(value: string): string {
  return REDACTIONS.reduce((current, pattern) => current.replace(pattern, "[REDACTED]"), value);
}

export function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolvePromise();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
