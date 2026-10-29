"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Chip,
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
import { explorerUrl, fmtDateUtc, fmtTokenHuman } from "@/lib/format";

type Holder = {
  address: string;
  amount: string;
  amountHuman: string;
  eligible: boolean;
  platform: boolean;
  excluded?: boolean;
};

type Resp = {
  network: string;
  tokenMint: string | null;
  tokenDecimals: number;
  minTokenEligibleRaw: string;
  minTokenEligibleHuman: string;
  capturedAt: string | null;
  total: number;
  eligibleTotal: number;
  page: number;
  pageSize: number;
  totalPages: number;
  holders: Holder[];
  dbError: string | null;
};

function fmtDate(iso: string | null): string {
  // UTC (see fmtDateUtc): a day boundary must not flip with the visitor's zone.
  return fmtDateUtc(iso);
}

function shortAddr(addr: string, head = 6, tail = 6): string {
  if (!addr) return "";
  if (addr.length <= head + tail) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export default function HoldersPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/holders?page=${page}`)
      .then((r) => r.json())
      .then((d: Resp) => {
        if (!alive) return;
        if (d.dbError) setError(d.dbError);
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
  }, [page]);

  const net = (data?.network ?? "mainnet") as "mainnet" | "devnet";
  // Chain-aware explorer link (see `explorerUrl` in @/lib/format).
  const explorer = (addr: string) => explorerUrl(addr, "address", net);

  return (
    <AppShell title="Holders">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-10 pt-8 sm:pt-10 pb-12 flex flex-col gap-6">
        <div className="max-w-3xl">
          <Typography type="h4">Token holders</Typography>
          <Typography type="body-sm" color="muted" className="mt-1.5">
            Live snapshot of every wallet holding the token, summed across token accounts and
            ranked by balance. Wallets meeting the eligibility threshold are entered into every draw.
          </Typography>
        </div>

        {loading && (
          <>
            <div className="rounded-lg border border-(--border) bg-default overflow-hidden">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-px">
                <StatSkeleton label="Total holders" />
                <StatSkeleton label="Eligible" />
                <StatSkeleton label="Threshold" />
                <StatSkeleton label="Snapshot" />
              </div>
            </div>
            <div className="overflow-x-auto rounded-lg border border-(--border) bg-surface">
              <SkeletonRows count={8} className="px-4" />
            </div>
          </>
        )}

        {data && (
          <div className="rounded-lg border border-(--border) bg-default overflow-hidden">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-px">
              <Stat label="Total holders" value={String(data.total)} caption="unique wallets" />
              <Stat label="Eligible" value={String(data.eligibleTotal)} caption="in every draw" />
              <Stat label="Threshold" value={fmtTokenHuman(data.minTokenEligibleRaw, data.tokenDecimals)} caption="min to qualify" />
              <Stat label="Snapshot" value={fmtDate(data.capturedAt)} caption="last sync" />
            </div>
          </div>
        )}

        {data?.tokenMint && (
          <div className="rounded-md border border-(--border) bg-default/40 px-4 py-3 text-sm">
            <p className="text-muted">
              Token mint{" "}
              <a href={explorer(data.tokenMint)} target="_blank" rel="noreferrer" className="font-mono text-foreground underline-offset-4 hover:text-accent hover:underline">
                {shortAddr(data.tokenMint)}
              </a>{" "}
              · Network <span className="font-mono">{data.network}</span>
            </p>
            <p className="mt-1 text-muted">
              Want to check your own wallet?{" "}
              <Link href="/eligibility" className="font-medium text-accent underline-offset-4 hover:underline">
                View eligibility →
              </Link>
            </p>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger">
            Couldn&apos;t load holders: {error}
          </div>
        )}

        {loading ? (
          <p className="text-sm text-muted">Loading holders…</p>
        ) : data && data.holders.length > 0 ? (
          <div className="table-bordered rounded-lg border border-(--border) overflow-hidden bg-surface">
            <Table variant="secondary">
              <TableContent aria-label="Token holders" className="text-xs font-mono">
                <TableHeader>
                  <TableColumn className="w-12">#</TableColumn>
                  <TableColumn isRowHeader>WALLET</TableColumn>
                  <TableColumn style={{ textAlign: "right" }}>BALANCE</TableColumn>
                  <TableColumn style={{ textAlign: "center" }}>STATUS</TableColumn>
                </TableHeader>
                <TableBody>
                  {data.holders.map((h, i) => {
                    const rank = (data.page - 1) * data.pageSize + i + 1;
                    return (
                      <TableRow key={h.address}>
                        <TableCell className="text-muted font-mono">{rank}</TableCell>
                        <TableCell>
                          <a href={explorer(h.address)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-mono text-foreground hover:text-accent transition">
                            {shortAddr(h.address)}
                            <Icon name="arrow-up-right" className="h-3.5 w-3.5 text-muted" />
                          </a>
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{h.amountHuman}</TableCell>
                        <TableCell className="text-center">
                          {h.platform ? (
                            <Chip size="sm" variant="soft" color="warning">
                              Platform
                            </Chip>
                          ) : h.excluded ? (
                            <Chip size="sm" variant="soft" color="warning">
                              Excluded
                            </Chip>
                          ) : (
                            <Chip size="sm" variant="soft" color={h.eligible ? "success" : "default"}>
                              {h.eligible ? "Eligible" : "Below"}
                            </Chip>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </TableContent>
            </Table>
          </div>
        ) : (
          !error && <p className="text-sm text-muted">No holders in the latest snapshot yet.</p>
        )}

        {data && data.totalPages > 1 && (
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="inline-flex items-center gap-1.5 rounded-md border border-(--border) px-4 py-2 text-sm font-medium text-foreground transition hover:bg-default/40 disabled:opacity-40"
            >
              <Icon name="arrow-left" className="h-4 w-4" /> Prev
            </button>
            <span className="text-sm text-muted font-mono">
              Page {data.page} of {data.totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
              disabled={page >= data.totalPages}
              className="inline-flex items-center gap-1.5 rounded-md border border-(--border) px-4 py-2 text-sm font-medium text-foreground transition hover:bg-default/40 disabled:opacity-40"
            >
              Next <Icon name="arrow-left" className="h-4 w-4 rotate-180" />
            </button>
          </div>
        )}
      </div>
    </AppShell>
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
      <Skeleton className="mt-1 h-6 w-24" />
      <Skeleton className="mt-1 h-3 w-16" />
    </div>
  );
}

