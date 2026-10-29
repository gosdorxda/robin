"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableContent,
  TableHeader,
  TableRow,
  Typography,
} from "@heroui/react";
import { AppShell } from "@/components/AppShell";
import { Icon, Skeleton, SkeletonRows } from "@/components/ui";
import { shortAddress, explorerUrl, fmtSolHuman } from "@/lib/format";
// Chain-aware display unit ("SOL" on Solana, "ETH" on Robinhood Chain).
import { NATIVE_SYMBOL } from "@/lib/chain/network";

/**
 * Stats aggregates everything the lottery has ever done. Totals come from
 * /api/stats (DB aggregates over ALL rounds — not the 50-row window /api/rounds
 * uses for the Draws list), and the timeline is 30 UTC-day buckets.
 */

type Day = {
  key: string;
  label: string;
  draws: number;
  completed: number;
  skipped: number;
  failed: number;
  /** Pool of that day's completed draws, platform fee included. */
  prizeSol: number;
  feeSol: number;
  eligibleAvg: number;
  eligiblePeak: number;
};

type HolderDay = { key: string; eligible: number; total: number };

type Stats = {
  network: "mainnet" | "devnet";
  windowDays: number;
  generatedAt: string;
  totals: {
    draws: number;
    winners: number;
    paidSol: number;
    paidCount: number;
    prizeSol: number;
    biggestPrize: number;
    avgPrize: number;
    avgEligible: number;
    platformFeesSol: number;
    payoutFeesSol: number;
    uniqueWinners: number;
    repeatWins: number;
    lastDrawAt: string | null;
  } | null;
  statusCounts: { status: string; count: number }[];
  payoutStatusCounts: { status: string; count: number }[];
  daily: Day[];
  /** null when the snapshot history query failed — the chart falls back to
   *  draw-time eligible peaks instead of showing an error. */
  holdersDaily: HolderDay[] | null;
  leaderboard: {
    address: string;
    totalSol: number;
    wins: number;
    lastRound: number;
  }[];
  dbError: string | null;
};

type Metric = "prize" | "eligible" | "outcomes";

export default function StatsPage() {
  const [data, setData] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>("prize");
  const [hover, setHover] = useState<{ index: number; left: number } | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  /** Tooltip x in % of the plot, clamped so the 176px card never leaves the plot. */
  const tooltipLeft = (cell: HTMLElement) => {
    const w = plotRef.current?.clientWidth ?? 0;
    if (!w) return 50;
    const center = cell.offsetLeft + cell.offsetWidth / 2;
    const half = 96; // w-44 / 2 + an 8px gutter
    const max = Math.max(half, w - half);
    return (Math.min(Math.max(center, half), max) / w) * 100;
  };

  useEffect(() => {
    let alive = true;
    fetch("/api/stats", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: Stats) => {
        if (!alive) return;
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const net = (data?.network ?? "mainnet") as "mainnet" | "devnet";

  const view = useMemo(() => {
    const daily = data?.daily ?? [];
    const n = daily.length;
    const holders = new Map((data?.holdersDaily ?? []).map((h) => [h.key, h]));

    // Eligible-wallet series. Preferred source is the daily holder snapshot (it
    // moves even on days without a draw); a missing day carries the last known
    // count forward because the holder set doesn't evaporate overnight. Without
    // snapshots we fall back to draw-time peaks, which only exist on days a
    // draw actually completed.
    let carried: number | null = null;
    const hasSnapshots = (data?.holdersDaily?.length ?? 0) > 0;
    const eligibleValues: (number | null)[] = daily.map((d) => {
      const snap = holders.get(d.key);
      if (snap) {
        carried = snap.eligible;
        return snap.eligible;
      }
      if (hasSnapshots) return carried;
      return d.completed > 0 ? d.eligiblePeak : null;
    });

    // Scale to the real peak — never to a fixed 1 SOL floor. Pools here are
    // fractions of a SOL, and flooring the axis at 1 drew every bar as a 3px
    // stub at the bottom of an empty plot.
    const prizePeak = daily.reduce((m, d) => Math.max(m, d.prizeSol), 0);
    const eligibleTop = eligibleValues.reduce<number>(
      (m, v) => (v !== null && v > m ? v : m),
      0
    );
    const maxPrize = prizePeak > 0 ? prizePeak : 1;
    const maxEligible = eligibleTop > 0 ? eligibleTop : 1;
    const maxDraws = Math.max(1, ...daily.map((d) => d.draws));
    const windowDraws = daily.reduce((a, d) => a + d.completed, 0);
    const windowPrize = daily.reduce((a, d) => a + d.prizeSol, 0);
    const windowFee = daily.reduce((a, d) => a + d.feeSol, 0);
    const windowBad = daily.reduce((a, d) => a + d.skipped + d.failed, 0);

    // Line geometry lives in a 0-100 space stretched over the plot box, so the
    // SVG needs no measuring and stays crisp at any width. Zero sits exactly on
    // the baseline (y=100) so the area fill has a floor to close against.
    const points = daily
      .map((d, i) => {
        const v = eligibleValues[i];
        if (v === null) return null;
        return {
          x: ((i + 0.5) / Math.max(1, n)) * 100,
          y: 100 - (v / maxEligible) * 92,
          v,
        };
      })
      .filter((p): p is { x: number; y: number; v: number } => p !== null);
    const line = points
      .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
      .join(" ");
    const area = points.length
      ? `${line} L${points[points.length - 1].x.toFixed(2)},100 L${points[0].x.toFixed(
          2
        )},100 Z`
      : "";

    return {
      daily,
      totals: data?.totals ?? null,
      hasSnapshots,
      holders,
      eligibleValues,
      points,
      line,
      area,
      maxPrize,
      maxEligible,
      maxDraws,
      windowDraws,
      windowPrize,
      windowFee,
      windowBad,
    };
  }, [data]);

  const t = view.totals;
  const windowDays = data?.windowDays ?? 30;

  return (
    <AppShell title="Stats">
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-10 pt-8 sm:pt-10 pb-12 flex flex-col gap-6">
        <div className="max-w-3xl">
          <Typography type="h4">Draw statistics</Typography>
          <Typography type="body-sm" color="muted" className="mt-1.5">
            Every completed draw, added up: how much {NATIVE_SYMBOL} reached winners, how many wallets were
            eligible, and who has won the most. Totals are all time. The chart covers the last{" "}
            {windowDays} days.
          </Typography>
        </div>

        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
            Couldn’t load these numbers. Refresh the page to try again.
          </div>
        )}
        {data?.dbError && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
            These numbers are temporarily unavailable. Refresh in a moment.
          </div>
        )}

        {loading ? (
          <StatsSkeleton />
        ) : !t || t.draws === 0 ? (
          error || data?.dbError ? null : (
            <p className="text-sm text-muted">
              No draw has finished yet. These numbers appear once the first one does.
            </p>
          )
        ) : (
          <>
            <Tiles totals={t} />

            <div className="rounded-lg border border-(--border) bg-surface">
              <div className="flex flex-col gap-3 border-b border-(--border) px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold tracking-tight">
                    Last {windowDays} days
                  </h2>
                  <p className="mt-0.5 text-xs text-muted">
                    {metric === "prize" &&
                      (view.windowDraws > 0
                        ? `${fmtSolHuman(view.windowPrize)} pooled across ${view.windowDraws} ${
                            view.windowDraws === 1 ? "draw" : "draws"
                          }`
                        : "No draw finished in this window")}
                    {metric === "eligible" &&
                      (view.hasSnapshots
                        ? `Eligible wallets from holder snapshots, latest ${lastValue(
                            view.eligibleValues
                          )}`
                        : "Eligible wallets at draw time, no holder snapshots yet")}
                    {metric === "outcomes" &&
                      `${view.windowDraws} completed · ${view.windowBad} skipped or failed`}
                  </p>
                </div>
                <Segmented value={metric} onChange={setMetric} />
              </div>

              <div className="px-5 py-4">
                <div
                  className="relative"
                  onMouseLeave={() => setHover(null)}
                >
                  {/* Fixed-height plot box: every percentage inside (gridlines,
                      SVG coords, dots, bar heights) resolves against this 176px
                      box alone — not against the axis row below it. */}
                  <div ref={plotRef} className="relative h-44">
                  {/* Faint rules: readable top/middle scale, no chart library. */}
                  <div
                    className="pointer-events-none absolute inset-0"
                    aria-hidden="true"
                  >
                    <div className="absolute inset-x-0 top-0 border-t border-(--border)" />
                    <div className="absolute inset-x-0 top-1/2 border-t border-(--separator)" />
                    {/* Baseline: bars need a floor to sit on. */}
                    <div className="absolute inset-x-0 bottom-0 border-t border-(--border)" />
                  </div>

                  {/* Eligible line sits behind the invisible hover cells. */}
                  {metric === "eligible" && view.points.length > 1 && (
                    <svg
                      className="pointer-events-none absolute inset-0 h-full w-full"
                      viewBox="0 0 100 100"
                      preserveAspectRatio="none"
                      aria-hidden="true"
                    >
                      <defs>
                        <linearGradient id="eligibleFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
                          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.03" />
                        </linearGradient>
                      </defs>
                      {/* Filled area under the line: the accent gradient is what
                          makes the series read as a trend at a glance, with the
                          line + dots only marking the actual snapshot points. */}
                      <path d={view.area} fill="url(#eligibleFill)" />
                      <path
                        d={view.line}
                        fill="none"
                        stroke="var(--accent)"
                        strokeWidth={1.75}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    </svg>
                  )}

                  {metric === "eligible" &&
                    view.points.map((p) => (
                      <span
                        key={`dot-${p.x}`}
                        className="pointer-events-none absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-surface"
                        style={{ left: `${p.x}%`, top: `${p.y}%` }}
                      />
                    ))}

                  <div className="relative flex h-full items-end gap-[3px]">
                    {view.daily.map((d, i) => {
                      const active = hover?.index === i;
                      const dim = hover !== null && !active;
                      const prizeH =
                        d.prizeSol > 0 ? Math.max(3, (d.prizeSol / view.maxPrize) * 100) : 0;
                      const feeShare = d.prizeSol > 0 ? (d.feeSol / d.prizeSol) * 100 : 0;
                      const drawH =
                        d.draws > 0 ? Math.max(3, (d.draws / view.maxDraws) * 100) : 0;
                      return (
                        <button
                          key={d.key}
                          type="button"
                          aria-label={dayAria(d, view.eligibleValues[i])}
                          onMouseEnter={(e) =>
                            setHover({ index: i, left: tooltipLeft(e.currentTarget) })
                          }
                          onFocus={(e) =>
                            setHover({ index: i, left: tooltipLeft(e.currentTarget) })
                          }
                          onBlur={() => setHover(null)}
                          className={`group relative flex h-full flex-1 cursor-default items-end rounded-sm outline-none transition duration-150 focus-visible:ring-2 focus-visible:ring-accent/40 ${
                            dim ? "opacity-40" : ""
                          } ${active ? "bg-default/50" : ""}`}
                        >
                          {metric === "prize" && prizeH > 0 && (
                            <div
                              style={{ height: `${prizeH}%` }}
                              className="relative w-full overflow-hidden rounded-t-md bg-accent/80 transition-colors group-hover:bg-accent"
                            >
                              {feeShare > 0 && (
                                <div
                                  style={{ height: `${feeShare}%` }}
                                  className="absolute inset-x-0 top-0 bg-warning/80"
                                />
                              )}
                            </div>
                          )}
                          {metric === "outcomes" && drawH > 0 && (
                            <div
                              style={{ height: `${drawH}%` }}
                              className="flex w-full flex-col-reverse overflow-hidden rounded-t-md"
                            >
                              {d.completed > 0 && (
                                <div style={{ flexGrow: d.completed }} className="bg-success/70" />
                              )}
                              {d.skipped > 0 && (
                                <div style={{ flexGrow: d.skipped }} className="bg-muted/40" />
                              )}
                              {d.failed > 0 && (
                                <div style={{ flexGrow: d.failed }} className="bg-danger/70" />
                              )}
                            </div>
                          )}
                          {metric === "eligible" && <span className="block h-full w-full" />}
                        </button>
                      );
                    })}
                  </div>


                  {/* Hovered point on the eligible line. */}
                  {metric === "eligible" && hover !== null && view.points.length > 0 && (
                    <HoverDot
                      index={hover.index}
                      values={view.eligibleValues}
                      max={view.maxEligible}
                      total={view.daily.length}
                    />
                  )}
                  </div>

                  {hover !== null && view.daily[hover.index] && (
                    <ChartTooltip
                      left={hover.left}
                      day={view.daily[hover.index]}
                      metric={metric}
                      holder={view.holders.get(view.daily[hover.index].key)}
                      eligibleNow={view.eligibleValues[hover.index]}
                    />
                  )}

                  <Axis daily={view.daily} />
                </div>

                <ChartLegend
                  metric={metric}
                  feeSol={view.windowFee}
                  snapshot={view.hasSnapshots}
                />
              </div>
            </div>

            <Leaderboard
              rows={data?.leaderboard ?? []}
              net={net}
              unique={t.uniqueWinners}
              repeat={t.repeatWins}
            />
          </>
        )}
      </main>
    </AppShell>
  );
}

/** Latest non-null eligible count, for the card subtitle. */
function lastValue(values: (number | null)[]): string {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null) return v.toLocaleString("en-US");
  }
  return "—";
}

/** `aria-label` for an invisible hover cell — the chart's accessible summary. */
function dayAria(d: Day, eligible: number | null): string {
  return [
    `${d.label}: ${d.draws} ${d.draws === 1 ? "draw" : "draws"}`,
    d.completed > 0 ? `${d.completed} completed` : null,
    d.skipped > 0 ? `${d.skipped} skipped` : null,
    d.failed > 0 ? `${d.failed} failed` : null,
    eligible !== null ? `${eligible.toLocaleString()} eligible` : null,
  ]
    .filter(Boolean)
    .join(", ");
}


/** Metric switch. Plain buttons instead of HeroUI Tabs: the three "panels" are
 *  the same chart with different cells, so there is no panel content to swap. */
function Segmented({
  value,
  onChange,
}: {
  value: Metric;
  onChange: (m: Metric) => void;
}) {
  const items: { id: Metric; label: string }[] = [
    { id: "prize", label: "Prize pool" },
    { id: "eligible", label: "Eligible wallets" },
    { id: "outcomes", label: "Outcomes" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Chart metric"
      className="flex shrink-0 items-center gap-0.5 rounded-lg bg-default/60 p-0.5"
    >
      {items.map((it) => {
        const active = value === it.id;
        return (
          <button
            key={it.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(it.id)}
            className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
              active
                ? "bg-surface text-foreground shadow-sm"
                : "text-muted hover:text-foreground"
            }`}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

/** Marker + guide line for the hovered day on the eligible line chart. */
function HoverDot({
  index,
  values,
  max,
  total,
}: {
  index: number;
  values: (number | null)[];
  max: number;
  total: number;
}) {
  const v = values[index];
  if (v === null) return null;
  const x = ((index + 0.5) / Math.max(1, total)) * 100;
  const y = 100 - (v / max) * 92;
  return (
    <>
      <div
        className="pointer-events-none absolute inset-y-0 w-px bg-(--border)"
        style={{ left: `${x}%` }}
      />
      <div
        className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-accent"
        style={{ left: `${x}%`, top: `${y}%` }}
      />
    </>
  );
}

function ChartTooltip({
  left,
  day,
  metric,
  holder,
  eligibleNow,
}: {
  left: number;
  day: Day;
  metric: Metric;
  holder?: HolderDay;
  eligibleNow: number | null;
}) {
  const rows: { label: string; value: string; dot?: string }[] = [];

  if (metric === "prize") {
    if (day.draws === 0) {
      // A zero-height bar is "nothing finished", not "0 SOL was paid" — say so
      // instead of printing a meaningless 0.0000 SOL row.
      rows.push({ label: "Outcome", value: "No draw finished" });
    } else {
      rows.push({
        label: "To winners",
        value: fmtSolHuman(Math.max(0, day.prizeSol - day.feeSol)),
        dot: "bg-accent",
      });
      if (day.feeSol > 0) {
        rows.push({ label: "Platform fee", value: fmtSolHuman(day.feeSol), dot: "bg-warning" });
      }
      rows.push({ label: "Completed", value: `${day.completed} of ${day.draws}` });
    }
  } else if (metric === "eligible") {
    if (eligibleNow !== null) {
      rows.push({
        label: "Eligible",
        value: eligibleNow.toLocaleString("en-US"),
        dot: "bg-accent",
      });
    } else {
      rows.push({ label: "Eligible", value: day.draws > 0 ? "not recorded" : "no snapshot" });
    }
    if (holder) rows.push({ label: "Holders", value: holder.total.toLocaleString("en-US") });
  } else {
    rows.push({ label: "Completed", value: String(day.completed), dot: "bg-success" });
    rows.push({ label: "Skipped", value: String(day.skipped), dot: "bg-muted/40" });
    rows.push({ label: "Failed", value: String(day.failed), dot: "bg-danger" });
  }

  return (
    <div
      className="pointer-events-none absolute top-1.5 z-20 w-44 -translate-x-1/2 rounded-lg border border-(--border) bg-surface/95 p-2.5 shadow-lg backdrop-blur-sm"
      style={{ left: `${left}%` }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-foreground">{day.label}</span>
        <span className="rounded-md bg-default px-1.5 py-0.5 font-mono text-[10px] text-muted">
          {day.draws} {day.draws === 1 ? "draw" : "draws"}
        </span>
      </div>
      <dl className="mt-2 flex flex-col gap-1">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-3">
            <dt className="flex items-center gap-1.5 text-[11px] text-muted">
              {r.dot && <span className={`h-1.5 w-1.5 rounded-full ${r.dot}`} />}
              {r.label}
            </dt>
            <dd className="font-mono text-[11px] tabular-nums text-foreground">{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}


function Axis({ daily }: { daily: Day[] }) {
  return (
    <div className="mt-1.5 flex gap-[3px]">
      {daily.map((d, i) => (
        <span
          key={d.key}
          className="flex-1 whitespace-nowrap text-center font-mono text-[9px] text-muted"
        >
          {i % 5 === 0 || i === daily.length - 1 ? d.label : ""}
        </span>
      ))}
    </div>
  );
}

function ChartLegend({
  metric,
  feeSol,
  snapshot,
}: {
  metric: Metric;
  feeSol: number;
  snapshot: boolean;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-(--border) pt-3 text-[11px] text-muted">
      {metric === "prize" && (
        <>
          <LegendDot className="bg-accent" label="To winners" />
          {feeSol > 0 && (
            <LegendDot className="bg-warning" label={`Platform fee ${fmtSolHuman(feeSol)}`} />
          )}
        </>
      )}
      {metric === "eligible" && <LegendDot className="bg-accent" label="Eligible wallets" />}
      {metric === "outcomes" && (
        <>
          <LegendDot className="bg-success" label="Completed" />
          <LegendDot className="bg-muted/40" label="Skipped" />
          <LegendDot className="bg-danger" label="Failed" />
        </>
      )}
      <span className="sm:ml-auto">
        {metric === "prize" &&
          "Each bar is one day's prize pool: what went to winners plus any platform fee. No bar means no draw finished that day."}
        {metric === "eligible" &&
          (snapshot
            ? "One point per day, from that day's most complete holder snapshot. Days without a snapshot carry the last count forward."
            : "Peak eligible count on days a draw completed.")}
        {metric === "outcomes" &&
          "Bar height is draws that day; segments split completed, skipped and failed."}
      </span>
    </div>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${className}`} />
      {label}
    </span>
  );
}


/**
 * One framed row of four tiles. It used to be six: "Winners" and "Average
 * prize" were pure arithmetic of the others (3 winners per draw; paid ÷ draws),
 * and "Average eligible" now lives as a trend in the chart. Four also fills the
 * frame exactly at every breakpoint — a conditional fifth tile left a gray hole
 * in the grid on tablets. Platform fees surface in the chart legend instead.
 */
function Tiles({ totals }: { totals: NonNullable<Stats["totals"]> }) {
  const tiles: { label: string; value: string; caption: string }[] = [
    {
      label: "Draws",
      value: totals.draws.toLocaleString("en-US"),
      caption: "completed, all time",
    },
    {
      label: "Paid out",
      value: fmtSolHuman(totals.paidSol),
      caption: `${totals.paidCount.toLocaleString("en-US")} of ${totals.winners.toLocaleString(
        "en-US"
      )} payouts sent`,
    },
    {
      label: "Biggest pool",
      value: fmtSolHuman(totals.biggestPrize),
      caption: `average ${fmtSolHuman(totals.avgPrize)} per draw`,
    },
    {
      label: "Eligible wallets",
      value: totals.avgEligible.toLocaleString("en-US"),
      caption: "average per draw",
    },
  ];

  return (
    <div className="rounded-lg border border-(--border) bg-(--border) overflow-hidden">
      <div className="grid grid-cols-2 gap-px sm:grid-cols-4">
        {tiles.map((tile) => (
          <Stat key={tile.label} {...tile} />
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, caption }: { label: string; value: string; caption: string }) {
  return (
    <div className="bg-surface px-4 sm:px-5 py-3 flex flex-col">
      <span className="text-sm text-muted">{label}</span>
      <span className="mt-1 text-xl sm:text-2xl font-semibold tabular-nums leading-tight break-words text-foreground">
        {value}
      </span>
      <span className="mt-1 text-xs text-muted">{caption}</span>
    </div>
  );
}

function StatSkeleton({ label }: { label: string }) {
  return (
    <div className="bg-surface px-4 sm:px-5 py-3 flex flex-col">
      <span className="text-sm text-muted">{label}</span>
      <Skeleton className="mt-1 h-7 w-20" />
      <Skeleton className="mt-1 h-3 w-16" />
    </div>
  );
}


function Leaderboard({
  rows,
  net,
  unique,
  repeat,
}: {
  rows: Stats["leaderboard"];
  net: "mainnet" | "devnet";
  unique: number;
  repeat: number;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-base font-semibold tracking-tight">Most won</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nobody has won yet. The first draw will change that.</p>
      ) : (
        <div className="table-bordered rounded-lg border border-(--border) overflow-hidden bg-surface">
          <Table variant="secondary">
            {/* Five columns need ~520px before "TOTAL WON" and the wallet links
                start stacking lines; below that the table pans inside its card. */}
            <Table.ScrollContainer
              tabIndex={0}
              className="overscroll-x-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            >
              <TableContent
                aria-label="Wallets that have won the most"
                className="min-w-[32rem] text-xs font-mono"
              >
                <TableHeader>
                  <TableColumn className="w-12">#</TableColumn>
                  <TableColumn isRowHeader>WALLET</TableColumn>
                  <TableColumn style={{ textAlign: "right" }}>TOTAL WON</TableColumn>
                  <TableColumn style={{ textAlign: "center" }}>WINS</TableColumn>
                  <TableColumn>LAST WIN</TableColumn>
                </TableHeader>
                <TableBody>
                  {rows.map((w, i) => (
                    <TableRow key={w.address}>
                      <TableCell className="text-muted font-mono">{i + 1}</TableCell>
                      <TableCell>
                        <a
                          href={explorerUrl(w.address, "address", net)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 font-mono text-foreground hover:text-accent transition"
                        >
                          {shortAddress(w.address, 6, 6)}
                          <Icon name="arrow-up-right" className="h-3.5 w-3.5 text-muted" />
                        </a>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {fmtSolHuman(w.totalSol)}
                      </TableCell>
                      <TableCell className="text-center font-mono tabular-nums">{w.wins}</TableCell>
                      <TableCell>
                        {w.lastRound ? (
                          <a
                            href={`/rounds/${w.lastRound}`}
                            className="font-mono text-muted hover:text-accent transition"
                          >
                            Draw {w.lastRound}
                          </a>
                        ) : (
                          <span className="font-mono text-muted">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </TableContent>
            </Table.ScrollContainer>
          </Table>
        </div>
      )}
      {rows.length > 0 && (
        <p className="text-xs text-muted">
          {unique.toLocaleString("en-US")} unique {unique === 1 ? "wallet has" : "wallets have"} won
          {repeat > 0 &&
            ` · ${repeat.toLocaleString("en-US")} repeat ${repeat === 1 ? "win" : "wins"}`}
        </p>
      )}
    </div>
  );
}

function StatsSkeleton() {
  return (
    <>
      <div className="rounded-lg border border-(--border) bg-(--border) overflow-hidden">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px">
          {["Draws", "Paid out", "Biggest pool", "Eligible wallets"].map((l) => (
            <StatSkeleton key={l} label={l} />
          ))}
        </div>
      </div>
      <div className="rounded-lg border border-(--border) bg-surface">
        <div className="flex flex-col gap-3 border-b border-(--border) px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
          <Skeleton className="h-8 w-64 rounded-lg" />
        </div>
        <div className="px-5 py-4 flex flex-col gap-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-1 w-full" />
          <Skeleton className="h-3 w-full" />
        </div>
      </div>
      <div className="rounded-lg border border-(--border) bg-surface p-6 flex flex-col gap-4">
        <Skeleton className="h-5 w-32" />
        <SkeletonRows count={5} />
      </div>
    </>
  );
}

