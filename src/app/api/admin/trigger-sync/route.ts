import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-guard";
import { syncHolders } from "@/lib/sync";
import { logEvent } from "@/lib/log-buffer";
import { clearCache } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  logEvent("info", "admin", "manual holder sync triggered");
  try {
    const result = await syncHolders();
    // New snapshot batch → holder counts/eligibility in status + holders pages
    // changed. Drop the cached copies.
    clearCache();
    logEvent(
      "success",
      "admin",
      `manual sync done — ${result.totalHolders} holders`
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    logEvent("error", "admin", `manual sync failed: ${(e as Error).message}`);
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 }
    );
  }
}
