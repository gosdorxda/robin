import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { lamportsToSol } from "@/lib/format";
import { getCreatorFeeStatus } from "@/lib/pumpfun/creator-fees";
import { getPonsFeeSummary } from "@/lib/pons/creator-fees";
import { CHAIN_KIND, getChain } from "@/lib/chain";
import { cached } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/creator-fees — public, minimal view of the creator-fee pot.
 *
 * The homepage prize-pool card shows two figures: how much creator fee is still
 * sitting on pump.fun (not yet swept into the prize pool) and when the last sweep
 * landed. That is a trust signal — "100% of creator fees go to the pool" is only
 * believable if you can see the money moving — so this route exposes the numbers
 * and nothing else: no wallet addresses, no signatures, no error internals.
 *
 * Cost: one pumpdev.io round-trip plus two DB reads, hence the 60 s cache. Claim
 * routes call `clearCache()`, so a fresh claim shows up immediately.
 */
async function build() {
  /**
   * Robinhood Chain: the pot lives on **pons**, and pumpdev exposes a read-only
   * PONS API on its own host (`rhc.pumpdev.io`). The owner claims manually, so
   * this branch never builds a transaction — it just reports the real numbers:
   * `claimable = escrow (already swept by pons) + pending (still on the curves of
   * PONS_TOKENS)`. Same field names as the pump.fun branch so the homepage tile
   * needs no change.
   */
  if (CHAIN_KIND !== "solana") {
    const summary = await getPonsFeeSummary(getChain().platformAddress());
    return {
      claimableSol: summary.claimableSol,
      pumpSol: summary.escrowSol,
      pumpSwapSol: summary.pendingSol,
      autoEnabled: false,
      autoMinSol: null,
      checkedAt: summary.checkedAt,
      lastClaimed: null,
      error: summary.error,
      source: "pons" as const,
      feeBps: summary.feeBps,
      tokens: summary.tokens,
    };
  }

  let claimableSol: number | null = null;
  let pumpSol: number | null = null;
  let pumpSwapSol: number | null = null;
  let autoEnabled = false;
  let autoMinSol: number | null = null;
  let checkedAt: string | null = null;
  let error: string | null = null;

  try {
    const status = await getCreatorFeeStatus();
    autoEnabled = status.auto.enabled;
    autoMinSol = status.auto.minSol;
    // `error` here means "snapshot unavailable" (API down / non-mainnet) — the
    // UI then shows a dash rather than a zero.
    error = status.error;
    if (status.snapshot) {
      claimableSol = lamportsToSol(BigInt(status.snapshot.totalLamports));
      pumpSol = lamportsToSol(BigInt(status.snapshot.pumpLamports));
      pumpSwapSol = lamportsToSol(BigInt(status.snapshot.pumpSwapLamports));
      checkedAt = status.snapshot.checkedAt;
    }
  } catch (e) {
    error = (e as Error).message;
  }

  // Only confirmed claims count: a failed attempt must never read as "claimed".
  let lastClaimed: {
    at: string;
    amountSol: number;
    source: string;
  } | null = null;
  try {
    const row = await prisma.creatorFeeClaim.findFirst({
      where: { status: "confirmed" },
      orderBy: [{ confirmedAt: "desc" }, { createdAt: "desc" }],
      select: {
        amountLamports: true,
        confirmedAt: true,
        createdAt: true,
        source: true,
      },
    });
    if (row) {
      lastClaimed = {
        at: (row.confirmedAt ?? row.createdAt).toISOString(),
        amountSol: lamportsToSol(row.amountLamports),
        source: row.source,
      };
    }
  } catch (e) {
    error = error ?? (e as Error).message;
  }

  return {
    claimableSol,
    pumpSol,
    pumpSwapSol,
    autoEnabled,
    autoMinSol,
    checkedAt,
    lastClaimed,
    error,
  };
}

export async function GET() {
  return NextResponse.json(await cached("creator-fees:public", 60_000, build));
}
