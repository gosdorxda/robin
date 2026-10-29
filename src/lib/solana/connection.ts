import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getConfig } from "../config";

let _connection: Connection | null = null;
let _payer: Keypair | null = null;
let _treasury: Keypair | null | undefined;

/**
 * Solana RPC connection used by the backend (confirmed commitment).
 *
 * Reads `solanaRpcUrl`, NEVER `rpcUrl`: the latter follows the ACTIVE chain, so
 * using it here made the Solana client talk to the EVM node and Alchemy answered
 * `getMinimumBalanceForRentExemption is not available on the ROBINHOOD_MAINNET`
 * (owner report, 2026-10-29). On an EVM deployment this throws immediately with a
 * message that names the variable.
 */
export function getConnection(): Connection {
  if (!_connection) {
    const url = getConfig().solanaRpcUrl;
    if (!url) {
      throw new Error(
        "SOLANA_RPC_URL is not set — this code path is Solana-only (creator fees, rent-exempt math, Solana payout/scripts)."
      );
    }
    _connection = new Connection(url, "confirmed");
  }
  return _connection;
}

/** Platform/hot wallet keypair — pays for & signs all backend Solana txs. */
export function getPlatformKeypair(): Keypair {
  if (!_payer) {
    _payer = Keypair.fromSecretKey(getConfig().platformWalletSecret);
  }
  return _payer;
}

/** Optional platform fee treasury keypair. Returns null when
 *  PLATFORM_TREASURY_SECRET is unset (legacy: fee stays on the platform wallet). */
export function getTreasuryKeypair(): Keypair | null {
  if (_treasury === undefined) {
    const secret = getConfig().platformTreasurySecret;
    _treasury = secret ? Keypair.fromSecretKey(secret) : null;
  }
  return _treasury;
}

/** Treasury wallet public key, or null when not configured. */
export function getTreasuryPubkey(): PublicKey | null {
  const kp = getTreasuryKeypair();
  return kp ? kp.publicKey : null;
}
