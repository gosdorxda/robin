import { PublicKey } from "@solana/web3.js";
import { CHAIN_KIND, getChain } from "./chain";
import { prisma } from "./prisma";

/**
 * Draw exclusion list ("blacklist") — server-only.
 *
 * Some accounts hold the token on-chain but are NOT players: the pump.fun
 * bonding curve, AMM/LP pool authorities, program vaults, treasury wallets.
 * Paying a prize into one of those would burn the SOL into a curve that nobody
 * controls (or hand it straight back to liquidity), so they must never be
 * counted as eligible — let alone drawn.
 *
 * How it composes with the draw (important for the fairness story):
 *   eligible pool  =  snapshot wallets  −  platform wallet  −  this list
 *                     (balance >= MIN_TOKEN_ELIGIBLE, per-wallet sums)
 *   winners        =  Fisher–Yates(eligible pool, drand seed)
 * The filter runs BEFORE the shuffle, so an excluded address has no index in
 * the array and the beacon simply cannot select it. It is not "skipped by the
 * randomness" — it was never a candidate. The exact list used is snapshotted on
 * `LotteryRound.excludedAddresses` so historical rounds stay reproducible after
 * an admin edits the blacklist later.
 */

export interface ExcludedWalletRow {
  address: string;
  label: string | null;
  createdAt: Date;
}

/** Hard cap so a runaway paste can't bloat every draw's snapshot payload. */
export const MAX_EXCLUDED_WALLETS = 500;
export const MAX_EXCLUSION_LABEL = 80;

/**
 * Venue programs whose per-mint accounts hold the token but are never players.
 * The addresses are DERIVED from TOKEN_MINT, so they follow the token through
 * graduation (curve → AMM pool) with no admin action and can't be forgotten.
 */
const PUMP_FUN_CURVE_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_SWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

export type VenueKind = "bonding-curve" | "pool-authority";

export interface VenueAccount {
  address: string;
  kind: VenueKind;
  /** Short human name — safe to show publicly ("pump.fun bonding curve"). */
  label: string;
  /** Compact chip tag: "bonding curve" / "pool authority". */
  tag: string;
  /** One-line "why this is never a player" — safe to show publicly. */
  reason: string;
}

/** The bonding curve + PumpSwap pool authority for the configured mint. */
export function getVenueAccounts(
  mint = process.env.TOKEN_MINT
): VenueAccount[] {
  // Solana-only: these are PDAs derived from the mint. On another chain the
  // equivalent venue accounts are DETECTED from the chain data instead and land
  // in the exclusion table via `syncHolders` (see `classifyEvmHolder` in
  // chain/robinhood.ts) — deriving pump.fun PDAs here would only add meaningless
  // base58 addresses to every round's exclusion list.
  if (CHAIN_KIND !== "solana") return [];
  if (!mint) return [];
  try {
    const mintKey = new PublicKey(mint);
    const derive = (
      programId: string,
      seed: string,
      kind: VenueKind,
      tag: string,
      label: string,
      reason: string
    ): VenueAccount => ({
      address: PublicKey.findProgramAddressSync(
        [Buffer.from(seed), mintKey.toBuffer()],
        new PublicKey(programId)
      )[0].toBase58(),
      kind,
      tag,
      label,
      reason,
    });
    return [
      derive(
        PUMP_FUN_CURVE_PROGRAM,
        "bonding-curve",
        "bonding-curve",
        "bonding curve",
        "pump.fun bonding curve",
        "The bonding curve holds the token as liquidity while the coin is minted — it is not a player, and a prize sent here would be locked in the curve."
      ),
      derive(
        PUMP_SWAP_PROGRAM,
        "pool-authority",
        "pool-authority",
        "pool authority",
        "PumpSwap pool authority",
        "The PumpSwap pool authority holds the token as AMM liquidity — it is not a player, and a prize sent here would just flow back into the pool."
      ),
    ];
  } catch {
    // Bad/missing TOKEN_MINT: the draw's own eligibility read will fail loudly.
    return [];
  }
}

/** address → venue account, for tagging rows without a DB round trip. */
export function getVenueAccountMap(
  mint = process.env.TOKEN_MINT
): Map<string, VenueAccount> {
  return new Map(getVenueAccounts(mint).map((v) => [v.address, v]));
}

/**
 * WHY an address is excluded, for the UI chips:
 *   venue  — derived from TOKEN_MINT (bonding curve / pool authority), named for
 *            the user.
 *   manual — an admin blacklist entry; the organiser's label ("Sybil cluster",
 *            "Split wallet"…) is returned so both /admin and the public holder
 *            list can show the reason next to the address. Callers that pass no
 *            `manualLabels` map get `excludedLabel: null`.
 */
export function describeExclusion(
  address: string,
  venueMap: Map<string, VenueAccount>,
  manualLabels?: Map<string, string | null>
): { excludedBy: "venue" | "manual"; excludedLabel: string | null } {
  const venue = venueMap.get(address);
  if (venue) return { excludedBy: "venue", excludedLabel: venue.label };
  return {
    excludedBy: "manual",
    excludedLabel: manualLabels?.get(address) ?? null,
  };
}

/**
 * THE complete exclusion set for the next draw: platform wallet + venue
 * accounts + the admin blacklist, deduped. Every surface that reports an
 * eligible count must use this (holders lists, /api/status, the engine) or the
 * reported count drifts from what the draw can actually pick.
 */
export async function getDrawExclusions(
  platformAddress: string | null
): Promise<string[]> {
  const blacklist = await getExcludedAddresses();
  return mergeExclusions(
    platformAddress,
    getVenueAccounts().map((v) => v.address),
    blacklist
  );
}

/**
 * Trim + validate a wallet address for the exclusion list.
 *
 * Chain-aware since the migration scaffold: the active adapter does the real
 * check (32-byte `PublicKey` on Solana, EIP-55 hex on EVM) and owns the message
 * the admin form shows. Kept as a named export so every existing caller
 * (`addExcludedWallet` here, the admin API route) stays unchanged.
 */
export function normalizeWalletAddress(raw: string): string {
  return getChain().normalizeAddress(raw);
}

/** Every excluded wallet, oldest first — the admin list order. */
export async function listExcludedWallets(): Promise<ExcludedWalletRow[]> {
  return prisma.excludedWallet.findMany({
    orderBy: [{ createdAt: "asc" }, { address: "asc" }],
    select: { address: true, label: true, createdAt: true },
  });
}

/** Just the addresses, for the draw / holder-count code paths. */
export async function getExcludedAddresses(): Promise<string[]> {
  const rows = await prisma.excludedWallet.findMany({
    orderBy: { address: "asc" },
    select: { address: true },
  });
  return rows.map((r) => r.address);
}

export async function addExcludedWallet(
  rawAddress: string,
  rawLabel?: string | null
): Promise<ExcludedWalletRow> {
  const address = normalizeWalletAddress(rawAddress);
  const label =
    String(rawLabel ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, MAX_EXCLUSION_LABEL) || null;

  const existing = await prisma.excludedWallet.findUnique({ where: { address } });
  if (existing) throw new Error("That address is already excluded from the draw");

  const count = await prisma.excludedWallet.count();
  if (count >= MAX_EXCLUDED_WALLETS) {
    throw new Error(`Exclusion list is full (max ${MAX_EXCLUDED_WALLETS} addresses)`);
  }

  return prisma.excludedWallet.create({
    data: { address, label },
    select: { address: true, label: true, createdAt: true },
  });
}

/** Removes one address. Returns false when it wasn't in the list. */
export async function removeExcludedWallet(rawAddress: string): Promise<boolean> {
  const address = normalizeWalletAddress(rawAddress);
  const res = await prisma.excludedWallet.deleteMany({ where: { address } });
  return res.count > 0;
}

/**
 * True for program-derived accounts: bonding curves, PDAs, pool authorities and
 * vaults are OFF the ed25519 curve, while every plain keypair wallet is on it.
 * Used only to *suggest* addresses in the admin UI — the list itself stays 100%
 * manual, because an off-curve heuristic alone can't distinguish "the curve"
 * from "a program vault that does belong to a player".
 */
export function isProgramOwnedAccount(address: string): boolean {
  try {
    // Static helper (web3.js 1.99): decodes base58 and tests the ed25519 curve.
    return !PublicKey.isOnCurve(address);
  } catch {
    return false;
  }
}

/** Union of exclusion sources, deduped + address-sorted (stable snapshots). */
export function mergeExclusions(
  ...lists: (string | null | undefined | string[])[]
): string[] {
  const set = new Set<string>();
  for (const item of lists) {
    if (!item) continue;
    if (Array.isArray(item)) {
      for (const addr of item) if (addr) set.add(addr);
    } else {
      set.add(item);
    }
  }
  return [...set].sort();
}
