"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  Separator,
} from "@heroui/react";

/**
 * Admin → Settings → Cache.
 *
 * The public read routes cache their payloads in memory for 10–30 s
 * (`lib/cache.ts`). That is the right default, but an admin who just topped up
 * the prize wallet or fixed a row in the DB wants the next request to re-query
 * immediately — this card lists what is held and drops it.
 *
 * Deliberately not a "danger" action: nothing is deleted, and the next request
 * simply pays one more database round-trip.
 */

type CacheEntry = { key: string; ageMs: number };
type Notice = { kind: "ok" | "err"; text: string } | null;

function fmtAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function CacheCard({ onCleared }: { onCleared?: () => void }) {
  const [entries, setEntries] = useState<CacheEntry[] | null>(null);
  const [busy, setBusy] = useState<"load" | "clear" | null>("load");
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    setBusy("load");
    try {
      const r = await fetch("/api/admin/cache", { cache: "no-store" });
      const body = (await r.json()) as {
        entries?: CacheEntry[];
        error?: string;
      };
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setEntries(body.entries ?? []);
    } catch (e) {
      setEntries([]);
      setNotice({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function clear() {
    setBusy("clear");
    setNotice(null);
    try {
      const r = await fetch("/api/admin/cache", { method: "POST" });
      const body = (await r.json()) as {
        cleared?: number;
        remaining?: number;
        error?: string;
      };
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      const n = body.cleared ?? 0;
      setEntries([]);
      setNotice({
        kind: "ok",
        text: `Cleared ${n} cached ${n === 1 ? "entry" : "entries"}.`,
      });
      onCleared?.();
    } catch (e) {
      setNotice({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-2">
        <p className="font-bold">Cache</p>
        <Chip size="sm" variant="soft">
          {entries === null ? "reading…" : `${entries.length} entries`}
        </Chip>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onPress={load}
          isPending={busy === "load"}
        >
          Refresh
        </Button>
      </CardHeader>
      <Separator />
      <CardContent className="gap-3">
        <p className="text-sm text-muted">
          Status, stats, rounds, holders and eligibility responses are held in
          memory for 10–30 s. Clearing only drops those cached payloads — the
          next request re-queries the database. Nothing is deleted and the
          blockchain is not touched.
        </p>

        {entries === null ? (
          <p className="text-sm text-muted">Reading the cache…</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted">
            The cache is empty — every request is already going to the database.
          </p>
        ) : (
          <div className="flex flex-col gap-1 rounded-lg border border-(--border) p-2.5 font-mono text-xs">
            {entries.slice(0, 12).map((entry) => (
              <div key={entry.key} className="flex items-center gap-2">
                <span className="min-w-0 truncate">{entry.key}</span>
                <span className="ml-auto shrink-0 text-muted tabular-nums">
                  {fmtAge(entry.ageMs)}
                </span>
              </div>
            ))}
            {entries.length > 12 ? (
              <span className="text-muted">
                +{entries.length - 12} more key(s)
              </span>
            ) : null}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            onPress={clear}
            isPending={busy === "clear"}
            isDisabled={busy === "clear" || (entries !== null && entries.length === 0)}
          >
            Clear cache
          </Button>
          {notice ? (
            <span
              className={
                notice.kind === "ok"
                  ? "text-xs text-success"
                  : "text-xs text-danger"
              }
            >
              {notice.text}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
