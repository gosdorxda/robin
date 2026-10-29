import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-guard";
import { runLotteryRound } from "@/lib/lottery/engine";
import { logEvent } from "@/lib/log-buffer";
import { clearCache } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  logEvent("info", "admin", "manual draw triggered");
  try {
    const result = await runLotteryRound({ debug: true });
    // A round writes rows, payouts and a new prize-pool balance — every cached
    // public/admin payload is now stale.
    clearCache();
    if (result.status === "failed") {
      logEvent(
        "error",
        "admin",
        `manual draw #${result.roundNumber} failed: ${result.error ?? "unknown"}`
      );
    } else if (result.status === "skipped") {
      logEvent(
        "info",
        "admin",
        `manual draw #${result.roundNumber} skipped — ${result.error ?? "pool below minimum"}`
      );
    } else {
      logEvent(
        "success",
        "admin",
        `manual draw #${result.roundNumber} done — ${result.winners.length} winners, pool ${result.prizePoolLamports} lamports`
      );
    }
    // "skipped" is an intentional no-op (HTTP 200), not a server error.
    const status = result.status === "failed" ? 500 : 200;
    return NextResponse.json(result, { status });
  } catch (e) {
    logEvent("error", "admin", `manual draw threw: ${(e as Error).message}`);
    return NextResponse.json(
      { status: "failed", error: (e as Error).message },
      { status: 500 }
    );
  }
}
