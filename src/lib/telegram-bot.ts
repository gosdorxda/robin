/**
 * Telegram GROUP BOT — periodic "current round" posts + draw announcements.
 *
 * Two kinds of messages, both to the same chat:
 *   1. round  — every N minutes (Admin → Telegram Bot, default 2): pool, eligible
 *               holders, estimated 1st prize, countdown to the next draw.
 *   2. draw   — the moment a round is persisted as completed (fired from
 *               lib/lottery/engine.ts): winners, payouts, beacon + payout tx.
 *
 * Config lives in the existing key/value `AdminSetting` table (like the SEO and
 * creator-fee toggles), so this feature needs NO Prisma migration and a change
 * made in the admin panel applies on the next tick without a restart:
 *   TELEGRAM_BOT_CONFIG — editable settings (JSON)
 *   TELEGRAM_BOT_STATE  — runtime bookkeeping (last send, last announced round)
 *
 * The bot token is stored there too (write-only from the panel — API responses
 * only ever return a masked hint), with `TELEGRAM_BOT_TOKEN` in `.env` as a
 * fallback, so a deployment can keep the secret out of the database entirely.
 *
 * Everything here is best-effort: a Telegram/DB/RPC hiccup is logged and
 * swallowed, never allowed to break a draw or a request.
 */
import { prisma } from "./prisma";
import { CHAIN_KIND } from "./chain/network";
import { logEvent, getRecentLogs } from "./log-buffer";
import { getConfig } from "./config";
import { getConnection, getPlatformKeypair } from "./solana/connection";
import { getDrawExclusions } from "./exclusions";
import { nextCronOccurrence } from "./cron-next";
import { effectiveMinEligibleBigint } from "./settings";
import { fmtSolNum, lamportsToSol, shortAddress } from "./format";
import { SEO_KEYS } from "./seo";
import { getChain } from "./chain";
import {
  applyTemplate,
  DEFAULT_DRAW_TEMPLATE,
  DEFAULT_ROUND_TEMPLATE,
  validateTemplate,
} from "./telegram-templates";

export const BOT_CONFIG_KEY = "TELEGRAM_BOT_CONFIG";
export const BOT_STATE_KEY = "TELEGRAM_BOT_STATE";

/** Interval bounds — 1 minute is the scheduler's resolution. */
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 1440;
export const DEFAULT_INTERVAL_MINUTES = 2;

/** How long after a draw the tick may still recover an unannounced result. */
const DRAW_CATCHUP_MS = 30 * 60_000;
/** Minimum spacing between catch-up retries (a bad chat id must not spam). */
const DRAW_RETRY_MS = 5 * 60_000;
/** Winners listed in a draw message; the rest are summarised as "+N more". */
const MAX_LISTED_WINNERS = 10;
/** Telegram rejects any single message above this many characters. */
const TELEGRAM_MAX_CHARS = 4096;

export interface BotSettings {
  enabled: boolean;
  /** Group id (e.g. -1001234567890) or @channelusername. */
  chatId: string;
  /** Optional forum-topic id (supergroups with Topics enabled). */
  threadId: string;
  /** Minutes between "current round" posts. */
  intervalMinutes: number;
  /** Post the current round on the interval. */
  notifyRound: boolean;
  /** Announce every completed draw. */
  notifyDraw: boolean;
  /** Editable Telegram-HTML body for the current-round post (`{placeholder}` slots). */
  roundTemplate: string;
  /** Editable Telegram-HTML body for the draw announcement. */
  drawTemplate: string;
}

/** Settings + the token exactly as persisted (token may be empty = use env). */
export interface BotStoredConfig extends BotSettings {
  token: string;
}

export interface BotState {
  lastRoundSentAt: string | null;
  /** Round number of the last draw announcement that actually went out. */
  lastDrawRound: number | null;
  /** Last draw attempt (success or failure) — throttles catch-up retries. */
  lastDrawAttemptAt: string | null;
  lastError: string | null;
}

export type BotTokenSource = "db" | "env" | "none";

export interface BotConfigView extends BotSettings {
  tokenSource: BotTokenSource;
  /** Masked tail of the token, e.g. "••••A1b2". Never the full secret. */
  tokenHint: string | null;
}

export interface BotOverview {
  config: BotConfigView;
  state: BotState;
  /** Whether the automatic draw cron is active (dev needs LOTTERY_CRON_ENABLED). */
  lotteryEnabled: boolean;
  lotteryCron: string;
  nextDrawAt: string | null;
  /** Canonical public base URL used for links; empty = no links in messages. */
  siteUrl: string;
  /** Plain-text previews (HTML stripped) exactly as the group will read them. */
  preview: { round: string | null; draw: string | null; roundError: string | null };
  history: { ts: string; level: string; message: string }[];
}

export interface DrawNotifyInput {
  roundNumber: number;
  prizePoolLamports: bigint | string;
  eligibleCount: number;
  winners: { rank: number; address: string; amountLamports: bigint | string }[];
  payoutTx: string | null;
  randomnessVerified: boolean;
}

interface RoundSnapshot {
  roundNumber: number;
  poolLamports: bigint;
  eligibleCount: number;
  firstPrizeLamports: bigint;
  nextDrawAt: Date | null;
  lotteryEnabled: boolean;
  playable: boolean;
  siteUrl: string;
  tokenName: string;
}

interface DrawSnapshot {
  roundNumber: number;
  prizePoolLamports: bigint;
  eligibleCount: number;
  winners: { rank: number; address: string; amountLamports: bigint }[];
  payoutTx: string | null;
  randomnessVerified: boolean;
  siteUrl: string;
  tokenName: string;
}

const EMPTY_STATE: BotState = {
  lastRoundSentAt: null,
  lastDrawRound: null,
  lastDrawAttemptAt: null,
  lastError: null,
};

/* ------------------------------------------------------------------------- *
 * Small JSON helpers over AdminSetting
 * ------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

async function readJson(key: string): Promise<Record<string, unknown>> {
  try {
    const row = await prisma.adminSetting.findUnique({ where: { key } });
    if (!row?.value) return {};
    return asRecord(JSON.parse(row.value));
  } catch {
    // Missing row / unreachable DB / hand-edited junk — fall back to defaults.
    return {};
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  await prisma.adminSetting.upsert({
    where: { key },
    update: { value: json },
    create: { key, value: json },
  });
}

/* ------------------------------------------------------------------------- *
 * Config
 * ------------------------------------------------------------------------- */

function parseStoredConfig(raw: Record<string, unknown>): BotStoredConfig {
  return {
    enabled: asBool(raw.enabled, false),
    chatId: asString(raw.chatId, process.env.TELEGRAM_CHAT_ID?.trim() || ""),
    threadId: asString(raw.threadId, ""),
    intervalMinutes: asInt(
      raw.intervalMinutes,
      DEFAULT_INTERVAL_MINUTES,
      MIN_INTERVAL_MINUTES,
      MAX_INTERVAL_MINUTES
    ),
    notifyRound: asBool(raw.notifyRound, true),
    notifyDraw: asBool(raw.notifyDraw, true),
    roundTemplate:
      asString(raw.roundTemplate, DEFAULT_ROUND_TEMPLATE) ||
      DEFAULT_ROUND_TEMPLATE,
    drawTemplate:
      asString(raw.drawTemplate, DEFAULT_DRAW_TEMPLATE) || DEFAULT_DRAW_TEMPLATE,
    token: asString(raw.token, ""),
  };
}

/** Persisted config verbatim (token included) — server-side only. */
export async function getBotStoredConfig(): Promise<BotStoredConfig> {
  return parseStoredConfig(await readJson(BOT_CONFIG_KEY));
}

/**
 * Effective config: the persisted token wins, `TELEGRAM_BOT_TOKEN` is the
 * fallback. `tokenSource` tells the admin panel where the secret comes from.
 */
export async function getBotConfig(): Promise<{
  settings: BotStoredConfig;
  token: string;
  tokenSource: BotTokenSource;
}> {
  const settings = await getBotStoredConfig();
  const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
  const stored = settings.token.trim();
  return {
    settings,
    token: stored || envToken,
    tokenSource: stored ? "db" : envToken ? "env" : "none",
  };
}

export async function saveBotConfig(config: BotStoredConfig): Promise<void> {
  await writeJson(BOT_CONFIG_KEY, config);
}

export async function getBotState(): Promise<BotState> {
  const raw = await readJson(BOT_STATE_KEY);
  const lastDrawRoundRaw = raw.lastDrawRound;
  return {
    ...EMPTY_STATE,
    lastRoundSentAt: asString(raw.lastRoundSentAt, "") || null,
    lastDrawRound:
      typeof lastDrawRoundRaw === "number" && Number.isFinite(lastDrawRoundRaw)
        ? Math.trunc(lastDrawRoundRaw)
        : null,
    lastDrawAttemptAt: asString(raw.lastDrawAttemptAt, "") || null,
    lastError: asString(raw.lastError, "") || null,
  };
}

async function patchBotState(patch: Partial<BotState>): Promise<void> {
  try {
    const current = await getBotState();
    await writeJson(BOT_STATE_KEY, { ...current, ...patch });
  } catch (e) {
    logEvent(
      "warn",
      "telegram",
      `could not save bot state: ${(e as Error).message}`
    );
  }
}

const CHAT_ID_RE = /^(@[A-Za-z0-9_]{4,}|-?\d{5,})$/;
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

export interface BotInput {
  enabled?: unknown;
  chatId?: unknown;
  threadId?: unknown;
  intervalMinutes?: unknown;
  notifyRound?: unknown;
  notifyDraw?: unknown;
  /** Editable message bodies (Telegram HTML + `{placeholder}` slots). */
  roundTemplate?: unknown;
  drawTemplate?: unknown;
  /** New token. Empty/absent = keep the saved one. */
  token?: unknown;
  /** Explicitly forget a token saved in the DB (env fallback still applies). */
  clearToken?: unknown;
}

/**
 * Validates a panel save against the persisted config. Only the fields present
 * in `input` change; validation errors are keyed by field for the form to plant
 * under the matching input (same contract as /api/buyback).
 */
export function normalizeBotInput(
  input: unknown,
  current: BotStoredConfig
): { config: BotStoredConfig; errors: Record<string, string> } {
  const raw = asRecord(input);
  const errors: Record<string, string> = {};

  const enabled =
    typeof raw.enabled === "boolean" ? raw.enabled : current.enabled;

  const chatId =
    typeof raw.chatId === "string" ? raw.chatId.trim() : current.chatId;
  if (chatId && !CHAT_ID_RE.test(chatId)) {
    errors.chatId =
      "Use a numeric group id (e.g. -1001234567890) or an @channelusername.";
  }

  const threadId =
    typeof raw.threadId === "string" ? raw.threadId.trim() : current.threadId;
  if (threadId && !/^\d+$/.test(threadId)) {
    errors.threadId =
      "Topic id must be numeric (leave blank if the group has no topics).";
  }

  const intervalMinutes = asInt(
    raw.intervalMinutes ?? current.intervalMinutes,
    current.intervalMinutes,
    MIN_INTERVAL_MINUTES,
    MAX_INTERVAL_MINUTES
  );
  if (
    raw.intervalMinutes !== undefined &&
    Number(raw.intervalMinutes) !== intervalMinutes
  ) {
    errors.intervalMinutes = `Must be a whole number between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES} minutes.`;
  }

  const notifyRound =
    typeof raw.notifyRound === "boolean" ? raw.notifyRound : current.notifyRound;
  const notifyDraw =
    typeof raw.notifyDraw === "boolean" ? raw.notifyDraw : current.notifyDraw;

  // Templates are admin-authored HTML, so the only real risks are a typo in a
  // placeholder name (a literal "{pool}" in the group) and an over-long body.
  const roundTemplate =
    typeof raw.roundTemplate === "string"
      ? raw.roundTemplate.trim()
      : current.roundTemplate;
  const roundTemplateError = validateTemplate("round", roundTemplate);
  if (raw.roundTemplate !== undefined && roundTemplateError) {
    errors.roundTemplate = roundTemplateError;
  }

  const drawTemplate =
    typeof raw.drawTemplate === "string"
      ? raw.drawTemplate.trim()
      : current.drawTemplate;
  const drawTemplateError = validateTemplate("draw", drawTemplate);
  if (raw.drawTemplate !== undefined && drawTemplateError) {
    errors.drawTemplate = drawTemplateError;
  }

  let token = current.token;
  if (raw.clearToken === true) {
    token = "";
  } else if (typeof raw.token === "string" && raw.token.trim().length > 0) {
    const candidate = raw.token.trim();
    if (!TOKEN_RE.test(candidate)) {
      errors.token =
        "That does not look like a BotFather token (expected 123456:ABC…).";
    } else {
      token = candidate;
    }
  }

  if (enabled && !chatId) {
    errors.chatId = "Add the group chat id before enabling the bot.";
  }

  return {
    config: {
      enabled,
      chatId,
      threadId,
      intervalMinutes,
      notifyRound,
      notifyDraw,
      roundTemplate,
      drawTemplate,
      token,
    },
    errors,
  };
}

/* ------------------------------------------------------------------------- *
 * Brand / site helpers (DB overrides over env, same order as lib/seo.ts).
 * Deliberately NOT reusing getSiteSeo() here: that helper is wrapped in React
 * `cache()`, which is meant for the request/render scope — the bot also runs
 * from the scheduler tick, outside any request.
 * ------------------------------------------------------------------------- */

async function getTokenName(): Promise<string> {
  try {
    const row = await prisma.adminSetting.findUnique({
      where: { key: SEO_KEYS.tokenName },
    });
    const stored = (row?.value ?? "").trim().replace(/^\$+/, "");
    if (stored) return stored;
  } catch {
    /* fall through to env */
  }
  return process.env.TOKEN_NAME?.trim().replace(/^\$+/, "") || "DrawFi";
}

async function getSiteUrl(): Promise<string> {
  let url = "";
  try {
    const row = await prisma.adminSetting.findUnique({
      where: { key: SEO_KEYS.siteUrl },
    });
    url = (row?.value ?? "").trim();
  } catch {
    /* fall through to env */
  }
  if (!url) {
    url =
      process.env.APP_BASE_URL?.trim() ||
      process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
      "";
  }
  return url.replace(/\/+$/, "");
}

/* ------------------------------------------------------------------------- *
 * Message formatting
 * ------------------------------------------------------------------------- */

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Strip the small HTML subset we emit so the admin can preview plain text. */
function toPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

function sol(lamports: bigint): string {
  return `${fmtSolNum(lamportsToSol(lamports))} SOL`;
}

function toBigInt(value: bigint | string | number | { toString(): string }): bigint {
  try {
    // `.toString()` first: Prisma's `Decimal` (numeric columns) is not accepted
    // by `BigInt()` directly, and a string keeps full precision.
    return typeof value === "bigint" ? value : BigInt(value.toString());
  } catch {
    return 0n;
  }
}

function fmtCountdown(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes <= 0) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function utcClock(date: Date): string {
  return `${date.toISOString().slice(11, 16)} UTC`;
}

function rankBadge(rank: number): string {
  if (rank === 1) return "🥇";
  if (rank === 2) return "🥈";
  if (rank === 3) return "🥉";
  return `#${rank}`;
}

/**
 * Values for the round template. Every interpolated value is escaped here, so
 * the admin-written template can never smuggle an unescaped address or URL in.
 * Optional lines resolve to "" — `applyTemplate` collapses the blank line.
 */
function roundValues(s: RoundSnapshot): Record<string, string> {
  const firstPrizeLine = s.playable
    ? `🥇 1st place ≈ <b>${sol(s.firstPrizeLamports)}</b>`
    : "";
  const scheduleLine = !s.lotteryEnabled
    ? "⏸ Automatic draws are paused — the admin triggers each draw."
    : s.nextDrawAt
    ? `⏳ Next draw: <b>in ${fmtCountdown(
        s.nextDrawAt.getTime() - Date.now()
      )}</b> · ${utcClock(s.nextDrawAt)}`
    : "⏳ Next draw: <b>not scheduled</b>";
  const playableNote = s.playable
    ? ""
    : s.poolLamports > 0n
    ? "<i>Waiting for the pool to reach the minimum prize.</i>"
    : "<i>No prize pool yet — waiting for the first deposit.</i>";
  const link = s.siteUrl
    ? `🔗 <a href="${esc(s.siteUrl)}">${esc(s.siteUrl)}</a>`
    : "";

  return {
    token: esc(s.tokenName),
    round: String(s.roundNumber),
    pool: sol(s.poolLamports),
    eligible: s.eligibleCount.toLocaleString("en-US"),
    firstPrizeLine,
    scheduleLine,
    playableNote,
    link,
  };
}

/** Refuse to call the API with a body Telegram will reject anyway. */
function assertMessageLength(html: string): string {
  if (html.length > TELEGRAM_MAX_CHARS) {
    throw new Error(
      `The message is ${html.length} characters — Telegram allows ${TELEGRAM_MAX_CHARS}. Shorten the template in Admin → Telegram Bot.`
    );
  }
  return html;
}

function renderRoundHtml(
  s: RoundSnapshot,
  template: string = DEFAULT_ROUND_TEMPLATE
): string {
  return assertMessageLength(applyTemplate(template, roundValues(s)));
}

/** Ranked winner block (multi-line) used by the `{winners}` slot. */
function winnerLines(d: DrawSnapshot): string {
  if (d.winners.length === 0) return "<i>No winners this round.</i>";
  const lines = d.winners
    .slice(0, MAX_LISTED_WINNERS)
    .map(
      (w) =>
        `${rankBadge(w.rank)} <code>${esc(
          shortAddress(w.address, 6, 6)
        )}</code> — <b>${sol(w.amountLamports)}</b>`
    );
  if (d.winners.length > MAX_LISTED_WINNERS) {
    lines.push(`…and ${d.winners.length - MAX_LISTED_WINNERS} more winners`);
  }
  return lines.join("\n");
}

function drawValues(d: DrawSnapshot): Record<string, string> {
  const roundUrl = d.siteUrl ? `${d.siteUrl}/rounds/${d.roundNumber}` : "";
  return {
    token: esc(d.tokenName),
    round: String(d.roundNumber),
    pool: sol(d.prizePoolLamports),
    eligible: d.eligibleCount.toLocaleString("en-US"),
    winners: winnerLines(d),
    beacon: d.randomnessVerified ? "cross-relay verified" : "single relay",
    payoutTxLine: d.payoutTx
      ? `📤 Payout tx: <code>${esc(shortAddress(d.payoutTx, 8, 8))}</code>`
      : "",
    link: roundUrl
      ? `🔗 <a href="${esc(roundUrl)}">${esc(roundUrl)}</a>`
      : "",
  };
}

function renderDrawHtml(
  d: DrawSnapshot,
  template: string = DEFAULT_DRAW_TEMPLATE
): string {
  return assertMessageLength(applyTemplate(template, drawValues(d)));
}

/* ------------------------------------------------------------------------- *
 * Telegram Bot API
 * ------------------------------------------------------------------------- */

/** Never let a token leak through an error message or a log line. */
function redact(message: string, token: string): string {
  if (!token) return message;
  return message.split(token).join("***");
}

async function callTelegram<T = unknown>(
  token: string,
  method: string,
  payload: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
    // Bounded: this also runs inside the draw path, so a black-holed connection
    // must fail fast instead of stalling the round for the default timeout.
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; result?: T; description?: string }
    | null;
  if (!res.ok || !body?.ok) {
    throw new Error(
      body?.description
        ? `Telegram: ${body.description}`
        : `Telegram HTTP ${res.status}`
    );
  }
  return body.result as T;
}

async function sendMessage(
  token: string,
  settings: BotSettings,
  html: string
): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: settings.chatId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (settings.threadId) {
    payload.message_thread_id = Number(settings.threadId);
  }
  await callTelegram(token, "sendMessage", payload);
}

/* ------------------------------------------------------------------------- *
 * Live data
 * ------------------------------------------------------------------------- */

/** Latest snapshot batch → eligible count, mirroring /api/status + the engine. */
async function eligibleHolderCount(
  platform: string | null
): Promise<number> {
  const latest = await prisma.holderSnapshot.findFirst({
    where: { chain: CHAIN_KIND },
    orderBy: { capturedAt: "desc" },
    select: { capturedAt: true },
  });
  if (!latest) return 0;

  const [snaps, minTokenEligible, excluded] = await Promise.all([
    prisma.holderSnapshot.findMany({
      where: { capturedAt: latest.capturedAt, chain: CHAIN_KIND },
      select: { holderAddress: true, amount: true },
    }),
    effectiveMinEligibleBigint(),
    getDrawExclusions(platform),
  ]);

  const excludedSet = new Set(excluded);
  const balances = new Map<string, bigint>();
  for (const s of snaps) {
    balances.set(
      s.holderAddress,
      (balances.get(s.holderAddress) ?? 0n) + toBigInt(s.amount)
    );
  }
  let count = 0;
  for (const [address, amount] of balances) {
    if (address === platform) continue;
    if (excludedSet.has(address)) continue;
    if (amount >= minTokenEligible) count++;
  }
  return count;
}

function platformAddress(): string | null {
  try {
    return getChain().platformAddress();
  } catch {
    return null;
  }
}

function lotteryEnabled(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.LOTTERY_CRON_ENABLED === "true"
  );
}

function nextDrawAt(): Date | null {
  const cron = process.env.LOTTERY_CRON?.trim() || "0 * * * *";
  return nextCronOccurrence(cron);
}

async function roundSnapshot(
  tokenName: string,
  siteUrl: string
): Promise<RoundSnapshot> {
  const cfg = getConfig();
  const connection = getConnection();
  const platform = platformAddress();
  if (!platform) throw new Error("Platform wallet is not configured.");

  const [balance, active, last, eligibleCount] = await Promise.all([
    connection.getBalance(getPlatformKeypair().publicKey, "confirmed"),
    prisma.lotteryRound.findFirst({
      where: { status: "drawing" },
      orderBy: { roundNumber: "desc" },
      select: { roundNumber: true },
    }),
    prisma.lotteryRound.findFirst({
      orderBy: { roundNumber: "desc" },
      select: { roundNumber: true },
    }),
    eligibleHolderCount(platform),
  ]);

  const rawPool = BigInt(balance) - cfg.prizeReserveLamports;
  const poolLamports = rawPool > 0n ? rawPool : 0n;
  const effectivePool =
    cfg.maxPrizeLamports > 0n && poolLamports > cfg.maxPrizeLamports
      ? cfg.maxPrizeLamports
      : poolLamports;
  const feeLamports = (effectivePool * BigInt(cfg.platformFeeBps)) / 10000n;
  const distributable = effectivePool - feeLamports;
  const firstShare = BigInt(
    Math.round((cfg.payoutDistribution[0] ?? 0) * 10_000)
  );
  const firstPrizeLamports = (distributable * firstShare) / 10_000n;

  return {
    roundNumber: active?.roundNumber ?? (last?.roundNumber ?? 0) + 1,
    poolLamports,
    eligibleCount,
    firstPrizeLamports,
    nextDrawAt: nextDrawAt(),
    lotteryEnabled: lotteryEnabled(),
    playable:
      effectivePool > 0n &&
      !(cfg.minPrizeLamports > 0n && effectivePool < cfg.minPrizeLamports),
    siteUrl,
    tokenName,
  };
}

function toDrawSnapshot(
  round: {
    roundNumber: number;
    /** `bigint`, a string, or Prisma's `Decimal` (numeric columns) — normalised below. */
    prizePoolLamports: bigint | string | { toString(): string };
    eligibleCount: number;
    payoutTx: string | null;
    randomnessVerified: boolean;
    winners: {
      rank: number;
      address: string;
      amountLamports: bigint | string | { toString(): string };
    }[];
  },
  tokenName: string,
  siteUrl: string
): DrawSnapshot {
  return {
    roundNumber: round.roundNumber,
    prizePoolLamports: toBigInt(round.prizePoolLamports),
    eligibleCount: round.eligibleCount,
    winners: round.winners
      .slice()
      .sort((a, b) => a.rank - b.rank)
      .map((w) => ({
        rank: w.rank,
        address: w.address,
        amountLamports: toBigInt(w.amountLamports),
      })),
    payoutTx: round.payoutTx,
    randomnessVerified: round.randomnessVerified,
    siteUrl,
    tokenName,
  };
}

/* ------------------------------------------------------------------------- *
 * Sending
 * ------------------------------------------------------------------------- */

export interface SendResult {
  ok: boolean;
  error?: string;
}

/** Checks that make every manual action report the same helpful message. */
async function requireConnection(): Promise<
  | { ok: true; settings: BotStoredConfig; token: string }
  | { ok: false; error: string }
> {
  const { settings, token } = await getBotConfig();
  if (!token) {
    return {
      ok: false,
      error:
        "Bot token is not configured. Paste a @BotFather token below (or set TELEGRAM_BOT_TOKEN).",
    };
  }
  if (!settings.chatId) {
    return { ok: false, error: "Group chat id is not configured." };
  }
  return { ok: true, settings, token };
}

/** Post the CURRENT round immediately (also resets the interval clock). */
export async function sendRoundUpdate(): Promise<SendResult> {
  const ready = await requireConnection();
  if (!ready.ok) return { ok: false, error: ready.error };

  try {
    const html = renderRoundHtml(
      await roundSnapshot(await getTokenName(), await getSiteUrl()),
      ready.settings.roundTemplate
    );
    await sendMessage(ready.token, ready.settings, html);
    await patchBotState({
      lastRoundSentAt: new Date().toISOString(),
      lastError: null,
    });
    logEvent(
      "success",
      "telegram",
      `round update sent to ${ready.settings.chatId}`
    );
    return { ok: true };
  } catch (e) {
    const msg = redact((e as Error).message, ready.token);
    // Timestamp even on failure: the cadence stays predictable instead of
    // retrying every single minute against a broken chat id.
    await patchBotState({
      lastRoundSentAt: new Date().toISOString(),
      lastError: msg,
    });
    logEvent("error", "telegram", `round update failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

/** Post a completed round. `force` bypasses the "already announced" guard. */
async function sendDraw(
  round: DrawSnapshot,
  opts: { force?: boolean } = {}
): Promise<SendResult> {
  const ready = await requireConnection();
  if (!ready.ok) return { ok: false, error: ready.error };

  const state = await getBotState();
  if (!opts.force && state.lastDrawRound === round.roundNumber) {
    return { ok: true };
  }

  try {
    await sendMessage(
      ready.token,
      ready.settings,
      renderDrawHtml(round, ready.settings.drawTemplate)
    );
    await patchBotState({
      lastDrawRound: round.roundNumber,
      lastDrawAttemptAt: new Date().toISOString(),
      lastError: null,
    });
    logEvent(
      "success",
      "telegram",
      `draw announcement sent for round #${round.roundNumber}`
    );
    return { ok: true };
  } catch (e) {
    const msg = redact((e as Error).message, ready.token);
    await patchBotState({
      lastDrawAttemptAt: new Date().toISOString(),
      lastError: msg,
    });
    logEvent(
      "error",
      "telegram",
      `draw announcement failed for round #${round.roundNumber}: ${msg}`
    );
    return { ok: false, error: msg };
  }
}

/**
 * Called from lib/lottery/engine.ts right after a round is persisted as
 * completed. Silent no-op unless the bot is enabled with draw announcements on;
 * never throws.
 */
export async function notifyDrawResult(input: DrawNotifyInput): Promise<void> {
  try {
    const { settings, token } = await getBotConfig();
    if (!settings.enabled || !settings.notifyDraw) return;
    if (!token || !settings.chatId) return;

    const state = await getBotState();
    if (state.lastDrawRound === input.roundNumber) return;

    const [siteUrl, tokenName] = await Promise.all([
      getSiteUrl(),
      getTokenName(),
    ]);
    await sendDraw({
      roundNumber: input.roundNumber,
      prizePoolLamports: toBigInt(input.prizePoolLamports),
      eligibleCount: input.eligibleCount,
      winners: input.winners.map((w) => ({
        rank: w.rank,
        address: w.address,
        amountLamports: toBigInt(w.amountLamports),
      })),
      payoutTx: input.payoutTx,
      randomnessVerified: input.randomnessVerified,
      siteUrl,
      tokenName,
    });
  } catch (e) {
    logEvent(
      "warn",
      "telegram",
      `draw announcement skipped: ${(e as Error).message}`
    );
  }
}

/** Admin "Send test" — proves token + chat id without touching the schedule. */
export async function sendTestMessage(): Promise<SendResult> {
  const ready = await requireConnection();
  if (!ready.ok) return { ok: false, error: ready.error };

  try {
    const name = await getTokenName();
    const text =
      `✅ <b>${esc(name)} lottery bot connected</b>\n\n` +
      `This group will receive:\n` +
      `• round updates every <b>${ready.settings.intervalMinutes} min</b>${
        ready.settings.notifyRound ? "" : " (currently off)"
      }\n` +
      `• every completed draw${
        ready.settings.notifyDraw ? "" : " (currently off)"
      }\n\n` +
      `<i>Sent from Admin → Telegram Bot.</i>`;
    await sendMessage(ready.token, ready.settings, text);
    logEvent(
      "success",
      "telegram",
      `test message sent to ${ready.settings.chatId}`
    );
    return { ok: true };
  } catch (e) {
    const msg = redact((e as Error).message, ready.token);
    logEvent("error", "telegram", `test message failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

/** Admin "Resend last draw" — ignores the dedupe guard for this call. */
export async function sendLastDrawNow(): Promise<SendResult> {
  try {
    const round = await prisma.lotteryRound.findFirst({
      where: { status: "completed" },
      orderBy: { roundNumber: "desc" },
      include: { winners: { orderBy: { rank: "asc" } } },
    });
    if (!round) return { ok: false, error: "No completed round to announce yet." };
    const [siteUrl, tokenName] = await Promise.all([
      getSiteUrl(),
      getTokenName(),
    ]);
    return await sendDraw(toDrawSnapshot(round, tokenName, siteUrl), {
      force: true,
    });
  } catch (e) {
    const msg = (e as Error).message;
    logEvent("error", "telegram", `resend last draw failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

/* ------------------------------------------------------------------------- *
 * Scheduler tick
 * ------------------------------------------------------------------------- */

let ticking = false;

/**
 * One tick per minute (registered in lib/scheduler.ts). The configured cadence
 * ("every N minutes") is enforced against the persisted `lastRoundSentAt`, so
 * changing the interval in the panel applies immediately and a restart does not
 * lose the clock.
 *
 * Draw announcements are normally fired by the engine; this tick additionally
 * recovers one that never went out (process killed mid-announcement, transient
 * Telegram outage) for up to 30 minutes after the round completed, retrying at
 * most every 5 minutes.
 */
export async function runBotTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const { settings, tokenSource } = await getBotConfig();
    if (!settings.enabled || tokenSource === "none" || !settings.chatId) return;

    const state = await getBotState();

    if (settings.notifyRound) {
      const intervalMs = settings.intervalMinutes * 60_000;
      const last = state.lastRoundSentAt ? Date.parse(state.lastRoundSentAt) : 0;
      if (
        !last ||
        Number.isNaN(last) ||
        Date.now() - last >= intervalMs - 5_000
      ) {
        await sendRoundUpdate();
      }
    }

    if (settings.notifyDraw) {
      const latest = await prisma.lotteryRound.findFirst({
        where: { status: "completed" },
        orderBy: { roundNumber: "desc" },
        include: { winners: { orderBy: { rank: "asc" } } },
      });
      if (
        latest &&
        latest.completedAt &&
        state.lastDrawRound !== latest.roundNumber &&
        Date.now() - latest.completedAt.getTime() <= DRAW_CATCHUP_MS
      ) {
        const attempted = state.lastDrawAttemptAt
          ? Date.parse(state.lastDrawAttemptAt)
          : 0;
        if (
          !attempted ||
          Number.isNaN(attempted) ||
          Date.now() - attempted >= DRAW_RETRY_MS
        ) {
          const [siteUrl, tokenName] = await Promise.all([
            getSiteUrl(),
            getTokenName(),
          ]);
          await sendDraw(toDrawSnapshot(latest, tokenName, siteUrl));
        }
      }
    }
  } catch (e) {
    logEvent("warn", "telegram", `tick failed: ${(e as Error).message}`);
  } finally {
    ticking = false;
  }
}

/* ------------------------------------------------------------------------- *
 * Chat discovery (getUpdates) — saves the admin from hunting for the id.
 * ------------------------------------------------------------------------- */

export interface DiscoveredChat {
  id: string;
  title: string;
  type: string;
}

/**
 * Reads recent updates and lists the chats that talked to the bot. Requires the
 * bot to be in the group and at least one message since it joined (Telegram
 * drops updates after 24h, and this is a no-op if a webhook is registered).
 */
export async function discoverChats(): Promise<{
  ok: boolean;
  chats: DiscoveredChat[];
  error?: string;
}> {
  const { token } = await getBotConfig();
  if (!token) {
    return { ok: false, chats: [], error: "Bot token is not configured." };
  }
  try {
    type Chat = {
      id?: number;
      title?: string;
      username?: string;
      first_name?: string;
      type?: string;
    };
    type Update = {
      message?: { chat?: Chat };
      my_chat_member?: { chat?: Chat };
      channel_post?: { chat?: Chat };
    };
    const updates = await callTelegram<Update[]>(token, "getUpdates", {
      limit: 100,
      allowed_updates: ["message", "my_chat_member", "channel_post"],
    });
    const seen = new Map<string, DiscoveredChat>();
    for (const u of updates ?? []) {
      const chat =
        u.message?.chat ?? u.my_chat_member?.chat ?? u.channel_post?.chat;
      if (!chat || typeof chat.id !== "number") continue;
      const id = String(chat.id);
      if (seen.has(id)) continue;
      seen.set(id, {
        id,
        title:
          chat.title ||
          (chat.username ? `@${chat.username}` : chat.first_name) ||
          id,
        type: chat.type || "unknown",
      });
    }
    if (seen.size === 0) {
      return {
        ok: false,
        chats: [],
        error:
          "No chats found. Add the bot to the group, send any message there, then try again (a webhook must not be set).",
      };
    }
    logEvent("info", "telegram", `discovered ${seen.size} chat(s) via getUpdates`);
    return { ok: true, chats: Array.from(seen.values()) };
  } catch (e) {
    const msg = redact((e as Error).message, token);
    logEvent("error", "telegram", `chat discovery failed: ${msg}`);
    return { ok: false, chats: [], error: msg };
  }
}

/* ------------------------------------------------------------------------- *
 * Admin overview
 * ------------------------------------------------------------------------- */

function maskToken(token: string): string {
  if (!token) return "—";
  return `••••${token.slice(-4)}`;
}

type BotPreview = BotOverview["preview"];

/**
 * Renders both messages against live data for the given templates. Used by the
 * panel GET (saved templates) and by the "preview edits" action, so an admin can
 * check an unsaved rewrite before committing it.
 */
async function buildPreviews(templates: {
  roundTemplate: string;
  drawTemplate: string;
}): Promise<BotPreview> {
  const [tokenName, siteUrl] = await Promise.all([getTokenName(), getSiteUrl()]);

  let round: string | null = null;
  let roundError: string | null = null;
  try {
    round = toPlain(
      renderRoundHtml(
        await roundSnapshot(tokenName, siteUrl),
        templates.roundTemplate
      )
    );
  } catch (e) {
    roundError = (e as Error).message;
  }

  let draw: string;
  try {
    const lastDraw = await prisma.lotteryRound.findFirst({
      where: { status: "completed" },
      orderBy: { roundNumber: "desc" },
      include: { winners: { orderBy: { rank: "asc" } } },
    });
    draw = lastDraw
      ? toPlain(
          renderDrawHtml(
            toDrawSnapshot(lastDraw, tokenName, siteUrl),
            templates.drawTemplate
          )
        )
      : "No completed round yet — the first draw announcement will appear here.";
  } catch (e) {
    draw = `Preview unavailable: ${(e as Error).message}`;
  }

  return { round, draw, roundError };
}

/**
 * Preview for templates that have not been saved yet. Validation runs first so
 * a typo comes back as a readable form error instead of a partial render.
 */
export async function previewBotTemplates(input: unknown): Promise<
  { ok: true; preview: BotPreview } | { ok: false; error: string }
> {
  const raw = asRecord(input);
  const { settings } = await getBotConfig();
  const roundTemplate =
    typeof raw.roundTemplate === "string"
      ? raw.roundTemplate.trim()
      : settings.roundTemplate;
  const drawTemplate =
    typeof raw.drawTemplate === "string"
      ? raw.drawTemplate.trim()
      : settings.drawTemplate;

  const error =
    validateTemplate("round", roundTemplate) ??
    validateTemplate("draw", drawTemplate);
  if (error) return { ok: false, error };

  try {
    return {
      ok: true,
      preview: await buildPreviews({ roundTemplate, drawTemplate }),
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Everything the admin panel renders in one round-trip. */
export async function getBotOverview(): Promise<BotOverview> {
  const [{ settings, token, tokenSource }, state, siteUrl] = await Promise.all([
    getBotConfig(),
    getBotState(),
    getSiteUrl(),
  ]);

  const preview = await buildPreviews({
    roundTemplate: settings.roundTemplate,
    drawTemplate: settings.drawTemplate,
  });

  return {
    config: {
      enabled: settings.enabled,
      chatId: settings.chatId,
      threadId: settings.threadId,
      intervalMinutes: settings.intervalMinutes,
      notifyRound: settings.notifyRound,
      notifyDraw: settings.notifyDraw,
      roundTemplate: settings.roundTemplate,
      drawTemplate: settings.drawTemplate,
      tokenSource,
      tokenHint: tokenSource === "none" ? null : maskToken(token),
    },
    state,
    lotteryEnabled: lotteryEnabled(),
    lotteryCron: process.env.LOTTERY_CRON?.trim() || "0 * * * *",
    nextDrawAt: nextDrawAt()?.toISOString() ?? null,
    siteUrl,
    preview,
    history: getTelegramHistory(),
  };
}

/** Recent bot activity for the panel (in-memory ring buffer, newest first). */
export function getTelegramHistory(): {
  ts: string;
  level: string;
  message: string;
}[] {
  try {
    return getRecentLogs(200)
      .filter((l) => l.source === "telegram")
      .slice(0, 12)
      .map((l) => ({ ts: l.ts, level: l.level, message: l.message }));
  } catch {
    return [];
  }
}








