import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { lamportsToSol } from "@/lib/format";
import { effectiveMinEligibleBigint } from "@/lib/settings";
import { cached } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUBLIC aggregated stats.
 *
 * Why this route exists: `/api/rounds` is capped at 50 rows (it feeds the Draws
 * list, not a dashboard). With the draw cron running hourly that is barely two
 * days of history, so "total draws / total paid" computed from it silently
 * stopped growing and the 30-day chart only ever had a couple of bars. Here the
 * totals come from DB aggregates over ALL rounds, and the 30-day timeline is a
 * separate narrow query (no winners, no drand signatures), so the payload stays
 * small no matter how much history accumulates.
 *
 * Everything is bucketed in UTC so the server-rendered day keys/labels match
 * whatever timezone the visitor's browser is in — no client-side re-bucketing.
 */

/** Days covered by the timeline + charts. */
const WINDOW_DAYS = 30;

/** Statuses the public page knows how to describe. */
const PUBLIC_STATUSES = ["completed", "failed", "skipped"] as const;

type DayBucket = {
  key: string;
  label: string;
  /** Draws that finished that day, regardless of outcome. */
  draws: number;
  completed: number;
  skipped: number;
  failed: number;
  /** Pool of the completed draws (includes the platform fee cut). */
  prizeSol: number;
  /** Platform fee kept back from those pools. */
  feeSol: number;
  /** Average eligible wallets per completed draw (0 when none ran). */
  eligibleAvg: number;
  /** Largest eligible count of the day — the day's reachable pool size. */
  eligiblePeak: number;
};

const dayKeyUtc = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;

const dayLabelUtc = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** UTC midnight for the first day of the window (today - 29d). */
function windowStartUtc(): Date {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(start - (WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000);
}

/**
 * Per-day eligible-wallet history from the holder snapshots.
 *
 * Draw-time `eligibleCount` only exists on days a draw ran, and summing or
 * averaging it across draws double-counts the same wallets. The snapshots are a
 * cleaner source: the sync cron writes a full batch every few minutes, so for
 * each UTC day we use the day's MOST COMPLETE batch (a partial write would
 * otherwise draw a cliff: a 5-row batch after a 444-row one reads as 95 → 4
 * eligible overnight) and count wallets whose summed balance meets the current
 * threshold. One batch per day (~30 batches) keeps this cheap; every batch would
 * be 288x the rows for no extra information on a 30-day chart.
 *
 * Returns null when the raw query fails (e.g. schema drift) — the page then
 * falls back to the per-draw eligible series instead of showing an error.
 */
async function loadHolderHistory(
  start: Date
): Promise<{ key: string; eligible: number; total: number }[] | null> {
  try {
    const threshold = await effectiveMinEligibleBigint();
    const rows = await prisma.$queryRaw<
      { key: string; eligible: number; total: number }[]
    >`
      WITH daycap AS (
        SELECT (date_trunc('day', "capturedAt" AT TIME ZONE 'UTC'))::date AS d,
               "capturedAt" AS cap,
               ROW_NUMBER() OVER (
                 PARTITION BY (date_trunc('day', "capturedAt" AT TIME ZONE 'UTC'))::date
                 ORDER BY COUNT(*) DESC, "capturedAt" DESC
               ) AS rn
        FROM "HolderSnapshot"
        WHERE "capturedAt" >= ${start}
        GROUP BY 1, 2
      ), chosen AS (
        SELECT d, cap FROM daycap WHERE rn = 1
      ), per_wallet AS (
        SELECT c.d AS d, s."holderAddress" AS address, SUM(s."amount") AS amt
        FROM "HolderSnapshot" s
        JOIN chosen c ON s."capturedAt" = c.cap
        GROUP BY c.d, s."holderAddress"
      )
      SELECT to_char(d, 'YYYY-MM-DD') AS key,
             COUNT(*) FILTER (WHERE amt >= ${threshold})::int AS eligible,
             COUNT(*)::int AS total
      FROM per_wallet
      GROUP BY d
      ORDER BY d
    `;
    return rows;
  } catch {
    return null;
  }
}


async function buildStats() {
  const network = (process.env.SOLANA_NETWORK || "mainnet") as "mainnet" | "devnet";
  const start = windowStartUtc();

  try {
    // ---- all-time totals ------------------------------------------------
    const completedAgg = await prisma.lotteryRound.aggregate({
      where: { status: "completed" },
      _count: { _all: true },
      _sum: {
        prizePoolLamports: true,
        platformFeeLamports: true,
        payoutFeeLamports: true,
      },
      _max: { prizePoolLamports: true, completedAt: true },
      _avg: { eligibleCount: true },
    });

    const draws = completedAgg._count._all;
    const prizeSol = lamportsToSol(completedAgg._sum.prizePoolLamports ?? 0n);
    const biggestPrize = lamportsToSol(completedAgg._max.prizePoolLamports ?? 0n);

    // ---- draw outcomes (completed / skipped / failed) --------------------
    const statusRows = await prisma.lotteryRound.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const statusCounts = statusRows
      .filter((r) => (PUBLIC_STATUSES as readonly string[]).includes(r.status))
      .map((r) => ({ status: r.status, count: r._count._all }));

    // ---- winners --------------------------------------------------------
    const winnerScope = { round: { status: "completed" } } as const;
    const winnersAgg = await prisma.winner.aggregate({
      where: winnerScope,
      _count: { _all: true },
    });
    const paidAgg = await prisma.winner.aggregate({
      where: { ...winnerScope, status: "sent" },
      _count: { _all: true },
      _sum: { amountLamports: true },
    });
    const payoutStatusRows = await prisma.winner.groupBy({
      by: ["status"],
      where: winnerScope,
      _count: { _all: true },
    });

    // One row per winning wallet (all-time) — unique count, repeat wins and
    // the leaderboard all come from this single grouped query.
    const perWallet = await prisma.winner.groupBy({
      by: ["address"],
      where: winnerScope,
      _sum: { amountLamports: true },
      _count: { _all: true },
    });
    const sortedWallets = [...perWallet].sort(
      (a, b) => Number(b._sum.amountLamports ?? 0n) - Number(a._sum.amountLamports ?? 0n)
    );
    const topWallets = sortedWallets.slice(0, 8);

    // `lastRound` cannot come out of groupBy (only aggregates can), so resolve
    // it for the 8 leaderboard rows only.
    const lastRounds = topWallets.length
      ? await prisma.winner.findMany({
          where: { address: { in: topWallets.map((w) => w.address) }, ...winnerScope },
          select: { address: true, round: { select: { roundNumber: true } } },
        })
      : [];
    const lastRoundByAddress = new Map<string, number>();
    for (const row of lastRounds) {
      lastRoundByAddress.set(
        row.address,
        Math.max(lastRoundByAddress.get(row.address) ?? 0, row.round.roundNumber)
      );
    }

    const totalWinners = winnersAgg._count._all;
    const leaderboard = topWallets.map((w) => ({
      address: w.address,
      totalSol: lamportsToSol(w._sum.amountLamports ?? 0n),
      wins: w._count._all,
      lastRound: lastRoundByAddress.get(w.address) ?? 0,
    }));

    // ---- 30-day timeline (narrow columns only) ---------------------------
    const windowRounds = await prisma.lotteryRound.findMany({
      where: {
        OR: [
          { completedAt: { gte: start } },
          { completedAt: null, startedAt: { gte: start } },
        ],
      },
      select: {
        status: true,
        prizePoolLamports: true,
        platformFeeLamports: true,
        eligibleCount: true,
        startedAt: true,
        completedAt: true,
      },
    });

    // Pre-seed every day of the window so days with no draw are still present
    // (a gap in the chart means "nothing finished", not "we forgot the day").
    const buckets = new Map<
      string,
      DayBucket & { eligibleSum: number }
    >();
    for (let i = 0; i < WINDOW_DAYS; i++) {
      const d = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
      const key = dayKeyUtc(d);
      buckets.set(key, {
        key,
        label: dayLabelUtc(d),
        draws: 0,
        completed: 0,
        skipped: 0,
        failed: 0,
        prizeSol: 0,
        feeSol: 0,
        eligibleAvg: 0,
        eligiblePeak: 0,
        eligibleSum: 0,
      });
    }
    for (const r of windowRounds) {
      const at = r.completedAt ?? r.startedAt;
      const bucket = buckets.get(dayKeyUtc(at));
      if (!bucket) continue;
      bucket.draws += 1;
      if (r.status === "completed") {
        bucket.completed += 1;
        bucket.prizeSol += lamportsToSol(r.prizePoolLamports ?? 0n);
        bucket.feeSol += lamportsToSol(r.platformFeeLamports ?? 0n);
        bucket.eligibleSum += r.eligibleCount;
        bucket.eligiblePeak = Math.max(bucket.eligiblePeak, r.eligibleCount);
      } else if (r.status === "skipped") {
        bucket.skipped += 1;
      } else if (r.status === "failed") {
        bucket.failed += 1;
      }
    }
    const daily: DayBucket[] = Array.from(buckets.values()).map((b) => ({
      key: b.key,
      label: b.label,
      draws: b.draws,
      completed: b.completed,
      skipped: b.skipped,
      failed: b.failed,
      prizeSol: b.prizeSol,
      feeSol: b.feeSol,
      eligibleAvg: b.completed ? Math.round(b.eligibleSum / b.completed) : 0,
      eligiblePeak: b.eligiblePeak,
    }));

    const holdersDaily = await loadHolderHistory(start);

    return {
      network,
      windowDays: WINDOW_DAYS,
      generatedAt: new Date().toISOString(),
      totals: {
        draws,
        winners: totalWinners,
        paidSol: lamportsToSol(paidAgg._sum.amountLamports ?? 0n),
        paidCount: paidAgg._count._all,
        prizeSol,
        biggestPrize,
        avgPrize: draws ? prizeSol / draws : 0,
        avgEligible: Math.round(completedAgg._avg.eligibleCount ?? 0),
        platformFeesSol: lamportsToSol(completedAgg._sum.platformFeeLamports ?? 0n),
        payoutFeesSol: lamportsToSol(completedAgg._sum.payoutFeeLamports ?? 0n),
        uniqueWinners: perWallet.length,
        repeatWins: Math.max(0, totalWinners - perWallet.length),
        lastDrawAt: completedAgg._max.completedAt
          ? completedAgg._max.completedAt.toISOString()
          : null,
      },
      statusCounts,
      payoutStatusCounts: payoutStatusRows.map((r) => ({
        status: r.status,
        count: r._count._all,
      })),
      daily,
      holdersDaily,
      leaderboard,
      dbError: null,
    };
  } catch {
    return {
      network,
      windowDays: WINDOW_DAYS,
      generatedAt: new Date().toISOString(),
      totals: null,
      statusCounts: [],
      payoutStatusCounts: [],
      daily: [],
      holdersDaily: null,
      leaderboard: [],
      // Public endpoint: never echo the driver message (it can carry host,
      // table and column names). The page only needs to know it failed.
      dbError: "unavailable",
    };
  }
}

/**
 * Cached 30 s: this is an aggregate dashboard (8 queries incl. a raw
 * holder-history CTE) while the numbers only move when a draw completes.
 */
export async function GET() {
  return NextResponse.json(await cached("stats", 30_000, buildStats));
}

