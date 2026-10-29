import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toBigInt } from "@/lib/db-amount";
import { lamportsToSol } from "@/lib/format";
import { cached } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every completed draw that actually paid out, with only the receipt figures the
 * treasury tables need.
 *
 * Why it exists: `/treasury` used to build both ledgers from `/api/rounds`, which
 * returns 50 rows (with every winner in each) — so the tables silently stopped at
 * the 50th draw and the payload carried far more than two numbers per row. This
 * endpoint has no cap, no winners array, and is cached like the rest of the
 * read path.
 *
 * Scope: draw receipts only (the atomic payout tx moves prizes + the fee sweep).
 * SOL movements that aren't draws — top-ups, manual sends — need a wallet
 * indexer and are deliberately out of scope.
 */
async function buildLedger() {
  try {
    const rows = await prisma.lotteryRound.findMany({
      where: { status: "completed", payoutTx: { not: null } },
      orderBy: { roundNumber: "desc" },
      select: {
        roundNumber: true,
        completedAt: true,
        startedAt: true,
        payoutTx: true,
        prizePoolLamports: true,
        platformFeeLamports: true,
        payoutFeeLamports: true,
        winners: { select: { amountLamports: true } },
      },
    });

    return {
      rows: rows.map((r) => {
        const paid = r.winners.reduce((sum, w) => sum + toBigInt(w.amountLamports), 0n);
        const fee = toBigInt(r.platformFeeLamports);
        const pool = toBigInt(r.prizePoolLamports);
        // Winner rows are authoritative; pool − fee covers rounds recorded
        // before those snapshots were kept.
        const payout = paid > 0n ? paid : pool > fee ? pool - fee : 0n;
        return {
          roundNumber: r.roundNumber,
          at: (r.completedAt ?? r.startedAt).toISOString(),
          payoutTx: r.payoutTx as string,
          paidSol: lamportsToSol(payout),
          feeSol: lamportsToSol(fee),
          payoutFeeSol: r.payoutFeeLamports ? lamportsToSol(r.payoutFeeLamports) : 0,
        };
      }),
      count: rows.length,
      dbError: null as string | null,
    };
  } catch (e) {
    return { rows: [], count: 0, dbError: (e as Error).message };
  }
}

export async function GET() {
  return NextResponse.json(await cached("treasury:ledger", 15_000, buildLedger));
}
