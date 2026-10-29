"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  Input,
  Separator,
  TextArea,
  TextField,
} from "@heroui/react";

/**
 * Admin → SEO & Analytics.
 *
 * Everything here is persisted by `/api/admin/seo` into the key/value
 * `AdminSetting` table and consumed by the root layout (`generateMetadata` +
 * the GA <Script> tags) and by `SiteProvider` (sidebar wordmark/breadcrumbs).
 */

type SeoView = {
  brandName: string;
  tokenName: string;
  siteTitle: string;
  description: string;
  keywords: string;
  siteUrl: string;
  ogImage: string;
  twitterHandle: string;
  xUrl: string;
  telegramUrl: string;
  gaMeasurementId: string;
  allowIndexing: boolean;
  googleSiteVerification: string;
  favicon: string;
};

type SeoErrors = Partial<Record<keyof SeoView, string>>;

type SeoResponse = {
  seo?: SeoView;
  defaults?: SeoView;
  errors?: SeoErrors;
  error?: string;
};

const EMPTY: SeoView = {
  brandName: "",
  tokenName: "",
  siteTitle: "",
  description: "",
  keywords: "",
  siteUrl: "",
  ogImage: "",
  twitterHandle: "",
  xUrl: "",
  telegramUrl: "",
  gaMeasurementId: "",
  allowIndexing: true,
  googleSiteVerification: "",
  favicon: "",
};

const GA_RE = /^G-[A-Z0-9]{4,20}$/i;

/** Mirrors FAVICON_MAX_BYTES / FAVICON_MIME_TYPES in `@/lib/seo` (server-only). */
const FAVICON_MAX_BYTES = 128 * 1024;
const FAVICON_TYPES = [
  "image/png",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/svg+xml",
  "image/webp",
];

/** Decoded byte size of a base64 data URI (for the "current" hint). */
function dataUriBytes(uri: string): number {
  const comma = uri.indexOf(",");
  if (comma < 0) return 0;
  const b64 = uri.slice(comma + 1).replace(/\s+/g, "");
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.round((b64.length / 4) * 3) - padding);
}

function initialOf(brand: string): string {
  return brand.trim().charAt(0).toUpperCase() || "P";
}

/** "https://pay.fun/docs" → "pay.fun › docs" for the SERP preview. */
function prettyUrl(url: string): string {
  if (!url) return "your-domain.com";
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "").replace(/\//g, " › ");
    return `${u.hostname}${path}`;
  } catch {
    return url.replace(/^https?:\/\//, "");
  }
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {children}
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function SeoPanel() {
  const [draft, setDraft] = useState<SeoView>(EMPTY);
  const [defaults, setDefaults] = useState<SeoView>(EMPTY);
  const [errors, setErrors] = useState<SeoErrors>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  const faviconInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/seo", { cache: "no-store" });
      const data = (await r.json()) as SeoResponse;
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      if (data.seo) setDraft(data.seo);
      if (data.defaults) setDefaults(data.defaults);
      setErrors({});
      setDirty(false);
      setNotice(null);
    } catch (e) {
      setNotice({ kind: "err", text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function set<K extends keyof SeoView>(key: K, value: SeoView[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
    setDirty(true);
    setNotice(null);
  }

  /**
   * Read the chosen file into a data URI — the same string the API stores, so
   * the preview is exactly what `/api/favicon` will serve. Validated client-side
   * as well as on the server (type + decoded size).
   */
  function onFaviconFile(file: File | null | undefined) {
    if (!file) return;
    const mime = file.type.toLowerCase();
    if (!FAVICON_TYPES.includes(mime)) {
      setErrors((e) => ({
        ...e,
        favicon: "Use a PNG, ICO, SVG or WebP image.",
      }));
      return;
    }
    if (file.size > FAVICON_MAX_BYTES) {
      setErrors((e) => ({
        ...e,
        favicon: `Maximum size is ${FAVICON_MAX_BYTES / 1024} KB — this file is ${Math.ceil(
          file.size / 1024
        )} KB.`,
      }));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const uri = typeof reader.result === "string" ? reader.result : "";
      if (!uri.startsWith(`data:${mime}`)) {
        setErrors((e) => ({ ...e, favicon: "Could not read that file." }));
        return;
      }
      setDraft((d) => ({ ...d, favicon: uri }));
      setErrors((e) => ({ ...e, favicon: undefined }));
      setDirty(true);
      setNotice(null);
    };
    reader.onerror = () =>
      setErrors((e) => ({ ...e, favicon: "Could not read that file." }));
    reader.readAsDataURL(file);
  }

  async function save() {
    setSaving(true);
    setNotice(null);
    try {
      const r = await fetch("/api/admin/seo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seo: draft }),
      });
      const data = (await r.json()) as SeoResponse;
      if (r.status === 400 && data.errors) {
        setErrors(data.errors);
        setNotice({
          kind: "err",
          text: "Some fields need attention — nothing was saved.",
        });
        return;
      }
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      if (data.seo) setDraft(data.seo);
      setErrors({});
      setDirty(false);
      setNotice({
        kind: "ok",
        text: "Saved. Titles, meta tags and analytics will update within seconds.",
      });
    } catch (e) {
      setNotice({ kind: "err", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    if (
      !window.confirm(
        "Reset every branding & SEO field (including the token name) to its default value? This clears the overrides from the database."
      )
    ) {
      return;
    }
    setResetting(true);
    setNotice(null);
    try {
      const r = await fetch("/api/admin/seo", { method: "DELETE" });
      const data = (await r.json()) as SeoResponse;
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      if (data.seo) setDraft(data.seo);
      setErrors({});
      setDirty(false);
      setNotice({ kind: "ok", text: "Reset to defaults." });
    } catch (e) {
      setNotice({ kind: "err", text: (e as Error).message });
    } finally {
      setResetting(false);
    }
  }

  const gaValid = !draft.gaMeasurementId || GA_RE.test(draft.gaMeasurementId);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-2">
        <p className="font-bold">SEO &amp; Analytics</p>
        {dirty ? (
          <Chip size="sm" variant="soft" color="warning">
            Unsaved changes
          </Chip>
        ) : null}
        <span className="ml-auto text-xs text-muted">
          Branding, metadata and the GA4 tag for every page
        </span>
        <Button
          size="sm"
          variant="ghost"
          onPress={load}
          isDisabled={loading || saving || resetting}
        >
          Reload
        </Button>
      </CardHeader>
      <Separator />
      <CardContent className="gap-6">
        {notice ? (
          <div
            className={`rounded-lg border px-3 py-2 text-sm ${
              notice.kind === "ok"
                ? "border-(--border) bg-success/10 text-success"
                : "border-(--border) bg-danger/10 text-danger"
            }`}
          >
            {notice.text}
          </div>
        ) : null}

        {loading ? (
          <p className="text-sm text-muted">Loading SEO settings…</p>
        ) : (
          <>
            <section className="flex flex-col gap-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Brand &amp; headings
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Token name"
                  hint="Ticker used across the app (hero, eligibility, holders, treasury). Case is kept as typed — DRAWFI, DrawFi and drawfi all display exactly like that."
                  error={errors.tokenName}
                >
                  <TextField
                    aria-label="Token name"
                    value={draft.tokenName}
                    onChange={(v) => set("tokenName", v)}
                    isInvalid={!!errors.tokenName}
                  >
                    <Input placeholder={defaults.tokenName} />
                  </TextField>
                </Field>
                <Field
                  label="Brand name"
                  hint="Wordmark in the sidebar, breadcrumbs and the suffix of every page title."
                  error={errors.brandName}
                >
                  <TextField
                    aria-label="Brand name"
                    value={draft.brandName}
                    onChange={(v) => set("brandName", v)}
                    isInvalid={!!errors.brandName}
                  >
                    <Input placeholder={defaults.brandName} />
                  </TextField>
                </Field>
              </div>
              <Field
                label="Homepage title"
                hint="Used as the default <title> and the site name in social cards."
                error={errors.siteTitle}
              >
                <TextField
                  aria-label="Homepage title"
                  value={draft.siteTitle}
                  onChange={(v) => set("siteTitle", v)}
                  isInvalid={!!errors.siteTitle}
                >
                  <Input placeholder={defaults.siteTitle} />
                </TextField>
              </Field>
              <Field
                label="Meta description"
                hint={`Shown in search results and link previews · ${draft.description.length}/320`}
                error={errors.description}
              >
                <TextField
                  aria-label="Meta description"
                  value={draft.description}
                  onChange={(v) => set("description", v)}
                  isInvalid={!!errors.description}
                >
                  <TextArea rows={3} placeholder={defaults.description} />
                </TextField>
              </Field>
              <Field
                label="Keywords"
                hint="Comma-separated. Low SEO impact, but harmless."
                error={errors.keywords}
              >
                <TextField
                  aria-label="Keywords"
                  value={draft.keywords}
                  onChange={(v) => set("keywords", v)}
                  isInvalid={!!errors.keywords}
                >
                  <Input placeholder={defaults.keywords} />
                </TextField>
              </Field>
            </section>

            <div className="rounded-lg border border-(--border) bg-surface-secondary p-4">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
                Search result preview
              </p>
              <div className="flex items-start gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-bold text-accent">
                  {initialOf(draft.brandName)}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-xs text-muted">
                    {prettyUrl(draft.siteUrl)}
                  </p>
                  <p className="truncate text-base font-medium text-accent">
                    {draft.siteTitle || defaults.siteTitle}
                  </p>
                  <p className="mt-1 line-clamp-2 text-xs text-muted">
                    {draft.description || defaults.description}
                  </p>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted">
                Page titles render as{" "}
                <span className="font-mono text-foreground">
                  How it works · {draft.brandName || defaults.brandName}
                </span>
              </p>
            </div>

            <section className="flex flex-col gap-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Pages &amp; social
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Site URL"
                  hint="Canonical base, e.g. https://pay.fun. No trailing slash."
                  error={errors.siteUrl}
                >
                  <TextField
                    aria-label="Site URL"
                    value={draft.siteUrl}
                    onChange={(v) => set("siteUrl", v)}
                    isInvalid={!!errors.siteUrl}
                  >
                    <Input placeholder="https://your-domain.com" inputMode="url" />
                  </TextField>
                </Field>
                <Field
                  label="X / Twitter handle"
                  hint="Without the @. Used in twitter:site / creator tags."
                  error={errors.twitterHandle}
                >
                  <TextField
                    aria-label="X or Twitter handle"
                    value={draft.twitterHandle}
                    onChange={(v) => set("twitterHandle", v)}
                    isInvalid={!!errors.twitterHandle}
                  >
                    <Input placeholder="paytoken" />
                  </TextField>
                </Field>
                <Field
                  label="X profile URL"
                  hint="Sidebar link target, e.g. https://x.com/drawfi. Empty hides the entry."
                  error={errors.xUrl}
                >
                  <TextField
                    aria-label="X profile URL"
                    value={draft.xUrl}
                    onChange={(v) => set("xUrl", v)}
                    isInvalid={!!errors.xUrl}
                  >
                    <Input placeholder="https://x.com/drawfi" inputMode="url" />
                  </TextField>
                </Field>
                <Field
                  label="Telegram link"
                  hint="Channel or group, e.g. https://t.me/drawfi. Empty hides the entry."
                  error={errors.telegramUrl}
                >
                  <TextField
                    aria-label="Telegram link"
                    value={draft.telegramUrl}
                    onChange={(v) => set("telegramUrl", v)}
                    isInvalid={!!errors.telegramUrl}
                  >
                    <Input placeholder="https://t.me/drawfi" inputMode="url" />
                  </TextField>
                </Field>
              </div>
              <Field
                label="Social preview image"
                hint="Absolute https:// URL, 1200×630. Leave empty to omit Open Graph images."
                error={errors.ogImage}
              >
                <TextField
                  aria-label="Social preview image URL"
                  value={draft.ogImage}
                  onChange={(v) => set("ogImage", v)}
                  isInvalid={!!errors.ogImage}
                >
                  <Input
                    placeholder="https://your-domain.com/og.png"
                    inputMode="url"
                  />
                </TextField>
              </Field>
              <Field
                label="Google Search Console verification"
                hint="Only the content value of the google-site-verification meta tag."
                error={errors.googleSiteVerification}
              >
                <TextField
                  aria-label="Google Search Console verification"
                  value={draft.googleSiteVerification}
                  onChange={(v) => set("googleSiteVerification", v)}
                  isInvalid={!!errors.googleSiteVerification}
                >
                  <Input placeholder="e.g. AbC123…" />
                </TextField>
              </Field>
              <Field
                label="Search engine indexing"
                hint="Noindex adds robots noindex,nofollow to every page — useful for staging."
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant={draft.allowIndexing ? "primary" : "outline"}
                    onPress={() => set("allowIndexing", true)}
                  >
                    Indexable
                  </Button>
                  <Button
                    size="sm"
                    variant={!draft.allowIndexing ? "primary" : "outline"}
                    onPress={() => set("allowIndexing", false)}
                  >
                    Noindex
                  </Button>
                  <Chip
                    size="sm"
                    variant="soft"
                    color={draft.allowIndexing ? "success" : "warning"}
                  >
                    {draft.allowIndexing
                      ? "robots: index,follow"
                      : "robots: noindex,nofollow"}
                  </Chip>
                </div>
              </Field>
            </section>

            <section className="flex flex-col gap-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Favicon
              </h3>
              <div className="flex flex-wrap items-start gap-4">
                <div className="flex items-center gap-4 rounded-lg border border-(--border) bg-surface-secondary px-4 py-3">
                  <div
                    role="img"
                    aria-label={
                      draft.favicon ? "Favicon preview" : "No favicon uploaded"
                    }
                    className="flex size-10 shrink-0 items-center justify-center rounded-md border border-(--border) bg-center bg-contain bg-no-repeat"
                    style={
                      draft.favicon
                        ? { backgroundImage: `url("${draft.favicon}")` }
                        : undefined
                    }
                  >
                    {draft.favicon ? null : (
                      <span className="text-base font-bold text-muted">
                        {initialOf(draft.brandName)}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <div
                      aria-hidden
                      className="flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-(--border) bg-center bg-contain bg-no-repeat"
                      style={
                        draft.favicon
                          ? { backgroundImage: `url("${draft.favicon}")` }
                          : undefined
                      }
                    >
                      {draft.favicon ? null : (
                        <span className="text-[8px] font-bold text-muted">
                          {initialOf(draft.brandName)}
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-muted">Tab size</span>
                  </div>
                </div>

                <div className="flex min-w-0 flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={faviconInput}
                      type="file"
                      accept="image/png,image/x-icon,image/vnd.microsoft.icon,image/svg+xml,image/webp,.ico"
                      className="hidden"
                      onChange={(e) => {
                        onFaviconFile(e.currentTarget.files?.[0]);
                        // Allow re-picking the same file after a failed attempt.
                        e.currentTarget.value = "";
                      }}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onPress={() => faviconInput.current?.click()}
                      isDisabled={saving || resetting}
                    >
                      Upload image
                    </Button>
                    {draft.favicon ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onPress={() => set("favicon", "")}
                        isDisabled={saving || resetting}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted">
                    PNG, ICO, SVG or WebP · square, at least 64×64 · max{" "}
                    {FAVICON_MAX_BYTES / 1024} KB
                    {draft.favicon
                      ? ` · current ${Math.max(
                          1,
                          Math.round(dataUriBytes(draft.favicon) / 1024)
                        )} KB`
                      : ""}
                  </p>
                  {errors.favicon ? (
                    <p className="text-xs text-danger">{errors.favicon}</p>
                  ) : null}
                </div>
              </div>
              <p className="text-xs text-muted">
                Stored with the rest of the SEO settings and served from{" "}
                <span className="font-mono text-foreground">/api/favicon</span>
                , which the root metadata links on every page. Saving revalidates
                the layout, so a new icon shows up on the next page load.
              </p>
            </section>

            <section className="flex flex-col gap-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Analytics
              </h3>
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <Field
                  label="Google Analytics measurement ID"
                  hint="GA4 only, e.g. G-XXXXXXXXXX. Leave empty to load no analytics tag."
                  error={errors.gaMeasurementId}
                >
                  <TextField
                    aria-label="Google Analytics measurement ID"
                    value={draft.gaMeasurementId}
                    onChange={(v) => set("gaMeasurementId", v)}
                    isInvalid={!gaValid || !!errors.gaMeasurementId}
                  >
                    <Input
                      placeholder="G-XXXXXXXXXX"
                      className="font-mono"
                      autoCapitalize="characters"
                    />
                  </TextField>
                </Field>
                <Chip
                  size="sm"
                  variant="soft"
                  color={
                    draft.gaMeasurementId
                      ? gaValid
                        ? "success"
                        : "danger"
                      : "default"
                  }
                  className="mb-1"
                >
                  {draft.gaMeasurementId
                    ? gaValid
                      ? "gtag.js will load"
                      : "Invalid ID"
                    : "Analytics off"}
                </Chip>
              </div>
              <p className="text-xs text-muted">
                The tag is rendered once in the root layout with{" "}
                <span className="font-mono text-foreground">next/script</span>{" "}
                (afterInteractive), so it covers every route. When the field is
                empty the fallback is{" "}
                <span className="font-mono text-foreground">
                  NEXT_PUBLIC_GA_ID
                </span>
                .
              </p>
            </section>

            <div className="flex flex-wrap items-center gap-2 border-t border-(--border) pt-4">
              <span className="text-xs text-muted">
                {dirty
                  ? "Unsaved changes."
                  : "All changes saved. Metadata is revalidated on save."}
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={reset}
                  isPending={resetting}
                  isDisabled={saving}
                >
                  Reset to defaults
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onPress={save}
                  isPending={saving}
                  isDisabled={resetting || !dirty || !gaValid}
                >
                  Save SEO settings
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
