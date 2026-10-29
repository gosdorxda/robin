import { NextRequest } from "next/server";
import { verifySessionToken, ADMIN_COOKIE } from "./auth";

/**
 * Returns true if the incoming request carries a valid admin session cookie.
 * Used to guard admin-only API routes (trigger-sync, trigger-draw, etc.).
 */
export function isAdmin(request: NextRequest): boolean {
  const token = request.cookies.get(ADMIN_COOKIE)?.value;
  return verifySessionToken(token);
}
