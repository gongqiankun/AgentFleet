export interface CodexSettings { model: string; effort?: string; mode?: "default" | "plan"; serviceTier?: string | null; personality?: "none" | "friendly" | "pragmatic" }
export interface CodexCatalog {
  models: Array<{ model: string; displayName: string; efforts: string[]; defaultEffort: string; serviceTiers?: { id: string; name: string }[]; supportsPersonality?: boolean }>;
  modes: string[];
  fetchedAt: string;
  error?: string;
  modeNotice?: string;
}
export interface CodexPreferences {
  catalog: CodexCatalog | null;
  preferences: Record<"machine" | "project" | "session", { settings: CodexSettings | null; revision: number }>;
  source: "machine" | "project" | "session" | "codex";
  desired: CodexSettings | null;
}
export interface RuntimeSettings {
  permissions?: { profile: "project" | "network" | "full"; source: string; acceptedAt: string; nativeTurnId: string };
  archived?: boolean;
  observed?: { model: string; provider?: string; effort?: string; observedAt: string };
  accepted?: CodexSettings & { acceptedAt: string; nativeTurnId: string };
}
