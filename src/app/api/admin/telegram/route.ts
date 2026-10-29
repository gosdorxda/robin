import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-guard";
import {
  discoverChats,
  getBotOverview,
  getBotStoredConfig,
  normalizeBotInput,
  previewBotTemplates,
  saveBotConfig,
  sendLastDrawNow,
  sendRoundUpdate,
  sendTestMessage,
} from "@/lib/telegram-bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/admin/telegram — the Telegram group bot (Admin → Telegram Bot).
 *
 *   GET  → config (token masked), runtime state, live plain-text previews of
 *          both messages, next-draw time and the recent send log.
 *   PUT  → { config: { enabled, chatId, threadId, intervalMinutes,
 *                      notifyRound, notifyDraw, token?, clearToken? } }
 *          Validation errors come back as 400 with `errors` keyed by field.
 *   POST → { action: "test" | "round" | "lastDraw" | "chats" | "preview" }
 *          `test`     sends a connection message to the group
 *          `round`    sends the current-round post right now
 *          `lastDraw` re-sends the latest completed round announcement
 *          `chats`    lists chats that have messaged the bot (getUpdates)
 *          `preview`  renders unsaved templates against live data
 *                     ({ templates: { roundTemplate, drawTemplate } })
 *
 * Everything is admin-guarded; the bot token is never returned in full.
 */

export async function GET(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const overview = await getBotOverview();
    return NextResponse.json({ ok: true, ...overview });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { config?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const current = await getBotStoredConfig();
    const { config, errors } = normalizeBotInput(body.config, current);

    // A saved token OR the env fallback both count — the panel should be usable
    // with the secret kept entirely in `.env`.
    const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
    if (config.enabled && !config.token && !envToken) {
      errors.token =
        "Add the bot token before enabling the bot (or set TELEGRAM_BOT_TOKEN).";
    }

    if (Object.keys(errors).length > 0) {
      return NextResponse.json({ errors }, { status: 400 });
    }

    await saveBotConfig(config);
    const overview = await getBotOverview();
    return NextResponse.json({ ok: true, ...overview });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!isAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { action?: unknown; templates?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "";

  try {
    if (action === "chats") {
      const res = await discoverChats();
      return NextResponse.json(res, { status: res.ok ? 200 : 400 });
    }

    if (action === "preview") {
      const res = await previewBotTemplates(body.templates);
      return res.ok
        ? NextResponse.json({ ok: true, preview: res.preview })
        : NextResponse.json({ error: res.error }, { status: 400 });
    }

    let result: { ok: boolean; error?: string };
    switch (action) {
      case "test":
        result = await sendTestMessage();
        break;
      case "round":
        result = await sendRoundUpdate();
        break;
      case "lastDraw":
        result = await sendLastDrawNow();
        break;
      default:
        return NextResponse.json(
          {
            error:
              "action must be one of: test, round, lastDraw, chats, preview",
          },
          { status: 400 }
        );
    }

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    const overview = await getBotOverview();
    return NextResponse.json({ ok: true, ...overview });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
