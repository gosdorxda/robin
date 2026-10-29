/**
 * The chain-agnostic contract every backend chain integration must satisfy.
 *
 * Types only — no runtime code, no imports from `@solana/*` or `viem`, so the
 * interface can be read (and imported) without dragging a chain SDK along.
 * Implementations live next to it (`solana.ts` today, `robinhood.ts` in Phase 2
 * of `MIGRATION-ROBINHOOD.md`).
 */
import type { ChainKind } from "./network";

/** A token holder as the chain reports it. */
/**
 * Thrown by `ChainAdapter.sendPayouts`. The EVM payout path is NOT atomic (one
 * transaction per winner), so a failure must carry what already landed —
 * otherwise the caller would delete the winner rows and the chain would show
 * money that the database cannot explain (owner hit exactly that on 2026-10-29:
 * fee + 2 winners on-chain, round marked failed, zero winner rows).
 */
export interface PayoutError extends Error {
  /** Transfers that DID land before the failure, in send order. */
  partialPayouts?: {
    address: string;
    amountBaseUnits: bigint;
    txHash: string;
  }[];
  /** Network fee already paid by the landed transfers, in base units. */
  partialFeeBaseUnits?: bigint;
}

export interface ChainHolder {
  /** Wallet that owns the balance — NOT the token account / LP position. */
  owner: string;
  /** Raw balance in base units (decimals included), as an integer string. */
  amount: string;
  /** Token decimals, as read from the chain. */
  decimals: number;
  /**
   * Chain-specific extra: on Solana the representative SPL token account, on
   * EVM usually undefined (a holder is just an address). Optional so the two
   * implementations don't have to fake it.
   */
  tokenAccount?: string;
  /**
   * True when this holder is structurally NOT a player: on EVM the pons bonding
   * curve, Uniswap pools, vaults and other contracts, plus the burn address.
   * `syncHolders` copies these into the exclusion table so every eligibility
   * surface drops them automatically. Undefined on Solana, where venue accounts
   * are DERIVED from the mint instead (`lib/exclusions.ts`).
   */
  isVenue?: boolean;
  /** Human label for the auto-added exclusion row, e.g. "PonsV2BondingCurve". */
  venueLabel?: string;
}

export interface ChainHolderSnapshot {
  holders: ChainHolder[];
  /** Number of non-zero holders the chain itself reports (may exceed `holders`). */
  totalHolders: number;
  fetchedAt: Date;
  /**
   * True when `holders` is NOT the complete list — e.g. the EVM adapter stopped
   * at the eligibility floor or hit its page cap. Solana leaves it undefined
   * because one `getProgramAccounts` really does return everyone.
   */
  truncated?: boolean;
  /** Pages/requests the snapshot needed, for cost visibility in the logs. */
  pagesFetched?: number;
  /**
   * Which source produced this snapshot: `"blockscout"` (the indexer) or
   * `"alchemy-transfers"` (the RPC fallback). Logged by `syncHolders` so the
   * operator can see why a batch looks different.
   */
  source?: string;
}

export interface ChainAdapter {
  readonly kind: ChainKind;
  /** Display unit of the gas/prize coin ("SOL", "ETH", …). */
  readonly nativeSymbol: string;
  /** Decimals of that unit (9 on Solana, 18 on EVM). */
  readonly nativeDecimals: number;

  /** Explorer URL for an address or tx hash; "" when the chain has none. */
  explorer(
    value: string,
    kind?: "address" | "tx",
    network?: "mainnet" | "devnet"
  ): string;

  /**
   * Native-coin balance of an address, in base units (lamports on Solana, wei on
   * EVM). One call, no caching — callers own their own cache TTL.
   */
  getNativeBalance(address: string): Promise<bigint>;

  /**
   * Every current non-zero token holder. This is the riskiest part of any chain
   * swap (Solana answers it in one `getProgramAccounts`; EVM needs logs or an
   * indexer), which is exactly why it sits behind the interface.
   *
   * `opts.minBalance` (base units) lets an adapter with a *sorted* source stop
   * early, and `opts.maxPages` caps the request cost. Both are advisory: an
   * adapter that cannot honour them simply returns everything.
   */
  listHolders(opts?: {
    minBalance?: bigint;
    maxPages?: number;
  }): Promise<ChainHolderSnapshot>;

  /** Strict check; returns the canonical form or throws a user-facing message. */
  normalizeAddress(raw: string): string;

  /** Non-throwing variant of `normalizeAddress`, for form validation. */
  isValidAddress(value: string): boolean;

  /**
   * Address of the platform wallet in chain-native form (base58 on Solana,
   * `0x…` on EVM). Derived from the configured secret / private key, so callers
   * never have to build a chain-specific keypair just to learn the address —
   * that is exactly what used to keep the Solana env keys mandatory on every
   * chain (see MIGRATION-ROBINHOOD.md §3).
   */
  platformAddress(): string;

  /**
   * False until the payout step is implemented for this chain. The lottery
   * engine refuses to run a round when this is false, *before* a round row is
   * created — a chain that cannot pay must never produce a draw that looks real,
   * and must never move funds on a different chain.
   */
  readonly payoutsImplemented: boolean;

  /**
   * Address of the optional platform FEE treasury wallet, or null when none is
   * configured (Solana: `PLATFORM_TREASURY_SECRET`; EVM: `PLATFORM_TREASURY_PRIVATE_KEY`).
   * Used by `/api/wallets` + `/api/admin/info` so the treasury card shows on any
   * chain, and by the payout path to sweep the platform fee.
   */
  treasuryAddress?(): string | null;

  /**
   * Send the prize transfers. Present only on chains whose payout step is
   * implemented (`payoutsImplemented: true`); the engine calls it when it exists
   * and falls back to the legacy Solana path otherwise.
   *
   * `feeTransfer` (optional) moves the round's platform fee to the treasury. The
   * EVM implementation sends it FIRST, because the EVM path is not atomic: a
   * failure there must abort before any prize leaves the wallet.
   *
   * Contract: throw on ANY failure — a partial payout must surface as an error so
   * the caller can keep the winners "pending" rather than marking them "sent".
   * Returns every winner hash: on EVM a payout is one transaction per winner
   * (native transfers cannot be batched without a contract), and only the first
   * hash fits the single `payoutTx` column — callers should log the full list.
   */
  sendPayouts?(
    winners: { address: string; amountLamports: bigint }[],
    feeTransfer?: { amountBaseUnits: bigint; destination: string }
  ): Promise<{
    txHashes: string[];
    /** Hash recorded on the round (the first winner payout). */
    primaryTxHash: string;
    /** Total network fee actually paid, in base units (lamports / wei). */
    feeBaseUnits: bigint;
  }>;

  /*
   * NOT in the contract yet, deliberately: sending prize payouts. Its shape
   * depends on decisions we cannot take blind — native coin vs ERC-20 prizes,
   * one tx per winner vs a batcher, how the platform fee sweep rides along. The
   * interface gets `sendPayouts()` in Phase 2, once those are answered, rather
   * than locking in a Solana-shaped API today.
   */
}
