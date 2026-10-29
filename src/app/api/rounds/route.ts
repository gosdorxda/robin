import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { lamportsToSol } from "@/lib/format";
import { toBaseUnitString } from "@/lib/db-amount";
import {
  DRAND_CHAIN,
  DRAND_CHAIN_HASH,
  DRAND_PUBLIC_KEY,
  DRAND_SCHEME,
  DRAND_PERIOD,
} from "@/lib/solana/randomness";
import { cached } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUBLIC draw history + drand audit metadata.
 * No auth — this is the public transparency surface: anyone can fetch this and
 * independently verify every past draw against the drand public beacon.
 */
/** Settled = the engine wrote a final row (skipped/failed included on purpose). */
const SETTLED = ["completed", "failed", "skipped"] as const;
type StatusFilter = "all" | (typeof SETTLED)[number];

const MAX_LIMIT = 100;

/** Median gap between consecutive settled rounds — this is the real cadence. */
function medianGapMs(times: Date[]): number | null {
  if (times.length < 2) return null;
  const ts = times.map((t) => t.getTime()).sort((a, b) => a - b);
  const diffs: number[] = [];
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i] - ts[i - 1];
    if (gap > 0) diffs.push(gap);
  }
  if (diffs.length === 0) return null;
  diffs.sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  return diffs.length % 2
    ? diffs[mid]
    : Math.round((diffs[mid - 1] + diffs[mid]) / 2);
}

/**
 * Paginated on the server (2026-10-26): `/draws` used to show only the newest 50
 * rows (`take: 50`), so older draws were unreachable and every header figure was
 * really "within the last 50". Query params: `limit` 1–100 (default 50),
 * `offset` (default 0), `status` `all|completed|failed|skipped`. The response
 * always carries all-time totals, so a page can say "draw 412 of 412" without
 * summing its own slice.
 */
async function buildRounds({
  status,
  limit,
  offset,
}: {
  status: StatusFilter;
  limit: number;
  offset: number;
}) {
  const network = (process.env.SOLANA_NETWORK || "mainnet") as
    | "mainnet"
    | "devnet";

  const where =
    status === "all" ? { status: { in: [...SETTLED] } } : { status };

  let rounds: unknown[] = [];
  let total = 0;
  let totals = { all: 0, completed: 0, failed: 0, skipped: 0, paidSol: 0 };
  let cadenceMs: number | null = null;
  let latest: { roundNumber: number; status: string; at: string | null } | null =
    null;
  let dbError: string | null = null;
  try {
    const [rows, count, byStatus, newest, paid, recentTimes] = await Promise.all([
      prisma.lotteryRound.findMany({
        where,
        orderBy: { roundNumber: "desc" },
        skip: offset,
        take: limit,
        include: { winners: { orderBy: { rank: "asc" } } },
      }),
      prisma.lotteryRound.count({ where }),
      prisma.lotteryRound.groupBy({
        by: ["status"],
        where: { status: { in: [...SETTLED] } },
        _count: { _all: true },
      }),
      prisma.lotteryRound.findFirst({
        where: { status: { in: [...SETTLED] } },
        orderBy: { roundNumber: "desc" },
        select: {
          roundNumber: true,
          status: true,
          completedAt: true,
          startedAt: true,
        },
      }),
      // All-time money that actually left the wallets (atomic payout txs only).
      prisma.winner.aggregate({
        where: { status: "sent", round: { status: "completed" } },
        _sum: { amountLamports: true },
      }),
      // Cadence sample: timestamps only, last 60 settled rounds (skips included,
      // because a skipped tick still proves the cron fired).
      prisma.lotteryRound.findMany({
        where: { status: { in: [...SETTLED] } },
        orderBy: { roundNumber: "desc" },
        take: 60,
        select: { startedAt: true },
      }),
    ]);
    const n = (s: string) => byStatus.find((g) => g.status === s)?._count._all ?? 0;
    total = count;
    totals = {
      all: byStatus.reduce((sum, g) => sum + g._count._all, 0),
      completed: n("completed"),
      failed: n("failed"),
      skipped: n("skipped"),
      paidSol: lamportsToSol(paid._sum.amountLamports ?? 0n),
    };
    if (newest) {
      latest = {
        roundNumber: newest.roundNumber,
        status: newest.status,
        at: (newest.completedAt ?? newest.startedAt).toISOString(),
      };
    }
    cadenceMs = medianGapMs(recentTimes.map((r) => r.startedAt));

    rounds = rows.map((r) => ({
      roundNumber: r.roundNumber,
      status: r.status,
      prizePoolSol: lamportsToSol(r.prizePoolLamports),
      eligibleCount: r.eligibleCount,
      startedAt: r.startedAt.toISOString(),
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      randomnessValue: r.randomnessValue,
      randomnessSignature: r.randomnessSignature,
      randomnessRound: r.randomnessRound,
      randomnessVerified: r.randomnessVerified,
      error: r.error,
      payoutTx: r.payoutTx,
      payoutFeeLamports: r.payoutFeeLamports
        ? toBaseUnitString(r.payoutFeeLamports)
        : null,
      platformFeeLamports: r.platformFeeLamports
        ? toBaseUnitString(r.platformFeeLamports)
        : null,
      winners: r.winners.map((w) => ({
        rank: w.rank,
        address: w.address,
        amountSol: lamportsToSol(w.amountLamports),
        payoutTx: w.payoutTx,
        status: w.status,
      })),
    }));
  } catch (e) {
    dbError = (e as Error).message;
  }

  return {
    network,
    chain: {
      name: DRAND_CHAIN,
      hash: DRAND_CHAIN_HASH,
      publicKey: DRAND_PUBLIC_KEY,
      scheme: DRAND_SCHEME,
      period: DRAND_PERIOD,
      verifyBaseUrl: `https://api.drand.sh/${DRAND_CHAIN_HASH}/public`,
    },
    rounds,
    total,
    totals,
    latest,
    cadenceMs,
    limit,
    offset,
    hasMore: offset + rounds.length < total,
    dbError,
  };
}

/**
 * Cached 15 s per (status, limit, offset): rounds only change when a draw
 * finishes (cron), yet every visit re-queried a page with all winners included.
 */
export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;

  const rawStatus = params.get("status");
  const status: StatusFilter =
    rawStatus === "completed" || rawStatus === "failed" || rawStatus === "skipped"
      ? rawStatus
      : "all";

  const rawLimit = Number(params.get("limit") ?? 50);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(rawLimit)))
    : 50;
  const rawOffset = Number(params.get("offset") ?? 0);
  const offset = Number.isFinite(rawOffset)
    ? Math.max(0, Math.floor(rawOffset))
    : 0;

  return NextResponse.json(
    await cached(`rounds:${status}:${limit}:${offset}`, 15_000, () =>
      buildRounds({ status, limit, offset })
    )
  );
}
