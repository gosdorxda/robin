import { NextRequest, NextResponse } from "next/server";
import { CHAIN_KIND } from "@/lib/chain";
import { isAdmin } from "@/lib/admin-guard";
import { prisma } from "@/lib/prisma";
import { toBigInt } from "@/lib/db-amount";
import {
  addExcludedWallet,
  getVenueAccounts,
  isProgramOwnedAccount,
  listExcludedWallets,
  normalizeWalletAddress,
  removeExcludedWallet,
} from "@/lib/exclusions";
import { fmtTokenHuman } from "@/lib/format";
import { clearCache } from "@/lib/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin-maintained DRAW EXCLUSION LIST (blacklist).
 *
 *   GET    → the list + the auto-excluded "venue" accounts (bonding curve /
 *            PumpSwap pool authority, derived from TOKEN_MINT) + "detected"
 *            candidates: current holders whose address is off the ed25519 curve
 *            (PDAs). Detected is a suggestion only: an off-curve address can
 *            also be a legitimate program wallet, so nothing is added
 *            automatically beyond the venue PDAs.
 *   POST   → { address, label? } — add one (base58-validated, deduped).
 *   DELETE → { address } — remove one.
 *
 * Excluded wallets are dropped from the eligible pool BEFORE the drand-seeded
 * shuffle (lib/lottery/engine.ts), so the beacon can never pick them. The list
 * is snapshotted on every round for auditability.
 */
export async function GET(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const tokenDecimals = Number(process.env.TOKEN_DECIMALS ?? 6);
    const [exclusions, latest] = await Promise.all([
      listExcludedWallets(),
      prisma.holderSnapshot.findFirst({
        where: { chain: CHAIN_KIND },
        orderBy: { capturedAt: "desc" },
        select: { capturedAt: true },
      }),
    ]);
    const excludedSet = new Set(exclusions.map((e) => e.address));
    // Venue accounts (bonding curve / pool authority) are excluded
    // automatically, derived from TOKEN_MINT — reported separately so the admin
    // sees why those holders never enter the draw, and left out of `detected`.
    const venue = getVenueAccounts();
    for (const v of venue) excludedSet.add(v.address);

    let detected: {
      address: string;
      amountRaw: string;
      amountHuman: string;
    }[] = [];
    if (latest) {
      const snaps = await prisma.holderSnapshot.findMany({
        where: { capturedAt: latest.capturedAt, chain: CHAIN_KIND },
        select: { holderAddress: true, amount: true },
      });
      const balances = new Map<string, bigint>();
      for (const s of snaps) {
        balances.set(
          s.holderAddress,
          (balances.get(s.holderAddress) ?? 0n) + toBigInt(s.amount)
        );
      }
      detected = Array.from(balances.entries())
        .filter(([address]) => !excludedSet.has(address) && isProgramOwnedAccount(address))
        .map(([address, amount]) => ({
          address,
          amountRaw: amount.toString(),
          amountHuman: fmtTokenHuman(amount, tokenDecimals),
        }))
        .sort((a, b) => (BigInt(b.amountRaw) > BigInt(a.amountRaw) ? 1 : -1));
    }

    return NextResponse.json({
      ok: true,
      tokenDecimals,
      capturedAt: latest ? latest.capturedAt.toISOString() : null,
      exclusions: exclusions.map((e) => ({
        address: e.address,
        label: e.label,
        createdAt: e.createdAt.toISOString(),
      })),
      venue,
      detected,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** POST /api/admin/exclusions — Body: { address, label? } */
export async function POST(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { address?: string; label?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.address) {
    return NextResponse.json({ error: "address is required" }, { status: 400 });
  }
  try {
    const created = await addExcludedWallet(body.address, body.label);
    // Status/eligibility + the admin holders list count this wallet as excluded.
    clearCache();
    return NextResponse.json({
      ok: true,
      exclusion: {
        address: created.address,
        label: created.label,
        createdAt: created.createdAt.toISOString(),
      },
    });
  } catch (e) {
    // Validation / duplicate / list-full errors are user-facing → 400.
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

/** DELETE /api/admin/exclusions — Body: { address } */
export async function DELETE(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { address?: string } = {};
  try {
    body = await request.json();
  } catch {
    /* handled by the missing-address check below */
  }
  if (!body.address) {
    return NextResponse.json({ error: "address is required" }, { status: 400 });
  }
  try {
    // Validate before the delete so a typo reports "invalid address" instead of
    // a silent "not found".
    normalizeWalletAddress(body.address);
    const removed = await removeExcludedWallet(body.address);
    if (!removed) {
      return NextResponse.json(
        { error: "That address is not on the exclusion list" },
        { status: 404 }
      );
    }
    clearCache();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
