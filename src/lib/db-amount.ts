/**
 * Helpers for the base-unit amount columns (`HolderSnapshot.amount`, the wei
 * fields on `LotteryRound` / `Winner` / `CreatorFeeClaim`).
 *
 * Why they exist: those columns are Postgres `numeric` since 2026-10-29
 * (`Decimal(78,0)` in Prisma), because int8 tops out at ~9,2e18 while an
 * 18-decimal token balance reaches 1e27. Prisma returns them as `Decimal`, which
 * cannot be mixed with `bigint` in arithmetic — hence the explicit conversions
 * at the read/write boundaries.
 */
export type BaseUnitValue = bigint | number | string | { toString(): string };

/**
 * Column value → bigint, safe for `Decimal`, plain strings and the old int8
 * columns.
 *
 * The `toFixed(0)` branch is essential, not cosmetic: Prisma's `Decimal`
 * (decimal.js) switches to **exponential notation** past 21 digits, so
 * `Decimal("797063843490960830516755487").toString()` is `"7.97063843490960830516755487e+26"`
 * — and `BigInt()` throws on that. `toFixed(0)` expands it back to plain digits.
 * Verified the hard way on 2026-10-29 (an EVM balance of 7,97e26).
 */
export function toBigInt(value: BaseUnitValue | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  const withFixed = value as { toFixed?: (digits?: number) => string };
  if (typeof withFixed.toFixed === "function") {
    return BigInt(withFixed.toFixed(0));
  }
  return BigInt(value.toString());
}

/**
 * bigint/number → a value Prisma accepts for a `Decimal` column. A plain string
 * keeps full precision (a JS number would round anything above 2^53).
 */
export function toDecimalValue(value: bigint | number | string): string {
  return typeof value === "string" ? value : value.toString();
}

/**
 * Column value → a plain decimal string for JSON payloads and the UI. Use this
 * instead of `.toString()` on a `Decimal`, which would emit `7.97e+26`.
 */
export function toBaseUnitString(
  value: BaseUnitValue | null | undefined
): string {
  if (value === null || value === undefined) return "0";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Math.trunc(value).toString();
  const withFixed = value as { toFixed?: (digits?: number) => string };
  if (typeof withFixed.toFixed === "function") return withFixed.toFixed(0);
  return value.toString();
}
