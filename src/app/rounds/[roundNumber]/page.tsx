"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
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
import { ExternalLink, Icon, Skeleton, SkeletonStat, SkeletonRows } from "@/components/ui";
import { explorerUrl, fmtDateTimeUtc, fmtSolHuman, shortAddress } from "@/lib/format";
import { reproduceWinners } from "@/lib/lottery/verify";
// Launchpad the creator fees come from ("Pump.fun trading" / "Pons trading") —
// the eligibility note names the venue that is excluded from the draw.
import { FEE_SOURCE_TITLE } from "@/lib/chain/network";

type Winner = {
  rank: number;
  address: string;
  amountSol: number;
  payoutTx: string | null;
  status: string;
};

type Round = {
  roundNumber: number;
  status: string;
  prizePoolSol: number;
  eligibleCount: number;
  minTokenEligible: string;
  startedAt: string;
  completedAt: string | null;
  randomnessValue: string | null;
  randomnessSignature: string | null;
  randomnessRound: number | null;
  randomnessVerified: boolean;
  error: string | null;
  winners: Winner[];
};

type Chain = {
  name: string;
  hash: string;
  publicKey: string;
  scheme: string;
  period: number;
  verifyBaseUrl: string;
};

type RoundResp = {
  network: "mainnet" | "devnet";
  chain: Chain | null;
  round: Round;
  eligible: { address: string; amount: string }[];
  eligibleSource: "recorded" | "inferred" | "unavailable";
  eligibleSnapshotCapturedAt: string | null;
  snapshotTotalHolders: number;
  platformExclusionReproduced: boolean;
  platformAddress: string | null;
  /** Full exclusion list applied at draw time (platform wallet + blacklist). */
  excludedAddresses?: string[];
  exclusionSource?: "recorded" | "platform-only";
  error?: string;
};

type CheckState = "idle" | "running" | "pass" | "fail" | "error";
type CheckResult = { state: CheckState; detail: string };
type ChipColor = "success" | "danger" | "warning" | "default";

/** DB status -> the words we show. Never print the raw enum on the page. */
const STATUS_LABEL: Record<string, string> = {
  completed: "Completed",
  drawing: "In progress",
  skipped: "Skipped",
  failed: "Failed",
  sent: "Paid",
  pending: "Pending",
};
const statusLabel = (status: string): string =>
  STATUS_LABEL[status] ?? status.charAt(0).toUpperCase() + status.slice(1);

/** Where the wallet list came from: machine values, user-facing words. */
const SOURCE_LABEL: Record<string, string> = {
  recorded: "Saved with this draw",
  inferred: "Closest snapshot",
  unavailable: "Not available",
};

/**
 * The engine stores an operator log line on skipped/failed draws (e.g.
 * "Prize pool 0 SOL (balance at/below reserve) - round skipped"). Show one plain
 * sentence and keep the raw text on `title` for anyone who wants details.
 */
function roundNote(round: Round): string {
  const raw = round.error ?? "";
  const s = raw.toLowerCase();
  if (round.status === "skipped") {
    if (s.includes("below minimum")) {
      return "The prize pool didn’t reach the minimum needed for a draw.";
    }
    if (s.includes("eligible")) {
      return "No wallet was eligible for this draw, so there was nobody to pick.";
    }
    if (s.includes("reserve")) {
      return "The balance sat at or below the reserve, so this draw had no prize pool and picked no winners.";
    }
    return "This draw stopped before it picked any winners.";
  }
  if (s.includes("failed on-chain") || s.includes("insufficientfunds")) {
    return "The payout transaction failed on-chain, so this draw didn’t pay out.";
  }
  if (s.includes("payout tx")) {
    return "The payout transaction failed, so this draw didn’t pay out.";
  }
  if (round.status === "failed") {
    return "This draw did not finish, so it paid no one.";
  }
  return "This draw closed without winners.";
}

function fmtDate(iso: string | null): string {
  if (!iso) return "Not recorded";
  // UTC, like every other timestamp on the site (see fmtDateTimeUtc).
  return fmtDateTimeUtc(iso);
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.toLowerCase().replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(hexValue: string): Promise<string> {
  const bytes = hexToBytes(hexValue);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return bytesToHex(new Uint8Array(digest));
}

function downloadCSV(filename: string, rows: (string | number)[][]): void {
  const esc = (c: string | number) => '"' + String(c).replace(/"/g, '""') + '"';
  const csv = rows.map((r) => r.map(esc).join(",")).join(String.fromCharCode(10));
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function RoundPage() {
  const params = useParams<{ roundNumber: string }>();
  const roundNumber = Number(params?.roundNumber ?? "");

  const [data, setData] = useState<RoundResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [shaResult, setShaResult] = useState<CheckResult | null>(null);
  const [beaconResult, setBeaconResult] = useState<CheckResult | null>(null);
  const [deriveResult, setDeriveResult] = useState<CheckResult | null>(null);
  const [eligQuery, setEligQuery] = useState("");

  useEffect(() => {
    if (!Number.isInteger(roundNumber) || roundNumber <= 0) {
      setLoading(false);
      setFetchError("This link doesn’t point to a draw.");
      return;
    }
    let alive = true;
    setLoading(true);
    setData(null);
    setFetchError(null);
    fetch(`/api/rounds/${roundNumber}`, { cache: "no-store" })
      .then(async (r) => {
        const j = (await r.json()) as RoundResp;
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        return j;
      })
      .then((d) => {
        if (!alive) return;
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setFetchError(String((e as Error).message ?? e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [roundNumber]);

  const round = data?.round ?? null;
  const chain = data?.chain ?? null;
  const net = (data?.network ?? "mainnet") as "mainnet" | "devnet";

  /** Run all three independent checks whenever the round data arrives. */
  useEffect(() => {
    if (!round || !round.randomnessValue || !round.randomnessSignature) {
      setShaResult(null);
      setBeaconResult(null);
      setDeriveResult(null);
      return;
    }
    let alive = true;
    const value = round.randomnessValue;
    const sig = round.randomnessSignature;

    // Check 1 (local): the saved number must equal SHA-256(signature). drand
    // quicknet defines randomness = sha256(signature), so this checks that the
    // two saved fields belong together.
    setShaResult({ state: "running", detail: "Computing SHA-256…" });
    sha256Hex(sig)
      .then((hash) => {
        if (!alive) return;
        if (hash === value.toLowerCase()) {
          setShaResult({
            state: "pass",
            detail: `SHA-256(signature) = ${hash.slice(0, 16)}… matches the saved number`,
          });
        } else {
          setShaResult({
            state: "fail",
            detail: `SHA-256(signature) = ${hash.slice(0, 16)}… does not match the saved number ${value.slice(0, 16)}…`,
          });
        }
      })
      .catch(() => {
        if (alive)
          setShaResult({
            state: "error",
            detail: "The browser could not hash the signature. Reload the page and try again.",
          });
      });

    // Check 2 (external): fetch the same round from the drand public beacon
    // (CORS-open) and compare the published randomness + signature.
    if (round.randomnessRound == null || !chain) {
      setBeaconResult({
        state: "idle",
        detail: "No beacon round was saved for this draw.",
      });
    } else {
      setBeaconResult({ state: "running", detail: "Fetching the round from drand.sh…" });
      fetch(`${chain.verifyBaseUrl}/${round.randomnessRound}`, {
        headers: { Accept: "application/json" },
      })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((j: { randomness?: string; signature?: string }) => {
          if (!alive) return;
          const gotRnd = (j.randomness ?? "").toLowerCase();
          const gotSig = (j.signature ?? "").toLowerCase();
          if (
            gotRnd &&
            gotRnd === value.toLowerCase() &&
            gotSig === sig.toLowerCase()
          ) {
            setBeaconResult({
              state: "pass",
              detail: `drand.sh published the same number and signature for beacon round ${round.randomnessRound}`,
            });
          } else {
            setBeaconResult({
              state: "fail",
              detail: `drand.sh returned different values for beacon round ${round.randomnessRound}`,
            });
          }
        })
        .catch(() => {
          if (alive)
            setBeaconResult({
              state: "error",
              detail: "drand.sh did not answer, so this check could not run. Reload to try again.",
            });
        });
    }

    // Check 3 (derivation): rebuild the winner selection from the saved number
    // and the saved wallet list, then compare rank by rank. It shows the winners
    // follow from those saved inputs; it cannot prove the inputs are originals.
    const eligible = data?.eligible ?? [];
    const source = data?.eligibleSource ?? "unavailable";
    const platformOk = data?.platformExclusionReproduced ?? false;
    if (source === "unavailable") {
      setDeriveResult({
        state: "idle",
        detail:
          "The holder snapshot for this draw is not available, so the winners cannot be rebuilt here.",
      });
    } else if (eligible.length === 0) {
      setDeriveResult({
        state: "idle",
        detail:
          "This draw saved no eligible holders, so there is nothing to rebuild.",
      });
    } else {
      setDeriveResult({
        state: "running",
        detail: `Re-running the shuffle over ${eligible.length} eligible holders…`,
      });
      reproduceWinners(value, eligible.map((e) => e.address), round.winners.length)
        .then((reproduced) => {
          if (!alive) return;
          const stored = round.winners;
          let mismatches = 0;
          const max = Math.max(reproduced.length, stored.length);
          for (let i = 0; i < max; i++) {
            if (reproduced[i]?.address !== stored[i]?.address) mismatches++;
          }
          const caveats =
            (source === "inferred" ? " · the snapshot was not saved with this draw" : "") +
            (!platformOk
              ? " · the project-wallet exclusion could not be rebuilt here"
              : "");
          if (mismatches === 0 && reproduced.length === stored.length) {
            setDeriveResult({
              state: "pass",
              detail: `Re-derived ${stored.length} ${stored.length === 1 ? "winner" : "winners"} from the saved wallet list and the number: same addresses, same order${caveats}`,
            });
          } else {
            setDeriveResult({
              state: "fail",
              detail: `Re-derived winners do not match the saved ones: ${mismatches} ${
                mismatches === 1 ? "rank differs" : "ranks differ"
              }${
                source === "inferred"
                  ? " · the snapshot was not saved with this draw, which can explain a mismatch"
                  : ""
              }`,
            });
          }
        })
        .catch(() => {
          if (alive)
            setDeriveResult({
              state: "error",
              detail: "The shuffle could not run in this browser. Reload the page and try again.",
            });
        });
    }

    return () => {
      alive = false;
    };
  }, [round, chain, data]);

  const checkColor = (s: CheckState): ChipColor =>
    s === "pass"
      ? "success"
      : s === "fail"
      ? "danger"
      : s === "error"
      ? "warning"
      : "default";
  const checkLabel = (s: CheckState): string =>
    s === "pass"
      ? "✓ Match"
      : s === "fail"
      ? "✗ Mismatch"
      : s === "error"
      ? "! Error"
      : s === "running"
      ? "Checking…"
      : "Waiting";

  return (
    <AppShell title="Draw">
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-10 pt-8 sm:pt-10 pb-12 flex flex-col gap-6">
        <div className="max-w-3xl">
          <div className="flex items-center gap-3">
            <Typography type="h4">
              {Number.isInteger(roundNumber) && roundNumber > 0 ? `Draw #${roundNumber}` : "Draw"}
            </Typography>
            {round && (
              <Chip size="sm" variant="soft" color={round.status === "completed" ? "success" : round.status === "failed" ? "danger" : round.status === "skipped" ? "default" : "warning"}>
                {statusLabel(round.status)}
              </Chip>
            )}
          </div>
          <Typography type="body-sm" color="muted" className="mt-1.5">
            {round && !round.randomnessValue
              ? "What stopped this draw, and what was saved with it."
              : "Who won, the random number that picked them, and the checks that let you confirm both against the values saved with the draw."}
          </Typography>
        </div>

        {fetchError && (
          <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
            Couldn’t load this draw. The link may be wrong, or the server didn’t answer. Try again in
            a moment.
          </div>
        )}

        {loading && (
          <>
            <div className="rounded-lg border border-(--border) bg-surface px-5 py-4 flex flex-col gap-4">
              <Skeleton className="h-5 w-32" />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
                <SkeletonStat label="Closed at" />
                <SkeletonStat label="Prize pool" />
                <SkeletonStat label="Eligible holders" />
                <SkeletonStat label="Beacon round" />
              </div>
            </div>
            <div className="rounded-lg border border-(--border) bg-surface px-5 py-4 flex flex-col gap-4">
              <Skeleton className="h-5 w-48" />
              <SkeletonRows count={3} />
            </div>
          </>
        )}

        {round && (
          <>
            <div className="rounded-lg border border-(--border) bg-surface px-5 py-4 flex flex-col gap-4">
              <h2 className="text-base font-semibold tracking-tight">Draw summary</h2>
              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-6 text-sm">
                <Field label="Closed at" value={fmtDate(round.completedAt)} />
                <Field label="Prize pool" value={fmtSolHuman(round.prizePoolSol)} mono />
                <Field label="Eligible holders" value={String(round.eligibleCount)} mono />
                <Field label="Beacon round" value={round.randomnessRound != null ? String(round.randomnessRound) : "Not recorded"} mono />
              </dl>
              <p className="text-xs text-muted">
                Prize pool is the amount available to pay winners in this draw. Winner payouts are net
                of any platform fee and rounding.
              </p>
              {round.error && (
                <p className={round.status === "failed" ? "text-sm text-danger" : "text-sm text-muted"} title={round.error}>
                  {roundNote(round)}
                </p>
              )}
            </div>

            {round.winners.length === 0 ? (
              round.error ? null : (
                <p className="text-sm text-muted">This draw picked no winners.</p>
              )
            ) : (
              <div className="table-bordered rounded-lg border border-(--border) overflow-hidden bg-surface">
                <Table variant="secondary">
                  {/* Five columns need ~540px; on a phone the table pans inside
                      its card rather than clipping the transaction column. */}
                  <Table.ScrollContainer
                    tabIndex={0}
                    className="overscroll-x-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                  >
                    <TableContent aria-label="Draw winners" className="min-w-[34rem] text-xs font-mono">
                      <TableHeader>
                        <TableColumn className="w-12">RANK</TableColumn>
                        <TableColumn isRowHeader>WINNER</TableColumn>
                        <TableColumn style={{ textAlign: "right" }}>PAYOUT</TableColumn>
                        <TableColumn style={{ textAlign: "center" }}>STATUS</TableColumn>
                        <TableColumn>TRANSACTION</TableColumn>
                      </TableHeader>
                      <TableBody>
                        {round.winners.map((w) => (
                          <TableRow key={w.rank}>
                            <TableCell className="text-muted font-mono">{w.rank}</TableCell>
                            <TableCell>
                              <a href={explorerUrl(w.address, "address", net)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-mono text-muted transition-colors hover:text-foreground hover:underline">
                                {shortAddress(w.address, 6, 6)}
                                <Icon name="arrow-up-right" className="h-3.5 w-3.5" />
                              </a>
                            </TableCell>
                            <TableCell className="text-right font-mono tabular-nums">{fmtSolHuman(w.amountSol)}</TableCell>
                            <TableCell className="text-center">
                              <Chip size="sm" variant="soft" color={w.status === "sent" ? "success" : w.status === "failed" ? "danger" : "warning"}>
                                {statusLabel(w.status)}
                              </Chip>
                            </TableCell>
                            <TableCell>
                              {w.payoutTx ? (
                                <a href={explorerUrl(w.payoutTx, "tx", net)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-mono text-muted transition-colors hover:text-foreground hover:underline">
                                  {shortAddress(w.payoutTx, 6, 6)}
                                  <Icon name="arrow-up-right" className="h-3.5 w-3.5" />
                                </a>
                              ) : (
                                <span className="text-muted">None</span>
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

            {round.randomnessValue && round.randomnessSignature ? (
              <div className="rounded-lg border border-(--border) bg-surface px-5 py-4 flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                  <h2 className="text-base font-semibold tracking-tight">Three checks on this page</h2>
                  <p className="text-sm text-muted">
                    When all three pass, the number is the one drand published and the winners follow
                    from that number and the saved wallet list. The checks cannot show that the list
                    holds every holder.
                  </p>
                </div>
                <CheckRow title="The saved number is the hash of its signature" hint="Local check: the number must be the SHA-256 hash of the signature saved with it. Editing one without the other fails here; the next check is what ties the signature to drand." result={shaResult} color={checkColor} label={checkLabel} />
                <CheckRow title="drand published the same number" hint="External check: fetches that beacon round from drand.sh and compares the number and signature with the values saved here." result={beaconResult} color={checkColor} label={checkLabel} />
                <CheckRow title="A fresh shuffle produces the same winners" hint="Rebuilds the winners from the saved wallet list and the saved number, then compares them rank by rank. It shows the winners follow from that list, not that the list holds every holder." result={deriveResult} color={checkColor} label={checkLabel} />
                {round.randomnessRound != null && chain && (
                  <ExternalLink href={`${chain.verifyBaseUrl}/${round.randomnessRound}`} className="self-start text-sm">
                    Open beacon round {round.randomnessRound} on drand.sh
                  </ExternalLink>
                )}
              </div>
            ) : (
              <div className="rounded-lg border border-(--border) bg-surface px-5 py-4 flex flex-col gap-2">
                <h2 className="text-base font-semibold tracking-tight">Nothing to check for this draw</h2>
                <p className="text-sm text-muted">
                  This draw has no saved random number, so there is no beacon round or winner
                  shuffle to compare. Skipped and failed draws can land here.
                </p>
              </div>
            )}

            <div className="rounded-lg border border-(--border) bg-surface px-5 py-4 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold tracking-tight">The wallet list for this draw</h2>
                {data && (
                  <Chip size="sm" variant="soft" color={data.eligibleSource === "recorded" ? "success" : data.eligibleSource === "inferred" ? "warning" : "default"}>
                    {SOURCE_LABEL[data.eligibleSource] ?? data.eligibleSource}
                  </Chip>
                )}
              </div>
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-6 text-sm">
                <Field label="Holders in the list" value={String(data?.eligible.length ?? 0)} mono />
                <Field label="Holders in the snapshot" value={String(data?.snapshotTotalHolders ?? 0)} mono />
                <Field
                  label="Addresses on the exclusion list"
                  value={String((data?.excludedAddresses ?? []).length)}
                  mono
                />
                <Field label="Snapshot time" value={fmtDate(data?.eligibleSnapshotCapturedAt ?? null)} />
              </dl>
              <div className="flex flex-col gap-2">
                <label className="text-xs font-mono uppercase text-muted" htmlFor="elig-check">
                  Was this wallet eligible for draw #{round.roundNumber}?
                </label>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input
                    id="elig-check"
                    type="text"
                    value={eligQuery}
                    onChange={(e) => setEligQuery(e.target.value)}
                    placeholder="Wallet address"
                    className="flex-1 rounded-md border border-(--border) bg-surface px-3 py-2 font-mono text-sm outline-none transition focus:border-accent"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  {eligQuery.trim() && data && (
                    <Chip size="sm" variant="soft" color={data.eligible.some((e) => e.address.toLowerCase() === eligQuery.trim().toLowerCase()) ? "success" : "default"}>
                      {data.eligible.some((e) => e.address.toLowerCase() === eligQuery.trim().toLowerCase()) ? "Yes, eligible" : "No, not eligible"}
                    </Chip>
                  )}
                </div>
              </div>
              <p className="text-xs text-muted">
                This is the list the draw picks from: every holder at or above the minimum balance in
                the snapshot, minus the project wallet, the {FEE_SOURCE_TITLE} venue (the bonding curve /
                pool that holds the liquidity) and any address on the exclusion list. A draw only shuffles this list, so an
                excluded wallet cannot be picked. When a draw predates saved lists, the closest earlier
                snapshot stands in, or the list shows as not available.
                {data && !data.platformExclusionReproduced && " · The project-wallet exclusion could not be rebuilt here."}
              </p>
              <Link href="/eligibility" className="inline-flex items-center gap-1.5 text-sm text-muted transition hover:text-foreground self-start">
                Browse current holders
                <Icon name="arrow-right" className="h-3.5 w-3.5" />
              </Link>
            </div>

            {(round.randomnessValue || round.randomnessSignature) && (
              <div className="rounded-lg border border-(--border) bg-surface px-5 py-4 flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                  <h2 className="text-base font-semibold tracking-tight">The exact values saved with this draw</h2>
                  <p className="text-sm text-muted">
                    These are the raw values behind the checks above, so you can reproduce them
                    elsewhere.
                  </p>
                </div>
                <Mono label="Random number" value={round.randomnessValue} />
                <Mono label="drand signature" value={round.randomnessSignature} />
              </div>
            )}

            {chain && (
              <div className="rounded-lg border border-(--border) bg-surface px-5 py-4 flex flex-col gap-4">
                <h2 className="text-base font-semibold tracking-tight">The drand beacon</h2>
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                  <Field label="Beacon chain" value={chain.name} mono />
                  <Field label="Signature scheme" value={chain.scheme === "bls-unchained-g1-rfc9380" ? "BLS unchained G1 (RFC 9380)" : chain.scheme} />
                  <Field label="New number every" value={chain.period === 1 ? "1 second" : `${chain.period} seconds`} />
                  <Field label="Chain live since" value="Aug 23, 2023" />
                </dl>
                <Mono label="Chain ID" value={chain.hash} />
                <Mono label="Public key" value={chain.publicKey} />
                <ExternalLink href={chain.verifyBaseUrl} className="self-start text-sm">
                  drand.sh beacon API
                </ExternalLink>
              </div>
            )}
          </>
        )}
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

function Mono({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-mono uppercase text-muted">{label}</span>
      <code className="block break-all rounded-md bg-default px-3 py-2 text-xs font-mono text-foreground">{value || "Not saved"}</code>
    </div>
  );
}

function CheckRow({
  title,
  hint,
  result,
  color,
  label,
}: {
  title: string;
  hint: string;
  result: CheckResult | null;
  color: (s: CheckState) => ChipColor;
  label: (s: CheckState) => string;
}) {
  const s = result?.state ?? "idle";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold">{title}</span>
        <Chip size="sm" variant="soft" color={color(s)}>
          {s === "idle" && result?.detail ? "Not run" : label(s)}
        </Chip>
      </div>
      <p className="text-xs text-muted">{hint}</p>
      {result?.detail && <p className="text-xs font-mono text-muted break-all">{result.detail}</p>}
    </div>
  );
}
