"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Tag } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  Input,
  Separator,
  TextField,
} from "@heroui/react";
import {
  EXCLUSION_LABEL_PRESETS,
  ExclusionLabelChip,
  VenueChip,
} from "@/components/ExclusionLabelChip";
import { explorerUrl, fmtDateUtc } from "@/lib/format";
import { ExternalLink, SkeletonRows } from "@/components/ui";
// Launchpad whose bonding curve / pool is auto-excluded ("pump.fun" on Solana,
// "pons" on Robinhood Chain), so the help text names the venue this chain uses.
import { FEE_SOURCE_LABEL } from "@/lib/chain/network";

/**
 * Admin → Exclusions (draw blacklist).
 *
 * Wallets here are removed from the eligible pool BEFORE the drand-seeded
 * shuffle, so the beacon can never pick them — they are not "skipped by
 * randomness", they were never candidates. Intended for accounts that hold the
 * token but aren't players: the pump.fun bonding curve, AMM/LP pool
 * authorities, program vaults, treasury wallets.
 *
 * The list is snapshotted on every round (`LotteryRound.excludedAddresses`), so
 * editing it never rewrites how an already-drawn round is re-verified.
 *
 * "Detected" rows come from GET /api/admin/exclusions: current holders whose
 * address is off the ed25519 curve (PDAs). Suggestion only — a plain wallet can
 * be a treasury and a PDA can be a player's wallet, so nothing is automatic.
 */

type Exclusion = {
  address: string;
  label: string | null;
  createdAt: string;
};

type Detected = {
  address: string;
  amountRaw: string;
  amountHuman: string;
};

type Resp = {
  ok?: boolean;
  capturedAt?: string | null;
  exclusions?: Exclusion[];
  venue?: {
    address: string;
    label: string;
    /** Compact kind tag: "bonding curve" / "pool authority". */
    tag?: string;
    /** Why it can never be a player (one line). */
    reason?: string;
  }[];
  detected?: Detected[];
  error?: string;
};

const shortAddr = (a: string, h = 6, t = 6): string =>
  !a || a.length <= h + t ? a : `${a.slice(0, h)}…${a.slice(-t)}`;

/**
 * One-click labels for the exclusion form. The presets themselves (value, icon,
 * colour, one-line reason) live in @/components/ExclusionLabelChip so the admin
 * list and the public /eligibility table render the exact same chips. Free text
 * is still allowed; a preset just fills the field.
 */

export function ExclusionsCard({ network }: { network: string }) {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notice, setNotice] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);

  // Chain-aware explorer link (see `explorerUrl` in @/lib/format).
  const explorer = (addr: string) =>
    explorerUrl(addr, "address", network === "devnet" ? "devnet" : "mainnet");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/exclusions", { cache: "no-store" });
      const body = (await r.json()) as Resp;
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setData(body);
    } catch (e) {
      setNotice({ kind: "err", text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(addr: string, note?: string) {
    const trimmed = addr.trim();
    if (!trimmed) {
      setNotice({ kind: "err", text: "Enter a wallet address first." });
      return;
    }
    setBusy(trimmed);
    setNotice(null);
    try {
      const r = await fetch("/api/admin/exclusions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: trimmed, label: note ?? null }),
      });
      const body = (await r.json()) as Resp;
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setAddress("");
      setLabel("");
      setPickerOpen(false);
      setNotice({
        kind: "ok",
        text: `${shortAddr(trimmed)} is excluded — it will not appear in any future draw.`,
      });
      await load();
    } catch (e) {
      setNotice({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function remove(addr: string) {
    setBusy(addr);
    setNotice(null);
    try {
      const r = await fetch("/api/admin/exclusions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: addr }),
      });
      const body = (await r.json()) as Resp;
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setNotice({
        kind: "ok",
        text: `${shortAddr(addr)} is eligible again (next draw onward).`,
      });
      await load();
    } catch (e) {
      setNotice({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const exclusions = data?.exclusions ?? [];
  const detected = data?.detected ?? [];
  const venue = data?.venue ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap gap-2 items-center">
          <p className="font-bold">Draw exclusions</p>
          <Chip
            size="sm"
            variant="soft"
            color={exclusions.length > 0 ? "warning" : "default"}
          >
            {exclusions.length} excluded
          </Chip>
          <Button
            size="sm"
            variant="ghost"
            onPress={load}
            className="ml-auto"
            isDisabled={loading}
          >
            Refresh
          </Button>
        </CardHeader>
        <Separator />
        <CardContent className="gap-4">
          <p className="text-sm text-muted leading-relaxed">
            Excluded wallets still hold the token but never enter the draw — the
            filter runs <span className="text-foreground">before</span> the drand
            shuffle, so the beacon can never select them. Use it for accounts
            that aren&apos;t players: the {FEE_SOURCE_LABEL} bonding curve, AMM/LP pool
            venues, program vaults or a treasury. The platform wallet is
            always excluded and doesn&apos;t need to be listed. Each round
            snapshots the list it used, so adding an address today doesn&apos;t
            change how past rounds verify.
          </p>

          {venue.length > 0 && (
            <div className="flex flex-col gap-3 rounded-lg border border-(--border) bg-surface-secondary px-4 py-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs uppercase tracking-wide text-muted">
                  Auto-excluded venue accounts
                </span>
                <span className="text-xs text-muted">
                  Derived from <span className="font-mono">TOKEN_MINT</span> — they
                  hold the token as liquidity, so they can never be players. No
                  action needed; they aren&apos;t part of your list below.
                </span>
              </div>
              {venue.map((v) => (
                <div key={v.address} className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <VenueChip
                      text={v.tag ? `venue · ${v.tag}` : "venue"}
                      title={v.reason}
                    />
                    <span className="font-medium text-foreground">{v.label}</span>
                    <ExternalLink
                      href={explorer(v.address)}
                      tone="foreground"
                      className="font-mono text-xs"
                    >
                      {shortAddr(v.address)}
                    </ExternalLink>
                  </div>
                  {v.reason && (
                    <span className="text-xs leading-relaxed text-muted">
                      {v.reason}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <TextField
                value={address}
                onChange={setAddress}
                aria-label="Wallet address to exclude"
              >
                <span className="flex h-6 items-center text-sm font-medium text-foreground">
                  Wallet address
                </span>
                <Input placeholder="base58 address" className="font-mono" />
              </TextField>
            </div>
            <div className="flex-1">
              <TextField
                value={label}
                onChange={setLabel}
                aria-label="Label (optional)"
              >
                <span className="flex h-6 items-center justify-between gap-2 text-sm font-medium text-foreground">
                  Label (optional)
                  <button
                    type="button"
                    onClick={() => setPickerOpen((open) => !open)}
                    aria-expanded={pickerOpen}
                    aria-controls="exclusion-label-presets"
                    title="Pick a preset label"
                    className="inline-flex items-center gap-1 rounded-full text-xs font-normal text-muted transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    {label.trim() ? (
                      <ExclusionLabelChip label={label} />
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-(--border) px-2 py-0.5">
                        <Tag className="h-3 w-3 shrink-0" aria-hidden />
                        Presets
                      </span>
                    )}
                    <ChevronDown
                      className={`h-3.5 w-3.5 shrink-0 transition-transform ${
                        pickerOpen ? "rotate-180" : ""
                      }`}
                      aria-hidden
                    />
                  </button>
                </span>
                <Input placeholder="e.g. second wallet of @user" maxLength={80} />
              </TextField>
            </div>
            <Button
              size="sm"
              variant="primary"
              onPress={() => void add(address, label)}
              isDisabled={busy !== null || address.trim().length === 0}
            >
              {busy !== null && busy === address.trim() ? "Adding…" : "Exclude"}
            </Button>
          </div>

          {pickerOpen && (
            <div
              id="exclusion-label-presets"
              className="flex flex-col gap-2 rounded-lg border border-(--border) bg-surface-secondary px-3 py-2.5"
            >
              <span className="text-xs uppercase tracking-wide text-muted">
                Preset labels
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {EXCLUSION_LABEL_PRESETS.map((preset) => {
                  const active =
                    label.trim().toLowerCase() === preset.value.toLowerCase();
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      aria-pressed={active}
                      title={preset.hint}
                      onClick={() => setLabel(active ? "" : preset.value)}
                      className={`rounded-full outline-none transition focus-visible:ring-2 focus-visible:ring-accent/40 ${
                        active
                          ? "ring-1 ring-accent/60"
                          : "opacity-80 hover:opacity-100"
                      }`}
                    >
                      <ExclusionLabelChip label={preset.value} />
                    </button>
                  );
                })}
              </div>
              <span className="text-xs text-muted">
                Click to fill the label (click again to clear). You can still
                type your own above.
              </span>
            </div>
          )}

          {notice && (
            <p
              className={
                notice.kind === "err"
                  ? "text-danger text-sm"
                  : "text-success text-sm"
              }
            >
              {notice.text}
            </p>
          )}

          {loading && !data ? (
            <SkeletonRows count={3} />
          ) : exclusions.length === 0 ? (
            <p className="text-sm text-muted">
              No exclusions yet — every eligible wallet can be drawn.
            </p>
          ) : (
            <div className="rounded-lg border border-(--border) overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface-secondary text-xs uppercase tracking-wide text-muted">
                    <th className="text-left px-4 py-2 font-medium">Address</th>
                    <th className="text-left px-4 py-2 font-medium">Label</th>
                    <th className="text-left px-4 py-2 font-medium">Added</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {exclusions.map((e) => (
                    <tr
                      key={e.address}
                      className="border-t border-(--border) hover:bg-default/40"
                    >
                      <td className="px-4 py-2">
                        <ExternalLink
                          href={explorer(e.address)}
                          tone="foreground"
                          className="font-mono text-xs"
                        >
                          {shortAddr(e.address)}
                        </ExternalLink>
                      </td>
                      <td className="px-4 py-2">
                        {e.label ? (
                          <ExclusionLabelChip label={e.label} />
                        ) : (
                          <span className="text-xs italic text-muted/40">
                            no label
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-muted text-xs">
                        {fmtDateUtc(e.createdAt)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onPress={() => void remove(e.address)}
                          isDisabled={busy !== null}
                        >
                          {busy === e.address ? "Removing…" : "Remove"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>


      <Card>
        <CardHeader className="flex flex-row flex-wrap gap-2 items-center">
          <p className="font-bold">Detected program-owned accounts</p>
          <Chip size="sm" variant="soft" color="default">
            {detected.length} found
          </Chip>
        </CardHeader>
        <Separator />
        <CardContent className="gap-3">
          <p className="text-sm text-muted leading-relaxed">
            Current holders whose address is{" "}
            <span className="text-foreground">off the ed25519 curve</span> — that
            is what a program-derived account looks like (the pump.fun bonding
            curve, a pool authority, a vault). Nothing is excluded
            automatically: review each one and exclude the ones that aren&apos;t
            players. The curve and pool authority for this token are already
            excluded above, automatically.
          </p>
          {detected.length === 0 ? (
            <p className="text-sm text-muted">
              No program-owned accounts in the latest snapshot.
            </p>
          ) : (
            <div className="rounded-lg border border-(--border) overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-surface-secondary text-xs uppercase tracking-wide text-muted">
                    <th className="text-left px-4 py-2 font-medium">Address</th>
                    <th className="text-right px-4 py-2 font-medium">Balance</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {detected.map((d) => (
                    <tr
                      key={d.address}
                      className="border-t border-(--border) hover:bg-default/40"
                    >
                      <td className="px-4 py-2">
                        <ExternalLink
                          href={explorer(d.address)}
                          tone="foreground"
                          className="font-mono text-xs"
                        >
                          {shortAddr(d.address)}
                        </ExternalLink>
                      </td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums">
                        {d.amountHuman}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onPress={() =>
                            void add(d.address, "Program-owned account")
                          }
                          isDisabled={busy !== null}
                        >
                          {busy === d.address ? "Adding…" : "Exclude"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

