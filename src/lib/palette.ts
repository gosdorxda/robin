import { cache } from "react";
import { prisma } from "./prisma";
import {
  countOverrides,
  normalizeHex,
  paletteCss,
  type Palette,
  type PaletteValues,
} from "./palette-css";

export type { Palette, PaletteValues };
export { countOverrides };

/**
 * Admin-editable theme palette (server-only).
 *
 * Every color in this project is a HeroUI semantic token declared in
 * `src/app/globals.css`. This module lets `/admin → Palette` override any of
 * them at runtime: the saved overrides are injected as a `<style>` block by the
 * root layout, so the stylesheet itself stays untouched (defaults remain the
 * source of truth, "reset" just deletes the row).
 *
 * Storage: a single row in the key/value `AdminSetting` table under
 * `THEME_PALETTE` (JSON), so no Prisma migration is needed. Only tokens whose
 * value differs from the built-in default are written — `sanitizePalette()`
 * drops the rest, which also keeps the injected CSS minimal.
 *
 * Values are hex (`#rrggbb`) rather than the oklch used in globals.css so the
 * admin can drive them with a native color picker. Hex defaults below are the
 * sRGB equivalent of those oklch values (converted at ~1/255 precision), which
 * means picking a default and saving it produces no CSS at all.
 *
 * The injected selectors are `html[data-theme="light"|"dark"]` — one step more
 * specific than globals.css (`:root`, `.dark`, `[data-theme=…]`), so overrides
 * win regardless of where the <style> block ends up in the document.
 *
 * Reads are wrapped in React `cache` (one DB query per request). The layout is
 * ISR (`revalidate = 300`), and the admin route calls
 * `revalidatePath("/", "layout")` so a save shows up immediately.
 */

export type PaletteMode = "light" | "dark";

/** One editable color token, with human-facing copy for the admin UI. */
export interface PaletteToken {
  /** CSS custom property name, without the leading `--`. */
  token: string;
  label: string;
  hint: string;
  /** Section heading in the admin panel. */
  group: string;
  light: string;
  dark: string;
}

export const PALETTE_TOKENS: readonly PaletteToken[] = [
  // ── Brand & status ────────────────────────────────────────────────────────
  {
    token: "accent",
    label: "Accent",
    group: "Brand & status",
    light: "#0485f7",
    dark: "#0485f7",
    hint: "Primary action color: solid buttons, active tab indicator, chart line, prize-pool sheen. Soft/hover variants are mixed from it automatically.",
  },
  {
    token: "accent-foreground",
    label: "Accent foreground",
    group: "Brand & status",
    light: "#fcfcfc",
    dark: "#fcfcfc",
    hint: "Text and icons drawn on top of accent fills.",
  },
  {
    token: "success",
    label: "Success",
    group: "Brand & status",
    light: "#15c964",
    dark: "#15c964",
    hint: "Positive states: completed draws, paid payouts, green chips and the buyback row tint.",
  },
  {
    token: "success-foreground",
    label: "Success foreground",
    group: "Brand & status",
    light: "#161917",
    dark: "#161917",
    hint: "Text on success fills.",
  },
  {
    token: "warning",
    label: "Warning",
    group: "Brand & status",
    light: "#f5a523",
    dark: "#f7b750",
    hint: "Attention states: pending payouts, unsaved changes, the warning half of the prize-pool sheen.",
  },
  {
    token: "warning-foreground",
    label: "Warning foreground",
    group: "Brand & status",
    light: "#1a1815",
    dark: "#1a1815",
    hint: "Text on warning fills.",
  },
  {
    token: "danger",
    label: "Danger",
    group: "Brand & status",
    light: "#ff373c",
    dark: "#db3b3e",
    hint: "Destructive actions, errors, failed payouts and the burn row tint.",
  },
  {
    token: "danger-foreground",
    label: "Danger foreground",
    group: "Brand & status",
    light: "#fcfcfc",
    dark: "#fcfcfc",
    hint: "Text on danger fills.",
  },


  // ── Page & surfaces ───────────────────────────────────────────────────────
  {
    token: "background",
    label: "Background",
    group: "Page & surfaces",
    light: "#f4f5f6",
    dark: "#050606",
    hint: "Page canvas behind every screen.",
  },
  {
    token: "foreground",
    label: "Foreground",
    group: "Page & surfaces",
    light: "#181819",
    dark: "#fbfcfd",
    hint: "Primary text color.",
  },
  {
    token: "surface",
    label: "Surface",
    group: "Page & surfaces",
    light: "#ffffff",
    dark: "#17181a",
    hint: "Cards, panels and the top bar.",
  },
  {
    token: "surface-foreground",
    label: "Surface foreground",
    group: "Page & surfaces",
    light: "#181819",
    dark: "#fbfcfd",
    hint: "Text on cards (most body copy inherits this).",
  },
  {
    token: "surface-secondary",
    label: "Surface secondary",
    group: "Page & surfaces",
    light: "#efeff0",
    dark: "#222324",
    hint: "Secondary cards, table headers, nested panels.",
  },
  {
    token: "surface-secondary-foreground",
    label: "Surface secondary foreground",
    group: "Page & surfaces",
    light: "#181819",
    dark: "#fbfcfd",
    hint: "Text on secondary surfaces.",
  },
  {
    token: "surface-tertiary",
    label: "Surface tertiary",
    group: "Page & surfaces",
    light: "#eaeaeb",
    dark: "#262728",
    hint: "Deepest surface step: inset panels and empty states.",
  },
  {
    token: "surface-tertiary-foreground",
    label: "Surface tertiary foreground",
    group: "Page & surfaces",
    light: "#181819",
    dark: "#fbfcfd",
    hint: "Text on tertiary surfaces.",
  },
  {
    token: "overlay",
    label: "Overlay",
    group: "Page & surfaces",
    light: "#ffffff",
    dark: "#17181a",
    hint: "Popovers, menus, tooltips and modals.",
  },
  {
    token: "overlay-foreground",
    label: "Overlay foreground",
    group: "Page & surfaces",
    light: "#181819",
    dark: "#fbfcfd",
    hint: "Text inside overlays.",
  },
  {
    token: "default",
    label: "Default",
    group: "Page & surfaces",
    light: "#eaebec",
    dark: "#272728",
    hint: "Neutral chips, inline code blocks and the table row hover base (bg-default/40).",
  },
  {
    token: "default-foreground",
    label: "Default foreground",
    group: "Page & surfaces",
    light: "#17191b",
    dark: "#fcfcfc",
    hint: "Text on default (neutral) fills.",
  },



  // ── Lines & chrome ────────────────────────────────────────────────────────
  {
    token: "border",
    label: "Border",
    group: "Lines & chrome",
    light: "#dddedf",
    dark: "#28292a",
    hint: "Hairlines: card frames, table borders, input outlines (border-(--border)).",
  },
  {
    token: "separator",
    label: "Separator",
    group: "Lines & chrome",
    light: "#e4e4e5",
    dark: "#212222",
    hint: "Inner dividers inside tables and lists.",
  },
  {
    token: "segment",
    label: "Segment",
    group: "Lines & chrome",
    light: "#feffff",
    dark: "#464747",
    hint: "Fill of the selected pill in HeroUI segmented controls and the tab track.",
  },
  {
    token: "segment-foreground",
    label: "Segment foreground",
    group: "Lines & chrome",
    light: "#181819",
    dark: "#fbfcfd",
    hint: "Label inside the segmented control.",
  },
  {
    token: "scrollbar",
    label: "Scrollbar",
    group: "Lines & chrome",
    light: "#d4d4d5",
    dark: "#9fa0a1",
    hint: "Scrollbar thumb color.",
  },
  {
    token: "muted",
    label: "Muted",
    group: "Lines & chrome",
    light: "#717274",
    dark: "#9fa0a2",
    hint: "Secondary text: labels, hints, timestamps, table captions (text-muted).",
  },
  {
    token: "nav-icon",
    label: "Nav icon",
    group: "Lines & chrome",
    light: "#474848",
    dark: "#cdcecf",
    hint: "Sidebar / mobile-nav glyphs only; sits one step off the muted label on purpose.",
  },
  {
    token: "focus",
    label: "Focus ring",
    group: "Lines & chrome",
    light: "#0485f7",
    dark: "#0485f7",
    hint: "Keyboard focus ring and field focus border.",
  },
  {
    token: "field-background",
    label: "Field background",
    group: "Lines & chrome",
    light: "#ffffff",
    dark: "#17181a",
    hint: "Inputs, text fields, selects and textareas.",
  },
  {
    token: "field-foreground",
    label: "Field foreground",
    group: "Lines & chrome",
    light: "#181819",
    dark: "#fbfcfd",
    hint: "Text typed into form fields.",
  },
  {
    token: "field-placeholder",
    label: "Field placeholder",
    group: "Lines & chrome",
    light: "#717274",
    dark: "#9fa0a2",
    hint: "Placeholder text inside form fields.",
  },
];

/** Group order for the admin panel. */
export const PALETTE_GROUPS: readonly string[] = [
  "Brand & status",
  "Page & surfaces",
  "Lines & chrome",
];

/** Built-in values, keyed by mode then token (no `--` prefix). */
export const PALETTE_DEFAULTS: Palette = {
  light: Object.fromEntries(PALETTE_TOKENS.map((t) => [t.token, t.light])),
  dark: Object.fromEntries(PALETTE_TOKENS.map((t) => [t.token, t.dark])),
};

/** Row key in the `AdminSetting` key/value table. */
export const PALETTE_SETTING_KEY = "THEME_PALETTE";

const TOKEN_NAMES = new Set(PALETTE_TOKENS.map((t) => t.token));

export const EMPTY_PALETTE: Palette = { light: {}, dark: {} };

/**
 * Turn untrusted input into storage-ready overrides: unknown tokens and bad
 * colors are reported in `invalid`, values equal to the default are dropped
 * (so an empty palette means "everything default").
 */
export function sanitizePalette(input: unknown): {
  palette: Palette;
  invalid: string[];
} {
  const palette: Palette = { light: {}, dark: {} };
  const invalid: string[] = [];
  if (!input || typeof input !== "object") return { palette, invalid };

  const src = input as Record<string, unknown>;
  for (const mode of ["light", "dark"] as const) {
    const block = src[mode];
    if (!block || typeof block !== "object") continue;
    for (const [token, raw] of Object.entries(block as Record<string, unknown>)) {
      if (!TOKEN_NAMES.has(token)) {
        invalid.push(`${mode}.${token}`);
        continue;
      }
      if (raw === null || raw === undefined || raw === "") continue;
      const hex = normalizeHex(raw);
      if (!hex) {
        invalid.push(`${mode}.${token}`);
        continue;
      }
      if (hex !== PALETTE_DEFAULTS[mode][token]) palette[mode][token] = hex;
    }
  }
  return { palette, invalid };
}

/** Overrides on top of the built-in defaults → full usable palette. */
export function resolvePalette(overrides: Palette): Palette {
  return {
    light: { ...PALETTE_DEFAULTS.light, ...overrides.light },
    dark: { ...PALETTE_DEFAULTS.dark, ...overrides.dark },
  };
}

/**
 * Sparse overrides from the DB. Never throws: a missing/unreachable database
 * (build, CI) or a malformed row falls back to "no overrides".
 */
export const getPaletteOverrides = cache(async (): Promise<Palette> => {
  try {
    const row = await prisma.adminSetting.findUnique({
      where: { key: PALETTE_SETTING_KEY },
    });
    if (!row) return EMPTY_PALETTE;
    const parsed: unknown = JSON.parse(row.value);
    const { palette } = sanitizePalette(parsed);
    return palette;
  } catch (e) {
    console.warn(
      "[palette] overrides unavailable, using defaults:",
      (e as Error).message
    );
    return EMPTY_PALETTE;
  }
});

/** Effective palette (defaults merged with overrides) — for the admin UI. */
export const getPalette = cache(async (): Promise<Palette> =>
  resolvePalette(await getPaletteOverrides())
);

/** The `<style>` payload injected by the root layout ("" when untouched). */
export const getPaletteCss = cache(
  async (): Promise<string> => paletteCss(await getPaletteOverrides())
);

export type SavePaletteResult =
  | { ok: true; palette: Palette; invalid: [] }
  | { ok: false; palette: Palette; invalid: string[] };

/**
 * Validate + persist overrides. Invalid tokens/colors reject the whole write so
 * a typo can't half-apply. An empty palette deletes the row.
 */
export async function savePalette(input: unknown): Promise<SavePaletteResult> {
  const { palette, invalid } = sanitizePalette(input);
  if (invalid.length > 0) return { ok: false, palette, invalid };

  if (countOverrides(palette) === 0) {
    await prisma.adminSetting.deleteMany({ where: { key: PALETTE_SETTING_KEY } });
  } else {
    const value = JSON.stringify(palette);
    await prisma.adminSetting.upsert({
      where: { key: PALETTE_SETTING_KEY },
      update: { value },
      create: { key: PALETTE_SETTING_KEY, value },
    });
  }
  return { ok: true, palette, invalid: [] };
}

/** Remove every color override → back to globals.css defaults. */
export async function clearPalette(): Promise<void> {
  await prisma.adminSetting.deleteMany({ where: { key: PALETTE_SETTING_KEY } });
}

