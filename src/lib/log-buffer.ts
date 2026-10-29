/**
 * In-memory ring buffer of recent system events for the admin log viewer.
 *
 * Persisted DB-backed logging is intentionally avoided here to keep this
 * zero-migration and resilient: a missing/changed schema can never crash the
 * running app. The buffer holds the most recent MAX entries since process boot;
 * it is not shared across serverless instances but is plenty for an admin
 * "what just happened?" sanity check. Upgrade to a SystemLog table later if
 * long-term retention is needed.
 */
export type LogLevel = "info" | "success" | "warn" | "error";

export interface LogEntry {
  id: number;
  ts: string; // ISO timestamp
  level: LogLevel;
  source: string; // e.g. "draw", "sync", "cron", "admin"
  message: string;
}

const MAX = 200;
const buffer: LogEntry[] = [];
let seq = 0;

/**
 * Records an event into the ring buffer and mirrors it to server stdout so it
 * also appears in the platform's log stream. Never throws.
 */
export function logEvent(
  level: LogLevel,
  source: string,
  message: string
): void {
  try {
    const entry: LogEntry = {
      id: ++seq,
      ts: new Date().toISOString(),
      level,
      source,
      message,
    };
    buffer.push(entry);
    while (buffer.length > MAX) buffer.shift();
    const tag = `[${source}]`;
    if (level === "error") console.error(tag, message);
    else if (level === "warn") console.warn(tag, message);
    else console.log(tag, message);
  } catch {
    // logging must never break the caller
  }
}

/** Returns recent log entries, newest first. */
export function getRecentLogs(limit = 100): LogEntry[] {
  return buffer.slice(-limit).reverse();
}
