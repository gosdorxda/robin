/**
 * Tiny in-process cache for read-only API payloads.
 *
 * Why: Neon (us-east-2) answers ~240 ms per round-trip from the VPS, and the
 * first pooled connection costs ~2 s (TLS + auth). A page that mounts fires
 * several GETs, and each of them used to re-run 3–6 sequential queries plus an
 * RPC call — seconds of waiting for data that changes once an hour.
 *
 * Semantics:
 *  - `fresh` (age < ttlMs)      → return the cached value, zero I/O.
 *  - `stale` (age < ttl + stale)→ return the cached value immediately and kick
 *                                 a background refresh (stale-while-revalidate),
 *                                 so a slow upstream never blocks a request.
 *  - `cold` / expired           → await a single shared load (concurrent
 *                                 requests dedupe onto the same promise).
 *
 * Single-process, in-memory — same trade-off the prize-pool cache already made
 * in /api/status. Mutation routes call `clearCache()` so an admin action is
 * visible immediately instead of waiting for the TTL.
 */

export interface CacheOptions {
  /** How long a value is served without touching the origin. */
  ttlMs: number;
  /** Extra window where the stale value is served while refreshing. Default 4×ttl. */
  staleMs?: number;
}

interface Entry {
  value: unknown;
  ts: number;
}

const globalCache = globalThis as typeof globalThis & {
  /** Shared across route bundles / HMR reloads — see the comment above. */
  __payCacheStore?: Map<string, Entry>;
  __payCacheInflight?: Map<string, Promise<unknown>>;
};

/**
 * The maps live on `globalThis` on purpose: Next.js can evaluate this module
 * more than once (a bundle per route in some builds, plus HMR in dev), and a
 * per-instance Map would let `POST /api/admin/cache` clear a different store
 * than the one `/api/status` filled. One map per process, one effective cache.
 */
const store = (globalCache.__payCacheStore ??= new Map<string, Entry>());
const inflight = (globalCache.__payCacheInflight ??= new Map());

function refresh<T>(key: string, load: () => Promise<T>): Promise<T> {
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = load()
    .then((value) => {
      store.set(key, { value, ts: Date.now() });
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/**
 * Returns the cached value for `key`, loading it with `load` when needed.
 * `ttlMs` may be a plain number (stale window defaults to 4×ttl).
 */
export async function cached<T>(
  key: string,
  ttl: number | CacheOptions,
  load: () => Promise<T>
): Promise<T> {
  const opts = typeof ttl === "number" ? { ttlMs: ttl } : ttl;
  const staleMs = opts.staleMs ?? opts.ttlMs * 4;
  const hit = store.get(key) as Entry & { value: T } | undefined;

  if (hit) {
    const age = Date.now() - hit.ts;
    if (age < opts.ttlMs) return hit.value;
    if (age < opts.ttlMs + staleMs) {
      // Serve stale, refresh behind the request. A failed refresh keeps the old
      // value (and its age), so the next call retries.
      void refresh(key, load).catch(() => {});
      return hit.value;
    }
  }
  return refresh(key, load);
}

/**
 * Drops cached payloads. With no argument everything is cleared — mutation
 * routes (draw, sync, claim, reset, exclusions) use that so the admin UI never
 * reads a pre-action value. A `prefix` narrows it (`"admin:"`, `"rounds"`).
 */
export function clearCache(prefix?: string): number {
  let n = 0;
  for (const key of [...store.keys()]) {
    if (!prefix || key.startsWith(prefix)) {
      store.delete(key);
      n++;
    }
  }
  return n;
}

/** Current cache contents — for the admin logs endpoint / debugging. */
export function cacheStats(): { key: string; ageMs: number }[] {
  const now = Date.now();
  return [...store.entries()].map(([key, e]) => ({ key, ageMs: now - e.ts }));
}
