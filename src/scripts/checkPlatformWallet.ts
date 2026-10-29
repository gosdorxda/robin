import { loadEnvConfig } from "@next/env";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getConfig } from "../lib/config";

/**
 * Platform-wallet balance diagnostic.
 *
 * Run with:  npx tsx src/scripts/checkPlatformWallet.ts
 *
 * Loads `.env`/`.env.local` exactly like Next.js does (via @next/env) so this
 * standalone tsx script sees the same env vars the running app uses, then prints:
 *   - the configured network + RPC URL
 *   - the platform wallet pubkey derived from PLATFORM_WALLET_SECRET
 *   - that wallet's balance via the APP's configured RPC
 *   - cross-checks on devnet + mainnet public RPCs
 *
 * This pinpoints why the admin panel may show "0 SOL" despite a faucet airdrop:
 * wrong pubkey (airdrop to a different address), wrong cluster (app RPC not
 * devnet), or stale process cache (env changed but `next dev` not restarted).
 */
async function main(): Promise<void> {
  loadEnvConfig(process.cwd());

  const cfg = getConfig();
  const pubkey = Keypair.fromSecretKey(cfg.platformWalletSecret).publicKey;

  const fmt = (lamports: number) =>
    `${lamports} lamports = ${lamports / LAMPORTS_PER_SOL} SOL`;

  console.log("=== Platform Wallet Diagnostic ===");
  console.log("SOLANA_NETWORK  :", cfg.network);
  console.log("SOLANA_RPC_URL  :", cfg.solanaRpcUrl);
  console.log("Platform pubkey :", pubkey.toBase58());
  console.log("Token mint      :", cfg.tokenMint);
  console.log("Token decimals  :", cfg.tokenDecimals);
  console.log("");

  // 1) Balance via the app's configured RPC (what the running app actually queries).
  const appConn = new Connection(cfg.solanaRpcUrl, "confirmed");
  const balApp = await appConn.getBalance(pubkey, "confirmed");
  console.log("Balance via APP RPC        :", fmt(balApp));

  // 2) Cross-check on devnet public RPC.
  const devnetConn = new Connection("https://api.devnet.solana.com", "confirmed");
  const balDevnet = await devnetConn.getBalance(pubkey, "confirmed");
  console.log("Balance via DEVNET public  :", fmt(balDevnet));

  // 3) Cross-check on mainnet public RPC (catches "env still points to mainnet").
  const mainnetConn = new Connection(
    "https://api.mainnet-beta.solana.com",
    "confirmed"
  );
  const balMainnet = await mainnetConn.getBalance(pubkey, "confirmed");
  console.log("Balance via MAINNET public :", fmt(balMainnet));

  const reserve = cfg.prizeReserveLamports;
  const prizePoolApp = BigInt(balApp) - reserve;
  const prizePoolClamped = prizePoolApp > 0n ? prizePoolApp : 0n;
  console.log("");
  console.log("Reserve          :", fmt(Number(reserve)));
  console.log(
    "Prize pool (app) :",
    fmt(Number(prizePoolClamped)),
    prizePoolApp > 0n ? "" : "(balance below reserve -> clamped to 0)"
  );

  console.log("");
  console.log("=== Interpretation ===");
  if (balDevnet > 0 && balApp === 0) {
    console.log(
      "-> SOL ada di DEVNET, tapi app RPC BUKAN devnet (atau belum direstart)."
    );
    console.log(
      "   Fix: pastikan SOLANA_RPC_URL = endpoint devnet, lalu RESTART `next dev`."
    );
  } else if (balDevnet === 0 && balMainnet === 0) {
    console.log("-> Pubkey ini gak ada SOL di devnet MAUPUN mainnet.");
    console.log(
      "   Kemungkinan airdrop ke address yang BEDA dari platform pubkey di atas."
    );
    console.log(
      "   Bandingkan 'Platform pubkey' dengan address yang kamu isi di faucet."
    );
  } else if (balApp > 0) {
    console.log("-> App RPC sudah lihat SOL-nya.");
    console.log(
      "   Kalau admin masih 0, RESTART `next dev` (config+connection di-cache per-proses)."
    );
  } else {
    console.log("-> Kasus lain — periksa baris saldo di atas.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});