/**
 * PONS (Robinhood Chain) creator-fee reader — **read-only**.
 *
 * pumpdev exposes a PONS API on its OWN host (`https://rhc.pumpdev.io`, no API
 * key) whose `GET /api/claim-account` reports what a creator wallet can claim:
 * `claimable = escrowBalance + pending`, where the escrow is what PONS already
 * swept and `pending` is what still sits on the bonding curves of the tokens you
 * name (max 10; a call without `tokens` reports the escrow only).
 *
 * Read-only on purpose: the owner claims manually from the pons interface for now
 * (decision 2026-10-29), so this module never builds, signs or sends anything.
 */
import { CHAIN_LABEL } from "@/lib/chain/network";

const DEFAULT_API_BASE = "https://rhc.pumpdev.io";
const MAX_TOKENS = 10;

export interface PonsTokenFees {
  token: string;
  curve: string | null;
  pendingSol: number;
  graduated: boolean;
  buybackEnabled: boolean;
  /** e.g. "Not a PONS V2 token", "Custom-pair fees are not supported yet". */
  error: string | null;
}

export interface PonsFeeSummary {
  /** What a claim would collect right now, in the native unit (ETH). */
  claimableSol: number | null;
  /** Already swept into the escrow by PONS. */
  escrowSol: number | null;
  /** Still on the bonding curves of `PONS_TOKENS`. */
  pendingSol: number | null;
  /** PumpDev's commission on a claim, in basis points (50 = 0.5%). */
  feeBps: number | null;
  tokens: PonsTokenFees[];
  checkedAt: string;
  /** Human-readable reason when the numbers could not be read. */
  error: string | null;
}

function apiBase(): string {
  return (process.env.PONS_API_BASE?.trim() || DEFAULT_API_BASE).replace(/\/+$/, "");
}

/** `PONS_TOKENS` (comma-separated) filtered to valid addresses, capped at 10. */
function tokensParam(): string {
  return (process.env.PONS_TOKENS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => /^0x[0-9a-fA-F]{40}$/.test(t))
    .slice(0, MAX_TOKENS)
    .join(",");
}

/** wei string → ETH number (display only); null when unparsable. */
function weiToEth(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return Number(BigInt(value)) / 1e18;
  } catch {
    return null;
  }
}

export async function getPonsFeeSummary(
  platformAddress: string
): Promise<PonsFeeSummary> {
  const checkedAt = new Date().toISOString();
  const base = apiBase();
  const tokens = tokensParam();
  const url =
    `${base}/api/claim-account?publicKey=${encodeURIComponent(platformAddress)}` +
    (tokens ? `&tokens=${encodeURIComponent(tokens)}` : "");

  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ""}`);
    }
    const raw = (await res.json()) as Record<string, unknown>;
    const list = Array.isArray(raw.tokens)
      ? (raw.tokens as Record<string, unknown>[])
      : [];
    return {
      claimableSol: weiToEth(raw.claimable),
      escrowSol: weiToEth(raw.escrowBalance),
      pendingSol: weiToEth(raw.pending),
      feeBps: typeof raw.feeBps === "number" ? raw.feeBps : null,
      tokens: list.map((t) => ({
        token: String(t.token ?? ""),
        curve: typeof t.curve === "string" ? t.curve : null,
        pendingSol: weiToEth(t.pending) ?? 0,
        graduated: t.graduated === true,
        buybackEnabled: t.buybackEnabled === true,
        error: typeof t.error === "string" ? t.error : null,
      })),
      checkedAt,
      error: null,
    };
  } catch (e) {
    return {
      claimableSol: null,
      escrowSol: null,
      pendingSol: null,
      feeBps: null,
      tokens: [],
      checkedAt,
      error: `PONS creator fees unavailable on ${CHAIN_LABEL} (${(e as Error).message})`,
    };
  }
}
