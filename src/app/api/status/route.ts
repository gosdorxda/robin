import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { toBaseUnitString, toBigInt } from "@/lib/db-amount";
import { computePrizePool } from "@/lib/lottery/engine";
import { getConfig } from "@/lib/config";
import { lamportsToSol, fmtTokenHuman } from "@/lib/format";
import { CHAIN_KIND, NATIVE_SYMBOL, activeTokenAddress, getChain } from "@/lib/chain";
import { effectiveMinEligibleBigint } from "@/lib/settings";
import { getPlatformKeypair } from "@/lib/solana/connection";
import { getDrawExclusions } from "@/lib/exclusions";
import { cached } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * In-process TTL cache for the prize-pool balance. computePrizePool() makes a
 * Solana RPC round-trip (platform wallet balance) on every call, and /api/status
 * is fetched by AppShell on every page mount — without caching that means a
 * mainnet RPC hit per navigation. The balance only moves on deposits/payouts, so
 * a short TTL is safe and turns repeated status calls into an instant lookup.
 * Single-instance in-memory cache (fine for dev + a single prod node).
 */
const PRIZE_POOL_TTL_MS = 15_000;
let prizePoolCache: { value: bigint; ts: number } | null = null;

async function cachedPrizePool(): Promise<bigint> {
  const now = Date.now();
  if (prizePoolCache && now - prizePoolCache.ts < PRIZE_POOL_TTL_MS) {
    return prizePoolCache.value;
  }
  const value = await computePrizePool();
  prizePoolCache = { value, ts: now };
  return value;
}

async function buildStatus() {
  const network = (process.env.SOLANA_NETWORK || "mainnet") as
    | "mainnet"
    | "devnet";
  const tokenMint = activeTokenAddress();
  const lotteryCron = process.env.LOTTERY_CRON || "0 * * * *";
  const holderSyncCron = process.env.HOLDER_SYNC_CRON || "*/5 * * * *";
  const tokenDecimals = Number(process.env.TOKEN_DECIMALS ?? 6);
  const minTokenEligible = await effectiveMinEligibleBigint();

  let prizePoolLamports = "0";
  let prizePoolSol = 0;
  /**
   * Public, non-secret view of the NEXT round's economics. Computed with the
   * exact same rules the engine uses (lib/lottery/engine.ts): the pool is
   * capped by MAX_PRIZE_SOL, the platform fee is deducted first, and the
   * remainder is split by PAYOUT_DISTRIBUTION. Lets the homepage show a real
   * "1st place ≈" figure and an honest funded/below-minimum state without
   * duplicating that policy in the client. Null when config is unreadable.
   */
  let prize: {
    winnerCount: number;
    payoutDistribution: number[];
    effectivePoolSol: number;
    firstPrizeSol: number;
    minPrizeSol: number;
    playable: boolean;
  } | null = null;
  let eligibleCount = 0;
  let totalHolders = 0;
  /** Live wallets on the admin exclusion list (bonding curve, LP pools…). */
  let excludedCount = 0;
  /**
   * Cumulative `Holder` rows: every wallet EVER seen holding the token. This
   * keeps growing (wallets that sold out stay), so it is NOT the live holder
   * count and must not be used for the "Holders" tile — see `totalHolders`.
   */
  let knownHolders = 0;
  let lastRound: unknown = null;
  let lastSyncAt: string | null = null;
  let dbError: string | null = null;
  let solanaError: string | null = null;

  // Prize pool (needs full Solana config + RPC reachability).
  try {
    const pool = await cachedPrizePool();
    prizePoolLamports = pool.toString();
    prizePoolSol = lamportsToSol(pool);

    // Same pipeline as runLotteryRound: cap → fee → split.
    const cfg = getConfig();
    const effectivePool =
      cfg.maxPrizeLamports > 0n && pool > cfg.maxPrizeLamports
        ? cfg.maxPrizeLamports
        : pool;
    const feeLamports = (effectivePool * BigInt(cfg.platformFeeBps)) / 10000n;
    const distributable = effectivePool - feeLamports;
    // Shares are floats (0.5, 0.3, …); scale to 1e4 for integer lamport math.
    const firstShare = BigInt(
      Math.round((cfg.payoutDistribution[0] ?? 0) * 10_000)
    );
    const firstPrizeLamports = (distributable * firstShare) / 10_000n;

    prize = {
      winnerCount: cfg.winnerCount,
      payoutDistribution: cfg.payoutDistribution,
      effectivePoolSol: lamportsToSol(effectivePool),
      firstPrizeSol: lamportsToSol(firstPrizeLamports),
      minPrizeSol: lamportsToSol(cfg.minPrizeLamports),
      // Mirrors the engine skip rule: empty effective pool, or below MIN_PRIZE_SOL.
      playable:
        effectivePool > 0n &&
        !(cfg.minPrizeLamports > 0n && effectivePool < cfg.minPrizeLamports),
    };
  } catch (e) {
    solanaError = (e as Error).message;
  }

  // DB-backed stats. `totalHolders` / `eligibleCount` describe the LATEST
  // snapshot batch — the live holder set the next draw reads. They deliberately
  // do NOT come from the cumulative `Holder` table: that table keeps every
  // wallet ever seen (a sold-out wallet is never deleted), so counting it made
  // the admin "Holders" tile drift above what the holders tab and the draw pool
  // actually contain (observed: tile 4 vs. 2 live holders). The all-time figure
  // is still available as `knownHolders`.
  try {
    const [latestSnap, knownHolderCount, lr] = await Promise.all([
      prisma.holderSnapshot.findFirst({
        where: { chain: CHAIN_KIND },
        orderBy: { capturedAt: "desc" },
        select: { capturedAt: true },
      }),
      prisma.holder.count({ where: { chain: CHAIN_KIND } }),
      prisma.lotteryRound.findFirst({
        orderBy: { roundNumber: "desc" },
        include: { winners: { orderBy: { rank: "asc" } } },
      }),
    ]);

    knownHolders = knownHolderCount;
    lastSyncAt = latestSnap ? latestSnap.capturedAt.toISOString() : null;

    if (latestSnap) {
      const snaps = await prisma.holderSnapshot.findMany({
        where: { capturedAt: latestSnap.capturedAt, chain: CHAIN_KIND },
        select: { holderAddress: true, amount: true },
      });
      // Sum per wallet (a wallet's balance may come from several token
      // accounts; the sync already merges them, this keeps the math correct
      // regardless).
      const balances = new Map<string, bigint>();
      for (const s of snaps) {
        balances.set(
          s.holderAddress,
          (balances.get(s.holderAddress) ?? 0n) + toBigInt(s.amount)
        );
      }
      totalHolders = balances.size;

      // Mirror the engine's eligible pool EXACTLY: balance >= threshold AND the
      // wallet is neither the platform wallet (the prize pool is paid out of
      // that same wallet) nor on the admin exclusion list. Without this the
      // admin reported more eligible wallets than the next draw could pick.
      let platformAddress: string | null = null;
      try {
        platformAddress = getChain().platformAddress();
      } catch {
        /* platform keypair not configured on this deployment */
      }
      const excludedSet = new Set(await getDrawExclusions(platformAddress));
      for (const [address, amount] of balances) {
        if (address === platformAddress) continue;
        if (excludedSet.has(address)) {
          excludedCount++;
          continue;
        }
        if (amount >= minTokenEligible) eligibleCount++;
      }
    }

    if (lr) {
      lastRound = {
        roundNumber: lr.roundNumber,
        status: lr.status,
        prizePoolLamports: toBaseUnitString(lr.prizePoolLamports),
        prizePoolSol: lamportsToSol(lr.prizePoolLamports),
        // Platform revenue cut taken from this round's pool (lamports) — the
        // % of the pool kept on the platform wallet (or swept to treasury),
        // NOT paid to winners. Null for rounds drawn before PLATFORM_FEE_BPS.
        platformFeeLamports:
          lr.platformFeeLamports === null
            ? null
            : toBaseUnitString(lr.platformFeeLamports),
        eligibleCount: lr.eligibleCount,
        startedAt: lr.startedAt.toISOString(),
        completedAt: lr.completedAt ? lr.completedAt.toISOString() : null,
        randomnessValue: lr.randomnessValue,
        randomnessSignature: lr.randomnessSignature,
        randomnessRound: lr.randomnessRound,
        randomnessVerified: lr.randomnessVerified,
        error: lr.error,
        winners: lr.winners.map((w) => ({
          rank: w.rank,
          address: w.address,
          amountLamports: toBaseUnitString(w.amountLamports),
          amountSol: lamportsToSol(w.amountLamports),
          payoutTx: w.payoutTx,
          status: w.status,
        })),
      };
    }
  } catch (e) {
    dbError = (e as Error).message;
  }

  const configured = !solanaError && !dbError;

  return {
    configured,
    network,
    // Chain identity for the UI (additive; Phase 3 switches the labels on it).
    chain: CHAIN_KIND,
    nativeSymbol: NATIVE_SYMBOL,
    tokenMint,
    tokenDecimals,
    lotteryCron,
    holderSyncCron,
    minTokenEligibleRaw: minTokenEligible.toString(),
    minTokenEligibleHuman: fmtTokenHuman(minTokenEligible, tokenDecimals),
    prizePoolLamports,
    prizePoolSol,
    prize,
    eligibleCount,
    excludedCount,
    totalHolders,
    knownHolders,
    lastRound,
    lastSyncAt,
    dbError,
    solanaError,
  };
}

/**
 * Cached for 10 s: AppShell refetches this on every page mount (and the
 * homepage polls), while the payload only moves when a deposit, payout or
 * snapshot lands. Caching removes the RPC + 5-query rebuild per navigation.
 */
export async function GET() {
  return NextResponse.json(await cached("status", 10_000, buildStatus));
}
