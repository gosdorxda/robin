import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { lamportsToSol } from "@/lib/format";
import { CHAIN_KIND, NATIVE_SYMBOL, getChain, type ChainKind } from "@/lib/chain";
import {
  effectiveValue,
  getEffectiveConfig,
} from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PUBLIC treasury overview for the /stats page: the platform (hot) wallet and
 * the optional platform-fee treasury wallet — address + live SOL balance — plus
 * the cumulative fee ledger (Σ `platformFeeLamports` over every recorded round).
 *
 * Only public, on-chain data is exposed (addresses, balances, fee totals). No
 * secrets, no signer material.
 *
 * Balances change only when SOL moves, so the whole snapshot is cached for 15s
 * in-process — same pattern as /api/status. Without it, every /stats mount
 * would cost 2 Solana RPC round-trips.
 */
const CACHE_TTL_MS = 15_000;

type WalletInfo = {
  address: string | null;
  balanceSol: number | null;
};

type FeeWalletInfo = WalletInfo & {
  /** True when PLATFORM_TREASURY_SECRET is set (fees are swept off-chain of the
   *  platform wallet into this treasury at payout time). When false the fee
   *  simply accumulates on the platform wallet (legacy behaviour). */
  configured: boolean;
  /** Lifetime platform fee recorded across all rounds (SOL). */
  totalEarnedSol: number;
  /** Number of rounds that actually recorded a fee > 0. */
  sweeps: number;
  /** False when the DB aggregate failed — the UI shows "—" instead of 0. */
  ledgerAvailable: boolean;
};

export type WalletOverview = {
  network: "mainnet" | "devnet";
  /** Chain + native unit this snapshot describes (UI switches labels in Phase 3). */
  chain: ChainKind;
  nativeSymbol: string;
  /** Reserve kept on the platform wallet for fees/rent (SOL). */
  reserveSol: number;
  /** Effective platform fee in basis points (100 = 1%). */
  feeBps: number;
  platform: WalletInfo;
  fee: FeeWalletInfo;
  generatedAt: string;
  /** Human-readable reason when part of the snapshot could not be read. */
  error: string | null;
};

let cache: { payload: WalletOverview; ts: number } | null = null;

async function buildOverview(): Promise<WalletOverview> {
  const network = (process.env.SOLANA_NETWORK || "mainnet") as
    | "mainnet"
    | "devnet";
  const feeBps = Math.max(
    0,
    Math.min(10000, Number(effectiveValue("PLATFORM_FEE_BPS")) || 0)
  );

  let reserveSol = 0.05;
  try {
    const cfg = await getEffectiveConfig();
    reserveSol = lamportsToSol(cfg.prizeReserveLamports);
  } catch {
    /* config not ready (missing secrets in dev) — keep the 0.05 default */
  }

  const notes: string[] = [];

  // Platform (hot) wallet: address + native balance, both through the chain
  // adapter (Solana keypair / EVM private key) so /treasury works on either chain.
  const platform: WalletInfo = { address: null, balanceSol: null };
  try {
    const chain = getChain();
    platform.address = chain.platformAddress();
    try {
      const bal = await chain.getNativeBalance(platform.address);
      platform.balanceSol = lamportsToSol(bal);
    } catch (e) {
      notes.push(`Platform balance: ${(e as Error).message}`);
    }
  } catch (e) {
    notes.push(`Platform wallet: ${(e as Error).message}`);
  }

  // Optional fee treasury wallet (address + balance). Null (not an error) when
  // unset — the fee then stays on the platform wallet.
  const fee: FeeWalletInfo = {
    address: null,
    balanceSol: null,
    configured: false,
    totalEarnedSol: 0,
    sweeps: 0,
    ledgerAvailable: false,
  };

  // Fee treasury address comes from the chain adapter — Solana reads
  // PLATFORM_TREASURY_SECRET, EVM reads PLATFORM_TREASURY_PRIVATE_KEY (the key the
  // owner set). Null keeps the card hidden; on EVM the payout path sweeps the
  // platform fee to it as the first transaction.
  try {
    const chain = getChain();
    const treasury = chain.treasuryAddress?.() ?? null;
    if (treasury) {
      fee.configured = true;
      fee.address = treasury;
      try {
        fee.balanceSol = lamportsToSol(await chain.getNativeBalance(treasury));
      } catch (e) {
        notes.push(`Fee wallet balance: ${(e as Error).message}`);
      }
    }
  } catch (e) {
    notes.push(`Fee wallet: ${(e as Error).message}`);
  }

  // Cumulative fee ledger straight from the draw rows. `platformFeeLamports`
  // is written at draw time, so this is the authoritative fee history even if
  // the on-chain sweep tx isn't indexed anywhere yet.
  try {
    const [agg, sweeps] = await Promise.all([
      prisma.lotteryRound.aggregate({ _sum: { platformFeeLamports: true } }),
      prisma.lotteryRound.count({
        where: { platformFeeLamports: { gt: 0 } },
      }),
    ]);
    fee.totalEarnedSol = lamportsToSol(agg._sum.platformFeeLamports ?? 0n);
    fee.sweeps = sweeps;
    fee.ledgerAvailable = true;
  } catch (e) {
    notes.push(`Fee ledger: ${(e as Error).message}`);
  }

  return {
    network,
    chain: CHAIN_KIND,
    nativeSymbol: NATIVE_SYMBOL,
    reserveSol,
    feeBps,
    platform,
    fee,
    generatedAt: new Date().toISOString(),
    error: notes.length > 0 ? notes.join(" · ") : null,
  };
}

export async function GET() {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) {
    return NextResponse.json(cache.payload);
  }
  const payload = await buildOverview();
  cache = { payload, ts: now };
  return NextResponse.json(payload);
}
