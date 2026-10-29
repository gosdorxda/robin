import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-guard";
import { getRecentLogs } from "@/lib/log-buffer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin-only recent system log (in-memory ring buffer since process boot).
 * Reflects sync / draw / cron / admin actions for quick "what just happened?"
 * checks. Not persisted across restarts.
 */
export async function GET(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ logs: getRecentLogs(150) });
}
