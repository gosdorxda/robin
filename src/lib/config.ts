import bs58 from "bs58";
import { CHAIN_ID, NATIVE_DECIMALS } from "./chain/network";

/** 0.05 ETH — the EVM counterpart of the 50,000,000-lamport Solana default. */
const EVM_RESERVE_DEFAULT = 50_000_000_000_000_000n;

function required(name: string, value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.trim();
}

/** Env value when set and non-empty, else a built-in default. Keeps the
 *  settings summary (`lib/settings.ts`) and the engine reading the same value. */
function envOr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim().length > 0 ? raw.trim() : fallback;
}


export type LotteryConfig = {
  rpcUrl: string;
  /**
   * SOLANA RPC URL — always the Solana endpoint, even when another chain is
   * active, because `lib/solana/connection.ts` builds a Solana `Connection` from
   * it and Solana-only callers (creator fees, rent-exempt math, scripts) still
   * reach it. Empty on an EVM deployment, in which case those callers throw a
   * clear "SOLANA_RPC_URL is not set" instead of firing Solana methods at an EVM
   * node (which is how the owner hit
   * `getMinimumBalanceForRentExemption is not available on the ROBINHOOD_MAINNET`).
   */
  solanaRpcUrl: string;
  heliusApiKey: string;
  network: "mainnet" | "devnet";
  tokenMint: string;
  tokenDecimals: number;
  /** Secret key bytes for the platform/hot wallet. Server-only. */
  platformWalletSecret: Uint8Array;
  /** Secret key bytes for the OPTIONAL platform fee treasury wallet. Server-only.
   *  Env: PLATFORM_TREASURY_SECRET. When set, the per-round platform fee is swept
   *  to this wallet in the same atomic tx as winner payouts (so the fee leaves
   *  the platform wallet and isn't recycled into the next round's prize pool).
   *  When null/unset, the fee stays on the platform wallet (legacy behaviour). */
  platformTreasurySecret: Uint8Array | null;
  lotteryCron: string;
  holderSyncCron: string;
  minTokenEligible: bigint;
  /** SOL kept on the platform wallet for fees/rent (not distributed). Env: PRIZE_RESERVE_LAMPORTS (default 0.05 SOL). */
  prizeReserveLamports: bigint;
  /** Max SOL prize distributed per round (lamports). 0 = no cap; the balance
   *  above the cap stays on the platform wallet for future rounds.
   *  Env: MAX_PRIZE_SOL (readable SOL string, e.g. "1.0"). */
  maxPrizeLamports: bigint;
  /** Minimum SOL prize per round (lamports). When the effective prize (after
   *  the max cap) falls below this, the round is skipped instead of drawn — no
   *  randomness consumed, no winners, no payout. 0 = no minimum.
   *  Env: MIN_PRIZE_SOL (readable SOL string, e.g. "0.1"). */
  minPrizeLamports: bigint;
  /** Platform revenue cut in basis points (0–10000; 100 = 1%, 500 = 5%). Default 0 = no cut.
   *  Env: PLATFORM_FEE_BPS. Deducted from the prize pool before splitting among
   *  winners; the cut stays on the platform wallet (the funder), not transferred. */
  platformFeeBps: number;
  winnerCount: number;
  payoutDistribution: number[];
  databaseUrl: string;
  adminUsername: string;
  adminPassword: string;
  adminSessionSecret: string;
  publicRpcUrl: string;
};

let cached: LotteryConfig | null = null;

/**
 * Loads and validates all server-side configuration from environment variables.
 * Throws if any required value is missing. Results are cached for the process.
 */
export function getConfig(): LotteryConfig {
  if (cached) return cached;

  const network = (process.env.SOLANA_NETWORK || "mainnet") as "mainnet" | "devnet";
  const isSolana = CHAIN_ID === null;

  /**
   * WHICH keys are required depends on the chain: Solana needs the SVM
   * credentials (RPC URL / mint / secret key), an EVM chain needs the 0x ones.
   * Before the chain layer every Solana variable was mandatory on every chain,
   * which is why the Solana block of `.env` could never be dropped after a
   * switch — see MIGRATION-ROBINHOOD.md §3.
   */
  const rpcUrl = isSolana
    ? required("SOLANA_RPC_URL", process.env.SOLANA_RPC_URL)
    : required("CHAIN_RPC_URL", process.env.CHAIN_RPC_URL);
  const tokenMint = isSolana
    ? required("TOKEN_MINT", process.env.TOKEN_MINT)
    : required("TOKEN_ADDRESS", process.env.TOKEN_ADDRESS);

  cached = {
    rpcUrl,
    solanaRpcUrl: (process.env.SOLANA_RPC_URL ?? "").trim(),
    heliusApiKey: process.env.HELIUS_API_KEY || "",
    network,
    tokenMint,
    tokenDecimals: Number(process.env.TOKEN_DECIMALS ?? (isSolana ? 6 : 18)),
    /**
     * Solana secret-key BYTES (Ed25519). On an EVM chain there is no such key —
     * the platform wallet lives in `PLATFORM_WALLET_PRIVATE_KEY` and is read by
     * the chain adapter (see `getChain().platformAddress()` / `sendPayouts()`),
     * so this stays empty. Solana-only callers (`getPlatformKeypair()`,
     * `distributePayouts`) must never be reached on another chain; if one is, it
     * fails loudly on a zero-length secret instead of signing with garbage.
     */
    platformWalletSecret: isSolana
      ? parseSecret(
          required("PLATFORM_WALLET_SECRET", process.env.PLATFORM_WALLET_SECRET)
        )
      : new Uint8Array(0),
    platformTreasurySecret: (() => {
      const raw = process.env.PLATFORM_TREASURY_SECRET;
      return raw && raw.trim().length > 0
        ? parseSecret(raw.trim(), "PLATFORM_TREASURY_SECRET")
        : null;
    })(),
    lotteryCron: envOr("LOTTERY_CRON", "0 * * * *"),
    holderSyncCron: envOr("HOLDER_SYNC_CRON", "*/5 * * * *"),
    minTokenEligible: BigInt(envOr("MIN_TOKEN_ELIGIBLE", "100000")),
    // The reserve is the ONE number where mixing units would move real money: on
    // an 18-decimal EVM chain the Solana default (50,000,000 = 0.05 SOL) would
    // read as ~0 ETH and hand the entire wallet to the winners. So the EVM branch
    // reads its own key and defaults to 0.05 ETH (5e16 wei). Renaming the field
    // itself is Phase 5 work — see MIGRATION-ROBINHOOD.md.
    prizeReserveLamports:
      CHAIN_ID === null
        ? parseReserve(envOr("PRIZE_RESERVE_LAMPORTS", ""))
        : parseReserve(envOr("PRIZE_RESERVE_WEI", ""), EVM_RESERVE_DEFAULT),
    maxPrizeLamports: parseSolToLamports(
      envOr("MAX_PRIZE_NATIVE", "") || envOr("MAX_PRIZE_SOL", "")
    ),
    minPrizeLamports: parseSolToLamports(
      envOr("MIN_PRIZE_NATIVE", "") || envOr("MIN_PRIZE_SOL", "")
    ),
    platformFeeBps: Math.max(
      0,
      Math.min(10000, Number(envOr("PLATFORM_FEE_BPS", "0")))
    ),
    winnerCount: Number(envOr("WINNER_COUNT", "3")),
    payoutDistribution: parseDistribution(
      envOr("PAYOUT_DISTRIBUTION", "0.5,0.3,0.2")
    ),

    databaseUrl: required("DATABASE_URL", process.env.DATABASE_URL),
    adminUsername: process.env.ADMIN_USERNAME || "admin",
    adminPassword: required("ADMIN_PASSWORD", process.env.ADMIN_PASSWORD),
    adminSessionSecret: required(
      "ADMIN_SESSION_SECRET",
      process.env.ADMIN_SESSION_SECRET
    ),
    publicRpcUrl: process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "",
  };

  // winnerCount must match the payout distribution length
  if (cached.winnerCount !== cached.payoutDistribution.length) {
    throw new Error(
      `WINNER_COUNT (${cached.winnerCount}) must equal PAYOUT_DISTRIBUTION length (${cached.payoutDistribution.length})`
    );
  }

  return cached;
}

/** Busts the cached LotteryConfig so the next getConfig() rebuilds it from env.
 *  Settings are env-only now, so this is mainly for tests / scripts that mutate
 *  `process.env` in-process. */
export function bustConfigCache(): void {
  cached = null;
}

export interface AuthConfig {
  adminUsername: string;
  adminPassword: string;
  adminSessionSecret: string;
}

let authCached: AuthConfig | null = null;

/**
 * Loads only the admin-auth config (username, password, session secret).
 * Use this instead of getConfig() in auth/login paths so the admin panel can
 * work without the full Solana/DB credentials being set.
 */
export function getAuthConfig(): AuthConfig {
  if (authCached) return authCached;
  authCached = {
    adminUsername: process.env.ADMIN_USERNAME || "admin",
    adminPassword: required("ADMIN_PASSWORD", process.env.ADMIN_PASSWORD),
    adminSessionSecret: required(
      "ADMIN_SESSION_SECRET",
      process.env.ADMIN_SESSION_SECRET
    ),
  };
  return authCached;
}

function parseDistribution(raw: string): number[] {
  const parts = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => !isNaN(n));
  const sum = parts.reduce((a, b) => a + b, 0);
  if (parts.length === 0 || Math.abs(sum - 1) > 0.0001) {
    throw new Error(
      `PAYOUT_DISTRIBUTION must be a comma-separated list summing to 1.0, got "${raw}" (sum=${sum})`
    );
  }
  return parts;
}

/**
 * Parses PRIZE_RESERVE_LAMPORTS (raw lamports). Defaults to 0.05 SOL when unset
 * or invalid, so production stays safe unless explicitly lowered for testing.
 */
function parseReserve(
  raw: string | undefined,
  fallback: bigint = 50_000_000n
): bigint {
  if (!raw || raw.trim().length === 0) return fallback; // 0.05 SOL / 0.05 ETH
  try {
    const v = BigInt(raw.trim());
    return v >= 0n ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Parses a readable native amount (e.g. "1.0", "0.05") into BASE UNITS — × 1e9
 * on Solana, × 1e18 on an EVM chain (`BASE_UNITS_PER_NATIVE`). Returns 0n for
 * unset / invalid / non-positive values, which disables the max-prize cap and
 * minimum-prize threshold respectively. Used by MAX_PRIZE_NATIVE and
 * MIN_PRIZE_NATIVE so admins enter friendly amounts instead of base units.
 *
 * The ×1e9 used to be hardcoded, which made `MAX_PRIZE_NATIVE=1` mean **1 gwei**
 * on Robinhood Chain — a cap of 0,000000001 ETH. Caught in the owner's draw log
 * ("cap 1000000000") on 2026-10-29.
 */
function parseSolToLamports(raw: string | undefined): bigint {
  if (!raw || raw.trim().length === 0) return 0n;
  const text = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return 0n;
  // Split on the decimal point and pad to the chain's decimals, so the whole
  // conversion stays in integers: 18-decimal precision must never sit in a float.
  const [whole, frac = ""] = text.split(".");
  const padded = (frac + "0".repeat(NATIVE_DECIMALS)).slice(0, NATIVE_DECIMALS);
  // BigInt math end to end: `BASE_UNITS_PER_NATIVE` is a JS number (1e18 is not
  // exactly representable as a product) and mixing it with a bigint throws.
  const factor = 10n ** BigInt(NATIVE_DECIMALS);
  const value = BigInt(whole) * factor + BigInt(padded || "0");
  return value > 0n ? value : 0n;
}

/**
 * Parses the platform wallet secret from env. Accepts either:
 *  - a JSON number array (solana-keygen output), e.g. "[12,34,...]"
 *  - a base58 string (Phantom export), e.g. "5K..."
 */
function parseSecret(raw: string, label = "PLATFORM_WALLET_SECRET"): Uint8Array {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as number[];
      if (arr.length !== 64) {
        throw new Error(`expected 64 numbers, got ${arr.length}`);
      }
      return Uint8Array.from(arr);
    } catch (e) {
      throw new Error(
        `${label} looks like a JSON array but failed to parse: ${(e as Error).message}`
      );
    }
  }
  try {
    const decoded = bs58.decode(trimmed);
    if (decoded.length !== 64) {
      throw new Error(`decoded to ${decoded.length} bytes, expected 64`);
    }
    return decoded;
  } catch (e) {
    throw new Error(
      `${label} is neither a valid JSON array nor valid base58: ${(e as Error).message}`
    );
  }
}
