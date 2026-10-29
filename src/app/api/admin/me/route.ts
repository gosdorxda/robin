import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    return NextResponse.json({ authenticated: isAdmin(request) });
  } catch {
    // Auth env vars (ADMIN_PASSWORD / ADMIN_SESSION_SECRET) not set yet.
    return NextResponse.json({ authenticated: false, configured: false });
  }
}
