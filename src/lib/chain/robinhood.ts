/** Server-only by contract (no `import "server-only"` — see `./index.ts`). */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { logEvent } from "@/lib/log-buffer";
import { NATIVE_DECIMALS, NATIVE_SYMBOL, explorerLink } from "./network";
import type { ChainAdapter, ChainHolder, ChainHolderSnapshot, PayoutError } from "./types";

/**
 * Raw env value with dotenv's INLINE-COMMENT rule applied: an unquoted value ends
 * at the first `#` preceded by whitespace. Next loads `.env` through dotenv, but
 * our own probes/scripts read the file directly, and `Number("0.05 # cap")` is
 * silently NaN — which would make a configured gas cap fall back to the default.
 */
function envRaw(name: string): string {
  const raw = process.env[name];
  if (!raw) return "";
  const cut = raw.replace(/\s+#.*$/, "");
  return cut.trim();
}

/** Positive integer from env, else the fallback. */
function envInt(name: string, fallback: number): number {
  const n = Number(envRaw(name));
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/** Positive number from env, else the fallback. */
function envNum(name: string, fallback: number): number {
  const n = Number(envRaw(name));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Robinhood Chain adapter (chain ID 4663) — read-only for now.
 *
 * Chain facts verified 2026-10-29 (see `MIGRATION-ROBINHOOD.md` §2c): an
 * Ethereum-compatible L2 built on Arbitrum Orbit, settling to Ethereum, gas
 * paid in **ETH** (18 decimals); node software `nitro/v3.12.1`; base fee ~0.02
 * gwei. Its 10x-per-second block time means a payout confirms in ~1 s.
 *
 * Deliberately SDK-free: `eth_getBalance` plus one REST list do not justify
 * pulling `viem`, which only becomes necessary in Phase 2b, when payouts have to
 * be SIGNED. Until then `payoutsImplemented: false` blocks the draw engine.
 *
 * Holders come from the **Blockscout API**, not `eth_getLogs`: Alchemy's free
 * tier caps log queries at a 10-block range (verified live), so log-based
 * enumeration is impossible there. Blockscout returns 50 holders per page,
 * ordered by balance descending, with a cursor — so the walk can stop at the
 * eligibility floor instead of paging through 100k holders.
 */
const RPC_URL = (process.env.CHAIN_RPC_URL ?? "").trim();
const API_BASE = (
  process.env.CHAIN_INDEXER_URL ?? "https://robinhoodchain.blockscout.com"
)
  .trim()
  .replace(/\/+$/, "");

/** Single JSON-RPC call. Throws on transport or JSON-RPC errors (never silent). */
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  if (!RPC_URL) {
    throw new Error("CHAIN_RPC_URL is not set (Robinhood Chain RPC endpoint)");
  }
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: HTTP ${res.status}`);
  const json = (await res.json()) as {
    result?: T;
    error?: { code?: number; message?: string };
  };
  if (json.error) {
    throw new Error(
      `RPC ${method} error ${json.error.code ?? ""}: ${json.error.message ?? "unknown"}`
    );
  }
  if (json.result === undefined) {
    throw new Error(`RPC ${method} returned no result`);
  }
  return json.result;
}

/**
 * GET a Blockscout endpoint as JSON.
 *
 * Sends a real `User-Agent`/`Accept` (a bare undici request is treated as a bot)
 * and retries once on 429 **or 403**: the public instance is shared and starts
 * refusing a burst of requests, which must not fail a whole holder sync. The
 * retry delay is deliberately generous; the caller runs every few minutes, not
 * every second.
 */
async function fetchJson<T>(url: string): Promise<T> {
  const headers = {
    accept: "application/json",
    "user-agent":
      "Mozilla/5.0 (compatible; drawfi-lottery/1.0; +https://robinhoodchain.blockscout.com)",
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { cache: "no-store", headers });
    if ((res.status === 429 || res.status === 403) && attempt === 0) {
      await new Promise((r) => setTimeout(r, 4000));
      continue;
    }
    if (!res.ok) {
      throw new Error(
        `indexer HTTP ${res.status} (${res.status === 403 || res.status === 429 ? "public instance throttling this host" : "request rejected"})`
      );
    }
    return (await res.json()) as T;
  }
  throw new Error("indexer rate limited");
}

interface TokenInfo {
  decimals?: string;
  holders_count?: string;
  total_supply?: string;
  symbol?: string;
}

interface HoldersPage {
  items?: {
    address?: {
      hash?: string;
      is_contract?: boolean;
      proxy_type?: string | null;
      name?: string | null;
      metadata?: { tags?: { name?: string; slug?: string }[] } | null;
    };
    value?: string;
  }[];
  next_page_params?: {
    value?: string;
    address_hash?: string;
    items_count?: number;
  } | null;
}

/** The subset of a Blockscout address object the venue classifier needs. */
export interface EvmHolderAddressInfo {
  hash?: string | null;
  is_contract?: boolean;
  proxy_type?: string | null;
  name?: string | null;
}

/**
 * Decide whether a holder is structurally a NON-player, and give the exclusion
 * row a label a human can audit.
 *
 * Why this rule (verified against the real NIGHT holder list, 2026-10-29):
 * - The **pons v2 bonding curve** holds ~80% of every fresh launch
 *   (`PonsV2BondingCurve`, `is_contract: true`). If it stayed eligible it would
 *   win the draw and the prize would land inside a curve nobody controls — the
 *   same failure the Solana build prevents by excluding the pump.fun curve PDA.
 * - **EIP-7702 delegated EOAs are real users.** Two NIGHT holders carry
 *   `proxy_type: "eip7702"` (SemiModularAccount7702 / MultiSig). Excluding every
 *   contract would silently disqualify them, so those stay eligible.
 * - The **burn address** (`0x…dEaD`) and the zero address can never claim.
 * Plain EOAs (including exchange hot wallets) are deliberately NOT excluded: the
 * Solana product does not exclude them either, and the admin list can add them.
 */
export function classifyEvmHolder(info: EvmHolderAddressInfo): {
  isVenue: boolean;
  label: string;
} {
  const hash = (info.hash ?? "").toLowerCase();
  if (!hash) return { isVenue: false, label: "unknown" };

  if (hash === ZERO_ADDRESS) return { isVenue: true, label: "zero address" };
  if (/dead$/i.test(hash)) return { isVenue: true, label: "burn address" };

  const isContract = info.is_contract === true;
  const isEip7702 = (info.proxy_type ?? "").toLowerCase() === "eip7702";
  if (isContract && !isEip7702) {
    return { isVenue: true, label: info.name?.trim() || "contract holder" };
  }
  return { isVenue: false, label: isEip7702 ? "EIP-7702 wallet" : "wallet" };
}

/**
 * EVM addresses are compared, stored and logged in **lowercase**: that keeps the
 * holder snapshot, the admin exclusion list and the engine's `Set` lookups
 * consistent, since an explorer returns mixed-case (EIP-55) forms. Checksummed
 * display returns with `viem` in Phase 2b.
 */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Minimal viem chain definition — `sendTransaction` needs an `id` and a native
 * currency; the RPC URL still comes from `CHAIN_RPC_URL` (one place for the key).
 */
const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: {
    name: "Ether",
    symbol: NATIVE_SYMBOL,
    decimals: NATIVE_DECIMALS,
  },
  rpcUrls: { default: { http: [RPC_URL || "http://127.0.0.1:8545"] } },
});

/** Gas for a plain native transfer is `PAYOUT_GAS_LIMIT` (see `.env`); the old
 *  hardcoded constants were replaced by that env knob on 2026-10-29. */

export const robinhoodAdapterBase: ChainAdapter = {
  kind: "robinhood",
  nativeSymbol: NATIVE_SYMBOL,
  nativeDecimals: NATIVE_DECIMALS,
  /**
   * Payouts implemented (Phase 2b, 2026-10-29): the platform wallet sends one
   * native-ETH transfer per winner. viem is used for SIGNING only; reads still go
   * through the hand-rolled JSON-RPC helpers above. The prize currency is native
   * ETH (owner decision: the wallet is funded manually), so creator fees claimed
   * as WETH must be unwrapped to ETH before a draw — that unwrap is Fase 4 work.
   */
  payoutsImplemented: true,
  explorer: explorerLink,

  /**
   * Platform wallet address — derived from PLATFORM_WALLET_PRIVATE_KEY with viem
   * (lowercase, matching how holders and the exclusion list are stored).
   */
  platformAddress(): string {
    const pk = (process.env.PLATFORM_WALLET_PRIVATE_KEY ?? "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      throw new Error(
        "PLATFORM_WALLET_PRIVATE_KEY is not a 32-byte 0x key (Robinhood Chain platform wallet)"
      );
    }
    return privateKeyToAccount(pk as Hex).address.toLowerCase();
  },

  /**
   * Optional fee-treasury address, derived from `PLATFORM_TREASURY_PRIVATE_KEY`.
   * Returns null when the key is unset/invalid, which keeps the treasury card
   * hidden instead of showing a wallet that cannot receive anything.
   */
  treasuryAddress(): string | null {
    const pk = (process.env.PLATFORM_TREASURY_PRIVATE_KEY ?? "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) return null;
    return privateKeyToAccount(pk as Hex).address.toLowerCase();
  },

  async getNativeBalance(address: string): Promise<bigint> {
    // Validate first: the common failure while migrating is still pointing at a
    // Solana base58 platform key (see F11 in MIGRATION-ROBINHOOD.md), and an RPC
    // "invalid argument" is a much worse error message than this one.
    if (!EVM_ADDRESS_RE.test(String(address ?? "").trim())) {
      throw new Error(
        `Expected a 0x… address for a balance lookup on Robinhood Chain, got "${address}". ` +
          `The configured platform wallet is probably still a Solana key (F11).`
      );
    }
    const hex = await rpc<string>("eth_getBalance", [
      address.toLowerCase(),
      "latest",
    ]);
    return BigInt(hex);
  },

  /**
   * Pay the winners in native ETH, one transaction each, sequential and awaited.
   *
   * Design notes (all verified against the chain on 2026-10-29):
   * - **One tx per winner.** Native transfers cannot be batched without a
   *   contract, so the round's single `payoutTx` column keeps only the first
   *   hash; every hash is returned and logged. Gas is ~0,02 gwei, so 3 payouts
   *   cost ~0,0000013 ETH.
   * - **All fees are set explicitly** (`gas`, `gasPrice`, `nonce`), so nothing
   *   depends on `eth_estimateGas` — it returned an empty result on Alchemy for
   *   this chain, and a payout must not hinge on that.
   * - **1,5× gas-price headroom.** Blocks are ~101 ms; the base fee is tiny but
   *   can tick up between build and broadcast.
   * - **A recipient with contract code gets a bigger limit** (EIP-7702 delegated
   *   accounts and smart wallets are real holders here — two of them hold NIGHT).
   * - **No fee sweep yet:** the platform fee simply stays on the platform wallet
   *   (same as the legacy Solana behaviour without a treasury key) and is still
   *   recorded on the round. EVM treasury sweep is a follow-up.
   */
  async sendPayouts(
    winners: { address: string; amountLamports: bigint }[],
    feeTransfer?: { amountBaseUnits: bigint; destination: string }
  ): Promise<{ txHashes: string[]; primaryTxHash: string; feeBaseUnits: bigint }> {
    if (!RPC_URL) {
      throw new Error("CHAIN_RPC_URL is not set (Robinhood Chain RPC endpoint)");
    }
    const pk = (process.env.PLATFORM_WALLET_PRIVATE_KEY ?? "").trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
      throw new Error(
        "PLATFORM_WALLET_PRIVATE_KEY is not a 32-byte 0x key (Robinhood Chain payouts)"
      );
    }

    const account = privateKeyToAccount(pk as Hex);
    const transport = http(RPC_URL, { retryCount: 2, timeout: 20_000 });
    const publicClient = createPublicClient({ chain: robinhoodChain, transport });
    const walletClient = createWalletClient({ account, chain: robinhoodChain, transport });

    // EIP-1559 fees. This chain REJECTS legacy (type-0) transactions — the owner's
    // payout died with Alchemy's "Missing or invalid parameters", and a controlled
    // test showed legacy is refused ("fee cap cannot be lower than the block base
    // fee") while the same transfer as type-2 succeeds. Real txs on this chain (the
    // pons collector) are `type: 2` with priority fee 0.
    // `maxFeePerGas` is a CAP: it must clear the block base fee, hence the headroom.
    const gasLimit = BigInt(envInt("PAYOUT_GAS_LIMIT", 21_000));
    const gasLimitContract = BigInt(envInt("PAYOUT_GAS_LIMIT_CONTRACT", 80_000));
    const headroomPct = BigInt(
      Math.max(100, Math.round(envNum("PAYOUT_GAS_HEADROOM", 2) * 100))
    );
    const fixedGwei = envNum("PAYOUT_GAS_PRICE_GWEI", 0);
    const rpcGasPrice = await publicClient.getGasPrice();
    const maxFeePerGas =
      fixedGwei > 0
        ? BigInt(Math.round(fixedGwei * 1e9))
        : (rpcGasPrice * headroomPct) / 100n;
    const maxPriorityFeePerGas = BigInt(
      Math.round(envNum("PAYOUT_PRIORITY_FEE_GWEI", 0) * 1e9)
    );
    let nonce = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    });

    // The treasury sweep rides FIRST: this path is not atomic, so a failing fee
    // transfer must abort before any prize leaves the wallet.
    const queue: { to: Hex; value: bigint; isFee: boolean }[] = [];
    if (feeTransfer && feeTransfer.amountBaseUnits > 0n) {
      if (!EVM_ADDRESS_RE.test(feeTransfer.destination)) {
        throw new Error(
          `Fee treasury "${feeTransfer.destination}" is not a 0x address`
        );
      }
      queue.push({
        to: feeTransfer.destination as Hex,
        value: feeTransfer.amountBaseUnits,
        isFee: true,
      });
    }
    for (const w of winners) {
      if (w.amountLamports <= 0n) continue;
      if (!EVM_ADDRESS_RE.test(w.address)) {
        throw new Error(`Winner "${w.address}" is not a 0x address`);
      }
      queue.push({
        to: w.address as Hex,
        value: w.amountLamports,
        isFee: false,
      });
    }

    // Resolve the gas limit per recipient (a contract / EIP-7702 account needs
    // more) and check the wallet covers values + gas BEFORE the first send.
    // 2026-10-29: a reserve smaller than the batch's gas let a payout send the fee
    // + 2 winners and then fail on #3 — money moved, nothing recorded.
    const plan: { to: Hex; value: bigint; isFee: boolean; gas: bigint }[] = [];
    for (const t of queue) {
      const code = await publicClient.getCode({ address: t.to });
      plan.push({
        ...t,
        gas: code && code !== "0x" ? gasLimitContract : gasLimit,
      });
    }
    const totalValue = plan.reduce((sum, t) => sum + t.value, 0n);
    const totalGas = plan.reduce((sum, t) => sum + t.gas * maxFeePerGas, 0n);
    const balance = await publicClient.getBalance({ address: account.address });
    if (balance < totalValue + totalGas) {
      throw new Error(
        `Payout needs ${totalValue + totalGas} wei (${totalValue} value + ${totalGas} gas for ${plan.length} tx) ` +
          `but the platform wallet holds ${balance} wei. Nothing was sent — fund the wallet or lower ` +
          `PRIZE_RESERVE_WEI so the pool leaves room for gas.`
      );
    }

    const landed: { address: string; amountBaseUnits: bigint; txHash: string }[] =
      [];
    const winnerHashes: string[] = [];
    let feeBaseUnits = 0n;

    for (const t of plan) {
      try {
        const hash = await walletClient.sendTransaction({
          to: t.to,
          value: t.value,
          gas: t.gas,
          maxFeePerGas,
          maxPriorityFeePerGas,
          nonce,
        });
        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          timeout: 90_000,
          pollingInterval: 500,
        });
        if (receipt.status !== "success") {
          throw new Error(`reverted on-chain`);
        }
        feeBaseUnits +=
          receipt.gasUsed * (receipt.effectiveGasPrice ?? maxFeePerGas);
        landed.push({ address: t.to, amountBaseUnits: t.value, txHash: hash });
        if (!t.isFee) winnerHashes.push(hash);
        nonce += 1;
      } catch (e) {
        // Attach what ALREADY landed: the caller records those winners instead of
        // deleting every row and leaving unexplained money on-chain.
        const err = new Error(
          `Payout to ${t.to} failed after ${landed.length} on-chain transfer(s): ${
            (e as Error).message
          }`
        ) as PayoutError;
        err.partialPayouts = landed;
        err.partialFeeBaseUnits = feeBaseUnits;
        throw err;
      }
    }

    if (winnerHashes.length === 0) {
      throw new Error("sendPayouts: nothing to send (all winner amounts were zero)");
    }
    return {
      txHashes: winnerHashes,
      primaryTxHash: winnerHashes[0],
      feeBaseUnits,
    };
  },

  async listHolders(opts = {}): Promise<ChainHolderSnapshot> {
    const token = (process.env.TOKEN_ADDRESS ?? "").trim();
    if (!EVM_ADDRESS_RE.test(token)) {
      throw new Error(
        "TOKEN_ADDRESS is not set to a 0x… contract address (Robinhood Chain token)"
      );
    }

    const info = await fetchJson<TokenInfo>(`${API_BASE}/api/v2/tokens/${token}`);
    const decimals = Number(info.decimals ?? 18);
    const onChainTotal = Number(info.holders_count ?? 0);

    const floor = opts.minBalance ?? 0n;
    const maxPages = Math.max(1, Math.min(500, opts.maxPages ?? 40));
    const holders: ChainHolder[] = [];
    let cursor: HoldersPage["next_page_params"] = null;
    let pages = 0;
    let reachedFloor = false;

    while (pages < maxPages && !reachedFloor) {
      const url = new URL(`${API_BASE}/api/v2/tokens/${token}/holders`);
      if (cursor?.value && cursor?.address_hash) {
        url.searchParams.set("value", cursor.value);
        url.searchParams.set("address_hash", cursor.address_hash);
        url.searchParams.set("items_count", String(cursor.items_count ?? 50));
      }
      const page = await fetchJson<HoldersPage>(url.toString());
      pages++;
      for (const item of page.items ?? []) {
        const owner = item.address?.hash?.toLowerCase();
        if (!owner || !item.value) continue;
        const amount = BigInt(item.value);
        // Sorted by balance DESC → the first wallet under the floor ends the walk.
        if (floor > 0n && amount < floor) {
          reachedFloor = true;
          break;
        }
        const venue = classifyEvmHolder({
          hash: owner,
          is_contract: item.address?.is_contract,
          proxy_type: item.address?.proxy_type,
          name: item.address?.name,
        });
        holders.push({
          owner,
          amount: amount.toString(),
          decimals,
          isVenue: venue.isVenue,
          venueLabel: venue.label,
        });
      }
      cursor = page.next_page_params ?? null;
      if (!cursor) break;
    }

    return {
      holders,
      totalHolders: onChainTotal || holders.length,
      fetchedAt: new Date(),
      truncated: reachedFloor || cursor !== null,
      pagesFetched: pages,
    };
  },

  normalizeAddress(raw: string): string {
    const value = String(raw ?? "").trim();
    if (!value) throw new Error("Wallet address is required");
    if (!EVM_ADDRESS_RE.test(value)) {
      throw new Error("Not a valid 0x address (42 characters, 20 bytes)");
    }
    if (value.toLowerCase() === ZERO_ADDRESS) {
      throw new Error("The zero address cannot hold a prize");
    }
    return value.toLowerCase();
  },

  isValidAddress(value: string): boolean {
    const v = String(value ?? "").trim().toLowerCase();
    return EVM_ADDRESS_RE.test(v) && v !== ZERO_ADDRESS;
  },
};

/* ------------------------------------------------------------------------- *
 * Holder source #2 — Alchemy AssetTransfers (no indexer required)
 *
 * Why: the public Blockscout instance throttles whole HOSTS with HTTP 403
 * (verified on the owner's machine: every request, any User-Agent), which is what
 * made the admin "Sync now" button answer 500. `eth_getLogs` cannot replace it —
 * Alchemy's free tier caps a log query at a **10-block range** (verified: every
 * span above 10 was rejected) while this chain produces ~855.000 blocks/day.
 *
 * `alchemy_getAssetTransfers` has no such limit: it pages 1.000 ERC-20 transfers
 * of one contract, which is aggregated here into net balances.
 *
 * Trade-offs vs the indexer: no `holders_count` (we report what we derived), no
 * contract NAMES (venue labels come from `eth_getCode`), and the cost is
 * O(transfers) per sync until a cursor is added.
 * ------------------------------------------------------------------------- */

interface AlchemyTransfer {
  from?: string | null;
  to?: string | null;
  rawContract?: { value?: string | null } | null;
}

interface AlchemyTransfersPage {
  transfers?: AlchemyTransfer[];
  pageKey?: string;
}

/** Net balances from the token's full transfer history. */
async function listHoldersFromTransfers(
  opts: { minBalance?: bigint; maxPages?: number } = {}
): Promise<ChainHolderSnapshot> {
  const token = (process.env.TOKEN_ADDRESS ?? "").trim();
  if (!EVM_ADDRESS_RE.test(token)) {
    throw new Error(
      "TOKEN_ADDRESS is not set to a 0x… contract address (Robinhood Chain token)"
    );
  }

  const meta = await rpc<{ decimals?: number }>("alchemy_getTokenMetadata", [
    token,
  ]);
  const decimals = Number(meta.decimals ?? 18);

  const floor = opts.minBalance ?? 0n;
  const maxPages = Math.max(1, Math.min(200, opts.maxPages ?? 40));
  const net = new Map<string, bigint>();
  let pageKey: string | undefined;
  let pages = 0;

  for (;;) {
    if (pages >= maxPages) break;
    const page = await rpc<AlchemyTransfersPage>("alchemy_getAssetTransfers", [
      {
        fromBlock: "0x0",
        toBlock: "latest",
        contractAddresses: [token],
        category: ["erc20"],
        maxCount: "0x3e8",
        withMetadata: false,
        excludeZeroValue: true,
        order: "asc",
        ...(pageKey ? { pageKey } : {}),
      },
    ]);
    pages += 1;
    for (const t of page.transfers ?? []) {
      const value = BigInt(t.rawContract?.value ?? "0x0");
      const to = t.to?.toLowerCase();
      const from = t.from?.toLowerCase();
      if (to) net.set(to, (net.get(to) ?? 0n) + value);
      if (from) net.set(from, (net.get(from) ?? 0n) - value);
    }
    pageKey = page.pageKey;
    if (!pageKey) break;
  }

  const candidates: { owner: string; amount: bigint }[] = [];
  for (const [owner, amount] of net) {
    if (amount <= 0n) continue;
    if (floor > 0n && amount < floor) continue;
    candidates.push({ owner, amount });
  }
  candidates.sort((a, b) =>
    a.amount === b.amount ? a.owner.localeCompare(b.owner) : a.amount > b.amount ? -1 : 1
  );

  // Venue detection without the indexer: one `eth_getCode` per candidate, in
  // small parallel batches. `0xef0100…` is the EIP-7702 delegation designator,
  // so those accounts stay eligible (they are real users).
  const holders: ChainHolder[] = [];
  const BATCH = 8;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const slice = candidates.slice(i, i + BATCH);
    const verdicts = await Promise.all(
      slice.map(async (c) => {
        try {
          const code = await rpc<string>("eth_getCode", [c.owner, "latest"]);
          return classifyEvmHolder({
            hash: c.owner,
            is_contract: Boolean(code) && code !== "0x",
            proxy_type: code?.startsWith("0xef0100") ? "eip7702" : null,
            name: null,
          });
        } catch {
          return { isVenue: false, label: "wallet" };
        }
      })
    );
    slice.forEach((c, idx) =>
      holders.push({
        owner: c.owner,
        amount: c.amount.toString(),
        decimals,
        isVenue: verdicts[idx].isVenue,
        venueLabel: verdicts[idx].label,
      })
    );
  }

  return {
    holders,
    totalHolders: holders.length,
    fetchedAt: new Date(),
    truncated: Boolean(pageKey),
    pagesFetched: pages,
    source: "alchemy-transfers",
  };
}

/**
 * The registered adapter: the indexer implementation above, wrapped with the
 * holder-source fallback.
 *
 * `HOLDER_SOURCE` — `auto` (default) tries the indexer first and falls back to
 * AssetTransfers; `indexer` / `transfers` force one path.
 */
export const robinhoodAdapter: ChainAdapter = {
  ...robinhoodAdapterBase,
  async listHolders(opts = {}) {
    const source = (process.env.HOLDER_SOURCE ?? "auto").trim().toLowerCase();
    if (source === "transfers") return listHoldersFromTransfers(opts);

    try {
      const snapshot = await robinhoodAdapterBase.listHolders(opts);
      return { ...snapshot, source: "blockscout" };
    } catch (e) {
      if (source === "indexer") throw e;
      logEvent(
        "warn",
        "sync",
        `holder indexer unavailable (${(e as Error).message}) — falling back to alchemy_getAssetTransfers`
      );
      return listHoldersFromTransfers(opts);
    }
  },
};
