"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  Separator,
} from "@heroui/react";
import type {
  CreatorFeeClaimRecord,
  CreatorFeeStatus,
} from "@/lib/pumpfun/creator-fees";
import { ExternalLink } from "@/components/ui";
import {
  explorerUrl,
  fmtDateTimeUtc,
  fmtSolHuman,
  fmtSolNum,
  lamportsToSol,
  shortAddress,
  timeAgo,
  SOL_ADMIN_DIGITS,
} from "@/lib/format";
// Chain-aware display unit ("SOL" on Solana, "ETH" on Robinhood Chain).
import { NATIVE_SYMBOL } from "@/lib/chain/network";

/**
 * Admin → Overview → Creator Fees.
 *
 * Read-only status from `GET /api/admin/creator-fees` (pumpdev balances +
 * shareholder split + signing-wallet balance + persisted auto-claim toggle),
 * a manual `Claim now` that signs & sends the pumpdev-built transaction, and a
 * toggle that flips the cron's auto-claim flag in the DB. Polls every 60s.
 *
 * Layout: headline pot → four cost/wallet stats (fee, minimum balance, net,
 * signer balance) → payout line → actions → claim history **table**. The table
 * replaced a wrapped flex row of chips, which turned unreadable as soon as a
 * claim carried an error message.
 */

type ClaimResponse = {
  ok?: boolean;
  signature?: string;
  amountLamports?: string;
  recipient?: string | null;
  error?: string;
  skipped?: boolean;
};

/** Claim history shows this many rows per page; the pager appears above that. */
const CLAIM_PAGE_SIZE = 3;

function statusColor(status: string): "success" | "warning" | "danger" {
  if (status === "confirmed") return "success";
  if (status === "failed") return "danger";
  return "warning";
}

function shortDate(iso: string): string {
  return fmtDateTimeUtc(iso);
}

/**
 * Browser `SendTransactionError` messages run to three sentences
 * ("Simulation failed. Message: Transaction simulation failed: … Catch the
 * `SendTransactionError` and call `getLogs()` on it for full details."), which
 * buries the actual cause in a table cell. Keep the cause, drop the boilerplate
 * — the untouched string stays in the cell's `title`.
 */
function shortNote(error: string): string {
  return error
    .replace(/^Simulation failed\. Message:\s*/i, "")
    .replace(/^Transaction simulation failed:\s*/i, "")
    .replace(/\s*Catch the `SendTransactionError`[\s\S]*$/i, "")
    .replace(/\s*Logs: \[[\s\S]*$/i, "")
    .trim();
}

/** One cell of the cost strip under the headline. */
function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  const toneClass =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : tone === "danger"
          ? "text-danger"
          : "";
  return (
    <div className="rounded-lg border border-(--border) px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-0.5 font-mono text-sm tabular-nums ${toneClass}`}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

function ClaimsTable({
  claims,
  net,
}: {
  claims: CreatorFeeClaimRecord[];
  net: "mainnet" | "devnet";
}) {
  if (claims.length === 0) {
    return (
      <p className="text-sm text-muted">
        No claims recorded yet — the first manual or auto claim shows up here.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-(--border)">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-surface-secondary text-xs uppercase tracking-wide text-muted">
            <th className="px-4 py-2 text-left font-medium">When</th>
            <th className="px-4 py-2 text-right font-medium">Amount</th>
            <th className="px-4 py-2 text-left font-medium">Source</th>
            <th className="px-4 py-2 text-left font-medium">Status</th>
            <th className="px-4 py-2 text-left font-medium">Note</th>
            <th className="px-4 py-2 text-right font-medium">Tx</th>
          </tr>
        </thead>
        <tbody>
          {claims.map((claim) => {
            const at = claim.confirmedAt ?? claim.createdAt;
            return (
              <tr
                key={claim.id}
                className="border-t border-(--border) align-top hover:bg-default/40"
              >
                <td className="whitespace-nowrap px-4 py-2">
                  <span className="block tabular-nums">{shortDate(at)}</span>
                  <span className="block text-xs text-muted">{timeAgo(at)}</span>
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right font-mono tabular-nums">
                  {fmtSolHuman(
                    lamportsToSol(BigInt(claim.amountLamports)),
                    SOL_ADMIN_DIGITS
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-muted">{claim.source}</td>
                <td className="px-4 py-2">
                  <Chip
                    size="sm"
                    variant="soft"
                    color={statusColor(claim.status)}
                  >
                    {claim.status}
                  </Chip>
                </td>
                <td className="max-w-[26rem] px-4 py-2 text-xs">
                  {claim.error ? (
                    <span
                      className="line-clamp-2 break-words text-danger"
                      title={claim.error}
                    >
                      {shortNote(claim.error)}
                    </span>
                  ) : claim.recipient ? (
                    <span className="text-muted">
                      {"→ "}
                      <span className="font-mono">
                        {shortAddress(claim.recipient, 6, 6)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-2 text-right">
                  {claim.signature ? (
                    <ExternalLink
                      href={explorerUrl(claim.signature, "tx", net)}
                      className="font-mono text-xs"
                    >
                      {shortAddress(claim.signature, 6, 6)}
                    </ExternalLink>
                  ) : (
                    <span className="text-xs text-muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CreatorFeesCard({
  net,
  onClaimed,
  refreshKey = 0,
}: {
  net: string;
  onClaimed?: () => void;
  /** Bumped by the admin page after a data reset (Settings → Danger zone).
   *  Re-polls immediately so a cleared claim history can't linger for a full
   *  60 s poll cycle. */
  refreshKey?: number;
}) {
  const [data, setData] = useState<CreatorFeeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"claim" | "auto" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Signature of the attempt just made, so the message carries a tx link. */
  const [txSig, setTxSig] = useState<string | null>(null);
  /** 1-based page of the claim history (3 rows per page). */
  const [page, setPage] = useState(1);

  const cluster: "mainnet" | "devnet" = net === "devnet" ? "devnet" : "mainnet";

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/creator-fees", {
        cache: "no-store",
      });
      const json = (await res.json().catch(() => null)) as
        | CreatorFeeStatus
        | { error?: string }
        | null;
      if (!res.ok) {
        throw new Error(json?.error ?? `Request failed (${res.status})`);
      }
      setData(json as CreatorFeeStatus);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 60_000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  // A page-wide refresh (data reset, sync, claim) bumps `refreshKey`; re-poll
  // right away instead of showing stale claims until the next 60 s tick. The
  // `> 0` guard keeps the initial mount from double-fetching.
  useEffect(() => {
    if (refreshKey > 0) fetchStatus();
  }, [refreshKey, fetchStatus]);

  const claim = async () => {
    setBusy("claim");
    setMsg(null);
    setErr(null);
    setTxSig(null);
    try {
      const res = await fetch("/api/admin/creator-fees/claim", {
        method: "POST",
      });
      const json = (await res.json().catch(() => null)) as ClaimResponse | null;
      if (json?.ok && json.amountLamports) {
        setMsg(
          `Claimed ${fmtSolHuman(
            lamportsToSol(BigInt(json.amountLamports)),
            SOL_ADMIN_DIGITS
          )} → ${shortAddress(json.recipient ?? "", 6, 6)}`
        );
        setTxSig(json.signature ?? null);
        onClaimed?.();
        // A fresh claim is the newest row — jump back to it.
        setPage(1);
      } else {
        setErr(json?.error ?? `Claim failed (${res.status})`);
        setTxSig(json?.signature ?? null);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      await fetchStatus();
    }
  };

  const toggleAuto = async () => {
    if (!data) return;
    setBusy("auto");
    setMsg(null);
    setErr(null);
    setTxSig(null);
    try {
      const res = await fetch("/api/admin/creator-fees/auto", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !data.auto.enabled }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; auto?: CreatorFeeStatus["auto"]; error?: string }
        | null;
      if (!res.ok || !json?.ok || !json.auto) {
        throw new Error(json?.error ?? `Request failed (${res.status})`);
      }
      setData({ ...data, auto: json.auto });
      setMsg(
        `Auto-claim ${
          json.auto.enabled ? "enabled" : "disabled"
        } — applies from the next cron tick.`
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };


  const snap = data?.snapshot ?? null;
  const claimableSol = snap ? lamportsToSol(BigInt(snap.totalLamports)) : null;
  const pumpSol = snap ? lamportsToSol(BigInt(snap.pumpLamports)) : 0;
  const pumpSwapSol = snap ? lamportsToSol(BigInt(snap.pumpSwapLamports)) : 0;
  const balanceSol = data?.platformBalanceSol ?? null;
  const prioritySol = data?.auto.priorityFeeSol ?? 0.0005;
  // Real cost of one claim: base signature fee + priority fee, plus the
  // rent-exempt floor the payer must keep afterwards (previously only
  // `minWalletSol` was checked, which let 0.0002 SOL pots through to a
  // simulation failure).
  const feeSol = data?.costs
    ? lamportsToSol(BigInt(data.costs.feeLamports))
    : 0.000505;
  const rentSol = data?.costs
    ? lamportsToSol(BigInt(data.costs.rentExemptLamports))
    : 0.00065024;
  const requiredSol = data?.costs
    ? lamportsToSol(BigInt(data.costs.requiredBalanceLamports))
    : Math.max(data?.auto.minWalletSol ?? 0.01, 0.0012);
  const netSol =
    data?.costs?.netLamports != null
      ? lamportsToSol(BigInt(data.costs.netLamports))
      : null;
  const feeShort = balanceSol != null && balanceSol < requiredSol;
  const potBelowFee = netSol != null && netSol <= 0;
  const paysElsewhere =
    !!snap && snap.hasFeeSharing && snap.payoutAddress !== data?.platformWallet;
  const autoOn = data?.auto.enabled ?? false;

  const claims = data?.claims ?? [];
  const confirmed = claims.filter((c) => c.status === "confirmed");
  const confirmedSol = confirmed.reduce(
    (sum, c) => sum + lamportsToSol(BigInt(c.amountLamports)),
    0
  );
  // Clamp instead of storing the clamp: a refresh that shortens the list (or a
  // claim that lands on page 1) can leave `page` past the end.
  const pageCount = Math.max(1, Math.ceil(claims.length / CLAIM_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * CLAIM_PAGE_SIZE;
  const visibleClaims = claims.slice(pageStart, pageStart + CLAIM_PAGE_SIZE);

  const disabledReason = !data
    ? "Loading creator-fee status…"
    : !data.configured
      ? "Platform wallet / token mint not configured."
      : !snap
        ? data.error ?? "Claimable balance unavailable."
        : claimableSol == null || claimableSol <= 0
          ? "Nothing to claim yet — fees accumulate as the token trades."
          : potBelowFee
            ? `Claimable ${fmtSolHuman(
                claimableSol,
                SOL_ADMIN_DIGITS
              )} is below the ${fmtSolHuman(
                feeSol,
                SOL_ADMIN_DIGITS
              )} claim fee — claiming now would lose {NATIVE_SYMBOL}. Wait for the pot to grow.`
            : feeShort
              ? `Platform wallet needs at least ${fmtSolHuman(
                  requiredSol,
                  SOL_ADMIN_DIGITS
                )} (${fmtSolHuman(
                  feeSol,
                  SOL_ADMIN_DIGITS
                )} fee + rent-exempt reserve) to pay the claim.`
              : null;

  const canClaim = !busy && !loading && disabledReason === null;

  return (
    <Card>
      <CardHeader className="flex flex-row gap-2 items-center">
        <p className="font-bold">Creator Fees</p>
        {loading && <span className="text-xs text-muted">loading…</span>}
        <span className="ml-auto flex items-center gap-2">
          {snap && (
            <span className="text-xs text-muted">
              checked {timeAgo(snap.checkedAt)}
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            onPress={fetchStatus}
            isDisabled={loading}
          >
            Refresh
          </Button>
        </span>
      </CardHeader>
      <Separator />
      <CardContent className="gap-4">
        <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
          <span className="text-3xl font-bold tabular-nums">
            {claimableSol != null
              ? fmtSolNum(claimableSol, SOL_ADMIN_DIGITS)
              : "—"}
          </span>
          <span className="mb-1 text-sm text-muted">{NATIVE_SYMBOL} claimable</span>
          {snap && (
            <span className="mb-1.5 text-xs text-muted">
              curve {fmtSolNum(pumpSol, SOL_ADMIN_DIGITS)} · pumpSwap{" "}
              {fmtSolNum(pumpSwapSol, SOL_ADMIN_DIGITS)}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="Claim fee"
            value={fmtSolHuman(feeSol, SOL_ADMIN_DIGITS)}
            hint={`5,000 lamports base + ${fmtSolHuman(
              prioritySol,
              SOL_ADMIN_DIGITS
            )} priority`}
          />
          <Stat
            label="Min wallet balance"
            value={fmtSolHuman(requiredSol, SOL_ADMIN_DIGITS)}
            hint={`fee + ${fmtSolHuman(
              rentSol,
              SOL_ADMIN_DIGITS
            )} rent-exempt reserve`}
          />
          <Stat
            label="Net if claimed"
            value={
              netSol != null
                ? `${netSol > 0 ? "+" : ""}${fmtSolHuman(
                    netSol,
                    SOL_ADMIN_DIGITS
                  )}`
                : "—"
            }
            tone={
              netSol == null ? "neutral" : netSol > 0 ? "success" : "danger"
            }
            hint="claimable − claim fee"
          />
          <Stat
            label="Signing wallet"
            value={
              balanceSol != null
                ? fmtSolHuman(balanceSol, SOL_ADMIN_DIGITS)
                : "—"
            }
            tone={feeShort ? "warning" : "success"}
            hint={
              feeShort
                ? `needs ≥ ${fmtSolHuman(requiredSol, SOL_ADMIN_DIGITS)}`
                : "covers fee + rent"
            }
          />
        </div>


        <div className="flex flex-wrap items-center gap-2 text-xs">
          {snap &&
            (paysElsewhere ? (
              <Chip size="sm" variant="soft" color="warning">
                pays → {shortAddress(snap.payoutAddress ?? "", 6, 6)}
              </Chip>
            ) : (
              <Chip size="sm" variant="soft" color="success">
                pays → platform wallet
              </Chip>
            ))}
          {snap?.hasFeeSharing && (
            <span className="text-muted">
              platform share {snap.platformSharePercent}%
            </span>
          )}
          {snap && !snap.isNativeQuote && (
            <Chip size="sm" variant="soft" color="warning">
              non-{NATIVE_SYMBOL} quote
            </Chip>
          )}
          {snap && snap.shareholders.length > 0 && (
            <span className="text-muted">
              {snap.shareholders
                .map((s) => `${shortAddress(s.address)} ${s.sharePercent}%`)
                .join(" · ")}
            </span>
          )}
          {data?.platformWallet && (
            <span className="ml-auto text-muted">
              signer{" "}
              <ExternalLink
                href={explorerUrl(data.platformWallet, "address", cluster)}
                tone="foreground"
                className="font-mono text-xs"
              >
                {shortAddress(data.platformWallet, 6, 6)}
              </ExternalLink>
            </span>
          )}
        </div>

        {paysElsewhere && (
          <p className="text-xs text-warning">
            On-chain fee sharing pays{" "}
            {shortAddress(snap?.payoutAddress ?? "", 6, 6)} — not the platform
            wallet. Make the platform/deployer wallet the 100% shareholder on
            pump.fun so claimed fees land in the prize pool.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            onPress={claim}
            isDisabled={!canClaim}
          >
            {busy === "claim" ? "Claiming…" : "Claim now"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onPress={toggleAuto}
            isDisabled={busy !== null || !data}
          >
            {busy === "auto"
              ? "Saving…"
              : `Auto-claim: ${autoOn ? "ON" : "OFF"}`}
          </Button>
          <span className="text-xs text-muted">
            auto ≥ {fmtSolHuman(data?.auto.minSol ?? 0, SOL_ADMIN_DIGITS)} · cron{" "}
            <span className="font-mono">
              {data?.auto.cron ?? "*/10 * * * *"}
            </span>
          </span>
        </div>


        {msg && (
          <p className="text-xs text-success">
            {msg}
            {txSig && (
              <>
                {" · "}
                <ExternalLink
                  href={explorerUrl(txSig, "tx", cluster)}
                  className="text-xs"
                >
                  view tx
                </ExternalLink>
              </>
            )}
          </p>
        )}
        {err && (
          <p className="text-xs text-danger">
            {err}
            {txSig && (
              <>
                {" · "}
                <ExternalLink
                  href={explorerUrl(txSig, "tx", cluster)}
                  className="text-xs"
                >
                  view tx
                </ExternalLink>
              </>
            )}
          </p>
        )}
        {!msg && !err && disabledReason && (
          <p
            className={
              potBelowFee || feeShort
                ? "text-xs text-warning"
                : "text-xs text-muted"
            }
          >
            {disabledReason}
          </p>
        )}
        {data?.error && data.error !== disabledReason && (
          <p className="text-xs text-muted">{data.error}</p>
        )}

        <Separator />
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="text-sm font-semibold">Claim history</p>
            <span className="text-xs text-muted">
              {claims.length === 0
                ? "nothing recorded yet"
                : `${claims.length} recent ${
                    claims.length === 1 ? "attempt" : "attempts"
                  } · ${confirmed.length} confirmed (${fmtSolHuman(
                    confirmedSol,
                    SOL_ADMIN_DIGITS
                  )})`}
            </span>
            {claims.length > CLAIM_PAGE_SIZE && (
              <span className="ml-auto text-xs tabular-nums text-muted">
                showing {pageStart + 1}–{pageStart + visibleClaims.length} of{" "}
                {claims.length}
              </span>
            )}
          </div>
          <ClaimsTable claims={visibleClaims} net={cluster} />
          {pageCount > 1 && (
            <div className="flex justify-end overflow-x-auto">
              <Pagination size="sm">
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious
                      isDisabled={currentPage <= 1}
                      onPress={() => setPage(Math.max(1, currentPage - 1))}
                    >
                      Prev
                    </PaginationPrevious>
                  </PaginationItem>
                  {Array.from({ length: pageCount }, (_, i) => i + 1).map(
                    (n) => (
                      <PaginationItem key={n}>
                        <PaginationLink
                          isActive={n === currentPage}
                          onPress={() => setPage(n)}
                        >
                          {n}
                        </PaginationLink>
                      </PaginationItem>
                    )
                  )}
                  <PaginationItem>
                    <PaginationNext
                      isDisabled={currentPage >= pageCount}
                      onPress={() =>
                        setPage(Math.min(pageCount, currentPage + 1))
                      }
                    >
                      Next
                    </PaginationNext>
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

