"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  Chip,
  Input,
  Label,
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  Separator,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableContent,
  TableHeader,
  TableRow,
  Tabs,
  TextField,
} from "@heroui/react";
import { useTheme } from "@/lib/use-theme";
import { useSite } from "@/components/providers/SiteProvider";
import { Skeleton } from "@/components/ui";
import { SeoPanel } from "@/components/admin/SeoPanel";
import { PalettePanel } from "@/components/admin/PalettePanel";
import { FontPanel } from "@/components/admin/FontPanel";
import { BuybackPanel } from "@/components/admin/BuybackPanel";
import { CreatorFeesCard } from "@/components/admin/CreatorFeesCard";
import { ExclusionsCard } from "@/components/admin/ExclusionsCard";
import { TelegramBotPanel } from "@/components/admin/TelegramBotPanel";
import { CacheCard } from "@/components/admin/CacheCard";
import { ExclusionLabelChip } from "@/components/ExclusionLabelChip";
import { nextCronOccurrence } from "@/lib/cron-next";
import {
  fmtDateTimeUtc,
  formatSol,
  fmtSolHuman,
  fmtTokenHuman,
  lamportsToSol,
  SOL_ADMIN_DIGITS,
  explorerUrl,
} from "@/lib/format";
// Chain-aware display unit ("SOL" on Solana, "ETH" on Robinhood Chain).
import { NATIVE_SYMBOL } from "@/lib/chain/network";

type Winner = {
  rank: number;
  address: string;
  amountLamports: string;
  amountSol: number;
  payoutTx: string | null;
  status: string;
};
type LastRound = {
  roundNumber: number;
  status: string;
  prizePoolSol: number;
  eligibleCount: number;
  completedAt: string | null;
  error: string | null;
  randomnessValue: string | null;
  randomnessSignature: string | null;
  randomnessRound: number | null;
  randomnessVerified: boolean;
  // Platform fee taken from this round's pool (lamports, BigInt→string).
  // Null for rounds drawn before the PLATFORM_FEE_BPS feature existed.
  platformFeeLamports: string | null;
  winners: Winner[];
};
type Status = {
  configured: boolean;
  network: string;
  tokenMint: string | null;
  lotteryCron: string;
  prizePoolSol: number;
  eligibleCount: number;
  totalHolders: number;
  knownHolders: number;
  lastRound: LastRound | null;
  lastSyncAt: string | null;
  dbError: string | null;
  solanaError: string | null;
};
type DrandChain = {
  name: string;
  hash: string;
  publicKey: string;
  scheme: string;
  period: number;
  verifyBaseUrl: string;
};
type RoundWinner = {
  rank: number;
  address: string;
  amountSol: number;
  payoutTx: string | null;
  status: string;
};
type RoundItem = {
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
  payoutTx: string | null;
  payoutFeeLamports: string | null;
  platformFeeLamports: string | null;
  winners: RoundWinner[];
};
type RoundsResp = {
  network: string;
  chain: DrandChain;
  rounds: RoundItem[];
  dbError: string | null;
};
type AppInfo = {
  network: string;
  platformWallet: { address: string; solBalance: number | null } | null;
  treasuryWallet: { address: string; solBalance: number | null } | null;
  rpcUrl: string | null;
  publicRpcUrl: string;
  heliusApiKeySet: boolean;
  tokenMint: string | null;
  tokenDecimals: number;
  lotteryCron: string;
  holderSyncCron: string;
  lotteryEnabled: boolean;
  minTokenEligibleRaw: string;
  minTokenHuman: string;
  winnerCount: number;
  payoutDistribution: number[];
  prizeReserveSol: number;
  platformFeeBps: number;
  totalPlatformFeeLamports: string;
  // Cumulative paid-out amount across all winners actually "sent"
  // (BigInt → string) + distinct wallet count that has ever won.
  totalPaidLamports: string;
  totalWinnerWallets: number;
  drawingRoundNumber: number | null;
  // Per-status round counts (engine-terminal statuses only) + readable SOL
  // values for the max prize cap and min prize threshold. 0 = disabled.
  totalCompletedRounds: number;
  totalSkippedRounds: number;
  totalFailedRounds: number;
  maxPrizeSol: number;
  minPrizeSol: number;
  databaseUrl: string | null;
  adminUsername: string;
  drand: DrandChain;
};
type Holder = {
  address: string;
  amount: string;
  eligible: boolean;
  platform: boolean;
  excluded: boolean;
  /** Why it's out of the draw: auto venue PDA vs the admin blacklist. */
  excludedBy?: "venue" | "manual" | null;
  /** Venue name ("pump.fun bonding curve") or the admin label for manual rows. */
  excludedLabel?: string | null;
};
type HoldersResp = {
  network: string;
  tokenDecimals: number;
  minTokenEligibleRaw: string;
  capturedAt: string | null;
  total: number;
  eligibleTotal: number;
  excludedTotal: number;
  knownTotal: number;
  platformAddress: string | null;
  holders: Holder[];
  dbError: string | null;
};
type LogEntry = {
  id: number;
  ts: string;
  level: "info" | "success" | "warn" | "error";
  source: string;
  message: string;
};
type VerifyState = "idle" | "checking" | "match" | "mismatch" | "error";

const shortAddr = (a: string, h = 4, t = 4): string =>
  !a || a.length <= h + t ? a : `${a.slice(0, h)}…${a.slice(-t)}`;
// Chain-aware explorer link (see `explorerUrl` in @/lib/format); the local
// solscan.io copy was removed 2026-10-29 (Phase 3).
const explorer = (v: string, kind: "address" | "tx", net: string): string =>
  explorerUrl(v, kind, net === "devnet" ? "devnet" : "mainnet");
const fmtTime = (iso: string | null): string => fmtDateTimeUtc(iso);
/**
 * Build a compact page list for pagination: always includes the first and last
 * page, a window of `siblings` pages around `current`, and ellipsis markers
 * where pages are skipped. Keeps the pagination bar from stretching wide when
 * there are many holders (e.g. 500 holders -> 50 pages).
 *
 * Example: pageItems(5, 50, 1) -> [1, "ellipsis", 4, 5, 6, "ellipsis", 50]
 */
function pageItems(
  current: number,
  total: number,
  siblings = 1
): (number | "ellipsis")[] {
  if (total <= 1) return total === 1 ? [1] : [];
  // With first + last + up to 2 ellipses + a (2*siblings+1) page window,
  // showing every page is fine up to this threshold.
  if (total <= 2 * siblings + 5) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const items: (number | "ellipsis")[] = [1];
  const left = Math.max(2, current - siblings);
  const right = Math.min(total - 1, current + siblings);
  if (left > 2) items.push("ellipsis");
  for (let p = left; p <= right; p++) items.push(p);
  if (right < total - 1) items.push("ellipsis");
  items.push(total);
  return items;
}

/** Icon-only copy-to-clipboard button built on HeroUI `Button`.
 *  Swaps to a check icon briefly on success. */
function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      isIconOnly
      size="sm"
      variant="ghost"
      aria-label={label}
      onPress={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable (non-secure context) */
        }
      }}
    >
      {copied ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </Button>
  );
}

/** Compact label+value stat tile for dashboard summaries. */
const StatTile = ({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) => (
  <div className="rounded-lg border border-(--border) bg-default/40 px-3 py-2.5 flex flex-col gap-0.5">
    <span className="text-xs text-muted">{label}</span>
    <span className="text-base font-semibold tabular-nums">{value}</span>
    {hint && <span className="text-xs text-muted">{hint}</span>}
  </div>
);

/** Wallet stat tile: pairs a SOL balance with its wallet address (short,
 *  explorer-linked, copy-to-clipboard) in one tile so the balance and the
 *  address it belongs to are never split apart. Mirrors StatTile styling. */
function WalletTile({
  label,
  balanceSol,
  address,
  net,
  hint,
  emptyLabel = "not configured",
}: {
  label: string;
  balanceSol: number | null;
  address: string | null;
  net: string;
  hint?: string;
  emptyLabel?: string;
}) {
  return (
    <div className="rounded-lg border border-(--border) bg-default/40 px-3 py-2.5 flex flex-col gap-0.5">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-base font-semibold tabular-nums">
        {balanceSol != null
          ? fmtSolHuman(balanceSol, SOL_ADMIN_DIGITS)
          : "—"}
      </span>
      {address ? (
        <div className="flex items-center gap-1.5">
          <a
            href={explorer(address, "address", net)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs text-accent underline underline-offset-2"
          >
            {shortAddr(address, 4, 4)}
          </a>
          <CopyButton value={address} label="Copy address" />
        </div>
      ) : (
        <span className="text-xs text-muted">{emptyLabel}</span>
      )}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}

/** Live client-side verification: fetches the same drand round straight from
 *  drand.sh (CORS-open) and checks the returned randomness equals our stored
 *  value. No backend round-trip — anyone can audit the draw. */
function VerifyButton({
  round,
  value,
  verifyBaseUrl,
}: {
  round: number;
  value: string;
  verifyBaseUrl: string;
}) {
  const [state, setState] = useState<VerifyState>("idle");
  const [detail, setDetail] = useState<string | null>(null);

  async function verify() {
    setState("checking");
    setDetail(null);
    try {
      const res = await fetch(`${verifyBaseUrl}/${round}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { randomness?: string };
      const got = (j.randomness ?? "").toLowerCase();
      if (got && got === value.toLowerCase()) {
        setState("match");
        setDetail("drand.sh randomness matches our stored value");
      } else {
        setState("mismatch");
        setDetail(`drand.sh returned ${got || "(empty)"}`);
      }
    } catch (e) {
      setState("error");
      setDetail((e as Error).message);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        onPress={verify}
        isPending={state === "checking"}
      >
        Verify on drand.sh
      </Button>
      <a
        href={`${verifyBaseUrl}/${round}`}
        target="_blank"
        rel="noreferrer"
        className="text-accent text-small underline"
      >
        open beacon ↗
      </a>
      {state === "match" && (
        <Chip size="sm" color="success">
          ✓ Matches drand.sh
        </Chip>
      )}
      {state === "mismatch" && (
        <Chip size="sm" color="danger">
          ✗ Mismatch
        </Chip>
      )}
      {state === "error" && (
        <Chip size="sm" color="warning">
          ! Error
        </Chip>
      )}
      {detail && (
        <span className="text-xs text-muted">{detail}</span>
      )}
    </div>
  );
}

type SettingItem = {
  key: string;
  /** Env var that supplies the value — the same string as `key`. */
  envVar: string;
  label: string;
  description: string;
  group: string;
  value: string;
  /** "env" when `.env` supplies it, "default" when the built-in fallback applies. */
  source: "env" | "default";
  /** Validation message for a malformed env value, else null. */
  problem: string | null;
};
type SettingsView = {
  items: SettingItem[];
  lotteryEnabled: boolean;
  inProduction: boolean;
  nextDrawAt: string | null;
  nextSyncAt: string | null;
};

function fmtCountdown(target: Date | null): string {
  if (!target) return "—";
  const ms = target.getTime() - Date.now();
  if (ms <= 0) return "due";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** DB enums never reach the screen: these two maps are the only place a raw
 *  `completed` / `skipped` / `sent` string turns into a word. Unknown values
 *  fall through unchanged so a new engine status can never render blank. */
const ROUND_STATUS_LABEL: Record<string, string> = {
  completed: "Done",
  skipped: "Skipped",
  failed: "Failed",
  running: "Running",
  pending: "Pending",
};
const PAYOUT_STATUS_LABEL: Record<string, string> = {
  sent: "Paid",
  pending: "Pending",
  failed: "Failed",
};
const roundStatus = (s: string) => ROUND_STATUS_LABEL[s] ?? s;
const payoutStatus = (s: string) => PAYOUT_STATUS_LABEL[s] ?? s;

/** Last-draw detail block for the admin overview: header (round #, status,
 *  time, beacon-verified, error) + four summary tiles (prize pool, eligible,
 *  platform fee earned, winners) + a winners table capped at the top 5.
 *  Mirrors the rounds-detail winners table styling. */
function LastDrawBlock({ last, net }: { last: LastRound | null; net: string }) {
  if (!last) {
    return <p className="text-sm text-muted">No draws yet.</p>;
  }

  const feeSol =
    last.platformFeeLamports != null
      ? lamportsToSol(BigInt(last.platformFeeLamports))
      : 0;
  const feeEarned =
    last.platformFeeLamports != null && BigInt(last.platformFeeLamports) > 0n;
  const shown = last.winners.slice(0, 5);
  const moreCount = Math.max(0, last.winners.length - shown.length);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">Last draw</span>
        <Chip size="sm" variant="soft">
          #{last.roundNumber}
        </Chip>
        <Chip
          size="sm"
          variant="soft"
          color={
            last.status === "completed"
              ? "success"
              : last.status === "failed"
              ? "danger"
              : last.status === "skipped"
              ? "default"
              : "warning"
          }
        >
          {roundStatus(last.status)}
        </Chip>
        {last.completedAt && (
          <span className="text-xs text-muted">
            {fmtTime(last.completedAt)}
          </span>
        )}
        {last.randomnessVerified && (
          <Chip size="sm" color="success" variant="soft">
            ✓ beacon verified
          </Chip>
        )}
        {last.error && (
          <span className="text-xs text-danger">{last.error}</span>
        )}
        <Link
          href={`/rounds/${last.roundNumber}`}
          className="ml-auto text-xs text-accent underline underline-offset-2"
        >
          View draw →
        </Link>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile
          label="Prize pool"
          value={fmtSolHuman(last.prizePoolSol, SOL_ADMIN_DIGITS)}
        />
        <StatTile
          label="Eligible"
          value={String(last.eligibleCount)}
          hint="holders in draw"
        />
        <StatTile
          label="Platform fee"
          value={fmtSolHuman(feeSol, SOL_ADMIN_DIGITS)}
          hint={feeEarned ? "earned in this draw" : "no cut"}
        />
        <StatTile label="Winners" value={String(last.winners.length)} />
      </div>

      {/* winners table (top 5) */}
      {shown.length === 0 ? (
        <p className="text-sm text-muted">No winners in this draw.</p>
      ) : (
        <div className="table-bordered rounded-lg border border-(--border) overflow-hidden bg-surface">
          <Table variant="secondary">
            <TableContent
              aria-label="Last draw winners"
              className="text-xs font-mono"
            >
              <TableHeader>
                <TableColumn className="w-12">RANK</TableColumn>
                <TableColumn isRowHeader>WINNER</TableColumn>
                <TableColumn style={{ textAlign: "right" }}>PAYOUT</TableColumn>
                <TableColumn style={{ textAlign: "center" }}>STATUS</TableColumn>
                <TableColumn>TX</TableColumn>
              </TableHeader>
              <TableBody>
                {shown.map((w) => (
                  <TableRow key={w.rank}>
                    <TableCell className="text-muted font-mono">
                      {w.rank}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <a
                          href={explorer(w.address, "address", net)}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-accent underline underline-offset-2"
                        >
                          {shortAddr(w.address, 4, 4)}
                        </a>
                        <CopyButton value={w.address} label="Copy address" />
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {fmtSolHuman(w.amountSol, SOL_ADMIN_DIGITS)}
                    </TableCell>
                    <TableCell className="text-center">
                      <Chip
                        size="sm"
                        variant="soft"
                        color={
                          w.status === "sent"
                            ? "success"
                            : w.status === "failed"
                            ? "danger"
                            : "warning"
                        }
                      >
                        {payoutStatus(w.status)}
                      </Chip>
                    </TableCell>
                    <TableCell>
                      {w.payoutTx ? (
                        <a
                          href={explorer(w.payoutTx, "tx", net)}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-accent underline underline-offset-2"
                        >
                          {shortAddr(w.payoutTx, 4, 4)}
                        </a>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </TableContent>
          </Table>
        </div>
      )}
      {moreCount > 0 && (
        <p className="text-xs text-muted">
          +{moreCount} more winner{moreCount === 1 ? "" : "s"} — view the full
          list on the draw page.
        </p>
      )}
    </div>
  );
}

/** Project status card for the overview — the single place live pool state
 *  lives: draw status (running indicator or a next-draw countdown while
 *  auto-draw is on), prize pool available now, eligible wallets (with the
 *  minimum token threshold), holders, cumulative paid-out SOL, distinct winning
 *  wallets, all-time draw counts, prize caps and the network, plus live
 *  platform-wallet + platform-fee balances with their addresses. Below a
 *  separator, the last-draw summary (prize, eligible, platform fee earned,
 *  winners) + a top-5 winners table. The next cron occurrence is recomputed
 *  client-side from the effective lottery cron so the countdown stays accurate
 *  without re-fetching. */
function LiveStatusCard({
  info,
  status,
  net,
}: {
  info: AppInfo | null;
  status: Status | null;
  net: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const cron = info?.lotteryCron ?? "0 * * * *";
  const enabled = info?.lotteryEnabled ?? false;
  const nextDraw = enabled ? nextCronOccurrence(cron, new Date(now)) : null;
  const last = status?.lastRound ?? null;

  return (
    <Card>
      <CardHeader className="flex flex-row gap-2 items-center">
        <p className="font-bold">Project Status</p>
        <Chip size="sm" variant="soft" color={enabled ? "success" : "warning"}>
          {enabled ? "draws on" : "draws paused"}
        </Chip>
        {info?.drawingRoundNumber != null && (
          <Chip size="sm" variant="soft" color="warning">
            ● draw #{info.drawingRoundNumber} running…
          </Chip>
        )}
        {info && (
          <span className="ml-auto text-xs text-muted">
            cron <span className="font-mono">{info.lotteryCron}</span>
          </span>
        )}
      </CardHeader>
      <Separator />
      <CardContent className="gap-4">
        {/* --- live tiles: what the next draw sees right now --- */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatTile
            label="Draw status"
            value={
              info?.drawingRoundNumber != null
                ? `Running #${info.drawingRoundNumber}`
                : enabled
                ? fmtCountdown(nextDraw)
                : "Paused"
            }
            hint={
              info?.drawingRoundNumber != null
                ? "in progress"
                : nextDraw
                ? fmtDateTimeUtc(nextDraw)
                : undefined
            }
          />
          <StatTile
            label="Prize pool"
            value={status ? fmtSolHuman(status.prizePoolSol, SOL_ADMIN_DIGITS) : "—"}
            hint="available now"
          />
          <StatTile
            label="Eligible"
            value={status ? String(status.eligibleCount) : "—"}
            hint={
              info ? `min ${info.minTokenHuman} to qualify` : "holders in draw"
            }
          />
          <StatTile
            label="Holders"
            value={status ? String(status.totalHolders) : "—"}
            hint={status ? `${status.knownHolders} known all-time` : undefined}
          />
        </div>

        {/* --- all-time tiles --- */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatTile
            label="Total paid"
            value={fmtSolHuman(
              lamportsToSol(BigInt(info?.totalPaidLamports ?? "0")),
              SOL_ADMIN_DIGITS
            )}
            hint="cumulative payouts"
          />
          <StatTile
            label="Winners"
            value={String(info?.totalWinnerWallets ?? 0)}
            hint="distinct wallets won"
          />
          <StatTile
            label="Completed"
            value={String(info?.totalCompletedRounds ?? 0)}
            hint="successful draws"
          />
          <StatTile
            label="Skipped"
            value={String(info?.totalSkippedRounds ?? 0)}
            hint="below min prize"
          />
        </div>

        {/* --- limits + chain --- */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatTile
            label="Failed"
            value={String(info?.totalFailedRounds ?? 0)}
            hint="errors"
          />
          <StatTile
            label="Max prize"
            value={
              info && info.maxPrizeSol > 0
                ? fmtSolHuman(info.maxPrizeSol, SOL_ADMIN_DIGITS)
                : "no cap"
            }
            hint="MAX_PRIZE_SOL"
          />
          <StatTile
            label="Min prize"
            value={
              info && info.minPrizeSol > 0
                ? fmtSolHuman(info.minPrizeSol, SOL_ADMIN_DIGITS)
                : "no min"
            }
            hint="MIN_PRIZE_SOL"
          />
          <StatTile
            label="Network"
            value={net}
            hint={
              info?.tokenMint
                ? `mint ${shortAddr(info.tokenMint, 4, 4)}`
                : undefined
            }
          />
        </div>

        {/* --- wallet tiles --- */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <WalletTile
            label="Platform wallet"
            balanceSol={info?.platformWallet?.solBalance ?? null}
            address={info?.platformWallet?.address ?? null}
            net={net}
            hint={`reserve ${fmtSolHuman(
              info?.prizeReserveSol ?? 0,
              SOL_ADMIN_DIGITS
            )}`}
          />
          <WalletTile
            label="Platform fee"
            balanceSol={
              info?.treasuryWallet?.solBalance != null
                ? info.treasuryWallet.solBalance
                : info?.totalPlatformFeeLamports
                  ? lamportsToSol(BigInt(info.totalPlatformFeeLamports))
                  : 0
            }
            address={info?.treasuryWallet?.address ?? null}
            net={net}
            hint={
              info?.platformFeeBps != null
                ? `${(info.platformFeeBps / 100).toLocaleString("en-US", {
                    maximumFractionDigits: 2,
                  })}% per draw`
                : undefined
            }
            emptyLabel="stays on platform wallet"
          />
        </div>

        {/* --- last draw --- */}
        <Separator />
        <LastDrawBlock last={last} net={net} />
      </CardContent>
    </Card>
  );
}

/** Read-only settings summary. Every value comes straight from `.env` (see
 *  lib/settings.ts) — there is no write path any more, so the panel shows what
 *  the running process loaded plus the env var that feeds each value.
 *  Editing a value = edit `.env` + restart the server. */
function SettingsSummary() {
  const [view, setView] = useState<SettingsView | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const fetchView = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/settings", { cache: "no-store" });
      if (r.ok) {
        setView((await r.json()) as SettingsView);
        setErr(null);
      } else {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setErr(d.error || `Could not load settings (${r.status})`);
      }
    } catch {
      setErr("Network error");
    }
  }, []);

  useEffect(() => {
    fetchView();
  }, [fetchView]);

  const GROUPS: { id: string; label: string }[] = [
    { id: "eligibility", label: "Eligibility" },
    { id: "winners", label: "Winners & payout" },
    { id: "payout", label: "Prize reserve" },
    { id: "schedule", label: "Schedules" },
  ];

  if (!view) {
    return (
      <Card>
        <CardContent className="py-6 flex flex-col gap-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          {err && <p className="text-xs text-danger">{err}</p>}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row gap-2 items-center">
        <p className="font-bold">Project Settings</p>
        <Chip size="sm" color="success" variant="soft">
          {view.items.filter((i) => i.source === "env").length}/{view.items.length} from env
        </Chip>
        <span className="ml-auto text-xs text-muted">
          read-only · edit .env, then restart
        </span>
      </CardHeader>
      <Separator />
      <CardContent className="gap-5">
        {GROUPS.map((g) => {
          const items = view.items.filter((i) => i.group === g.id);
          if (items.length === 0) return null;
          return (
            <section key={g.id} className="flex flex-col gap-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                {g.label}
              </p>
              <Separator />
              {items.map((it) => {
                const isDist = it.key === "PAYOUT_DISTRIBUTION";
                const distParts = isDist
                  ? it.value
                      .split(",")
                      .map((s) => Number(s.trim()))
                      .filter((n) => !isNaN(n))
                  : [];
                const distSum = distParts.reduce((a, b) => a + b, 0);
                return (
                  <div key={it.key} className="flex flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{it.label}</span>
                      {it.source === "env" ? (
                        <Chip size="sm" color="success" variant="soft">
                          env
                        </Chip>
                      ) : (
                        <Chip size="sm" color="warning" variant="soft">
                          default
                        </Chip>
                      )}
                      <code className="ml-auto rounded-md bg-default px-2 py-0.5 font-mono text-xs text-muted">
                        {it.envVar}
                      </code>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-md bg-default px-2.5 py-1.5 font-mono text-xs break-all">
                        {it.value}
                      </span>
                      {it.key === "LOTTERY_CRON_ENABLED" && view.inProduction && (
                        <span className="text-xs text-muted">
                          production: always on
                        </span>
                      )}
                    </div>
                    {isDist && distParts.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {distParts.map((p, i) => (
                          <Chip key={i} size="sm" variant="soft">
                            #{i + 1}: {(p * 100).toFixed(1)}%
                          </Chip>
                        ))}
                        <Chip
                          size="sm"
                          variant="soft"
                          color={
                            Math.abs(distSum - 1) < 0.0001 ? "success" : "warning"
                          }
                        >
                          sum {(distSum * 100).toFixed(1)}%
                        </Chip>
                      </div>
                    )}
                    <p className="text-xs text-muted">{it.description}</p>
                    {it.problem && (
                      <p className="text-xs text-danger">{it.problem}</p>
                    )}
                  </div>
                );
              })}
            </section>
          );
        })}

        <p className="text-xs text-muted">
          Values are read from <span className="font-mono">.env</span> once at
          server start — restart after editing. The draw engine, cron and this
          summary all read the same keys, so there is no second copy to drift.
        </p>
      </CardContent>
    </Card>
  );
}

/** Danger zone — permanently deletes stored draw/holder data so the lottery
 *  can start fresh (escape hatch for repeated failed rounds). Calls
 *  /api/admin/reset-data with a scope; requires typing DELETE to arm the
 *  button. The "draws" scope also drops the creator-fee claim history, so the
 *  Creator Fees card never reports payouts for rounds that no longer exist.
 *  Env settings (`MIN_TOKEN_ELIGIBLE`, `PLATFORM_FEE_BPS`, …) and notification
 *  subscriptions are never touched. Uses a busy + result-message feedback
 *  pattern. */
function DangerZoneCard({ onDone }: { onDone: () => void }) {
  const [scope, setScope] = useState<"draws" | "holders" | "all">("all");
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [sev, setSev] = useState<"ok" | "err">("ok");

  const armed = confirmText.trim().toUpperCase() === "DELETE";

  async function run() {
    if (!armed || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/admin/reset-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        counts?: {
          rounds: string;
          winners: string;
          claims: string;
          holders: string;
          snapshots: string;
        };
        error?: string;
      };
      if (r.ok && d.ok && d.counts) {
        const c = d.counts;
        setSev("ok");
        setMsg(
          `Deleted ${c.rounds} draw(s), ${c.winners} winner(s), ` +
            `${c.claims} claim(s), ${c.holders} holder(s), ` +
            `${c.snapshots} snapshot(s).`
        );
        setConfirmText("");
        onDone();
      } else {
        setSev("err");
        setMsg(d.error || `Reset failed (${r.status})`);
      }
    } catch {
      setSev("err");
      setMsg("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border-danger/40">
      <CardHeader className="flex flex-row gap-2 items-center">
        <p className="font-bold text-danger">Danger zone</p>
        <Chip size="sm" color="danger" variant="soft">
          irreversible
        </Chip>
      </CardHeader>
      <Separator />
      <CardContent className="gap-4">
        <p className="text-sm text-muted">
          Permanently delete stored draw/holder data to start fresh. Draw
          deletion also clears the creator-fee claim history. Settings (incl.
          platform fee) and notification subscriptions are kept. This cannot be
          undone.
        </p>

        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            Scope
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={scope === "all" ? "primary" : "outline"}
              onPress={() => setScope("all")}
            >
              Everything (draws + claims + holders)
            </Button>
            <Button
              size="sm"
              variant={scope === "draws" ? "primary" : "outline"}
              onPress={() => setScope("draws")}
            >
              Draws + claims
            </Button>
            <Button
              size="sm"
              variant={scope === "holders" ? "primary" : "outline"}
              onPress={() => setScope("holders")}
            >
              Holders only
            </Button>
          </div>
          <p className="text-xs text-muted">
            {scope === "draws"
              ? "Deletes every draw, winner row and creator-fee claim. Holders untouched."
              : scope === "holders"
              ? "Deletes every holder snapshot and holder row. Draws and claim history untouched."
              : "Deletes draws, winners, creator-fee claims, holder snapshots and holders."}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-sm font-medium">
            Type <span className="font-mono">DELETE</span> to confirm
          </Label>
          <TextField value={confirmText} onChange={setConfirmText}>
            <Input
              className="font-mono text-sm"
              placeholder="DELETE"
              aria-label="Type DELETE to confirm data deletion"
            />
          </TextField>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            isDisabled={!armed || busy}
            isPending={busy}
            onPress={run}
          >
            {busy ? "Deleting…" : "Delete data"}
          </Button>
          {msg && (
            <span
              className={
                sev === "err" ? "text-xs text-danger" : "text-xs text-success"
              }
            >
              {msg}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function AdminPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [rounds, setRounds] = useState<RoundsResp | null>(null);
  const [holders, setHolders] = useState<HoldersResp | null>(null);
  const [logs, setLogs] = useState<{ logs: LogEntry[] } | null>(null);
  const [holdersPage, setHoldersPage] = useState(1);
  /** Bumped by every `refreshAll()` — children that fetch their own data
   *  (CreatorFeesCard) key off it instead of waiting for their poll interval. */
  const [dataVersion, setDataVersion] = useState(0);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { theme, toggle, mounted } = useTheme();
  const { siteTitle } = useSite();

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/status", { cache: "no-store" });
      setStatus((await r.json()) as Status);
    } catch {
      setStatus(null);
    }
  }, []);

  const fetchInfo = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/info", { cache: "no-store" });
      if (r.ok) setInfo((await r.json()) as AppInfo);
    } catch {
      /* ignore */
    }
  }, []);

  const fetchRounds = useCallback(async () => {
    try {
      const r = await fetch("/api/rounds", { cache: "no-store" });
      setRounds((await r.json()) as RoundsResp);
    } catch {
      /* ignore */
    }
  }, []);

  const fetchHolders = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/holders", { cache: "no-store" });
      if (r.ok) {
        setHolders((await r.json()) as HoldersResp);
        setHoldersPage(1);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const fetchLogs = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/logs", { cache: "no-store" });
      if (r.ok) setLogs((await r.json()) as { logs: LogEntry[] });
    } catch {
      /* ignore */
    }
  }, []);

  const refreshAll = useCallback(() => {
    fetchStatus();
    fetchInfo();
    fetchRounds();
    fetchHolders();
    fetchLogs();
    setDataVersion((v) => v + 1);
  }, [fetchStatus, fetchInfo, fetchRounds, fetchHolders, fetchLogs]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/admin/me", { cache: "no-store" });
        setAuthed(
          ((await r.json()) as { authenticated: boolean }).authenticated
        );
      } catch {
        setAuthed(false);
      }
      fetchStatus();
      fetchInfo();
      fetchRounds();
      fetchHolders();
      fetchLogs();
    })();
  }, [fetchStatus, fetchInfo, fetchRounds, fetchHolders, fetchLogs]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginErr(null);
    try {
      const r = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (r.ok) {
        setAuthed(true);
        setPassword("");
        setMsg("Logged in");
      } else {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setLoginErr(d.error || `Login failed (${r.status})`);
      }
    } catch {
      setLoginErr("Network error");
    }
  }

  async function handleLogout() {
    await fetch("/api/admin/logout", { method: "POST" });
    setAuthed(false);
    setMsg(null);
    setErr(null);
  }

  async function handleSync() {
    setSyncing(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await fetch("/api/admin/trigger-sync", { method: "POST" });
      const d = (await r.json().catch(() => ({}))) as {
        totalHolders?: number;
        error?: string;
      };
      if (r.ok) {
        setMsg(`Synced ${d.totalHolders ?? 0} holders`);
        refreshAll();
      } else {
        setErr(d.error || `Sync failed (${r.status})`);
      }
    } catch {
      setErr("Network error");
    } finally {
      setSyncing(false);
    }
  }

  async function handleDraw() {
    setDrawing(true);
    setMsg(null);
    setErr(null);
    try {
      const r = await fetch("/api/admin/trigger-draw", { method: "POST" });
      const d = (await r.json().catch(() => ({}))) as {
        roundNumber?: number;
        winners?: Winner[];
        error?: string;
      };
      if (r.ok) {
        setMsg(
          `Draw #${d.roundNumber ?? "?"} finished — ${
            d.winners?.length ?? 0
          } winners`
        );
        refreshAll();
      } else {
        setErr(d.error || `Draw failed (${r.status})`);
      }
    } catch {
      setErr("Network error");
    } finally {
      setDrawing(false);
    }
  }

  if (authed === null) {
    return (
      <main className="min-h-screen bg-background p-6">
        <div className="max-w-5xl mx-auto flex flex-col gap-6">
          <div className="flex items-center justify-between">
            <Skeleton className="h-8 w-44" />
            <Skeleton className="h-8 w-40" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
          </div>
          <Skeleton className="h-72 w-full rounded-lg" />
        </div>
      </main>
    );
  }

  if (!authed) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background p-6">
        <Card className="max-w-sm w-full">
          <CardHeader className="flex flex-col gap-1">
            <p className="text-lg font-bold">🔐 Admin Login</p>
            <p className="text-small text-muted">{siteTitle}</p>
          </CardHeader>
          <Separator />
          <form onSubmit={handleLogin}>
            <CardContent className="gap-4">
              <TextField value={username} onChange={setUsername} isRequired>
                <Label>Username</Label>
                <Input />
              </TextField>
              <TextField value={password} onChange={setPassword} isRequired>
                <Label>Password</Label>
                <Input type="password" />
              </TextField>
              {loginErr && (
                <p className="text-danger text-small">{loginErr}</p>
              )}
            </CardContent>
            <CardFooter>
              <Button type="submit" variant="primary" className="w-full">
                Login
              </Button>
            </CardFooter>
          </form>
        </Card>
      </main>
    );
  }

  const net = status?.network ?? "mainnet";
  return (
    <main className="min-h-screen bg-background p-6">
      <div className="max-w-5xl mx-auto flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <p className="text-2xl font-bold">🪙 Admin Panel</p>
          <div className="flex gap-2 items-center">
            <Button
              size="sm"
              variant="ghost"
              isIconOnly
              aria-label={
                mounted
                  ? theme === "dark"
                    ? "Switch to light mode"
                    : "Switch to dark mode"
                  : "Toggle theme"
              }
              onPress={toggle}
            >
              {mounted ? (theme === "dark" ? "🌙" : "☀️") : "·"}
            </Button>
            <Button size="sm" variant="ghost" onPress={fetchStatus}>
              Refresh
            </Button>
            <Button
              size="sm"
              variant="danger-soft"
              onPress={handleLogout}
            >
              Logout
            </Button>
          </div>
        </div>

        {!status?.configured && (
          <Card className="bg-warning/10 border border-warning/30">
            <CardContent>
              <p className="text-sm font-semibold">⚠ Not fully configured</p>
              {status?.solanaError && (
                <p className="text-xs text-muted mt-1">
                  Solana: {status.solanaError}
                </p>
              )}
              {status?.dbError && (
                <p className="text-xs text-muted mt-1">
                  DB: {status.dbError}
                </p>
              )}
              <p className="text-xs text-muted mt-2">
                Set the missing env vars in <code>.env.local</code> to enable
                sync/draw.
              </p>
            </CardContent>
          </Card>
        )}

        <Tabs defaultSelectedKey="overview" className="w-full">
          <Tabs.ListContainer>
            <Tabs.List aria-label="Admin sections">
              <Tabs.Tab id="overview">
                App Info
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="draws">
                Draw History
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="holders">
                Token Holders
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="exclusions">
                Exclusions
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="buyback">
                Buyback
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="telegram">
                Telegram Bot
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="logs">
                System Log
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="settings">
                Settings
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="seo">
                SEO &amp; Analytics
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="palette">
                Palette
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="font">
                Font
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
          <Tabs.Panel id="overview" className="pt-4">
          <div className="flex flex-col gap-4">
        <CreatorFeesCard
          net={net}
          onClaimed={refreshAll}
          refreshKey={dataVersion}
        />
        <LiveStatusCard info={info} status={status} net={net} />

        <div className="flex flex-wrap gap-3">
          <Button variant="primary" onPress={handleSync} isPending={syncing}>
            Sync Holders
          </Button>
          <Button variant="secondary" onPress={handleDraw} isPending={drawing}>
            Run draw
          </Button>
        </div>

        {msg && <p className="text-success text-small">{msg}</p>}
        {err && <p className="text-danger text-small">{err}</p>}
          </div>
          </Tabs.Panel>
          <Tabs.Panel id="draws" className="pt-4">
          <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-lg font-bold">Draw history</p>
          <Chip size="sm" variant="soft">
            {rounds?.rounds.length ?? 0} draws
          </Chip>
          <a
            href="/draws"
            className="ml-auto text-accent text-small underline"
          >
            Public /draws →
          </a>
          <Button size="sm" variant="ghost" onPress={fetchRounds}>
            Refresh
          </Button>
        </div>
        {rounds && rounds.rounds.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatTile label="Total draws" value={String(rounds.rounds.length)} />
            <StatTile
              label={`${NATIVE_SYMBOL} paid out`}
              value={fmtSolHuman(
                rounds.rounds.reduce(
                  (s, r) => s + r.winners.reduce((ss, w) => ss + w.amountSol, 0),
                  0
                )
              )}
            />
            <StatTile
              label="Winners paid"
              value={String(
                rounds.rounds.reduce(
                  (s, r) =>
                    s + r.winners.filter((w) => w.status === "sent").length,
                  0
                )
              )}
            />
            <StatTile
              label="Verified draws"
              value={`${rounds.rounds.filter((r) => r.randomnessVerified).length}/${
                rounds.rounds.length
              }`}
            />
          </div>
        )}
            {rounds?.dbError && (
              <p className="text-danger text-small">{rounds.dbError}</p>
            )}
            {!rounds || rounds.rounds.length === 0 ? (
              <p className="text-small text-muted">
                No draws yet — start one with “Run draw”.
              </p>
            ) : (
              rounds.rounds.map((r) => (
                <Card key={r.roundNumber} className="overflow-hidden">
                  <CardHeader className="flex flex-row items-center gap-3 py-3">
                    <span className="text-xl font-bold tabular-nums">
                      #{r.roundNumber}
                    </span>
                    <Chip
                      size="sm"
                      color={
                        r.status === "completed"
                          ? "success"
                          : r.status === "failed"
                          ? "danger"
                          : r.status === "skipped"
                          ? "default"
                          : "warning"
                      }
                    >
                      {roundStatus(r.status)}
                    </Chip>
                    <span className="ml-auto text-xs text-muted">
                      {fmtTime(r.completedAt)}
                    </span>
                  </CardHeader>
                  <Separator />
                  <CardContent className="gap-4 py-4">
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                      <StatTile
                        label="Prize pool"
                        value={fmtSolHuman(r.prizePoolSol)}
                      />
                      <StatTile
                        label="Eligible"
                        value={String(r.eligibleCount)}
                      />
                      <StatTile
                        label="Winners"
                        value={String(r.winners.length)}
                      />
                      <StatTile
                        label="Payout fee"
                        value={
                          r.payoutFeeLamports
                            ? formatSol(BigInt(r.payoutFeeLamports))
                            : "—"
                        }
                        hint={
                          r.payoutTx || r.winners.some((w) => w.payoutTx)
                            ? "paid"
                            : r.winners.length > 0
                            ? "pending"
                            : undefined
                        }
                      />
                      <StatTile
                        label="Platform fee"
                        value={
                          r.platformFeeLamports
                            ? formatSol(BigInt(r.platformFeeLamports))
                            : "—"
                        }
                        hint={
                          r.platformFeeLamports != null
                            ? BigInt(r.platformFeeLamports) > 0n
                              ? info?.treasuryWallet
                                ? "swept to treasury"
                                : "kept on platform wallet"
                              : "no cut"
                            : undefined
                        }
                      />
                    </div>
                    {r.payoutTx && (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-muted">Payout tx:</span>
                        <a
                          href={explorer(r.payoutTx, "tx", net)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent font-mono underline"
                        >
                          {shortAddr(r.payoutTx, 8, 8)} ↗
                        </a>
                      </div>
                    )}
                    {r.error && (
                      <p className="text-danger text-small">⚠ {r.error}</p>
                    )}
                    {r.randomnessValue && rounds.chain ? (
                      <div className="rounded-lg border border-(--border) bg-default/40 p-3 flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <p className="text-small font-semibold">
                            🎲 drand randomness proof
                          </p>
                          {r.randomnessVerified ? (
                            <Chip size="sm" color="success" variant="soft">
                              ✓ verified
                            </Chip>
                          ) : (
                            <Chip size="sm" color="warning" variant="soft">
                              unverified
                            </Chip>
                          )}
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-xs">
                          <div className="flex flex-col gap-0.5">
                            <span className="text-muted">
                              Randomness round
                            </span>
                            <a
                              href={`${rounds.chain.verifyBaseUrl}/${r.randomnessRound}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-accent font-mono underline"
                            >
                              #{r.randomnessRound} ↗
                            </a>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <span className="text-muted">
                              Selection pool
                            </span>
                            <span className="text-foreground">
                              {r.eligibleCount} eligible holders
                            </span>
                          </div>
                        </div>
                        <div className="flex flex-col gap-1">
                          <span className="flex items-center gap-1 text-muted text-xs">
                            Hash (randomness value)
                            <CopyButton value={r.randomnessValue} label="Copy hash" />
                          </span>
                          <code className="font-mono text-xs break-all rounded bg-background border border-(--border) px-2 py-1.5">
                            {r.randomnessValue}
                          </code>
                        </div>
                        <div className="flex flex-col gap-1">
                          <span className="flex items-center gap-1 text-muted text-xs">
                            BLS signature
                            <CopyButton
                              value={r.randomnessSignature ?? ""}
                              label="Copy signature"
                            />
                          </span>
                          <code className="font-mono text-xs break-all rounded bg-background border border-(--border) px-2 py-1.5">
                            {r.randomnessSignature}
                          </code>
                        </div>
                        <div className="pt-1">
                          <VerifyButton
                            round={r.randomnessRound ?? 0}
                            value={r.randomnessValue}
                            verifyBaseUrl={rounds.chain.verifyBaseUrl}
                          />
                        </div>
                      </div>
                    ) : null}
                    {r.winners.length > 0 ? (
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <p className="text-small font-semibold">
                            🏆 Winners
                          </p>
                          <Chip size="sm" variant="soft">
                            {r.winners.length}
                          </Chip>
                        </div>
                        {r.winners.map((w) => (
                          <div
                            key={w.rank}
                            className="flex items-center gap-2 text-sm rounded-md border border-(--border) px-2 py-1.5"
                          >
                            <Chip size="sm" variant="soft" color="accent">
                              #{w.rank}
                            </Chip>
                            <a
                              href={explorer(w.address, "address", net)}
                              target="_blank"
                              rel="noreferrer"
                              className="text-accent font-mono"
                            >
                              {shortAddr(w.address, 6, 6)}
                            </a>
                            <CopyButton
                              value={w.address}
                              label={`Copy winner #${w.rank} address`}
                            />
                            <span className="ml-auto font-mono">
                              {fmtSolHuman(w.amountSol)}
                            </span>
                            {w.payoutTx ? (
                              <a
                                href={explorer(w.payoutTx, "tx", net)}
                                target="_blank"
                                rel="noreferrer"
                                className="text-accent text-small underline"
                              >
                                payout tx ↗
                              </a>
                            ) : (
                              <Chip
                                size="sm"
                                variant="soft"
                                color={
                                  w.status === "sent" ? "success" : "warning"
                                }
                              >
                                {payoutStatus(w.status)}
                              </Chip>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-small text-muted">
                        No winners
                      </p>
                    )}
                  </CardContent>
                </Card>
              ))
            )}
          </div>
          </Tabs.Panel>
          <Tabs.Panel id="holders" className="pt-4">
        <Card>
          <CardHeader className="flex flex-row gap-2 items-center">
            <p className="font-bold">Token Holders</p>
            <span className="text-small text-muted">
              {holders
                ? `${holders.total} current · ${holders.eligibleTotal} in draw${
                    holders.excludedTotal > 0
                      ? ` · ${holders.excludedTotal} out of the draw`
                      : ""
                  }`
                : "—"}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onPress={fetchHolders}
              className="ml-auto"
            >
              Refresh
            </Button>
          </CardHeader>
          <Separator />
          <CardContent className="gap-2">
            {holders?.dbError && (
              <p className="text-danger text-small">{holders.dbError}</p>
            )}
            {!holders || holders.holders.length === 0 ? (
              <p className="text-small text-muted">
                No holders synced yet — run “Sync Holders”.
              </p>
            ) : (
              <>
                <p className="text-xs text-muted">
                  Snapshot: {fmtTime(holders.capturedAt)} · min eligible{" "}
                  {fmtTokenHuman(
                    holders.minTokenEligibleRaw,
                    holders.tokenDecimals
                  )}{" "}
                  ({holders.tokenDecimals} decimals){" "}
                  {"·"} {holders.knownTotal} known all-time
                </p>
                <Table>
                  <TableContent aria-label="Token holders">
                    <TableHeader>
                      <TableColumn>#</TableColumn>
                      <TableColumn isRowHeader>ADDRESS</TableColumn>
                      <TableColumn>BALANCE</TableColumn>
                      <TableColumn>STATUS</TableColumn>
                    </TableHeader>
                    <TableBody>
                      {holders.holders
                        .slice((holdersPage - 1) * 10, holdersPage * 10)
                        .map((h, i) => (
                          <TableRow key={h.address} className="hover:bg-default/40">
                            <TableCell className="text-muted">
                              {(holdersPage - 1) * 10 + i + 1}
                            </TableCell>
                            <TableCell>
                              <a
                                href={explorer(h.address, "address", net)}
                                target="_blank"
                                rel="noreferrer"
                                className="text-accent font-mono"
                              >
                                {shortAddr(h.address, 6, 6)}
                              </a>
                            </TableCell>
                            <TableCell className="font-mono">
                              {fmtTokenHuman(h.amount, holders.tokenDecimals)}
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-col gap-0.5">
                                <Chip
                                  size="sm"
                                  variant="soft"
                                  color={
                                    h.eligible
                                      ? "success"
                                      : h.platform
                                        ? "default"
                                        : h.excludedBy === "venue"
                                          ? "warning"
                                          : h.excluded
                                            ? "danger"
                                            : "default"
                                  }
                                >
                                  {h.eligible
                                    ? "eligible"
                                    : h.platform
                                      ? "platform"
                                      : h.excludedBy === "venue"
                                        ? "venue · auto"
                                        : h.excluded
                                          ? "excluded"
                                          : "—"}
                                </Chip>
                                {h.excludedLabel &&
                                  !h.platform &&
                                  h.excludedBy !== "venue" && (
                                    <ExclusionLabelChip label={h.excludedLabel} />
                                  )}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </TableContent>
                </Table>
                  {(() => {
                    const total = Math.ceil(holders.holders.length / 10);
                    if (total <= 1) return null;
                    return (
                      <div className="flex justify-center mt-2 overflow-x-auto">
                        <Pagination size="sm">
                          <PaginationContent>
                            <PaginationItem>
                              <PaginationPrevious
                                isDisabled={holdersPage <= 1}
                                onPress={() =>
                                  setHoldersPage((p) => Math.max(1, p - 1))
                                }
                              >
                                Prev
                              </PaginationPrevious>
                            </PaginationItem>
                            {pageItems(holdersPage, total).map((it, idx) =>
                              it === "ellipsis" ? (
                                <PaginationItem key={`e-${idx}`}>
                                  <PaginationEllipsis />
                                </PaginationItem>
                              ) : (
                                <PaginationItem key={it}>
                                  <PaginationLink
                                    isActive={it === holdersPage}
                                    onPress={() => setHoldersPage(it)}
                                  >
                                    {it}
                                  </PaginationLink>
                                </PaginationItem>
                              )
                            )}
                            <PaginationItem>
                              <PaginationNext
                                isDisabled={holdersPage >= total}
                                onPress={() =>
                                  setHoldersPage((p) =>
                                    Math.min(total, p + 1)
                                  )
                                }
                              >
                                Next
                              </PaginationNext>
                            </PaginationItem>
                          </PaginationContent>
                        </Pagination>
                      </div>
                    );
                  })()}
              </>
            )}
          </CardContent>
        </Card>
          </Tabs.Panel>
          <Tabs.Panel id="exclusions" className="pt-4">
            <ExclusionsCard network={net} />
          </Tabs.Panel>
          <Tabs.Panel id="buyback" className="pt-4">
            <BuybackPanel />
          </Tabs.Panel>
          <Tabs.Panel id="telegram" className="pt-4">
            <TelegramBotPanel />
          </Tabs.Panel>
          <Tabs.Panel id="logs" className="pt-4">
        <Card>
          <CardHeader className="flex flex-row gap-2 items-center">
            <p className="font-bold">System Log</p>
            <span className="text-small text-muted">since boot</span>
            <Button
              size="sm"
              variant="ghost"
              onPress={fetchLogs}
              className="ml-auto"
            >
              Refresh
            </Button>
          </CardHeader>
          <Separator />
          <CardContent className="gap-1">
            {!logs || logs.logs.length === 0 ? (
              <p className="text-small text-muted">
                No events yet. Sync/draw/cron activity will appear here.
              </p>
            ) : (
              <div className="flex flex-col gap-1 max-h-96 overflow-auto font-mono text-xs">
                {logs.logs.map((l) => (
                  <div key={l.id} className="flex gap-2">
                    <span className="text-muted shrink-0">
                      {fmtTime(l.ts)}
                    </span>
                    <Chip
                      size="sm"
                      variant="soft"
                      color={
                        l.level === "error"
                          ? "danger"
                          : l.level === "warn"
                          ? "warning"
                          : l.level === "success"
                          ? "success"
                          : "default"
                      }
                      className="shrink-0"
                    >
                      {l.source}
                    </Chip>
                    <span className="break-all">{l.message}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
          </Tabs.Panel>
          <Tabs.Panel id="settings" className="pt-4">
            <div className="flex flex-col gap-4">
              <SettingsSummary />
              <CacheCard onCleared={refreshAll} />
              <DangerZoneCard onDone={refreshAll} />
            </div>
          </Tabs.Panel>
          <Tabs.Panel id="seo" className="pt-4">
            <SeoPanel />
          </Tabs.Panel>
          <Tabs.Panel id="palette" className="pt-4">
            <PalettePanel />
          </Tabs.Panel>
          <Tabs.Panel id="font" className="pt-4">
            <FontPanel />
          </Tabs.Panel>
        </Tabs>

        {status?.tokenMint && (
          <p className="text-xs text-muted text-center">
            Token:{" "}
            <a
              className="text-accent"
              href={explorer(status.tokenMint, "address", net)}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddr(status.tokenMint, 6, 6)}
            </a>{" "}
            · Draw cron: {status.lotteryCron}
          </p>
        )}
      </div>
    </main>
  );
}
