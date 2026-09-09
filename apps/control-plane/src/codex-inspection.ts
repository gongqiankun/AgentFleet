/** A second allowlist at the browser boundary; never expose an arbitrary RPC result. */
export function sanitizeInspection(value: unknown): Record<string, unknown> | null {
  const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const raw = object(value); const source = object(raw.sections);
  if (typeof raw.observedAt !== "string" || typeof raw.cwd !== "string") return null;
  const sections: Record<string, unknown> = {};
  for (const key of ["account", "usage", "config", "skills", "hooks", "mcp", "apps", "plugins", "terminals", "goal", "permissions", "experimental"]) {
    const section = object(source[key]);
    if (typeof section.available !== "boolean") continue;
    sections[key] = { available: section.available, truncated: section.truncated === true,
      rows: Array.isArray(section.rows) ? section.rows.slice(0, 25).map((v) => { const row = object(v); return Object.fromEntries(["name", "detail", "status"].map((field) => [field, typeof row[field] === "string" ? row[field].slice(0, 540) : ""])); }) : [],
      ...(typeof section.errorCode === "string" ? { errorCode: section.errorCode.slice(0, 100) } : {}) };
  }
  return { observedAt: raw.observedAt.slice(0, 64), cwd: raw.cwd.slice(0, 8192), sections };
}
