import { createHash } from "node:crypto";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { getConfig } from "../config";
import { getEffectiveConfig } from "../settings";
import { prisma } from "../prisma";
import { getConnection, getPlatformKeypair, getTreasuryPubkey } from "../solana/connection";
import { getChain } from "../chain";
import type { PayoutError } from "../chain/types";
import { toBigInt, toDecimalValue } from "../db-amount";
import { CHAIN_KIND, CHAIN_LABEL, NATIVE_SYMBOL } from "../chain/network";
import { requestRandomness } from "../solana/randomness";
import { lamportsToSol } from "../format";
import { logEvent } from "../log-buffer";
import { notifyWinners } from "../notifications";
import { notifyDrawResult } from "../telegram-bot";
import { getDrawExclusions } from "../exclusions";

export interface EligibleHolder {
  address: string;
  amount: bigint;
}

export interface WinnerPick {
  rank: number;
  address: string;
  share: number;
}

export interface LotteryRoundResult {
  roundId: string;
  roundNumber: number;
  status: "completed" | "failed" | "skipped";
  winners: {
    rank: number;
    address: string;
    amountLamports: string;
    payoutTx: string | null;
  }[];
  prizePoolLamports: string;
  eligibleCount: number;
  randomnessValue: string | null;
  randomnessSignature: string | null;
  randomnessRound: number | null;
  randomnessVerified: boolean;
  error?: string;
}

function sha256(data: Buffer | string): Buffer {
  return createHash("sha256").update(data).digest();
}

/** Deterministic PRNG seeded by the drand random value (hex string). */
function makeRng(seedHex: string): () => bigint {
  let state = sha256(seedHex);
  return () => {
    state = sha256(state);
    return state.readBigUInt64BE(0);
  };
}

/**
 * Reads the latest holder snapshot batch from the DB and returns wallets whose
 * balance is >= minTokenEligible, excluding any addresses in `exclude`
 * (the platform wallet + the admin exclusion list — see lib/exclusions.ts).
 * The filter is applied BEFORE the drand-seeded shuffle, so an excluded wallet
 * never gets an index and the beacon cannot select it.
 * Also returns the `capturedAt` of the batch
 * used, so the caller can record it on the round for end-to-end provably-fair
 * verification (anyone can later re-derive the eligible pool from that batch).
 */
export async function getEligibleHolders(
  minTokenEligible: bigint,
  exclude: string[] = []
): Promise<{ eligible: EligibleHolder[]; capturedAt: Date | null }> {
  const latest = await prisma.holderSnapshot.findFirst({
    where: { chain: CHAIN_KIND },
    orderBy: { capturedAt: "desc" },
    select: { capturedAt: true },
  });
  if (!latest) return { eligible: [], capturedAt: null };

  const snaps = await prisma.holderSnapshot.findMany({
    where: { capturedAt: latest.capturedAt, chain: CHAIN_KIND },
    select: { holderAddress: true, amount: true },
  });

  const map = new Map<string, bigint>();
  for (const s of snaps) {
    map.set(s.holderAddress, (map.get(s.holderAddress) ?? 0n) + toBigInt(s.amount));
  }

  const excludeSet = new Set(exclude);
  const eligible: EligibleHolder[] = [];
  for (const [address, amount] of map) {
    if (excludeSet.has(address)) continue;
    if (amount >= minTokenEligible) eligible.push({ address, amount });
  }
  return { eligible, capturedAt: latest.capturedAt };
}

/**
 * Deterministically selects winners from the eligible pool using the drand
 * random value. A Fisher–Yates shuffle (seeded by the hex random value) is run
 * over the eligible list sorted by address, so the result is fully reproducible:
 * anyone with (valueHex, eligible list) can re-derive the exact same winners.
 */
export function selectWinners(
  randomValueHex: string,
  eligible: EligibleHolder[],
  winnerCount: number,
  payoutDistribution: number[]
): WinnerPick[] {
  const sorted = [...eligible].sort((a, b) =>
    a.address.localeCompare(b.address)
  );
  const n = sorted.length;
  if (n === 0) return [];
  const count = Math.min(winnerCount, n);

  const order = sorted.map((_, i) => i);
  const rng = makeRng(randomValueHex);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Number(rng() % BigInt(i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const winners: WinnerPick[] = [];
  for (let r = 0; r < count; r++) {
    winners.push({
      rank: r + 1,
      address: sorted[order[r]].address,
      share: payoutDistribution[r] ?? 0,
    });
  }
  return winners;
}

/**
 * Prize pool = confirmed native balance of the platform wallet minus a reserve.
 * Reserve is env-configurable via PRIZE_RESERVE_LAMPORTS (see lib/config).
 *
 * Reads the balance through the chain adapter on purpose: this number decides
 * how much money leaves the wallet, so it must never be possible for a
 * chain switch to quietly keep reading Solana balances. With no adapter
 * registered for the selected chain, this throws instead.
 */
export async function computePrizePool(
  prizeReserveLamports?: bigint
): Promise<bigint> {
  const platformAddress = getChain().platformAddress();
  const balance = await getChain().getNativeBalance(platformAddress);
  const reserve = prizeReserveLamports ?? getConfig().prizeReserveLamports;
  const pool = balance - reserve;
  return pool > 0n ? pool : 0n;
}

/**
 * Splits the prize pool across winners by their shares; remainder goes to rank 1.
 *
 * A platform revenue cut (`platformFeeBps` basis points, 0–10000) is deducted
 * from the pool FIRST: `fee = pool * bps / 10000`, then `distributable = pool −
 * fee` is split across winners by their shares. The fee is never transferred —
 * it stays on the platform wallet (the funder) because winners are paid out of
 * `distributable`, not `pool`. Returns the winner amounts AND the fee taken so
 * the round can record it.
 */
export function computeWinnerAmounts(
  pool: bigint,
  winners: WinnerPick[],
  platformFeeBps = 0
): {
  amounts: { rank: number; address: string; amountLamports: bigint }[];
  platformFeeLamports: bigint;
} {
  const clampedBps = BigInt(Math.max(0, Math.min(10000, platformFeeBps)));
  const platformFeeLamports = (pool * clampedBps) / 10000n;
  const distributable = pool - platformFeeLamports;
  const SCALE = 1_000_000_000n;
  const amounts = winners.map((w) => {
    const shareBps = BigInt(Math.round(w.share * 1e9));
    const amountLamports = (distributable * shareBps) / SCALE;
    return { rank: w.rank, address: w.address, amountLamports };
  });
  const total = amounts.reduce((a, w) => a + w.amountLamports, 0n);
  const remainder = distributable - total;
  if (amounts.length > 0) amounts[0].amountLamports += remainder;
  return { amounts, platformFeeLamports };
}

/**
 * Builds an optional fee-sweep transfer (platform fee → treasury wallet) to be
 * included in the same atomic transaction as winner payouts. Returns undefined
 * when there is no fee, no treasury is configured, or the treasury IS the
 * platform wallet (a self-transfer would be a pointless no-op).
 */
function buildFeeTransfer(
  feeLamports: bigint
): { lamports: bigint; destination: PublicKey } | undefined {
  if (feeLamports <= 0n) return undefined;
  const treasury = getTreasuryPubkey();
  if (!treasury) return undefined;
  if (treasury.equals(getPlatformKeypair().publicKey)) return undefined;
  return { lamports: feeLamports, destination: treasury };
}

/**
 * How many times a payout tx is re-signed + re-broadcast with a FRESH blockhash
 * when the previous attempt expired (block height exceeded). Two total attempts
 * covers the common "tx never reached a leader" case without turning a genuine
 * failure into a long hang.
 */
const PAYOUT_SEND_ATTEMPTS = 2;

/** Re-broadcast cadence for the SAME signed payout tx while waiting for it to
 *  land. Resending identical bytes reuses the signature, so a duplicate can
 *  never be paid twice — a duplicate simply cannot exist. */
const PAYOUT_REBROADCAST_MS = 1_500;

/** How often the payout signature status is polled while waiting. */
const PAYOUT_STATUS_POLL_MS = 500;

/**
 * Waits for `sig` to be included in a block, re-broadcasting the identical
 * signed bytes every `PAYOUT_REBROADCAST_MS` until it lands or its blockhash
 * window closes.
 *
 * A single `sendTransaction` call is not a delivery guarantee: the RPC can
 * accept the bytes (returning a signature) and still fail to get the tx to the
 * leader that owns the next slot — especially with no priority fee. The tx then
 * sits unlanded until its blockhash expires, which on mainnet shows up as a
 * ~30s wait followed by "block height exceeded" (observed on rounds #33-#37).
 * Periodic re-sends give every subsequent leader another chance inside the SAME
 * validity window, so a payout normally lands in one or two slots instead of
 * burning the whole window.
 *
 * Returns true as soon as a status exists for the signature (the caller then
 * settles the tx via getTransaction), false when the blockhash window closed
 * with the signature still absent.
 */
async function broadcastUntilLanded(
  connection: Connection,
  rawTx: Uint8Array,
  sig: string,
  lastValidBlockHeight: number
): Promise<boolean> {
  const startedAt = Date.now();
  let resends = 0;
  let nextHeightCheck = 0;

  for (;;) {
    await new Promise((r) => setTimeout(r, PAYOUT_STATUS_POLL_MS));

    const statuses = await connection.getSignatureStatuses([sig]);
    if (statuses.value[0]) return true;

    const now = Date.now();
    if (now >= nextHeightCheck) {
      nextHeightCheck = now + 1_000;
      const height = await connection.getBlockHeight("confirmed");
      if (height > lastValidBlockHeight) {
        logEvent(
          "warn",
          "draw",
          `payout tx ${sig.slice(0, 12)}… was not included within its blockhash window (${(
            (now - startedAt) / 1000
          ).toFixed(1)}s, ${resends} re-broadcast${resends === 1 ? "" : "s"})`
        );
        return false;
      }
    }

    if (now - startedAt >= (resends + 1) * PAYOUT_REBROADCAST_MS) {
      resends++;
      try {
        await connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 });
      } catch (e) {
        // A re-broadcast can legitimately fail (e.g. the tx just landed and the
        // RPC reports a duplicate) — the status poll above is authoritative.
        logEvent(
          "warn",
          "draw",
          `payout re-broadcast ${resends} for ${sig.slice(0, 12)}… failed: ${(e as Error).message.slice(0, 120)}`
        );
      }
    }
  }
}

/**
 * Fetches the full landed transaction for `sig`, tolerating RPC indexing lag
 * (status/`getTransaction` can trail the confirmation by a beat). Returns null
 * when the RPC has no record of the signature at all.
 */
async function fetchLandedTx(connection: Connection, sig: string) {
  let txResult = await connection.getTransaction(sig, {
    maxSupportedTransactionVersion: 0,
  });
  for (let attempt = 0; attempt < 3 && !txResult; attempt++) {
    await new Promise((r) => setTimeout(r, 400));
    txResult = await connection.getTransaction(sig, {
      maxSupportedTransactionVersion: 0,
    });
  }
  return txResult;
}

/** Network fee actually paid = payer balance delta − everything it transferred
 *  (winners + swept platform fee). Authoritative, and includes any priority fee. */
function networkFeePaid(
  balanceBefore: number,
  balanceAfter: number,
  transferred: bigint
): bigint {
  const diff = BigInt(balanceBefore) - BigInt(balanceAfter) - transferred;
  return diff > 0n ? diff : 0n;
}

/**
 * Fails fast (before broadcasting) when a prize is too small to fund a winner
 * wallet that doesn't exist yet — a SOL transfer that CREATES an account with
 * less than the rent-exempt minimum fails on-chain with
 * `InsufficientFundsForRent` (the classic tiny-prize failure). Nothing is sent,
 * so the round costs no network fee and the error says exactly what to fix.
 *
 * The threshold is read from the RPC (`getMinimumBalanceForRentExemption(0)`),
 * not hardcoded — it is 0.00065024 SOL on mainnet today, not the often-quoted
 * 0.00089088. Wallet existence is one batched read; if either RPC read fails we
 * do NOT block the payout (the on-chain failure path still catches a real
 * problem).
 */
async function assertPrizesCanCreateWallets(
  connection: Connection,
  winners: { address: string; amountLamports: bigint }[]
): Promise<void> {
  let risky: { address: string; amountLamports: bigint }[] = [];
  let rentExempt = 0n;
  let infos: Awaited<ReturnType<Connection["getMultipleAccountsInfo"]>> | null =
    null;
  try {
    rentExempt = BigInt(await connection.getMinimumBalanceForRentExemption(0));
    risky = winners.filter((w) => w.amountLamports < rentExempt);
    if (risky.length > 0) {
      infos = await connection.getMultipleAccountsInfo(
        risky.map((w) => new PublicKey(w.address)),
        "confirmed"
      );
    }
  } catch {
    return; // RPC hiccup — let the real send decide
  }
  if (!infos) return;
  const missing = risky.filter((_, i) => !infos?.[i]);
  if (missing.length === 0) return;
  const detail = missing
    .map(
      (w) =>
        `${lamportsToSol(w.amountLamports).toFixed(6)} SOL → ${w.address.slice(0, 4)}…${w.address.slice(-4)}`
    )
    .join(", ");
  throw new Error(
    `payout would fail on-chain: ${detail} is below the ${lamportsToSol(rentExempt).toFixed(6)} SOL rent-exempt minimum needed to create a brand-new wallet — nothing was sent. Raise the prize pool or set a higher MIN_PRIZE_SOL.`
  );
}

/**
 * Sends SOL to every winner in a single atomic transaction (all-or-nothing).
 * When `feeTransfer` is supplied, the platform fee is swept to the treasury
 * wallet as the first instruction of the SAME tx — so the fee leaves the
 * platform wallet iff every winner is paid (no partial state). Returns the
 * transaction signature AND the exact on-chain network fee the platform wallet
 * paid for it. The network fee is derived from the payer's balance delta across
 * the send (fee = balanceBefore − balanceAfter − totalTransferred, where
 * totalTransferred includes the swept fee), which is authoritative and avoids
 * version-specific getFeeForMessage return shapes.
 *
 * A tx whose blockhash expires without ever landing ("Signature … has expired:
 * block height exceeded") is NOT a funds problem — the SOL never left the
 * wallet. Such an attempt is retried once with a fresh blockhash, but only
 * after proving the signature is absent on-chain: `confirmTransaction` can
 * report expiry for a tx that actually landed while the RPC's status index
 * lagged, and blindly retrying that would pay the winners twice.
 *
 * THROWS if the tx lands but FAILS on-chain (meta.err ≠ null, e.g. "Insufficient
 * Funds For Rent" when sweeping a fee to an unfunded treasury), and after every
 * send attempt expires. Callers must catch this so winners stay "pending" —
 * never marked "sent" for a failed tx.
 */
async function distributePayouts(
  winners: { address: string; amountLamports: bigint }[],
  feeTransfer?: { lamports: bigint; destination: PublicKey }
): Promise<{ signature: string; feeLamports: bigint }> {
  const connection = getConnection();
  const payer = getPlatformKeypair();
  const winnerIxs = winners.map((w) =>
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: new PublicKey(w.address),
      lamports: Number(w.amountLamports),
    })
  );
  const ixs =
    feeTransfer && feeTransfer.lamports > 0n
      ? [
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: feeTransfer.destination,
            lamports: Number(feeTransfer.lamports),
          }),
          ...winnerIxs,
        ]
      : winnerIxs;
  const transferred =
    (feeTransfer && feeTransfer.lamports > 0n ? feeTransfer.lamports : 0n) +
    winners.reduce((a, w) => a + w.amountLamports, 0n);

  // A prize below the rent-exempt minimum cannot create a recipient wallet, and
  // the atomic tx would fail as a whole — check once, before spending any fee.
  await assertPrizesCanCreateWallets(connection, winners);

  for (let attempt = 1; attempt <= PAYOUT_SEND_ATTEMPTS; attempt++) {
    // Read the payer balance BEFORE fetching the blockhash: a blockhash is only
    // valid for ~150 blocks, so no RPC round-trip may sit between fetching it
    // and broadcasting the signed tx.
    const balanceBefore = await connection.getBalance(payer.publicKey, "confirmed");
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({
      feePayer: payer.publicKey,
      blockhash,
      lastValidBlockHeight,
    }).add(...ixs);
    tx.sign(payer);
    const rawTx = tx.serialize();

    /** Settles a tx the RPC reports as landed: verifies meta.err (a tx can land
     *  and FAIL) and derives the network fee from the payer balance delta. */
    const settle = async (signature: string) => {
      const result = await fetchLandedTx(connection, signature);
      if (!result) {
        throw new Error(
          `payout tx ${signature.slice(0, 12)}… landed but its details are not retrievable from the RPC — check it on an explorer before retrying`
        );
      }
      if (result.meta?.err) {
        throw new Error(
          `payout tx ${signature.slice(0, 12)}… failed on-chain: ${JSON.stringify(result.meta.err)}`
        );
      }
      const balanceAfter = await connection.getBalance(payer.publicKey, "confirmed");
      return {
        signature,
        feeLamports: networkFeePaid(balanceBefore, balanceAfter, transferred),
      };
    };

    const sentAt = Date.now();
    const sig = await connection.sendRawTransaction(rawTx, {
      skipPreflight: true,
      maxRetries: 5,
    });
    const sendMs = Date.now() - sentAt;
    if (sendMs > 1_000) {
      // A slow broadcast eats the blockhash window from the wrong end: the tx
      // reaches the leader already closer to expiry.
      logEvent(
        "warn",
        "draw",
        `payout broadcast for ${sig.slice(0, 12)}… took ${sendMs}ms (blockhash window started at fetch)`
      );
    }

    // Wait for inclusion while re-broadcasting the identical bytes (same
    // signature, so re-sends can never double-pay).
    const landedInWindow = await broadcastUntilLanded(
      connection,
      rawTx,
      sig,
      lastValidBlockHeight
    );
    if (landedInWindow) {
      const settled = await settle(sig);
      logEvent(
        "info",
        "draw",
        `payout tx ${sig.slice(0, 12)}… landed after ${((Date.now() - sentAt) / 1000).toFixed(1)}s (attempt ${attempt}/${PAYOUT_SEND_ATTEMPTS})`
      );
      return settled;
    }

    // Expired ≠ absent: check whether it landed anyway before doing anything
    // else. A landed tx (even a failed one) must be settled, never retried.
    const landed = await fetchLandedTx(connection, sig);
    if (landed) return settle(sig);

    // Some RPCs answer getTransaction with null but still know the signature.
    // Then we cannot tell whether it paid — never retry (double-pay hazard).
    const status = await connection.getSignatureStatuses([sig], {
      searchTransactionHistory: true,
    });
    if (status.value[0]) {
      throw new Error(
        `payout tx ${sig} landed but its details are not retrievable from the RPC — check it on an explorer before retrying`
      );
    }

    if (attempt < PAYOUT_SEND_ATTEMPTS) {
      logEvent(
        "warn",
        "draw",
        `payout tx ${sig.slice(0, 12)}… expired before confirmation (block height exceeded) — retrying with a fresh blockhash`
      );
      continue;
    }
    throw new Error(
      `payout tx ${sig.slice(0, 12)}… expired before it confirmed (block height exceeded) — nothing was sent on-chain after ${PAYOUT_SEND_ATTEMPTS} attempts`
    );
  }

  // Unreachable: the loop either returns or throws on its last iteration.
  throw new Error("payout: no send attempt was made");
}

/**
 * Postgres advisory-lock key that serialises round-number allocation across
 * EVERY process sharing the database (cron, admin trigger, CLI).
 * pg_advisory_xact_lock is released automatically when the transaction ends.
 */
const ROUND_ALLOC_LOCK_KEY = 4_711_001;

/**
 * A round left in "drawing" for longer than this is treated as abandoned (the
 * process died mid-draw) and recovered as "failed" before a new round is
 * allocated — otherwise the "already drawing" guard would block every future
 * draw forever.
 */
const STALE_DRAWING_MS = 30 * 60 * 1000;

/**
 * Minimum spacing between two round starts. A duplicate trigger from the same
 * cron tick can land AFTER the first round already finished (a skipped round
 * takes ~1.5s), so the "still drawing" guard alone would let it create a second
 * round seconds later. 30s is far longer than the duplicate window (~2s) and far
 * shorter than any sensible draw schedule.
 */
const MIN_ROUND_SPACING_MS = 30_000;

type RoundSlot =
  | { kind: "created"; round: { id: bigint }; roundNumber: number }
  | {
      kind: "busy";
      roundId: bigint;
      roundNumber: number;
      reason: "in-progress" | "cooldown";
    };

/**
 * Atomically claims the next round number and creates its "drawing" row.
 *
 * Why a transaction + advisory lock: the old read-max-then-create sequence was
 * a race. Two schedulers (e.g. an orphaned `next start` still running next to a
 * fresh one, or a cron tick overlapping a manual "Run draw") both read the same
 * max and inserted the same number: the loser died with Prisma P2002 "Unique
 * constraint failed on (roundNumber)", and when their reads landed a second
 * apart the loser instead created a SECOND round in the same minute — a
 * double-payout hazard as soon as the prize pool is non-zero.
 *
 * With the lock held, read + insert are one critical section and the existence
 * of an unfinished round turns every other concurrent caller into a no-op.
 */
async function claimRoundSlot(
  minTokenEligible: bigint
): Promise<RoundSlot> {
  return prisma.$transaction(async (tx): Promise<RoundSlot> => {
    // pg_advisory_xact_lock returns `void`, which Prisma's $queryRaw refuses to
    // deserialize — $executeRaw only looks at the command tag.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ROUND_ALLOC_LOCK_KEY})`;

    // Recover abandoned "drawing" rounds (process killed mid-draw).
    await tx.lotteryRound.updateMany({
      where: {
        status: "drawing",
        startedAt: { lt: new Date(Date.now() - STALE_DRAWING_MS) },
      },
      data: {
        status: "failed",
        error: "Round abandoned — process stopped mid-draw (auto-recovered)",
        completedAt: new Date(),
      },
    });

    const active = await tx.lotteryRound.findFirst({
      where: { status: "drawing" },
      orderBy: { roundNumber: "desc" },
      select: { id: true, roundNumber: true },
    });
    if (active) {
      return {
        kind: "busy",
        roundId: active.id,
        roundNumber: active.roundNumber,
        reason: "in-progress",
      };
    }

    // Same-tick duplicate that arrived after the previous round already
    // finished — still one round per trigger, not two seconds apart.
    const recent = await tx.lotteryRound.findFirst({
      where: { startedAt: { gte: new Date(Date.now() - MIN_ROUND_SPACING_MS) } },
      orderBy: { roundNumber: "desc" },
      select: { id: true, roundNumber: true },
    });
    if (recent) {
      return {
        kind: "busy",
        roundId: recent.id,
        roundNumber: recent.roundNumber,
        reason: "cooldown",
      };
    }

    const last = await tx.lotteryRound.findFirst({
      orderBy: { roundNumber: "desc" },
      select: { roundNumber: true },
    });
    const roundNumber = (last?.roundNumber ?? 0) + 1;
    const created = await tx.lotteryRound.create({
      data: {
        roundNumber,
        status: "drawing",
        minTokenEligible: toDecimalValue(minTokenEligible),
      },
      select: { id: true },
    });
    return { kind: "created", round: created, roundNumber };
  });
}

/**
 * Runs a full lottery round:
 *   0. claim the next round number atomically (advisory lock) and create the
 *      "drawing" row — a concurrent caller becomes a no-op, never a second round
 *   1. read eligible holders from the latest snapshot (excl. platform wallet)
 *   2. compute the SOL prize pool from the platform wallet balance
 *   3. request verifiable drand randomness (public beacon)
 *   4. deterministically select + size winners
 *   5. persist winners, distribute SOL atomically, finalize the round
 *
 * Any failure marks the round "failed" with the error message.
 */
export async function runLotteryRound(
  opts: { debug?: boolean } = {}
): Promise<LotteryRoundResult> {
  const cfg = await getEffectiveConfig();
  const log = opts.debug
    ? (...a: unknown[]) => console.log("[lottery]", ...a)
    : undefined;

  // Chain safety gate — runs BEFORE the round slot is claimed, so nothing is
  // written to the DB. A chain whose payout step is not implemented must never
  // produce a draw: the round would look real while no money can move, and the
  // Solana payout path would fire on the wrong network.
  const chain = getChain();
  if (!chain.payoutsImplemented) {
    const msg = `Draws are disabled on ${CHAIN_LABEL}: the payout step is not implemented for this chain yet (see MIGRATION-ROBINHOOD.md). No round was created.`;
    log?.(msg);
    logEvent("warn", "draw", msg);
    return {
      roundId: "0",
      roundNumber: 0,
      status: "skipped",
      winners: [],
      prizePoolLamports: "0",
      eligibleCount: 0,
      randomnessValue: null,
      randomnessSignature: null,
      randomnessRound: null,
      randomnessVerified: false,
      error: msg,
    };
  }

  // Atomic claim: exactly one caller (across every process/instance) gets the
  // slot. A concurrent scheduler / manual trigger becomes a no-op here instead
  // of racing the unique constraint and potentially creating a second round.
  const slot = await claimRoundSlot(cfg.minTokenEligible);
  if (slot.kind === "busy") {
    const spacingSec = MIN_ROUND_SPACING_MS / 1000;
    const msg =
      slot.reason === "in-progress"
        ? `Round #${slot.roundNumber} is still in progress — this trigger was ignored (no new round created)`
        : `Round #${slot.roundNumber} started less than ${spacingSec}s ago — duplicate trigger ignored (minimum ${spacingSec}s between rounds)`;
    log?.(
      "round",
      slot.roundNumber,
      slot.reason === "in-progress"
        ? "still in progress — trigger ignored"
        : `started <${spacingSec}s ago — duplicate trigger ignored`
    );
    logEvent("warn", "draw", msg);
    return {
      roundId: slot.roundId.toString(),
      roundNumber: slot.roundNumber,
      status: "skipped",
      winners: [],
      prizePoolLamports: "0",
      eligibleCount: 0,
      randomnessValue: null,
      randomnessSignature: null,
      randomnessRound: null,
      randomnessVerified: false,
      error: msg,
    };
  }

  const round = slot.round;
  const roundNumber = slot.roundNumber;
  log?.("round", roundNumber, "created (drawing)");
  logEvent("info", "draw", `round #${roundNumber} started (drawing)`);

  const fail = async (msg: string): Promise<LotteryRoundResult> => {
    log?.("round failed:", msg);
    logEvent("error", "draw", `round #${roundNumber} failed: ${msg}`);
    await prisma.lotteryRound.update({
      where: { id: round.id },
      data: { status: "failed", error: msg, completedAt: new Date() },
    });
    return {
      roundId: round.id.toString(),
      roundNumber,
      status: "failed",
      winners: [],
      prizePoolLamports: "0",
      eligibleCount: 0,
      randomnessValue: null,
      randomnessSignature: null,
      randomnessRound: null,
      randomnessVerified: false,
      error: msg,
    };
  };

  try {
    const platformAddr = getChain().platformAddress();
    // Exclusion list applied BEFORE the shuffle: platform wallet (prizes are
    // paid out of it), the token's venue accounts (pump.fun bonding curve /
    // PumpSwap pool authority, derived from TOKEN_MINT) and the admin blacklist.
    // Snapshot the exact list on the round so the eligible pool stays
    // reproducible after the blacklist is edited later.
    const excludedAddresses = await getDrawExclusions(platformAddr);
    const { eligible, capturedAt: eligibleSnapshotCapturedAt } =
      await getEligibleHolders(cfg.minTokenEligible, excludedAddresses);
    log?.("eligible holders:", eligible.length);
    logEvent("info", "draw", `round #${roundNumber}: ${eligible.length} eligible holders`);

    // No eligible holder = nothing to draw. Record the round as SKIPPED (not
    // "completed") with a human-readable reason, so the rounds history explains
    // why nothing happened instead of showing a completed round with 0 winners.
    // No drand beacon is requested and no payout is attempted.
    const noEligibleReason =
      "No eligible holders in the latest snapshot - round skipped";
    if (eligible.length === 0) {
      await prisma.lotteryRound.update({
        where: { id: round.id },
        data: {
          status: "skipped",
          eligibleCount: 0,
          eligibleSnapshotCapturedAt,
          excludedAddresses,
          error: noEligibleReason,
          completedAt: new Date(),
        },
      });
      logEvent(
        "warn",
        "draw",
        `round #${roundNumber} skipped - 0 eligible holders`
      );
      return {
        roundId: round.id.toString(),
        roundNumber,
        status: "skipped",
        winners: [],
        prizePoolLamports: "0",
        eligibleCount: 0,
        randomnessValue: null,
        randomnessSignature: null,
        randomnessRound: null,
        randomnessVerified: false,
        error: noEligibleReason,
      };
    }

    // Fewer eligible wallets than configured winners is NOT an error: winners
    // are capped at the eligible count (selectWinners: min(winnerCount, n)) and
    // computeWinnerAmounts rolls every unassigned share into rank 1, so 100% of
    // the distributable pool is still paid out (e.g. 2 eligible with a
    // 50/30/20 split -> rank 1 gets 70%, rank 2 gets 30%). Only log it so the
    // round history explains the smaller winner list.
    if (eligible.length < cfg.winnerCount) {
      logEvent(
        "warn",
        "draw",
        `round #${roundNumber}: only ${eligible.length} eligible holder(s) for ${cfg.winnerCount} winner slots - paying ${eligible.length} winner(s), unassigned shares roll into rank 1`
      );
    }

    const pool = await computePrizePool(cfg.prizeReserveLamports);
    log?.("prize pool lamports:", pool.toString());

    // Max prize cap: when set (>0) and the available pool exceeds it, only the
    // capped amount is paid out this round; the remainder stays on the platform
    // wallet for future rounds.
    const effectivePool =
      cfg.maxPrizeLamports > 0n && pool > cfg.maxPrizeLamports
        ? cfg.maxPrizeLamports
        : pool;
    log?.(
      "effective prize lamports:",
      effectivePool.toString(),
      cfg.maxPrizeLamports > 0n
        ? `(cap ${cfg.maxPrizeLamports.toString()})`
        : "(no cap)"
    );

    // Skip the round when there is no prize pool (platform wallet balance at
    // or below the reserve — effectively zero income) OR when the effective
    // prize is below the configured minimum threshold. No drand request, no
    // winner selection, no payout. Recording the round as "skipped" means the
    // zero-balance case no longer strands winners in "pending" limbo.
    const belowMin =
      cfg.minPrizeLamports > 0n && effectivePool < cfg.minPrizeLamports;
    if (effectivePool === 0n || belowMin) {
      let reason: string;
      if (effectivePool === 0n) {
        reason = `Prize pool 0 ${NATIVE_SYMBOL} (balance at/below reserve) — round skipped`;
      } else {
        const effectiveSol = lamportsToSol(effectivePool).toFixed(4);
        const minSol = lamportsToSol(cfg.minPrizeLamports).toFixed(4);
        reason = `Prize pool ${effectiveSol} ${NATIVE_SYMBOL} below minimum ${minSol} ${NATIVE_SYMBOL} — round skipped`;
      }
      log?.("round skipped:", reason);
      logEvent(
        "info",
        "draw",
        `round #${roundNumber} skipped — ${effectivePool === 0n ? "no prize pool (balance at/below reserve)" : "prize pool below minimum threshold"}`
      );
      await prisma.lotteryRound.update({
        where: { id: round.id },
        data: {
          status: "skipped",
          prizePoolLamports: toDecimalValue(effectivePool),
          eligibleCount: eligible.length,
          eligibleSnapshotCapturedAt,
          excludedAddresses,
          error: reason,
          completedAt: new Date(),
        },
      });
      return {
        roundId: round.id.toString(),
        roundNumber,
        status: "skipped",
        winners: [],
        prizePoolLamports: effectivePool.toString(),
        eligibleCount: eligible.length,
        randomnessValue: null,
        randomnessSignature: null,
        randomnessRound: null,
        randomnessVerified: false,
        error: reason,
      };
    }

    const rnd = await requestRandomness({ debug: opts.debug });
    log?.("randomness:", rnd.valueHex);
    logEvent(
      "info",
      "draw",
      `round #${roundNumber}: drand round ${rnd.round} fetched (${rnd.verified ? "cross-relay verified" : "single relay"})`
    );

    const picks = selectWinners(
      rnd.valueHex,
      eligible,
      cfg.winnerCount,
      cfg.payoutDistribution
    );
    const { amounts, platformFeeLamports } = computeWinnerAmounts(
      effectivePool,
      picks,
      cfg.platformFeeBps
    );

    await prisma.winner.createMany({
      data: amounts.map((a) => ({
        roundId: round.id,
        rank: a.rank,
        address: a.address,
        amountLamports: toDecimalValue(a.amountLamports),
        status: "pending",
      })),
    });

    let payoutTx: string | null = null;
    let payoutFeeLamports: bigint | null = null;
    if (effectivePool > 0n && amounts.length > 0) {
      const chain = getChain();
      /** EVM only: one tx per winner, in `amounts` order (fee sweep excluded). */
      let winnerTxHashes: string[] | null = null;
      if (chain.sendPayouts) {
        // Chain-native payout (EVM): one transfer per winner, sequential and
        // awaited. When a fee treasury is configured the fee is swept as the
        // FIRST transfer, so a failure aborts before any prize moves (this path
        // is not atomic, unlike the Solana branch below).
        const treasury = chain.treasuryAddress?.() ?? null;
        const sweepFee = treasury !== null && platformFeeLamports > 0n;
        const payout = await chain.sendPayouts(
          amounts,
          sweepFee
            ? { amountBaseUnits: platformFeeLamports, destination: treasury }
            : undefined
        );
        payoutTx = payout.primaryTxHash;
        payoutFeeLamports = payout.feeBaseUnits;
        winnerTxHashes = payout.txHashes;
        logEvent(
          "info",
          "draw",
          `round #${roundNumber}: paid ${amounts.length} winner(s) in ${payout.txHashes.length} tx(s)${
            sweepFee ? ` + fee sweep to ${treasury.slice(0, 10)}…` : " (fee stays on the platform wallet)"
          } — ${payout.txHashes.join(", ")}`
        );
      } else {
        // Solana: winners + optional fee sweep ride in ONE atomic tx, so the fee
        // leaves the platform wallet instead of being recycled into the next pool.
        const feeTransfer = buildFeeTransfer(platformFeeLamports);
        const payout = await distributePayouts(amounts, feeTransfer);
        payoutTx = payout.signature;
        payoutFeeLamports = payout.feeLamports;
      }
      if (winnerTxHashes && winnerTxHashes.length === amounts.length) {
        // EVM: every winner has its OWN transaction, so each row stores its own
        // hash (the round keeps the first one). Writing the round's single hash to
        // all rows — the Solana shape — made three winners share one tx hash.
        await Promise.all(
          amounts.map((a, i) =>
            prisma.winner.updateMany({
              where: { roundId: round.id, address: a.address },
              data: { payoutTx: winnerTxHashes[i], status: "sent" },
            })
          )
        );
      } else {
        // Solana: one atomic tx paid everyone, so one hash for all rows.
        await prisma.winner.updateMany({
          where: { roundId: round.id },
          data: { payoutTx, status: "sent" },
        });
      }
    }

    await prisma.lotteryRound.update({
      where: { id: round.id },
      data: {
        status: "completed",
        prizePoolLamports: toDecimalValue(effectivePool),
        eligibleCount: eligible.length,
        eligibleSnapshotCapturedAt,
        excludedAddresses,
        randomnessValue: rnd.valueHex,
        randomnessSignature: rnd.signature,
        randomnessRound: rnd.round,
        randomnessVerified: rnd.verified,
        payoutTx,
        payoutFeeLamports:
          payoutFeeLamports === null ? null : toDecimalValue(payoutFeeLamports),
        platformFeeLamports: toDecimalValue(platformFeeLamports),
        completedAt: new Date(),
      },
    });
    log?.("round", roundNumber, "completed");
    logEvent(
      "success",
      "draw",
      `round #${roundNumber} completed — ${amounts.length} winners, pool ${lamportsToSol(effectivePool).toFixed(4)} ${NATIVE_SYMBOL}` +
        (payoutTx ? `, tx ${payoutTx.slice(0, 12)}…` : "")
    );

    // #9 — fire winner notifications (email/Telegram) for subscribers whose
    // address won this round. Best-effort: the round is already persisted as
    // completed above, so a notify failure must never break the draw.
    try {
      await notifyWinners(roundNumber, amounts);
    } catch (notifyErr) {
      logEvent(
        "error",
        "notify",
        `round #${roundNumber}: notify failed — ${(notifyErr as Error).message}`
      );
    }

    // Group bot — one announcement to the configured Telegram group. Same
    // best-effort contract as the winner notifications above: the round is
    // already persisted as completed, so a bot failure must never break the
    // draw. `notifyDrawResult` no-ops unless the bot is enabled with draw
    // announcements on, and de-dupes by round number.
    try {
      await notifyDrawResult({
        roundNumber,
        prizePoolLamports: effectivePool,
        eligibleCount: eligible.length,
        winners: amounts,
        payoutTx,
        randomnessVerified: rnd.verified,
      });
    } catch (botErr) {
      logEvent(
        "error",
        "telegram",
        `round #${roundNumber}: group announcement failed — ${(botErr as Error).message}`
      );
    }

    return {
      roundId: round.id.toString(),
      roundNumber,
      status: "completed",
      winners: amounts.map((a) => ({
        rank: a.rank,
        address: a.address,
        amountLamports: a.amountLamports.toString(),
        payoutTx,
      })),
      prizePoolLamports: effectivePool.toString(),
      eligibleCount: eligible.length,
      randomnessValue: rnd.valueHex,
      randomnessSignature: rnd.signature,
      randomnessRound: rnd.round,
      randomnessVerified: rnd.verified,
    };
  } catch (e) {
    // The Solana path is a single atomic tx, so a throw means nothing moved. The
    // EVM path is NOT: `sendPayouts` attaches whatever already landed, so those
    // winners are recorded as paid (with their tx hash) instead of being deleted —
    // otherwise the chain would show money the database cannot explain. Owner hit
    // exactly that on 2026-10-29: fee + 2 winners on-chain, round "failed", zero
    // winner rows.
    const payoutError = e as PayoutError;
    const partial = payoutError.partialPayouts ?? [];
    let partialNote = "";
    if (partial.length > 0) {
      partialNote = ` · ${partial.length} transfer(s) already on-chain (${partial
        .map((p) => p.txHash.slice(0, 10))
        .join(", ")})`;
      try {
        for (const p of partial) {
          await prisma.winner.updateMany({
            where: { roundId: round.id, address: p.address, status: "pending" },
            data: { status: "sent", payoutTx: p.txHash },
          });
        }
        await prisma.lotteryRound.update({
          where: { id: round.id },
          data: {
            payoutTx: partial[partial.length - 1].txHash,
            payoutFeeLamports:
              payoutError.partialFeeBaseUnits === undefined
                ? null
                : toDecimalValue(payoutError.partialFeeBaseUnits),
          },
        });
      } catch {
        /* best-effort — the error text below still carries the hashes */
      }
    }
    // Only rows that never got paid are removed (they would be unpayable).
    try {
      await prisma.winner.deleteMany({
        where: { roundId: round.id, status: "pending" },
      });
    } catch {
      /* best-effort cleanup */
    }
    return fail((e as Error).message + partialNote);
  }
}
