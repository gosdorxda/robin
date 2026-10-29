import { Connection, PublicKey } from "@solana/web3.js";
import { getConfig } from "../config";
import { getConnection } from "./connection";

/** Standard SPL Token program id (pump.fun tokens live here). */
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
/** Token-2022 program id (checked too, in case the mint uses the newer program). */
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6UTFLGdJKSKkocXCGnDRA"
);

export interface Holder {
  /** Holder wallet address (the token account *owner*, not the ATA). */
  owner: string;
  /** Raw token amount as an integer string (includes decimals). */
  amount: string;
  /** Token decimals. */
  decimals: number;
  /** Representative token account pubkey for this owner (for reference). */
  tokenAccount: string;
}

/**
 * Fetches non-zero token accounts for the configured mint.
 *
 * The token program is resolved DYNAMICALLY from the mint account's owner
 * (standard SPL Token vs Token-2022 vs other). This is essential because
 * pump.fun tokens are Token-2022, whose token accounts carry extensions and are
 * NOT a fixed 165 bytes — a hard `dataSize: 165` filter silently drops every
 * one of them and you get "0 holders".
 *
 * Uses `jsonParsed` encoding with only a mint `memcmp` filter (no dataSize), so
 * accounts of any size are returned and the RPC decodes owner + amount itself.
 */
async function fetchHolders(): Promise<Holder[]> {
  const cfg = getConfig();
  const connection = getConnection();
  const mint = new PublicKey(cfg.tokenMint);

  // Resolve the program that owns this mint (Token / Token-2022 / ...).
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) {
    throw new Error(
      `Mint ${mint.toBase58()} was not found on ${cfg.network}. Check TOKEN_MINT and SOLANA_NETWORK.`
    );
  }
  const tokenProgram = mintInfo.owner;

  // getParsedProgramAccounts returns jsonParsed output (so Token-2022 accounts
  // with variable-length extensions are decoded by the RPC itself) and accepts
  // the same mint `memcmp` filter — no dataSize restriction.
  const accounts = await connection.getParsedProgramAccounts(tokenProgram, {
    filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
  });

  const holders: Holder[] = [];
  for (const a of accounts) {
    const data = a.account.data as unknown as {
      parsed?: {
        type?: string;
        info?: {
          owner?: string;
          tokenAmount?: { amount?: string; decimals?: number };
        };
      };
    };
    const parsed = data.parsed;
    if (!parsed || parsed.type !== "account") continue;
    const info = parsed.info;
    if (!info?.owner || !info?.tokenAmount?.amount) continue;
    const amount = info.tokenAmount.amount;
    if (BigInt(amount) <= 0n) continue; // skip zero/closed accounts
    holders.push({
      owner: info.owner,
      amount,
      decimals: cfg.tokenDecimals,
      tokenAccount: a.pubkey.toBase58(),
    });
  }
  return holders;
}

/**
 * When no holders are found, inspects the mint on-chain to pinpoint WHY, so a
 * misconfiguration (wrong mint / wrong network) or a fetch problem (RPC not
 * returning getProgramAccounts results) is surfaced instead of "0 holders".
 *
 * Uses getTokenSupply as the authoritative "is this a real SPL token" check
 * (it only succeeds for token mints) and names the owning program without
 * hard-failing on programs outside our two known constants.
 */
async function diagnoseMint(
  mint: PublicKey,
  connection: Connection,
  cfg: ReturnType<typeof getConfig>
): Promise<{ shouldThrow: boolean; message: string }> {
  const mintAddr = mint.toBase58();
  const net = cfg.network;

  // 1. Does the mint account exist on this RPC/network?
  const mintInfo = await connection.getAccountInfo(mint).catch(() => null);
  if (!mintInfo) {
    return {
      shouldThrow: true,
      message: `0 holders; mint ${mintAddr} was NOT FOUND on ${net} (or the RPC failed to read it). Verify TOKEN_MINT is correct and SOLANA_NETWORK (${net}) matches where the token actually lives.`,
    };
  }

  const ownerProgram = mintInfo.owner.toBase58();
  const isStandard = ownerProgram === TOKEN_PROGRAM_ID.toBase58();
  const isT2022 = ownerProgram === TOKEN_2022_PROGRAM_ID.toBase58();
  const progNote = isStandard
    ? "Token program"
    : isT2022
    ? "Token-2022 program"
    : `program ${ownerProgram}`;

  // 2. getTokenSupply only succeeds for SPL token mints — failure means this
  //    address is not a token mint (TOKEN_MINT may point at a non-token acct).
  const supplyResp = await connection.getTokenSupply(mint).catch(() => null);
  if (!supplyResp) {
    return {
      shouldThrow: true,
      message: `0 holders; ${mintAddr} is owned by ${progNote}, and getTokenSupply failed — TOKEN_MINT may not be an SPL token mint. Verify the address.`,
    };
  }
  const supplyAmount = supplyResp.value.amount;
  if (BigInt(supplyAmount) > 0n) {
    return {
      shouldThrow: true,
      message: `0 holders even though ${mintAddr} (${progNote}) has supply ${supplyAmount} on ${net}. Your RPC is NOT returning token accounts via getProgramAccounts (common on free/public RPCs). Fix: use a Helius RPC with HELIUS_API_KEY set, or switch the fetch to Helius DAS getTokenAccounts.`,
    };
  }
  return {
    shouldThrow: false,
    message: `${mintAddr} (${progNote}) is valid but has 0 supply (no tokens minted / no holders yet).`,
  };
}

/**
 * Snapshots every non-zero holder of the configured Pay token mint.
 *
 * Uses `getProgramAccounts` (jsonParsed) on the RPC, querying whichever token
 * program owns the mint (resolved dynamically — standard Token OR Token-2022,
 * e.g. pump.fun tokens), filtered by mint only (no fixed account-size filter,
 * since Token-2022 accounts carry variable-length extensions). A wallet holding
 * the token across multiple accounts is merged into one entry with summed balance.
 *
 * Note: for tokens with an extremely large holder set (tens of thousands+),
 * this can be replaced with the paginated Helius DAS `getTokenAccounts` method
 * without changing the returned {@link Holder} shape.
 */
export async function snapshotHolders(): Promise<{
  holders: Holder[];
  totalHolders: number;
  fetchedAt: Date;
}> {
  const cfg = getConfig();
  // Single fetch: the token program is resolved dynamically from the mint's
  // owner (handles standard Token AND Token-2022, incl. pump.fun tokens whose
  // accounts carry extensions and are NOT a fixed 165 bytes).
  const raw = await fetchHolders();

  // 0 holders despite a valid mint — diagnose WHY (RPC not returning accounts,
  // wrong network, etc.) instead of an opaque "0 holders".
  if (raw.length === 0) {
    const diag = await diagnoseMint(
      new PublicKey(cfg.tokenMint),
      getConnection(),
      cfg
    );
    if (diag.shouldThrow) {
      throw new Error(diag.message);
    }
    console.warn(`[holders] ${diag.message}`);
  }

  // Merge by wallet owner, summing balances across multiple token accounts.
  const byOwner = new Map<
    string,
    { amount: bigint; decimals: number; tokenAccount: string }
  >();
  for (const h of raw) {
    const cur = byOwner.get(h.owner);
    const amt = BigInt(h.amount);
    if (cur) {
      cur.amount += amt;
    } else {
      byOwner.set(h.owner, {
        amount: amt,
        decimals: h.decimals,
        tokenAccount: h.tokenAccount,
      });
    }
  }

  const holders: Holder[] = Array.from(byOwner.entries()).map(
    ([owner, v]) => ({
      owner,
      amount: v.amount.toString(),
      decimals: v.decimals,
      tokenAccount: v.tokenAccount,
    })
  );

  return {
    holders,
    totalHolders: holders.length,
    fetchedAt: new Date(),
  };
}
