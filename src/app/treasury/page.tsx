"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowBigUp, Flame } from "lucide-react";
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
import { useSite } from "@/components/providers/SiteProvider";
import { ExternalLink, Icon, Skeleton, SkeletonRows } from "@/components/ui";
import { explorerUrl, fmtDateTimeUtc, shortAddress, SOL_BALANCE_DIGITS } from "@/lib/format";
// Chain-aware display unit: "SOL" on Solana, "ETH" on Robinhood Chain.
import { NATIVE_SYMBOL } from "@/lib/chain/network";
import { summarizeBuyback, type BuybackData } from "@/lib/buyback";

/** Public treasury snapshot from /api/wallets (addresses, balances, fee ledger). */
type WalletOverview = {
  network: "mainnet" | "devnet";
  reserveSol: number;
  feeBps: number;
  platform: { address: string | null; balanceSol: number | null };
  fee: {
    configured: boolean;
    address: string | null;
    balanceSol: number | null;
    totalEarnedSol: number;
    sweeps: number;
    ledgerAvailable: boolean;
  };
  generatedAt: string;
  error: string | null;
};

/** One paid-out draw, from /api/treasury/ledger (every draw, not a window). */
type LedgerRow = {
  roundNumber: number;
  at: string;
  payoutTx: string;
  paidSol: number;
  feeSol: number;
};

type LedgerResp = {
  rows: LedgerRow[];
  count: number;
  dbError: string | null;
};

/** One row in either tx table. Negative amount = SOL left the wallet. */
type TxRow = {
  signature: string;
  at: string;
  label: string;
  amountSol: number;
};

/** Rows per page in both tx tables — the ledger now holds every paid draw. */
const PAGE_SIZE = 5;

export default function TreasuryPage() {
  const [wallets, setWallets] = useState<WalletOverview | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  // Paid-out draws are only needed to reconstruct the two tx tables, so a
  // failure here hides the derived rows and marks the history incomplete
  // (never sample rows). /api/treasury/ledger returns every draw, not 50.
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [roundsError, setRoundsError] = useState<string | null>(null);
  // Buyback numbers are a hand-kept ledger in `data/buyback.json` (Admin →
  // Buyback), read through /api/buyback. A bad edit must not take the page
  // down: the card degrades to dashes and the banner explains why.
  const [buyback, setBuyback] = useState<BuybackData | null>(null);
  const [buybackError, setBuybackError] = useState<string | null>(null);

  /**
   * Light auto-refresh: the three fetches below used to run once on mount and
   * never again, so a draw that completed while this tab was open left both tx
   * tables empty until a manual reload (owner report, 2026-10-29). `tick` bumps
   * every 15 s while the tab is visible — the same cadence as the ledger's own
   * cache and as /draws — and each effect below re-runs on it.
   */
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        setTick((t) => t + 1);
      }
    }, 15_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let alive = true;
    fetch("/api/wallets", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: WalletOverview) => {
        if (!alive) return;
        setWallets(d);
        if (d.error) setWalletError(d.error);
      })
      .catch((e) => {
        if (!alive) return;
        setWalletError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [tick]);

  useEffect(() => {
    let alive = true;
    fetch("/api/treasury/ledger", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: LedgerResp) => {
        if (!alive) return;
        setLedger(d.rows ?? []);
        if (d.dbError) setRoundsError(d.dbError);
      })
      .catch((e) => {
        if (!alive) return;
        setRoundsError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [tick]);

  useEffect(() => {
    let alive = true;
    fetch("/api/buyback", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { buyback?: BuybackData; error?: string }) => {
        if (!alive) return;
        if (d.buyback) setBuyback(d.buyback);
        if (d.error) setBuybackError(d.error);
      })
      .catch((e) => {
        if (!alive) return;
        setBuybackError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [tick]);

  const net = wallets?.network ?? "mainnet";

  /**
   * Platform-wallet payouts, derived from the draw ledger: every completed draw
   * has one atomic payout tx that moves the winners' prizes — and, when a
   * treasury is configured, the fee sweep — out of the platform wallet. No
   * wallet-history indexer is needed: `payoutTx` is the on-chain receipt.
   */
  const platformTxs = useMemo(() => {
    const rows: TxRow[] = ledger
      .filter((r) => r.paidSol > 0)
      .map((r) => ({
        signature: r.payoutTx,
        at: r.at,
        label: `Prize payouts · draw #${r.roundNumber}`,
        amountSol: -r.paidSol,
      }))
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return { rows, live: rows.length > 0 };
  }, [ledger]);

  /**
   * Fee-wallet activity, derived from the same ledger. The engine sweeps the
   * platform fee to the treasury in the SAME atomic tx as the winner payouts,
   * so `payoutTx` is also the fee tx signature — no separate indexer needed.
   *
   * The buyback is paid out of this wallet too, so the ledger's `buy` legs are
   * appended as outflows: without them the table implies 100% of the fees are
   * still sitting here. Burn legs move tokens only (no SOL), so they stay in
   * the Buyback & burn table. No sample rows: an empty table plus one honest
   * sentence is the only way this list stays trustworthy.
   */
  const feeTxs = useMemo(() => {
    const rows: TxRow[] = ledger
      .filter((r) => r.feeSol > 0)
      .map((r) => ({
        signature: r.payoutTx,
        at: r.at,
        label: `Earned from draw #${r.roundNumber}`,
        amountSol: r.feeSol,
      }));

    for (const t of buyback?.txs ?? []) {
      if (t.kind !== "buy" || t.sol == null || t.sol <= 0) continue;
      rows.push({
        signature: t.signature,
        at: t.at,
        label: "Buyback purchase",
        amountSol: -t.sol,
      });
    }

    rows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return { rows, live: rows.length > 0, draws: ledger.length };
  }, [ledger, buyback]);

  /**
   * Fee rows are the real ledger, full stop. There used to be a `DEMO_FEE_TXS`
   * fallback with a "Sample" chip for the case "no draw has paid a fee yet" —
   * removed before launch: fake fee income on a public treasury page reads as
   * real revenue, and a chip is not enough of a disclaimer. An empty table with
   * one honest sentence is better than three invented rows.
   */
  const feeRows = feeTxs.rows;


  return (
    <AppShell title="Treasury">
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-10 pt-8 sm:pt-10 pb-12 flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="max-w-3xl">
            <Typography type="h4">Treasury</Typography>
            <Typography type="body-sm" color="muted" className="mt-1.5">
              Where the {NATIVE_SYMBOL} actually sits: the platform wallet that pays the winners, the fee wallet,
              every fee and payout on chain, and what the buyback programme has bought and burned.
            </Typography>
          </div>
          {wallets && (
            <span className="text-xs font-mono text-muted">
              updated {fmtTxDate(wallets.generatedAt)}
            </span>
          )}
        </div>

        {walletError && (
          <div
            className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
            title={walletError}
          >
            Some figures couldn’t be refreshed just now, so they may be out of date.
          </div>
        )}
        {roundsError && (
          <div
            className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
            title={roundsError}
          >
            The draw ledger couldn’t be read, so the payout and fee history below may be
            incomplete.
          </div>
        )}
        {buybackError && (
          <div
            className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
            title={buybackError}
          >
            The buyback ledger couldn’t be read, so its figures are unavailable.
          </div>
        )}

        {wallets || walletError ? (
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
              <WalletCard
                label="Platform wallet"
                net={net}
                address={wallets?.platform.address ?? null}
                balanceSol={wallets?.platform.balanceSol ?? null}
                caption="pays winner prizes and network fees"
                emptyNote={
                  wallets
                    ? "The platform wallet isn’t available yet."
                    : "Wallet details couldn’t be loaded just now."
                }
                txAria="Recent platform wallet transactions"
                txs={platformTxs.rows}
                txEmptyNote={
                  roundsError
                    ? "Payout history couldn’t be loaded."
                    : "No payout transaction yet. One appears when a draw settles."
                }
              />

              <WalletCard
                label="Fee wallet"
                net={net}
                address={wallets?.fee.address ?? null}
                balanceSol={
                  wallets?.fee.configured
                    ? wallets.fee.balanceSol
                    : wallets?.fee.ledgerAvailable
                      ? wallets.fee.totalEarnedSol
                      : null
                }
                caption={
                  !wallets
                    ? "balance unavailable"
                    : wallets.fee.configured
                      ? "platform fees are swept here at payout time, and buybacks are paid from it"
                      : wallets.fee.ledgerAvailable
                        ? "fees so far, still sitting on the platform wallet"
                        : "fee total unavailable because the fee ledger couldn’t be read"
                }
                emptyNote={
                  wallets
                    ? "Fees stay on the platform wallet. No separate fee wallet is in use."
                    : "Wallet details couldn’t be loaded just now."
                }
                txAria="Fee wallet activity, fees earned and buyback spends"
                txs={feeRows}
                txEmptyNote={
                  roundsError
                    ? "Fee history couldn’t be loaded."
                    : "No fees recorded yet — the first completed draw settles one."
                }
              />
            </div>

            <BuybackCard net={net} data={buyback} unavailable={!!buybackError} />

            <PolicyCard
              net={net}
              available={!!wallets}
              reserveSol={wallets?.reserveSol ?? 0.05}
              feeBps={wallets?.feeBps ?? 0}
              feeConfigured={wallets?.fee.configured ?? false}
              feeAddress={wallets?.fee.address ?? null}
              buybackSharePct={buyback?.feeSharePct ?? null}
            />
          </div>
        ) : (
          <TreasurySkeleton />
        )}
      </main>
    </AppShell>
  );
}

/**
 * One wallet, all in a single card: the on-chain balance with a one-line
 * explanation under it, the address, and the transaction ledger underneath — the
 * same header → table shape `BuybackCard` uses, so the page reads as three cards
 * instead of six floating ones.
 *
 * No derived figures under the balance on purpose — "prize pool", "reserve" and
 * "fee rate" all used to sit there and every one of them was already spelled out
 * in `PolicyCard` (or was balance minus reserve, which reads as a broken
 * `0.000000` on an empty wallet).
 */
function WalletCard({
  label,
  net,
  address,
  balanceSol,
  caption,
  emptyNote,
  txAria,
  txs,
  txEmptyNote,
}: {
  label: string;
  net: "mainnet" | "devnet";
  address: string | null;
  balanceSol: number | null;
  caption: string;
  emptyNote: string;
  txAria: string;
  txs: TxRow[];
  txEmptyNote: string;
}) {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-(--border) bg-surface">
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-tight">{label}</h2>
        </div>

        <div className="flex flex-col">
          <span className="text-xl sm:text-2xl font-semibold leading-tight tabular-nums tracking-tight break-words text-foreground">
            {balanceSol != null
              ? fmtSolPrecise(balanceSol, SOL_BALANCE_DIGITS)
              : "—"}
          </span>
          <span className="mt-0.5 text-xs text-muted">{caption}</span>
        </div>

        {address ? (
          // The address itself is plain text: a 44-char base58 string should never
          // be a click target (text selection and copy matter more). Only the
          // corner glyph opens the explorer.
          <div className="flex items-start gap-2 rounded-md bg-default px-2.5 py-1">
            <span className="min-w-0 flex-1 select-all break-all font-mono text-xs leading-5 text-foreground">
              {address}
            </span>
            <a
              href={explorerUrl(address, "address", net)}
              target="_blank"
              rel="noreferrer"
              title={`${address}, open on the explorer`}
              aria-label={`Open ${label} address on the explorer`}
              className="-mr-1.5 mt-px inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--border)"
            >
              <Icon name="arrow-up-right" className="h-3.5 w-3.5" />
            </a>
          </div>
        ) : (
          <span className="text-xs text-muted">{emptyNote}</span>
        )}
      </div>

      <TxTable aria={txAria} rows={txs} net={net} emptyNote={txEmptyNote} />
    </div>
  );
}


/**
 * Outbound tx link used by every table on this page. The signature itself is
 * noise for a public money page — 88 characters that wrap and that nobody
 * reads — so the cell is reduced to the corner glyph; `explorerUrl` carries the
 * signature and `title` / `aria-label` still announce the link as a
 * transaction. The glyph gets a 24px box with a hover background because a bare
 * 14px arrow at the right edge of a row is a poor click target.
 */
function TxLink({
  signature,
  net,
}: {
  signature: string;
  net: "mainnet" | "devnet";
}) {
  return (
    <a
      href={explorerUrl(signature, "tx", net)}
      target="_blank"
      rel="noreferrer"
      title="View transaction on the explorer"
      aria-label="View transaction on the explorer"
      className="inline-flex h-6 w-6 items-center justify-center rounded text-muted transition hover:bg-default/40 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--border)"
    >
      <Icon name="arrow-up-right" className="h-3.5 w-3.5" />
    </a>
  );
}


/**
 * Ledger body for a wallet card: compact, paginated, no card frame of its own —
 * it sits flush under the wallet header, separated by the one hairline on top,
 * exactly like the buyback table. The `aria` label keeps it announced correctly
 * for screen readers and only `PAGE_SIZE` rows render at a time, so a long
 * ledger can’t stretch the card.
 *
 * There is no sample/placeholder chip any more: both ledger tables only ever show
 * rows derived from the draw ledger (fee sweeps) or the hand-kept buyback file.
 *
 * Body type is Geist Sans, same 12px as the buyback ledger below (`.table-compact`
 * handles the size for both). These cells are labels, dates and SOL amounts — no
 * hashes — so `font-mono` only made the two cards read like a different app next
 * to the rest of the page. Amounts keep `tabular-nums`, which aligns digits the
 * way mono did.
 */
function TxTable({
  aria,
  rows,
  net,
  emptyNote = "No transactions recorded yet.",
}: {
  aria: string;
  rows: TxRow[];
  net: "mainnet" | "devnet";
  emptyNote?: string;
}) {
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  // Clamp instead of resetting: rows shrink after a refetch, and a reset effect
  // would fight the parent's memo identity.
  const current = Math.min(page, totalPages - 1);
  const start = current * PAGE_SIZE;
  const visible = rows.slice(start, start + PAGE_SIZE);

  if (rows.length === 0) {
    return (
      <p className="border-t border-(--border) px-5 py-4 text-sm text-muted">
        {emptyNote}
      </p>
    );
  }

  return (
    <div className="border-t border-(--border)">
      <div className="table-bordered table-compact">
        <Table variant="secondary">
          {/* HeroUI clips inside .table-root, so the pan happens in a scroll
              container just outside the <table>; narrow cards keep every column
              legible instead of cutting off the TX link. */}
          <Table.ScrollContainer
            tabIndex={0}
            className="overscroll-x-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          >
            <TableContent aria-label={aria} className="min-w-[21rem]">
              <TableHeader>
                <TableColumn isRowHeader>ACTIVITY</TableColumn>
                <TableColumn style={{ textAlign: "right" }}>AMOUNT</TableColumn>
                <TableColumn style={{ textAlign: "right" }}>TX</TableColumn>
              </TableHeader>
              <TableBody>
                {visible.map((t) => (
                  <TableRow key={`${t.signature}-${t.label}`}>
                    <TableCell className="whitespace-nowrap">
                      <span className="block text-foreground">{t.label}</span>
                      <span className="block text-[10px] text-muted">{fmtTxDate(t.at)}</span>
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums whitespace-nowrap ${
                        t.amountSol >= 0 ? "text-success" : "text-foreground"
                      }`}
                    >
                      {t.amountSol >= 0 ? "+" : "−"}
                      {fmtSolPrecise(Math.abs(t.amountSol))}
                    </TableCell>
                    <TableCell className="text-right">
                      <TxLink signature={t.signature} net={net} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </TableContent>
          </Table.ScrollContainer>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-2 border-t border-(--border) px-5 py-2">
          <span className="text-[11px] tabular-nums text-muted">
            {start + 1}–{start + visible.length} of {rows.length}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPage(Math.max(0, current - 1))}
              disabled={current === 0}
              className="inline-flex items-center gap-1 rounded-md border border-(--border) px-2 py-1 text-[11px] font-medium text-foreground transition hover:bg-default/40 disabled:opacity-40"
            >
              <Icon name="arrow-left" className="h-3 w-3" /> Prev
            </button>
            <span className="text-[11px] tabular-nums text-muted">
              {current + 1}/{totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage(Math.min(totalPages - 1, current + 1))}
              disabled={current >= totalPages - 1}
              className="inline-flex items-center gap-1 rounded-md border border-(--border) px-2 py-1 text-[11px] font-medium text-foreground transition hover:bg-default/40 disabled:opacity-40"
            >
              Next <Icon name="arrow-left" className="h-3 w-3 rotate-180" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


/**
 * Buyback / burn marker for the ledger's ACTIVITY cell. The old row tints
 * (`.tx-row--buy` / `--burn`) are gone — at 12px they turned whole rows into
 * status banners and the table read as a list of alerts. The kind is now a glyph
 * in a tinted chip instead: lucide `ArrowBigUp` in green for a buyback, `Flame`
 * in ink for a burn.
 *
 * The glyphs are painted **solid** (`fill="currentColor"` + a thin same-colour
 * stroke), not lucide's default hollow outline: at 12px an outline arrow/flame
 * reads as a stray squiggle next to the label. The chip is vertically centred by
 * the flex row in the cell, which aligns it against the two-line label + date
 * block rather than hanging it off the first line.
 *
 * The burn chip uses `--foreground` rather than a literal black: near-black text
 * in the light theme, near-white in dark, so it keeps its contrast instead of
 * vanishing into the dark surface. `aria-hidden` is set because the chip is
 * redundant — the label beside it already says Buyback or Burn.
 */
function KindBadge({ kind }: { kind: "buy" | "burn" }) {
  const buy = kind === "buy";
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] ${
        buy ? "bg-success/15 text-success" : "bg-foreground/10 text-foreground"
      }`}
    >
      {buy ? (
        <ArrowBigUp size={13} strokeWidth={1} fill="currentColor" />
      ) : (
        <Flame size={13} strokeWidth={1} fill="currentColor" />
      )}
    </span>
  );
}


/**
 * Buyback & burn, kept to three bands: the title, a strip of headline figures
 * (big enough to read at a glance — the table is the drill-down), and one
 * combined buy / burn table.
 *
 * Every figure is DERIVED from the hand-kept ledger in `data/buyback.json`
 * (Admin → Buyback), so the strip can never drift from the rows below it and
 * there is no "Sample" data to label: whatever is in that file is what the
 * programme did.
 */
function BuybackCard({
  net,
  data,
  unavailable,
}: {
  net: "mainnet" | "devnet";
  data: BuybackData | null;
  /** True when /api/buyback failed: figures are dashes, not zeros. */
  unavailable: boolean;
}) {
  const s = useMemo(() => (data ? summarizeBuyback(data) : null), [data]);
  const { tokenName } = useSite();
  const txs = data?.txs ?? [];
  const runs = s?.runs ?? 0;

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-(--border) bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold tracking-tight">Buyback &amp; burn</h2>
        </div>
        <span className="text-xs text-muted">
          {unavailable
            ? "ledger unavailable"
            : runs === 0
              ? "No runs yet"
              : `${runs} completed ${runs === 1 ? "run" : "runs"}${
                  data?.nextRunAt ? ` · next run ${fmtDayMonth(data.nextRunAt)}` : ""
                }`}
        </span>
      </div>

      {/* Hairline dividers come from the gap-px grid, same pattern as /stats. */}
      <dl className="grid grid-cols-1 gap-px border-y border-(--border) bg-(--border) sm:grid-cols-3">
        <BuybackStat
          label="Bought"
          value={s && s.bought > 0 ? s.bought.toLocaleString("en-US") : "—"}
          caption={
            unavailable
              ? "tokens unavailable"
              : s && s.bought > 0
                ? `${tokenName} tokens`
                : "no buybacks yet"
          }
        />
        <BuybackStat
          label="Burned"
          value={s && s.burned > 0 ? s.burned.toLocaleString("en-US") : "—"}
          caption={
            s && data && data.supply > 0
              ? `${s.burnedPct.toFixed(2)}% of supply`
              : unavailable
                ? "supply unavailable"
                : "supply not recorded"
          }
        />
        <BuybackStat
          label={`${NATIVE_SYMBOL} spent`}
          value={s && s.spentSol > 0 ? fmtSolPrecise(s.spentSol) : "—"}
          caption={
            unavailable
              ? "not available"
              : runs === 0
                ? "no runs yet"
                : `in ${runs} ${runs === 1 ? "run" : "runs"}`
          }
        />
      </dl>

      {txs.length === 0 ? (
        <p className="border-t border-(--border) px-5 py-4 text-sm text-muted">
          {unavailable
            ? "The buyback ledger couldn’t be loaded. Refresh the page to try again."
            : "No buyback recorded yet."}
        </p>
      ) : (
        <div className="table-bordered table-compact">
          <Table variant="secondary">
            <Table.ScrollContainer
              tabIndex={0}
              className="overscroll-x-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            >
              <TableContent
                aria-label="Buyback and burn transactions"
                className="min-w-[23rem]"
              >
                <TableHeader>
                  <TableColumn isRowHeader>ACTIVITY</TableColumn>
                  <TableColumn style={{ textAlign: "right" }}>SPENT</TableColumn>
                  <TableColumn style={{ textAlign: "right" }}>TOKENS</TableColumn>
                  <TableColumn style={{ textAlign: "right" }}>TX</TableColumn>
                </TableHeader>
                <TableBody>
                  {txs.map((t) => (
                    <TableRow key={t.signature}>
                      <TableCell className="whitespace-nowrap">
                        <span className="flex items-center gap-2">
                          <KindBadge kind={t.kind} />
                          <span className="flex flex-col">
                            <span className="text-foreground">
                              {t.kind === "buy" ? "Buyback" : "Burn"}
                            </span>
                            <span className="text-[10px] text-muted">
                              {fmtTxDate(t.at)}
                            </span>
                          </span>
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums whitespace-nowrap text-foreground">
                        {t.kind === "buy" && t.sol != null
                          ? `−${fmtSolPrecise(t.sol)}`
                          : "—"}
                      </TableCell>
                      <TableCell
                        className={`text-right tabular-nums whitespace-nowrap ${
                          t.kind === "buy" ? "text-success" : "text-foreground"
                        }`}
                      >
                        {t.kind === "buy" ? "+" : "−"}
                        {t.tokens.toLocaleString("en-US")}
                      </TableCell>
                      <TableCell className="text-right">
                        <TxLink signature={t.signature} net={net} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </TableContent>
            </Table.ScrollContainer>
        </Table>
      </div>
      )}
    </div>
  );
}


/**
 * One cell of the buyback headline strip. The caption rides inside the `<dd>`
 * so the `<dl>` grid stays valid markup while the number keeps the visual weight
 * of the `/stats` tiles.
 */
function BuybackStat({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption: string;
}) {
  return (
    <div className="flex flex-col bg-surface px-4 py-3 sm:px-5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-1 text-xl sm:text-2xl font-semibold leading-tight tabular-nums tracking-tight break-words text-foreground">
        {value}
        <span className="mt-0.5 block text-xs font-normal tracking-normal text-muted">
          {caption}
        </span>
      </dd>
    </div>
  );
}


/**
 * Plain-language money flow, kept to three rows: reserve, fee rate, and where
 * the fee goes. All of it is live — `/api/wallets` for the wallet config,
 * `/api/buyback` (the JSON ledger) for the buyback share — so no row is sample
 * data. The per-sweep count is dropped on purpose: it repeated the fee table.
 */
function PolicyCard({
  net,
  available,
  reserveSol,
  feeBps,
  feeConfigured,
  feeAddress,
  buybackSharePct,
}: {
  net: "mainnet" | "devnet";
  /** False when /api/wallets failed: the fallback numbers must not be printed. */
  available: boolean;
  reserveSol: number;
  feeBps: number;
  feeConfigured: boolean;
  feeAddress: string | null;
  buybackSharePct: number | null;
}) {
  const feePct = `${Number((feeBps / 100).toFixed(2))}%`;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-(--border) bg-surface px-5 py-4">
      <h2 className="text-sm font-semibold tracking-tight">How the money moves</h2>

      {!available ? (
        <p className="text-sm text-muted">
          Reserve and fee figures couldn’t be loaded. Refresh the page to try again.
        </p>
      ) : (
        <dl className="flex flex-col gap-2 text-sm">
          <PolicyRow label="Prize pool">
            Everything above the{" "}
            <span className="font-mono text-foreground">{fmtSolPrecise(reserveSol)}</span> reserve,
            which stays put for network fees.
          </PolicyRow>
          <PolicyRow label="Platform fee">
            <span className="font-mono text-foreground">{feePct}</span> of each pool, taken before
            winners split the rest.
          </PolicyRow>
          <PolicyRow label="Fee destination">
            {buybackSharePct != null ? (
              <>
                <span className="font-mono text-foreground">{buybackSharePct}%</span> of each fee
                goes to buybacks, paid from{" "}
              </>
            ) : (
              <>Buyback share unavailable right now. Fees are collected from{" "}</>
            )}
            {feeConfigured && feeAddress ? (
              <ExternalLink
                href={explorerUrl(feeAddress, "address", net)}
                tone="foreground"
                className="font-mono"
                iconClassName="h-3 w-3 opacity-50"
              >
                {shortAddress(feeAddress, 6, 6)}
              </ExternalLink>
            ) : (
              <span>the platform wallet</span>
            )}
            .
          </PolicyRow>
        </dl>
      )}

      <p className="text-xs text-muted">
        {available && <>Payouts and fee sweeps are public Solana transactions.{" "}</>}
        <Link href="/verify" className="text-foreground underline decoration-(--border) underline-offset-2 transition hover:text-accent">
          Verify a draw
        </Link>{" "}
        replays any round, and{" "}
        <Link href="/how-it-works" className="text-foreground underline decoration-(--border) underline-offset-2 transition hover:text-accent">
          how it works
        </Link>{" "}
        covers the fee maths.
      </p>
    </div>
  );
}

function PolicyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="max-w-2xl text-muted sm:text-right">{children}</dd>
    </div>
  );
}


/**
 * Placeholder that mirrors the real page's geometry: two wallet cards (header
 * block + ledger table in the same frame), then the buyback card (header +
 * three-figure strip + rows) and the policy card. The old version drew three
 * generic bars per card, split the ledger into its own bordered box and skipped
 * both bottom cards, so the page visibly jumped when data landed.
 */
function TreasurySkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-(--border) bg-surface"
          >
            <div className="flex flex-col gap-3 px-5 py-4">
              <Skeleton className="h-4 w-28" />
              <div className="flex flex-col gap-1">
                <Skeleton className="h-7 w-32" />
                <Skeleton className="h-3 w-44" />
              </div>
              <Skeleton className="h-7 w-full" />
            </div>
            <div className="border-t border-(--border) px-5 py-4">
              <SkeletonRows count={5} />
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-col overflow-hidden rounded-lg border border-(--border) bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-5 pt-4 pb-2">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3 w-24" />
        </div>
        <div className="grid grid-cols-1 gap-px border-y border-(--border) bg-(--border) sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-1 bg-surface px-4 py-3 sm:px-5">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>
        <div className="px-5 py-4">
          <SkeletonRows count={3} />
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-(--border) bg-surface px-5 py-4">
        <Skeleton className="h-4 w-40" />
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
        <Skeleton className="h-3 w-3/4" />
      </div>
    </div>
  );
}

/**
 * SOL with the treasury's own precision: 4 decimals like the rest of the app,
 * but the two wallet cards pass `SOL_BALANCE_DIGITS` (6) because they show a
 * real on-chain balance, where 0.00007475 SOL of swept dust must stay legible.
 */
function fmtSolPrecise(sol: number, digits: number = 4): string {
  const step = 1 / 10 ** digits;
  if (sol > 0 && sol < step / 2) return `<${step.toFixed(digits)} ${NATIVE_SYMBOL}`;
  return `${sol.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} ${NATIVE_SYMBOL}`;
}

/**
 * Fixed-format timestamp for tx rows. Uses explicit locale options (not
 * `dateStyle`) so the rows stay one line; falls back to the raw string when the
 * input isn't a parseable date.
 */
function fmtTxDate(iso: string): string {
  // UTC + an explicit zone label: this card used to render the visitor's local
  // time (e.g. 15:32 WIB next to an 08:32 UTC API value).
  return fmtDateTimeUtc(iso);
}

/**
 * Day + short month ("Oct 20") for the buyback stat strip, where a full
 * timestamp would push the tile onto two lines. Pinned to UTC so the server and
 * client render the same day (a fixed ISO sample must not flip by timezone).
 */
function fmtDayMonth(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}


