/** Server-only by contract (no `import "server-only"` — see `./index.ts`). */
import { PublicKey } from "@solana/web3.js";
import { getConnection, getPlatformKeypair, getTreasuryPubkey } from "@/lib/solana/connection";
import { snapshotHolders } from "@/lib/solana/holders";
import {
  NATIVE_DECIMALS,
  NATIVE_SYMBOL,
  explorerLink,
} from "./network";
import type { ChainAdapter, ChainHolderSnapshot } from "./types";

/**
 * Solana implementation of `ChainAdapter` — a thin delegation layer over the
 * code that already existed, so switching the app to another chain means
 * swapping THIS file instead of editing the engine, the API routes and the
 * scripts. No behaviour lives here: every method calls the same helper the old
 * callers used (`getConnection`, `snapshotHolders`, `PublicKey` validation).
 *
 * `snapshotHolders()` (wallet-level aggregation + the "0 holders" diagnostics)
 * stays in `src/lib/solana/holders.ts`; it already returns wallet owners, which
 * is what the draw needs.
 */
export const solanaAdapter: ChainAdapter = {
  kind: "solana",
  /** Solana payouts are implemented (SystemProgram transfers in the engine). */
  payoutsImplemented: true,
  nativeSymbol: NATIVE_SYMBOL,
  nativeDecimals: NATIVE_DECIMALS,

  explorer: explorerLink,

  /** Platform (hot) wallet address — base58, from PLATFORM_WALLET_SECRET. */
  platformAddress: () => getPlatformKeypair().publicKey.toBase58(),

  /** Optional fee treasury (Solana: PLATFORM_TREASURY_SECRET). */
  treasuryAddress: () => getTreasuryPubkey()?.toBase58() ?? null,

  async getNativeBalance(address: string): Promise<bigint> {
    const lamports = await getConnection().getBalance(
      new PublicKey(address),
      "confirmed"
    );
    return BigInt(lamports);
  },

  async listHolders(): Promise<ChainHolderSnapshot> {
    const { holders, totalHolders, fetchedAt } = await snapshotHolders();
    return {
      holders: holders.map((h) => ({
        owner: h.owner,
        amount: h.amount,
        decimals: h.decimals,
        tokenAccount: h.tokenAccount,
      })),
      totalHolders,
      fetchedAt,
    };
  },

  normalizeAddress(raw: string): string {
    const value = String(raw ?? "").trim();
    if (!value) throw new Error("Wallet address is required");
    try {
      // PublicKey also rejects the all-zero key and non-32-byte input.
      return new PublicKey(value).toBase58();
    } catch {
      throw new Error("Not a valid Solana address (base58, 32 bytes)");
    }
  },

  isValidAddress(value: string): boolean {
    try {
      new PublicKey(String(value ?? "").trim());
      return true;
    } catch {
      return false;
    }
  },
};
