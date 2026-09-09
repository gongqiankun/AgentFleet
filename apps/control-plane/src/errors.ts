export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function invariant(
  condition: unknown,
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): asserts condition {
  if (!condition) throw new AppError(statusCode, code, message, details);
}
