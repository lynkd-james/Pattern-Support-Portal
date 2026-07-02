// =============================================================================
// Minimal structured logger (server-only).
//
// Emits one JSON object per line so logs are greppable locally and ingestible by
// Vercel / log drains later. No dependencies. Never logs secrets.
// =============================================================================

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function emit(
  component: string,
  bound: Record<string, unknown>,
  level: LogLevel,
  event: string,
  fields?: Record<string, unknown>
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    component,
    event,
    ...bound,
    ...fields,
  });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export function createLogger(
  component: string,
  bound: Record<string, unknown> = {}
): Logger {
  return {
    debug: (e, f) => emit(component, bound, "debug", e, f),
    info: (e, f) => emit(component, bound, "info", e, f),
    warn: (e, f) => emit(component, bound, "warn", e, f),
    error: (e, f) => emit(component, bound, "error", e, f),
    child: (f) => createLogger(component, { ...bound, ...f }),
  };
}
