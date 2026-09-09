import { AgentError } from "./errors.js";
import { isRecord, nowIso } from "./util.js";

export interface CodexSettings {
  model: string;
  effort?: string;
  mode?: "default" | "plan";
  serviceTier?: string | null;
  personality?: "none" | "friendly" | "pragmatic";
}
export interface CodexModel {
  inputModalities?: string[];
  model: string;
  displayName: string;
  efforts: string[];
  defaultEffort: string;
  serviceTiers?: { id: string; name: string }[];
  supportsPersonality?: boolean;
}
export interface CodexCatalog {
  imageInput?: boolean;
  models: CodexModel[];
  modes: string[];
  fetchedAt: string;
  error?: string;
  modeNotice?: string;
}
export interface CodexObservedSettings {
  model: string;
  provider?: string;
  effort?: string;
  observedAt: string;
}

export function readObservedSettings(raw: Record<string, unknown>): CodexObservedSettings | undefined {
  if (typeof raw.model !== "string" || !raw.model || raw.model.length > 256) return undefined;
  return { model: raw.model, observedAt: nowIso(),
    ...(typeof raw.modelProvider === "string" ? { provider: raw.modelProvider.slice(0, 256) } : {}),
    ...(typeof raw.reasoningEffort === "string" ? { effort: raw.reasoningEffort.slice(0, 32) } : {}),
  };
}

export function parseModels(value: unknown): CodexModel[] {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new AgentError("CODEX_CATALOG_INVALID", "Codex model catalog is invalid");
  return value.data.filter(isRecord).filter((item) => item.hidden !== true).map((item) => {
    if (typeof item.model !== "string" || !item.model || item.model.length > 256 || !Array.isArray(item.supportedReasoningEfforts)) {
      throw new AgentError("CODEX_CATALOG_INVALID", "Codex model entry is invalid");
    }
    return { model: item.model, displayName: typeof item.displayName === "string" ? item.displayName.slice(0, 256) : item.model,
      ...(Array.isArray(item.inputModalities) ? { inputModalities: item.inputModalities.filter((v): v is string => v === "text" || v === "image") } : {}),
      efforts: item.supportedReasoningEfforts.filter(isRecord).map((entry) => entry.reasoningEffort).filter((effort): effort is string => typeof effort === "string" && effort.length <= 32),
      defaultEffort: typeof item.defaultReasoningEffort === "string" ? item.defaultReasoningEffort : "",
      ...(Array.isArray(item.serviceTiers) ? { serviceTiers: item.serviceTiers.filter(isRecord).filter((tier) => typeof tier.id === "string" && tier.id.length <= 64).slice(0, 16).map((tier) => ({ id: tier.id as string, name: typeof tier.name === "string" ? tier.name.slice(0, 128) : tier.id as string })) } : {}),
      ...(typeof item.supportsPersonality === "boolean" ? { supportsPersonality: item.supportsPersonality } : {}),
    };
  });
}

export function validateSettings(value: unknown, catalog: CodexCatalog | undefined): CodexSettings | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).some((key) => !["model", "effort", "mode", "serviceTier", "personality"].includes(key)) || typeof value.model !== "string") {
    throw new AgentError("CODEX_SETTINGS_INVALID", "Only documented runtime settings are accepted");
  }
  const model = catalog?.models.find((item) => item.model === value.model);
  if (!model || catalog?.error) throw new AgentError("CODEX_MODEL_UNAVAILABLE", "Refresh the host model catalog before selecting a model");
  if (value.effort !== undefined && (typeof value.effort !== "string" || !model.efforts.includes(value.effort))) {
    throw new AgentError("CODEX_EFFORT_UNAVAILABLE", "The selected model does not support this reasoning effort");
  }
  if (value.mode !== undefined && ((value.mode !== "default" && value.mode !== "plan") || !catalog?.modes.includes(value.mode))) {
    throw new AgentError("CODEX_MODE_UNAVAILABLE", "This Codex runtime does not support the selected mode");
  }
  if (value.serviceTier !== undefined && value.serviceTier !== null && !model.serviceTiers?.some((tier) => tier.id === value.serviceTier)) throw new AgentError("CODEX_SETTINGS_INVALID", "Host model does not advertise this service tier");
  if (value.personality !== undefined && (!model.supportsPersonality || !["none", "friendly", "pragmatic"].includes(String(value.personality)))) throw new AgentError("CODEX_SETTINGS_INVALID", "Host model does not support this personality");
  return { model: model.model, ...(value.effort === undefined ? {} : { effort: value.effort as string }), ...(value.mode === undefined ? {} : { mode: value.mode as "default" | "plan" }),
    ...(value.serviceTier === undefined ? {} : { serviceTier: value.serviceTier as string | null }), ...(value.personality === undefined ? {} : { personality: value.personality as NonNullable<CodexSettings["personality"]> }) };
}

export function turnSettingsParams(settings: CodexSettings | undefined): Record<string, unknown> {
  if (!settings) return {};
  return { model: settings.model, ...(settings.effort ? { effort: settings.effort } : {}),
    ...(settings.serviceTier === undefined ? {} : { serviceTier: settings.serviceTier }), ...(settings.personality ? { personality: settings.personality } : {}),
    ...(settings.mode ? { collaborationMode: { mode: settings.mode, settings: {
      model: settings.model, reasoning_effort: settings.effort ?? null, developer_instructions: null,
    } } } : {}),
  };
}
