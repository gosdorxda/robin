import "server-only";
import { VersionedTransaction, type Keypair } from "@solana/web3.js";
import { prisma } from "@/lib/prisma";
import { CHAIN_KIND, CHAIN_LABEL } from "../chain/network";
import { toBaseUnitString, toDecimalValue, type BaseUnitValue } from "@/lib/db-amount";
import { getConfig } from "@/lib/config";
import { getConnection, getPlatformKeypair } from "@/lib/solana/connection";
import { logEvent } from "@/lib/log-buffer";
import { lamportsToSol, solToLamports, formatSol, shortAddress } from "@/lib/format";

/**
 * pump.fun creator-fee claim client (server-only).
 *
 * The claim flow is a two-step dance against pumpdev.io:
 *
 *   1. GET  `{base}/api/claim-account?publicKey=&mint=` → JSON balances
 *      (cached ~3 min server-side). `totalClaimable` is the fee pot in SOL and
 *      is the same for any `publicKey`, so only `shareholders[]` tells us WHERE
 *      the money goes once claimed.
 *   2. POST `{base}/api/claim-account` (or `/api/claim-distribute` when the
 *      mint has fee sharing) → a **binary `VersionedTransaction`**. It must be
 *      deserialized, signed by the platform keypair and sent immediately —
 *      its blockhash expires in ~60s. The claim itself is permissionless; the
 *      on-chain shareholder config decides the recipient, while the signing
 *      wallet pays the network + priority fees.
 *
 * We never trust the JSON to tell us how much *we* receive: the card shows the
 * shareholder split, and each DB row stores the claimable snapshot next to the
 * recipient reported by the API.
 */

/** AdminSetting key holding the persisted auto-claim toggle ("true"/"false"). */
export const AUTO_CLAIM_SETTING_KEY = "CLAIM_AUTO_ENABLED";

const DEFAULT_API_BASE = "https://pumpdev.io";
const DEFAULT_CRON = "*/10 * * * *";
const DEFAULT_MIN_SOL = 0.05;
/** Fee headroom the signing wallet must hold before we build a claim tx. */
const DEFAULT_MIN_WALLET_SOL = 0.01;
/** Priority fee attached to the claim tx (pumpdev reads it from the body). */
const DEFAULT_PRIORITY_FEE_SOL = 0.0005;

/**
 * Base signature fee charged by the runtime for a one-signature transaction.
 * Paid on top of the priority fee below, so the *real* cost of a claim is
 * `BASE_FEE_LAMPORTS + priorityFeeSol` — never just the priority fee.
 */
const BASE_FEE_LAMPORTS = 5_000;
/**
 * Conservative stand-in for the rent-exempt minimum when the RPC can't be
 * asked. A transaction may not leave the fee payer below this floor, which is
 * why a wallet holding "enough for the fee" can still be rejected with
 * `insufficient funds for rent`.
 */
const DEFAULT_RENT_EXEMPT_LAMPORTS = 1_000_000;
/** Rent-exempt minimum is a cluster constant — cache it for an hour. */
const RENT_CACHE_MS = 60 * 60_000;

const FETCH_TIMEOUT_MS = 15_000;
const CONFIRM_TIMEOUT_MS = 60_000;

export interface CreatorFeeShareholder {
  address: string;
  sharePercent: number;
}

export interface CreatorFeeSnapshot {
  /** Wallet the probe was made for (the platform/deployer wallet). */
  publicKey: string;
  mint: string;
  /** Claimable on the pump.fun bonding curve / AMM, in lamports (string). */
  pumpLamports: string;
  /** Claimable on PumpSwap after graduation, in lamports (string). */
  pumpSwapLamports: string;
  totalLamports: string;
  graduated: boolean;
  hasFeeSharing: boolean;
  quoteMint: string | null;
  isNativeQuote: boolean;
  shareholders: CreatorFeeShareholder[];
  /** Share of the pot the platform wallet itself receives (0–100). */
  platformSharePercent: number;
  /** Highest-share shareholder, or the platform wallet when there is none. */
  payoutAddress: string | null;
  checkedAt: string;
}

export interface CreatorFeeAutoConfig {
  enabled: boolean;
  minSol: number;
  cron: string;
  minWalletSol: number;
  priorityFeeSol: number;
}

export interface CreatorFeeClaimRecord {
  id: string;
  signature: string | null;
  amountLamports: string;
  pumpLamports: string;
  pumpSwapLamports: string;
  recipient: string | null;
  source: string;
  status: string;
  error: string | null;
  createdAt: string;
  confirmedAt: string | null;
}

/**
 * Cost model for one claim attempt, surfaced to the admin card so the
 * "why is 0.0002 SOL not claimable" question answers itself:
 *
 *   fee            = 5,000 base + priority fee (both actually charged)
 *   rentExempt     = floor the fee payer must still hold afterwards
 *   requiredBalance= max(CLAIM_MIN_WALLET_SOL, fee + rentExempt)
 *   net            = claimable − fee (negative ⇒ claiming loses SOL)
 */
export interface CreatorFeeCosts {
  feeLamports: string;
  rentExemptLamports: string;
  requiredBalanceLamports: string;
  /** `null` when the claimable snapshot is unavailable. */
  netLamports: string | null;
}

export interface CreatorFeeStatus {
  /** Env + platform wallet available (token mint, secret, RPC). */
  configured: boolean;
  network: "mainnet" | "devnet" | null;
  platformWallet: string | null;
  mint: string | null;
  snapshot: CreatorFeeSnapshot | null;
  /** Why the snapshot is missing (network, API error, non-mainnet, …). */
  error: string | null;
  /** Live SOL balance of the signing wallet — must cover the claim fees. */
  platformBalanceSol: number | null;
  auto: CreatorFeeAutoConfig;
  /** Fee/rent math behind the claim button's enabled state. */
  costs: CreatorFeeCosts;
  lastClaim: CreatorFeeClaimRecord | null;
  claims: CreatorFeeClaimRecord[];
}

export interface ClaimOutcome {
  ok: boolean;
  /** Present once the tx was broadcast (even if it later failed on-chain). */
  signature?: string;
  amountLamports?: string;
  recipient?: string | null;
  /** True when nothing was attempted (no fees / below threshold / busy). */
  skipped?: boolean;
  error?: string;
}

function apiBase(): string {
  return (process.env.PUMPFUN_API_BASE || DEFAULT_API_BASE)
    .trim()
    .replace(/\/+$/, "");
}

/**
 * undici reports every network failure as the same `TypeError: fetch failed`;
 * the actual reason hides in `cause` (`ENOTFOUND`, `EAI_AGAIN`, `ECONNRESET`,
 * `CERT_HAS_EXPIRED`, or a happy-eyeballs `AggregateError` of both families).
 * Without it the admin card can't tell a DNS problem from a blocked egress
 * port, so the cause is folded into the message the UI shows.
 */
function describeFetchError(e: unknown): string {
  const err = e as Error & { cause?: unknown };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return "timed out — tidak ada respons dari pumpdev";
  }
  const base = err?.message || "fetch failed";
  const cause = err?.cause as
    | (Error & { code?: string; errors?: { code?: string }[] })
    | undefined;
  const code = cause?.code ?? cause?.errors?.[0]?.code;
  const detail = cause instanceof Error ? cause.message : "";
  const extra = [code, detail].filter(Boolean).join(" — ");
  return extra ? `${base} (${extra})` : base;
}

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function toLamports(value: unknown): bigint {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0
    ? solToLamports(n)
    : 0n;
}

function shortError(text: string, max = 300): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** What one claim attempt costs the signing wallet, in lamports. */
export function claimFeeLamports(priorityFeeSol: number): number {
  return BASE_FEE_LAMPORTS + Number(solToLamports(priorityFeeSol));
}

let rentExemptCache: { at: number; lamports: number } | null = null;

/**
 * Rent-exempt minimum for a 0-byte system account (the fee payer). A tx whose
 * post-state leaves the payer below this floor is rejected *before execution*
 * with `insufficient funds for rent` and **empty logs** — the exact failure the
 * old `CLAIM_MIN_WALLET_SOL` guard (0.0001) let through. Never throws.
 */
async function getRentExemptLamports(): Promise<number> {
  if (rentExemptCache && Date.now() - rentExemptCache.at < RENT_CACHE_MS) {
    return rentExemptCache.lamports;
  }
  try {
    const lamports = await getConnection().getMinimumBalanceForRentExemption(0);
    if (lamports > 0) {
      rentExemptCache = { at: Date.now(), lamports };
      return lamports;
    }
  } catch {
    // fall through to the conservative constant
  }
  return DEFAULT_RENT_EXEMPT_LAMPORTS;
}

/**
 * Turn the runtime's terse `SendTransactionError` into something an operator
 * can act on. The rent case is the one that bit us: 0.0002 SOL pot on a wallet
 * holding 0.001 SOL is "enough for the fee" but not enough to stay rent-exempt,
 * so the tx dies in simulation with no logs at all.
 */
function explainSendError(
  message: string,
  feeLamports: number,
  rentExemptLamports: number
): string {
  if (/insufficient funds for rent/i.test(message)) {
    const required = feeLamports + rentExemptLamports;
    return (
      `Rejected before execution: after paying the ${formatSol(
        feeLamports,
        6
      )} claim fee the wallet would drop below the ${formatSol(
        rentExemptLamports,
        6
      )} rent-exempt floor. Seed the platform wallet with at least ` +
      `${formatSol(required, 6)} and retry.`
    );
  }
  if (/insufficient (funds|lamports) for fee/i.test(message)) {
    return (
      `Rejected: the platform wallet cannot pay the ` +
      `${formatSol(feeLamports, 6)} claim fee. Seed it first.`
    );
  }
  return message;
}

function serializeClaim(row: {
  id: bigint;
  signature: string | null;
  amountLamports: BaseUnitValue;
  pumpLamports: BaseUnitValue;
  pumpSwapLamports: BaseUnitValue;
  recipient: string | null;
  source: string;
  status: string;
  error: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
}): CreatorFeeClaimRecord {
  return {
    id: row.id.toString(),
    signature: row.signature,
    amountLamports: toBaseUnitString(row.amountLamports),
    pumpLamports: toBaseUnitString(row.pumpLamports),
    pumpSwapLamports: toBaseUnitString(row.pumpSwapLamports),
    recipient: row.recipient,
    source: row.source,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
  };
}

/** Effective auto-claim config: AdminSetting toggle over env, env over defaults. */
export async function getAutoClaimConfig(): Promise<CreatorFeeAutoConfig> {
  let enabled = process.env.CLAIM_AUTO_ENABLED === "true";
  try {
    const row = await prisma.adminSetting.findUnique({
      where: { key: AUTO_CLAIM_SETTING_KEY },
    });
    if (row) enabled = row.value === "true";
  } catch {
    // DB unavailable — fall back to env so the card still renders.
  }
  return {
    enabled,
    minSol: envNumber("CLAIM_MIN_SOL", DEFAULT_MIN_SOL),
    cron: process.env.CLAIM_CRON || DEFAULT_CRON,
    minWalletSol: envNumber("CLAIM_MIN_WALLET_SOL", DEFAULT_MIN_WALLET_SOL),
    priorityFeeSol: envNumber(
      "CLAIM_PRIORITY_FEE_SOL",
      DEFAULT_PRIORITY_FEE_SOL
    ),
  };
}

/** Persist the auto-claim toggle (takes effect on the next cron tick). */
export async function setAutoClaimEnabled(enabled: boolean): Promise<void> {
  await prisma.adminSetting.upsert({
    where: { key: AUTO_CLAIM_SETTING_KEY },
    update: { value: String(enabled) },
    create: { key: AUTO_CLAIM_SETTING_KEY, value: String(enabled) },
  });
}

/** GET the claimable balances for the platform wallet. Throws on API errors. */
export async function fetchCreatorFeeSnapshot(
  platformWallet: string,
  mint: string
): Promise<CreatorFeeSnapshot> {
  const url =
    `${apiBase()}/api/claim-account?publicKey=${encodeURIComponent(platformWallet)}` +
    `&mint=${encodeURIComponent(mint)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (e) {
    throw new Error(`pumpdev unreachable: ${shortError(describeFetchError(e), 200)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`pumpdev ${res.status}: ${shortError(text)}`);
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`pumpdev returned non-JSON: ${shortError(text)}`);
  }

  const shareholders = Array.isArray(raw.shareholders)
    ? (raw.shareholders as Record<string, unknown>[])
        .map((s) => ({
          address: String(s.address ?? ""),
          sharePercent: Number(s.sharePercent ?? 0),
        }))
        .filter((s) => s.address.length > 0)
    : [];

  const pumpLamports = toLamports(raw.pumpBalance);
  const pumpSwapLamports = toLamports(raw.pumpSwapBalance);
  const totalLamports = toLamports(raw.totalClaimable);
  const platformSharePercent = shareholders
    .filter((s) => s.address === platformWallet)
    .reduce((sum, s) => sum + s.sharePercent, 0);
  const primary = shareholders
    .slice()
    .sort((a, b) => b.sharePercent - a.sharePercent)[0];

  return {
    publicKey: String(raw.publicKey ?? platformWallet),
    mint: String(raw.mint ?? mint),
    pumpLamports: pumpLamports.toString(),
    pumpSwapLamports: pumpSwapLamports.toString(),
    totalLamports: totalLamports.toString(),
    graduated: raw.graduated === true,
    hasFeeSharing: raw.hasFeeSharing === true,
    quoteMint: typeof raw.quoteMint === "string" ? raw.quoteMint : null,
    isNativeQuote: raw.isNativeQuote !== false,
    shareholders,
    platformSharePercent,
    payoutAddress: primary ? primary.address : platformWallet,
    checkedAt: new Date().toISOString(),
  };
}

/** Recent claim rows, newest first. Never throws (empty list on DB errors). */
export async function getRecentClaims(
  limit = 5
): Promise<CreatorFeeClaimRecord[]> {
  try {
    const rows = await prisma.creatorFeeClaim.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(serializeClaim);
  } catch {
    return [];
  }
}

/** Full payload for the admin card. Never throws. */
export async function getCreatorFeeStatus(): Promise<CreatorFeeStatus> {
  /*
   * pump.fun creator fees are a SOLANA feature: the claimable amounts come from
   * a pumpdev transaction and the minimum balance is a Solana rent exemption.
   * Without this guard the Solana `Connection` sent those methods to the EVM node
   * and Alchemy answered `getMinimumBalanceForRentExemption is not available on
   * the ROBINHOOD_MAINNET` (owner report, 2026-10-29). Returning the same shape
   * keeps the admin card rendering without an RPC storm.
   */
  if (CHAIN_KIND !== "solana") {
    return {
      configured: false,
      network: null,
      platformWallet: null,
      mint: null,
      snapshot: null,
      error: `Creator fees are pump.fun/Solana only — not available on ${CHAIN_LABEL}.`,
      platformBalanceSol: null,
      auto: await getAutoClaimConfig(),
      costs: {
        feeLamports: "0",
        rentExemptLamports: "0",
        requiredBalanceLamports: "0",
        netLamports: null,
      },
      lastClaim: null,
      claims: [],
    };
  }

  const auto = await getAutoClaimConfig();
  // The admin card renders these as a table, so 8 rows fit without scrolling
  // and still keep the payload small.
  const claims = await getRecentClaims(8);
  const rentExemptLamports = await getRentExemptLamports();

  let network: "mainnet" | "devnet" | null = null;
  let platformWallet: string | null = null;
  let mint: string | null = null;
  let configured = false;
  let error: string | null = null;
  let snapshot: CreatorFeeSnapshot | null = null;
  let platformBalanceSol: number | null = null;

  try {
    const cfg = getConfig();
    network = cfg.network;
    mint = cfg.tokenMint;
    platformWallet = getPlatformKeypair().publicKey.toBase58();
    configured = true;
  } catch (e) {
    error = `Config incomplete: ${(e as Error).message}`;
  }

  if (configured && platformWallet && mint) {
    try {
      platformBalanceSol = lamportsToSol(
        await getConnection().getBalance(getPlatformKeypair().publicKey)
      );
    } catch (e) {
      error = `RPC error: ${shortError((e as Error).message, 160)}`;
    }

    if (network !== "mainnet") {
      error =
        "Creator fees are mainnet-only — the current network is devnet, so there is nothing to claim here.";
    } else {
      try {
        snapshot = await fetchCreatorFeeSnapshot(platformWallet, mint);
      } catch (e) {
        error = shortError((e as Error).message, 300);
      }
    }
  }

  return {
    configured,
    network,
    platformWallet,
    mint,
    snapshot,
    error,
    platformBalanceSol,
    auto,
    costs: {
      feeLamports: String(claimFeeLamports(auto.priorityFeeSol)),
      rentExemptLamports: String(rentExemptLamports),
      requiredBalanceLamports: String(
        Math.max(
          Number(solToLamports(auto.minWalletSol)),
          claimFeeLamports(auto.priorityFeeSol) + rentExemptLamports
        )
      ),
      netLamports: snapshot
        ? String(
            BigInt(snapshot.totalLamports) -
              BigInt(claimFeeLamports(auto.priorityFeeSol))
          )
        : null,
    },
    lastClaim:
      claims.find((c) => c.status === "confirmed") ?? claims[0] ?? null,
    claims,
  };
}

/** Per-process lock: a cron tick and a manual click must never double-claim. */
let claimInFlight = false;

/** True when a claim (manual or cron) is currently in flight. */
export function isClaimInFlight(): boolean {
  return claimInFlight;
}

/** Poll the RPC until the tx is confirmed/finalized, fails, or times out. */
async function waitForConfirmation(signature: string): Promise<void> {
  const connection = getConnection();
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const { value } = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      const status = value[0];
      if (status?.err) {
        throw new Error(
          `Transaction failed on-chain: ${JSON.stringify(status.err)}`
        );
      }
      if (
        status?.confirmationStatus === "confirmed" ||
        status?.confirmationStatus === "finalized"
      ) {
        return;
      }
    } catch (e) {
      // A transient RPC hiccup should not abort a tx that may still land.
      if ((e as Error).message.startsWith("Transaction failed on-chain")) {
        throw e;
      }
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error(
    `Transaction not confirmed within ${CONFIRM_TIMEOUT_MS / 1000}s`
  );
}

interface PreparedClaim {
  publicKey: string;
  mint: string;
  platform: Keypair;
  snap: CreatorFeeSnapshot;
  total: bigint;
  source: "manual" | "auto";
  priorityFeeSol: number;
  /** Base + priority fee this tx will be charged. */
  feeLamports: number;
  /** Floor the payer must still hold after the fee. */
  rentExemptLamports: number;
  rowId: bigint | null;
}

/**
 * Claim creator fees into the wallet(s) configured on-chain.
 *
 * `minLamports` is the auto-claim threshold (manual claims pass 0). Returns
 * `{ ok: false, skipped: true }` when nothing was attempted — no fees, below
 * threshold, wallet too poor to pay fees, or another claim is in flight.
 */
export async function claimCreatorFees(options?: {
  source?: "manual" | "auto";
  minLamports?: bigint;
}): Promise<ClaimOutcome> {
  if (CHAIN_KIND !== "solana") {
    // See getCreatorFeeStatus(): a claim needs the Solana signing key + rent math.
    return {
      ok: false,
      skipped: true,
      error: `Creator fees are pump.fun/Solana only — not available on ${CHAIN_LABEL}.`,
    };
  }

  const source = options?.source ?? "manual";
  const minLamports = options?.minLamports ?? 0n;

  if (claimInFlight) {
    return {
      ok: false,
      skipped: true,
      error: "A claim is already in progress — try again in a moment.",
    };
  }
  claimInFlight = true;

  let rowId: bigint | null = null;
  try {
    const cfg = getConfig();
    if (cfg.network !== "mainnet") {
      return {
        ok: false,
        skipped: true,
        error:
          "Creator fees are mainnet-only (SOLANA_NETWORK is set to devnet).",
      };
    }

    const platform = getPlatformKeypair();
    const publicKey = platform.publicKey.toBase58();
    const auto = await getAutoClaimConfig();

    let snap: CreatorFeeSnapshot;
    try {
      snap = await fetchCreatorFeeSnapshot(publicKey, cfg.tokenMint);
    } catch (e) {
      return { ok: false, skipped: true, error: (e as Error).message };
    }

    const total = BigInt(snap.totalLamports);
    if (total <= 0n) {
      return {
        ok: false,
        skipped: true,
        error: "No claimable creator fees right now.",
      };
    }
    if (total < minLamports) {
      return {
        ok: false,
        skipped: true,
        error:
          `Claimable ${formatSol(total)} is below the ` +
          `${formatSol(minLamports)} auto-claim threshold.`,
      };
    }

    // What this attempt actually costs: the base signature fee plus the
    // priority fee pumpdev puts into the tx. A pot smaller than that is a
    // guaranteed loss, so refuse it for manual clicks too (not only when the
    // auto-claim threshold applies).
    const feeLamports = claimFeeLamports(auto.priorityFeeSol);
    if (total <= BigInt(feeLamports)) {
      return {
        ok: false,
        skipped: true,
        error:
          `Claimable ${formatSol(total, 6)} is less than the ` +
          `${formatSol(feeLamports, 6)} claim fee (5,000 lamports base + ` +
          "priority). Claiming now would cost more than it pays — let the fee " +
          "pot grow.",
      };
    }

    // The signing wallet pays the fee *and* must stay rent-exempt afterwards:
    // a tx that would leave the payer below the floor is rejected in
    // simulation with empty logs, so "more than the fee" is not enough.
    const rentExemptLamports = await getRentExemptLamports();
    const requiredLamports = Math.max(
      Number(solToLamports(auto.minWalletSol)),
      feeLamports + rentExemptLamports
    );
    let balanceLamports: number;
    try {
      balanceLamports = await getConnection().getBalance(platform.publicKey);
    } catch (e) {
      return {
        ok: false,
        skipped: true,
        error:
          "RPC error reading the platform balance: " +
          shortError((e as Error).message, 160),
      };
    }
    if (balanceLamports < requiredLamports) {
      return {
        ok: false,
        skipped: true,
        error:
          `Platform wallet holds ${formatSol(balanceLamports, 6)} — a claim ` +
          `needs ${formatSol(requiredLamports, 6)} (${formatSol(
            feeLamports,
            6
          )} fee + ${formatSol(rentExemptLamports, 6)} rent-exempt reserve). ` +
          "Seed the platform wallet first.",
      };
    }

    try {
      const row = await prisma.creatorFeeClaim.create({
        data: {
          amountLamports: toDecimalValue(total),
          pumpLamports: toDecimalValue(snap.pumpLamports),
          pumpSwapLamports: toDecimalValue(snap.pumpSwapLamports),
          recipient: snap.payoutAddress,
          source,
          status: "pending",
        },
      });
      rowId = row.id;
    } catch (e) {
      // A DB hiccup must not block a claim that is otherwise valid.
      logEvent(
        "warn",
        "claim",
        `could not record claim start: ${shortError(
          (e as Error).message,
          160
        )}`
      );
    }

    return await broadcastClaim({
      publicKey,
      mint: cfg.tokenMint,
      platform,
      snap,
      total,
      source,
      priorityFeeSol: auto.priorityFeeSol,
      feeLamports,
      rentExemptLamports,
      rowId,
    });
  } finally {
    claimInFlight = false;
  }
}

/** Build → sign → send → confirm, persisting the outcome on the pending row. */
async function broadcastClaim(prep: PreparedClaim): Promise<ClaimOutcome> {
  const { snap, total, source, rowId } = prep;

  const fail = async (
    message: string,
    signature?: string
  ): Promise<ClaimOutcome> => {
    if (rowId !== null) {
      await prisma.creatorFeeClaim
        .update({
          where: { id: rowId },
          data: { status: "failed", error: shortError(message), signature },
        })
        .catch(() => undefined);
    }
    logEvent(
      "error",
      "claim",
      `${source} claim failed: ${message}` + (signature ? ` · tx ${signature}` : "")
    );
    return {
      ok: false,
      signature,
      amountLamports: total.toString(),
      recipient: snap.payoutAddress,
      error: signature ? `${message} · tx ${signature}` : message,
    };
  };

  try {
    const endpoint = snap.hasFeeSharing
      ? "claim-distribute"
      : "claim-account";
    const res = await fetch(`${apiBase()}/api/${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/octet-stream",
      },
      body: JSON.stringify({
        publicKey: prep.publicKey,
        mint: prep.mint,
        priorityFee: prep.priorityFeeSol,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const text = await res.text();
      return await fail(`pumpdev ${res.status}: ${shortError(text)}`);
    }
    if ((res.headers.get("content-type") ?? "").includes("application/json")) {
      const text = await res.text();
      let message = text;
      try {
        const json = JSON.parse(text) as { error?: string; message?: string };
        message = json.error ?? json.message ?? text;
      } catch {
        // keep the raw body
      }
      return await fail(`pumpdev refused the claim: ${shortError(message)}`);
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) {
      return await fail("pumpdev returned an empty transaction.");
    }

    const tx = VersionedTransaction.deserialize(bytes);
    tx.sign([prep.platform]);
    const signature = await getConnection().sendTransaction(tx, {
      skipPreflight: false,
      maxRetries: 3,
    });

    if (rowId !== null) {
      await prisma.creatorFeeClaim
        .update({ where: { id: rowId }, data: { signature } })
        .catch(() => undefined);
    }
    logEvent(
      "info",
      "claim",
      `${source} claim broadcast: ${formatSol(total)} → ${shortAddress(
        snap.payoutAddress ?? prep.publicKey
      )} · tx ${signature}`
    );

    try {
      await waitForConfirmation(signature);
    } catch (e) {
      return await fail(shortError((e as Error).message), signature);
    }

    if (rowId !== null) {
      await prisma.creatorFeeClaim
        .update({
          where: { id: rowId },
          data: { status: "confirmed", confirmedAt: new Date(), error: null },
        })
        .catch(() => undefined);
    }
    logEvent(
      "success",
      "claim",
      `${source} claim confirmed: ${formatSol(total)} → ${shortAddress(
        snap.payoutAddress ?? prep.publicKey
      )} · tx ${signature}`
    );
    return {
      ok: true,
      signature,
      amountLamports: total.toString(),
      recipient: snap.payoutAddress,
    };
  } catch (e) {
    return await fail(
      explainSendError(
        shortError(describeFetchError(e), 400),
        prep.feeLamports,
        prep.rentExemptLamports
      )
    );
  }
}





