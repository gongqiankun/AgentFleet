export class AgentError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof AgentError) return { code: error.code, message: error.message };
  return { code: "INTERNAL_ERROR", message: errorMessage(error) };
}
