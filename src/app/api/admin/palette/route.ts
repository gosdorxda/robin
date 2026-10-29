import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/admin-guard";
import {
  clearPalette,
  countOverrides,
  getPalette,
  PALETTE_DEFAULTS,
  PALETTE_GROUPS,
  PALETTE_TOKENS,
  savePalette,
} from "@/lib/palette";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/palette — token catalogue + effective palette.
 * `tokens` carries the labels, hints and grouping the admin panel renders, so
 * the client never duplicates the list; `defaults` powers the per-row reset.
 */
export async function GET(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const palette = await getPalette();
    return NextResponse.json({
      palette,
      defaults: PALETTE_DEFAULTS,
      tokens: PALETTE_TOKENS,
      groups: PALETTE_GROUPS,
    });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/palette — persist overrides.
 * Body: { palette: { light: {token: "#hex"}, dark: {…} } }.
 * Values equal to the default are dropped; an empty palette deletes the row.
 */
export async function POST(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { palette?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await savePalette(body.palette);
    if (!result.ok) {
      return NextResponse.json(
        {
          error: `Unrecognized color value for ${result.invalid.join(", ")}.`,
          invalid: result.invalid,
        },
        { status: 400 }
      );
    }
    // The palette is injected by the root layout.
    revalidatePath("/", "layout");
    return NextResponse.json({
      ok: true,
      palette: await getPalette(),
      overridden: countOverrides(result.palette),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** DELETE /api/admin/palette — drop every override, back to globals.css. */
export async function DELETE(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    await clearPalette();
    revalidatePath("/", "layout");
    return NextResponse.json({ ok: true, palette: PALETTE_DEFAULTS });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
