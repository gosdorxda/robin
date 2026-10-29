/**
 * Chain identity — the ONE place that knows which chain this deployment runs on.
 *
 * Client-safe by design: it reads only `NEXT_PUBLIC_*` values plus literals, so
 * server code (API routes, engine, scripts) and client components (sidebar,
 * draw cards, holder table) resolve the same native unit and the same explorer
 * host. Two sources of truth here would let the server-rendered HTML and the
 * hydrated client disagree about a currency label.
 *
 * Today only `solana` is implemented, and every value below reproduces the
 * behaviour it replaces exactly (SOL · 9 decimals · solscan.io with
 * `?cluster=devnet`). The Robinhood migration (see `MIGRATION-ROBINHOOD.md`)
 * adds the `robinhood` branch here plus the server adapter in
 * `src/lib/chain/index.ts`.
 */
export type ChainKind = "solana" | "robinhood";

const requested = (process.env.NEXT_PUBLIC_CHAIN ?? "").trim().toLowerCase();

/** Chain this build talks to. Empty/unknown value keeps today's behaviour. */
export const CHAIN_KIND: ChainKind =
  requested === "robinhood" ? "robinhood" : "solana";

/** Human unit of the chain's gas/prize coin — "SOL" today, "ETH"-style later. */
export const NATIVE_SYMBOL: string =
  (process.env.NEXT_PUBLIC_NATIVE_SYMBOL ?? "").trim() ||
  (CHAIN_KIND === "robinhood" ? "ETH" : "SOL");

/** Decimals of the native coin: 9 (lamports) on Solana, 18 (wei) on EVM. */
export const NATIVE_DECIMALS: number = (() => {
  // Note: `Number("")` is 0, which would silently mean "no decimals" — so an
  // unset/blank variable must be distinguished from a real 0 before parsing.
  const raw = (process.env.NEXT_PUBLIC_NATIVE_DECIMALS ?? "").trim();
  if (raw !== "") {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0 && n <= 18) return n;
  }
  return CHAIN_KIND === "robinhood" ? 18 : 9;
})();

/**
 * Smallest-unit conversion factor: lamports per SOL (1e9) on Solana, wei per
 * native coin (1e18) on EVM. `format.ts` divides by this instead of the old
 * `LAMPORTS_PER_SOL` constant, so switching chains does not require touching
 * the ~60 call sites that already call `lamportsToSol` / `fmtSolNum`.
 */
export const BASE_UNITS_PER_NATIVE = 10 ** NATIVE_DECIMALS;

/** Human label of the active chain, for logs and error messages. */
export const CHAIN_LABEL =
  CHAIN_KIND === "robinhood" ? "Robinhood Chain (4663)" : "Solana";

/**
 * Chain name as it should be written in prose (meta descriptions, page copy).
 * Separate from `CHAIN_LABEL` so a `(4663)` chain id — useful in a log line —
 * never leaks into a social share card.
 */
export const CHAIN_NAME = CHAIN_KIND === "robinhood" ? "Robinhood Chain" : "Solana";

/** EIP-155 chain id — null on Solana, which has no such concept. */
export const CHAIN_ID: number | null =
  CHAIN_KIND === "robinhood" ? 4663 : null;

/**
 * The launchpad whose creator fees fund the prize pool: **pump.fun** on Solana,
 * **pons** (Robinhood Chain's launchpad) everywhere else.
 *
 * One source of truth for the flow-chart card, the homepage footer and the
 * how-it-works copy. A hardcoded launchpad name is a claim about where the money
 * actually comes from, so it has to follow the chain for the same reason
 * `NATIVE_SYMBOL` does — otherwise the flow chart keeps advertising a launchpad
 * the draw no longer reads fees from.
 */
export const FEE_SOURCE_LABEL = CHAIN_KIND === "solana" ? "pump.fun" : "pons";

/** Card title for the fee-source step ("Pump.fun trading" / "Pons trading"). */
export const FEE_SOURCE_TITLE =
  CHAIN_KIND === "solana" ? "Pump.fun trading" : "Pons trading";

/**
 * Logo for the fee-source card, served from `public/`. Both files ship with the
 * app; `HowItWorksFlow` falls back to its lucide icon if the file 404s, so a
 * missing asset can never render a broken-image glyph.
 */
export const FEE_SOURCE_LOGO =
  CHAIN_KIND === "solana" ? "/flow/pumpfun.png" : "/flow/pons.png";

/**
 * Per-chain explorer URL scheme.
 *
 * Robinhood Chain: Blockscout is the official explorer
 * (`https://robinhoodchain.blockscout.com`, path scheme `/tx/{h}`,
 * `/address/{a}`, `/token/{a}`); `robinscanner.com` is the alternative.
 * Override with `NEXT_PUBLIC_EXPLORER_URL` when that changes.
 */
const EXPLORERS: Record<
  ChainKind,
  { base: string; tx: string; address: string }
> = {
  solana: { base: "https://solscan.io", tx: "tx", address: "account" },
  robinhood: {
    base:
      (process.env.NEXT_PUBLIC_EXPLORER_URL ?? "").trim().replace(/\/+$/, "") ||
      "https://robinhoodchain.blockscout.com",
    tx: "tx",
    address: "address",
  },
};

/**
 * Explorer link for an address or a transaction. Returns "" when the chain has
 * no configured explorer (callers already treat "" as "no link"), so a
 * half-configured migration can never render a broken URL.
 */
export function explorerLink(
  value: string,
  kind: "address" | "tx" = "address",
  network: "mainnet" | "devnet" = "mainnet"
): string {
  const explorer = EXPLORERS[CHAIN_KIND];
  if (!explorer.base || !value) return "";
  const path = kind === "tx" ? explorer.tx : explorer.address;
  // Solana clusters are a query flag; EVM networks live in the host itself, so
  // the "devnet" suffix only applies where the chain actually has one.
  const suffix =
    CHAIN_KIND === "solana" && network === "devnet" ? "?cluster=devnet" : "";
  return `${explorer.base}/${path}/${value}${suffix}`;
}

/**
 * Cheap, framework-free address shape check for client code (form validation,
 * hiding links for junk input). Server code uses the adapter's
 * `normalizeAddress()`, which does the real cryptographic check.
 */
export function looksLikeChainAddress(value: string): boolean {
  const v = (value ?? "").trim();
  if (!v) return false;
  return CHAIN_KIND === "robinhood"
    ? /^0x[0-9a-fA-F]{40}$/.test(v)
    : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
}
