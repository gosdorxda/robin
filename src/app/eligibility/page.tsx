"use client";

import { FormEvent, ReactNode, useState } from "react";
import { Chip, Label, ProgressBar, Typography } from "@heroui/react";
import { CircleCheckBig, ShieldAlert } from "lucide-react";
import { Icon, Skeleton, SkeletonStat } from "@/components/ui";
import { AppShell } from "@/components/AppShell";
import { HoldersBrowser } from "@/components/HoldersBrowser";
import { useSite } from "@/components/providers/SiteProvider";
import {
  ExclusionLabelChip,
  VenueChip,
  matchExclusionPreset,
} from "@/components/ExclusionLabelChip";
import { shortAddress, explorerUrl, timeAgo } from "@/lib/format";
// Chain name for the input placeholder — a Robinhood-Chain visitor must not be
// told to paste a Solana address (and the API's 400 already spells out the real
// shape when the input is wrong).
import { CHAIN_NAME } from "@/lib/chain/network";

type EligResp = {
  address: string;
  network: "mainnet" | "devnet";
  tokenName: string;
  tokenMint: string | null;
  tokenDecimals: number;
  found: boolean;
  balanceRaw: string;
  balanceHuman: string;
  minTokenEligibleRaw: string;
  minTokenEligibleHuman: string;
  eligible: boolean;
  drawEligible: boolean;
  excluded: boolean;
  excludedBy: "venue" | "manual" | null;
  excludedLabel: string | null;
  exclusionReason: string | null;
  shortfallHuman: string;
  capturedAt: string | null;
  lastSyncAt: string | null;
  dbError: string | null;
};

export default function EligibilityPage() {
  const { tokenName } = useSite();
  const [address, setAddress] = useState("");
  const [data, setData] = useState<EligResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function check(e: FormEvent) {
    e.preventDefault();
    const a = address.trim();
    if (!a) return;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const r = await fetch(`/api/eligibility?address=${encodeURIComponent(a)}`);
      const json = await r.json();
      if (!r.ok) {
        // The API's 400 carries a chain-appropriate sentence ("Not a valid 0x
        // address (42 characters, 20 bytes)" / the Solana equivalent), so it is
        // shown as-is instead of a hardcoded "Solana wallet address" hint.
        setError(
          typeof json.error === "string" && json.error.length > 0
            ? json.error
            : "Couldn’t check that wallet. Please try again."
        );
      } else setData(json as EligResp);
    } catch {
      setError("Couldn’t reach the server, check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell title="Eligibility">

      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-10 pt-8 sm:pt-10 pb-12">
        <HoldersBrowser
          title="Eligibility"
          subtitle={`Hold at least the minimum ${tokenName} and you’re entered in every draw automatically, no claim, no sign-up. Check a wallet below or browse the holder list.`}
        >
          <div className="flex flex-col gap-4">

          <form onSubmit={check}>
            {/* Stacked on phones and inline from sm up: as one row the button
                was `shrink-0` next to a `flex-1` input, so at 375 px the field
                collapsed to ~150 px and the placeholder clipped. The hairline
                between the two turns from a top border into a left border once
                they sit side by side. */}
            <div className="flex flex-col overflow-hidden rounded-lg border border-(--border) bg-surface transition focus-within:border-accent sm:flex-row sm:items-stretch">
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder={`Paste a ${CHAIN_NAME} wallet address`}
                className="min-w-0 flex-1 bg-transparent px-4 py-2.5 font-mono text-sm outline-none"
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="submit"
                disabled={loading}
                className="inline-flex w-full shrink-0 items-center justify-center gap-1.5 border-t border-(--border) bg-(--button) px-5 py-2.5 text-sm font-medium text-(--button-foreground) transition hover:bg-(--button-hover) disabled:opacity-60 sm:w-auto sm:border-l sm:border-t-0"
              >
                <Icon name="search" className="h-4 w-4" />
                {loading ? "Checking…" : "Check wallet"}
              </button>
            </div>
            <p className="mt-2 text-xs text-muted">
              Balances come from a snapshot refreshed every few minutes, so a recent
              buy may not show up yet.
            </p>
          </form>

          {error && (
            <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div>
          )}

          {loading && (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <div className="flex items-center gap-4 rounded-lg border border-(--border) bg-surface p-6 lg:col-span-2">
                <Skeleton className="h-14 w-14 rounded-full" />
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-6 w-44" />
                  <Skeleton className="h-4 w-64" />
                </div>
                <Skeleton className="ml-auto h-7 w-24 rounded-full" />
              </div>
              <div className="flex flex-col gap-4 rounded-lg border border-(--border) bg-surface p-5">
                <div className="grid grid-cols-2 gap-5">
                  <SkeletonStat label={`Your balance (${tokenName})`} />
                  <SkeletonStat label={`Minimum (${tokenName})`} />
                </div>
                <Skeleton className="h-2 w-full rounded-full" />
              </div>
              <div className="flex flex-col gap-3 rounded-lg border border-(--border) bg-surface p-5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            </div>
          )}

          {data && <ResultCard data={data} />}
          </div>
        </HoldersBrowser>
      </main>
    </AppShell>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ResultCard({ data }: { data: EligResp }) {
  const pct = (() => {
    const b = Number(data.balanceRaw);
    const t = Number(data.minTokenEligibleRaw);
    if (!t || t <= 0) return 100;
    return Math.max(0, Math.min(100, (b / t) * 100));
  })();

  // Banner tone per outcome: excluded → warning (holds the token, but has no
  // entry), eligible → success (win), found-but-short → danger (action needed),
  // never-seen → neutral. Keeps the four states visually distinct without
  // inventing new colour tokens.
  // Ticker is shown exactly as stored (case included) — no forced uppercase.
  const token = data.tokenName;
  // The draw's own reason (venue accounts) beats the preset hint; free-text and
  // unlabelled blacklist rows fall back to a generic line.
  const exclusionNote =
    data.exclusionReason ??
    matchExclusionPreset(data.excludedLabel)?.hint ??
    "This wallet was removed from the draw by the organiser.";
  const banner = data.excluded
    ? { cls: "border-warning/30 bg-warning/10", iconBg: "bg-warning/15 text-warning", icon: "face-slightly-frowning", chipColor: "warning" as const, chipText: "Excluded" }
    : data.eligible
    ? { cls: "border-success/30 bg-success/10", iconBg: "bg-success/15 text-success", icon: "face-slightly-smiling", chipColor: "success" as const, chipText: "Eligible" }
    : data.found
      ? { cls: "border-danger/30 bg-danger/10", iconBg: "bg-danger/15 text-danger", icon: "face-slightly-frowning", chipColor: "danger" as const, chipText: "Not eligible" }
      : { cls: "border-(--border) bg-default/40", iconBg: "bg-default text-muted", icon: "search", chipColor: "default" as const, chipText: "Not listed" };

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {/* Status banner — full width, eye-catching */}
      <div className={`rounded-lg border p-5 sm:p-6 lg:col-span-2 ${banner.cls}`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
          <span className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-full ${banner.iconBg}`}>
            {data.excluded ? (
              <ShieldAlert className="h-7 w-7" aria-hidden />
            ) : (
              <Icon name={banner.icon} className="h-7 w-7" />
            )}
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            {data.excluded ? (
              <>
                <span className="text-xl sm:text-2xl font-bold tracking-tight text-warning">Not in the draw</span>
                <Typography type="body-sm" color="muted">
                  This wallet is filtered out before the drand shuffle, so it
                  can’t win. Its balance still shows in the holder table, but it
                  isn’t entered in the draw.
                </Typography>
              </>
            ) : data.eligible ? (
              <>
                <span className="text-xl sm:text-2xl font-bold tracking-tight text-success">You’re eligible</span>
                <Typography type="body-sm" color="muted">Your balance clears the minimum, so you’re in the pool for the next draw.</Typography>
              </>
            ) : data.found ? (
              <>
                <span className="text-xl sm:text-2xl font-bold tracking-tight">Not yet eligible</span>
                <Typography type="body-sm" color="muted">
                  You need{" "}
                  <span className="rounded-md bg-default px-2 py-0.5 font-mono text-xs font-semibold text-foreground">{data.shortfallHuman}</span>{" "}
                  more {token} to qualify.
                </Typography>
              </>
            ) : (
              <>
                <span className="text-xl sm:text-2xl font-bold tracking-tight">Not in the holder list</span>
                <Typography type="body-sm" color="muted">This wallet isn’t in the holder list yet. If you just bought {token}, check again in a few minutes.</Typography>
              </>
            )}
          </div>
          {data.excluded ? (
            <div className="self-start sm:ml-auto sm:self-auto">
              {data.excludedBy === "venue" ? (
                <VenueChip size="lg" text={data.excludedLabel ?? "Venue account"} />
              ) : (
                <ExclusionLabelChip label={data.excludedLabel} size="lg" />
              )}
            </div>
          ) : (
            <Chip className="gap-1 self-start sm:ml-auto sm:self-auto" size="lg" color={banner.chipColor} variant="soft">
              {data.eligible && <CircleCheckBig className="h-4 w-4 shrink-0" aria-hidden />}
              {banner.chipText}
            </Chip>
          )}
        </div>
      </div>

      {(data.found || data.excluded) && (
        <>
      {data.found && (
      <div className="flex flex-col gap-4 rounded-lg border border-(--border) bg-surface p-5">
        <div className="grid grid-cols-2 gap-5">
          <div className="flex flex-col gap-1">
            <span className="text-sm text-muted">Your balance ({token})</span>
            <span className="text-2xl font-medium tabular-nums tracking-tight text-foreground">{data.balanceHuman}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-sm text-muted">Minimum ({token})</span>
            <span className="text-2xl font-medium tabular-nums tracking-tight text-muted">{data.minTokenEligibleHuman}</span>
          </div>
        </div>
        <ProgressBar
          aria-label="Toward the minimum"
          value={pct}
          maxValue={100}
          size="sm"
          color={data.eligible ? "success" : "accent"}
          className="gap-1.5"
        >
          <div className="flex items-center justify-between">
            <Label className="text-sm text-muted">Toward the minimum</Label>
            <span className="text-xs font-mono tabular-nums text-muted">{pct.toFixed(0)}%</span>
          </div>
          <ProgressBar.Track className="bg-default/40">
            <ProgressBar.Fill className={data.eligible ? "bg-success" : "bg-accent"} />
          </ProgressBar.Track>
        </ProgressBar>
      </div>
      )}

      <div className={`rounded-lg border border-(--border) bg-surface p-5 ${data.found ? "" : "lg:col-span-2"}`}>
        <dl className="flex flex-col gap-3 text-sm">
          <Row label="Draw status">
            {data.excluded ? (
              data.excludedBy === "venue" ? (
                <VenueChip text={data.excludedLabel ?? "Venue account"} />
              ) : (
                <ExclusionLabelChip label={data.excludedLabel} />
              )
            ) : (
              <Chip
                size="sm"
                variant="soft"
                color={data.eligible ? "success" : "default"}
                className="gap-1"
              >
                {data.eligible && (
                  <CircleCheckBig className="h-3 w-3 shrink-0" aria-hidden />
                )}
                {data.eligible ? "Eligible" : "Below minimum"}
              </Chip>
            )}
          </Row>
          <Row label="Wallet">
            <a href={explorerUrl(data.address, "address", data.network)} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 font-mono text-muted transition hover:text-accent">
              {shortAddress(data.address, 6, 6)}
              <Icon name="arrow-up-right" className="h-3.5 w-3.5" />
            </a>
          </Row>
          <Row label="List updated">
            <span className="text-muted">{timeAgo(data.lastSyncAt)}</span>
          </Row>
          {(!data.capturedAt || data.capturedAt !== data.lastSyncAt) && (
            <Row label="Balance read">
              <span className="text-muted">
                {data.capturedAt ? timeAgo(data.capturedAt) : "not in the latest snapshot"}
              </span>
            </Row>
          )}
        </dl>
        {data.excluded && (
          <div className="mt-3 border-t border-(--border) pt-3">
            <p className="text-xs leading-relaxed text-muted">{exclusionNote}</p>
          </div>
        )}
      </div>
        </>
      )}

      {data.dbError && (
        <div className="lg:col-span-2 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger" title={data.dbError}>
          The holder list couldn’t be read. Refresh the page to try again.
        </div>
      )}
    </div>
  );
}