"use client";

import { useId, useState } from "react";
import { ArrowRight, ChevronDown } from "lucide-react";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
  Tooltip,
} from "@heroui/react";
import { DrandBeacon } from "@/components/DrandBeacon";
import { Icon, SkeletonRows } from "@/components/ui";
import { useSite } from "@/components/providers/SiteProvider";
import { explorerUrl, fmtDateTimeUtc, fmtSolHuman, timeAgo } from "@/lib/format";
// Provenance chain artwork/label for the fee-source step: pump.fun on Solana,
// pons on Robinhood Chain — same constants the "How a draw works" chart uses.
import { FEE_SOURCE_LABEL, FEE_SOURCE_LOGO } from "@/lib/chain/network";

/* ──────────────────────────────────────────────────────────────────────────
   Homepage "Recent draws" — collapsible rows, paged 5 at a time.

   Each collapsed row reads left → centre → right:
     1.24 ETH            pons  →  pay  →  drand  →  ①②③      2h ago ⌄
     Draw #13
   The prize pool is the big number on the left with the draw id underneath it,
   the provenance chain (logo → logo → logo → rank circles) sits in the middle,
   the age sits on the right, and the only affordance is a bare chevron — never
   a "Details" label or a bordered button chip that reads like a link. Opening a
   row reveals the same detail the /draws cards carry (pool, wallets, winners,
   beacon), inline; there is deliberately no "Open draw #N" link because the row
   already is the draw. Rows are separate cards with a small gap, not a glued
   list.

   Paging is client-side over the 50-round window /api/rounds already returns:
   five rows per page keeps the section short enough that the hero and "how it
   works" stay reachable, while Prev/Next still lets anyone walk the history
   without leaving the homepage. "/draws" remains the deeper archive.
   ────────────────────────────────────────────────────────────────────────── */

/** Rows per page. Five fits a laptop fold without turning the page into a list. */
const PAGE_SIZE = 5;

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

const shortAddr = (a: string, h = 4, t = 4): string =>
  !a || a.length <= h + t ? a : `${a.slice(0, h)}…${a.slice(-t)}`;
// Chain-aware explorer link: delegates to the chain layer (`explorerUrl`), so
// Solscan becomes the new chain's explorer with no edit here. The local copy
// that hardcoded solscan.io was removed 2026-10-29 (Phase 3).
const explorer = (v: string, kind: "address" | "tx", net: string): string =>
  explorerUrl(v, kind, net === "devnet" ? "devnet" : "mainnet");

const fmtTime = (iso: string | null): string => fmtDateTimeUtc(iso);

/** Podium tint for a winner rank chip — gold #1, silver #2, bronze #3. */
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

/** One brand step in the provenance chain (launchpad → engine → drand). */
function Step({ src, label }: { src: string; label: string }) {
  return (
    <span
      title={label}
      className="grid size-6 shrink-0 place-items-center overflow-hidden rounded-md bg-default ring-1 ring-(--border)"
    >
      {/* Same assets as the "How a draw works" flow; decorative here. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className="size-[18px] object-contain" />
    </span>
  );
}

/**
 * Rank circles for the collapsed row: 1 · 2 · 3, not anonymous avatars. In a
 * draw the winner *is* a rank, and the podium tint carries that faster than
 * three gradient blobs. The circles overlap like the old avatar stack (with a
 * surface ring as the seam), so the group reads as one cluster instead of three
 * loose dots. Each circle is a HeroUI tooltip trigger — the full rank, wallet
 * and amount are only a hover away, so the row stays a single line.
 */
function WinnerBadges({
  winners,
  size = "size-6",
  text = "text-[10px]",
}: {
  winners: Winner[];
  size?: string;
  /** Glyph size inside the circles — the mobile row bumps it alongside `size`. */
  text?: string;
}) {
  if (winners.length === 0) {
    return <span className="text-[11px] text-muted">no winners</span>;
  }
  const shown = winners.slice(0, 3);
  const extra = winners.length - shown.length;
  return (
    <span className="flex items-center -space-x-1.5">
      {shown.map((w) => (
        <Tooltip key={w.rank} delay={150}>
          {/* The trigger is a hover surface only: the row itself is the button,
              so it stays out of the tab order (`role=presentation` +
              `tabIndex=-1`) instead of nesting a second button inside it. The
              same rank/wallet/amount data is also in the expanded panel. */}
          <Tooltip.Trigger
            role="presentation"
            tabIndex={-1}
            className="shrink-0 cursor-default rounded-full ring-2 ring-surface"
          >
            <span
              className={`${size} ${text} grid place-items-center rounded-full font-mono font-semibold tabular-nums ${rankBadge(
                w.rank,
              )}`}
            >
              {w.rank}
            </span>
          </Tooltip.Trigger>
          <Tooltip.Content className="font-mono text-[11px]">
            {`#${w.rank} · ${shortAddr(w.address)} · ${fmtSolHuman(w.amountSol)}`}
          </Tooltip.Content>
        </Tooltip>
      ))}
      {extra > 0 && (
        <Tooltip delay={150}>
          <Tooltip.Trigger
            role="presentation"
            tabIndex={-1}
            className="shrink-0 cursor-default rounded-full ring-2 ring-surface"
          >
            <span
              className={`${size} ${text} grid place-items-center rounded-full bg-default font-semibold text-muted ring-1 ring-(--border)`}
            >
              +{extra}
            </span>
          </Tooltip.Trigger>
          <Tooltip.Content className="font-mono text-[11px]">
            {winners
              .slice(3)
              .map((w) => `#${w.rank} ${shortAddr(w.address)}`)
              .join(" · ")}
          </Tooltip.Content>
        </Tooltip>
      )}
    </span>
  );
}

function Cell({
  label,
  value,
  title,
}: {
  label: string;
  value: React.ReactNode;
  title?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5" title={title}>
      <span className="text-xs text-muted">{label}</span>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
    </div>
  );
}


function DrawRow({
  round,
  chain,
  network,
}: {
  round: Round;
  chain: Chain | null;
  network: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  // Engine card carries the admin brand name (Admin → SEO), like the flow chart.
  const { brandName } = useSite();

  // Winners arrive in payout order, but rank is the contract.
  const ranked = [...round.winners].sort((a, b) => a.rank - b.rank);
  const when = round.completedAt ?? round.startedAt;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Draw #${round.roundNumber}, ${ranked.length} ${
          ranked.length === 1 ? "winner" : "winners"
        }, ${fmtSolHuman(round.prizePoolSol)}. ${open ? "Hide" : "Show"} details`}
        className="group grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-default/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 sm:px-5 md:flex"
      >
        {/* Left: the number that matters (prize pool), draw id under it.
            `minmax(0,1fr)` + truncation keeps this column from ever growing
            into the centred badge cluster on a narrow phone. */}
        <span className="col-start-1 flex min-w-0 flex-col leading-tight md:w-44 md:shrink-0">
          <span className="truncate font-mono text-base font-semibold tabular-nums sm:text-xl">
            {fmtSolHuman(round.prizePoolSol)}
          </span>
          <span className="mt-1 truncate text-[10px] font-normal uppercase tracking-[0.12em] text-muted/80">
            Draw #{round.roundNumber}
          </span>
        </span>

        {/* Centre: provenance chain — the same four actors as the "How a draw works" flow.
            The block sits in the middle of the row, but its contents stay
            left-aligned inside a fixed-width box: a longer pool number or a
            `+N` badge then grows to the right instead of sliding the launchpad
            logo (and every icon after it) sideways. */}
        <span className="hidden flex-1 justify-center md:flex">
          <span className="flex w-[14rem] shrink-0 items-center gap-2">
            <Step src={FEE_SOURCE_LOGO} label={`Creator fee from ${FEE_SOURCE_LABEL}`} />
            <ArrowRight size={12} className="text-muted/50" aria-hidden="true" />
            <Step src="/flow/pay.png" label={`Shuffled by the ${brandName} engine`} />
            <ArrowRight size={12} className="text-muted/50" aria-hidden="true" />
            <Step src="/flow/drand.png" label="Seeded by drand" />
            <ArrowRight size={12} className="text-muted/50" aria-hidden="true" />
            <span className="ml-0.5">
              <WinnerBadges winners={ranked} />
            </span>
          </span>
        </span>

        {/* Below md the chain is dropped and the rank circles take the middle
            grid track. With `minmax(0,1fr) auto minmax(0,1fr)` that track is
            the true centre of the row — they used to sit in the leftover space
            beside the pool, which read as "left" — and no long pool number can
            ever reach them. They are one step larger here because there is no
            chain around them to carry the eye. */}
        <span className="col-start-2 flex items-center justify-self-center gap-2 md:hidden">
          <WinnerBadges winners={ranked} size="size-7" text="text-[11px]" />
          <span className="hidden text-[11px] text-muted sm:inline">
            {ranked.length} {ranked.length === 1 ? "winner" : "winners"}
          </span>
        </span>

        {/* Right: when it ran, then a bare chevron — no chip, so it never
            reads as a link or a button with its own frame. */}
        <span className="col-start-3 flex shrink-0 items-center justify-self-end gap-3 md:col-auto">
          <span
            className="hidden w-20 truncate text-right text-[11px] text-muted sm:inline-block"
            title={fmtTime(when)}
          >
            {timeAgo(when)}
          </span>
          <ChevronDown
            size={16}
            aria-hidden="true"
            className={`shrink-0 transition-transform duration-200 ${
              open ? "rotate-180 text-foreground" : "text-muted group-hover:text-foreground"
            }`}
          />
        </span>
      </button>

      {/* Collapsed = 0fr grid row, so the panel stays mounted (aria-controls
          always resolves) while `inert` keeps its links out of tab order. */}
      <div
        id={panelId}
        inert={!open}
        aria-hidden={!open}
        className={`grid transition-[grid-template-rows] duration-300 ease-out ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="border-t border-(--border) px-4 py-4 sm:px-5">
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
              <Cell label="Prize pool" value={fmtSolHuman(round.prizePoolSol)} />
              <Cell label="Eligible holders" value={round.eligibleCount.toLocaleString()} />
              <Cell label="Winners" value={String(ranked.length)} />
              <Cell label="Drawn" value={timeAgo(when)} title={fmtTime(when)} />
            </div>

            {round.randomnessValue && round.randomnessRound ? (
              <DrandBeacon
                className="mt-4"
                beaconRound={round.randomnessRound}
                value={round.randomnessValue}
                signature={round.randomnessSignature}
                lotteryRound={round.roundNumber}
                winners={ranked}
                chain={chain}
                verified={round.randomnessVerified}
                full
              />
            ) : (
              <p className="mt-4 text-xs text-muted">No drand beacon was recorded for this draw.</p>
            )}

            <div className="mt-4">
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted">
                Winners
              </p>
              {ranked.length > 0 ? (
                <div className="flex flex-col">
                  {ranked.map((w) => (
                    <div
                      key={w.rank}
                      className="flex items-center gap-2.5 border-b border-(--border) py-1.5 last:border-0"
                    >
                      <span
                        className={`grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-bold tabular-nums ${rankBadge(w.rank)}`}
                      >
                        {w.rank}
                      </span>
                      <a
                        href={explorer(w.address, "address", network)}
                        target="_blank"
                        rel="noreferrer"
                        className="min-w-0 truncate font-mono text-xs text-muted transition-colors hover:text-foreground hover:underline"
                      >
                        {shortAddr(w.address)}
                      </a>
                      <span className="ml-auto shrink-0 font-mono text-xs font-semibold tabular-nums">
                        {fmtSolHuman(w.amountSol)}
                      </span>
                      {w.payoutTx ? (
                        <a
                          href={explorer(w.payoutTx, "tx", network)}
                          target="_blank"
                          rel="noreferrer"
                          aria-label="Open the payout transaction on Solscan"
                          title={`Payout transaction · ${w.payoutTx}`}
                          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-default hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                        >
                          <Icon name="arrow-up-right" className="h-3.5 w-3.5" />
                        </a>
                      ) : (
                        <span className="text-[11px] text-muted">pending</span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted">No winners in this draw.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}


export default function RecentDraws({
  rounds,
  chain,
  network,
  loading,
  dbError,
}: {
  rounds: Round[];
  chain: Chain | null;
  network: string;
  loading: boolean;
  dbError: string | null;
}) {
  const [page, setPage] = useState(1);

  if (loading) {
    return (
      <div className="rounded-lg border border-(--border) bg-surface px-5 py-4">
        <SkeletonRows count={PAGE_SIZE} className="px-1" />
      </div>
    );
  }
  if (dbError) {
    return (
      <div className="rounded-lg border border-(--border) bg-surface px-5 py-4">
        <p className="text-sm text-muted">
          Draw history is unavailable right now. Please try again shortly.
        </p>
      </div>
    );
  }
  if (rounds.length === 0) {
    return (
      <div className="rounded-lg border border-(--border) bg-surface px-5 py-4">
        <p className="text-sm text-muted">
          No draws yet. The first one will show up here once it runs.
        </p>
      </div>
    );
  }

  // Clamp instead of storing a corrected page: rounds can shrink (a reset, or a
  // shorter list after a refresh) and the render must never point past the end.
  const totalPages = Math.max(1, Math.ceil(rounds.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), totalPages);
  const start = (current - 1) * PAGE_SIZE;
  const visible = rounds.slice(start, start + PAGE_SIZE);
  const lastShown = Math.min(start + PAGE_SIZE, rounds.length);

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {visible.map((r) => (
          <li
            key={r.roundNumber}
            className="overflow-hidden rounded-lg border border-(--border) bg-surface"
          >
            <DrawRow round={r} chain={chain} network={network} />
          </li>
        ))}
      </ul>

      {totalPages > 1 && (
        <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted tabular-nums">
            Showing {start + 1}–{lastShown} of {rounds.length} draws
          </p>
          <Pagination
            size="sm"
            aria-label="Draw history pages"
            className="justify-center sm:justify-end"
          >
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  isDisabled={current <= 1}
                  onPress={() => setPage(current - 1)}
                >
                  Prev
                </PaginationPrevious>
              </PaginationItem>
              <PaginationItem>
                <span
                  aria-live="polite"
                  className="px-2 text-xs text-muted tabular-nums"
                >
                  Page {current} / {totalPages}
                </span>
              </PaginationItem>
              <PaginationItem>
                <PaginationNext
                  isDisabled={current >= totalPages}
                  onPress={() => setPage(current + 1)}
                >
                  Next
                </PaginationNext>
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      )}
    </div>
  );
}
