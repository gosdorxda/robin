import { NextRequest, NextResponse } from "next/server";
import { CHAIN_KIND, activeTokenAddress } from "@/lib/chain";
import { prisma } from "@/lib/prisma";
import { getChain } from "@/lib/chain";
import { toBigInt } from "@/lib/db-amount";
import { fmtTokenHuman } from "@/lib/format";
import { effectiveMinEligibleBigint } from "@/lib/settings";
import { getPlatformKeypair } from "@/lib/solana/connection";
import {
  describeExclusion,
  getDrawExclusions,
  getVenueAccountMap,
  listExcludedWallets,
} from "@/lib/exclusions";
import { cached } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 15;

/**
 * Public holder list from the latest snapshot batch. Mirrors /api/admin/holders
 * (balances summed per wallet across token accounts, sorted by balance desc,
 * `eligible` = meets MIN_TOKEN_ELIGIBLE AND is neither the platform wallet nor
 * on the admin exclusion list, matching the draw's eligible pool) but WITHOUT
 * auth and with pagination + pre-formatted human amounts so the public /holders
 * page needs no client math.
 *
 * Token holder balances are public on-chain data (Solana account state), so
 * exposing them on a public page is fine for a public lottery.
 *
 * `excludedBy` says WHY a row is out of the draw so the chip isn't a bare
 * "Excluded": `venue` = an account derived from TOKEN_MINT (pump.fun bonding
 * curve / PumpSwap pool authority); `manual` = an admin blacklist entry.
 * `excludedLabel` carries the matching name — the venue name for `venue`, or the
 * admin's label (e.g. "Sybil cluster") for `manual`, because the public list now
 * names the reason instead of implying an unexplained ban. The label is written
 * by the organiser for exactly this purpose and is never raw account data, so
 * there is nothing sensitive in exposing it.
 */
export async function GET(request: NextRequest) {
  const page = Math.max(1, Number(request.nextUrl.searchParams.get("page") ?? "1") || 1);
  // 30 s per page: the list is rebuilt from the latest snapshot batch (4 queries
  // + a full-batch scan), which only changes on HOLDER_SYNC_CRON.
  return NextResponse.json(
    await cached(`holders:${page}`, 30_000, () => buildHolders(page))
  );
}

async function buildHolders(page: number) {
  const network = (process.env.SOLANA_NETWORK || "mainnet") as
    | "mainnet"
    | "devnet";
  const tokenDecimals = Number(process.env.TOKEN_DECIMALS ?? 6);
  const tokenMint = activeTokenAddress();
  const threshold = await effectiveMinEligibleBigint();

  let capturedAt: string | null = null;
  let holders: {
    address: string;
    amount: string;
    amountHuman: string;
    eligible: boolean;
    platform: boolean;
    excluded: boolean;
    excludedBy: "venue" | "manual" | null;
    excludedLabel: string | null;
  }[] = [];
  let total = 0;
  let eligibleTotal = 0;
  let excludedTotal = 0;
  let platformAddress: string | null = null;
  let dbError: string | null = null;

  try {
    platformAddress = getChain().platformAddress();
  } catch {
    /* platform keypair not configured on this deployment */
  }

  try {
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
      // Full exclusion set for the next draw: platform wallet + the token's
      // venue accounts (pump.fun bonding curve / PumpSwap pool authority) +
      // the admin blacklist. Same helper the engine uses, so counts match.
      const venueMap = getVenueAccountMap();
      const excludedSet = new Set(await getDrawExclusions(platformAddress));
      // Same label map the admin table uses: the public chip says "Sybil
      // cluster" instead of a bare "Excluded". Null labels stay null.
      const manualLabels = new Map(
        (await listExcludedWallets()).map((r) => [r.address, r.label])
      );
      const map = new Map<string, bigint>();
      for (const s of snaps) {
        map.set(s.holderAddress, (map.get(s.holderAddress) ?? 0n) + toBigInt(s.amount));
      }
      const all = Array.from(map.entries())
        .map(([address, amount]) => {
          const platform = address === platformAddress;
          const excluded = excludedSet.has(address);
          // Platform wallet is reported by its own flag; attribute the rest so
          // the chip can say "venue · bonding curve" instead of "Excluded".
          const why =
            excluded && !platform
              ? describeExclusion(address, venueMap, manualLabels)
              : { excludedBy: null, excludedLabel: null };
          return {
            address,
            amount,
            platform,
            excluded,
            excludedBy: why.excludedBy,
            excludedLabel: why.excludedLabel,
            eligible: !platform && !excluded && amount >= threshold,
          };
        })
        .sort((a, b) => (b.amount > a.amount ? 1 : -1));
      total = all.length;
      eligibleTotal = all.filter((h) => h.eligible).length;
      excludedTotal = all.filter((h) => h.excluded).length;
      const start = (page - 1) * PAGE_SIZE;
      const slice = all.slice(start, start + PAGE_SIZE);
      holders = slice.map((h) => ({
        address: h.address,
        amount: h.amount.toString(),
        amountHuman: fmtTokenHuman(h.amount, tokenDecimals),
        eligible: h.eligible,
        platform: h.platform,
        excluded: h.excluded,
        excludedBy: h.excludedBy,
        excludedLabel: h.excludedLabel,
      }));
    }
  } catch (e) {
    dbError = (e as Error).message;
  }

  return {
    network,
    tokenMint,
    tokenDecimals,
    minTokenEligibleRaw: threshold.toString(),
    minTokenEligibleHuman: fmtTokenHuman(threshold, tokenDecimals),
    capturedAt,
    platformAddress,
    total,
    eligibleTotal,
    excludedTotal,
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    holders,
    dbError,
  };
}
