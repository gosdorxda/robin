import { createHmac } from "node:crypto";
import { getAuthConfig } from "./config";

export const ADMIN_COOKIE = "pay_admin_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

/** Creates a stateless, HMAC-signed session token: `${exp}.${mac}`. */
export function createSessionToken(): string {
  const exp = Date.now() + SESSION_TTL_MS;
  const cfg = getAuthConfig();
  const mac = createHmac("sha256", cfg.adminSessionSecret)
    .update(String(exp))
    .digest("base64url");
  return `${exp}.${mac}`;
}

/** Verifies a session token (signature + expiry) with a constant-time compare. */
export function verifySessionToken(
  token: string | undefined | null
): boolean {
  if (!token) return false;
  const [expStr, mac] = token.split(".");
  if (!expStr || !mac) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const cfg = getAuthConfig();
  const expected = createHmac("sha256", cfg.adminSessionSecret)
    .update(expStr)
    .digest("base64url");
  if (mac.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < mac.length; i++) {
    diff |= mac.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
