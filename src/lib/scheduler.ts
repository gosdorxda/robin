import cron from "node-cron";
import { getConfig } from "./config";
import { runLotteryRound } from "./lottery/engine";
import { syncHolders } from "./sync";
import { logEvent } from "./log-buffer";
import { solToLamports } from "./format";

const globalForCron = globalThis as unknown as {
  __payCronRegistered?: boolean;
};

/**
 * Registers the holder-snapshot sync + lottery draw crons via node-cron.
 *
 * This module is intentionally only ever loaded from `src/instrumentation.ts`
 * via a runtime-guarded dynamic `import()`, so that its Node-only dependencies
 * (node-cron, drand, node:crypto, https) are never pulled into the Edge
 * instrumentation bundle.
 *
 * - Skipped silently if env config isn't ready yet, so the app can still boot
 *   during setup (UI previews without secrets).
 * - The SOL-spending lottery cron only runs in production, or when
 *   LOTTERY_CRON_ENABLED=true, to avoid accidental real payouts in dev.
 */
export async function startScheduler(): Promise<void> {
  if (globalForCron.__payCronRegistered) return;
  globalForCron.__payCronRegistered = true;

  let cfg: ReturnType<typeof getConfig>;
  try {
    // Settings are env-only; getConfig() validates them and caches the result.
    cfg = getConfig();
  } catch (e) {
    console.warn(
      "[cron] config not ready — skipping cron registration:",
      (e as Error).message
    );
    logEvent(
      "warn",
      "cron",
      `config not ready — cron registration skipped: ${(e as Error).message}`
    );
    return;
  }

  // Per-process overlap guards. A tick that fires while the previous one is
  // still running (slow RPC / Neon cold start) is skipped instead of stacking.
  // Cross-process duplicates are handled in the engine by the round-claim lock.
  let syncing = false;
  let drawing = false;

  // Holder balance snapshot sync (read-only; safe in any environment).
  cron.schedule(cfg.holderSyncCron, async () => {
    if (syncing) {
      console.warn("[cron] holder sync still running — tick skipped");
      return;
    }
    syncing = true;
    try {
      const res = await syncHolders();
      console.log(
        `[cron] holders synced: ${res.totalHolders} @ ${res.capturedAt.toISOString()}`
      );
    } catch (e) {
      console.error("[cron] holder sync failed:", (e as Error).message);
      logEvent("error", "cron", `holder sync failed: ${(e as Error).message}`);
    } finally {
      syncing = false;
    }
  });

  const lotteryEnabled =
    process.env.NODE_ENV === "production" ||
    process.env.LOTTERY_CRON_ENABLED === "true";

  if (lotteryEnabled) {
    cron.schedule(cfg.lotteryCron, async () => {
      if (drawing) {
        console.warn("[cron] draw still running — tick skipped");
        logEvent("warn", "cron", "draw still running — tick skipped");
        return;
      }
      drawing = true;
      try {
        const res = await runLotteryRound({ debug: true });
        console.log(
          `[cron] lottery round ${res.roundNumber}: ${res.status}` +
            (res.error ? ` — ${res.error}` : "")
        );
      } catch (e) {
        console.error("[cron] lottery failed:", (e as Error).message);
        logEvent(
          "error",
          "cron",
          `lottery round failed: ${(e as Error).message}`
        );
      } finally {
        drawing = false;
      }
    });
  }

  // Creator-fee auto-claim. Registered whenever config is ready + network is
  // mainnet (pump.fun fees are mainnet-only); whether a given tick actually
  // claims is decided at tick time from the persisted AdminSetting toggle, so
  // flipping "Auto-claim" in the admin card applies on the next tick without a
  // restart. Skipped ticks (below threshold, no fees) are silent by design.
  const claimCron = process.env.CLAIM_CRON || "*/10 * * * *";
  let claiming = false;
  if (cfg.network === "mainnet" && cron.validate(claimCron)) {
    cron.schedule(claimCron, async () => {
      if (claiming) {
        console.warn("[cron] claim still running — tick skipped");
        return;
      }
      claiming = true;
      try {
        const { claimCreatorFees, getAutoClaimConfig } = await import(
          "./pumpfun/creator-fees"
        );
        const auto = await getAutoClaimConfig();
        if (!auto.enabled) return;

        const res = await claimCreatorFees({
          source: "auto",
          minLamports: solToLamports(auto.minSol),
        });
        if (!res.ok) {
          if (!res.skipped) {
            logEvent("warn", "cron", `auto claim failed: ${res.error}`);
          }
          return;
        }
        console.log(`[cron] auto-claimed (tx ${res.signature})`);
      } catch (e) {
        console.error("[cron] auto claim failed:", (e as Error).message);
        logEvent("error", "cron", `auto claim failed: ${(e as Error).message}`);
      } finally {
        claiming = false;
      }
    });
  }

  // Telegram group bot. Registered unconditionally (also when the draw cron is
  // off) because the tick is read-only: it decides from the persisted admin
  // config whether to post anything. One-minute resolution; the configured
  // "every N minutes" cadence is enforced against the stored last-send time,
  // so an interval change applies on the next tick without a restart.
  let broadcasting = false;
  cron.schedule("* * * * *", async () => {
    if (broadcasting) return;
    broadcasting = true;
    try {
      const { runBotTick } = await import("./telegram-bot");
      await runBotTick();
    } catch (e) {
      logEvent("warn", "telegram", `tick failed: ${(e as Error).message}`);
    } finally {
      broadcasting = false;
    }
  });

  const msg =
    `[cron] registered — holders="${cfg.holderSyncCron}",` +
    ` lottery="${cfg.lotteryCron}" (enabled=${lotteryEnabled}),` +
    ` claim="${cfg.network === "mainnet" ? claimCron : "n/a (devnet)"}",` +
    ` telegram="* * * * * (DB-configured)"`;

  console.log(msg);
  logEvent("info", "cron", msg);
}
