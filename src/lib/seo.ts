import { cache } from "react";
import { createHash } from "node:crypto";
import { prisma } from "./prisma";
// Chain-aware default copy: the meta description and keywords have to name the
// chain the draw actually runs on. `chain/network.ts` is client-safe and reads
// only `NEXT_PUBLIC_*` values, so importing it here adds no dependency the rest
// of this server-only module does not already have.
import { CHAIN_NAME, NATIVE_SYMBOL } from "./chain/network";

/**
 * Admin-editable SEO + analytics settings (server-only).
 *
 * Stored in the existing key/value `AdminSetting` table under a `SEO_` prefix,
 * so adding this panel needs NO Prisma migration. Values are read through
 * `getSiteSeo()`, which is wrapped in React `cache` — one DB query per request
 * even though both the root layout and `generateMetadata()` consume it.
 *
 * The root layout exports `revalidate = 300`, so a saved change becomes visible
 * after the next ISR regeneration; the admin POST/DELETE route additionally
 * calls `revalidatePath("/", "layout")` for immediate effect.
 *
 * Public fallbacks: `NEXT_PUBLIC_SITE_URL` and `NEXT_PUBLIC_GA_ID` act as env
 * defaults when the matching DB value is empty.
 */

export const SEO_KEYS = {
  brandName: "SEO_BRAND_NAME",
  /**
   * Ticker of the token the lottery is built around. Deliberately NOT prefixed
   * `SEO_`: it is a product setting read by pages/APIs, not metadata — but it
   * lives in the same panel + key/value store so admins have ONE place to edit
   * the name (previously hardcoded as `"PAY"` in several files).
   */
  tokenName: "TOKEN_NAME",
  siteTitle: "SEO_SITE_TITLE",
  description: "SEO_DESCRIPTION",
  keywords: "SEO_KEYWORDS",
  siteUrl: "SEO_SITE_URL",
  ogImage: "SEO_OG_IMAGE",
  twitterHandle: "SEO_TWITTER_HANDLE",
  /** Full profile URL — the sidebar's X link reads this (Admin → SEO). */
  xUrl: "SEO_X_URL",
  /** Full t.me/… link — the sidebar's Telegram entry reads this. */
  telegramUrl: "SEO_TELEGRAM_URL",
  gaMeasurementId: "SEO_GA_MEASUREMENT_ID",
  allowIndexing: "SEO_ALLOW_INDEXING",
  googleSiteVerification: "SEO_GOOGLE_VERIFICATION",
  favicon: "SEO_FAVICON",
} as const satisfies Record<string, string>;

export type SeoField = keyof typeof SEO_KEYS;

export interface SiteSeo {
  /** Site wordmark + title suffix, e.g. "DrawFi". */
  brandName: string;
  /** Token ticker shown across the app, e.g. "DrawFi". Case is kept as typed. */
  tokenName: string;
  /** Default <title> for the homepage / browser tab. */
  siteTitle: string;
  /** Meta description used site-wide unless a page overrides it. */
  description: string;
  /** Comma-separated keyword list. */
  keywords: string;
  /** Canonical base URL, no trailing slash. Empty = no canonical/metadataBase. */
  siteUrl: string;
  /** Absolute URL of the 1200×630 social preview image. */
  ogImage: string;
  /** X / Twitter handle without the leading @. */
  twitterHandle: string;
  /** Full X profile URL (https://x.com/handle) used by the sidebar links. */
  xUrl: string;
  /** Full Telegram link (https://t.me/…). Empty = the entry is hidden. */
  telegramUrl: string;
  /** GA4 measurement ID (G-XXXXXXX). Empty = analytics disabled. */
  gaMeasurementId: string;
  /** false → robots noindex,nofollow site-wide. */
  allowIndexing: boolean;
  /** Google Search Console verification token (meta tag). */
  googleSiteVerification: string;
  /** Uploaded favicon as a `data:image/…;base64,…` URI. Empty = no icon. */
  favicon: string;
}

const envSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "";
const envGaId = process.env.NEXT_PUBLIC_GA_ID?.trim() || "";
/** Optional env default; the DB `TOKEN_NAME` row always wins. Case untouched. */
const envTokenName =
  process.env.TOKEN_NAME?.trim().replace(/^\$+/, "") || "";

export const SEO_DEFAULTS: SiteSeo = {
  brandName: "DrawFi",
  tokenName: envTokenName || "DrawFi",
  siteTitle: "DrawFi — verifiable holder draws",
  // The description and keywords name the chain and its coin, so they follow
  // CHAIN_KIND instead of the old Solana-only wording ("…on Solana", "SOL
  // payouts") that kept showing up in social share cards after the migration.
  description: `DrawFi runs verifiable holder draws on ${CHAIN_NAME}: creator fees fund the prize pool, drand picks the winners, and anyone can re-run the draw in a browser.`,
  keywords: `DrawFi, ${CHAIN_NAME} holder draws, creator fees, prize pool, drand randomness, provably fair, verifiable randomness, ${NATIVE_SYMBOL} payouts`,
  siteUrl: envSiteUrl.replace(/\/+$/, ""),
  ogImage: "",
  twitterHandle: "",
  xUrl: "",
  telegramUrl: "",
  gaMeasurementId: envGaId,
  allowIndexing: true,
  googleSiteVerification: "",
  favicon: "",
};

/** Serialise one field for the key/value store. */
function serialize(field: SeoField, seo: SiteSeo): string {
  return field === "allowIndexing" ? String(seo.allowIndexing) : String(seo[field]);
}

/**
 * Effective SEO settings: DB overrides on top of `SEO_DEFAULTS`. Never throws —
 * a missing/unreachable database (e.g. during a CI build) falls back to the
 * defaults so pages can still render.
 */
export const getSiteSeo = cache(async (): Promise<SiteSeo> => {
  const seo: SiteSeo = { ...SEO_DEFAULTS };
  try {
    const rows = await prisma.adminSetting.findMany({
      where: { key: { in: Object.values(SEO_KEYS) } },
    });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));

    const stringFields = (Object.keys(SEO_KEYS) as SeoField[]).filter(
      (f): f is Exclude<SeoField, "allowIndexing"> => f !== "allowIndexing"
    );
    for (const field of stringFields) {
      const raw = byKey.get(SEO_KEYS[field]);
      if (raw !== undefined) seo[field] = raw.trim();
    }
    const indexing = byKey.get(SEO_KEYS.allowIndexing);
    if (indexing !== undefined) seo.allowIndexing = indexing !== "false";
    // A hand-edited row must never leak whitespace / a `$` prefix into the UI;
    // the case it was saved with is kept.
    const stored = normalizeTokenName(seo.tokenName);
    seo.tokenName = TOKEN_NAME_RE.test(stored)
      ? stored
      : SEO_DEFAULTS.tokenName;
  } catch (e) {
    console.warn(
      "[seo] settings unavailable, using defaults:",
      (e as Error).message
    );
  }
  return seo;
});

/**
 * The ONE source of truth for the token ticker shown anywhere in the UI:
 * DB `TOKEN_NAME` → env `TOKEN_NAME` → `"DrawFi"`. Reuses `getSiteSeo()`'s cached
 * query, so this costs nothing extra inside the request that already read SEO.
 */
export const getTokenName = cache(async (): Promise<string> => {
  return (await getSiteSeo()).tokenName;
});

export type SeoErrors = Partial<Record<SeoField, string>>;

/** Ticker shape: 1–16 chars, starts with a letter/digit, then letters/digits/_.- */
const TOKEN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;

/**
 * `$pay` → `pay`, `  DrawFi ` → `DrawFi`. Only trims and drops a `$` prefix —
 * **case is preserved exactly as typed**, so `DrawFi`, `drawfi` and `DRAWFI`
 * are three different (all valid) tickers. Validation rejects anything else.
 */
export function normalizeTokenName(value: string): string {
  return value.trim().replace(/^\$+/, "");
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Favicon upload limits — kept in sync with the admin panel. */
export const FAVICON_MAX_BYTES = 128 * 1024;

/** Image types a browser accepts for <link rel="icon">. */
export const FAVICON_MIME_TYPES = [
  "image/png",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/svg+xml",
  "image/webp",
] as const;

export type FaviconMime = (typeof FAVICON_MIME_TYPES)[number];

export interface ParsedFavicon {
  mime: FaviconMime;
  base64: string;
  bytes: number;
}

const FAVICON_DATA_URI_RE =
  /^data:(image\/(?:png|x-icon|vnd\.microsoft\.icon|svg\+xml|webp))((?:;charset=[A-Za-z0-9._-]+)?);base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Cache-busted URL for the uploaded favicon (`/api/favicon?v=<hash>`), or ""
 * when the stored value is not a valid icon. Browsers keep favicons in a cache
 * that ignores HTTP caching, so the URL itself has to change per upload — one
 * helper so the metadata tags and the client provider can never disagree.
 */
export function faviconUrl(value: string): string {
  if (!parseFavicon(value)) return "";
  const hash = createHash("sha1").update(value).digest("hex").slice(0, 10);
  return `/api/favicon?v=${hash}`;
}

/**
 * Decode the stored favicon data URI. Returns `null` for an empty, malformed,
 * oversized or non-image value — callers treat that as "no custom icon", so a
 * bad row can never break the layout or the /api/favicon route.
 */
export function parseFavicon(value: string): ParsedFavicon | null {
  const match = FAVICON_DATA_URI_RE.exec(value.trim());
  if (!match) return null;
  const mime = match[1].toLowerCase() as FaviconMime;
  const base64 = match[3];
  if (base64.length % 4 !== 0) return null;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = (base64.length / 4) * 3 - padding;
  if (bytes <= 0 || bytes > FAVICON_MAX_BYTES) return null;
  return { mime, base64, bytes };
}

/** Coerce an unknown JSON body into a complete `SiteSeo`, trimming + normalising. */
export function normalizeSeoInput(input: unknown): SiteSeo {
  const src =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const str = (field: SeoField, fallback: string): string =>
    typeof src[field] === "string" ? (src[field] as string).trim() : fallback;

  const rawIndex = src.allowIndexing;
  const allowIndexing =
    typeof rawIndex === "boolean"
      ? rawIndex
      : typeof rawIndex === "string"
        ? rawIndex !== "false"
        : SEO_DEFAULTS.allowIndexing;

  const keywords = str("keywords", SEO_DEFAULTS.keywords)
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .join(", ");

  return {
    brandName: str("brandName", SEO_DEFAULTS.brandName),
    tokenName: normalizeTokenName(str("tokenName", SEO_DEFAULTS.tokenName)),
    siteTitle: str("siteTitle", SEO_DEFAULTS.siteTitle),
    description: str("description", SEO_DEFAULTS.description),
    keywords,
    siteUrl: str("siteUrl", SEO_DEFAULTS.siteUrl).replace(/\/+$/, ""),
    ogImage: str("ogImage", SEO_DEFAULTS.ogImage),
    twitterHandle: str("twitterHandle", SEO_DEFAULTS.twitterHandle).replace(
      /^@+/,
      ""
    ),
    xUrl: str("xUrl", SEO_DEFAULTS.xUrl),
    telegramUrl: str("telegramUrl", SEO_DEFAULTS.telegramUrl),
    gaMeasurementId: str("gaMeasurementId", SEO_DEFAULTS.gaMeasurementId),
    allowIndexing,
    googleSiteVerification: str(
      "googleSiteVerification",
      SEO_DEFAULTS.googleSiteVerification
    ),
    favicon: str("favicon", SEO_DEFAULTS.favicon),
  };
}

/** Field-level validation. Returns an empty object when everything is fine. */
export function validateSeo(seo: SiteSeo): SeoErrors {
  const errors: SeoErrors = {};

  if (seo.brandName.length < 1 || seo.brandName.length > 40) {
    errors.brandName = "Use 1–40 characters.";
  }
  if (!TOKEN_NAME_RE.test(seo.tokenName)) {
    errors.tokenName =
      "Use 1–16 letters, numbers, or . _ - (any case, e.g. DRAWFI or DrawFi; the $ is optional).";
  }
  if (seo.siteTitle.length < 1 || seo.siteTitle.length > 70) {
    errors.siteTitle = "Use 1–70 characters (Google truncates around 60).";
  }
  if (seo.description.length < 1 || seo.description.length > 320) {
    errors.description = "Use 1–320 characters (aim for 150–160).";
  }
  if (seo.keywords.length > 500) {
    errors.keywords = "Keep the keyword list under 500 characters.";
  }
  if (seo.siteUrl && !isHttpUrl(seo.siteUrl)) {
    errors.siteUrl = "Must be a full URL starting with http:// or https://.";
  }
  if (seo.ogImage && !isHttpUrl(seo.ogImage)) {
    errors.ogImage = "Must be a full https:// URL to the image.";
  }
  if (seo.twitterHandle && !/^[A-Za-z0-9_]{1,15}$/.test(seo.twitterHandle)) {
    errors.twitterHandle = "Handle only, without @ (max 15 characters).";
  }
  if (seo.xUrl) {
    const ok =
      isHttpUrl(seo.xUrl) && /^https?:\/\/(www\.)?(x|twitter)\.com\//i.test(seo.xUrl);
    if (!ok) errors.xUrl = "Use a full X/Twitter profile URL, e.g. https://x.com/drawfi.";
  }
  if (seo.telegramUrl) {
    const ok =
      isHttpUrl(seo.telegramUrl) &&
      /^https?:\/\/(www\.)?(t\.me|telegram\.me|telegram\.dog)\//i.test(seo.telegramUrl);
    if (!ok) errors.telegramUrl = "Use a full Telegram link, e.g. https://t.me/drawfi.";
  }
  if (seo.gaMeasurementId && !/^G-[A-Z0-9]{4,20}$/i.test(seo.gaMeasurementId)) {
    errors.gaMeasurementId = "GA4 IDs look like G-XXXXXXXXXX.";
  }
  if (seo.googleSiteVerification.length > 120) {
    errors.googleSiteVerification = "Verification token is too long.";
  }
  if (seo.favicon && !parseFavicon(seo.favicon)) {
    errors.favicon = `Upload a PNG, ICO, SVG or WebP under ${
      FAVICON_MAX_BYTES / 1024
    } KB.`;
  }
  return errors;
}

export interface SaveSeoResult {
  seo: SiteSeo;
  applied: SeoField[];
  errors: SeoErrors;
}

/** Validate + upsert every SEO field. Nothing is written if any field fails. */
export async function saveSeo(input: unknown): Promise<SaveSeoResult> {
  const seo = normalizeSeoInput(input);
  const errors = validateSeo(seo);
  if (Object.keys(errors).length > 0) {
    return { seo, applied: [], errors };
  }

  const fields = Object.keys(SEO_KEYS) as SeoField[];
  await prisma.$transaction(
    fields.map((field) => {
      const value = serialize(field, seo);
      return prisma.adminSetting.upsert({
        where: { key: SEO_KEYS[field] },
        update: { value },
        create: { key: SEO_KEYS[field], value },
      });
    })
  );
  return { seo, applied: fields, errors: {} };
}

/** Remove every SEO override → back to `SEO_DEFAULTS` / env. */
export async function clearSeo(): Promise<SiteSeo> {
  await prisma.adminSetting.deleteMany({
    where: { key: { in: Object.values(SEO_KEYS) } },
  });
  return { ...SEO_DEFAULTS };
}
