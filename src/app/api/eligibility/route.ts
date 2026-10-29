import { NextRequest, NextResponse } from "next/server";
import { CHAIN_KIND, activeTokenAddress, getChain } from "@/lib/chain";
import { prisma } from "@/lib/prisma";
import { toBigInt } from "@/lib/db-amount";
import { fmtTokenHuman } from "@/lib/format";
import { effectiveMinEligibleBigint } from "@/lib/settings";
import { getVenueAccountMap } from "@/lib/exclusions";
import { getTokenName } from "@/lib/seo";
import { cached } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Address validation lives in the chain adapter (`getChain().normalizeAddress`):
// base58/32 bytes on Solana, EIP-55 `0x…` on EVM. A hardcoded base58 regex here
// is what rejected every EVM address.

/**
 * Public single-wallet eligibility check. Reads the holder's summed balance
 * from the latest snapshot batch (a wallet may hold across several token
 * accounts, so amounts are summed) and compares it to MIN_TOKEN_ELIGIBLE —
 * the same threshold a draw selects winners from.
 *
 * Also reports whether the wallet is EXCLUDED from the draw (venue accounts
 * derived from TOKEN_MINT + the admin blacklist, with the organiser's label),
 * so a wallet that holds enough PAY but has no entry doesn't read "eligible".
 * `eligible` stays balance-only; `drawEligible` = clears the minimum AND is not
 * excluded, and is what the UI shows.
 *
 * Returns only this wallet's data (never the holder list) for privacy. No
 * auth required. Mirrors the env-direct pattern used by /api/status and
 * /api/admin/holders so it works without the full Solana/RPC config.
 */
export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("address")?.trim() ?? "";

  if (!raw) {
    return NextResponse.json(
      { error: "Missing 'address' query parameter." },
      { status: 400 }
    );
  }

  /**
   * Chain-aware validation + canonicalisation: the adapter does the real check
   * (32-byte base58 on Solana, EIP-55 `0x…` — stored lowercase — on EVM) and
   * owns the message the form shows. This was a hardcoded base58 test, so an EVM
   * address was rejected with "Invalid Solana address format" (owner report,
   * 2026-10-29).
   */
  let address: string;
  try {
    address = getChain().normalizeAddress(raw);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  // 30 s per wallet: balances come from the latest snapshot batch, which only
  // changes on HOLDER_SYNC_CRON (every few minutes). The wallet page refetches
  // this on each mount, and each build costs 4 DB round-trips.
  return NextResponse.json(
    await cached(`eligibility:${address}`, 30_000, () =>
      buildEligibility(address)
    )
  );
}

async function buildEligibility(address: string) {
  const network = (process.env.SOLANA_NETWORK || "mainnet") as
    | "mainnet"
    | "devnet";
  const tokenDecimals = Number(process.env.TOKEN_DECIMALS ?? 6);
  const tokenMint = activeTokenAddress();
  const tokenName = await getTokenName();
  const threshold = await effectiveMinEligibleBigint();

  let balanceRaw = 0n;
  let found = false;
  let capturedAt: string | null = null;
  let lastSyncAt: string | null = null;
  let dbError: string | null = null;

  try {
    // Latest global snapshot batch + whether this wallet has ever been seen.
    const [latestSnap, anySnap] = await Promise.all([
      prisma.holderSnapshot.findFirst({
        where: { chain: CHAIN_KIND },
        orderBy: { capturedAt: "desc" },
        select: { capturedAt: true },
      }),
      prisma.holderSnapshot.findFirst({
        where: { holderAddress: address, chain: CHAIN_KIND },
        select: { holderAddress: true },
      }),
    ]);

    found = !!anySnap;
    lastSyncAt = latestSnap ? latestSnap.capturedAt.toISOString() : null;

    if (latestSnap) {
      // Sum this wallet's token accounts within the latest batch.
      const rows = await prisma.holderSnapshot.findMany({
        where: { capturedAt: latestSnap.capturedAt, holderAddress: address, chain: CHAIN_KIND },
        select: { amount: true },
      });
      if (rows.length > 0) {
        balanceRaw = rows.reduce((sum, r) => sum + toBigInt(r.amount), 0n);
        capturedAt = latestSnap.capturedAt.toISOString();
      }
    }
  } catch (e) {
    dbError = (e as Error).message;
  }

  // Same two exclusion sources the draw filters with, so the answer here can't
  // disagree with the holder table: venue accounts derived from TOKEN_MINT
  // (bonding curve / pool authority) and the admin blacklist (with its label).
  const venue = getVenueAccountMap(tokenMint ?? undefined).get(address) ?? null;

  let manualExcluded = false;
  let manualLabel: string | null = null;
  try {
    const row = await prisma.excludedWallet.findUnique({
      where: { address },
      select: { label: true },
    });
    if (row) {
      manualExcluded = true;
      manualLabel = row.label;
    }
  } catch (e) {
    dbError = dbError ?? (e as Error).message;
  }

  const excluded = !!venue || manualExcluded;
  const eligible = balanceRaw >= threshold;
  const shortfallRaw = eligible ? 0n : threshold - balanceRaw;

  return {
    address,
    network,
    tokenName,
    tokenMint,
    tokenDecimals,
    found,
    balanceRaw: balanceRaw.toString(),
    balanceHuman: fmtTokenHuman(balanceRaw, tokenDecimals),
    minTokenEligibleRaw: threshold.toString(),
    minTokenEligibleHuman: fmtTokenHuman(threshold, tokenDecimals),
    // clears the minimum, ignoring exclusions (kept for API compatibility)
    eligible,
    // clears the minimum AND has an entry in the draw
    drawEligible: eligible && !excluded,
    // venue account / blacklisted wallet: no entry even with a full balance
    excluded,
    excludedBy: venue ? "venue" : manualExcluded ? "manual" : null,
    excludedLabel: venue ? venue.label : manualLabel,
    exclusionReason: venue ? venue.reason : null,
    shortfallRaw: shortfallRaw.toString(),
    shortfallHuman: fmtTokenHuman(shortfallRaw, tokenDecimals),
    // snapshot batch this balance is from (null if wallet not in latest batch)
    capturedAt,
    // when the global holder sync last ran
    lastSyncAt,
    dbError,
  };
}