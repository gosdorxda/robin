import { requestRandomness } from "../lib/solana/randomness";

/**
 * Standalone smoke test for the drand randomness module.
 * `npx tsx src/scripts/testDrand.ts`
 * Confirms the drand fetch + cross-relay verification works in the Node runtime,
 * independent of Solana config / DB / payouts.
 */
async function main(): Promise<void> {
  const r = await requestRandomness({ debug: true });
  console.log(
    JSON.stringify(
      {
        valueHex: r.valueHex,
        valueHexLen: r.valueHex.length,
        round: r.round,
        signature: r.signature,
        previousSignature: r.previousSignature,
        chain: r.chain,
        verified: r.verified,
        relay: r.relay,
        bytesLen: r.valueBytes.length,
      },
      null,
      2
    )
  );
  console.log(
    r.verified
      ? "OK: drand beacon fetched + cross-relay verified"
      : "OK (single-relay): drand beacon fetched; cross-relay unavailable"
  );
}

main().catch((e) => {
  console.error("FAIL:", (e as Error).message);
  process.exit(1);
});
