/**
 * Browser-side reproduction of the server's winner-selection algorithm
 * (src/lib/lottery/engine.ts → makeRng + selectWinners), so anyone can
 * independently re-derive the winners from (randomness, eligible list) and
 * confirm they match what was stored — closing the "the beacon was valid but
 * the winners were hand-picked" gap.
 *
 * Uses the Web Crypto API (crypto.subtle) so it runs fully client-side with no
 * backend round-trip. The server uses node's synchronous createHash; this is
 * the async Web-Crypto equivalent with identical hashing semantics:
 *
 *   seed = SHA-256 of the UTF-8 bytes of the random-value hex STRING
 *          (node createHash("sha256").update(hexString) encodes the string as
 *          utf8 by default — TextEncoder().encode(hexString) matches that)
 *   step = SHA-256 of the previous 32-byte digest (raw bytes)
 *   draw = big-endian uint64 from the first 8 bytes of the digest
 *          (node Buffer.readBigUInt64BE(0) ↔ DataView.getBigUint64(0, false))
 *
 * The shuffle is a Fisher–Yates over the eligible list sorted by address
 * (localeCompare), seeded by that RNG — exactly as selectWinners does. Given
 * the same (randomnessHex, eligibleAddresses, winnerCount) it yields the exact
 * same winners, rank for rank.
 *
 * EXCLUSIONS: excluded wallets (the platform wallet + the admin blacklist —
 * bonding curve, LP pool authorities, program vaults) are already missing from
 * `eligibleAddresses`. They are filtered out BEFORE the shuffle, so the beacon
 * never gets a chance to pick them — they are not "skipped by randomness", they
 * never became candidates. The list actually used is snapshotted on the round
 * (LotteryRound.excludedAddresses) and /api/rounds/[n] rebuilds the pool from
 * that snapshot, so adding an address to the blacklist later does not change
 * the verification of an already-drawn round.
 */

async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  // data is always a fresh, full-buffer Uint8Array (byteOffset 0) at every call
  // site below, so data.buffer is exactly the bytes to hash. The cast mirrors the
  // workaround in src/app/verify/page.tsx for TS 5.7+'s Uint8Array<ArrayBufferLike>
  // vs BufferSource narrowing.
  const digest = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer);
  return new Uint8Array(digest);
}

/** Deterministic PRNG seeded by the drand random value (hex string). */
function makeRng(seedHex: string): () => Promise<bigint> {
  // Lazily-computed seed = SHA-256(utf8 bytes of seedHex). Each call then
  // chains SHA-256 over the previous digest — identical to the server's makeRng
  // (which seeds at construction time; the values produced are the same).
  let state: Uint8Array | null = null;
  return async () => {
    if (state === null) {
      state = await sha256Bytes(new TextEncoder().encode(seedHex));
    }
    state = await sha256Bytes(state);
    // state is always a fresh 32-byte Uint8Array (byteOffset 0), so reading the
    // big-endian uint64 from offset 0 is safe.
    return new DataView(state.buffer).getBigUint64(0, false);
  };
}

export type ReproducedWinner = { rank: number; address: string };

/**
 * Reproduces the winner selection for a round, given:
 *   - randomValueHex: the drand randomness stored on the round
 *   - eligibleAddresses: the eligible holder addresses AS USED by the draw
 *     (already filtered by minTokenEligible, platform-wallet-excluded, and
 *     sorted by address — /api/rounds/[n] returns exactly this list)
 *   - winnerCount: how many winners were selected (= stored winners length)
 *
 * Returns winners in rank order (rank 1 = first pick). Compare rank→address to
 * the stored winners to verify honest derivation.
 */
export async function reproduceWinners(
  randomValueHex: string,
  eligibleAddresses: string[],
  winnerCount: number
): Promise<ReproducedWinner[]> {
  const sorted = [...eligibleAddresses].sort((a, b) => a.localeCompare(b));
  const n = sorted.length;
  if (n === 0) return [];
  const count = Math.min(winnerCount, n);

  // Fisher–Yates shuffle of the index order, seeded by makeRng — identical to
  // the server's selectWinners.
  const order = sorted.map((_, i) => i);
  const rng = makeRng(randomValueHex);
  for (let i = order.length - 1; i > 0; i--) {
    const r = await rng();
    const j = Number(r % BigInt(i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const winners: ReproducedWinner[] = [];
  for (let r = 0; r < count; r++) {
    winners.push({ rank: r + 1, address: sorted[order[r]] });
  }
  return winners;
}
