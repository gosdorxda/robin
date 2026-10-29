/**
 * Pure palette helpers — no database, no Node APIs, so both the server layer
 * (`src/lib/palette.ts`) and the admin client component can import them.
 */

export type PaletteValues = Record<string, string>;

export interface Palette {
  light: PaletteValues;
  dark: PaletteValues;
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/** Custom-property name guard: `accent`, `surface-secondary`, `field-placeholder`. */
const TOKEN_RE = /^[a-z][a-z0-9-]*$/;

/** `#ABC` → `#aabbcc`; anything that is not a hex color → null. */
export function normalizeHex(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (!HEX_RE.test(value)) return null;
  if (value.length === 4) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
  }
  return value;
}

/*
 * `html[data-theme=…]` is (0,1,1) — one step above globals.css (`:root`, `.dark`,
 * `[data-theme=…]` at (0,1,0)), so an override wins no matter where this style
 * block lands in the document.
 */
const LIGHT_SELECTOR = 'html[data-theme="light"]';
const DARK_SELECTOR = 'html[data-theme="dark"]';

/**
 * Render sparse overrides as CSS. Returns "" when nothing is overridden, which
 * lets the layout skip the <style> tag entirely. Every value and property name
 * is re-validated here so a hand-edited DB row can never inject arbitrary CSS.
 */
export function paletteCss(overrides: Palette): string {
  const block = (selector: string, values: PaletteValues): string => {
    const decls = Object.entries(values)
      .map(([token, value]) => {
        const hex = normalizeHex(value);
        return TOKEN_RE.test(token) && hex ? `--${token}:${hex}` : "";
      })
      .filter(Boolean)
      .join(";");
    return decls ? `${selector}{${decls}}` : "";
  };
  const blocks = [
    block(LIGHT_SELECTOR, overrides.light),
    block(DARK_SELECTOR, overrides.dark),
  ].filter(Boolean);
  return blocks.join("\n");
}

/**
 * Sparse diff: values equal to the default are dropped, so an empty result
 * means "everything default" and the saved row can be deleted.
 */
export function diffPalette(draft: Palette, defaults: Palette): Palette {
  const mode = (a: PaletteValues, b: PaletteValues): PaletteValues => {
    const out: PaletteValues = {};
    for (const [token, value] of Object.entries(a)) {
      if (normalizeHex(value) !== normalizeHex(b[token])) out[token] = value;
    }
    return out;
  };
  return { light: mode(draft.light, defaults.light), dark: mode(draft.dark, defaults.dark) };
}

/** Number of overridden colors across both themes. */
export function countOverrides(overrides: Palette): number {
  return Object.keys(overrides.light).length + Object.keys(overrides.dark).length;
}
