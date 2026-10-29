/**
 * Editable Telegram message templates.
 *
 * Shared by the bot (`lib/telegram-bot.ts`, server) and the admin panel
 * (`components/admin/TelegramBotPanel.tsx`, client) — so this module must stay
 * **pure**: no Prisma, no Solana, no `process.env`. Importing the bot module
 * from a client component would drag the whole server stack into the bundle.
 *
 * A template is Telegram-flavoured HTML with `{placeholder}` slots. The admin
 * writes the copy and the layout; the bot only fills in already-escaped values,
 * so a template can never inject an unescaped wallet address or URL.
 *
 * Rendering rules:
 *  - unknown placeholders are a **save-time error** (a typo would otherwise
 *    ship a literal `{pool}` to the group);
 *  - a placeholder whose value is empty leaves an empty line behind, and runs of
 *    blank lines collapse to one — so "optional" lines (1st prize, payout tx,
 *    link) can sit on their own line without leaving gaps;
 *  - CRLF is normalised to LF (the TextArea on Windows submits `\r\n`).
 */

/** Characters allowed per template. Telegram's hard limit is 4096/message. */
export const MAX_TEMPLATE_LENGTH = 2000;

/** Placeholders available in the "current round" template. */
export const ROUND_PLACEHOLDERS = [
  "token",
  "round",
  "pool",
  "eligible",
  "firstPrizeLine",
  "scheduleLine",
  "playableNote",
  "link",
] as const;

/** Placeholders available in the "after a draw" template. */
export const DRAW_PLACEHOLDERS = [
  "token",
  "round",
  "pool",
  "eligible",
  "winners",
  "beacon",
  "payoutTxLine",
  "link",
] as const;

export type RoundPlaceholder = (typeof ROUND_PLACEHOLDERS)[number];
export type DrawPlaceholder = (typeof DRAW_PLACEHOLDERS)[number];
export type TemplateKind = "round" | "draw";

export const DEFAULT_ROUND_TEMPLATE = `🎲 <b>{token} lottery · round #{round}</b>

💰 Prize pool: <b>{pool}</b>
👥 Eligible holders: <b>{eligible}</b>
{firstPrizeLine}
{scheduleLine}
{playableNote}
{link}`;

export const DEFAULT_DRAW_TEMPLATE = `🏆 <b>{token} lottery · round #{round} drawn</b>

💰 Pool: <b>{pool}</b> · 👥 {eligible} eligible

{winners}

🔐 drand beacon: <b>{beacon}</b>
{payoutTxLine}
{link}`;

export interface PlaceholderHelp {
  token: string;
  description: string;
}

/** Tooltip copy for the placeholder chips in the admin panel. */
export const ROUND_PLACEHOLDER_HELP: PlaceholderHelp[] = [
  { token: "token", description: "Token name (Admin → SEO & Analytics)" },
  { token: "round", description: "Round number" },
  { token: "pool", description: "Prize pool, e.g. 1.24 SOL" },
  { token: "eligible", description: "Eligible holder count" },
  {
    token: "firstPrizeLine",
    description: "Estimated 1st prize line — empty when the pool cannot pay yet",
  },
  {
    token: "scheduleLine",
    description: "Next draw line (or “paused” / “not scheduled”)",
  },
  {
    token: "playableNote",
    description: "“Waiting for the minimum prize” note — empty when playable",
  },
  { token: "link", description: "Site link — empty when no site URL is set" },
];

export const DRAW_PLACEHOLDER_HELP: PlaceholderHelp[] = [
  { token: "token", description: "Token name (Admin → SEO & Analytics)" },
  { token: "round", description: "Round number" },
  { token: "pool", description: "Prize pool, e.g. 1.24 SOL" },
  { token: "eligible", description: "Eligible holder count" },
  {
    token: "winners",
    description: "Ranked winner list (or “no winners this round”)",
  },
  { token: "beacon", description: "drand status, e.g. cross-relay verified" },
  {
    token: "payoutTxLine",
    description: "Payout transaction line — empty when there is no tx",
  },
  { token: "link", description: "/rounds/<n> link — empty when no site URL" },
];

const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;

function allowedFor(kind: TemplateKind): readonly string[] {
  return kind === "round" ? ROUND_PLACEHOLDERS : DRAW_PLACEHOLDERS;
}

/** Distinct placeholder names used by a template, in first-appearance order. */
export function placeholdersIn(template: string): string[] {
  const seen = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_RE)) seen.add(match[1]);
  return [...seen];
}

/**
 * Returns a human-readable error for the admin form, or null when the template
 * is usable. Mirrors the validation the API applies on PUT.
 */
export function validateTemplate(
  kind: TemplateKind,
  template: string
): string | null {
  const text = template.trim();
  const label = kind === "round" ? "round" : "draw";
  if (!text) return `The ${label} template cannot be empty.`;
  if (text.length > MAX_TEMPLATE_LENGTH) {
    return `Too long: ${text.length}/${MAX_TEMPLATE_LENGTH} characters.`;
  }
  const allowed = allowedFor(kind);
  const unknown = placeholdersIn(text).filter((t) => !allowed.includes(t));
  if (unknown.length > 0) {
    const list = unknown.map((t) => `{${t}}`).join(", ");
    return `Unknown placeholder${unknown.length > 1 ? "s" : ""} ${list}. Use: ${allowed
      .map((t) => `{${t}}`)
      .join(" ")}`;
  }
  return null;
}

/**
 * Substitutes `{name}` slots with values that the caller has already escaped
 * for Telegram HTML. Missing keys are left as-is (a stale stored template keeps
 * rendering something visible instead of silently dropping text).
 */
export function applyTemplate(
  template: string,
  values: Record<string, string>
): string {
  return template
    .replace(/\r\n?/g, "\n")
    .replace(PLACEHOLDER_RE, (whole, key: string) =>
      key in values ? values[key] : whole
    )
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
