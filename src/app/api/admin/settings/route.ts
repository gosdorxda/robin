import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-guard";
import { getSettingsView } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/settings — READ-ONLY summary of the env-driven settings.
 *
 * Every value comes from `.env` (`lib/settings.ts`); there is no write path
 * any more. Editing a value means editing `.env` and restarting the server —
 * the admin UI only displays what the running process loaded.
 */
export async function GET(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const view = await getSettingsView();
    return NextResponse.json(view);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
