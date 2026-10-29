import cron from "node-cron";
import { getConfig, type LotteryConfig } from "./config";

/**
 * Admin-tunable settings — ENV ONLY (server-only).
 *
 * `.env` is the single source of truth. The old DB override store
 * (`AdminSetting` rows for these keys) is gone: an admin save no longer exists,
 * and any leftover rows are ignored.
 *
 * `getConfig()` reads these keys straight from `process.env` and caches the
 * result for the process, so a `.env` edit applies after a server restart
 * (`next dev` reloads by itself when `.env` changes). The cron schedules are
 * registered once at boot (`lib/scheduler.ts`), which is covered by the same
 * restart.
 *
 * `/admin` → Settings renders a READ-ONLY summary via `getSettingsView()`; the
 * only write action left on that tab is the data reset (Danger zone).
 */

export const SETTING_KEYS = [
  "MIN_TOKEN_ELIGIBLE",
  "WINNER_COUNT",
  "PAYOUT_DISTRIBUTION",
  "PRIZE_RESERVE_LAMPORTS",
  "PLATFORM_FEE_BPS",
  "MAX_PRIZE_SOL",
  "MIN_PRIZE_SOL",
  "LOTTERY_CRON",
  "HOLDER_SYNC_CRON",
  "LOTTERY_CRON_ENABLED",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export interface SettingMeta {
  key: SettingKey;
  label: string;
  description: string;
  group: "eligibility" | "winners" | "payout" | "schedule";
}

export const SETTING_META: Record<SettingKey, SettingMeta> = {
  MIN_TOKEN_ELIGIBLE: {
    key: "MIN_TOKEN_ELIGIBLE",
    label: "Eligibility threshold",
    description:
      "Minimum token balance (raw units incl. decimals) a holder needs to be eligible.",
    group: "eligibility",
  },
  WINNER_COUNT: {
    key: "WINNER_COUNT",
    label: "Winner count",
    description: "Number of winners per round. Must equal the number of payout shares.",
    group: "winners",
  },
  PAYOUT_DISTRIBUTION: {
    key: "PAYOUT_DISTRIBUTION",
    label: "Payout distribution",
    description: "Comma-separated shares summing to 1.0 for rank 1, 2, 3 … e.g. 0.5,0.3,0.2.",
    group: "winners",
  },
  PRIZE_RESERVE_LAMPORTS: {
    key: "PRIZE_RESERVE_LAMPORTS",
    label: "Prize reserve",
    description: "SOL (in lamports) kept on the platform wallet for fees/rent — not distributed.",
    group: "payout",
  },
  PLATFORM_FEE_BPS: {
    key: "PLATFORM_FEE_BPS",
    label: "Platform fee",
    description:
      "Platform revenue cut in basis points (0–10000; 100 = 1%, 500 = 5%). Deducted from the prize pool before winners are paid; the cut stays on the platform wallet.",
    group: "payout",
  },
  MAX_PRIZE_SOL: {
    key: "MAX_PRIZE_SOL",
    label: "Max prize (SOL)",
    description:
      "Maximum SOL prize distributed per round (readable SOL, e.g. 1.0). 0 = no cap. When the available pool exceeds this, only the cap is paid out and the remainder stays on the platform wallet for future rounds.",
    group: "payout",
  },
  MIN_PRIZE_SOL: {
    key: "MIN_PRIZE_SOL",
    label: "Min prize (SOL)",
    description:
      "Minimum SOL prize required to run a round (readable SOL, e.g. 0.1). 0 = no minimum. When the effective prize (after the max cap) falls below this, the round is skipped instead of drawn — no randomness, no winners, no payout.",
    group: "payout",
  },
  LOTTERY_CRON: {
    key: "LOTTERY_CRON",
    label: "Lottery cron",
    description: "5-field cron schedule for draws, interpreted as UTC.",
    group: "schedule",
  },
  HOLDER_SYNC_CRON: {
    key: "HOLDER_SYNC_CRON",
    label: "Holder sync cron",
    description: "5-field cron schedule for holder snapshot sync, interpreted as UTC.",
    group: "schedule",
  },
  LOTTERY_CRON_ENABLED: {
    key: "LOTTERY_CRON_ENABLED",
    label: "Draw cron enabled",
    description:
      "Whether the SOL-spending lottery cron runs (dev only — in production draws are always on).",
    group: "schedule",
  },
};

/** Built-in defaults — mirrors the fallbacks used in lib/config.ts. */
export const SETTING_DEFAULTS: Record<SettingKey, string> = {
  MIN_TOKEN_ELIGIBLE: "100000",
  WINNER_COUNT: "3",
  PAYOUT_DISTRIBUTION: "0.5,0.3,0.2",
  PRIZE_RESERVE_LAMPORTS: "50000000",
  PLATFORM_FEE_BPS: "0",
  MAX_PRIZE_SOL: "0",
  MIN_PRIZE_SOL: "0",
  LOTTERY_CRON: "0 * * * *",
  HOLDER_SYNC_CRON: "*/5 * * * *",
  LOTTERY_CRON_ENABLED: "false",
};

/** True when the key is present and non-empty in `.env`. */
export function isEnvSet(key: SettingKey): boolean {
  const raw = process.env[key];
  return !!raw && raw.trim().length > 0;
}

/** Effective value for a key: env when set, otherwise the built-in default. */
export function envDefault(key: SettingKey): string {
  return isEnvSet(key)
    ? (process.env[key] as string).trim()
    : SETTING_DEFAULTS[key];
}

/** Alias kept for callers that read the effective (env) value. */
export function effectiveValue(key: SettingKey): string {
  return envDefault(key);
}

/** Effective MIN_TOKEN_ELIGIBLE as bigint, safe to call from any server route
 *  handler. Used by /api/status, /api/holders, /api/eligibility and
 *  /api/admin/holders so the displayed/checked threshold matches what the
 *  lottery engine uses for draws. */
export async function effectiveMinEligibleBigint(): Promise<bigint> {
  try {
    return BigInt(effectiveValue("MIN_TOKEN_ELIGIBLE"));
  } catch {
    return 100000n;
  }
}

/** Effective config (env + process cache). Kept async so existing call sites
 *  can keep awaiting it. */
export async function getEffectiveConfig(): Promise<LotteryConfig> {
  return getConfig();
}

/** Validates a single setting value. Returns an error message, or null when ok. */
export function validateSetting(key: SettingKey, value: string): string | null {
  const v = value.trim();
  if (v.length === 0) return "Required.";
  switch (key) {
    case "MIN_TOKEN_ELIGIBLE":
      if (!/^\d+$/.test(v)) return "Must be a non-negative integer (raw token units).";
      return null;
    case "WINNER_COUNT": {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) return "Must be an integer ≥ 1.";
      return null;
    }
    case "PAYOUT_DISTRIBUTION": {
      const parts = v.split(",").map((s) => Number(s.trim()));
      if (parts.some((n) => Number.isNaN(n))) return "Must be comma-separated numbers.";
      if (parts.length === 0) return "At least one share is required.";
      if (parts.some((p) => p < 0)) return "Shares must be ≥ 0.";
      const sum = parts.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1) > 0.0001) return `Shares must sum to 1.0 (currently ${sum}).`;
      return null;
    }
    case "PRIZE_RESERVE_LAMPORTS":
      if (!/^\d+$/.test(v)) return "Must be a non-negative integer (lamports).";
      return null;
    case "PLATFORM_FEE_BPS": {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 10000)
        return "Must be an integer 0–10000 (basis points).";
      return null;
    }
    case "MAX_PRIZE_SOL":
    case "MIN_PRIZE_SOL": {
      const n = Number(v);
      if (Number.isNaN(n) || n < 0) return "Must be a non-negative number (SOL).";
      return null;
    }
    case "LOTTERY_CRON":
    case "HOLDER_SYNC_CRON":
      if (!cron.validate(v)) return "Must be a valid 5-field cron expression.";
      return null;
    case "LOTTERY_CRON_ENABLED":
      if (v !== "true" && v !== "false") return "Must be 'true' or 'false'.";
      return null;
    default:
      return null;
  }
}

/** Cross-field validation (winnerCount must equal payoutDistribution length). */
export function validateSettingsTogether(
  map: Partial<Record<SettingKey, string>>
): Partial<Record<SettingKey, string>> {
  const errors: Partial<Record<SettingKey, string>> = {};
  const wc = Number(map.WINNER_COUNT ?? envDefault("WINNER_COUNT"));
  const distRaw = map.PAYOUT_DISTRIBUTION ?? envDefault("PAYOUT_DISTRIBUTION");
  const dist = distRaw.split(",").map((s) => Number(s.trim()));
  if (Number.isInteger(wc) && wc !== dist.length) {
    const msg = `Winner count (${wc}) must match payout shares (${dist.length}).`;
    errors.WINNER_COUNT = msg;
    errors.PAYOUT_DISTRIBUTION = msg;
  }
  return errors;
}

export interface SettingView {
  key: SettingKey;
  /** Env var to edit — same string as `key`. */
  envVar: SettingKey;
  label: string;
  description: string;
  group: SettingMeta["group"];
  value: string;
  /** "env" when `.env` supplies the value, "default" when the fallback applies. */
  source: "env" | "default";
  /** Validation message for a malformed value (cron, shares, …), else null. */
  problem: string | null;
}

export interface SettingsView {
  items: SettingView[];
  lotteryEnabled: boolean;
  inProduction: boolean;
  nextDrawAt: string | null; // ISO — null when draws are paused
  nextSyncAt: string | null;
}

/** Read-only snapshot for the admin settings GET route. */
export async function getSettingsView(): Promise<SettingsView> {
  // Cross-field problems (winner count vs. payout shares) apply to both rows.
  const together = validateSettingsTogether({});
  const items: SettingView[] = SETTING_KEYS.map((key) => {
    const meta = SETTING_META[key];
    const value = effectiveValue(key);
    return {
      key,
      envVar: key,
      label: meta.label,
      description: meta.description,
      group: meta.group,
      value,
      source: isEnvSet(key) ? "env" : "default",
      problem: validateSetting(key, value) ?? together[key] ?? null,
    };
  });
  const inProduction = process.env.NODE_ENV === "production";
  const lotteryEnabled =
    inProduction || effectiveValue("LOTTERY_CRON_ENABLED") === "true";
  const { nextCronOccurrence } = await import("./cron-next");
  const nextDrawAt = lotteryEnabled
    ? nextCronOccurrence(effectiveValue("LOTTERY_CRON"))?.toISOString() ?? null
    : null;
  const nextSyncAt =
    nextCronOccurrence(effectiveValue("HOLDER_SYNC_CRON"))?.toISOString() ?? null;
  return { items, lotteryEnabled, inProduction, nextDrawAt, nextSyncAt };
}



