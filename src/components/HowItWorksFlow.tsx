"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Dices, Hash, Zap } from "lucide-react";
import { useSite } from "@/components/providers/SiteProvider";
// Chain-aware display unit ("SOL" on Solana, "ETH" on Robinhood Chain) and the
// launchpad whose creator fees feed the pool ("pump.fun" / "pons"), so this
// chart never advertises a venue the draw no longer reads fees from.
import {
  FEE_SOURCE_LOGO,
  FEE_SOURCE_TITLE,
  NATIVE_SYMBOL,
} from "@/lib/chain/network";

type Winner = { rank: number; address: string };

// ============================================================================
// Geometry - SVG viewBox is 1000 x 380. All four cards are the same 16.5% wide
// column with equal 10.7% gaps, so the flow reads as four equally weighted steps:
//   fee source: left 1%    w 16.5%  ->  x 10-175
//   Pay engine: left 28.2% w 16.5%  ->  x 282-447
//   drand:      left 55.3% w 16.5%  ->  x 553-718
//   winners:    left 82.5% w 16.5%  ->  x 825-990
// The first card is the chain's launchpad (pump.fun on Solana, pons on Robinhood
// Chain) — see FEE_SOURCE_TITLE. One dot crosses the gaps in order (fee source ->
// Pay engine -> drand) and forks at x=718 (drand right edge = split point) into
// one dot per winner.
// ============================================================================
const SEQ_START_X = 175; // fee-source card right edge
const PAY_LEFT_X = 282;
const PAY_RIGHT_X = 447;
const DRAND_LEFT_X = 553;
const DRAND_RIGHT_X = 718; // drand right edge - also the split point
const LINE_Y = 190;

const WINNER_X = 825;
// Winner card centres: 62 px cards at top 64/164/264 px -> centres 95/195/295 px,
// scaled into the 380-unit viewBox, so each branch dot lands dead-centre on the
// edge of its card (and rank #2 lines up with the three-step card row).
const WINNER_YS = [93, 190, 287];

type Pt = readonly [number, number];
type Branch = { d: string; c1: Pt; c2: Pt; end: Pt };

// Visible connector lines (the gaps between cards). One dot crosses these in
// order: it disappears into a card while that card does its work and comes out
// the other side, which is what reads as a single continuous flow.
const seqLines = [
  `M ${SEQ_START_X} ${LINE_Y} L ${PAY_LEFT_X} ${LINE_Y}`, // fee source -> Pay engine
  `M ${PAY_RIGHT_X} ${LINE_Y} L ${DRAND_LEFT_X} ${LINE_Y}`, // Pay engine -> drand
];

// At the split point the flow forks into three wires, one per winner. Each is a
// cubic bezier whose control points are kept as numbers so the dot can be placed
// on it exactly (cubicAt) instead of relying on a second animation clock.
const winnerBranches: Branch[] = WINNER_YS.map((y, i) => {
  const c1: Pt = [775 - i * 3, LINE_Y];
  const c2: Pt = [786 - i * 2, y];
  return {
    d: `M ${DRAND_RIGHT_X} ${LINE_Y} C ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${WINNER_X} ${y}`,
    c1,
    c2,
    end: [WINNER_X, y],
  };
});

// The desktop fork, redrawn in a 300x58 mobile box: the same split out of the
// drand card's bottom edge into one wire per winner. Short horizontal gap
// between the two outer branches keeps them readable at ~92 px columns.
const MOBILE_BRANCHES: Branch[] = [
  { d: "M 150 0 C 150 25 48 24 48 58", c1: [150, 25], c2: [48, 24], end: [48, 58] },
  { d: "M 150 0 V 58", c1: [150, 19.33], c2: [150, 38.67], end: [150, 58] },
  { d: "M 150 0 C 150 25 252 24 252 58", c1: [150, 25], c2: [252, 24], end: [252, 58] },
];

// ============================================================================
// Timeline (fractions of one FLOW_CYCLE loop).
// Narrative: the launchpad accrues the creator fee (its own charge-up animation,
// no dot yet) -> the fee leaves as a single dot and enters the Pay engine
// (shuffle) -> comes out and enters drand (scramble) -> forks at the split point
// into three dots, one per winner -> confetti + payout reveal.
// While the dot is "inside" a card it is not drawn, so the eye follows one
// particle through the whole circuit instead of three separate currents.
// ============================================================================
const FLOW_CYCLE = 8; // seconds per loop
const PHASES = {
  chargeEnd: 0.09, // the launchpad has accrued the fee - the dot leaves
  walk1End: 0.23, // dot enters the Pay engine
  payPauseEnd: 0.34, // dot comes out of the Pay engine
  walk2End: 0.48, // dot enters drand
  splitEnd: 0.63, // drand is done - the dot forks at its right edge
  winEnd: 0.83, // forks reach the winners  ->  confetti + payout reveal begin
};

// Dot windows, derived from the phases above so the two can never drift apart.
const DOT_WALK_1 = { start: PHASES.chargeEnd, end: PHASES.walk1End };
const DOT_WALK_2 = { start: PHASES.payPauseEnd, end: PHASES.walk2End };
const DOT_FORK = { start: PHASES.splitEnd, end: PHASES.winEnd };

const CHARGE_END = PHASES.chargeEnd;
const SHUFFLE_START = PHASES.walk1End;
const SHUFFLE_END = PHASES.payPauseEnd;
const SCRAMBLE_START = PHASES.walk2End;
const SCRAMBLE_END = PHASES.splitEnd;
const CONFETTI_START = PHASES.winEnd;

// Shared visual style for every connector line: soft accent tint so the lines
// read as part of the same accent "circuit" as the travelling coins.
const flowLineProps = {
  fill: "none",
  stroke: "var(--accent)",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  opacity: 0.28,
};

const CONFETTI_COLORS = ["#fbbf24", "#9945FF", "#14F195", "#f43f5e", "#3b82f6", "#fcd34d"];
// ============================================================================
// Hooks & animation primitives (React-driven, single timeline)
// ============================================================================



/** Single looping progress 0..1 locked to FLOW_CYCLE. Returns null when the
 *  user prefers reduced motion (callers render a static end-state instead). */
function useFlowProgress(reduced: boolean): number | null {
  const [progress, setProgress] = useState<number | null>(reduced ? null : 0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    if (reduced) return;
    let raf = 0;
    const tick = (t: number) => {
      if (startRef.current === null) startRef.current = t;
      const elapsed = (t - startRef.current) / 1000;
      const p = (elapsed % FLOW_CYCLE) / FLOW_CYCLE;
      setProgress(p);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);
  return progress;
}

// ---- Travelling dot ------------------------------------------------------

/** Fraction 0..1 of a time window, clamped. */
const phaseProgress = (p: number, start: number, end: number) =>
  Math.min(1, Math.max(0, (p - start) / (end - start)));

/** Smoothstep: the dot eases out of one card and settles into the next. */
const smoothStep = (t: number) => t * t * (3 - 2 * t);

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** One axis of a cubic bezier at t - keeps the dot glued to its wire. */
function cubicAt(t: number, p0: number, c1: number, c2: number, p1: number) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * p1;
}

/** The single travelling dot. Coordinates use the same 1000x380 space as the
 *  wires and are converted to percentages, so the dot always sits exactly on its
 *  line at any container width and stays round - the SVG is stretched with
 *  preserveAspectRatio="none", which would squash a <circle>. Only one dot is
 *  drawn per wire (three on the fork), never a dash trail. */
function FlowDot({ x, y }: { x: number; y: number }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute z-0 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_10px_2px_var(--accent)]"
      style={{ left: `${(x / 1000) * 100}%`, top: `${(y / 380) * 100}%` }}
    />
  );
}
// ---- Scramble text (drand randomness display) ----------------------------

const HEX_CHARS = "0123456789abcdef";
function randomHex(len: number) {
  let s = "";
  for (let i = 0; i < len; i++) s += HEX_CHARS[Math.floor(Math.random() * 16)];
  return s;
}

function ScrambleText({ active, base, length = 11 }: { active: boolean; base: string; length?: number }) {
  const [text, setText] = useState(base);
  useEffect(() => {
    if (!active) {
      setText(base);
      return;
    }
    const id = setInterval(() => setText(randomHex(length)), 70);
    return () => clearInterval(id);
  }, [active, base, length]);
  return (
    <span className={`block truncate font-mono text-xs ${active ? "text-accent" : "text-muted"}`}>
      {text}
    </span>
  );
}

// ---- Shuffle dots (Pay engine Fisher-Yates) -------------------------------

function ShuffleDots({ active }: { active: boolean }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 130);
    return () => clearInterval(id);
  }, [active]);
  const orders = [
    [0, 1, 2],
    [1, 2, 0],
    [2, 0, 1],
    [0, 2, 1],
  ];
  const order = orders[tick % orders.length];
  return (
    <span className="flex items-center gap-1">
      {order.map((dot, i) => (
        <motion.span
          key={i}
          className="inline-block size-1.5 rounded-full bg-accent"
          animate={{ opacity: dot === 1 ? 1 : 0.35, scale: dot === 1 ? 1.35 : 1 }}
          transition={{ duration: 0.12 }}
        />
      ))}
      <span className="ml-1 text-xs font-medium text-accent">Shuffling...</span>
    </span>
  );
}

// ---- Fee source charge (pre-roll of the loop) ------------------------------

/** Before the fee leaves as the travelling dot, the first card collects it:
 *  three quick pulses + a label - the same rhythm as ShuffleDots/ScrambleText,
 *  so every card in the flow visibly "does its job" while the dot is with it. */
function FeeCharge({ active }: { active: boolean }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) {
      setTick(0);
      return;
    }
    const id = setInterval(() => setTick((t) => (t + 1) % 3), 150);
    return () => clearInterval(id);
  }, [active]);
  return (
    <span className="flex min-w-0 items-center gap-1">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="inline-block size-1.5 shrink-0 rounded-full bg-success"
          animate={{ opacity: i <= tick ? 1 : 0.3, scale: i === tick ? 1.35 : 1 }}
          transition={{ duration: 0.12 }}
        />
      ))}
      <span className="ml-1 truncate text-xs font-medium text-success">Collecting...</span>
    </span>
  );
}

// ---- Confetti burst (winner reveal) ---------------------------------------

function Confetti({ fire }: { fire: boolean }) {
  if (!fire) return null;
  const count = 22;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-visible">
      {Array.from({ length: count }).map((_, i) => {
        const angle = (i / count) * Math.PI * 2;
        const dist = 24 + (i % 3) * 11;
        const x = Math.cos(angle) * dist;
        const y = Math.sin(angle) * dist;
        const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
        return (
          <motion.span
            key={i}
            className="absolute left-1/2 top-1/2 size-1.5 rounded-sm"
            style={{ background: color }}
            initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
            animate={{ x, y, opacity: 0, scale: 0.4, rotate: i * 28 }}
            transition={{ duration: 0.9, ease: "easeOut" }}
          />
        );
      })}
    </div>
  );
}


// ============================================================================
// Cards
// ============================================================================

// ============================================================================
// Brand art for the step cards. The engine and drand badges use these files;
// the fee-source card's logo is chain-dependent and lives in
// `@/lib/chain/network` (`FEE_SOURCE_LOGO` = pumpfun.png on Solana, pons.png on
// Robinhood Chain), so switching chains switches the artwork with it.
//
// Drop the PNGs into public/flow/ (square art, 64 px or larger, transparent
// background preferred) and the badge shows the logo instead of its lucide icon.
// A missing file is not an error: the <img> reports it through onError and the
// badge silently keeps its icon, so the flow never renders a broken-image glyph.
// ============================================================================
const ART = {
  pay: "/flow/pay.png",
  drand: "/flow/drand.png",
} as const;

function Node({
  icon,
  image,
  title,
  subtitle,
  badgeClassName = "bg-accent/10 text-accent ring-1 ring-inset ring-accent/20",
  active = false,
  dense = false,
}: {
  icon: ReactNode;
  /** Optional brand art, e.g. ART.pay. Falls back to `icon` if it 404s. */
  image?: string;
  title: string;
  subtitle: ReactNode;
  badgeClassName?: string;
  active?: boolean;
  /** Phone 3-across winner column (~110 px at 375 px). Same type, same order,
   *  same 60 px height — only the badge and the inner padding shrink, and only
   *  while the column is too narrow to hold the step-card badge (see below). */
  dense?: boolean;
}) {
  const [artBroken, setArtBroken] = useState(false);
  const showArt = Boolean(image) && !artBroken;
  // One shape everywhere: badge left, title over subtitle, both left-aligned,
  // and the same 60 px minimum height. The *type* never changes — title 14 px
  // (`text-sm`), subtitle 12 px (`text-xs`), same weight/tracking as the step
  // cards. The badge/padding step is driven by geometry, not taste: "Winner #1"
  // at 14 px is ~64 px wide, and a 3-across column at 375 px only has 110 px, so
  // 32 px badge + 12 px padding leaves 52 px for the copy and clips it. 24 px
  // badge + 8 px padding gives exactly the 64 px it needs. From 460 px up the
  // column is wide enough and the tile takes the step-card tokens verbatim.
  const layout = `items-center text-left ${dense ? "gap-1.5 min-[460px]:gap-2.5" : "gap-2.5"}`;
  const padding = dense
    ? "min-h-[60px] px-2 py-2 min-[460px]:px-3 min-[460px]:py-3"
    : "min-h-[60px] px-3 py-3";
  const badgeSize = dense
    ? "size-6 rounded-lg min-[460px]:size-8 min-[460px]:rounded-xl"
    : "size-8 rounded-xl";
  const radius = dense ? "rounded-xl min-[460px]:rounded-2xl" : "rounded-2xl";
  return (
    <div
      className={`relative z-10 flex min-w-0 ${radius} border bg-surface shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${layout} ${padding} ${
        active
          ? "border-accent/60 ring-2 ring-accent/30"
          : "border-(--border) hover:border-muted/40"
      }`}
    >
      <span className={`flex shrink-0 items-center justify-center overflow-hidden ${badgeSize} ${badgeClassName}`}>
        {showArt && image ? (
          <img
            src={image}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="size-6 object-contain"
            onError={() => setArtBroken(true)}
          />
        ) : (
          icon
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-left text-sm font-semibold tracking-tight text-foreground ${
            dense ? "max-[379px]:text-[13px]" : ""
          }`}
        >
          {title}
        </span>
        {typeof subtitle === "string" ? (
          <span
            className={
              dense
                ? "block break-words text-left text-xs text-muted"
                : "block truncate text-left text-xs text-muted"
            }
          >
            {subtitle}
          </span>
        ) : (
          subtitle
        )}
      </span>
    </div>
  );
}

function rankBadgeClass(rank: number): string {
  if (rank === 1) return "bg-amber-100 text-amber-900 ring-1 ring-amber-200";
  if (rank === 2) return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
  if (rank === 3) return "bg-orange-100 text-orange-900 ring-1 ring-orange-200";
  return "bg-default text-muted ring-1 ring-(--border)";
}

// Winner card - built from the very same <Node> as the three step cards, so the
// order, alignment and height match exactly (it used to be a shorter card with a
// HeroUI Avatar and a 10 px bold badge, which read as a different font). The
// `dense` variant is only for the phone's 3-across row and scales the same tile
// down; it does not change the shape. The rank is the badge slot; the rank's cut
// of the net pool arrives as the subtitle when the travelling dots land.
//
// The cut comes from PAYOUT_DISTRIBUTION (via /api/status), never hardcoded, so
// changing the split - or the platform fee that is taken before it - can't leave
// the card quoting a number the engine no longer pays. It is a percentage rather
// than a SOL figure on purpose: this is an explainer, and a made-up amount next
// to a real pool reads as a promise.
function WinnerCard({
  index,
  reveal,
  share,
  dense = false,
}: {
  index: number;
  reveal: boolean;
  /** The rank's share of the net pool, e.g. 0.5 for 50%. Absent when unknown. */
  share?: number;
  /** Phone 3-across row: three winners side by side, one column each. */
  dense?: boolean;
}) {
  const rank = index + 1;
  const pct = typeof share === "number" ? Math.round(share * 100) : null;
  // "50% of net pool" fits the desktop tile; the phone's ~92 px column only has
  // room for "50%".
  const shareLabel =
    pct === null ? `paid in ${NATIVE_SYMBOL}` : dense ? `${pct}%` : `${pct}% of net pool`;
  return (
    <div className="relative">
      <Node
        icon={
          <span className={`font-bold leading-none ${dense ? "text-xs min-[460px]:text-sm" : "text-sm"}`}>
            {rank}
          </span>
        }
        title={`Winner #${rank}`}
        badgeClassName={rankBadgeClass(rank)}
        dense={dense}
        subtitle={
          reveal ? (
            <motion.span
              className="block tabular-nums text-xs text-accent"
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
            >
              {shareLabel}
            </motion.span>
          ) : (
            <span
              className={
                dense
                  ? "block break-words text-xs text-muted"
                  : "block truncate text-xs text-muted"
              }
            >
              {/* Phone columns are ~92 px wide, so "Awaiting draw" wrapped into
                  "Awaiting" / "draw" and made that card taller than its
                  neighbours. One word on phones, the full phrase from desktop. */}
              {dense ? "Awaiting" : "Awaiting draw"}
            </span>
          )
        }
      />
      <Confetti fire={reveal} />
    </div>
  );
}

// ============================================================================
// Main
// ============================================================================

export default function HowItWorksFlow({
  winners,
  network,
  chainName,
  payoutDistribution,
}: {
  winners: Winner[];
  network: "mainnet" | "devnet";
  chainName?: string;
  /** Next round's split from /api/status; absent while loading or unreadable. */
  payoutDistribution?: number[];
}) {
  // Card title comes from the admin brand name (SiteProvider), so the flow never
  // shows a stale hardcoded wordmark like the old "Pay engine".
  const { brandName } = useSite();
  const reduceMotion = useReducedMotion();
  const reduced = Boolean(reduceMotion);
  const progress = useFlowProgress(reduced);
  const p = progress ?? 1; // reduced  ->  show end-state
  const reveal = reduced || p >= CONFETTI_START;

  const drandActive = !reduced && p >= SCRAMBLE_START && p < SCRAMBLE_END;
  const platformActive = !reduced && p >= SHUFFLE_START && p < SHUFFLE_END;
  // Pre-roll: the launchpad counts the fee in before the dot is allowed to leave.
  const pumping = !reduced && p < CHARGE_END;

  // One dot, in order: fee source -> Pay engine -> drand -> fork into 3 winners.
  // Positions come from the shared timeline, so the dot, the wires and the card
  // states (shuffle / scramble / reveal) can never drift out of sync.
  const walk1T = smoothStep(phaseProgress(p, DOT_WALK_1.start, DOT_WALK_1.end));
  const walk2T = smoothStep(phaseProgress(p, DOT_WALK_2.start, DOT_WALK_2.end));
  const forkT = smoothStep(phaseProgress(p, DOT_FORK.start, DOT_FORK.end));
  const walking1 = !reduced && p >= DOT_WALK_1.start && p < DOT_WALK_1.end;
  const walking2 = !reduced && p >= DOT_WALK_2.start && p < DOT_WALK_2.end;
  const forking = !reduced && p >= DOT_FORK.start && p < DOT_FORK.end;

  return (
    <div>
      {/* ===================== Desktop ===================== */}
      <div
        className="relative hidden min-h-[390px] lg:block"
        aria-label={`${FEE_SOURCE_TITLE} creator fee flows through the ${brandName} engine and drand to the winners`}
      >
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox="0 0 1000 380"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {seqLines.map((d) => (
            <path key={d} d={d} {...flowLineProps} />
          ))}
          {winnerBranches.map((b) => (
            <path key={b.d} d={b.d} {...flowLineProps} />
          ))}
        </svg>

        {/* One dot: fee source -> Pay engine -> drand, then it forks into three. */}
        {walking1 && <FlowDot x={lerp(SEQ_START_X, PAY_LEFT_X, walk1T)} y={LINE_Y} />}
        {walking2 && <FlowDot x={lerp(PAY_RIGHT_X, DRAND_LEFT_X, walk2T)} y={LINE_Y} />}
        {forking &&
          winnerBranches.map((b, i) => (
            <FlowDot
              key={i}
              x={cubicAt(forkT, DRAND_RIGHT_X, b.c1[0], b.c2[0], b.end[0])}
              y={cubicAt(forkT, LINE_Y, b.c1[1], b.c2[1], b.end[1])}
            />
          ))}
        {/* The fee-source card: chain-dependent logo + title (pump.fun on Solana,
            pons on Robinhood Chain) — collects the creator fee before the dot
            leaves. */}
        <div className="absolute left-[1%] top-[164px] w-[16.5%]">
          <Node
            icon={<Zap size={18} />}
            image={FEE_SOURCE_LOGO}
            title={FEE_SOURCE_TITLE}
            active={pumping}
            subtitle={pumping ? <FeeCharge active /> : "creator fees"}
            badgeClassName="bg-success/10 text-success ring-1 ring-inset ring-success/20"
          />
        </div>

        {/* The engine card — titled with the brand (Admin → SEO → Brand name),
            not a hardcoded old name. */}
        <div className="absolute left-[28.2%] top-[164px] w-[16.5%]">
          <Node
            icon={<Dices size={18} />}
            image={ART.pay}
            title={`${brandName} engine`}
            active={platformActive}
            subtitle={platformActive ? <ShuffleDots active /> : "Provably-fair shuffle"}
          />
        </div>

        {/* drand - verifiable randomness (hex scrambles while the dot visits) */}
        <div className="absolute left-[55.3%] top-[164px] w-[16.5%]">
          <Node
            icon={<Hash size={18} />}
            image={ART.drand}
            title="drand beacon"
            active={drandActive}
            subtitle={<ScrambleText active={drandActive} base={chainName ?? "Verifiable beacon"} />}
          />
        </div>

        {/* Winners - same Node shape as the steps; payout arrives with the dots */}
        <div className="absolute left-[82.5%] top-[64px] w-[16.5%]">
          <WinnerCard index={0} reveal={reveal} share={payoutDistribution?.[0]} />
        </div>
        <div className="absolute left-[82.5%] top-[164px] w-[16.5%]">
          <WinnerCard index={1} reveal={reveal} share={payoutDistribution?.[1]} />
        </div>
        <div className="absolute left-[82.5%] top-[264px] w-[16.5%]">
          <WinnerCard index={2} reveal={reveal} share={payoutDistribution?.[2]} />
        </div>
      </div>

      {/* ===================== Mobile ===================== */}
      <div
        className="flex flex-col gap-2 lg:hidden"
        aria-label={`${FEE_SOURCE_TITLE} creator fee flows through the ${brandName} engine and drand to the winners`}
      >
        {/* Phones keep the flow as a centred column of capped cards, but each
            card is left-aligned exactly like the desktop tile (badge left, copy
            left) — centring the card contents made the fee-source step stop
            looking like the same tile, and left the subtitle floating under the
            icon. Only the *column* is centred now, not the text inside — and the
            card is capped at 13rem, because at 18rem it was much wider than the
            copy it holds. */}
        <div className="mx-auto w-full max-w-[13rem]">
          <Node
            icon={<Zap size={18} />}
            image={FEE_SOURCE_LOGO}
            title={FEE_SOURCE_TITLE}
            active={pumping}
            subtitle={pumping ? <FeeCharge active /> : "creator fees"}
            badgeClassName="bg-success/10 text-success ring-1 ring-inset ring-success/20"
          />
        </div>
        <MobileWire active={walking1} t={walk1T} />
        <div className="mx-auto w-full max-w-[13rem]">
          <Node
            icon={<Dices size={18} />}
            image={ART.pay}
            title={`${brandName} engine`}
            active={platformActive}
            subtitle={platformActive ? <ShuffleDots active /> : "Provably-fair shuffle"}
          />
        </div>
        <MobileWire active={walking2} t={walk2T} />
        <div className="mx-auto w-full max-w-[13rem]">
          <Node
            icon={<Hash size={18} />}
            image={ART.drand}
            title="drand beacon"
            active={drandActive}
            subtitle={<ScrambleText active={drandActive} base={chainName ?? "Verifiable beacon"} />}
          />
        </div>
        {/* The desktop split, on the phone: the drand card pours into a
            three-way fork and one dot per winner lands on the three column
            centres (16% / 50% / 84%) — the same fan as desktop, not a single
            wire. `-my-2` pulls the fork into the flex gaps (gap-2 = 8 px) so the
            branches start on the drand card's bottom border and land on the
            winner cards' top border; the 58-unit box is stretched to 72 px
            (`preserveAspectRatio="none"`), which gives the fan more travel
            without redoing the curve maths. */}
        <div className="relative -my-2 h-[72px]" aria-hidden="true">
          <svg className="h-full w-full overflow-visible" viewBox="0 0 300 58" preserveAspectRatio="none">
            {MOBILE_BRANCHES.map((b) => (
              <path key={b.d} d={b.d} {...flowLineProps} />
            ))}
          </svg>
          {forking &&
            MOBILE_BRANCHES.map((b, i) => (
              <span
                key={i}
                className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_10px_2px_var(--accent)]"
                style={{
                  left: `${(cubicAt(forkT, 150, b.c1[0], b.c2[0], b.end[0]) / 300) * 100}%`,
                  top: `${(cubicAt(forkT, 0, b.c1[1], b.c2[1], b.end[1]) / 58) * 100}%`,
                }}
              />
            ))}
        </div>
        {/* Three winners on one row — #1 left, #2 centre, #3 right — directly
            under the three fork tips. The row is a 3-column grid (not shrink-to-
            fit cards) so each card's centre is exactly the 16% / 50% / 84% the
            branches point at. `dense` keeps the step-card shape (badge left,
            title over subtitle, left-aligned, 60 px tall) at ~92 px per column. */}
        <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
          {[0, 1, 2].map((index) => (
            <WinnerCard key={index} index={index} reveal={reveal} share={payoutDistribution?.[index]} dense />
          ))}
        </div>
      </div>
    </div>
  );
}
// ============================================================================
// Mobile helpers - the same single dot, on the vertical connectors
// ============================================================================

/** Vertical wire carrying the same travelling dot as the desktop flow. The dot
 *  is mounted only while its phase is active (caller passes `active`), so one
 *  wire at a time is live: fee source -> Pay engine -> drand. The last hop
 *  (drand -> winners) is the three-way fork below, exactly like desktop. */
function MobileWire({ active, t }: { active: boolean; t: number }) {
  return (
    // `-my-2` cancels the 8px flex gap on both sides (gap-2) so the wire starts
    // on the previous card's border and ends on the next card's border; without
    // it the line visibly floated between the cards. The 40-unit viewBox is
    // stretched to the h-14 box, so the run between two cards stays connected
    // at any height.
    <div className="relative -my-2 flex h-14 items-center justify-center" aria-hidden="true">
      <svg className="h-full w-12 overflow-visible" viewBox="0 0 48 40" preserveAspectRatio="none">
        <path d="M24 0 V40" {...flowLineProps} />
      </svg>
      {active ? (
        <span
          className="pointer-events-none absolute left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_10px_2px_var(--accent)]"
          style={{ top: `${t * 100}%` }}
        />
      ) : null}
    </div>
  );
}
