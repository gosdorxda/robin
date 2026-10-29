import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-guard";
import { getConfig } from "@/lib/config";
import { effectiveValue } from "@/lib/settings";
import { lamportsToSol } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { activeTokenAddress, getChain } from "@/lib/chain";
import { toBaseUnitString } from "@/lib/db-amount";
import { cached } from "@/lib/cache";
import {
  DRAND_CHAIN,
  DRAND_CHAIN_HASH,
  DRAND_PUBLIC_KEY,
  DRAND_SCHEME,
  DRAND_PERIOD,
} from "@/lib/solana/randomness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Shows only host+db from a postgres DATABASE_URL, hiding user/password. */
function maskDbUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.hostname;
    const port = u.port ? `:${u.port}` : "";
    const db = u.pathname || "/";
    return `${host}${port}${db}`;
  } catch {
    return "(invalid DATABASE_URL)";
  }
}

/**
 * Admin-only app info: platform wallet (address + live SOL balance) and a
 * display-safe snapshot of every env-configurable field, plus the drand chain
 * audit metadata. Secrets are never returned (only "set / not set" booleans or
 * masked hosts). All Solana-dependent parts are guarded so a dev preview
 * without secrets still returns the env fields instead of 500ing.
 */
export async function GET(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 5 s TTL: the admin tiles show live-ish balances/history, but /admin also
  // refreshes on every action — this keeps the 6 round-trips off the critical
  // path while staying fresh enough to watch a draw land.
  const body = await cached("admin:info", 5_000, buildInfo);
  return NextResponse.json(body);
}

/** Builds the payload (no auth — the exported GET checks the session first). */
async function buildInfo() {
  const network = (process.env.SOLANA_NETWORK || "mainnet") as
    | "mainnet"
    | "devnet";
  const tokenMint = activeTokenAddress();
  const tokenDecimals = Number(process.env.TOKEN_DECIMALS ?? 6);
  const lotteryCron = effectiveValue("LOTTERY_CRON");
  const holderSyncCron = effectiveValue("HOLDER_SYNC_CRON");
  const lotteryEnabled =
    process.env.NODE_ENV === "production" ||
    effectiveValue("LOTTERY_CRON_ENABLED") === "true";
  const minTokenEligibleRaw = BigInt(effectiveValue("MIN_TOKEN_ELIGIBLE"));
  const winnerCount = Number(effectiveValue("WINNER_COUNT"));
  const payoutDistribution = effectiveValue("PAYOUT_DISTRIBUTION")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => !isNaN(n));
  const platformFeeBps = Math.max(
    0,
    Math.min(10000, Number(effectiveValue("PLATFORM_FEE_BPS")))
  );
  const adminUsername = process.env.ADMIN_USERNAME || "admin";
  const heliusApiKeySet = !!(
    process.env.HELIUS_API_KEY && process.env.HELIUS_API_KEY.trim().length > 0
  );
  const publicRpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "";
  const dbUrlMasked = process.env.DATABASE_URL
    ? maskDbUrl(process.env.DATABASE_URL)
    : null;

  // Humanize min token eligible using token decimals.
  let minTokenHuman = minTokenEligibleRaw.toString();
  try {
    const denom = 10n ** BigInt(tokenDecimals);
    const whole = minTokenEligibleRaw / denom;
    const frac = minTokenEligibleRaw % denom;
    minTokenHuman = `${whole.toLocaleString("en-US")}.${frac
      .toString()
      .padStart(tokenDecimals, "0")
      .slice(0, 4)}`;
  } catch {
    /* keep raw */
  }

  // Server RPC URL + prize reserve from getConfig (guarded).
  let rpcUrl: string | null = null;
  let prizeReserveSol = 0;
  try {
    const cfg = getConfig();
    rpcUrl = cfg.rpcUrl;
    prizeReserveSol = lamportsToSol(cfg.prizeReserveLamports);
  } catch {
    // getConfig not ready (missing secrets in dev) — leave nulls.
  }

  // Platform wallet address (no RPC) + live native balance. Both go through the
  // chain adapter, so this works on EVM too — it used to build a Solana keypair +
  // Connection and showed "—" on Robinhood Chain.
  let platformWallet: { address: string; solBalance: number | null } | null =
    null;
  try {
    const chain = getChain();
    const address = chain.platformAddress();
    let solBalance: number | null = null;
    try {
      solBalance = lamportsToSol(await chain.getNativeBalance(address));
    } catch {
      /* RPC down — address still shown */
    }
    platformWallet = { address, solBalance };
  } catch {
    /* platform wallet not configured */
  }

  // Optional fee treasury wallet — address from the chain adapter (Solana:
  // PLATFORM_TREASURY_SECRET, EVM: PLATFORM_TREASURY_PRIVATE_KEY) + live balance.
  let treasuryWallet: { address: string; solBalance: number | null } | null =
    null;
  try {
    const chain = getChain();
    const treasury = chain.treasuryAddress?.() ?? null;
    if (treasury) {
      let solBalance: number | null = null;
      try {
        solBalance = lamportsToSol(await chain.getNativeBalance(treasury));
      } catch {
        /* RPC down — address still shown */
      }
      treasuryWallet = { address: treasury, solBalance };
    }
  } catch {
    /* treasury not configured */
  }

  // Whether a draw is currently executing (a round sitting in "drawing" status
  // — set by the engine at round create, cleared when it completes/fails).
  let drawingRoundNumber: number | null = null;
  let totalPlatformFeeLamports = "0";
  let totalPaidLamports = "0";
  let totalWinnerWallets = 0;
  // Per-status round counts for the admin "Round stats" tiles. The engine now
  // records "skipped" rounds (effective prize below MIN_PRIZE_SOL), so surfacing
  // completed vs skipped vs failed lets admins see skip frequency at a glance.
  let totalCompletedRounds = 0;
  let totalSkippedRounds = 0;
  let totalFailedRounds = 0;
  // Readable SOL values for MAX_PRIZE_SOL / MIN_PRIZE_SOL (read from env like the
  // engine does). 0 disables the cap / minimum respectively.
  const maxPrizeSol = Number(effectiveValue("MAX_PRIZE_SOL")) || 0;
  const minPrizeSol = Number(effectiveValue("MIN_PRIZE_SOL")) || 0;
  try {
    // One round-trip instead of five: these queries are independent and each
    // costs a full RTT to Neon (~240 ms), so serially they dominated the admin
    // dashboard's load time.
    const [drawing, feeSum, paidSum, distinctWinners, roundsByStatus] =
      await Promise.all([
        prisma.lotteryRound.findFirst({
          where: { status: "drawing" },
          orderBy: { roundNumber: "desc" },
          select: { roundNumber: true },
        }),
        prisma.lotteryRound.aggregate({
          _sum: { platformFeeLamports: true },
        }),
        prisma.winner.aggregate({
          _sum: { amountLamports: true },
          where: { status: "sent" },
        }),
        prisma.winner.groupBy({
          by: ["address"],
          _count: { _all: true },
        }),
        prisma.lotteryRound.groupBy({
          by: ["status"],
          _count: { _all: true },
        }),
      ]);
    drawingRoundNumber = drawing?.roundNumber ?? null;
    totalPlatformFeeLamports = toBaseUnitString(feeSum._sum.platformFeeLamports);
    totalPaidLamports = toBaseUnitString(paidSum._sum.amountLamports);
    totalWinnerWallets = distinctWinners.length;
    for (const r of roundsByStatus) {
      if (r.status === "completed") totalCompletedRounds = r._count._all;
      else if (r.status === "skipped") totalSkippedRounds = r._count._all;
      else if (r.status === "failed") totalFailedRounds = r._count._all;
    }
  } catch {
    /* db error — leave defaults */
  }

  return {
    network,
    platformWallet,
    treasuryWallet,
    rpcUrl,
    publicRpcUrl,
    heliusApiKeySet,
    tokenMint,
    tokenDecimals,
    lotteryCron,
    holderSyncCron,
    lotteryEnabled,
    minTokenEligibleRaw: minTokenEligibleRaw.toString(),
    minTokenHuman,
    winnerCount,
    payoutDistribution,
    prizeReserveSol,
    platformFeeBps,
    totalPlatformFeeLamports,
    totalPaidLamports,
    totalWinnerWallets,
    drawingRoundNumber,
    totalCompletedRounds,
    totalSkippedRounds,
    totalFailedRounds,
    maxPrizeSol,
    minPrizeSol,
    databaseUrl: dbUrlMasked,
    adminUsername,
    drand: {
      name: DRAND_CHAIN,
      hash: DRAND_CHAIN_HASH,
      publicKey: DRAND_PUBLIC_KEY,
      scheme: DRAND_SCHEME,
      period: DRAND_PERIOD,
      verifyBaseUrl: `https://api.drand.sh/${DRAND_CHAIN_HASH}/public`,
    },
  };
}
