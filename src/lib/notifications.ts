/**
 * #9 — Winner notifications. Channel-agnostic: each subscription picks a channel
 * ("email" or "telegram") at subscribe time. Sending is gated on env creds — if
 * RESEND_API_KEY / TELEGRAM_BOT_TOKEN is unset, that channel is skipped
 * gracefully (logged), so the feature is safe to deploy before creds exist.
 *
 * Env:
 *   RESEND_API_KEY      — Resend.com API key (enables the email channel)
 *   RESEND_FROM_EMAIL   — verified From address, e.g. "DrawFi <noreply@x.com>"
 *   TELEGRAM_BOT_TOKEN  — bot token from @BotFather (enables the telegram channel)
 *   APP_BASE_URL        — public site base for round links in messages (optional)
 *
 * Called from engine.executeRound right after a round is persisted as completed.
 */
import { prisma } from "./prisma";
import { lamportsToSol } from "./format";
import { logEvent } from "./log-buffer";
import { SEO_KEYS } from "./seo";

type Channel = "email" | "telegram";

/* ------------------------------------------------------------------------- *
 * Brand name for the message copy (DB `SEO_BRAND_NAME` → "DrawFi").
 * Deliberately NOT reusing `getSiteSeo()`: that helper is wrapped in React
 * `cache()`, which belongs to the request/render scope, while this module is
 * called from the draw engine and its scheduler tick (same reasoning as
 * `telegram-bot.ts`).
 * ------------------------------------------------------------------------- */
async function getBrandName(): Promise<string> {
  try {
    const row = await prisma.adminSetting.findUnique({
      where: { key: SEO_KEYS.brandName },
    });
    const stored = (row?.value ?? "").trim();
    if (stored) return stored;
  } catch {
    /* fall through to the default */
  }
  return "DrawFi";
}

interface NotifyWinner {
  rank: number;
  address: string;
  amountLamports: bigint | string;
}

export async function notifyWinners(
  roundNumber: number,
  winners: NotifyWinner[]
): Promise<void> {
  if (winners.length === 0) return;

  // One query for every winning address's subscriptions.
  const addresses = winners.map((w) => w.address);
  const subs = await prisma.notificationSubscription.findMany({
    where: { address: { in: addresses } },
  });
  if (subs.length === 0) return;

  const byAddr = new Map<string, NotifyWinner>();
  for (const w of winners) byAddr.set(w.address, w);

  const baseUrl = process.env.APP_BASE_URL || "";
  const brandName = await getBrandName();
  let sent = 0;
  let skipped = 0;
  for (const sub of subs) {
    const w = byAddr.get(sub.address);
    if (!w) continue;
    const lamports =
      typeof w.amountLamports === "bigint"
        ? w.amountLamports
        : BigInt(String(w.amountLamports));
    const sol = lamportsToSol(lamports);
    const ok = await sendOne(sub.channel as Channel, sub.endpoint, {
      roundNumber,
      address: w.address,
      rank: w.rank,
      sol,
      baseUrl,
      brandName,
    });
    if (ok) sent++;
    else skipped++;
  }
  logEvent(
    "info",
    "notify",
    `round #${roundNumber}: notified ${sent} subscription(s), ${skipped} skipped (no creds/failed)`
  );
}

async function sendOne(
  channel: Channel,
  endpoint: string,
  ctx: {
    roundNumber: number;
    address: string;
    rank: number;
    sol: number;
    baseUrl: string;
    brandName: string;
  }
): Promise<boolean> {
  try {
    if (channel === "email") return await sendEmail(endpoint, ctx);
    if (channel === "telegram") return await sendTelegram(endpoint, ctx);
    return false;
  } catch (e) {
    logEvent(
      "error",
      "notify",
      `${channel} send to ${endpoint} failed: ${(e as Error).message}`
    );
    return false;
  }
}

function roundLink(baseUrl: string, roundNumber: number): string {
  return baseUrl
    ? `${baseUrl.replace(/\/$/, "")}/rounds/${roundNumber}`
    : `/rounds/${roundNumber}`;
}

async function sendEmail(
  to: string,
  ctx: {
    roundNumber: number;
    address: string;
    rank: number;
    sol: number;
    baseUrl: string;
    brandName: string;
  }
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false; // email channel not configured
  const from =
    process.env.RESEND_FROM_EMAIL || `${ctx.brandName} <noreply@resend.dev>`;
  const subject = `🎉 You won round #${ctx.roundNumber} — ${ctx.sol.toFixed(4)} SOL`;
  const html =
    `<p>You won <strong>rank ${ctx.rank}</strong> in ${ctx.brandName} round #${ctx.roundNumber}!</p>` +
    `<p>Payout: <strong>${ctx.sol.toFixed(4)} SOL</strong> to <code>${ctx.address}</code></p>` +
    `<p><a href="${roundLink(ctx.baseUrl, ctx.roundNumber)}">View round proof &amp; winner derivation</a></p>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend ${res.status}: ${text.slice(0, 200)}`);
  }
  return true;
}

async function sendTelegram(
  chatId: string,
  ctx: {
    roundNumber: number;
    address: string;
    rank: number;
    sol: number;
    baseUrl: string;
    brandName: string;
  }
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false; // telegram channel not configured
  const text =
    `🎉 *You won ${ctx.brandName} round #${ctx.roundNumber}!*\n` +
    `Rank: *${ctx.rank}*  •  Payout: *${ctx.sol.toFixed(4)} SOL*\n` +
    `To: \`${ctx.address}\`\n` +
    `[View round proof](${roundLink(ctx.baseUrl, ctx.roundNumber)})`;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const text2 = await res.text();
    throw new Error(`Telegram ${res.status}: ${text2.slice(0, 200)}`);
  }
  return true;
}