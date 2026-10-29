import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-guard";
import { getCreatorFeeStatus } from "@/lib/pumpfun/creator-fees";
import { cached } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/creator-fees
 *
 * Claimable creator-fee status for the admin card: pumpdev balances, the
 * on-chain shareholder split, the platform wallet's SOL balance, the persisted
 * auto-claim toggle and the last few claim rows.
 *
 * Cached for 20 s (stale up to 40 s while refreshing): building this costs 3
 * sequential DB/RPC steps plus a pumpdev.io HTTP round-trip, and the card polls
 * it every 60 s. Claim/auto routes call clearCache() so an action is visible
 * immediately.
 */
export async function GET(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(
      await cached(
        "admin:creator-fees",
        { ttlMs: 20_000, staleMs: 40_000 },
        getCreatorFeeStatus
      )
    );
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
