import { runLotteryRound } from "../lib/lottery/engine";

/**
 * Manual lottery runner: `npm run lottery:run` (uses tsx).
 * Runs a single round end-to-end (drand randomness + SOL payouts) and
 * prints the result as JSON. Exits 0 on completion, 1 on failure.
 */
async function main(): Promise<void> {
  const res = await runLotteryRound({ debug: true });
  console.log(JSON.stringify(res, null, 2));
  // "skipped" is a deliberate no-op (pool below minimum), not a failure.
  process.exit(res.status === "failed" ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
