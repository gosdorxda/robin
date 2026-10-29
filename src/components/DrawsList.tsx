"use client";

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CircleCheck, CircleX, Clock, Minus } from "lucide-react";
import { Button, Chip, Tabs } from "@heroui/react";
import { DrandBeacon } from "@/components/DrandBeacon";
import { CountUp, Icon, Skeleton } from "@/components/ui";
import { explorerUrl, fmtDateTimeUtc, fmtSolHuman, fmtSolNum, timeAgo } from "@/lib/format";
// Chain-aware display unit ("SOL" on Solana, "ETH" on Robinhood Chain).
import { NATIVE_SYMBOL } from "@/lib/chain/network";

type Winner = {
  rank: number;
  address: string;
  amountSol: number;
  payoutTx: string | null;
  status: string;
};
type Round = {
  roundNumber: number;
  status: string;
  prizePoolSol: number;
  eligibleCount: number;
  startedAt: string;
  completedAt: string | null;
  randomnessValue: string | null;
  randomnessSignature: string | null;
  randomnessRound: number | null;
  randomnessVerified: boolean;
  error: string | null;
  winners: Winner[];
};
type Chain = {
  name: string;
  hash: string;
  publicKey: string;
  scheme: string;
  period: number;
  verifyBaseUrl: string;
};
type RoundsResponse = {
  network: string;
  chain: Chain;
  rounds: Round[];
  /** Rows matching the current filter (not the page). */
  total: number;
  totals: {
    all: number;
    completed: number;
    failed: number;
    skipped: number;
    /** SOL actually sent to winners, all-time. */
    paidSol: number;
  };
  latest: { roundNumber: number; status: string; at: string | null } | null;
  /** Median gap between consecutive settled rounds (ms) — the real cadence. */
  cadenceMs: number | null;
  limit: number;
  offset: number;
  hasMore: boolean;
  dbError: string | null;
};

/** Rows per page. Server-paginated, so this is a page size, not a window cap. */
const PAGE_SIZE = 10;

/** Status tabs above the list — the API filters server-side (`?status=`). */
type StatusFilter = "all" | "completed" | "skipped" | "failed";
const FILTERS: { key: StatusFilter; label: string; empty: string }[] = [
  { key: "all", label: "All", empty: "No draws yet. The first one appears here as soon as it finishes." },
  { key: "completed", label: "Completed", empty: "No completed draws yet — rounds that pay out will show up here." },
  { key: "skipped", label: "Skipped", empty: "Nothing skipped so far: every round reached the minimum and ran." },
  { key: "failed", label: "Failed", empty: "No failed draws — nothing broke on the payout side." },
];

const shortAddr = (a: string, h = 4, t = 4): string =>
  !a || a.length <= h + t ? a : `${a.slice(0, h)}…${a.slice(-t)}`;
// Chain-aware explorer link (see `explorerUrl` in @/lib/format); the local
// solscan.io copy was removed 2026-10-29 (Phase 3).
const explorer = (v: string, kind: "address" | "tx", net: string): string =>
  explorerUrl(v, kind, net === "devnet" ? "devnet" : "mainnet");
const fmtTime = (iso: string | null): string => fmtDateTimeUtc(iso);

/** Concise human duration from milliseconds, e.g. 600000 → "10 min". Rounded to
 *  the nearest minute so a 59:59 gap reads "1h" instead of "59 min". */
function fmtDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

/** Tailwind classes for a circular rank badge, tiered like a podium.
 *  Subtle tints (gold / silver / bronze) instead of saturated gradients so
 *  they sit calmly inside the HeroUI theme instead of fighting it. */
const rankBadge = (rank: number): string => {
  switch (rank) {
    case 1:
      return "bg-amber-100 text-amber-900 ring-1 ring-amber-200";
    case 2:
      return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
    case 3:
      return "bg-orange-100 text-orange-900 ring-1 ring-orange-200";
    default:
      return "bg-default text-muted ring-1 ring-(--border)";
  }
};

/** DB status values are lowercase machine strings — show them as normal words. */
const STATUS_LABEL: Record<string, string> = {
  completed: "Completed",
  sent: "Paid",
  pending: "Pending",
  drawing: "In progress",
  skipped: "Skipped",
  failed: "Failed",
};
const statusLabel = (status: string): string =>
  STATUS_LABEL[status] ?? status.charAt(0).toUpperCase() + status.slice(1);

/**
 * The engine stores a technical reason on skipped rounds (e.g.
 * "Prize pool 0 SOL (balance at/below reserve) — round skipped"). Visitors don't
 * need that log line, so map the two known cases to plain sentences and keep the
 * raw text only as a fallback.
 */
function skipReason(raw: string | null): string {
  if (!raw) return "There was nothing in the prize pool to pay out.";
  const s = raw.toLowerCase();
  if (s.includes("below minimum")) {
    return "The prize pool didn’t reach the minimum needed for a draw.";
  }
  if (s.includes("at/below reserve") || s.includes("0 sol")) {
    return "There was nothing in the prize pool to pay out.";
  }
  return raw;
}

/**
 * Same idea for failed draws: the stored message is an operator log line like
 * `payout tx 5Dh6… failed on-chain: {"InsufficientFundsForRent":{…}}`. Show one
 * plain sentence and keep the raw text on `title` for anyone who wants details.
 */
function failureReason(raw: string | null): string {
  if (!raw) return "Something went wrong and this draw didn’t finish.";
  const s = raw.toLowerCase();
  if (s.includes("rent-exempt minimum")) {
    return "A prize was too small to create a winner’s wallet, so nothing was paid out, this round needs a bigger prize pool.";
  }
  if (s.includes("failed on-chain") || s.includes("insufficientfunds")) {
    return "The payout transaction failed on-chain, so this draw didn’t pay out.";
  }
  if (s.includes("block height exceeded") || s.includes("has expired")) {
    return `The payout transaction expired before it could confirm, no ${NATIVE_SYMBOL} left the wallet, so this draw didn’t pay out.`;
  }
  if (s.includes("not retrievable")) {
    return "The payout transaction couldn’t be read back from the network, so this draw is unconfirmed.";
  }
  return raw;
}

/** Maps a round/winner status string to a soft chip with a leading status icon. */
function StatusChip({ status, className }: { status: string; className?: string }) {
  const color: "success" | "danger" | "warning" | "default" =
    status === "completed" || status === "sent"
      ? "success"
      : status === "failed"
        ? "danger"
        : status === "skipped"
          ? "default"
          : "warning";
  return (
    <Chip size="sm" variant="soft" color={color} className={className}>
      {color === "success" ? (
        <CircleCheck size={14} aria-hidden="true" />
      ) : color === "danger" ? (
        <CircleX size={14} aria-hidden="true" />
      ) : color === "default" ? (
        <Minus size={14} aria-hidden="true" />
      ) : (
        <Clock size={14} aria-hidden="true" />
      )}
      <Chip.Label>{statusLabel(status)}</Chip.Label>
    </Chip>
  );
}

export default function DrawsList({
  className = "flex flex-col",
}: {
  className?: string;
}) {
  const [data, setData] = useState<RoundsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Background work (filter change, page change, 15 s refresh). It never
   *  unmounts the list — that was the jump: skeletons replaced the card, the
   *  page lost ~900 px of height and the scroll position snapped. */
  const [busy, setBusy] = useState(false);
  /** Only the very first paint is a skeleton state. */
  const loading = !data && !err;
  /** Zero-based page. The API does the slicing, so the browser never holds more
   *  than one page of rounds (each with winners). */
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<StatusFilter>("all");

  const fetchRounds = useCallback(
    async (silent = false) => {
      if (!silent) {
        setBusy(true);
        setErr(null);
      }
      try {
        const status = filter === "all" ? "" : `&status=${filter}`;
        const r = await fetch(
          `/api/rounds?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}${status}`,
          { cache: "no-store" }
        );
        setData((await r.json()) as RoundsResponse);
        setErr(null);
      } catch (e) {
        // Keep the last good page on screen: an error banner above stale rows is
        // far less disruptive than a full-page error in the middle of a filter.
        if (!silent) setErr((e as Error).message);
      } finally {
        if (!silent) setBusy(false);
      }
    },
    [page, filter]
  );

  /* First load, then a quiet 15 s refresh — the same window the API caches, so a
     tab left open keeps the current page honest and picks up newly settled rounds
     without flashing the skeletons. Skipped while the tab is in the background. */
  useEffect(() => {
    fetchRounds();
    const id = window.setInterval(() => {
      if (!document.hidden) fetchRounds(true);
    }, 15_000);
    return () => window.clearInterval(id);
  }, [fetchRounds]);

  /* A reset (or a fresh clone) can shrink the history under the current page.
     Clamp to the last real page instead of storing a corrected value, so the
     refetch that follows lands on a page that exists. */
  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  useEffect(() => {
    if (data && page > pageCount - 1) setPage(pageCount - 1);
  }, [data, page, pageCount]);

  const net = data?.network ?? "mainnet";
  const chain = data?.chain;
  const rounds = data?.rounds ?? [];
  const totals = data?.totals;
  const latest = data?.latest ?? null;
  const firstShown = rounds.length === 0 ? 0 : page * PAGE_SIZE + 1;
  const lastShown = page * PAGE_SIZE + rounds.length;
  const listTop = useRef<HTMLDivElement>(null);

  /** Pager handler: new page, then nudge the list into view only if it scrolled
   *  away (`nearest`), so the page never jumps just because rows changed. */
  const goToPage = (next: number) => {
    setPage(Math.max(0, Math.min(pageCount - 1, next)));
    listTop.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  /** Filter switch: back to page 1. No scrolling — the tab you clicked stays
   *  exactly where it is; the list below swaps in place once the page arrives. */
  const changeFilter = (next: StatusFilter) => {
    if (next === filter) return;
    setFilter(next);
    setPage(0);
  };

  const activeFilter = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const countFor = (key: StatusFilter) =>
    !totals
      ? 0
      : key === "all"
        ? totals.all
        : key === "completed"
          ? totals.completed
          : key === "skipped"
            ? totals.skipped
            : totals.failed;

  // Every figure in the summary is all-time, straight from the API's totals —
  // nothing is derived from the 10 rows on screen any more.
  const pct = (n: number) =>
    totals && totals.all > 0 ? Math.round((n / totals.all) * 100) : 0;

  return (
    <div className={className} ref={listTop} aria-busy={busy}>
      {/* Summary stats card — all-time, from the API's totals */}
      {data && (
        <div className="mb-6 overflow-hidden rounded-lg border border-(--border)">
          <div className="grid grid-cols-2 gap-px bg-(--border) sm:grid-cols-5">
            <Stat
              label="Draws"
              value={<CountUp value={totals?.all ?? 0} />}
              caption={`${totals?.completed ?? 0} completed`}
            />
            <Stat
              label="Skipped"
              value={<CountUp value={totals?.skipped ?? 0} />}
              caption={
                (totals?.failed ?? 0) > 0
                  ? `${pct(totals?.skipped ?? 0)}% · ${totals?.failed} failed`
                  : `${pct(totals?.skipped ?? 0)}% of draws`
              }
            />
            <Stat
              label="Paid out"
              value={
                <CountUp value={totals?.paidSol ?? 0} format={(n) => fmtSolNum(n)} />
              }
              caption={`${NATIVE_SYMBOL} to winners`}
            />
            <Stat
              label="Draw interval"
              value={fmtDuration(data?.cadenceMs ?? null)}
              caption="median of the last 60 rounds"
            />
            <Stat
              label="Latest draw"
              value={timeAgo(latest?.at ?? null)}
              caption={
                latest
                  ? `draw #${latest.roundNumber} · ${statusLabel(latest.status)}`
                  : "no draws yet"
              }
              className="col-span-2 sm:col-span-1"
            />
          </div>
          <div className="border-t border-(--border) px-4 py-2 sm:px-5">
            <p className="text-xs text-muted">
              Every settled draw, newest first. Skipped and failed rounds included.
            </p>
          </div>
        </div>
      )}

      {/* Status tabs (HeroUI Tabs, same primitives as /admin). The filter runs
          on the server, so switching is one small request, not a re-filter of
          the page in the browser. Counts come from the all-time totals, so they
          stay right on every page. */}
      {data && (
        <Tabs
          selectedKey={filter}
          onSelectionChange={(key) => changeFilter(String(key) as StatusFilter)}
          className="mb-4"
        >
          <Tabs.ListContainer>
            <Tabs.List aria-label="Filter draws by status">
              {FILTERS.map((f) => (
                <Tabs.Tab key={f.key} id={f.key}>
                  {f.label}
                  <span className="ml-1 tabular-nums text-xs opacity-70">
                    {countFor(f.key)}
                  </span>
                  <Tabs.Indicator />
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
      )}

      {loading && (
        <>
          {/* Skeleton mirrors the real layout 1:1 — summary card with its footer
              strip, the status tabs, then two draw cards (header · 4 stats ·
              winner rows · beacon block). The old version stopped at the tiles
              plus three thin table rows, so the page grew by ~400 px the moment
              data landed. */}
          <div className="mb-6 overflow-hidden rounded-lg border border-(--border)">
            <div className="grid grid-cols-2 gap-px bg-(--border) sm:grid-cols-5">
              <StatSkeleton label="Draws" />
              <StatSkeleton label="Skipped" />
              <StatSkeleton label="Paid out" />
              <StatSkeleton label="Draw interval" />
              <StatSkeleton label="Latest draw" className="col-span-2 sm:col-span-1" />
            </div>
            <div className="border-t border-(--border) px-4 py-2 sm:px-5">
              <Skeleton className="h-3 w-72 max-w-full" />
            </div>
          </div>

          {/* Status tabs strip */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Skeleton className="h-9 w-20 rounded-md" />
            <Skeleton className="h-9 w-28 rounded-md" />
            <Skeleton className="h-9 w-24 rounded-md" />
            <Skeleton className="h-9 w-24 rounded-md" />
          </div>

          <DrawCardSkeleton />
          <DrawCardSkeleton />
        </>
      )}

      {err && (
        <div className="py-12 text-center">
          <p className="text-danger text-sm">
            Couldn’t load the draw history. Check your connection and try again.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onPress={() => fetchRounds()}
            isPending={busy}
          >
            Try again
          </Button>
        </div>
      )}
      {data?.dbError && (
        <p className="text-danger text-sm py-4">
          The draw history couldn’t be read right now. Please try again in a moment.
        </p>
      )}

      {data && data.rounds.length === 0 && (
        <div className="py-20 text-center">
          <p className="text-muted">{activeFilter.empty}</p>
        </div>
      )}

      {rounds.map((r) => (
        <div
          key={r.roundNumber}
          className={`rounded-lg border border-(--border) bg-surface px-5 py-4 mb-4 transition-opacity duration-150 ${
            busy ? "opacity-60" : ""
          }`}
        >
          {/* Round header */}
          <div className="flex flex-wrap items-center gap-3 -mx-5 px-5 pb-3 mb-3 border-b border-(--border)">
            <h2 className="text-base font-semibold tracking-tight">
              <Link
                href={`/rounds/${r.roundNumber}`}
                className="inline-flex items-center gap-1.5 transition hover:underline"
              >
                Draw #{r.roundNumber}
                {/* Internal route → thin right arrow, like "View all draws" on
                    the homepage. `arrow-up-right` is reserved for links that
                    leave the app (explorer, drand.sh). */}
                <Icon name="arrow-right" className="h-3.5 w-3.5" />
              </Link>
            </h2>
            <StatusChip status={r.status} className="ml-auto" />
          </div>

          {r.status === "skipped" ? (
            <div className="rounded-lg border border-(--border) bg-default/40 px-4 py-3">
              <p className="text-sm font-semibold text-foreground">Draw skipped</p>
              <p className="text-sm text-muted">{skipReason(r.error)}</p>
            </div>
          ) : r.status === "failed" ? (
            <div className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3">
              <p className="text-sm font-semibold text-danger">Draw failed</p>
              <p className="text-sm text-danger" title={r.error ?? undefined}>
                {failureReason(r.error)}
              </p>
            </div>
          ) : (
            <>
          {/* Round stats grid */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 mb-5 sm:grid-cols-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm text-muted">
                Prize pool
              </span>
              <span className="text-sm font-bold">
                {fmtSolHuman(r.prizePoolSol)}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-sm text-muted">
                Eligible holders
              </span>
              <span className="text-sm font-bold">{r.eligibleCount}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-sm text-muted">
                Winners
              </span>
              <span className="text-sm font-bold">{r.winners.length}</span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-sm text-muted">
                Drawn
              </span>
              <span
                className="text-sm font-bold"
                title={fmtTime(r.completedAt ?? r.startedAt)}
              >
                {timeAgo(r.completedAt ?? r.startedAt)}
              </span>
            </div>
          </div>

          {r.error && (
            <p className="text-danger text-sm mb-4" title={r.error}>
              This draw finished with an error logged.
            </p>
          )}

          {/* Randomness section */}
          {r.randomnessValue && r.randomnessRound ? (
            <DrandBeacon
              className="mb-5"
              beaconRound={r.randomnessRound}
              value={r.randomnessValue}
              signature={r.randomnessSignature}
              lotteryRound={r.roundNumber}
              winners={r.winners}
              chain={chain}
            />
          ) : (
            <p className="text-sm text-muted mb-5">
              No drand beacon was recorded for this draw.
            </p>
          )}

          {/* Winners — podium-styled list */}
          <div>
            <p className="text-sm text-muted mb-2">Winners and payouts</p>
            {r.winners.length > 0 ? (
              <div className="flex flex-col">
                {r.winners.map((w) => (
                  <div
                    key={w.rank}
                    className="flex items-center gap-2.5 py-1.5 border-b border-(--border) last:border-0"
                  >
                    <span
                      className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold tabular-nums ${rankBadge(w.rank)}`}
                    >
                      {w.rank}
                    </span>
                    {w.rank === 1 && (
                      <span className="text-xs leading-none" title="Grand prize winner">
                        🏆
                      </span>
                    )}
                    <a
                      href={explorer(w.address, "address", net)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-sm text-muted transition-colors hover:text-foreground hover:underline"
                    >
                      {shortAddr(w.address)}
                    </a>
                    <span className="ml-auto font-semibold tabular-nums text-sm">
                      {fmtSolHuman(w.amountSol)}
                    </span>
                    {w.payoutTx ? (
                      <a
                        href={explorer(w.payoutTx, "tx", net)}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="Open the payout transaction on Solscan"
                        title={`Payout transaction · ${w.payoutTx}`}
                        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-default hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      >
                        <Icon name="arrow-up-right" className="h-3.5 w-3.5" />
                      </a>
                    ) : (
                      <StatusChip status={w.status} />
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">No winners in this draw.</p>
            )}
          </div>
            </>
          )}
        </div>
      ))}

      {data && data.total > 0 && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-(--border) pt-4 pb-2">
          <p className="text-xs text-muted tabular-nums">
            Showing {firstShown}–{lastShown} of {data.total}{" "}
            {filter === "all" ? "settled" : activeFilter.label.toLowerCase()} draw
            {data.total === 1 ? "" : "s"}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onPress={() => goToPage(page - 1)}
              isDisabled={page === 0 || busy}
            >
              <Icon name="arrow-left" className="h-3 w-3" />
              Prev
            </Button>
            <span className="text-xs text-muted tabular-nums">
              Page {page + 1} / {pageCount}
            </span>
            <Button
              variant="outline"
              size="sm"
              onPress={() => goToPage(page + 1)}
              isDisabled={page >= pageCount - 1 || busy}
            >
              Next
              <Icon name="arrow-left" className="h-3 w-3 rotate-180" />
            </Button>
          </div>
        </div>
      )}

    </div>
  );
}

function Stat({
  label,
  value,
  caption,
  className = "",
}: {
  label: string;
  value: ReactNode;
  caption: string;
  className?: string;
}) {
  return (
    <div className={`bg-surface px-4 sm:px-5 py-3 flex flex-col ${className}`}>
      <span className="text-sm text-muted">{label}</span>
      <span className="mt-1 text-xl sm:text-2xl font-semibold tabular-nums leading-tight break-words text-foreground">
        {value}
      </span>
      <span className="mt-1 text-xs text-muted">{caption}</span>
    </div>
  );
}

function StatSkeleton({ label, className = "" }: { label: string; className?: string }) {
  return (
    <div className={`bg-surface px-4 sm:px-5 py-3 flex flex-col ${className}`}>
      <span className="text-sm text-muted">{label}</span>
      <Skeleton className="mt-1 h-6 w-24" />
      <Skeleton className="mt-1 h-3 w-16" />
    </div>
  );
}

/**
 * One draw card while the first page loads. Same paddings, rules and block
 * heights as the real card so the swap underneath is a fade, not a jump:
 * header row → 4 stat cells → three winner rows → beacon panel.
 */
function DrawCardSkeleton() {
  return (
    <div className="rounded-lg border border-(--border) bg-surface px-5 py-4 mb-4">
      <div className="flex flex-wrap items-center gap-3 -mx-5 px-5 pb-3 mb-3 border-b border-(--border)">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="ml-auto h-5 w-20 rounded-full" />
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 mb-5 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-1">
            <Skeleton className="h-[18px] w-20" />
            <Skeleton className="h-[18px] w-24" />
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="size-6 shrink-0 rounded-full" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-3 w-16 shrink-0" />
          </div>
        ))}
      </div>

      <Skeleton className="mt-4 h-14 w-full rounded-lg" />
    </div>
  );
}