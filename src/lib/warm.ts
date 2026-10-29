/**
 * Boot-time warm-up for the cached read endpoints.
 *
 * Why: /api/status, /api/rounds and /api/stats are fetched by the client right
 * after the (statically rendered) pages hydrate. Their cold cost is real — a
 * Neon connection handshake plus 3–8 sequential queries plus a Solana RPC call —
 * so the first visitor after a deploy used to stare at 2–5 s of spinners while
 * everyone after them got the cached payload.
 *
 * The server self-fetches those routes shortly after boot so the cache is
 * already populated (and Prisma's pool already used) before the first real
 * request. Fire-and-forget: failures are logged at debug level and never block
 * startup. Production only — in `next dev` it would just trigger route
 * compilation at boot.
 */
const WARMS = ["/api/status", "/api/rounds", "/api/stats"] as const;

export function warmApiCache(): void {
  if (process.env.NODE_ENV !== "production") return;
  const port = process.env.PORT || "3000";
  const base = `http://127.0.0.1:${port}`;

  setTimeout(() => {
    void (async () => {
      for (const path of WARMS) {
        // Retry a few times: register() can run a moment before the listener
        // is accepting connections (or before nginx is up in a cold container).
        for (let attempt = 1; attempt <= 4; attempt++) {
          try {
            const startedAt = Date.now();
            const res = await fetch(base + path, { cache: "no-store" });
            if (res.ok) {
              await res.arrayBuffer(); // drain so the route handler completes
              console.log(
                `[warm] ${path} ${res.status} in ${Date.now() - startedAt} ms`
              );
              break;
            }
          } catch {
            /* listener not ready yet — retry */
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    })();
  }, 1500);
}
