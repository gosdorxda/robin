"use client";

import { useEffect, useMemo, useState } from "react";
import { CircleCheck, CircleX, Clock, Minus } from "lucide-react";
import { Chip, Label, ListBox, Select, Typography } from "@heroui/react";
import { AppShell } from "@/components/AppShell";
import { SeedToWinner } from "@/components/SeedToWinner";
import { ExternalLink, Skeleton } from "@/components/ui";
import { fmtDateTimeUtc, fmtSolHuman } from "@/lib/format";

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

type RoundsResp = {
  network: "mainnet" | "devnet";
  chain: Chain | null;
  rounds: Round[];
  dbError: string | null;
};

function fmtDate(iso: string | null): string {
  // Every timestamp on the site is UTC (see fmtDateTimeUtc) — the visitor's
  // local clock made the same moment read two different times per page.
  return fmtDateTimeUtc(iso);
}

/** A skip has several causes (no eligible wallets, empty pool, pool below the
 *  minimum). Turn the stored reason into a sentence instead of printing the
 *  raw string, which carries driver-level wording. */
function skipReason(error: string | null): string {
  const reason = (error ?? "").toLowerCase();
  if (reason.includes("eligible")) {
    return "No wallet met the holding requirement, so this draw picked no winners.";
  }
  if (reason.includes("below minimum")) {
    return "The prize pool was below the minimum for a draw, so this draw picked no winners.";
  }
  if (reason.includes("reserve") || reason.includes("0 sol")) {
    return "The prize pool was empty, so this draw picked no winners.";
  }
  return "This draw was skipped, so no winners were picked.";
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

type CheckState = "idle" | "running" | "pass" | "fail" | "error";
type CheckResult = { state: CheckState; detail: string };
type ChipColor = "success" | "danger" | "warning" | "default";

/** DB status -> the words we show. Never print the raw enum on the page. */
const STATUS_LABEL: Record<string, string> = {
  completed: "Completed",
  skipped: "Skipped",
  failed: "Failed",
  drawing: "In progress",
  pending: "Pending",
};

const statusLabel = (status: string): string =>
  STATUS_LABEL[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
export default function VerifyPage() {
  const [data, setData] = useState<RoundsResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [shaResult, setShaResult] = useState<CheckResult | null>(null);
  const [beaconResult, setBeaconResult] = useState<CheckResult | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/rounds", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: RoundsResp) => {
        if (!alive) return;
        setData(d);
        const firstWithRound = d.rounds.find((r) => r.randomnessRound != null);
        if (firstWithRound) setSelected(firstWithRound.roundNumber);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setFetchError(String(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const rounds = useMemo(() => data?.rounds ?? [], [data]);
  const chain = data?.chain ?? null;
  const current = useMemo(
    () => rounds.find((r) => r.roundNumber === selected) ?? null,
    [rounds, selected],
  );

  /** Run both independent checks whenever the selected round changes. */
  useEffect(() => {
    if (!current || !current.randomnessValue || !current.randomnessSignature) {
      setShaResult(null);
      setBeaconResult(null);
      return;
    }
    let alive = true;
    const value = current.randomnessValue;
    const sig = current.randomnessSignature;

    // Check 1 — local: randomness must equal SHA-256(signature). drand quicknet
    // defines randomness = sha256(signature), so this is a zero-trust check that
    // the two stored fields are internally consistent.
    setShaResult({ state: "running", detail: "computing SHA-256…" });
    sha256Hex(sig)
      .then((hash) => {
        if (!alive) return;
        if (hash === value.toLowerCase()) {
          setShaResult({
            state: "pass",
            detail: `SHA-256(signature) = ${hash.slice(0, 16)}… matches the stored randomness`,
          });
        } else {
          setShaResult({
            state: "fail",
            detail: `SHA-256(signature) = ${hash.slice(0, 16)}… ≠ stored randomness ${value.slice(0, 16)}…`,
          });
        }
      })
      .catch(() => {
        if (!alive) return;
        setShaResult({
          state: "error",
          detail: "The SHA-256 check couldn't run in this browser. Open this page over HTTPS in a current browser.",
        });
      });

    // Check 2 — external: fetch the same round from the drand public beacon
    // (CORS-open) and compare the published randomness + signature.
    if (current.randomnessRound == null || !chain) {
      setBeaconResult({ state: "idle", detail: "no beacon round recorded for this draw" });
      return;
    }
    setBeaconResult({ state: "running", detail: "fetching drand.sh…" });
    const url = `${chain.verifyBaseUrl}/${current.randomnessRound}`;
    fetch(url, { headers: { Accept: "application/json" } })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: { randomness?: string; signature?: string; round?: number }) => {
        if (!alive) return;
        const gotRnd = (j.randomness ?? "").toLowerCase();
        const gotSig = (j.signature ?? "").toLowerCase();
        const randMatch = gotRnd !== "" && gotRnd === value.toLowerCase();
        const sigMatch = gotSig !== "" && gotSig === sig.toLowerCase();
        const roundMatch = j.round == null || j.round === current.randomnessRound;
        if (randMatch && sigMatch && roundMatch) {
          setBeaconResult({
            state: "pass",
            detail: `drand.sh published the same randomness and signature for beacon round ${current.randomnessRound}`,
          });
        } else {
          const diff: string[] = [];
          if (!roundMatch) {
            diff.push(`round ${j.round} ≠ ${current.randomnessRound}`);
          }
          if (!randMatch) {
            diff.push(`randomness ${gotRnd.slice(0, 16) || "(empty)"} ≠ ${value.slice(0, 16)}`);
          }
          if (!sigMatch) {
            diff.push(`signature ${gotSig.slice(0, 16) || "(empty)"} ≠ ${sig.slice(0, 16)}`);
          }
          setBeaconResult({
            state: "fail",
            detail: `drand.sh disagrees with the saved values: ${diff.join("; ")}`,
          });
        }
      })
      .catch(() => {
        if (!alive) return;
        setBeaconResult({
          state: "error",
          detail: "drand.sh couldn't be reached or returned an error. Refresh to try again.",
        });
      });

    return () => {
      alive = false;
    };
  }, [current, chain]);

  const checkColor = (s: CheckState): ChipColor =>
    s === "pass" ? "success" : s === "fail" ? "danger" : s === "error" ? "warning" : "default";
  const checkLabel = (s: CheckState): string =>
    s === "pass" ? "✓ Match" : s === "fail" ? "✗ Mismatch" : s === "error" ? "! Error" : s === "running" ? "Checking…" : "Waiting";

  return (
    <AppShell title="Verify">
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-10 pt-8 sm:pt-10 pb-12">
        <div className="max-w-3xl flex flex-col gap-6">
          <header>
            <Typography type="h4">Check a draw yourself</Typography>
            <Typography type="body-sm" color="muted" className="mt-1.5">
              Draws start with a random number that drand publishes: a public beacon run by
              independent organisations, not by us. Pick a draw and your browser checks three
              things: the saved number is the hash of its signature, drand published that same
              number, and the shuffle shown here reproduces the winners listed. Skipped draws stop
              before the beacon, so there is nothing to check for them.
            </Typography>
          </header>

          {fetchError && (
            <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
              Couldn’t load the draws. Refresh the page to try again.
            </div>
          )}
          {data?.dbError && (
            <div className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
              The draw history is temporarily unavailable. Refresh in a moment.
            </div>
          )}

          <div className="rounded-lg border border-(--border) bg-surface p-6 flex flex-col gap-2">
            {loading ? (
              <>
                <span className="text-xs font-mono uppercase text-muted">Draw to check</span>
                <Skeleton className="h-11 w-full" />
              </>
            ) : rounds.length === 0 ? (
              <>
                <span className="text-xs font-mono uppercase text-muted">Draw to check</span>
                <p className="text-sm text-muted">No draws to check yet.</p>
              </>
            ) : (
              <Select
                fullWidth
                placeholder="Pick a draw"
                selectedKey={selected}
                onSelectionChange={(key) =>
                  setSelected(key == null ? null : Number(key))
                }
              >
                <Label className="text-xs font-mono uppercase text-muted">
                  Draw to check
                </Label>
                {/* HeroUI trigger: the chevron is a positioned indicator, so it
                    stays centered on the control instead of the native select's
                    OS-drawn arrow. Border + surface bg keep it visible on the
                    card (this theme ships a transparent --field-border). */}
                <Select.Trigger className="w-full items-center border border-(--border) bg-surface text-sm focus-visible:border-accent">
                  {/* Explicit children keep the trigger on one line: rendering the
                      highlighted ListBox.Item instead would copy its two-column row
                      (date + winner count) into the single-line control. */}
                  <Select.Value className="min-w-0 truncate font-mono">
                    {current ? (
                      <>
                        Draw #{current.roundNumber}
                        <span className="hidden text-muted sm:inline">
                          {" · "}
                          {fmtDate(current.completedAt)}
                        </span>
                      </>
                    ) : (
                      "Pick a draw"
                    )}
                  </Select.Value>
                  <Select.Indicator className="text-muted" />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {rounds.map((r) => (
                      <ListBox.Item
                        key={r.roundNumber}
                        id={r.roundNumber}
                        textValue={`Draw #${r.roundNumber}, ${fmtDate(r.completedAt)}`}
                      >
                        <span className="flex w-full items-baseline gap-3">
                          <span className="font-mono text-sm tabular-nums">
                            Draw #{r.roundNumber}
                          </span>
                          <span className="ml-auto truncate text-xs text-muted">
                            {fmtDate(r.completedAt)} ·{" "}
                            {r.winners.length === 0
                              ? "no winners"
                              : `${r.winners.length} winners`}
                          </span>
                        </span>
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            )}
          </div>

          {current && (
            <>
              <div className="rounded-lg border border-(--border) bg-surface p-6 flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <Typography type="h5">Draw #{current.roundNumber}</Typography>
                  <RoundStatusChip status={current.status} />
                </div>
                <dl className="flex flex-col gap-3 text-sm">
                  <Field label="Beacon round" value={current.randomnessRound != null ? String(current.randomnessRound) : "—"} mono />
                  <Field label="Finished" value={fmtDate(current.completedAt)} />
                  <Field label="Eligible wallets" value={String(current.eligibleCount)} mono />
                  <Field label="Prize pool" value={fmtSolHuman(current.prizePoolSol)} mono />
                  {current.error && (
                    <Field
                      label="Note"
                      value={
                        current.status === "skipped"
                          ? skipReason(current.error)
                          : "This draw stopped before it finished."
                      }
                    />
                  )}
                </dl>
              </div>

              {current.randomnessValue && (
                <SeedToWinner round={current} network={data?.network ?? "mainnet"} />
              )}

              {current.randomnessValue ? (
                <div className="rounded-lg border border-(--border) bg-surface p-6 flex flex-col gap-5">
                  <div className="flex flex-col gap-1">
                    <Typography type="h5">Two checks on the saved number</Typography>
                    <p className="text-sm text-muted">
                      When both checks pass, the saved random number is the one drand published.
                      The winners are checked separately, by re-running the shuffle above.
                    </p>
                  </div>
                  <CheckRow
                    title="The saved number is the hash of its signature"
                    hint="Local check: the number we saved must be the SHA-256 hash of the signature we saved. An edited value fails here."
                    result={shaResult}
                    color={checkColor}
                    label={checkLabel}
                  />
                  <CheckRow
                    title="drand published the same number"
                    hint="External check: fetches that beacon round from drand.sh and compares it with what we stored."
                    result={beaconResult}
                    color={checkColor}
                    label={checkLabel}
                  />
                  {current.randomnessRound != null && chain && (
                    <ExternalLink
                      href={`${chain.verifyBaseUrl}/${current.randomnessRound}`}
                      className="self-start text-sm"
                    >
                      See that round on drand.sh
                    </ExternalLink>
                  )}
                </div>
              ) : (
                <div className="rounded-lg border border-(--border) bg-surface p-6 flex flex-col gap-2">
                  <Typography type="h5">Nothing to check for this draw</Typography>
                  <p className="text-sm text-muted">
                    This draw stopped before it requested a random number, so there is no beacon
                    round or winner shuffle to compare. Skipped and failed draws can land here.
                  </p>
                </div>
              )}

              <div className="rounded-lg border border-(--border) bg-surface p-6 flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                  <Typography type="h5">The exact values we stored</Typography>
                  <p className="text-sm text-muted">
                    Copy these if you want to check the draw somewhere else.
                  </p>
                </div>
                <Mono label="Random number" value={current.randomnessValue} />
                <Mono label="drand signature" value={current.randomnessSignature} />
              </div>
            </>
          )}

          {chain && (
            <div className="rounded-lg border border-(--border) bg-surface p-6 flex flex-col gap-4">
              <Typography type="h5">The drand beacon</Typography>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <Field label="Beacon chain" value={chain.name} mono />
                <Field label="Signature scheme" value={chain.scheme} mono />
                <Field label="New number every" value={`${chain.period}s`} mono />
                <Field label="Live since" value="2023-08-23" mono />
              </dl>
              <div className="flex flex-col gap-3">
                <Mono label="Chain ID" value={chain.hash} />
                <Mono label="Public key" value={chain.publicKey} />
              </div>
              <ExternalLink href={chain.verifyBaseUrl} className="self-start text-sm">
                drand.sh beacon API
              </ExternalLink>
            </div>
          )}

          {chain && (
            <section className="rounded-lg border border-(--border) bg-default/40 overflow-hidden">
              {/* Header */}
              <div className="px-5 py-4 border-b border-(--border) bg-surface">
                <Typography type="h5">Where the random number comes from</Typography>
                <p className="mt-1 text-sm text-muted leading-relaxed">
                  Nobody, not even the team, picks the number. Here is the chain,
                  from the beacon to the winners.
                </p>
              </div>

              {/* Steps */}
              <ol className="px-5 py-5 flex flex-col gap-5">
                <li className="flex gap-3">
                  <span className="shrink-0 mt-0.5 size-7 rounded-full bg-accent/10 text-accent flex items-center justify-center text-xs font-bold ring-1 ring-accent/20">
                    1
                  </span>
                  <div className="flex flex-col gap-1 min-w-0">
                    <p className="text-sm font-semibold">A random number nobody controls</p>
                    <p className="text-sm text-muted leading-relaxed">
                      <ExternalLink
                        href={chain.verifyBaseUrl}
                        tone="foreground"
                        className="font-medium"
                        iconClassName="h-3 w-3 opacity-50"
                      >
                        drand.sh
                      </ExternalLink>{" "}
                      is a group of independent servers around the world that publish
                      a new random number every{" "}
                      <span className="font-mono text-foreground">
                        {chain.period}s
                      </span>
                      . Each one is signed, so anyone can check it is genuine, and no
                      single party can predict or bend the result.
                    </p>
                  </div>
                </li>

                <li className="flex gap-3">
                  <span className="shrink-0 mt-0.5 size-7 rounded-full bg-accent/10 text-accent flex items-center justify-center text-xs font-bold ring-1 ring-accent/20">
                    2
                  </span>
                  <div className="flex flex-col gap-1 min-w-0">
                    <p className="text-sm font-semibold">The draw saves that number</p>
                    <p className="text-sm text-muted leading-relaxed">
                      When a draw runs, it takes the newest published number, a long
                      hex string, and stores it with the draw for good. That number is
                      the seed: everything else follows from it. You can see the exact
                      value and which drand round it came from, right on this page.
                    </p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="shrink-0 mt-0.5 size-7 rounded-full bg-accent/10 text-accent flex items-center justify-center text-xs font-bold ring-1 ring-accent/20">
                    3
                  </span>
                  <div className="flex flex-col gap-1 min-w-0">
                    <p className="text-sm font-semibold">The seed shuffles the wallets</p>
                    <p className="text-sm text-muted leading-relaxed">
                      The seed is hashed to produce a long stream of random numbers.
                      That stream shuffles the list of eligible wallets like a deck of
                      cards (the Fisher–Yates shuffle). The first{" "}
                      <span className="font-mono text-foreground">N</span> wallets after
                      the shuffle are the winners, in rank order. Same seed and same
                      wallets always give the same winners. Run it a thousand times and
                      nothing changes.
                    </p>
                  </div>
                </li>

                <li className="flex gap-3">
                  <span className="shrink-0 mt-0.5 size-7 rounded-full bg-success/10 text-success flex items-center justify-center text-xs font-bold ring-1 ring-success/20">
                    ✓
                  </span>
                  <div className="flex flex-col gap-1 min-w-0">
                    <p className="text-sm font-semibold">You just checked it</p>
                    <p className="text-sm text-muted leading-relaxed">
                      Pick a draw above. Your browser fetches the same number from
                      drand.sh, so a swapped seed can&apos;t slip through, and confirms
                      the stored number is the hash of the stored signature. It then
                      re-runs the shuffle. The comparisons happen in your browser, not
                      on our servers.
                    </p>
                  </div>
                </li>
              </ol>
            </section>
          )}
        </div>
      </main>
    </AppShell>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-xs font-mono uppercase text-muted">{label}</dt>
      <dd className={`text-right ${mono ? "font-mono tabular-nums" : ""}`}>{value}</dd>
    </div>
  );
}

function Mono({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-mono uppercase text-muted">{label}</span>
      <code className="block break-all rounded-md bg-default px-3 py-2 text-xs font-mono text-foreground">
        {value || "—"}
      </code>
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
          {label(s)}
        </Chip>
      </div>
      <p className="text-xs text-muted">{hint}</p>
      {result?.detail && (
        <p className="text-xs font-mono text-muted break-all">{result.detail}</p>
      )}
    </div>
  );
}

/** Round status chip — icon + label, mirroring the draws list so a status reads
 *  the same way everywhere (check / cross / dash / clock instead of colour alone). */
function RoundStatusChip({ status }: { status: string }) {
  const color: ChipColor =
    status === "completed"
      ? "success"
      : status === "failed"
        ? "danger"
        : status === "skipped"
          ? "default"
          : "warning";
  return (
    <Chip size="sm" variant="soft" color={color}>
      {color === "success" ? (
        <CircleCheck size={14} aria-hidden="true" />
      ) : color === "danger" ? (
        <CircleX size={14} aria-hidden="true" />
      ) : color === "default" ? (
        <Minus size={14} aria-hidden="true" />
      ) : (
        <Clock size={14} aria-hidden="true" />
      )}
      <Chip.Label>{statusLabel(status)}</Chip.Label>
    </Chip>
  );
}