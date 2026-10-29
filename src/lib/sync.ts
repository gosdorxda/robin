import { prisma } from "./prisma";
import { getChain } from "./chain";
import { CHAIN_KIND } from "./chain/network";
import { effectiveMinEligibleBigint } from "./settings";
import { logEvent } from "./log-buffer";

/**
 * Snapshots all non-zero holders of the configured token on-chain and persists
 * the batch to the database (Holder rows + a HolderSnapshot row per holder, all
 * sharing one `capturedAt` timestamp so the latest batch can be queried).
 *
 * Goes through the chain adapter: on Solana that is still the `getProgramAccounts`
 * snapshot in `src/lib/solana/holders.ts`, and swapping chains means a different
 * `listHolders()` — not a change here.
 */
export async function syncHolders(): Promise<{
  totalHolders: number;
  capturedAt: Date;
}> {
  logEvent("info", "sync", "holder sync started");
  try {
    // `minBalance` lets a sorted source (the EVM indexer) stop at the eligibility
    // floor instead of paging through every dust wallet, and `maxPages` caps the
    // request cost. Solana ignores both — `getProgramAccounts` returns everyone.
    const { holders, totalHolders, fetchedAt, truncated, pagesFetched, source } =
      await getChain().listHolders({
        minBalance: await effectiveMinEligibleBigint(),
        maxPages: Number(process.env.HOLDER_SYNC_MAX_PAGES ?? 40),
      });
    const capturedAt = fetchedAt;

    if (holders.length === 0) {
      logEvent("info", "sync", "holder sync done — 0 holders on-chain");
      return { totalHolders: 0, capturedAt };
    }

    // Venue accounts the chain itself marks as non-players — on EVM the pons
    // bonding curve, pools, vaults and the burn address (see `classifyEvmHolder`).
    // They are copied into the exclusion table so EVERY eligibility surface
    // (counts, engine, admin, verify) drops them with no per-chain code.
    // `skipDuplicates` leaves an admin's existing row and its custom label alone.
    const venues = holders.filter((h) => h.isVenue);
    // Both tables carry the chain so a Solana cron and an EVM test run can share
    // the database without one burying the other's "latest batch".
    const chain = CHAIN_KIND;

    await prisma.$transaction([
      prisma.holder.createMany({
        data: holders.map((h) => ({ address: h.owner, chain })),
        skipDuplicates: true,
      }),
      prisma.holderSnapshot.createMany({
        data: holders.map((h) => ({
          holderAddress: h.owner,
          chain,
          // String keeps full precision for the numeric(78,0) column — an
          // 18-decimal balance (up to 1e27) never fits int8 or a JS number.
          amount: h.amount,
          capturedAt,
        })),
      }),
      prisma.excludedWallet.createMany({
        data: venues.map((v) => ({
          address: v.owner,
          label: `auto · ${v.venueLabel ?? "venue"}`,
        })),
        skipDuplicates: true,
      }),
    ]);

    logEvent(
      "success",
      "sync",
      `holder sync done — ${holders.length} of ${totalHolders} holders in ${
        pagesFetched ?? 1
      } request(s)${source ? ` via ${source}` : ""}${
        truncated ? " (truncated: eligibility floor / page cap reached)" : ""
      }${venues.length > 0 ? ` · ${venues.length} venue(s) auto-excluded` : ""} @ ${capturedAt.toISOString()}`
    );
    return { totalHolders, capturedAt };
  } catch (e) {
    logEvent("error", "sync", `holder sync failed: ${(e as Error).message}`);
    throw e;
  }
}
