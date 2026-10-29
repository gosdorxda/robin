/**
 * Admin-editable site typeface — pure, client-safe half (the DB half lives in
 * `lib/font.ts`, mirroring the `palette-css.ts` / `palette.ts` split).
 *
 * Google Fonts only, and deliberately by *link*: the admin pastes a family name
 * or the URL Google gives them, the root layout emits the stylesheet <link> and
 * overrides `--font-sans` at runtime. `next/font` would bake the family into the
 * build, so changing it would need a redeploy — this way it is instant.
 *
 * Parsing is strict on purpose: whatever reaches the injected CSS is rebuilt
 * from a validated family name, never from raw input. A stray `}` or `;` left in
 * the field would otherwise let anyone holding an admin session inject arbitrary
 * CSS into every page.
 */

export const FONT_SETTING_KEY = "SITE_FONT";

/** `href` empty → keep Geist (the built-in face). */
export type FontConfig = { family: string; href: string };

export const DEFAULT_FONT: FontConfig = { family: "Geist", href: "" };

/** Weights requested for every family — enough for body, medium and bold. */
const WEIGHTS = "400;500;600;700";

function cleanFamily(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return null;
  // Letters, digits, spaces, hyphens, apostrophes ("Dela Gothic One" style names
  // are covered); everything else — braces, semicolons, quotes, backslashes — is
  // rejected rather than escaped.
  if (!/^[A-Za-z0-9][A-Za-z0-9 '\-]{0,59}$/.test(name)) return null;
  return name;
}

/** `Playfair Display` → the css2 URL with the weights the UI actually uses. */
export function googleFontHref(family: string): string {
  return `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:wght@${WEIGHTS}&display=swap`;
}

/**
 * Accepts a family name, a css2 URL, an `@import url(…)` line or a pasted
 * `<link href="…">` — all four are what people copy off Google Fonts.
 */
export function parseFontInput(
  raw: string
): { config: FontConfig } | { error: string } {
  const value = raw.trim();
  if (!value) return { error: "Paste a Google Fonts family name or link." };

  const urlMatch = value.match(/https?:\/\/[^\s"'<>)]+/);
  if (urlMatch) {
    let url: URL;
    try {
      url = new URL(urlMatch[0]);
    } catch {
      return { error: "That link could not be parsed." };
    }
    if (url.hostname !== "fonts.googleapis.com") {
      return { error: "Only fonts.googleapis.com links are supported." };
    }
    if (!/^\/css2?\/?$/.test(url.pathname)) {
      return { error: "Use the Google Fonts stylesheet link (…/css2?family=…)." };
    }
    const families = url.searchParams.getAll("family");
    if (families.length === 0) return { error: "That link has no family= parameter." };
    // `family=Playfair+Display:ital,wght@0,400;1,700` → `Playfair Display`
    const family = cleanFamily(families[0].split(":")[0].replace(/\+/g, " "));
    if (!family) return { error: "Could not read a font name from that link." };
    return { config: { family, href: googleFontHref(family) } };
  }

  const family = cleanFamily(value);
  if (!family) {
    return {
      error:
        "Font names may only use letters, numbers, spaces, hyphens and apostrophes.",
    };
  }
  return { config: { family, href: googleFontHref(family) } };
}

/**
 * The CSS the layout injects. `:root:root` outranks the `:root` block Tailwind
 * emits for `@theme`, so the override wins regardless of where the <style> sits
 * in the document. `--font-mono` is re-pointed at the new face too — this
 * project aliases mono to sans on purpose.
 */
export function fontCss(font: FontConfig): string {
  if (!font.href) return "";
  const family = font.family.replace(/'/g, "\\'");
  const stack = `'${family}', ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
  return `:root:root{--font-sans:${stack};--font-mono:var(--font-sans);}`;
}
