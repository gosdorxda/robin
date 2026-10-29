"use client";

import { useEffect, useState } from "react";
import { Chip, Typography } from "@heroui/react";
import { Skeleton } from "@/components/ui";
import { shortAddress, explorerUrl } from "@/lib/format";
import { reproduceWinners, type ReproducedWinner } from "@/lib/lottery/verify";

/**
 * SeedToWinner — the "how a hash becomes a wallet" explainer for /verify.
 *
 * Three parts:
 *  (A) A 4-step pipeline (signature -> SHA-256 -> seed -> PRNG stream ->
 *      Fisher-Yates shuffle of the sorted eligible list -> top N win) with the
 *      selected round's real values plugged in.
 *  (B) A LIVE reproduction: fetches the exact eligible pool from
 *      /api/rounds/[n], re-runs reproduceWinners() in-browser (Web Crypto),
 *      shows the winners YOUR browser derived, and confirms rank-for-rank they
 *      match the stored ones -- so the draw wasn't hand-picked.
 *  (C) A tiny worked example on 5 mock wallets so a reader can SEE the swap
 *      mechanic at human scale.
 *
 * The real verification (B) uses the shared reproduceWinners from
 * @/lib/lottery/verify. Only the pedagogical worked example (C) uses the local
 * annotateShuffle mirror below -- it never feeds a verdict.
 */

type SeedWinner = { rank: number; address: string };

export type SeedRound = {
  roundNumber: number;
  randomnessValue: string | null;
  randomnessSignature: string | null;
  randomnessRound: number | null;
  eligibleCount: number;
  winners: SeedWinner[];
};

type EligibleEntry = { address: string; amount: string };
type RoundDetail = {
  eligible?: EligibleEntry[];
  eligibleSource?: "recorded" | "inferred" | "unavailable";
  snapshotTotalHolders?: number;
  platformExclusionReproduced?: boolean;
  error?: string;
};

type Verdict = "idle" | "checking" | "match" | "mismatch" | "unavailable" | "error";
type ChipColor = "default" | "success" | "warning" | "danger";

/** Tailwind classes for a circular rank badge -- mirrors DrawsList.tsx exactly. */
const rankBadge = (rank: number): string => {
  switch (rank) {
    case 1:
      return "bg-accent/10 text-accent ring-1 ring-accent/20";
    case 2:
      return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
    case 3:
      return "bg-orange-100 text-orange-900 ring-1 ring-orange-200";
    default:
      return "bg-default text-muted ring-1 ring-(--border)";
  }
};

/** SHA-256 of raw bytes -> raw bytes (Web Crypto). Mirrors verify.ts' sha256Bytes. */
async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer);
  return new Uint8Array(digest);
}

type SwapTrace = { i: number; j: number };
type AnnotatedShuffle = {
  sorted: string[];
  order: number[];
  swaps: SwapTrace[];
  winners: SeedWinner[];
};

/**
 * Pedagogical mirror of verify.ts' makeRng + Fisher-Yates, used ONLY to render
 * the worked example. seed = SHA-256(utf8 of seedHex); each step chains SHA-256
 * over the previous 32-byte digest and reads a big-endian uint64 -- identical to
 * the server/client reproduction. Returns the full swap trace for display.
 */
async function annotateShuffle(
  seedHex: string,
  addrs: string[],
  winnerCount: number,
): Promise<AnnotatedShuffle> {
  const sorted = [...addrs].sort((a, b) => a.localeCompare(b));
  const n = sorted.length;
  if (n === 0) return { sorted, order: [], swaps: [], winners: [] };
  let state = await sha256Bytes(new TextEncoder().encode(seedHex));
  const rng = async (): Promise<bigint> => {
    state = await sha256Bytes(state);
    return new DataView(state.buffer).getBigUint64(0, false);
  };
  const order = sorted.map((_, i) => i);
  const swaps: SwapTrace[] = [];
  for (let i = order.length - 1; i > 0; i--) {
    const r = await rng();
    const j = Number(r % BigInt(i + 1));
    [order[i], order[j]] = [order[j], order[i]];
    swaps.push({ i, j });
  }
  const count = Math.min(winnerCount, n);
  const winners: SeedWinner[] = Array.from({ length: count }, (_, r) => ({
    rank: r + 1,
    address: sorted[order[r]],
  }));
  return { sorted, order, swaps, winners };
}

// Fixed mock input for the worked example (5 wallets, 2 winners).
const DEMO_SEED =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const DEMO_WALLETS = ["Wallet A", "Wallet B", "Wallet C", "Wallet D", "Wallet E"];
const DEMO_WINNERS = 2;

export function SeedToWinner({
  round,
  network,
}: {
  round: SeedRound;
  network: "mainnet" | "devnet";
}) {
  const [detail, setDetail] = useState<RoundDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reproduced, setReproduced] = useState<ReproducedWinner[] | null>(null);
  const [verdict, setVerdict] = useState<Verdict>("idle");
  const [verdictNote, setVerdictNote] = useState<string>("");
  const [demo, setDemo] = useState<AnnotatedShuffle | null>(null);

  // Worked example: computed once on mount (fixed mock input).
  useEffect(() => {
    let alive = true;
    annotateShuffle(DEMO_SEED, DEMO_WALLETS, DEMO_WINNERS).then((d) => {
      if (alive) setDemo(d);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Live reproduction for the selected round.
  useEffect(() => {
    if (!round.randomnessValue) {
      setDetail(null);
      setReproduced(null);
      setVerdict("unavailable");
      setVerdictNote(
        "This draw has no saved random number, so the shuffle can't be re-run.",
      );
      return;
    }
    if (round.winners.length === 0) {
      setDetail(null);
      setReproduced(null);
      setVerdict("unavailable");
      setVerdictNote("This draw recorded no winners.");
      return;
    }
    const value = round.randomnessValue; // string (narrowed after the guard above)
    let alive = true;
    setDetailLoading(true);
    setDetail(null);
    setReproduced(null);
    setVerdict("checking");
    setVerdictNote(
      "Loading the holder list and re-running the shuffle in your browser…",
    );
    fetch(`/api/rounds/${round.roundNumber}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: RoundDetail) => {
        if (!alive) return;
        if (d.error) throw new Error(d.error);
        setDetail(d);
        setDetailLoading(false);
        const eligible = d.eligible ?? [];
        if (eligible.length === 0 || d.eligibleSource === "unavailable") {
          setVerdict("unavailable");
          setVerdictNote(
            "No holder snapshot was saved for this draw, so the shuffle can't be re-run.",
          );
          return;
        }
        reproduceWinners(value, eligible.map((e) => e.address), round.winners.length)
          .then((reps) => {
            if (!alive) return;
            setReproduced(reps);
            const stored = [...round.winners].sort((a, b) => a.rank - b.rank);
            const same =
              reps.length === stored.length &&
              reps.every(
                (w, i) =>
                  w.address.toLowerCase() ===
                  (stored[i]?.address ?? "").toLowerCase(),
              );
            if (same) {
              setVerdict("match");
              setVerdictNote(
                d.eligibleSource === "inferred"
                  ? `Your browser worked out the same ${reps.length} winners, rank for rank, using the closest snapshot saved before this draw.`
                  : `Your browser worked out the same ${reps.length} winners, rank for rank, from the saved number and the saved wallet list.`,
              );
            } else {
              setVerdict("mismatch");
              setVerdictNote(
                d.eligibleSource === "inferred"
                  ? "The winners your browser found don't match the saved ones. The wallet list was rebuilt from the closest snapshot, so check that first."
                  : "The winners your browser found don't match the saved ones. This draw should be investigated.",
              );
            }
          })
          .catch(() => {
            if (!alive) return;
            setVerdict("error");
            setVerdictNote(
              "The re-run didn't finish in this browser. Refresh the page to try again.",
            );
          });
      })
      .catch(() => {
        if (!alive) return;
        setDetailLoading(false);
        setVerdict("error");
        setVerdictNote(
          "The wallet list for this draw couldn't be loaded. Refresh the page to try again.",
        );
      });
    return () => {
      alive = false;
    };
  }, [round]);

  const value = round.randomnessValue;
  const storedSorted = [...round.winners].sort((a, b) => a.rank - b.rank);

  return (
    <section className="rounded-lg border border-(--border) bg-default/40 overflow-hidden">
      <div className="px-5 py-4 border-b border-(--border) bg-surface">
        <Typography type="h5">From a random number to the winners</Typography>
        <p className="mt-1 text-sm text-muted leading-relaxed">
          The checks on this page test the random number against drand. Here is how it
          becomes the winning wallets, and your browser works this draw out again, live,
          to compare.
        </p>
      </div>

      <div className="px-5 py-5 flex flex-col gap-5">
        {/* Part A — the pipeline */}
        <div className="flex flex-col gap-4">
          <p className="text-sm font-semibold">Four steps from number to winners</p>
          <ol className="flex flex-col gap-3">
            <li className="flex gap-3">
              <span className="shrink-0 mt-0.5 size-7 rounded-full bg-default text-foreground flex items-center justify-center text-xs font-bold ring-1 ring-(--border)">
                1
              </span>
              <div className="flex flex-col gap-1.5 min-w-0 flex-1">
                <p className="text-sm font-semibold">The signature becomes the seed</p>
                <p className="text-sm text-muted leading-relaxed">
                  drand signs every number it publishes. The randomness stored on this draw
                  is the SHA-256 hash of that signature, 256 bits nobody could predict or
                  steer.
                </p>
                {value && (
                  <code className="rounded-md bg-default px-2.5 py-1.5 font-mono text-xs break-all text-foreground">
                    {value}
                  </code>
                )}
              </div>
            </li>

            <li className="flex gap-3">
              <span className="shrink-0 mt-0.5 size-7 rounded-full bg-default text-foreground flex items-center justify-center text-xs font-bold ring-1 ring-(--border)">
                2
              </span>
              <div className="flex flex-col gap-1.5 min-w-0 flex-1">
                <p className="text-sm font-semibold">The seed becomes a stream of numbers</p>
                <p className="text-sm text-muted leading-relaxed">
                  The seed is hashed with SHA-256 to start a chain: each step hashes the
                  previous 32-byte digest and reads a big-endian 64-bit integer. That
                  deterministic stream drives the shuffle. Same seed, same stream, every
                  time.
                </p>
              </div>
            </li>

            <li className="flex gap-3">
              <span className="shrink-0 mt-0.5 size-7 rounded-full bg-default text-foreground flex items-center justify-center text-xs font-bold ring-1 ring-(--border)">
                3
              </span>
              <div className="flex flex-col gap-1.5 min-w-0 flex-1">
                <p className="text-sm font-semibold">The holder list gets numbered</p>
                <p className="text-sm text-muted leading-relaxed">
                  A snapshot of every wallet holding at least the minimum is taken, the
                  exclusion list is applied (the project wallet, the token&apos;s liquidity
                  accounts, and any blocked address), and the rest is sorted by address.
                  Each wallet gets a stable index{" "}
                  <span className="font-mono text-foreground">0…N-1</span>. This draw had{" "}
                  <span className="font-mono text-foreground">{round.eligibleCount}</span>{" "}
                  eligible wallets.
                </p>
              </div>
            </li>

            <li className="flex gap-3">
              <span className="shrink-0 mt-0.5 size-7 rounded-full bg-accent/10 text-accent flex items-center justify-center text-xs font-bold ring-1 ring-accent/20">
                ★
              </span>
              <div className="flex flex-col gap-1.5 min-w-0 flex-1">
                <p className="text-sm font-semibold">The shuffle picks the winners</p>
                <p className="text-sm text-muted leading-relaxed">
                  The stream shuffles the list like a deck of cards (Fisher–Yates). The first{" "}
                  <span className="font-mono text-foreground">{round.winners.length}</span>{" "}
                  wallets after the shuffle are the winners, in rank order. Same seed and
                  same list always give the same winners.
                </p>
              </div>
            </li>
          </ol>
        </div>

        {/* Part B — live reproduction for this round */}
        <div className="flex flex-col gap-3 border-t border-(--border) pt-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold">Re-run for draw #{round.roundNumber}</p>
            <VerdictChip verdict={verdict} />
          </div>
          <p className="text-sm text-muted leading-relaxed">{verdictNote}</p>

          {detail && detail.eligibleSource && detail.eligibleSource !== "unavailable" && (
            <p className="text-xs text-muted">
              Wallet list used for the re-run:{" "}
              <span className="font-mono text-foreground">
                {detail.eligible?.length ?? 0}
              </span>{" "}
              addresses, sorted
              {detail.eligibleSource === "inferred"
                ? " (rebuilt from the closest snapshot before this draw, so it may not match the original list exactly)"
                : ""}
              {detail.platformExclusionReproduced === false
                ? " (the project wallet exclusion could not be rebuilt, so the pool may include it)"
                : ""}
              .
            </p>
          )}

          {detailLoading && (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-3/4" />
            </div>
          )}

          {reproduced && reproduced.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-mono uppercase text-muted">
                Winners your browser just worked out
              </p>
              <ul className="flex flex-col">
                {reproduced.map((w) => {
                  const stored = storedSorted[w.rank - 1];
                  const match =
                    stored != null &&
                    stored.address.toLowerCase() === w.address.toLowerCase();
                  return (
                    <li
                      key={w.rank}
                      className="flex items-center gap-3 border-b border-(--border) py-2 last:border-0"
                    >
                      <span
                        className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold tabular-nums ${rankBadge(w.rank)}`}
                      >
                        {w.rank}
                      </span>
                      <a
                        href={explorerUrl(w.address, "address", network)}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-sm text-muted transition-colors hover:text-foreground hover:underline"
                      >
                        {shortAddress(w.address)}
                      </a>
                      <span className="ml-auto text-xs">
                        {match ? (
                          <span className="text-success">✓ same as the saved winner</span>
                        ) : (
                          <span className="text-danger">
                            ✗ expected{" "}
                            <span className="font-mono">
                              {stored ? shortAddress(stored.address) : "—"}
                            </span>
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        {/* Part C — worked example on 5 mock wallets */}
        {demo && (
          <div className="flex flex-col gap-3 border-t border-(--border) pt-5">
            <p className="text-sm font-semibold">Watch the shuffle on five wallets</p>
            <p className="text-sm text-muted leading-relaxed">
              A toy example, so you can see the shuffle itself. Five wallets, sorted by
              address, are shuffled with a fixed seed. The first two after the shuffle win.
              This is exactly what happens in a real draw, just small enough to follow.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="flex flex-col gap-2">
                <p className="text-xs font-mono uppercase text-muted">Sorted list</p>
                <ol className="flex flex-col gap-1 text-sm">
                  {demo.sorted.map((addr, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="font-mono text-muted w-6">#{i}</span>
                      <span className="text-foreground">{addr}</span>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="flex flex-col gap-2">
                <p className="text-xs font-mono uppercase text-muted">Shuffle steps</p>
                <ol className="flex flex-col gap-1 text-sm font-mono text-foreground">
                  {demo.swaps.map((s, k) => (
                    <li key={k}>
                      i={s.i} ↔ j={s.j}
                    </li>
                  ))}
                </ol>
                <p className="text-xs text-muted leading-relaxed">
                  Each step swaps position <span className="font-mono">i</span> with a
                  random position <span className="font-mono">j ≤ i</span>.
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <p className="text-xs font-mono uppercase text-muted">
                  Final order (top wins)
                </p>
                <ol className="flex flex-col gap-1 text-sm">
                  {demo.order.map((idx, pos) => {
                    const isWinner = pos < DEMO_WINNERS;
                    return (
                      <li key={pos} className="flex items-center gap-2">
                        <span
                          className={`shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold ${isWinner ? rankBadge(pos + 1) : "bg-default text-muted ring-1 ring-(--border)"}`}
                        >
                          {pos + 1}
                        </span>
                        <span
                          className={isWinner ? "text-foreground font-semibold" : "text-muted"}
                        >
                          {demo.sorted[idx]}
                        </span>
                        {isWinner && (
                          <span className="ml-auto text-xs text-accent">winner</span>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function VerdictChip({ verdict }: { verdict: Verdict }) {
  const map: Record<Verdict, { color: ChipColor; label: string }> = {
    idle: { color: "default", label: "Waiting" },
    checking: { color: "warning", label: "Checking…" },
    match: { color: "success", label: "✓ Same winners" },
    mismatch: { color: "danger", label: "✗ Mismatch" },
    unavailable: { color: "default", label: "Unavailable" },
    error: { color: "warning", label: "! Error" },
  };
  const { color, label } = map[verdict];
  return (
    <Chip size="sm" variant="soft" color={color}>
      {label}
    </Chip>
  );
}


