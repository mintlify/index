// In production this is backed by the Mintlify platform's pino-based
// structured logger (request-scoped via AsyncLocalStorage).

export interface MinimalLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): MinimalLogger;
}

function buildLogger(): MinimalLogger {
  return {
    info: (obj, msg) => console.info(msg ?? '', obj),
    warn: (obj, msg) => console.warn(msg ?? '', obj),
    error: (obj, msg) => console.error(msg ?? '', obj),
    debug: (obj, msg) => console.debug(msg ?? '', obj),
    child: () => buildLogger(),
  };
}

export function getLogger(): MinimalLogger {
  return buildLogger();
}
