import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/admin-guard";
import {
  DEFAULT_FONT,
  clearFont,
  getFontConfig,
  saveFont,
} from "@/lib/font";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/font — current typeface + the built-in default.
 * `href` is "" for the default (Geist is bundled, no stylesheet needed).
 */
export async function GET(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({
      font: await getFontConfig(),
      default: DEFAULT_FONT,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * POST /api/admin/font — save. Body: { value: "Playfair Display" } or any
 * Google Fonts css2 link (the parser accepts both). 400 carries the field error.
 */
export async function POST(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { value?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await saveFont(body.value);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    // The family is injected by the root layout.
    revalidatePath("/", "layout");
    return NextResponse.json({ ok: true, font: result.font });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** DELETE /api/admin/font — reset to the built-in Geist stack. */
export async function DELETE(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    await clearFont();
    revalidatePath("/", "layout");
    return NextResponse.json({ ok: true, font: DEFAULT_FONT });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
