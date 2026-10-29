import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-guard";
import { cacheStats, clearCache } from "@/lib/cache";
import { logEvent } from "@/lib/log-buffer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/admin/cache — inspect and clear the in-process response cache
 * (`lib/cache.ts`) from Admin → Settings.
 *
 *   GET  → { ok, count, entries: [{ key, ageMs }] } — youngest entry first.
 *   POST → { ok, cleared, remaining }.
 *          Body { prefix?: string } narrows the clear ("admin:", "rounds", …);
 *          no body clears everything, like the mutation routes do.
 *
 * Only cached *payloads* are discarded — the database, the settings and the
 * scheduler state are untouched. Public pages simply re-query on the next hit,
 * which is the intended escape hatch after a manual DB edit or a prize-wallet
 * top-up that the 10–30 s TTL would otherwise hide.
 */

export async function GET(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const entries = cacheStats().sort((a, b) => a.ageMs - b.ageMs);
  return NextResponse.json({ ok: true, count: entries.length, entries });
}

export async function POST(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { prefix?: unknown } = {};
  try {
    body = (await request.json().catch(() => ({}))) as { prefix?: unknown };
  } catch {
    /* empty body → clear everything */
  }
  const prefix = typeof body.prefix === "string" ? body.prefix.trim() : "";

  const cleared = clearCache(prefix || undefined);
  const remaining = cacheStats().length;
  logEvent(
    "success",
    "admin",
    prefix
      ? `cache cleared (prefix "${prefix}"): ${cleared} key(s)`
      : `cache cleared: ${cleared} key(s)`
  );
  return NextResponse.json({ ok: true, cleared, remaining });
}
