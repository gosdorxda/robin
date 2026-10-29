import { syncHolders } from "../lib/sync";

/**
 * Manual holder sync: `npm run holders:sync` (uses tsx).
 * Snapshots all non-zero Pay token holders on-chain and persists them to the DB.
 */
async function main(): Promise<void> {
  const res = await syncHolders();
  console.log(
    `Synced ${res.totalHolders} holders @ ${res.capturedAt.toISOString()}`
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
