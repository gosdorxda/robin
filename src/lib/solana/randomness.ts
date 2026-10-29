import { Buffer } from "buffer";

/**
 * Verifiable randomness from the drand public beacon (League of Entropy).
 *
 * drand emits a BLS-signed random value every 3s. The "quicknet" chain is
 * unchained: each beacon signs its round number, and `randomness = sha256(sig)`.
 * The signature is verifiable forever against the chain's fixed public key, so
 * storing `signature` + `round` is a permanent, publicly-auditable proof that the
 * draw used this exact value.
 *
 * Reachability: drand relays are run by Protocol Labs & Cloudflare (well-CDN'd,
 * unlike Switchboard's crossbar host which currently has no public DNS record).
 * We query relays in order for redundancy and cross-check the SAME round from a
 * second relay to detect a tampered response (TLS already guards each request).
 */
/**
 * drand "quicknet" chain (League of Entropy mainnet). Unchained BLS-on-G1
 * (RFC 9380): each beacon signs ONLY its round number, so the stored
 * (round, signature) pair is a self-contained proof — no chain history needed.
 * randomness = sha256(signature). Period = 3s, genesis 2023-08-23.
 */
export const DRAND_CHAIN = "drand-quicknet";
export const DRAND_CHAIN_HASH =
  "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
export const DRAND_PUBLIC_KEY =
  "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
export const DRAND_SCHEME = "bls-unchained-g1-rfc9380";
export const DRAND_PERIOD = 3;

const DRAND_RELAYS = [
  "https://api.drand.sh",
  "https://drand.cloudflare.com",
];

/** Canonical public URL to fetch the beacon for a round (JSON: round, randomness, signature). */
export function drandVerifyUrl(round: number): string {
  return `${DRAND_RELAYS[0]}/${DRAND_CHAIN_HASH}/public/${round}`;
}

interface DrandBeacon {
  round: number;
  randomness: string;
  signature: string;
  previous_signature?: string; // absent on unchained quicknet
}

export interface RandomnessResult {
  /** 32-byte randomness as lowercase hex (64 chars) — seed for winner selection. */
  valueHex: string;
  /** Raw randomness bytes. */
  valueBytes: Uint8Array;
  /** drand beacon round number. */
  round: number;
  /** Hex BLS signature — verifiable proof against the drand quicknet public key. */
  signature: string;
  /** Hex previous-signature (chain link; absent on unchained quicknet). */
  previousSignature?: string;
  /** drand chain identifier. */
  chain: string;
  /** Cross-relay consistency check passed (same round agreed by >=2 relays). */
  verified: boolean;
  /** Relay that served the primary fetch. */
  relay: string;
}

async function fetchBeacon(
  url: string,
  timeoutMs = 10_000
): Promise<DrandBeacon> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const j = (await res.json()) as DrandBeacon;
    if (
      typeof j.round !== "number" ||
      typeof j.randomness !== "string" ||
      typeof j.signature !== "string"
    ) {
      throw new Error("malformed drand payload");
    }
    return j;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches a fresh verifiable random value from the drand public beacon.
 *
 * 1. Fetch `/public/latest` from relays in order until one responds.
 * 2. Cross-check: fetch the SAME round from every other relay. If any returns a
 *    DIFFERENT value for the same round, that's tampering — we refuse to draw.
 *    If a cross-check relay is simply unreachable, we proceed with
 *    `verified=false` (TLS still guards the primary response).
 */
export async function requestRandomness(
  opts: { debug?: boolean } = {}
): Promise<RandomnessResult> {
  const log = opts.debug
    ? (...a: unknown[]) => console.log("[drand]", ...a)
    : undefined;

  let primary: DrandBeacon | null = null;
  let primaryRelay = "";
  let lastErr: unknown = null;
  for (const relay of DRAND_RELAYS) {
    try {
      primary = await fetchBeacon(`${relay}/${DRAND_CHAIN_HASH}/public/latest`);
      primaryRelay = relay;
      log?.("latest beacon round", primary.round, "via", relay);
      break;
    } catch (e) {
      lastErr = e;
      log?.("relay unreachable", relay, (e as Error).message);
    }
  }
  if (!primary) {
    throw new Error(
      `drand: all relays unreachable (${
        lastErr ? (lastErr as Error).message : "unknown"
      })`
    );
  }

  let verified = false;
  for (const relay of DRAND_RELAYS) {
    if (relay === primaryRelay) continue;
    let check: DrandBeacon;
    try {
      check = await fetchBeacon(`${relay}/${DRAND_CHAIN_HASH}/public/${primary.round}`);
    } catch (e) {
      log?.("cross-check relay down", relay, (e as Error).message);
      continue;
    }
    if (
      check.round !== primary.round ||
      check.randomness !== primary.randomness ||
      check.signature !== primary.signature
    ) {
      throw new Error(
        `drand tampering detected: relay ${relay} disagrees on round ${primary.round}`
      );
    }
    verified = true;
    log?.("cross-verified round", primary.round, "with", relay);
    break;
  }

  const valueHex = primary.randomness.toLowerCase();

  return {
    valueHex,
    valueBytes: Uint8Array.from(Buffer.from(valueHex, "hex")),
    round: primary.round,
    signature: primary.signature,
    previousSignature: primary.previous_signature,
    chain: DRAND_CHAIN,
    verified,
    relay: primaryRelay,
  };
}
