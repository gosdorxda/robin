"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { Breadcrumbs, Chip, ProgressBar, Tooltip, Typography } from "@heroui/react";
import HowItWorksFlow from "@/components/HowItWorksFlow";
import RecentDraws from "@/components/RecentDraws";
import { CountUp, ExternalLink, Icon, ThemeToggle, Skeleton } from "@/components/ui";
import { BrandMark } from "@/components/BrandMark";
import { INFORMATION, NAV, isNavActive } from "@/components/nav";
import { useSite } from "@/components/providers/SiteProvider";
import { nextCronOccurrence } from "@/lib/cron-next";
import {
  explorerUrl,
  fmtSolHuman,
  fmtSolNum,
  SOL_BALANCE_DIGITS,
  timeAgo,
} from "@/lib/format";
// Chain-aware display unit ("SOL" on Solana, "ETH" on Robinhood Chain) and the
// launchpad whose creator fees fund the pool ("pump.fun" on Solana, "pons" on
// Robinhood Chain). Both live in `@/lib/chain/network` so this page, the flow
// chart and the how-it-works copy cannot disagree about where the money comes
// from.
import { FEE_SOURCE_LABEL, NATIVE_SYMBOL } from "@/lib/chain/network";

/* ──────────────────────────────────────────────────────────────────────────
   Live data. The homepage fetches /api/status (current prize pool, eligible
   count, latest round, min-eligible threshold, lottery cron) and /api/rounds
   (round history for totals + the drand chain metadata) on mount and derives
   every displayed number from those responses — no hardcoded stats. The token
   ticker comes from the one admin setting via `useSite()`.
   ────────────────────────────────────────────────────────────────────────── */

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

/** Public economics of the NEXT round, computed server-side by /api/status. */
type PrizeInfo = {
  winnerCount: number;
  payoutDistribution: number[];
  effectivePoolSol: number;
  firstPrizeSol: number;
  minPrizeSol: number;
  playable: boolean;
};

type StatusResp = {
  configured: boolean;
  network: "mainnet" | "devnet";
  tokenMint: string | null;
  tokenDecimals: number;
  lotteryCron: string;
  holderSyncCron: string;
  prizePoolSol: number;
  prize: PrizeInfo | null;
  eligibleCount: number;
  totalHolders: number;
  minTokenEligibleRaw: string;
  minTokenEligibleHuman: string;
  lastRound: Round | null;
  lastSyncAt: string | null;
  dbError: string | null;
  solanaError: string | null;
};

type Chain = {
  name: string;
  hash: string;
  publicKey: string;
  scheme: string;
  period: number;
  verifyBaseUrl: string;
};

type RoundsResp = {
  network: "mainnet" | "devnet";
  chain: Chain | null;
  rounds: Round[];
  dbError: string | null;
};

/** Slice of /api/creator-fees used by the prize-pool footer. */
type FeesResp = {
  claimableSol: number | null;
  autoEnabled: boolean;
  autoMinSol: number | null;
  lastClaimed: { at: string; amountSol: number; source: string } | null;
  error: string | null;
};

/**
 * The slice of /api/stats the hero needs: all-time completed draws, the SOL
 * that actually left the pool and how many payouts went out. Aggregated
 * server-side over every round, so the numbers stay correct past the
 * paged `/api/rounds` history.
 */
type StatsTotals = {
  draws: number;
  paidSol: number;
  /** Winner rows with `status: "sent"` — one per payout actually broadcast. */
  paidCount: number;
};

/**
 * Human cadence derived from the actual gap between two cron occurrences
 * (`nextCronOccurrence` is UTC-exact). Deriving it from real occurrences
 * instead of parsing the cron string keeps step crons honest — a 15-minute
 * step cron reads "every 15m", never "every 15h" — and it always matches the
 * countdown next to it, regardless of the schedule an admin saved.
 */
function cadenceLabel(intervalMs: number): string {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return "—";
  const mins = Math.round(intervalMs / 60_000);
  if (mins === 60) return "hourly";
  if (mins === 1440) return "daily";
  if (mins % 1440 === 0) return `every ${mins / 1440}d`;
  if (mins % 60 === 0) return `every ${mins / 60}h`;
  return `every ${mins}m`;
}

/**
 * Absolute next-run time in UTC (the cron is interpreted as UTC, see
 * lib/cron-next). Absolute instead of "in 42m" so it adds information the big
 * countdown doesn't already show. Long cadences get a date prefix.
 */
function nextRunClock(date: Date | null, withDate = false): string {
  if (!date) return "—";
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const clock = `${hh}:${mm} UTC`;
  if (!withDate) return clock;
  const day = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `${day}, ${clock}`;
}

/** Compact live countdown from ms — "MM:SS" or "H:MM:SS" once an hour+. */
function fmtCountdown(ms: number): string {
  if (ms <= 0) return "due now";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** Podium tint as a struck-metal gradient for the prize-split medals — a flat
 *  100-level chip reads as a label, a gradient with a darker edge reads as a
 *  coin. Fixed light-theme values like the gold/silver/bronze chips in
 *  `DrawsList` (gold is gold in both themes). */
const rankMedal = (rank: number): string => {
  switch (rank) {
    case 1:
      return "bg-linear-to-br from-amber-200 via-amber-300 to-amber-500 text-amber-950 shadow-sm shadow-amber-500/40";
    case 2:
      return "bg-linear-to-br from-slate-100 via-slate-300 to-slate-400 text-slate-800 shadow-sm shadow-slate-500/30";
    case 3:
      // Exactly the tint the flow's winner-3 bubble uses
      // (`bg-orange-100 text-orange-900 ring-orange-200`): a soft bronze, not a
      // gradient. The earlier deep copper (700→900) read as red, and the first
      // version (200→500) competed with gold — flat + pale keeps third place
      // clearly below the two bright medals.
      return "bg-orange-100 text-orange-900 shadow-sm";
    default:
      return "bg-default text-muted";
  }
};

/** Matching fill for the split bars. Mid tones stay visible against the light
 *  track in both themes, unlike the 100-level chip fills; the lighter end of
 *  each gradient sits on the right so the bar looks lit from the tip. */
const rankBar = (rank: number): string => {
  switch (rank) {
    case 1:
      return "bg-linear-to-r from-amber-500 via-amber-400 to-amber-300";
    case 2:
      return "bg-linear-to-r from-slate-500 via-slate-400 to-slate-300";
    case 3:
      // Same family as the flow's winner-3 bubble (bg-orange-100 / ring
      // orange-200): flat `orange-200`, one step stronger than the medal so the
      // fill still separates from the track. No gradient — third place should
      // recede behind gold and silver, not shimmer.
      return "bg-orange-200";
    default:
      return "bg-accent";
  }
};

/**
 * Contract address strip under the hero card. The token mark comes from the
 * uploaded favicon (Admin → SEO, versioned URL) with `/logo.svg` as the
 * fallback, the mint itself is set in a real monospace stack (the project's
 * `font-mono` is an inert alias of Geist Sans since the mono cut was removed, so
 * this is a deliberate one-off for a code value), and the row copies on click
 * with an inline "Copied" confirmation plus an explorer arrow.
 */
function ContractAddress({
  address,
  net,
  loading,
}: {
  address: string | null;
  net: "mainnet" | "devnet";
  loading: boolean;
}) {
  const { faviconUrl } = useSite();
  const [copied, setCopied] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(id);
  }, [copied]);

  /** The address is a code value: slot it into a mono stack instead of Geist. */
  const codeStyle: React.CSSProperties = {
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    letterSpacing: "0.01em",
  };

  if (loading) {
    // Reserve the row's exact height while /api/status is in flight, so the
    // strip below doesn't jump when the address lands.
    return (
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-(--border) bg-surface px-2.5 py-1.5">
        <Skeleton className="size-4 rounded-[4px]" />
        <Skeleton className="h-4 flex-1" />
      </div>
    );
  }

  if (!address) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      /* clipboard blocked (insecure context) — the address stays selectable */
    }
  };

  return (
    <div className="mt-3 flex items-center gap-2 rounded-lg border border-(--border) bg-surface px-2.5 py-1.5">
      {logoFailed ? (
        <span
          aria-hidden="true"
          className="grid size-4 shrink-0 place-items-center rounded-[4px] bg-accent/10 text-[8px] font-semibold text-accent"
        >
          D
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={faviconUrl || "/logo.svg"}
          alt=""
          aria-hidden="true"
          onError={() => setLogoFailed(true)}
          className="size-4 shrink-0 rounded-[4px] object-contain"
        />
      )}
      <button
        type="button"
        onClick={copy}
        title={`${address} — click to copy`}
        className="group flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-default/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span
          className="min-w-0 truncate rounded-md bg-default/60 px-2 py-1 text-[11px] leading-none text-foreground"
          style={codeStyle}
        >
          {address}
        </span>
        <span
          aria-live="polite"
          className={`shrink-0 text-[10px] uppercase tracking-wider ${
            copied ? "text-success" : "text-muted group-hover:text-foreground"
          }`}
        >
          {copied ? "Copied" : "Copy"}
        </span>
      </button>
      <a
        href={explorerUrl(address, "address", net)}
        target="_blank"
        rel="noreferrer"
        aria-label="Open the token on Solscan"
        title="Open on Solscan"
        className="-mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-default/40 hover:text-foreground"
      >
        <Icon name="arrow-up-right" className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}

/** 1 → "1st", 2 → "2nd", 3 → "3rd", 11 → "11th". */
const ordinal = (n: number): string => {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
};

/**
 * Decorative art for the prize-pool card — a coin with the SOL mark plus a few
 * sparkles, drawn inline so it needs no asset request and tints itself from
 * the accent token (`currentColor`), which keeps light and dark in sync.
 */
/** Drop the PNG at `public/prizepool_image.png` — no import, no build step. */
const PRIZE_POOL_IMAGE = "/prizepool_image.png";

/**
 * Prize-pool art: the uploaded `prizepool_image.png` when it exists, otherwise
 * the built-in coin SVG. Same fallback trick as `BrandMark` (plain <img> +
 * onError), so a not-yet-uploaded file never shows a broken image and the tile
 * keeps its 96 px box either way. Decorative — the tile labels itself.
 */
function PrizePoolArt({ className = "" }: { className?: string }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  // A cached image can finish before hydration, in which case `onLoad` never
  // fires — check `complete` once on mount so the skeleton can't get stuck.
  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth > 0) setLoaded(true);
  }, []);

  if (failed) return <PoolArt className={className} />;
  return (
    <>
      {/* Skeleton until the PNG paints, then a 300 ms cross-fade into the art —
          same loading language as the numbers beside it. */}
      {!loaded ? (
        <Skeleton className="absolute inset-0 rounded-full" aria-hidden="true" />
      ) : null}
      <img
        ref={imgRef}
        src={PRIZE_POOL_IMAGE}
        alt=""
        aria-hidden="true"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={`pool-coin-float shrink-0 object-contain transition-opacity duration-300 motion-reduce:transition-none ${
          loaded ? "opacity-85" : "opacity-0"
        } ${className}`}
      />
    </>
  );
}

function PoolArt({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      className={`pool-coin-float text-accent ${className}`}
      aria-hidden="true"
    >
      {/* soft halo behind the coin */}
      <circle cx="60" cy="60" r="46" fill="currentColor" opacity="0.06" />
      <circle cx="60" cy="60" r="38" stroke="currentColor" strokeWidth="2" opacity="0.35" />
      <circle
        cx="60"
        cy="60"
        r="30"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.2"
        strokeDasharray="3 6"
      />
      {/* three slanted bars — reads as the SOL mark without the wordmark */}
      <g fill="currentColor" opacity="0.7">
        <path d="M41 45h29l-5 5H36z" />
        <path d="M47 55h29l-5 5H42z" />
        <path d="M41 65h29l-5 5H36z" />
      </g>
      {/* sparkles */}
      <path
        d="M99 20l1.9 5.1L106 27l-5.1 1.9L99 34l-1.9-5.1L92 27l5.1-1.9z"
        fill="currentColor"
        opacity="0.55"
      />
      <circle cx="19" cy="34" r="2" fill="currentColor" opacity="0.4" />
      <circle cx="104" cy="80" r="1.6" fill="currentColor" opacity="0.35" />
      <circle cx="26" cy="96" r="1.6" fill="currentColor" opacity="0.3" />
    </svg>
  );
}

export default function Home() {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  const { brandName, tokenName, social } = useSite();
  // Sidebar social links are admin-editable (Admin → SEO); empty = hidden.
  const socialLinks = INFORMATION.map((item) => ({
    ...item,
    href:
      item.icon === "x"
        ? social.x
        : item.icon === "telegram"
          ? social.telegram
          : "",
  })).filter((item) => item.href.trim().length > 0);

  // Mobile drawer: lock page scroll while it is open and let Escape close it,
  // so a thumb drag on the panel never scrolls the page underneath. Resizing up
  // to desktop closes it, otherwise the page would stay scroll-locked after the
  // sidebar turns back into a permanent column.
  useEffect(() => {
    if (!mobileOpen) return;
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onResize = () => {
      if (desktop.matches) setMobileOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    desktop.addEventListener("change", onResize);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      desktop.removeEventListener("change", onResize);
      window.removeEventListener("keydown", onKey);
    };
  }, [mobileOpen]);

  // Live data: /api/status (current prize pool, eligible count, latest round,
  // min-eligible threshold, lottery cron) + /api/rounds (history + drand chain).
  const [status, setStatus] = useState<StatusResp | null>(null);
  const [rounds, setRounds] = useState<RoundsResp | null>(null);
  // Hero proof numbers (all-time) + a loaded flag so a failed fetch can settle
  // on an em dash instead of a skeleton that never resolves.
  const [stats, setStats] = useState<StatsTotals | null>(null);
  const [statsLoaded, setStatsLoaded] = useState(false);
  // Creator-fee pot (claimable on the launchpad + last sweep) for the pool tile.
  const [fees, setFees] = useState<FeesResp | null>(null);
  const [loading, setLoading] = useState(true);
  // 1s ticker so the "next draw" countdown in the hero updates live.
  const [now, setNow] = useState(() => Date.now());

  // One-time fetch for round history + drand chain metadata (rarely changes).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/rounds?status=completed&limit=5", { cache: "no-store" }).then((x) => x.json());
        if (cancelled) return;
        setRounds(r as RoundsResp);
      } catch {
        /* leave null — UI shows placeholders */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Hero proof numbers — all-time draws + SOL paid. /api/stats already
  // aggregates every round (and is cached 30 s server-side), so this is one
  // extra request on load rather than folding totals into the 5 s status poll;
  // the numbers only move when a draw settles.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/stats", { cache: "no-store" }).then((x) => x.json());
        if (cancelled) return;
        setStats((r?.totals as StatsTotals | null) ?? null);
      } catch {
        /* leave null — the hero stats fall back to an em dash */
      } finally {
        if (!cancelled) setStatsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Creator-fee pot — separate endpoint because building it costs a pumpdev.io
  // round-trip (cached 60 s server-side). Failure leaves nulls, so the tile shows
  // an em dash instead of a fake zero.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/creator-fees", { cache: "no-store" }).then((x) =>
          x.json()
        );
        if (!cancelled) setFees(r as FeesResp);
      } catch {
        /* leave null — the footer falls back to an em dash */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Polling fetch for live status — mirrors the old /live page's 5-second
  // refresh so the homepage stays live (prize pool, eligible count, latest round).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const s = await fetch("/api/status", { cache: "no-store" }).then((x) => x.json());
        if (cancelled) return;
        setStatus(s as StatusResp);
      } catch {
        /* leave null — UI shows placeholders */
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(poll, 5000);
        }
      }
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  // Ticking clock — drives the hero countdown once status (lottery cron) loads.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Derived display values (safe defaults while loading).
  const network = status?.network ?? "mainnet";
  const lastRound = status?.lastRound ?? rounds?.rounds?.[0] ?? null;
  const chain = rounds?.chain ?? null;
  const eligibleHolders = status?.eligibleCount ?? 0;
  const totalHolders = status?.totalHolders ?? 0;
  // Share of all holders that clear the threshold — drives the eligible card bar.
  const eligibleShare = totalHolders > 0 ? Math.min(100, (eligibleHolders / totalHolders) * 100) : 0;
  // The five newest *completed* draws, fetched directly from the API
  // (`status=completed&limit=5`) instead of filtering a window: with a busy
  // skip history, "5 from the last 50" could return one or none. "/draws" stays
  // the full, server-paginated archive.
  const completedRounds = (rounds?.rounds ?? []).filter(
    (r) => r.status === "completed"
  );
  const rawPoolSol = status?.prizePoolSol ?? lastRound?.prizePoolSol ?? 0;
  const prize = status?.prize ?? null;
  // What will actually be paid this round (cap applied, fee deducted). Equal to
  // the raw balance unless MAX_PRIZE_SOL is set, so no surprise for default setups.
  const prizePoolSol = prize?.effectivePoolSol ?? rawPoolSol;
  const minEligibleHuman = status?.minTokenEligibleHuman ?? "—";
  // Prose reads from the same value as the badge, so changing WINNER_COUNT in
  // settings can't leave the copy claiming a different number of winners.
  const winnerCount = prize?.winnerCount ?? 3;
  // Net-of-fee pot behind the split. /api/status already deducted the platform
  // fee from `firstPrizeSol`, so dividing by rank 1's share recovers the
  // distributable pool without re-deriving PLATFORM_FEE_BPS in the browser.
  const splitPoolSol =
    prize && (prize.payoutDistribution[0] ?? 0) > 0
      ? prize.firstPrizeSol / prize.payoutDistribution[0]
      : 0;
  // Why the split chip reads lower than the big pool number: the tile shows the
  // wallet balance (gross, cap applied), the chip shows what winners actually
  // get once PLATFORM_FEE_BPS is taken. /api/status doesn't expose the bps, so
  // derive it from the two amounts it does send and round it for prose.
  const feePct =
    prizePoolSol > 0 && splitPoolSol > 0 && splitPoolSol < prizePoolSol
      ? Math.round((1 - splitPoolSol / prizePoolSol) * 100)
      : 0;
  // Podium only — WINNER_COUNT is unbounded, so ranks 4+ fold into one note.
  const splitRows = (prize?.payoutDistribution ?? [])
    .slice(0, 3)
    .map((share, i) => ({
      rank: i + 1,
      share,
      sol: splitPoolSol * share,
    }));
  const extraRanks = Math.max(0, (prize?.payoutDistribution.length ?? 0) - 3);
  const extraShare = (prize?.payoutDistribution ?? [])
    .slice(3)
    .reduce((sum, share) => sum + share, 0);
  // Live-draw banner: a round is mid-execution, or we count down to the next one.
  const drawing = lastRound?.status === "drawing";
  const nextDraw = useMemo(
    () => (status ? nextCronOccurrence(status.lotteryCron, new Date(now)) : null),
    [status, now],
  );
  const countdown = nextDraw ? nextDraw.getTime() - now : null;
  // Ring progress: fraction of the current draw interval already elapsed (0→100).
  const nextNext = useMemo(
    () => (status && nextDraw ? nextCronOccurrence(status.lotteryCron, new Date(nextDraw.getTime() + 1000)) : null),
    [status, nextDraw],
  );
  const intervalMs = nextDraw && nextNext ? nextNext.getTime() - nextDraw.getTime() : 0;
  const prevDrawTs = intervalMs > 0 && nextDraw ? nextDraw.getTime() - intervalMs : 0;
  const progress =
    intervalMs > 0 && !drawing
      ? Math.min(100, Math.max(0, ((now - prevDrawTs) / intervalMs) * 100))
      : 0;
  // Cadence derived from the two nearest cron occurrences, so the tile footer
  // can never contradict the countdown above it (and step crons stay honest).
  const cadence = cadenceLabel(intervalMs);
  const longCadence = intervalMs >= 86_400_000;
  // Chip label for the countdown tile: the schedule itself. "Scheduled" only
  // restated that a draw exists, while the cadence is the one fact the tile
  // didn't already show (it used to sit in a tooltip on the footer clock).
  const cadenceChip =
    cadence === "—" ? "Scheduled" : cadence.charAt(0).toUpperCase() + cadence.slice(1);
  // How often the holder snapshot itself refreshes — explains why the eligible
  // bar is a gauge (a share of holders) and not a ticking countdown.
  const holderSyncCadence = useMemo(() => {
    if (!status?.holderSyncCron) return "—";
    // Anchored at the epoch so the answer is stable across renders (no ceil to
    // "the next tick"), which keeps SSR and the client in agreement.
    const a = nextCronOccurrence(status.holderSyncCron, new Date(0));
    const b = a
      ? nextCronOccurrence(status.holderSyncCron, new Date(a.getTime() + 1000))
      : null;
    return a && b ? cadenceLabel(b.getTime() - a.getTime()) : "—";
  }, [status?.holderSyncCron]);

  // Active state comes from `isNavActive` in nav.ts — the same helper AppShell
  // uses, so `/rounds/37` keeps "Draws" lit here too.
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Mobile backdrop — always mounted so it fades out instead of popping. */}
      <div
        className={`fixed inset-0 z-30 bg-black/55 transition-opacity duration-300 ease-out motion-reduce:transition-none lg:hidden ${
          mobileOpen ? "opacity-100 backdrop-blur-[2px]" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setMobileOpen(false)}
        aria-hidden="true"
      />

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-(--border) bg-surface shadow-2xl shadow-black/40 transition-[width,translate] duration-300 ease-[cubic-bezier(0.22,0.61,0.36,1)] will-change-[width,translate] motion-reduce:transition-none lg:translate-x-0 lg:shadow-none ${
          collapsed ? "lg:w-[68px]" : ""
        } ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}
        aria-label="Site navigation"
      >
        <div className={`flex h-14 shrink-0 items-center gap-2 border-b border-(--border) px-4 ${collapsed ? "lg:justify-center" : ""}`}>
          <BrandMark brandName={brandName} />
          {!collapsed && (
            <span className="min-w-0 truncate font-bold tracking-tight">{brandName}</span>
          )}
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
            className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-default/40 hover:text-foreground lg:hidden"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto overscroll-contain p-3">
          {NAV.map((item, index) => {
            const active = isNavActive(pathname, item.href);
            const cls = `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition w-full text-left ${collapsed ? "lg:justify-center lg:px-0" : ""} ${active ? "bg-default font-medium text-foreground" : "font-medium text-muted hover:bg-default/40 hover:text-foreground"} ${mobileOpen ? "drawer-item-in" : ""}`;
            // Same stagger the AppShell drawer uses: 70ms base, 22ms per row,
            // capped at 190ms so the links land with the panel slide.
            const itemStyle = { animationDelay: `${Math.min(70 + index * 22, 190)}ms` };
            const inner = (
              <>
                <Icon name={item.icon} className="shrink-0 text-(--nav-icon)" />
                <span className={collapsed ? "lg:hidden" : ""}>{item.label}</span>
              </>
            );
            // `next/link` (not a plain <a>) so the home sidebar navigates
            // client-side, exactly like AppShell — a plain anchor forced a full
            // reload from "/" but not from any other page.
            return (
              <Link
                key={item.label}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                title={collapsed ? item.label : undefined}
                aria-current={active ? "page" : undefined}
                className={cls}
                style={itemStyle}
              >
                {inner}
              </Link>
            );
          })}
          {/* Social media — URLs come from Admin → SEO; an unset one is hidden
              rather than linking to x.com / t.me's front page. */}
          {socialLinks.length > 0 && (
            <div
              className={`mt-auto flex flex-col gap-1 pt-2 ${mobileOpen ? "drawer-item-in" : ""}`}
              style={{ animationDelay: `${Math.min(70 + NAV.length * 22, 190)}ms` }}
            >
              <span
                className={`px-3 pb-1 text-xs font-normal uppercase tracking-wider text-muted ${collapsed ? "lg:hidden" : ""}`}
              >
                Social media
              </span>
              {socialLinks.map((item) => (
                <a
                  key={item.label}
                  href={item.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={() => setMobileOpen(false)}
                  title={collapsed ? item.label : undefined}
                  className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted transition hover:bg-default/40 hover:text-foreground ${collapsed ? "lg:justify-center lg:px-0" : ""}`}
                >
                  <Icon name={item.icon} className="shrink-0 text-(--nav-icon)" />
                  <span className={collapsed ? "lg:hidden" : ""}>{item.label}</span>
                  <Icon
                    name="arrow-up-right"
                    className={`ml-auto h-3.5 w-3.5 opacity-50 ${collapsed ? "lg:hidden" : ""}`}
                  />
                </a>
              ))}
            </div>
          )}
        </nav>
        <div className="hidden shrink-0 border-t border-(--border) p-3 lg:block">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="flex items-center gap-2 text-xs text-muted transition hover:text-foreground"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <Icon name={collapsed ? "expand" : "collapse"} />
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div className={`transition-[padding] duration-200 ${collapsed ? "lg:pl-[68px]" : "lg:pl-60"}`}>
        <header className="sticky top-0 z-20 border-b border-(--border) bg-surface/80 backdrop-blur">
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="flex h-10 w-10 items-center justify-center rounded-md text-muted transition hover:bg-default/40 hover:text-foreground lg:hidden"
              aria-label="Open menu"
            >
              <Icon name="menu" />
            </button>
            <div className="min-w-0 flex-1">
              {/* 13px/18px: one notch below the text-sm default so the trail sits quieter than the page title. */}
              <Breadcrumbs isDisabled className="[&_.breadcrumbs\_\_link]:text-[13px]! [&_.breadcrumbs\_\_link]:leading-[18px]!">
                <Breadcrumbs.Item href="/">{brandName}</Breadcrumbs.Item>
                <Breadcrumbs.Item>Home</Breadcrumbs.Item>
              </Breadcrumbs>
            </div>
            <div className="ml-auto flex items-center gap-4">
              <ThemeToggle />
            </div>
          </div>
        </header>

        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-10">
        {/* Hero — pitch + all-time proof numbers + CTAs on one surface. Only
            lifetime totals live here (draws run, SOL paid); the live per-round
            numbers stay in the tile strip below, so the fold reads
            headline → proof → status tiles → draws. */}
        <section className="pt-5 pb-5 sm:pt-10 sm:pb-6">
          <div className="relative overflow-hidden rounded-lg border border-(--border) bg-surface">
            {/* Soft accent halo — token-based, so it adapts to light/dark. */}
            <div
              className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-accent/10 blur-3xl"
              aria-hidden="true"
            />
            <div className="relative flex flex-col gap-5 p-4 sm:p-6">
              <div className="flex flex-col gap-2">
                <h1 className="max-w-3xl text-balance text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
                  Hold {tokenName}. <span className="text-accent">Win the pool.</span>
                </h1>
                <Typography type="body-sm" color="muted" className="max-w-2xl text-pretty">
                  100% of creator fees go into the pool. Meet the minimum hold and you’re in. Each
                  round, {winnerCount} holders are drawn at random and paid in{" "}
                  {NATIVE_SYMBOL}.
                </Typography>
              </div>

              {/* Proof numbers above the CTAs — has it run, did payouts go out,
                  how much SOL actually left the pool. Sourced from /api/stats
                  totals, in that order so the story reads left to right. */}
              <dl className="flex flex-wrap items-stretch gap-y-4">
                <div className="flex flex-col gap-1 pr-2.5 sm:pr-5">
                  <dt className="text-[11px] leading-4 tracking-tight text-muted sm:text-xs sm:tracking-normal">
                    Draws completed
                  </dt>
                  <dd className="font-mono text-xl font-semibold leading-none tracking-tight tabular-nums">
                    {!statsLoaded ? (
                      <Skeleton className="h-5 w-12" />
                    ) : stats ? (
                      <CountUp value={stats.draws} />
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
                <div className="flex flex-col gap-1 border-l border-(--border) pl-2.5 pr-2.5 sm:pl-5 sm:pr-5">
                  <dt className="text-[11px] leading-4 tracking-tight text-muted sm:text-xs sm:tracking-normal">
                    Winners paid
                  </dt>
                  <dd className="font-mono text-xl font-semibold leading-none tracking-tight tabular-nums">
                    {!statsLoaded ? (
                      <Skeleton className="h-5 w-12" />
                    ) : stats ? (
                      <CountUp value={stats.paidCount} />
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
                {/* All three stay on one line even at 360 px: the labels drop to
                    11 px + tracking-tight below sm (12 px is what forces the
                    third cell to wrap) so the vertical rules hold in both. */}
                <div className="flex flex-col gap-1 border-l border-(--border) pl-2.5 sm:pl-5">
                  <dt className="text-[11px] leading-4 tracking-tight text-muted sm:text-xs sm:tracking-normal">
                    Paid out to holders
                  </dt>
                  <dd className="flex items-baseline gap-1.5 font-mono text-xl font-semibold leading-none tracking-tight tabular-nums">
                    {!statsLoaded ? (
                      <Skeleton className="h-5 w-20" />
                    ) : stats ? (
                      <>
                        {/* Same 4-dp SOL precision as the pool tile, so a
                            small running total never collapses to "<0.01". */}
                        <CountUp value={stats.paidSol} format={(n) => fmtSolNum(n)} />
                        <span className="text-xs font-normal text-muted">
                          {NATIVE_SYMBOL}
                        </span>
                      </>
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
              </dl>

              {/* CTAs — the pair does the hero's conversion work, so they get
                  more than a colour swap: 36 px tap targets at label size
                  (12 px, medium — not semibold, so the pair reads as chrome
                  next to the hero's numbers), a light sweep and a
                  right-stepping arrow on the primary, and a filled secondary so
                  it doesn't dissolve into the hero surface. Both ride the
                  `translate` property (what Tailwind v4 compiles `translate-*`
                  to), lift 1 px on hover, and have an explicit focus outline for
                  keyboard users. The primary one reads the **button palette**
                  (`--button*`, Admin → Palette → Buttons) so its fill, hover,
                  press and text color are editable without a code change; only
                  the secondary ghost button stays on the neutral tokens. Inline
                  at every width — the pair sits side by side on phones too
                  (full-width stacking made the hero read like a form), and
                  `flex-wrap` only kicks in if the trailing drand.sh link runs
                  out of room. */}
              <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
                <Link
                  href="/draws"
                  className="group relative inline-flex h-9 items-center justify-center gap-1.5 overflow-hidden rounded-lg bg-(--button) px-3.5 text-xs font-medium text-(--button-foreground) shadow-sm transition-[background-color,box-shadow,translate] duration-200 hover:-translate-y-px hover:bg-(--button-hover) hover:shadow-md hover:shadow-(--button)/25 active:translate-y-0 active:bg-(--button-pressed) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--button) motion-reduce:transition-none motion-reduce:hover:translate-y-0 sm:px-4"
                >
                  {/* One-pass sheen — fades in from the left on hover and exits
                      right, clipped by the button's overflow-hidden. Token-based
                      (follows the button text color, which is white by default
                      in both themes). */}
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 -translate-x-full bg-linear-to-r from-transparent via-(--button-foreground)/25 to-transparent transition-[translate] duration-700 ease-out group-hover:translate-x-full motion-reduce:hidden"
                  />
                  <span className="relative">View draws</span>
                  <Icon
                    name="arrow-right"
                    className="relative h-3 w-3 transition-[translate] duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none"
                  />
                </Link>
                <a
                  href="#how"
                  className="group inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-(--border) bg-default/40 px-3 text-xs font-medium text-foreground transition-[background-color,border-color,translate] duration-200 hover:-translate-y-px hover:border-accent/40 hover:bg-default/70 active:translate-y-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none motion-reduce:hover:translate-y-0 sm:px-3.5"
                >
                  <Icon
                    name="how"
                    className="h-3 w-3 text-muted transition-colors group-hover:text-accent"
                  />
                  How draws work
                </a>
                {/* Source of the randomness, not a third CTA: plain muted text
                    at label size, so it trails the buttons without competing. */}
                <ExternalLink href="https://drand.sh" className="self-center text-xs sm:self-auto">
                  drand.sh
                </ExternalLink>
              </div>
            </div>
          </div>

          {/* Contract address — one quiet row directly under the hero card.
              Caught by the eye (accent CA tag, mono address) but it stays a
              single line: copy on click, explorer arrow on the right. Hidden
              entirely when no mint is configured. */}
          <ContractAddress
            address={status?.tokenMint ?? null}
            net={network}
            loading={loading}
          />
        </section>

        {/* Live strip — the three numbers that used to sit inside the hero card
            now get their own promo-style tiles (bc.game daily-contest layout):
            prize pool (widest, with art + animated sheen), then the prize split
            (podium bars + eligibility footnote) in the middle, then the
            next-draw countdown on the right. Kept directly under the hero so the
            fold still answers "what can I win / how is it split / when" without
            scrolling — split in the centre because the middle tile is the one
            that gets read at a glance, countdown last before the fold edge. */}
        <section id="draw" className="pb-6">
          <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-[1.6fr_1fr_1fr]">
            {/* Prize pool — the wide tile */}
            <div className="relative overflow-hidden rounded-lg border border-(--border) bg-surface p-4 sm:col-span-2 sm:p-6 lg:col-span-1">
              <div className="pool-sheen pointer-events-none absolute inset-0" aria-hidden="true" />
              <div className="relative flex items-center justify-between gap-4 sm:items-start">
                <div className="flex min-w-0 flex-col gap-2">
                  {/* Status chip removed on request ("Ready / Below minimum
                      prize / Awaiting funds"): it restated what the number and
                      the countdown already implied and was the loudest element
                      in the tile. The one fact worth keeping — this round gets
                      skipped until the pool clears the minimum — rides as a
                      tooltip on the amount instead. */}
                  <span className="text-sm text-muted">Prize pool</span>
                  <div
                    className="flex items-baseline gap-2"
                    title={
                      prize && prizePoolSol > 0 && !prize.playable
                        ? `Below the ${fmtSolHuman(prize.minPrizeSol)} minimum — the round is skipped until the pool grows.`
                        : undefined
                    }
                  >
                    {loading ? (
                      <>
                        <Skeleton className="h-10 w-40 sm:h-12 sm:w-52" />
                        <Skeleton className="h-3.5 w-8" />
                      </>
                    ) : (
                      <>
                        <span className="font-mono text-4xl font-semibold leading-none tracking-tight tabular-nums sm:text-5xl">
                          {/* Counts up from 0 when the first poll lands; later
                              polls only animate the (small) delta. */}
                          <CountUp value={prizePoolSol} format={(n) => fmtSolNum(n)} />
                        </span>
                        <span className="font-mono text-sm text-muted">
                          {NATIVE_SYMBOL}
                        </span>
                      </>
                    )}
                  </div>
                  <p className="max-w-sm text-sm text-muted">
                    Funded by creator fees and paid in {NATIVE_SYMBOL} to{" "}
                    {winnerCount} holders drawn at random.
                  </p>
                </div>
                {/* Phones: centred against the copy and inset from the card edge.
                    The halo + lowered opacity + soft drop shadow make the upload
                    sit *in* the card instead of looking pasted on top of it
                    (both survive the SVG fallback too). */}
                <span className="relative mr-2 flex h-14 w-14 shrink-0 items-center justify-center sm:mr-0 sm:h-24 sm:w-24">
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute -inset-3 rounded-full bg-accent/20 blur-xl"
                  />
                  <PrizePoolArt className="relative h-full w-full drop-shadow-[0_4px_12px_rgba(0,0,0,0.22)]" />
                </span>
              </div>
              {/* Creator-fee pot: how much is still sitting on the launchpad and when
                  the last sweep landed. Replaces the Min hold / Updated pair —
                  "100% of creator fees go to the pool" is only convincing if the
                  money can be seen moving. Min hold still lives in the split
                  tile's eligibility tooltip and on /eligibility. */}
              <div className="relative mt-5 grid gap-3 border-t border-(--border) pt-4">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs text-muted">
                    Unclaimed fees on {FEE_SOURCE_LABEL}
                  </span>
                  {loading ? (
                    <Skeleton className="h-4 w-20" />
                  ) : (
                    <span
                      className="flex flex-wrap items-baseline gap-x-1.5"
                      title={
                        fees?.autoEnabled
                          ? `Creator fees still on ${FEE_SOURCE_LABEL} — swept into the prize pool automatically once the pot clears ${fmtSolHuman(fees.autoMinSol ?? 0)} ${NATIVE_SYMBOL}.`
                          : `Creator fees still on ${FEE_SOURCE_LABEL} — auto-claim is off, they stay there until claimed.`
                      }
                    >
                      <span className="font-mono text-sm font-semibold tabular-nums">
                        {fees?.claimableSol != null
                          ? fmtSolNum(fees.claimableSol, SOL_BALANCE_DIGITS)
                          : "—"}
                      </span>
                      <span className="text-xs text-muted">{NATIVE_SYMBOL}</span>
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Prize split — the tile answers "what does each place pay?"
                instead of restating the holder count: one single-line row per
                rank, with the ordinal (`1st`) inside a struck-metal medal that
                straddles the track's left cap, and the payout + share in small
                type over the bar's right end (rank share 50 / 30 / 20 by
                default). Bars carry the podium gradient and the gold one gets a
                slow light sweep (`.split-shine`), so the hierarchy is visible
                before any number is read. Ranks 4+ collapse into a note because
                WINNER_COUNT is unbounded. The eligibility count moved to the
                footer so "am I in" still lands without a scroll. */}
            <div className="relative flex flex-col overflow-hidden rounded-lg border border-(--border) bg-surface p-4 sm:p-6">
              {/* Quiet echo of the pool tile's sheen, so the two cards in the
                  strip read as one family — dimmer, because this tile's job is
                  the gold/silver/bronze bars, not the amount. Drawn first and
                  every sibling is `relative`, so it never sits over the text. */}
              <div
                className="pointer-events-none absolute inset-0 opacity-50"
                aria-hidden="true"
              >
                {/* Wrapper carries the dimming: `.pool-sheen` animates its own
                    opacity (0.65 → 0.95), so `opacity-50` on it would be
                    overridden by the keyframes. */}
                <div className="pool-sheen h-full w-full" />
              </div>
              <div className="relative flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-muted">Prize split</span>
                {loading ? (
                  <Skeleton className="h-[22px] w-20 rounded-full" />
                ) : (
                  <Tooltip delay={150}>
                    {/* The chip is only a hover surface — it has no action, so it
                        stays out of the tab order; the same numbers are in the
                        rows below for anyone using the keyboard. */}
                    <Tooltip.Trigger
                      role="presentation"
                      tabIndex={-1}
                      className="flex shrink-0 cursor-default"
                    >
                      <Chip
                        size="sm"
                        variant="tertiary"
                        color="default"
                        className="border border-(--border) text-muted! tabular-nums"
                      >
                        {splitPoolSol > 0 ? `≈ ${fmtSolHuman(splitPoolSol)}` : "Estimate"}
                      </Chip>
                    </Tooltip.Trigger>
                    <Tooltip.Content className="max-w-[16rem] text-xs leading-snug">
                      {splitPoolSol > 0
                        ? `The pool tile shows the full ${fmtSolHuman(prizePoolSol)} ${NATIVE_SYMBOL} balance; ${feePct > 0 ? `the ${feePct}% platform fee is taken first` : "the platform fee is taken first"}, so ≈ ${fmtSolHuman(splitPoolSol)} ${NATIVE_SYMBOL} is what the winners actually split.`
                        : "The pool tile shows the full wallet balance. The platform fee is taken first, then the rest is split by rank."}
                    </Tooltip.Content>
                  </Tooltip>
                )}
              </div>
              <div className="relative mt-3.5 flex flex-col gap-2">
                {loading ? (
                  <>
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="flex h-10 items-center gap-2">
                        <Skeleton className="size-7 shrink-0 rounded-full" />
                        <Skeleton className="h-3 flex-1 rounded-full" />
                        <Skeleton className="h-2 w-8 rounded" />
                      </div>
                    ))}
                  </>
                ) : splitRows.length === 0 ? (
                  <p className="text-xs text-muted">
                    Prize split unavailable right now.
                  </p>
                ) : (
                  splitRows.map((row) => {
                    const pct = Math.round(row.share * 100);
                    return (
                      <ProgressBar
                        key={row.rank}
                        value={pct}
                        size="lg"
                        aria-label={`${ordinal(row.rank)} prize share`}
                        valueLabel={`${pct}% of the net pool`}
                        className="relative flex h-10 items-center gap-2"
                      >
                        {/* The caption is absolutely placed over the right end
                            of the track, at the top of the row: the row is 40px
                            (12px label + a 2px breath + the 12px track centred
                            on the 28px medal), so the payout and the share read
                            at the same `text-xs` size as the eligibility
                            footnote below without adding a line — and in the
                            body font, not mono, so the caption matches the tile
                            instead of looking like a terminal. */}
                        <span
                          className="absolute right-0 top-0 flex items-baseline gap-1.5 leading-none"
                          title={
                            splitPoolSol > 0
                              ? `${pct}% of the net pool · ≈ ${fmtSolHuman(row.sol)} if the draw ran now`
                              : "The pool is empty — only the share is known."
                          }
                        >
                          {splitPoolSol > 0 ? (
                            <span className="text-xs font-medium leading-none tabular-nums">
                              {fmtSolHuman(row.sol)}
                            </span>
                          ) : null}
                          <span
                            className={
                              splitPoolSol > 0
                                ? "text-xs leading-none tabular-nums text-muted"
                                : "text-xs font-medium leading-none tabular-nums"
                            }
                          >
                            {pct}%
                          </span>
                        </span>
                        {/* Ordinal lives inside the podium medal and the track
                            is pulled left by half the medal's width, so the
                            medal caps the bar instead of sitting beside it —
                            the same "attached avatar" trick as the winner stack
                            in RecentDraws. The gradient makes it read as a coin
                            rather than a label. */}
                        <span
                          className={`relative z-10 grid size-7 shrink-0 place-items-center rounded-full text-[10px] font-medium tracking-tight tabular-nums ring-2 ring-surface ${rankMedal(row.rank)}`}
                          aria-hidden="true"
                        >
                          {ordinal(row.rank)}
                        </span>
                        <ProgressBar.Track className="-ml-3.5 flex-1 overflow-hidden rounded-full bg-default/50 shadow-[inset_0_1px_2px_rgba(0,0,0,0.08)]">
                          <ProgressBar.Fill
                            className={`overflow-hidden rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none ${rankBar(row.rank)}${
                              row.rank === 1 ? " split-shine" : ""
                            }`}
                          />
                        </ProgressBar.Track>
                      </ProgressBar>
                    );
                  })
                )}
              </div>
              {!loading && extraRanks > 0 ? (
                <p className="relative mt-2 text-[11px] text-muted">
                  +{extraRanks} more winner{extraRanks === 1 ? "" : "s"} share{" "}
                  {Math.round(extraShare * 100)}% of the pool
                </p>
              ) : null}
              {/* Eligibility shrank to a footnote instead of a headline: the
                  count still answers "am I in", while the tooltip keeps the
                  minimum, the tracked total and the snapshot age that used to
                  live in this tile. */}
              <div className="relative mt-auto flex items-center justify-between gap-2 pt-4 text-xs text-muted">
                {loading ? (
                  <Skeleton className="h-3 w-20" />
                ) : (
                  /* Native `title` → HeroUI tooltip, so the tile's two
                     footnotes match the chip and cadence notes: the facts
                     (minimum, tracked total, snapshot age) live in a styled
                     bubble instead of a browser one. The trigger is a
                     non-focusable `flex min-w-0` wrapper so it doesn't grow
                     the footer's line-box or the tile. */
                  <Tooltip delay={150}>
                    <Tooltip.Trigger
                      role="presentation"
                      tabIndex={-1}
                      className="flex min-w-0 cursor-default"
                    >
                      <span className="truncate tabular-nums">
                        {totalHolders === 0
                          ? "No holders tracked"
                          : `${eligibleHolders.toLocaleString()} eligible`}
                      </span>
                    </Tooltip.Trigger>
                    <Tooltip.Content className="max-w-[16rem] text-xs leading-snug">
                      {[
                        status?.minTokenEligibleHuman
                          ? `Minimum ${minEligibleHuman} ${tokenName} to qualify`
                          : null,
                        totalHolders > 0
                          ? `${Math.round(eligibleShare)}% of ${totalHolders.toLocaleString()} tracked holders qualify`
                          : null,
                        status?.lastSyncAt
                          ? `Snapshot taken ${timeAgo(status.lastSyncAt)}`
                          : null,
                        holderSyncCadence !== "—"
                          ? `refreshed ${holderSyncCadence}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "No holder snapshot yet."}
                    </Tooltip.Content>
                  </Tooltip>
                )}
                <Link
                  href="/eligibility"
                  aria-label="View all wallets"
                  className="-my-1 inline-flex shrink-0 items-center gap-1 py-1 underline transition-colors hover:text-foreground"
                >
                  View all
                  <Icon name="arrow-right" className="h-3.5 w-3.5" />
                </Link>
              </div>
            </div>

            {/* Next draw — countdown + interval progress (flex column so the
                footer lines up across all three tiles). Sits right of the split
                now: the strip reads pool → split → when, and the eye lands on
                the countdown last, next to the fold. */}
            <div className="relative flex flex-col overflow-hidden rounded-lg border border-(--border) bg-surface p-4 sm:p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-muted">
                  Next draw
                </span>
                {loading ? (
                  /* Same footprint as the `sm` chip (22 px tall), so the
                     cadence label doesn't pop in from a placeholder word on the
                     first paint (it used to flash "Scheduled" while /api/status
                     was still in flight). */
                  <Skeleton className="h-[22px] w-20 rounded-full" />
                ) : drawing ? (
                  /* A live draw is the one moment this tile should raise its
                     voice, so the running state keeps the warning tint. */
                  <Chip size="sm" variant="soft" color="warning">
                    In progress
                  </Chip>
                ) : (
                  /* Idle: same quiet outline chip as the prize-split figure —
                     the cadence is reference data, not a call to action. */
                  <Chip
                    size="sm"
                    variant="tertiary"
                    color="default"
                    className="border border-(--border) text-muted! tabular-nums"
                  >
                    {cadenceChip}
                  </Chip>
                )}
              </div>
              <div className="mt-4 flex flex-col gap-1">
                {loading ? (
                  <Skeleton className="h-9 w-28 sm:h-10 sm:w-32" />
                ) : (
                  <span
                    className={`font-mono text-3xl font-semibold leading-none tracking-tight tabular-nums sm:text-4xl ${
                      drawing ? "text-warning" : "text-foreground"
                    }`}
                  >
                    {drawing ? "live" : countdown != null ? fmtCountdown(countdown) : "—"}
                  </span>
                )}
                {loading ? (
                  <Skeleton className="h-3 w-24" />
                ) : (
                  <span className="text-xs text-muted">
                    {drawing
                      ? `Draw #${lastRound?.roundNumber ?? ""} in progress`
                      : "until the next draw"}
                  </span>
                )}
              </div>
              <div className="mt-auto pt-5">
                <ProgressBar
                  aria-label="Time until the next draw"
                  value={drawing ? 100 : progress}
                  maxValue={100}
                  size="sm"
                  color={drawing ? "warning" : "accent"}
                  className="gap-1.5"
                >
                  <ProgressBar.Track className="bg-default/40">
                    <ProgressBar.Fill
                      className={`transition-[width] duration-700 ease-out ${
                        drawing ? "bg-warning" : "bg-accent"
                      }`}
                    />
                  </ProgressBar.Track>
                </ProgressBar>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs text-muted">
                  {loading ? (
                    <Skeleton className="h-3 w-24" />
                  ) : (
                    /* Short by design — the cadence lives in a real HeroUI
                       tooltip (the same pattern as the split chip) instead of
                       a native `title`, so the footer reads like the countdown
                       above it and the note can be styled. */
                    <Tooltip delay={150}>
                      <Tooltip.Trigger
                        role="presentation"
                        tabIndex={-1}
                        className="flex min-w-0 cursor-default"
                      >
                        <span className="truncate">
                          Next{" "}
                          <span className="tabular-nums">
                            {nextRunClock(nextDraw, longCadence)}
                          </span>
                        </span>
                      </Tooltip.Trigger>
                      <Tooltip.Content className="max-w-[16rem] text-xs leading-snug">
                        {`Draws ${cadence} · next ${nextRunClock(nextDraw, longCadence)} — the draw cron runs on UTC.`}
                      </Tooltip.Content>
                    </Tooltip>
                  )}
                  {/* Same quiet link treatment as "open beacon" on /draws:
                      thin, underlined, inherited colour, small arrow. */}
                  <Link
                    href="/draws"
                    aria-label="View all draws"
                    className="-my-1 inline-flex items-center gap-1 py-1 underline transition-colors hover:text-foreground"
                  >
                    View all
                    <Icon name="arrow-right" className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </div>
            </div>

          </div>
        </section>

        {/* Completed rounds — collapsible rows: #N · launchpad → engine → drand → winners */}
        <section className="pb-6 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            {/* Heading and the "View all" link share one row on every width —
                the link used to wrap under the description on phones because
                both sat in the same flex-wrap parent as the copy. */}
            <div className="flex items-center justify-between gap-3">
              <Typography type="h4">Recent draws</Typography>
              <Link
                href="/draws"
                aria-label="View all draws"
                className="-my-1 inline-flex shrink-0 items-center gap-1 py-1 text-sm underline transition-colors hover:text-foreground"
              >
                View all draws
                <Icon name="arrow-right" className="h-3.5 w-3.5" />
              </Link>
            </div>
            {/* Describes the rows below without repeating their numbers: the
                collapsed row already carries #N, the pool, the age and the
                winner avatars, so this line only explains the affordance. */}
            <Typography type="body-sm" color="muted">
              Each row follows one draw from the {FEE_SOURCE_LABEL} creator fee to the wallets
              that got paid. Open one to see the receipts.
            </Typography>
          </div>

          <RecentDraws
            rounds={completedRounds}
            chain={chain}
            network={network}
            loading={loading}
            dbError={rounds?.dbError ?? null}
          />
        </section>

        {/* How it works — animated flow: launchpad → engine → drand → winners */}
        <section id="how" className="pb-12 flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <Typography type="h4">How a draw works</Typography>
            <Typography type="body-sm" color="muted" className="max-w-2xl">
              We snapshot every wallet meeting the minimum hold, draw {winnerCount} winners with a
              drand-seeded shuffle, and pay them in {NATIVE_SYMBOL}. Anyone can re-run the draw in the
              browser to check the result.
            </Typography>
          </div>

          <HowItWorksFlow
            winners={lastRound?.winners ?? []}
            network={network}
            chainName={chain?.name}
            payoutDistribution={prize?.payoutDistribution}
          />

        <div className="mt-4 max-w-2xl">
          <p
            id="flow-disclaimer"
            className="text-sm font-semibold tracking-tight text-foreground"
          >
            Disclaimer
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Not financial advice. {tokenName} is a memecoin with no intrinsic value or
            expectation of financial return. Prizes come only from the creator-fee pool, and
            the animation illustrates how a draw works; it doesn’t show live odds.
          </p>
          <Link
            href="/how-it-works"
            className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-muted underline decoration-(--border) underline-offset-4 transition-colors hover:text-foreground"
          >
            Read the full verification guide
            <Icon name="arrow-right" className="h-3.5 w-3.5" />
          </Link>
        </div>
        </section>
      </div>
      </div>
    </div>
  );
}
