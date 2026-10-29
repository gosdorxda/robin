"use client";

import { useCallback, useState } from "react";
import { Check, CircleCheck, Clock, Copy } from "lucide-react";
import { Button, Chip, Spinner } from "@heroui/react";
import { reproduceWinners, type ReproducedWinner } from "@/lib/lottery/verify";
import { ExternalLink } from "@/components/ui";

/* ──────────────────────────────────────────────────────────────────────────
   The drand provenance block — one implementation for `/draws` and the
   homepage "Recent draws" panel.

   A draw whose seed you can't inspect is just a claim, so both surfaces render
   the *complete* evidence: the beacon round, the randomness hex, the BLS
   signature, a link to the same round on drand.sh, and the two-check Verify
   button. `/` previously showed a single shortened hash + "View on drand",
   which meant opening a row still pushed the visitor to another page to see
   the proof.

   `full` makes the hashes wrap instead of truncating (homepage panels are wide
   and read as a detail view); `/draws` keeps the one-line ellipsis + copy.

   VerifyButton runs two independent, client-side checks when pressed:
     1. Beacon — fetches the drand round straight from drand.sh (CORS-open) and
        confirms the published randomness equals our stored value, so the seed
        wasn't faked.
     2. Derivation — fetches the exact eligible holder list for this round from
        /api/rounds/[n], re-runs the Fisher–Yates shuffle in the browser
        (reproduceWinners, Web Crypto), and compares the reproduced winners
        rank-for-rank with the stored ones — so winners weren't hand-picked.
   ────────────────────────────────────────────────────────────────────────── */

type VerifyState = "idle" | "checking" | "match" | "mismatch" | "error";
type DeriveState =
  | "idle"
  | "checking"
  | "pass"
  | "mismatch"
  | "unavailable"
  | "error";

/** Only the fields verification needs — a richer Winner[] still fits. */
export type DrandWinner = { rank: number; address: string };

/** Subset of the `/api/rounds` chain object this block displays. */
export type DrandChain = {
  name: string;
  scheme: string;
  period: number;
  verifyBaseUrl: string;
};

const shortAddr = (a: string, h = 4, t = 4): string =>
  !a || a.length <= h + t ? a : `${a.slice(0, h)}…${a.slice(-t)}`;

/**
 * A labelled, copyable hash row. `wrap` prints the full 64-char hex across
 * multiple lines (selectable, no truncation) while keeping the copy button.
 */
export function HashRow({
  label,
  value,
  wrap = false,
}: {
  label: string;
  value: string | null;
  wrap?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    if (!value) return;
    navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, [value]);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      <div className="relative">
        <p
          title={value ?? undefined}
          className={`rounded-md border border-(--border) bg-default/40 px-2.5 py-1.5 pr-10 font-mono text-xs ${
            wrap ? "break-all select-all" : "truncate"
          }`}
        >
          {value ?? "—"}
        </p>
        {value && (
          <button
            type="button"
            onClick={copy}
            aria-label={`Copy ${label}`}
            className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex items-center justify-center rounded p-1.5 text-muted transition hover:text-foreground"
          >
            {copied ? (
              <Check size={13} aria-hidden="true" />
            ) : (
              <Copy size={13} aria-hidden="true" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The two-check "Verify draw" button. Stays uncontrolled from the parent's
 * point of view: all progress/result state is local, so a panel can be opened,
 * verified and collapsed without lifting anything up.
 */
export function VerifyButton({
  beaconRound,
  value,
  verifyBaseUrl,
  lotteryRound,
  winners,
}: {
  beaconRound: number;
  value: string;
  verifyBaseUrl: string;
  lotteryRound: number;
  winners: DrandWinner[];
}) {
  const [beaconState, setBeaconState] = useState<VerifyState>("idle");
  const [beaconDetail, setBeaconDetail] = useState<string | null>(null);
  const [deriveState, setDeriveState] = useState<DeriveState>("idle");
  const [deriveDetail, setDeriveDetail] = useState<string | null>(null);
  const [reproduced, setReproduced] = useState<ReproducedWinner[] | null>(null);

  async function verifyBeacon(): Promise<void> {
    setBeaconState("checking");
    setBeaconDetail(null);
    try {
      const res = await fetch(`${verifyBaseUrl}/${beaconRound}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { randomness?: string };
      const got = (j.randomness ?? "").toLowerCase();
      if (got && got === value.toLowerCase()) {
        setBeaconState("match");
        setBeaconDetail("drand’s published value matches the stored seed");
      } else {
        setBeaconState("mismatch");
        setBeaconDetail(`drand returned a different value: ${got || "empty"}`);
      }
    } catch (e) {
      setBeaconState("error");
      setBeaconDetail(`couldn’t reach drand — ${(e as Error).message}`);
    }
  }

  async function verifyDerivation(): Promise<void> {
    if (!winners.length) {
      setDeriveState("unavailable");
      setDeriveDetail("no winners recorded for this draw");
      return;
    }
    setDeriveState("checking");
    setDeriveDetail(null);
    setReproduced(null);
    try {
      const res = await fetch(`/api/rounds/${lotteryRound}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`holder list returned HTTP ${res.status}`);
      const d = (await res.json()) as {
        eligible?: { address: string }[];
        eligibleSource?: string;
      };
      const eligible = d.eligible ?? [];
      if (!eligible.length) {
        setDeriveState("unavailable");
        setDeriveDetail("the holder list for this draw isn’t available");
        return;
      }
      const reps = await reproduceWinners(
        value,
        eligible.map((e) => e.address),
        winners.length
      );
      setReproduced(reps);
      let mismatches = 0;
      const max = Math.max(reps.length, winners.length);
      for (let i = 0; i < max; i++) {
        if (reps[i]?.address !== winners[i]?.address) mismatches++;
      }
      if (mismatches === 0 && reps.length === winners.length) {
        setDeriveState("pass");
        setDeriveDetail(
          `all ${reps.length} winners reproduced from the seed and ${eligible.length} holders`
        );
      } else {
        setDeriveState("mismatch");
        setDeriveDetail(
          `${mismatches} of ${max} winners don’t match the stored list`
        );
      }
    } catch (e) {
      setDeriveState("error");
      setDeriveDetail(`reproduction failed — ${(e as Error).message}`);
    }
  }

  async function verify() {
    await Promise.all([verifyBeacon(), verifyDerivation()]);
  }

  const busy = beaconState === "checking" || deriveState === "checking";

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="primary"
        fullWidth
        onPress={verify}
        isPending={busy}
        className="h-9 text-xs font-medium rounded-lg"
      >
        {busy && <Spinner size="sm" color="current" />}
        Verify draw
      </Button>

      {(beaconState !== "idle" || deriveState !== "idle") && (
        <div className="flex flex-col gap-1.5">
          {/* Beacon attestation */}
          {beaconState !== "idle" && beaconState !== "checking" && (
            <div className="flex flex-wrap items-center gap-2">
              {beaconState === "match" && (
                <Chip size="sm" color="success">
                  ✓ Beacon matches
                </Chip>
              )}
              {beaconState === "mismatch" && (
                <Chip size="sm" color="danger">
                  ✗ Mismatch
                </Chip>
              )}
              {beaconState === "error" && (
                <Chip size="sm" color="warning">
                  drand unreachable
                </Chip>
              )}
              {beaconDetail && (
                <span className="text-xs text-muted">{beaconDetail}</span>
              )}
            </div>
          )}

          {/* Winner derivation from the hash */}
          {deriveState !== "idle" && deriveState !== "checking" && (
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                {deriveState === "pass" && (
                  <Chip size="sm" color="success">
                    ✓ Winners reproduced {winners.length}/{winners.length}
                  </Chip>
                )}
                {deriveState === "mismatch" && (
                  <Chip size="sm" color="danger">
                    ✗ Mismatch
                  </Chip>
                )}
                {deriveState === "unavailable" && (
                  <Chip size="sm" color="warning">
                    Not available
                  </Chip>
                )}
                {deriveState === "error" && (
                  <Chip size="sm" color="warning">
                    Check failed
                  </Chip>
                )}
                {deriveDetail && (
                  <span className="text-xs text-muted">{deriveDetail}</span>
                )}
              </div>
              {reproduced && reproduced.length > 0 && (
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {reproduced.map((w) => (
                    <div key={w.rank} className="flex items-center gap-1.5 text-xs">
                      <span className="font-mono text-muted">
                        #{w.rank}
                      </span>
                      <span className="font-mono text-foreground">
                        {shortAddr(w.address)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The full drand evidence box: beacon round, chain label, stored randomness +
 * BLS signature, a link to the same round on drand.sh, and the Verify button.
 *
 * Renders identically on `/draws` and in the homepage detail panel — the only
 * differences are `verified` (the DB's own flag, shown as a chip on `/`) and
 * `full` (wrap the hex instead of ellipsising it).
 */
export function DrandBeacon({
  beaconRound,
  value,
  signature,
  lotteryRound,
  winners,
  chain,
  verified,
  full = false,
  className = "",
}: {
  beaconRound: number;
  value: string;
  signature: string | null;
  lotteryRound: number;
  winners: DrandWinner[];
  chain?: DrandChain | null;
  verified?: boolean;
  full?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-lg border border-accent/25 bg-accent/10 px-3 py-3 sm:px-4 ${className}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-sm font-semibold">
          drand beacon #{beaconRound}
        </span>
        {/* The chain label ("drand-quicknet") used to sit here as a third item
            in this row. It is noise on a proof panel — the round number and the
            "View on drand" link already identify the beacon — and on phones it
            pushed the chip onto its own line, so it is gone. */}
        {typeof verified === "boolean" && (
          <Chip
            size="sm"
            variant="soft"
            color={verified ? "success" : "warning"}
          >
            {verified ? (
              <CircleCheck size={14} aria-hidden="true" />
            ) : (
              <Clock size={14} aria-hidden="true" />
            )}
            <Chip.Label>{verified ? "Verified" : "Not verified"}</Chip.Label>
          </Chip>
        )}
        {chain?.verifyBaseUrl && (
          <ExternalLink
            href={`${chain.verifyBaseUrl}/${beaconRound}`}
            className="-my-1 ml-auto py-1 text-xs"
          >
            View on drand
          </ExternalLink>
        )}
      </div>

      {/* Full-width rows when wrapping: two 64-char hex strings side by side
          would each wrap to ~3 lines. */}
      <div
        className={`grid grid-cols-1 gap-2 ${full ? "" : "sm:grid-cols-2"}`}
      >
        <HashRow label="Randomness (seed)" value={value} wrap={full} />
        <HashRow label="Signature (BLS)" value={signature} wrap={full} />
      </div>

      <VerifyButton
        beaconRound={beaconRound}
        value={value}
        verifyBaseUrl={chain?.verifyBaseUrl ?? ""}
        lotteryRound={lotteryRound}
        winners={winners}
      />
    </div>
  );
}
