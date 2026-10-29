"use client";

import { useEffect, useMemo, useState } from "react";
import { Chip } from "@heroui/react";
import { ExternalLink } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { Skeleton, SkeletonStat } from "@/components/ui";
import { fmtDateTimeUtc, shortAddress, explorerUrl, fmtSolHuman } from "@/lib/format";
import { nextCronOccurrence } from "@/lib/cron-next";

type LastRound = {
  roundNumber: number;
  status: string;
  prizePoolSol: number;
  eligibleCount: number;
  completedAt: string | null;
  randomnessRound: number | null;
  winners: {
    rank: number;
    address: string;
    amountSol: number;
    payoutTx: string | null;
    status: string;
  }[];
};

type StatusResp = {
  configured: boolean;
  network: "mainnet" | "devnet";
  lotteryCron: string;
  holderSyncCron: string;
  prizePoolSol: number;
  eligibleCount: number;
  totalHolders: number;
  knownHolders: number;
  lastRound: LastRound | null;
  lastSyncAt: string | null;
  solanaError: string | null;
  dbError: string | null;
};

function fmtDate(iso: string | null): string {
  // UTC (see fmtDateTimeUtc), not the visitor's clock.
  return fmtDateTimeUtc(iso);
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return "due now";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export default function LivePage() {
  const [data, setData] = useState<StatusResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await fetch("/api/status", { cache: "no-store" });
        const j = (await r.json()) as StatusResp;
        if (!alive) return;
        setData(j);
        setError(null);
      } catch (e) {
        if (alive) setError(String((e as Error).message ?? e));
      }
      if (alive) timer = setTimeout(poll, 5000);
    };
    poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const net = (data?.network ?? "mainnet") as "mainnet" | "devnet";
  const last = data?.lastRound ?? null;
  const drawing = last?.status === "drawing";
  const nextDraw = useMemo(
    () => (data ? nextCronOccurrence(data.lotteryCron, new Date(now)) : null),
    [data, now]
  );
  const countdown = nextDraw ? nextDraw.getTime() - now : null;

  return (
    <AppShell title="Live">
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-10 pt-12 sm:pt-16 pb-16 flex flex-col gap-8">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-muted">Live</p>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Live draw</h1>
          <p className="max-w-2xl text-base text-muted leading-relaxed">
            Watch the next draw approach in real time. The prize pool + eligible pool refresh every few seconds; when a
            round starts it goes <em>drawing</em>, then completed.
          </p>
        </header>

        {error && (
          <div className="rounded-lg border border-danger-200 bg-danger-50/50 p-4 text-sm text-danger">Error: {error}</div>
        )}

        {!data && !error && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="rounded-lg border border-(--border) bg-surface p-6 flex flex-col gap-2">
              <span className="text-xs font-mono uppercase text-muted">Next draw in</span>
              <Skeleton className="h-10 w-32" />
              <Skeleton className="h-3 w-44" />
              <Skeleton className="h-3 w-28 mt-1" />
            </div>
            <div className="rounded-lg border border-(--border) bg-surface p-6 flex flex-col gap-4 lg:col-span-2">
              <Skeleton className="h-5 w-28" />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
                <SkeletonStat label="Prize pool" />
                <SkeletonStat label="Eligible" />
                <SkeletonStat label="Total holders" />
                <SkeletonStat label="Last sync" />
              </div>
            </div>
          </div>
        )}

        {data && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="rounded-lg border border-(--border) bg-surface p-6 flex flex-col gap-2">
            <span className="text-xs font-mono uppercase text-muted">Next draw in</span>
            <span className="text-4xl font-bold tabular-nums tracking-tight">{countdown != null ? fmtCountdown(countdown) : "—"}</span>
            <span className="text-xs text-muted">{nextDraw ? `Scheduled ${fmtDate(nextDraw.toISOString())}` : `Schedule: ${data?.lotteryCron ?? "—"}`}</span>
            <span className="text-xs font-mono text-muted mt-1">cron: {data?.lotteryCron ?? "—"}</span>
          </div>

          <div className="rounded-lg border border-(--border) bg-surface p-6 flex flex-col gap-4 lg:col-span-2">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold tracking-tight">Current pool</h2>
              {drawing ? <Chip size="sm" variant="soft" color="warning">● drawing</Chip> : last?.status === "completed" ? <Chip size="sm" variant="soft" color="success">idle</Chip> : <Chip size="sm" variant="soft" color="default">waiting</Chip>}
            </div>
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-6 text-sm">
              <Field label="Prize pool" value={fmtSolHuman(data?.prizePoolSol ?? 0)} mono />
              <Field label="Eligible" value={String(data?.eligibleCount ?? 0)} mono />
              <Field label="Holders (current)" value={String(data?.totalHolders ?? 0)} mono />
              <Field label="Known all-time" value={String(data?.knownHolders ?? 0)} mono />
              <Field label="Last sync" value={fmtDate(data?.lastSyncAt ?? null)} />
            </dl>
            {drawing && <p className="text-sm text-warning">A draw is executing — winners + payouts settle shortly.</p>}
          </div>
        </div>
        )}

        {last && (
          <div className="rounded-lg border border-(--border) bg-surface p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold tracking-tight">Latest round</h2>
              <a href={`/rounds/${last.roundNumber}`} className="inline-flex items-center gap-1.5 text-sm text-accent transition hover:opacity-80">View round #{last.roundNumber}<ExternalLink className="h-3.5 w-3.5" strokeWidth={1.8} /></a>
            </div>
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-6 text-sm">
              <Field label="Round" value={`#${last.roundNumber}`} mono />
              <Field label="Status" value={last.status} mono />
              <Field label="Prize" value={fmtSolHuman(last.prizePoolSol)} mono />
              <Field label="Completed" value={fmtDate(last.completedAt)} />
            </dl>
            {last.winners.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs font-mono uppercase text-muted border-b border-(--border)"><th className="px-4 py-3">Rank</th><th className="px-4 py-3">Winner</th><th className="px-4 py-3 text-right">Payout</th><th className="px-4 py-3 text-center">Status</th></tr></thead>
                  <tbody className="divide-y divide-(--border)">
                    {last.winners.map((w) => (
                      <tr key={w.rank} className="hover:bg-default/40">
                        <td className="px-4 py-3 font-mono text-muted">{w.rank}</td>
                        <td className="px-4 py-3"><a href={explorerUrl(w.address, "address", net)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-mono text-foreground hover:text-accent transition">{shortAddress(w.address, 6, 6)}<ExternalLink className="h-3.5 w-3.5 text-muted" strokeWidth={1.8} /></a></td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums">{fmtSolHuman(w.amountSol)}</td>
                        <td className="px-4 py-3 text-center"><Chip size="sm" variant="soft" color={w.status === "sent" ? "success" : w.status === "failed" ? "danger" : "warning"}>{w.status}</Chip></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {data?.dbError && <div className="rounded-lg border border-danger-200 bg-danger-50/50 p-4 text-sm text-danger">DB error: {data.dbError}</div>}
        {data?.solanaError && <div className="rounded-lg border border-warning-200 bg-warning-50/50 p-4 text-sm text-warning">RPC unavailable: {data.solanaError}</div>}
      </main>
    </AppShell>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-mono uppercase text-muted">{label}</dt>
      <dd className={mono ? "font-mono tabular-nums" : ""}>{value}</dd>
    </div>
  );
}
