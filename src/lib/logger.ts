/**
 * Structured JSON logger. One JSON object per line on stdout with a `severity` field so Google Cloud
 * Logging parses levels automatically. Usage:
 *
 *   logger.info("request done", { requestId, status })
 *   const log = logger.child({ requestId })
 *   log.error("boom", { err })
 */
type Level = "debug" | "info" | "warn" | "error";

const SEVERITY: Record<Level, string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
};
const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel(): Level {
  const l = process.env.LOG_LEVEL as Level | undefined;
  return l && l in RANK ? l : "info";
}

function serializeError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return err;
}

function normalize(fields: Record<string, unknown> | undefined) {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? serializeError(v) : v;
  }
  return out;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function make(bindings: Record<string, unknown>): Logger {
  const emit = (level: Level, message: string, fields?: Record<string, unknown>) => {
    if (RANK[level] < RANK[minLevel()]) return;
    let line: string;
    try {
      line = JSON.stringify({
        severity: SEVERITY[level],
        message,
        time: new Date().toISOString(),
        ...bindings,
        ...normalize(fields),
      });
    } catch {
      line = JSON.stringify({ severity: SEVERITY[level], message, time: new Date().toISOString() });
    }
    process.stdout.write(line + "\n");
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (b) => make({ ...bindings, ...b }),
  };
}

export const logger: Logger = make({});
