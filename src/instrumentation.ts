/**
 * Next.js instrumentation hook — runs once when the server starts.
 *
 * The scheduler (node-cron + drand + node:crypto/https) is Node-only and
 * cannot be bundled for the Edge runtime. We guard with `process.env.NEXT_RUNTIME`
 * so the scheduler is loaded exclusively in the Node.js runtime, and use a dynamic
 * `import()` so webpack does not pull those heavy dependencies into the Edge
 * instrumentation chunk (this is Next.js' documented pattern for instrumentation
 * hooks that rely on Node.js APIs).
 *
 * Note: in Next 16, `serverExternalPackages` (next.config.mjs) DOES externalize
 * packages for the instrumentation hook's Node runtime — `@prisma/client` /
 * `.prisma/client` are listed there so Prisma initializes at startup (without
 * it, the bundled client can't resolve the generated query engine and throws
 * "did not initialize yet"). The `NEXT_RUNTIME === "nodejs"` guard + dynamic
 * `import()` additionally keep node-cron / node:crypto / node:https out of the
 * Edge instrumentation chunk.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { preferIpv4 } = await import("./lib/net-ipv4");
      if (await preferIpv4()) {
        console.log("[net] ipv4-first aktif, family auto-selection dimatikan");
      }
    } catch (e) {
      console.warn("[net] prefer-ipv4 tidak diterapkan:", (e as Error).message);
    }
    const { startScheduler } = await import("./lib/scheduler");
    await startScheduler();

    // Warm the Prisma pool. The first connection to Neon costs ~2 s (TLS +
    // auth across ~240 ms RTT) and Prisma opens extra connections lazily during
    // a burst — paying that at boot keeps the first page load from absorbing it.
    // Non-fatal: dev previews without secrets must still start.
    try {
      const { prisma } = await import("./lib/prisma");
      const startedAt = Date.now();
      await Promise.all(
        Array.from({ length: 4 }, () => prisma.$queryRaw`SELECT 1`)
      );
      console.log(`[db] pool warm (${Date.now() - startedAt} ms)`);
    } catch (e) {
      console.warn("[db] warm-up gagal:", (e as Error).message);
    }

    // Populate the read caches before the first visitor arrives (production
    // only; see lib/warm.ts). Fire-and-forget — never delays startup.
    try {
      const { warmApiCache } = await import("./lib/warm");
      warmApiCache();
    } catch (e) {
      console.warn("[warm] gagal:", (e as Error).message);
    }
  }
}

