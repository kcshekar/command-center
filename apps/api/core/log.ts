// Minimal structured logging: one JSON line per event to stdout/stderr, no
// dependency — this app's log volume doesn't justify pulling in pino/winston.
// Downstream (systemd, docker, a log shipper) can parse newline-delimited JSON.
type Level = "info" | "warn" | "error";

function emit(level: Level, message: string, meta?: Record<string, unknown>) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...meta });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  info: (message: string, meta?: Record<string, unknown>) => emit("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit("error", message, meta),
};
