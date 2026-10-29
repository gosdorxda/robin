"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  Input,
  Separator,
  TextField,
} from "@heroui/react";
import {
  DEFAULT_FONT,
  fontCss,
  parseFontInput,
  type FontConfig,
} from "@/lib/font-shared";

/**
 * Admin → Font.
 *
 * Paste a Google Fonts family name ("Playfair Display") or the stylesheet link
 * Google gives you (`https://fonts.googleapis.com/css2?family=…`) — both are
 * accepted. Saving stores the family in `AdminSetting.SITE_FONT`; the root layout
 * then links that stylesheet and overrides `--font-sans`, so the whole site
 * (HeroUI included) switches on the next render, no rebuild.
 *
 * Typing previews live: a `<link id="font-preview-link">` plus a
 * `<style id="font-preview">` are appended to the document while the draft is
 * valid and removed on unmount, so leaving /admin never leaves a draft face
 * behind.
 */
type Notice = { kind: "ok" | "err"; text: string } | null;

/** `…family=Playfair+Display:wght@…` → `Playfair Display` (for the preview CSS). */
function familyFromHref(href: string): string {
  try {
    const family = new URL(href).searchParams.get("family") ?? "";
    return family.split(":")[0].replace(/\+/g, " ") || "Geist";
  } catch {
    return "Geist";
  }
}

export function FontPanel() {
  const [current, setCurrent] = useState<FontConfig | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"load" | "save" | "reset" | null>("load");
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    setBusy("load");
    try {
      const r = await fetch("/api/admin/font", { cache: "no-store" });
      const body = (await r.json()) as { font?: FontConfig; error?: string };
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      const font = body.font ?? DEFAULT_FONT;
      setCurrent(font);
      setDraft(font.href ? font.family : "");
    } catch (e) {
      setCurrent(DEFAULT_FONT);
      setNotice({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Parsed on every keystroke: drives the live preview, the hint and Save.
  const parsed = draft.trim() ? parseFontInput(draft) : null;
  const preview = parsed && "config" in parsed ? parsed.config : null;
  const fieldError = parsed && "error" in parsed ? parsed.error : null;
  const previewHref = preview?.href ?? "";

  useEffect(() => {
    if (!previewHref) return;
    const link = document.createElement("link");
    link.id = "font-preview-link";
    link.rel = "stylesheet";
    link.href = previewHref;
    document.head.appendChild(link);

    const style = document.createElement("style");
    style.id = "font-preview";
    style.textContent = fontCss({ family: familyFromHref(previewHref), href: previewHref });
    document.body.appendChild(style);

    return () => {
      link.remove();
      style.remove();
    };
  }, [previewHref]);

  async function save() {
    setBusy("save");
    setNotice(null);
    try {
      const r = await fetch("/api/admin/font", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: draft }),
      });
      const body = (await r.json()) as { ok?: boolean; font?: FontConfig; error?: string };
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      const font = body.font ?? DEFAULT_FONT;
      setCurrent(font);
      setDraft(font.family);
      setNotice({ kind: "ok", text: `Saved — every page now uses ${font.family}.` });
    } catch (e) {
      setNotice({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    setBusy("reset");
    setNotice(null);
    try {
      const r = await fetch("/api/admin/font", { method: "DELETE" });
      const body = (await r.json()) as { font?: FontConfig; error?: string };
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setCurrent(body.font ?? DEFAULT_FONT);
      setDraft("");
      setNotice({ kind: "ok", text: "Reset — back to the bundled Geist stack." });
    } catch (e) {
      setNotice({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const isDefault = !!current && !current.href;
  // Enabled only for a valid, changed family — typing junk keeps Save disabled
  // instead of firing a request just to come back with the same field error.
  const dirty = !!preview && preview.family !== (current?.href ? current.family : "");

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-2">
        <p className="font-bold">Typography</p>
        <Chip size="sm" variant="soft">
          {current === null ? "reading…" : isDefault ? "Geist (default)" : current.family}
        </Chip>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onPress={load}
          isPending={busy === "load"}
        >
          Refresh
        </Button>
      </CardHeader>
      <Separator />
      <CardContent className="gap-4">
        <p className="text-sm text-muted">
          Paste a <span className="text-foreground">Google Fonts</span> family name, or the
          stylesheet link from Google Fonts → “Get embed code” (the{" "}
          <span className="font-mono text-xs">…/css2?family=…</span> URL). Weights
          400/500/600/700 are requested. Typing previews the face on this page immediately;
          visitors keep the current one until you save.
        </p>

        <div className="max-w-xl">
          <TextField
            aria-label="Google Font"
            value={draft}
            onChange={setDraft}
            isInvalid={!!fieldError}
          >
            <Input placeholder="Playfair Display — or https://fonts.googleapis.com/css2?family=…" />
          </TextField>
          <p className={`mt-1.5 text-xs ${fieldError ? "text-danger" : "text-muted"}`}>
            {fieldError ??
              (preview
                ? `Detected: ${preview.family} — loaded from fonts.googleapis.com`
                : "Only fonts.googleapis.com is accepted; other hosts are rejected.")}
          </p>
        </div>

        <div className="rounded-lg border border-(--border) bg-default/40 p-4">
          <p className="text-xs uppercase tracking-wider text-muted">Preview</p>
          <p className="mt-1 text-2xl font-semibold leading-tight">Hold. Win the pool.</p>
          <p className="mt-1 text-sm text-muted">
            Aa Bb Cc 0123456789 — the quick brown fox jumps over the lazy dog.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onPress={save} isPending={busy === "save"} isDisabled={!dirty}>
            Save font
          </Button>
          <Button
            variant="secondary"
            onPress={reset}
            isPending={busy === "reset"}
            isDisabled={isDefault}
          >
            Reset to Geist
          </Button>
          {notice ? (
            <span className={notice.kind === "ok" ? "text-xs text-success" : "text-xs text-danger"}>
              {notice.text}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

