import { NextResponse } from "next/server";
import { getSiteSeo, parseFavicon } from "@/lib/seo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/favicon — serves the favicon uploaded from /admin → SEO.
 *
 * The image lives in `AdminSetting` as a base64 data URI (no filesystem, no
 * object storage, no migration), so this route is the only thing browsers and
 * search engines ever request. Returns 404 when no valid icon is configured,
 * which lets the browser fall back to its default tab icon.
 */
export async function GET() {
  let parsed: ReturnType<typeof parseFavicon> = null;
  try {
    parsed = parseFavicon((await getSiteSeo()).favicon);
  } catch {
    parsed = null;
  }

  if (!parsed) {
    return new NextResponse(null, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const bytes = Buffer.from(parsed.base64, "base64");
  if (bytes.length === 0) {
    return new NextResponse(null, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }

  return new NextResponse(new Blob([bytes], { type: parsed.mime }), {
    status: 200,
    headers: {
      "Content-Type": parsed.mime,
      "Content-Length": String(bytes.byteLength),
      // 5 min matches the root layout's ISR window; saves set revalidatePath so
      // the new icon shows up on the next navigation.
      "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
