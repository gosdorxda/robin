/**
 * IPv4-first socket defaults for the Node server process.
 *
 * Symptom this prevents — `pumpdev unreachable: fetch failed (ETIMEDOUT)` on a
 * VPS whose IPv4 egress is fine (`curl -4 https://pumpdev.io` → 200 in ~1.7 s)
 * but whose IPv6 has no route at all (`curl -6` fails in 0 ms):
 *
 *   1. `dns.lookup` returns A first, then an AAAA the host cannot use.
 *   2. Node's happy-eyeballs (`autoSelectFamily`, on by default, attempt budget
 *      **250 ms**) starts the IPv4 attempt; 250 ms later — before that handshake
 *      finishes — it also starts the IPv6 attempt.
 *   3. IPv6 dies instantly with `ENETUNREACH`; every attempt is now settled, so
 *      Node aggregates and reports the *still pending* IPv4 attempt as
 *      `ETIMEDOUT`, even though the same connect succeeds in ~0.9 s.
 *
 * Proven with a probe on the affected host (Node 22, `pumpdev.io`):
 *
 *   default            → ERR 304 ms  ETIMEDOUT@80.78.25.150 + ENETUNREACH@2a0a:…
 *   ipv4first          → ERR 252 ms  (flag alone is NOT enough)
 *   ipv4first + noAuto → HTTP 200 in 899 ms
 *
 * Disabling auto-selection leaves one address (A, thanks to `ipv4first`) and no
 * premature abort. Safe for IPv4-only and IPv6-only hosts alike; set
 * `NET_PREFER_IPV4=0` to keep Node's stock behaviour.
 */
export async function preferIpv4(): Promise<boolean> {
  if (process.env.NET_PREFER_IPV4 === "0") return false;
  const dns = await import("node:dns");
  const net = await import("node:net");
  dns.setDefaultResultOrder("ipv4first");
  if (typeof net.setDefaultAutoSelectFamily === "function") {
    net.setDefaultAutoSelectFamily(false);
  }
  return true;
}
