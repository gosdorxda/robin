import { loadEnvConfig } from "@next/env";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getConfig } from "../lib/config";

/**
 * Devnet SOL airdrop to the platform wallet.
 *
 * Run with:  npx tsx src/scripts/airdrop.ts [SOL]
 *   SOL  -> amount to request (default 2). Devnet RPC usually caps at 2 SOL/req.
 *
 * Uses `connection.requestAirdrop` (standard JSON-RPC faucet method) — works on
 * Windows without the Solana CLI. The platform wallet is the recipient; no
 * signing required for an airdrop.
 */
async function main(): Promise<void> {
  loadEnvConfig(process.cwd());

  const cfg = getConfig();
  if (cfg.network !== "devnet") {
    throw new Error(
      `Refusing to airdrop: SOLANA_NETWORK is "${cfg.network}", not "devnet". Airdrops are devnet-only.`
    );
  }

  const sol = Number(process.argv[2] ?? 2);
  const lamports = Math.floor(sol * LAMPORTS_PER_SOL);
  const conn = new Connection(cfg.solanaRpcUrl, "confirmed");
  const pubkey = Keypair.fromSecretKey(cfg.platformWalletSecret).publicKey;

  const before = await conn.getBalance(pubkey, "confirmed");
  console.log("=== Airdrop ===");
  console.log("network        :", cfg.network);
  console.log("rpc            :", cfg.solanaRpcUrl);
  console.log("platform pubkey:", pubkey.toBase58());
  console.log("balance before :", before / LAMPORTS_PER_SOL, "SOL");
  console.log("requesting     :", sol, "SOL ...");

  const sig = await conn.requestAirdrop(pubkey, lamports);
  await conn.confirmTransaction(sig, "confirmed");

  const after = await conn.getBalance(pubkey, "confirmed");
  console.log("balance after  :", after / LAMPORTS_PER_SOL, "SOL");
  console.log("signature      :", sig);
  console.log(
    "explorer       :",
    `https://solscan.io/tx/${sig}?cluster=devnet`
  );
}

main().catch((e) => {
  console.error("Airdrop failed:", e);
  process.exit(1);
});