import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-guard";
import { claimCreatorFees } from "@/lib/pumpfun/creator-fees";
import { clearCache } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Allow the full build → sign → send → confirm cycle (60s poll). */
export const maxDuration = 90;

/**
 * POST /api/admin/creator-fees/claim
 *
 * Manual "Claim now" from the admin card. Builds the pumpdev transaction,
 * signs it with the platform wallet, sends it and waits for confirmation.
 * Returns `{ ok, signature, amountLamports, recipient }` on success, or
 * `{ ok: false, error, skipped }` when nothing was sent (no fees, below
 * threshold, wallet too poor for the fee, or another claim in flight).
 */
export async function POST(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await claimCreatorFees({ source: "manual" });
    // Fees/balances just moved — drop cached payloads so the card and the
    // status tiles show the post-claim numbers immediately.
    clearCache();
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 }
    );
  }
}
