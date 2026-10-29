import {
  BASE_UNITS_PER_NATIVE,
  NATIVE_SYMBOL,
  explorerLink,
} from "./chain/network";

/**
 * Convert base units (lamports / wei) to the native coin as a number.
 *
 * The name is a Solana leftover, kept on purpose: the divisor now comes from the
 * chain layer (`BASE_UNITS_PER_NATIVE` = 1e9 on Solana, 1e18 on EVM), so the
 * ~60 call sites keep working unchanged across the Robinhood migration. The
 * rename happens in Phase 3, together with the "SOL" labels in the UI.
 *
 * Accepts anything stringifiable — `bigint`, `number`, and Prisma's `Decimal`
 * (the amount columns are Postgres `numeric` since 2026-10-29, see
 * `db-amount.ts`). Display-only: precision beyond ~17 significant digits is lost
 * on purpose, exactly as the old `Number()` version did.
 */
export type NativeAmountInput = bigint | number | string | { toString(): string };

export function lamportsToSol(lamports: NativeAmountInput): number {
  return Number(lamports.toString()) / BASE_UNITS_PER_NATIVE;
}

/** Convert the native coin (number) to base units (bigint), rounded. */
export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * BASE_UNITS_PER_NATIVE));
}

/**
 * Decimals used for every SOL **amount** in the UI (prize pools, payouts, fees,
 * totals, estimates): always exactly 4, e.g. `0.0013 SOL`. Fixed width matters
 * more than trimming here — a column that flips between "0.001" and "0.0013",
 * or between "1.25" and "1.2500", reads as broken alignment rather than as a
 * deliberate level of precision.
 */
export const SOL_DIGITS = 4;

/**
 * Decimals for a raw **wallet balance**. Dust is meaningful at that scale (the
 * rent-exempt floor is 0.00065024 SOL, a swept fee can be 0.00007475 SOL), so
 * the treasury wallet cards keep 6 decimals instead of the usual 4.
 */
export const SOL_BALANCE_DIGITS = 6;

/**
 * Decimals for every SOL figure on the admin **App Info** tab. Fee and pool
 * numbers there run down to dust (a bare network fee is 0.000005 SOL, a swept
 * creator pot can be 0.00007475 SOL), which 4 decimals would print as
 * "0.0000" — i.e. "nothing was paid". Six decimals keep those values readable.
 * Scoped to that tab on purpose: public pages stay on `SOL_DIGITS` so their
 * columns keep the stable 4-decimal width.
 */
export const SOL_ADMIN_DIGITS = 6;

/**
 * SOL number → fixed-decimal string **without** the unit, e.g. `0.0013` (4) or
 * `0.001300` (6). Use this where the "SOL" label is a separate element; use
 * `fmtSolHuman` when the unit belongs to the string.
 */
export function fmtSolNum(sol: number, digits: number = SOL_DIGITS): string {
  if (!Number.isFinite(sol)) return "—";
  const step = 1 / 10 ** digits;
  // A real but sub-precision amount (a 5,000-lamport network fee is 0.000005
  // SOL) must never print as a flat "0.0000" — that reads as "nothing was
  // paid". Show the smallest representable value instead, capped with "<".
  if (sol > 0 && sol < step / 2) return `<${step.toFixed(digits)}`;
  return sol.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * Human-readable SOL string from lamports, with the unit: e.g. 1_250_000
 * lamports → "0.0013 SOL". Always 4 decimals (see `SOL_DIGITS`).
 */
export function formatSol(
  lamports: NativeAmountInput,
  digits: number = SOL_DIGITS
): string {
  return `${fmtSolNum(lamportsToSol(lamports), digits)} ${NATIVE_SYMBOL}`;
}

/** Format a raw token amount (incl. decimals) into a display string. */
export function formatTokenAmount(raw: NativeAmountInput, decimals: number): string {
  const value = BigInt(raw.toString());
  if (decimals <= 0) return value.toLocaleString("en-US");
  const denominator = 10n ** BigInt(decimals);
  const whole = value / denominator;
  const fraction = value % denominator;
  const fracStr = fraction.toString().padStart(decimals, "0").slice(0, 4);
  return `${whole.toLocaleString("en-US")}.${fracStr}`;
}

/**
 * Human-readable SOL string from a SOL **number** (not lamports), with the
 * unit — e.g. 0.0013 → "0.0013 SOL", 100000 → "100,000.0000 SOL". Always 4
 * decimals (see `SOL_DIGITS`); pass `SOL_BALANCE_DIGITS` for a raw wallet
 * balance, which needs 6.
 */
export function fmtSolHuman(
  sol: number,
  digits: number = SOL_DIGITS
): string {
  if (!Number.isFinite(sol)) return "—";
  return `${fmtSolNum(sol, digits)} ${NATIVE_SYMBOL}`;
}

/**
 * Human-readable token amount from a raw integer (string | bigint) + decimals,
 * trimming trailing zeros so e.g. 1_000_000_000 @ 6dp → "1,000" (not
 * "1,000.0000"), and 500_000_000 @ 6dp → "0.5". Whole numbers show no decimal
 * point. Mirrors the helper that used to live locally in the holders page.
 */
export function fmtTokenHuman(raw: NativeAmountInput, decimals: number): string {
  const text = raw.toString();
  if (decimals <= 0) {
    try {
      return BigInt(text).toLocaleString("en-US");
    } catch {
      return text;
    }
  }
  try {
    const r = BigInt(text);
    const denom = 10n ** BigInt(decimals);
    const whole = r / denom;
    const fraction = r % denom;
    if (fraction === 0n) return whole.toLocaleString("en-US");
    const fracStr = fraction
      .toString()
      .padStart(decimals, "0")
      .slice(0, 4)
      .replace(/0+$/, "");
    return `${whole.toLocaleString("en-US")}.${fracStr}`;
  } catch {
    return text;
  }
}

/** Shorten a base58 address, e.g. "9xQe…v3k2". */
export function shortAddress(addr: string, head = 4, tail = 4): string {
  if (!addr) return "";
  if (addr.length <= head + tail) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/**
 * Explorer URL for an address or tx signature. Delegates to the chain layer, so
 * Solscan links become the new chain's explorer in one place (the callers that
 * still keep a local copy — `RecentDraws`, `DrawsList`, `HoldersBrowser` — move
 * over in Phase 3).
 */
export function explorerUrl(
  value: string,
  kind: "address" | "tx" = "address",
  network: "mainnet" | "devnet" = "mainnet"
): string {
  return explorerLink(value, kind, network);
}

/**
 * Absolute UTC timestamp for every surface that shows a clock time:
 * `Oct 26, 08:32 UTC` (the year appears only when it isn't the current UTC
 * year).
 *
 * Why a shared helper: the draw cron, the drand beacon, the holder snapshots
 * and the chain are all UTC, but `toLocale*` without `timeZone` silently uses
 * the visitor's clock — the treasury wallet card read "updated Oct 26, 15:32"
 * (WIB) while the same moment read 08:32 in the API. `hourCycle: "h23"` avoids
 * the en-US "24:00" quirk that `hour12: false` can produce at midnight.
 */
export function fmtDateTimeUtc(iso: string | Date | null): string {
  if (!iso) return "—";
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return typeof iso === "string" ? iso : "—";
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  const stamp = d.toLocaleString("en-US", {
    ...(sameYear ? {} : { year: "numeric" as const }),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  });
  return `${stamp} UTC`;
}

/** Date only, UTC: `Oct 26, 2026`. */
export function fmtDateUtc(iso: string | Date | null): string {
  if (!iso) return "—";
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return typeof iso === "string" ? iso : "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Relative time string, e.g. "just now", "3 min ago", "2h ago", "5d ago".
 * Falls back to a medium-format date (UTC) for anything older than a week.
 */
export function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  try {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return iso;
    const seconds = Math.floor((Date.now() - then) / 1000);
    if (seconds < 0) return "just now";
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString("en-US", {
      dateStyle: "medium",
      timeZone: "UTC",
    });
  } catch {
    return iso;
  }
}
