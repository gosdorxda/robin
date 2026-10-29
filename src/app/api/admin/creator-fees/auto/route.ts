import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-guard";
import { logEvent } from "@/lib/log-buffer";
import {
  getAutoClaimConfig,
  setAutoClaimEnabled,
} from "@/lib/pumpfun/creator-fees";
import { clearCache } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/creator-fees/auto
 *
 * Flips the persisted auto-claim toggle. The cron is registered at boot and
 * re-reads this flag on every tick, so the change applies on the next tick —
 * no restart needed. Body: `{ enabled: boolean }`.
 */
export async function POST(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { enabled?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "Body must be { enabled: boolean }" },
      { status: 400 }
    );
  }
  try {
    await setAutoClaimEnabled(body.enabled);
    clearCache("admin:creator-fees");
    const auto = await getAutoClaimConfig();
    logEvent(
      "info",
      "admin",
      `auto-claim ${body.enabled ? "enabled" : "disabled"} by admin`
    );
    return NextResponse.json({ ok: true, auto });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 }
    );
  }
}
