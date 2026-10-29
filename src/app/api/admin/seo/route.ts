import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/admin-guard";
import {
  clearSeo,
  getSiteSeo,
  SEO_DEFAULTS,
  saveSeo,
  type SiteSeo,
} from "@/lib/seo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/seo — effective SEO values + defaults.
 * The admin UI uses `defaults` for placeholders and the reset preview.
 *
 * `seo.tokenName` (the one token-name setting) is included here on purpose:
 * it lives in the same panel + key/value store, so the UI needs no second
 * endpoint.
 */
export async function GET(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const seo = await getSiteSeo();
    return NextResponse.json({ seo, defaults: SEO_DEFAULTS });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/seo — validate + upsert all SEO fields.
 * Body: { seo: SiteSeo }. Returns { seo, applied, errors }.
 */
export async function POST(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { seo?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const result = await saveSeo(body.seo);
    if (Object.keys(result.errors).length > 0) {
      return NextResponse.json(result, { status: 400 });
    }
    // Refresh every route: metadata, <title>, brand wordmark and the GA tag
    // all live in the root layout.
    revalidatePath("/", "layout");
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      {
        applied: [],
        errors: {},
        seo: body.seo ?? SEO_DEFAULTS,
        error: (e as Error).message,
      },
      { status: 500 }
    );
  }
}

/** DELETE /api/admin/seo — drop every override and fall back to defaults. */
export async function DELETE(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const seo: SiteSeo = await clearSeo();
    revalidatePath("/", "layout");
    return NextResponse.json({ ok: true, seo, defaults: SEO_DEFAULTS });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 }
    );
  }
}
