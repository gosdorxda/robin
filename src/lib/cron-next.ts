/**
 * Minimal 5-field cron → next-occurrence calculator (first match strictly after
 * `from`). Supports the field syntaxes the lottery/holder crons use:
 *   - star        any value
 *   - step        every Nth value (the cron star-slash-N form)
 *   - N           a specific value
 *   - a,b,c       a list
 *   - a-b         a range
 * e.g. top-of-hour, every-5-minutes, and "30 3 * * *" all resolve correctly.
 *
 * Day-of-month & day-of-week follow POSIX semantics: if BOTH are restricted the
 * match is an OR (either hits); if only one is restricted, that one must match.
 * Iterates minute-by-minute (capped at 8 days) so it's exact for any pattern.
 */

type Field = Set<number>;

function parseField(expr: string, min: number, max: number): Field {
  const out = new Set<number>();
  for (const part of expr.split(",")) {
    const p = part.trim();
    if (p === "*") {
      for (let v = min; v <= max; v++) out.add(v);
    } else if (p.startsWith("*/")) {
      const step = Number(p.slice(2));
      if (step > 0) for (let v = min; v <= max; v += step) out.add(v);
    } else if (p.includes("-")) {
      const [a, b] = p.split("-").map(Number);
      for (let v = a; v <= b; v++) out.add(v);
    } else {
      const v = Number(p);
      if (!Number.isNaN(v)) out.add(v);
    }
  }
  return out;
}

export function nextCronOccurrence(cron: string, from: Date = new Date()): Date | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const dom = parseField(parts[2], 1, 31);
  const month = parseField(parts[3], 1, 12);
  // cron 0 and 7 both mean Sunday; JS getDay() uses 0=Sunday.
  const dowRaw = parseField(parts[4], 0, 7);
  const dow = new Set<number>();
  for (const v of dowRaw) dow.add(v === 7 ? 0 : v);

  const start = new Date(from);
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1); // strictly after `from`

  const domRestricted = parts[2] !== "*";
  const dowRestricted = parts[4] !== "*";
  const cap = new Date(start.getTime() + 8 * 24 * 60 * 60 * 1000);

  // All field tests use UTC accessors so the cron is interpreted as UTC —
  // matching a UTC server clock (the common deployment TZ for node-cron) and
  // making the returned instant + countdown timezone-independent for browsers.
  for (let t = new Date(start); t < cap; t.setUTCMinutes(t.getUTCMinutes() + 1)) {
    const dayOk =
      domRestricted && dowRestricted
        ? dom.has(t.getUTCDate()) || dow.has(t.getUTCDay())
        : dom.has(t.getUTCDate()) && dow.has(t.getUTCDay());
    if (
      minute.has(t.getUTCMinutes()) &&
      hour.has(t.getUTCHours()) &&
      month.has(t.getUTCMonth() + 1) &&
      dayOk
    ) {
      return new Date(t);
    }
  }
  return null;
}
