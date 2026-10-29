import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Base58 Solana address (32–44 chars, no 0/O/I/l).
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * PUBLIC winner-notification subscription endpoint. Idempotent via the
 * (address, channel, endpoint) unique constraint — subscribing twice is a no-op.
 * Body: { address, channel: "email"|"telegram", endpoint }
 *   - email channel     -> endpoint is an email address
 *   - telegram channel  -> endpoint is a numeric Telegram chat id
 */
export async function POST(request: NextRequest) {
  let body: { address?: string; channel?: string; endpoint?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const address = (body.address || "").trim();
  const channel = (body.channel || "").trim();
  const endpoint = (body.endpoint || "").trim();

  if (!ADDRESS_RE.test(address)) {
    return NextResponse.json({ error: "Invalid Solana address" }, { status: 400 });
  }
  if (channel !== "email" && channel !== "telegram") {
    return NextResponse.json(
      { error: "Channel must be 'email' or 'telegram'" },
      { status: 400 }
    );
  }
  if (channel === "email" && !EMAIL_RE.test(endpoint)) {
    return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
  }
  if (channel === "telegram" && !/^-?\d+$/.test(endpoint)) {
    return NextResponse.json(
      { error: "Telegram endpoint must be a numeric chat id" },
      { status: 400 }
    );
  }

  try {
    const sub = await prisma.notificationSubscription.upsert({
      where: { address_channel_endpoint: { address, channel, endpoint } },
      update: {},
      create: { address, channel, endpoint },
    });
    return NextResponse.json({ ok: true, id: sub.id.toString() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** Unsubscribe. Body: { address, channel, endpoint } */
export async function DELETE(request: NextRequest) {
  let body: { address?: string; channel?: string; endpoint?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const address = (body.address || "").trim();
  const channel = (body.channel || "").trim();
  const endpoint = (body.endpoint || "").trim();
  if (!address || !channel || !endpoint) {
    return NextResponse.json(
      { error: "address, channel, and endpoint are required" },
      { status: 400 }
    );
  }
  try {
    await prisma.notificationSubscription.deleteMany({
      where: { address, channel, endpoint },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}