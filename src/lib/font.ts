import { cache } from "react";
import { prisma } from "./prisma";
import {
  DEFAULT_FONT,
  FONT_SETTING_KEY,
  fontCss,
  parseFontInput,
  type FontConfig,
} from "./font-shared";

export type { FontConfig };
export { DEFAULT_FONT, parseFontInput };

/**
 * Admin → Font (server-only). One key/value row in `AdminSetting` under
 * `SITE_FONT`, so no migration is needed. Only the family name is stored; the
 * stylesheet URL is rebuilt on every read through `parseFontInput`, which means
 * a hand-edited or corrupted row can never emit a non-Google URL.
 *
 * Reads are wrapped in React `cache` (one query per request); the layout is ISR
 * (`revalidate = 300`) and the API calls `revalidatePath("/", "layout")`, so a
 * save lands on the next render.
 */
export const getFontConfig = cache(async (): Promise<FontConfig> => {
  try {
    const row = await prisma.adminSetting.findUnique({
      where: { key: FONT_SETTING_KEY },
    });
    if (!row) return DEFAULT_FONT;
    const parsed: unknown = JSON.parse(row.value);
    const family = (parsed as { family?: unknown } | null)?.family;
    const result = parseFontInput(typeof family === "string" ? family : "");
    return "error" in result ? DEFAULT_FONT : result.config;
  } catch (e) {
    console.warn("[font] config unavailable, using Geist:", (e as Error).message);
    return DEFAULT_FONT;
  }
});

/** The `<style>` payload injected by the root layout ("" for the default face). */
export const getFontCss = cache(
  async (): Promise<string> => fontCss(await getFontConfig())
);

export type SaveFontResult =
  | { ok: true; font: FontConfig }
  | { ok: false; error: string };

/** Validate + persist. Saving the default family deletes the row instead. */
export async function saveFont(raw: unknown): Promise<SaveFontResult> {
  const result = parseFontInput(typeof raw === "string" ? raw : "");
  if ("error" in result) return { ok: false, error: result.error };

  const value = JSON.stringify({ family: result.config.family });
  await prisma.adminSetting.upsert({
    where: { key: FONT_SETTING_KEY },
    update: { value },
    create: { key: FONT_SETTING_KEY, value },
  });
  return { ok: true, font: result.config };
}

/** Drop the row → back to the Geist stack from globals.css. */
export async function clearFont(): Promise<void> {
  await prisma.adminSetting.deleteMany({ where: { key: FONT_SETTING_KEY } });
}
