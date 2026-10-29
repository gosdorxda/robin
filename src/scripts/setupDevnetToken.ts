import { loadEnvConfig } from "@next/env";
import bs58 from "bs58";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  mintTo,
  transfer,
  createMint,
} from "@solana/spl-token";
import { getConfig } from "../lib/config";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Devnet SPL token + test-holder bootstrap (Windows-friendly, no Solana CLI).
 *
 * Run with:  npx tsx src/scripts/setupDevnetToken.ts
 *
 * Creates a fresh SPL token mint on the configured (devnet) RPC using the
 * platform wallet as payer + mint/freeze authority, mints a supply to the
 * platform ATA, then generates `winnerCount + 2` test-holder keypairs (min 5),
 * creates their ATAs, and transfers each an amount well above MIN_TOKEN_ELIGIBLE
 * so Sync finds eligible holders (the platform wallet is excluded from
 * eligibility by the lottery engine, so we MUST seed other wallets).
 *
 * Saves the generated holder keypairs (base58) to devnet-test-wallets.json so
 * you can import any of them into Phantom (devnet) to claim prize payouts.
 */
async function main(): Promise<void> {
  loadEnvConfig(process.cwd());

  const cfg = getConfig();
  if (cfg.network !== "devnet") {
    throw new Error(
      `Refusing: SOLANA_NETWORK is "${cfg.network}", not "devnet".`
    );
  }

  const conn = new Connection(cfg.solanaRpcUrl, "confirmed");
  const payer = Keypair.fromSecretKey(cfg.platformWalletSecret);
  const decimals = cfg.tokenDecimals;
  const minEligible = cfg.minTokenEligible;

  const holderCount = Math.max(cfg.winnerCount + 2, 5);
  const perHolder = minEligible * 100n; // comfortably above eligibility threshold
  const totalSupply = perHolder * BigInt(holderCount + 1); // holders + platform buffer

  console.log("=== Devnet Token Setup ===");
  console.log("network         :", cfg.network);
  console.log("rpc             :", cfg.solanaRpcUrl);
  console.log("payer/platform  :", payer.publicKey.toBase58());
  console.log(
    "balance         :",
    (await conn.getBalance(payer.publicKey, "confirmed")) / LAMPORTS_PER_SOL,
    "SOL"
  );
  console.log("decimals        :", decimals);
  console.log("minTokenEligible:", minEligible.toString(), "raw");
  console.log("winnerCount     :", cfg.winnerCount);
  console.log("test holders    :", holderCount);
  console.log("per holder      :", perHolder.toString(), "raw");
  console.log("total supply    :", totalSupply.toString(), "raw");
  console.log("");

  // 1) Create the mint (standard Token program; holders.ts resolves either program).
  console.log("Creating mint ...");
  const mint = await createMint(
    conn,
    payer,
    payer.publicKey, // mint authority
    payer.publicKey, // freeze authority
    decimals
  );
  console.log("mint            :", mint.toBase58());

  // 2) Platform ATA + mint the full supply there.
  console.log("Creating platform ATA ...");
  const platformAta = await getOrCreateAssociatedTokenAccount(
    conn,
    payer,
    mint,
    payer.publicKey
  );
  console.log("platform ATA    :", platformAta.address.toBase58());

  console.log("Minting supply  :", totalSupply.toString(), "raw ...");
  await mintTo(conn, payer, mint, platformAta.address, payer, totalSupply);

  // 3) Generate test holders, create ATAs, transfer tokens.
  const holders: { address: string; secret: string }[] = [];
  for (let i = 0; i < holderCount; i++) {
    const kp = Keypair.generate();
    const ata = await getOrCreateAssociatedTokenAccount(
      conn,
      payer,
      mint,
      kp.publicKey
    );
    await transfer(
      conn,
      payer,
      platformAta.address, // source
      ata.address, // destination
      payer, // owner of source (signs)
      perHolder
    );
    holders.push({
      address: kp.publicKey.toBase58(),
      secret: bs58.encode(kp.secretKey),
    });
    console.log(
      `holder ${i + 1}/${holderCount} : ${kp.publicKey.toBase58()} <- ${perHolder.toString()} raw`
    );
  }

  // 4) Persist holder keypairs so payouts can be claimed via Phantom.
  const outPath = join(process.cwd(), "devnet-test-wallets.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      { mint: mint.toBase58(), decimals, perHolderRaw: perHolder.toString(), holders },
      null,
      2
    )
  );

  console.log("");
  console.log("Saved test wallets to:", outPath);
  console.log("");
  console.log("=== NEXT STEPS ===");
  console.log("1. Set in .env:");
  console.log(`   TOKEN_MINT=${mint.toBase58()}`);
  console.log(`   TOKEN_DECIMALS=${decimals}`);
  console.log("2. Restart: npm run dev");
  console.log("3. Admin -> Sync Holders  (should find", holderCount, "eligible)");
  console.log("4. Admin -> Trigger Draw");
  console.log("");
  console.log("Tip: import any holder secret from devnet-test-wallets.json into");
  console.log("     Phantom (devnet) to view/claim prize payouts.");
}

main().catch((e) => {
  console.error("Setup failed:", e);
  process.exit(1);
});