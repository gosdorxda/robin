/**
 * Server-only by contract — deliberately NOT `import "server-only"`.
 *
 * `server-only` is aliased by Next's bundler but is not a real installed package
 * (`node_modules/server-only` does not exist in this repo), so importing it
 * breaks every `tsx` script that reaches this module — verified 2026-10-29 with
 * `npm run lottery:run` → `MODULE_NOT_FOUND`. Client code must import
 * `@/lib/chain/network` instead (dependency-free: no Prisma, no chain SDKs).
 */
import { CHAIN_KIND, NATIVE_DECIMALS, NATIVE_SYMBOL, explorerLink } from "./network";
import { robinhoodAdapter } from "./robinhood";
import { solanaAdapter } from "./solana";
import type { ChainKind } from "./network";
import type { ChainAdapter } from "./types";

/**
 * Server-side chain entry point: `getChain()` returns the adapter for the chain
 * this deployment runs on (`NEXT_PUBLIC_CHAIN`, default Solana).
 *
 * Everything the backend does with the chain — balances, holder snapshots,
 * address validation, explorer links — goes through here, so adding a chain
 * means adding one adapter, not teaching the whole app a second SDK.
 *
 * Robinhood Chain is registered **read-only** since 2026-10-29 (Phase 2a):
 * balances, holders and address validation work, but `payoutsImplemented` is
 * false, so the draw engine refuses to create rounds until payouts land in
 * Phase 2b (`MIGRATION-ROBINHOOD.md`).
 */
const ADAPTERS: Partial<Record<ChainKind, ChainAdapter>> = {
  solana: solanaAdapter,
  robinhood: robinhoodAdapter,
};

let cached: ChainAdapter | null = null;

/**
 * The active chain adapter. Throws (instead of falling back to Solana) when a
 * chain is selected that has no implementation yet: silently reading Solana
 * balances while the operator believes they moved to another chain would be a
 * much worse failure than a loud one — the draw would pay out on the wrong
 * network.
 */
export function getChain(): ChainAdapter {
  if (cached) return cached;
  const adapter = ADAPTERS[CHAIN_KIND];
  if (!adapter) {
    throw new Error(
      `No chain adapter for "${CHAIN_KIND}" yet (Phase 2 of MIGRATION-ROBINHOOD.md). ` +
        `Unset NEXT_PUBLIC_CHAIN or set it to "solana" to keep running on Solana.`
    );
  }
  cached = adapter;
  return cached;
}

/**
 * Token address of the ACTIVE chain, straight from env: `TOKEN_MINT` (base58) on
 * Solana, `TOKEN_ADDRESS` (`0x…`) on EVM. Routes used to read `TOKEN_MINT`
 * directly, so the homepage contract-address strip still pointed at the Solana
 * mint after the switch (owner report, 2026-10-29).
 */
export function activeTokenAddress(): string | null {
  const raw =
    CHAIN_KIND === "solana" ? process.env.TOKEN_MINT : process.env.TOKEN_ADDRESS;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

export {
  CHAIN_ID,
  CHAIN_KIND,
  CHAIN_LABEL,
  NATIVE_DECIMALS,
  NATIVE_SYMBOL,
  explorerLink,
  looksLikeChainAddress,
} from "./network";
export type { ChainAdapter, ChainHolder, ChainHolderSnapshot } from "./types";
export type { ChainKind } from "./network";
