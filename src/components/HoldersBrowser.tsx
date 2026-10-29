"use client";

import { ReactNode, useEffect, useState } from "react";
import { CircleCheckBig, ShieldAlert } from "lucide-react";
import {
  Alert,
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
import {
  ExclusionLabelChip,
  VenueChip,
} from "@/components/ExclusionLabelChip";
import { CountUp, ExternalLink, Icon, Skeleton, SkeletonRows } from "@/components/ui";
import { explorerUrl, fmtTokenHuman, timeAgo } from "@/lib/format";

type Holder = {
  address: string;
  amount: string;
  amountHuman: string;
  eligible: boolean;
  /** On the admin draw-exclusion list (bonding curve, LP pool, vault…). */
  excluded?: boolean;
  /** Fees land here, so it is never in the draw (its own flag, not a label). */
  platform?: boolean;
  /** Why: auto venue (bonding curve / pool authority) or the admin blacklist. */
  excludedBy?: "venue" | "manual" | null;
  /** Venue name for `venue` rows, the organiser's label for `manual` rows. */
  excludedLabel?: string | null;
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

function shortAddr(addr: string, head = 6, tail = 6): string {
  if (!addr) return "";
  if (addr.length <= head + tail) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/** Reusable holders browser — stats grid + paginated token-holders table.
 *  Extracted from the old /holders page so it can live as a tab inside
 *  /eligibility. No AppShell wrapper (the host page provides chrome). */
export function HoldersBrowser({
  title = "Token holders",
  subtitle = "Every wallet holding the token, summed across token accounts and ranked by balance. Wallets at or above the minimum are in every draw.",
  children,
}: {
  title?: string;
  subtitle?: string;
  children?: ReactNode;
}) {
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

  const eligibleRate = data && data.total > 0
    ? Math.round((data.eligibleTotal / data.total) * 100)
    : 0;

  const thresholdNum = data
    ? parseFloat(fmtTokenHuman(data.minTokenEligibleRaw, data.tokenDecimals).replace(/,/g, "")) || 0
    : 0;

  // Bubblemaps indexes mainnet only, and only once we know the mint.
  const bubblemapsUrl =
    net === "mainnet" && data?.tokenMint
      ? `https://bubblemaps.io/solana/token/${data.tokenMint}`
      : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="max-w-3xl">
        <Typography type="h4">{title}</Typography>
        <Typography type="body-sm" color="muted" className="mt-1.5">
          {subtitle}
        </Typography>
      </div>
      {children}
      {!data && loading && (
        <div className="rounded-lg border border-(--border) bg-(--border) overflow-hidden">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-px">
            <StatSkeleton label="Wallets" />
            <StatSkeleton label="Eligible" />
            <StatSkeleton label="Minimum" />
            <StatSkeleton label="Eligible share" />
            <StatSkeleton label="Snapshot" className="col-span-2 sm:col-span-1" />
          </div>
        </div>
      )}

      {data && (
        <div className="rounded-lg border border-(--border) bg-(--border) overflow-hidden">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-px">
            <Stat label="Wallets" value={<CountUp value={data.total} />} caption="in the latest list" />
            <Stat label="Eligible" value={<CountUp value={data.eligibleTotal} />} caption="in every draw" />
            <Stat label="Minimum" value={<CountUp value={thresholdNum} format={(n) => n.toLocaleString("en-US", { maximumFractionDigits: 4 })} />} caption="to qualify" />
            <Stat label="Eligible share" value={<CountUp value={eligibleRate} format={(n) => `${Math.round(n)}%`} />} caption="of all holders" />
            <Stat label="Snapshot" value={timeAgo(data.capturedAt)} caption="last refreshed" className="col-span-2 sm:col-span-1" />
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger" title={error}>
          Couldn’t load the holder list. Refresh the page to try again.
        </div>
      )}

      <Alert
        status="warning"
        className="rounded-lg border border-(--border) shadow-none"
      >
        <Alert.Indicator>
          <ShieldAlert className="h-4 w-4" aria-hidden />
        </Alert.Indicator>
        <Alert.Content>
          <Alert.Title>Some wallets aren’t entered in the draw</Alert.Title>
          <Alert.Description>
            Liquidity accounts hold the token but can never win. Sybil clusters,
            bots and split wallets are dropped before the drand shuffle. Think
            it’s wrong? Check the clusters on{" "}
            {bubblemapsUrl ? (
              <ExternalLink
                href={bubblemapsUrl}
                tone="foreground"
                className="font-medium"
              >
                Bubblemaps
              </ExternalLink>
            ) : (
              <span className="text-foreground">Bubblemaps</span>
            )}{" "}
            first, then contact the team.
          </Alert.Description>
        </Alert.Content>
      </Alert>


      {loading ? (
        <div className="overflow-x-auto rounded-lg border border-(--border) bg-surface">
          <SkeletonRows count={8} className="px-4" />
        </div>
      ) : data && data.holders.length > 0 ? (
        <div className="table-bordered rounded-lg border border-(--border) overflow-hidden bg-surface">
          <Table variant="secondary">
            {/* Phones: the four columns need ~480px before the address and the
                status chip start wrapping mid-word. Below that the table pans
                sideways inside its own card instead of being clipped by
                .table-root's overflow: clip. */}
            <Table.ScrollContainer
              tabIndex={0}
              className="overscroll-x-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            >
              <TableContent aria-label="Token holders" className="min-w-[30rem] text-xs font-mono">
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
                          {h.eligible ? (
                            <Chip
                              size="sm"
                              variant="soft"
                              color="success"
                              className="gap-1"
                            >
                              <CircleCheckBig
                                className="h-3 w-3 shrink-0"
                                aria-hidden
                              />
                              Eligible
                            </Chip>
                          ) : h.platform ? (
                            <Chip size="sm" variant="soft" color="default">
                              Platform
                            </Chip>
                          ) : h.excluded ? (
                            <span className="inline-flex flex-col items-center gap-1">
                              {h.excludedBy === "venue" ? (
                                <VenueChip
                                  text="Venue"
                                  title={`${h.excludedLabel ?? "Venue account"}, holds the token as liquidity, so it is not in the draw.`}
                                />
                              ) : (
                                <ExclusionLabelChip label={h.excludedLabel} />
                              )}
                              {h.excludedBy === "venue" && h.excludedLabel && (
                                <span className="max-w-[160px] text-[10px] leading-tight text-muted">
                                  {h.excludedLabel}
                                </span>
                              )}
                            </span>
                          ) : (
                            <Chip size="sm" variant="soft" color="default">
                              Below minimum
                            </Chip>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </TableContent>
            </Table.ScrollContainer>
          </Table>
        </div>
      ) : (
        !error && <p className="text-sm text-muted">No wallets in the holder list yet.</p>
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
  );
}

function Stat({ label, value, caption, className = "" }: { label: string; value: ReactNode; caption: string; className?: string }) {
  return (
    <div className={`bg-surface px-4 sm:px-5 py-3 flex flex-col ${className}`}>
      <span className="text-sm text-muted">{label}</span>
      <span className="mt-1 text-xl sm:text-2xl font-medium tabular-nums leading-tight break-words text-foreground">
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
