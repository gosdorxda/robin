import { NextRequest, NextResponse } from "next/server";
import { CHAIN_KIND } from "@/lib/chain";
import { isAdmin } from "@/lib/admin-guard";
import { prisma } from "@/lib/prisma";
import { getChain } from "@/lib/chain";
import { toBigInt } from "@/lib/db-amount";
import { cached } from "@/lib/cache";
import { effectiveMinEligibleBigint } from "@/lib/settings";
import { getPlatformKeypair } from "@/lib/solana/connection";
import {
  describeExclusion,
  getDrawExclusions,
  getVenueAccountMap,
  listExcludedWallets,
} from "@/lib/exclusions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin-only holder list from the latest snapshot batch. Balances are summed
 * per wallet (a wallet may hold across several token accounts) and sorted by
 * balance desc. `eligible` flags wallets that would actually enter the next
 * draw: balance >= MIN_TOKEN_ELIGIBLE AND neither the platform wallet nor an
 * address on the admin exclusion list (bonding curve, LP pools, program
 * vaults…) — exactly the pool the engine builds, so this list can't over-report
 * the eligible count. `excluded` marks the blacklisted rows so the UI can chip
 * them instead of calling them "below min".
 *
 * `excludedBy` / `excludedLabel` say WHY: `venue` = derived from TOKEN_MINT
 * (pump.fun bonding curve / PumpSwap pool authority, e.g. "pump.fun bonding
 * curve"), `manual` = an admin blacklist entry with its (admin-only) label.
 * Platform wallet rows carry `excludedBy: null` — they have their own flag.
 *
 * Only the LATEST batch is returned (live holders). `knownTotal` is the
 * cumulative `Holder` table size — wallets ever seen, including ones that have
 * since sold out — for context only.
 */
export async function GET(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // The underlying snapshot changes every few minutes (HOLDER_SYNC_CRON), so a
  // 30 s TTL costs no freshness while skipping the 4-query rebuild + the full
  // holder list serialisation on every tab visit.
  return NextResponse.json(
    await cached("admin:holders", 30_000, buildHolders)
  );
}

/** Builds the payload (no auth — the exported GET checks the session first). */
async function buildHolders() {
  const network = (process.env.SOLANA_NETWORK || "mainnet") as
    | "mainnet"
    | "devnet";
  const tokenDecimals = Number(process.env.TOKEN_DECIMALS ?? 6);
  const threshold = await effectiveMinEligibleBigint();

  let capturedAt: string | null = null;
  let holders: {
    address: string;
    amount: string;
    eligible: boolean;
    platform: boolean;
    excluded: boolean;
    excludedBy: "venue" | "manual" | null;
    excludedLabel: string | null;
  }[] = [];
  let knownTotal = 0;
  let platformAddress: string | null = null;
  let dbError: string | null = null;

  try {
    platformAddress = getChain().platformAddress();
  } catch {
    /* platform keypair not configured on this deployment */
  }

  try {
    knownTotal = await prisma.holder.count({ where: { chain: CHAIN_KIND } });
    const latest = await prisma.holderSnapshot.findFirst({
      where: { chain: CHAIN_KIND },
      orderBy: { capturedAt: "desc" },
      select: { capturedAt: true },
    });
    if (latest) {
      capturedAt = latest.capturedAt.toISOString();
      const snaps = await prisma.holderSnapshot.findMany({
        where: { capturedAt: latest.capturedAt, chain: CHAIN_KIND },
        select: { holderAddress: true, amount: true },
      });
      const map = new Map<string, bigint>();
      for (const s of snaps) {
        map.set(s.holderAddress, (map.get(s.holderAddress) ?? 0n) + toBigInt(s.amount));
      }
      const excludedSet = new Set(await getDrawExclusions(platformAddress));
      const venueMap = getVenueAccountMap();
      // Admin surface: label map lets the table show the organiser's reason.
      const manualLabels = new Map(
        (await listExcludedWallets()).map((r) => [r.address, r.label])
      );
      holders = Array.from(map.entries())
        .map(([address, amount]) => {
          const platform = address === platformAddress;
          const excluded = excludedSet.has(address);
          const why =
            excluded && !platform
              ? describeExclusion(address, venueMap, manualLabels)
              : { excludedBy: null, excludedLabel: null };
          return {
            address,
            amount: amount.toString(),
            platform,
            excluded,
            excludedBy: why.excludedBy,
            excludedLabel: why.excludedLabel,
            eligible: !platform && !excluded && amount >= threshold,
          };
        })
        .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
    }
  } catch (e) {
    dbError = (e as Error).message;
  }

  return {
    network,
    tokenDecimals,
    minTokenEligibleRaw: threshold.toString(),
    capturedAt,
    total: holders.length,
    eligibleTotal: holders.filter((h) => h.eligible).length,
    excludedTotal: holders.filter((h) => h.excluded).length,
    knownTotal,
    platformAddress,
    holders,
    dbError,
  };
}
