import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-guard";
import { prisma } from "@/lib/prisma";
import { logEvent } from "@/lib/log-buffer";
import { clearCache } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type ResetScope = "draws" | "holders" | "all";

/**
 * Permanently deletes stored draw/holder data so the lottery can start fresh —
 * the escape hatch for repeated failed rounds polluting the dashboard. Scoped:
 *   - "draws":   LotteryRound + Winner + CreatorFeeClaim
 *                (FK-safe: Winner first, then Round; claims are independent)
 *   - "holders": HolderSnapshot + Holder      (Snapshot first, then Holder)
 *   - "all":     both of the above
 *
 * Claim history rides along with the "draws" scope because it is the payout
 * trail of that same activity — leaving rows behind made the Creator Fees card
 * keep reporting claims for rounds that no longer exist.
 *
 * NEVER touches AdminSetting (platform config incl. PLATFORM_FEE_BPS) or
 * NotificationSubscription (user opt-ins) — those survive a reset. Wrapped in a
 * single interactive transaction so a partial failure leaves the DB unchanged.
 *
 * Irreversible — there is no undo.
 *
 * Body: { scope: "draws" | "holders" | "all" } (defaults to "all").
 * Returns: { ok, scope, counts: { rounds, winners, claims, holders, snapshots } }.
 */
export async function POST(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { scope?: string } = {};
  try {
    body = (await request.json().catch(() => ({}))) as { scope?: string };
  } catch {
    /* empty/invalid body → falls through to the scope check below */
  }
  const scope = (body.scope ?? "all") as ResetScope;
  if (scope !== "draws" && scope !== "holders" && scope !== "all") {
    return NextResponse.json(
      {
        error: `Invalid scope "${scope}". Use "draws", "holders", or "all".`,
      },
      { status: 400 }
    );
  }

  logEvent("warn", "admin", `reset-data triggered (scope=${scope})`);

  try {
    // Interactive transaction: deletes are FK-ordered (children before parents)
    // so referential integrity holds mid-transaction. Number() coerces the count
    // (Prisma may return number or BigInt depending on driver) to a plain number
    // — safe here because row counts are always well below 2^53.
    const counts = await prisma.$transaction(
      async (tx) => {
        const result = {
          winners: 0,
          rounds: 0,
          claims: 0,
          snapshots: 0,
          holders: 0,
        };
        if (scope === "draws" || scope === "all") {
          result.winners = Number((await tx.winner.deleteMany({})).count);
          result.rounds = Number((await tx.lotteryRound.deleteMany({})).count);
          result.claims = Number(
            (await tx.creatorFeeClaim.deleteMany({})).count
          );
        }
        if (scope === "holders" || scope === "all") {
          result.snapshots = Number(
            (await tx.holderSnapshot.deleteMany({})).count
          );
          result.holders = Number((await tx.holder.deleteMany({})).count);
        }
        return result;
      },
      { timeout: 30000, maxWait: 10000 }
    );

    const summary =
      `reset-data done (scope=${scope}): ` +
      `${counts.rounds} round(s), ${counts.winners} winner(s), ` +
      `${counts.claims} claim(s), ${counts.holders} holder(s), ` +
      `${counts.snapshots} snapshot(s)`;
    logEvent("success", "admin", summary);

    clearCache();
    return NextResponse.json({
      ok: true,
      scope,
      counts: {
        rounds: String(counts.rounds),
        winners: String(counts.winners),
        claims: String(counts.claims),
        holders: String(counts.holders),
        snapshots: String(counts.snapshots),
      },
    });
  } catch (e) {
    const msg = (e as Error).message;
    logEvent(
      "error",
      "admin",
      `reset-data failed (scope=${scope}): ${msg}`
    );
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
