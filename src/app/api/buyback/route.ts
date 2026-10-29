import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-guard";
import { normalizeBuyback, summarizeBuyback } from "@/lib/buyback";
import { readBuyback, writeBuyback } from "@/lib/buyback-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/buyback — the hand-maintained buyback & burn ledger.
 *
 * GET is public (the same figures are printed on /treasury). PUT is admin-only
 * and rewrites `data/buyback.json`; the request body carries the whole document,
 * exactly as the Admin → Buyback form holds it, so a save can never merge
 * half-old rows into fresh ones.
 */

/** GET — ledger + derived totals. Read failures surface as 500 + message. */
export async function GET() {
  try {
    const buyback = await readBuyback();
    return NextResponse.json({ buyback, summary: summarizeBuyback(buyback) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * PUT — body `{ buyback: {...} }`. Validation errors come back as 400 with
 * `errors` keyed by dotted path (`txs.2.signature`) for the form to place.
 */
export async function PUT(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { buyback?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { data, errors } = normalizeBuyback(body.buyback);
  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ errors }, { status: 400 });
  }

  try {
    const buyback = await writeBuyback(data);
    return NextResponse.json({ buyback, summary: summarizeBuyback(buyback) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
