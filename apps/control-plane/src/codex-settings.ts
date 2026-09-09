import { invariant } from "./errors.js";

export interface CodexCatalog {
  imageInput?: boolean;
  models: Array<{ model: string; displayName: string; efforts: string[]; defaultEffort: string; serviceTiers?: { id: string; name: string }[]; supportsPersonality?: boolean; inputModalities?: string[] }>;
  modes: string[];
  fetchedAt: string;
  error?: string;
  modeNotice?: string;
}
export interface CodexSettings { model: string; effort?: string; mode?: "default" | "plan"; serviceTier?: string | null; personality?: "none" | "friendly" | "pragmatic" }
function object(value: unknown): Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), 400, "INVALID_CODEX_SETTINGS", "Expected an object");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  invariant(typeof value === "string" && value.length <= max && !value.includes("\0"), 400, "INVALID_CODEX_SETTINGS", "Invalid Codex setting string");
  return value;
}
export function parseCodexCatalog(value: unknown): CodexCatalog | null {
  if (value == null) return null;
  const raw = object(value);
  invariant(Array.isArray(raw.models) && raw.models.length <= 500 && Array.isArray(raw.modes) && raw.modes.length <= 8, 400, "INVALID_CODEX_CATALOG", "Invalid model catalog");
  const models = raw.models.map((entry) => {
    const model = object(entry);
    invariant(Array.isArray(model.efforts) && model.efforts.length <= 16, 400, "INVALID_CODEX_CATALOG", "Invalid reasoning efforts");
    return { model: text(model.model), displayName: text(model.displayName), efforts: model.efforts.map((effort) => text(effort, 32)), defaultEffort: text(model.defaultEffort, 32),
      ...(Array.isArray(model.inputModalities) ? { inputModalities: model.inputModalities.filter((v): v is string => v === "text" || v === "image") } : {}),
      ...(Array.isArray(model.serviceTiers) ? { serviceTiers: model.serviceTiers.slice(0, 16).map((entry) => { const tier = object(entry); return { id: text(tier.id, 64), name: text(tier.name, 128) }; }) } : {}),
      ...(typeof model.supportsPersonality === "boolean" ? { supportsPersonality: model.supportsPersonality } : {}) };
  });
  return { ...(raw.imageInput === true ? { imageInput: true } : {}), models, modes: raw.modes.map((mode) => text(mode, 32)).filter((mode) => ["default", "plan"].includes(mode)), fetchedAt: text(raw.fetchedAt, 64), ...(raw.error === undefined ? {} : { error: text(raw.error, 500) }), ...(raw.modeNotice === undefined ? {} : { modeNotice: text(raw.modeNotice, 500) }) };
}
export function validateCodexSettings(value: unknown, catalog: CodexCatalog | null): CodexSettings | undefined {
  if (value === undefined) return undefined;
  const raw = object(value);
  invariant(Object.keys(raw).every((key) => ["model", "effort", "mode", "serviceTier", "personality"].includes(key)), 400, "INVALID_CODEX_SETTINGS", "Only documented runtime settings are configurable");
  const model = catalog?.models.find((item) => item.model === raw.model);
  invariant(model && !catalog?.error, 409, "CODEX_MODEL_UNAVAILABLE", "Host model catalog is unavailable or does not contain this model; update or reconnect the host");
  invariant(raw.effort === undefined || (typeof raw.effort === "string" && model.efforts.includes(raw.effort)), 400, "CODEX_EFFORT_UNAVAILABLE", "Model does not support this reasoning effort");
  invariant(raw.mode === undefined || ((raw.mode === "default" || raw.mode === "plan") && catalog?.modes.includes(raw.mode)), 400, "CODEX_MODE_UNAVAILABLE", "Host does not support this collaboration mode");
  invariant(raw.serviceTier === undefined || raw.serviceTier === null || model.serviceTiers?.some((tier) => tier.id === raw.serviceTier), 400, "CODEX_TIER_UNAVAILABLE", "Host model does not advertise this service tier");
  invariant(raw.personality === undefined || (model.supportsPersonality && ["none", "friendly", "pragmatic"].includes(String(raw.personality))), 400, "CODEX_PERSONALITY_UNAVAILABLE", "Host model does not support this personality");
  return { model: model.model, ...(raw.effort === undefined ? {} : { effort: raw.effort as string }), ...(raw.mode === undefined ? {} : { mode: raw.mode as "default" | "plan" }),
    ...(raw.serviceTier === undefined ? {} : { serviceTier: raw.serviceTier as string | null }), ...(raw.personality === undefined ? {} : { personality: raw.personality as NonNullable<CodexSettings["personality"]> }) };
}
export function parseRuntimeSettings(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  const raw = object(value);
  const result: Record<string, unknown> = {};
  if (typeof raw.archived === "boolean") result.archived = raw.archived;
  if (raw.permissions != null) {
    const permissions = object(raw.permissions);
    invariant(["project", "network", "full"].includes(String(permissions.profile)), 400, "INVALID_PERMISSION_PROFILE", "Unknown accepted permission profile");
    result.permissions = { profile: permissions.profile, source: text(permissions.source, 32), acceptedAt: text(permissions.acceptedAt, 64), nativeTurnId: text(permissions.nativeTurnId) };
  }
  for (const [key, fields] of [["observed", ["model", "provider", "effort", "observedAt"]], ["accepted", ["model", "effort", "mode", "personality", "serviceTier", "acceptedAt", "nativeTurnId"]]] as const) {
    if (raw[key] == null) continue;
    const entry = object(raw[key]);
    const clean: Record<string, string | null> = {};
    for (const field of fields) if (entry[field] !== undefined && entry[field] !== null) clean[field] = text(entry[field]);
    if (key === "accepted" && entry.serviceTier === null) clean.serviceTier = null;
    if (clean.model) result[key] = clean;
  }
  return result;
}
