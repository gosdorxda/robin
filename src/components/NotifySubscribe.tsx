"use client";

import { useState } from "react";
import { Icon } from "./ui";

/**
 * #9 — winner-notification subscribe card. Renders on /how-it-works. Posts to
 * /api/notifications/subscribe with { address, channel, endpoint }. The actual
 * dispatch happens server-side in lib/notifications.ts after each round.
 */
export function NotifySubscribe() {
  const [address, setAddress] = useState("");
  const [channel, setChannel] = useState<"email" | "telegram">("email");
  const [endpoint, setEndpoint] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" | "ok" | "err"; msg: string }>({
    kind: "idle",
    msg: "",
  });
  const [busy, setBusy] = useState(false);

  async function submit() {
    setStatus({ kind: "idle", msg: "" });
    setBusy(true);
    try {
      const res = await fetch("/api/notifications/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: address.trim(),
          channel,
          endpoint: endpoint.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setStatus({ kind: "err", msg: data.error || `Failed (${res.status})` });
      } else {
        setStatus({
          kind: "ok",
          msg: "Subscribed — you'll be notified when this wallet wins a round.",
        });
        setEndpoint("");
      }
    } catch (e) {
      setStatus({ kind: "err", msg: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-(--border) bg-surface p-6 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Icon name="bell" className="h-5 w-5 text-accent" />
        <h2 className="text-lg font-semibold">Get notified when you win</h2>
      </div>
      <p className="text-sm text-muted leading-relaxed">
        Subscribe with your wallet address + email or Telegram chat id. We&apos;ll ping you
        the moment a draw crowns that wallet a winner.
      </p>
      <div className="flex flex-col sm:flex-row gap-3 items-end">
        <label className="flex flex-col gap-1.5 sm:w-72">
          <span className="text-xs font-mono uppercase text-muted">Wallet address</span>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="e.g. 7xKXt… or 0x4f52…"
            spellCheck={false}
            className="font-mono rounded-md border border-(--border) bg-surface px-3 py-2 text-sm outline-none focus:border-accent transition"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-mono uppercase text-muted">Channel</span>
          <div className="inline-flex rounded-md border border-(--border) overflow-hidden">
            <button
              type="button"
              onClick={() => setChannel("email")}
              className={`px-3 py-2 text-sm transition ${
                channel === "email" ? "bg-(--button) text-(--button-foreground) active:bg-(--button-pressed)" : "bg-surface text-muted hover:bg-default/40"
              }`}
            >
              Email
            </button>
            <button
              type="button"
              onClick={() => setChannel("telegram")}
              className={`px-3 py-2 text-sm transition ${
                channel === "telegram" ? "bg-(--button) text-(--button-foreground) active:bg-(--button-pressed)" : "bg-surface text-muted hover:bg-default/40"
              }`}
            >
              Telegram
            </button>
          </div>
        </label>
        <label className="flex flex-col gap-1.5 flex-1">
          <span className="text-xs font-mono uppercase text-muted">
            {channel === "email" ? "Email" : "Telegram chat id"}
          </span>
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={channel === "email" ? "you@example.com" : "e.g. 123456789"}
            type={channel === "email" ? "email" : "text"}
            spellCheck={false}
            className="rounded-md border border-(--border) bg-surface px-3 py-2 text-sm outline-none focus:border-accent transition"
          />
        </label>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !address.trim() || !endpoint.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-(--button) px-5 py-2 text-sm font-semibold text-(--button-foreground) transition hover:bg-(--button-hover) active:bg-(--button-pressed) disabled:opacity-50"
        >
          {busy ? "Subscribing…" : "Subscribe"}
        </button>
      </div>
      {status.kind !== "idle" && (
        <p className={`text-sm ${status.kind === "ok" ? "text-success" : "text-danger"}`}>
          {status.msg}
        </p>
      )}
    </section>
  );
}