/**
 * Buyback & burn ledger (plain JSON, no DB).
 *
 * The programme is executed by hand — one market buy, then one burn — so the
 * numbers live in `data/buyback.json` instead of a Prisma table: no migration,
 * no indexer, and the file can be edited either in Admin → Buyback or directly
 * on the server. A single JSON document is the right size for a handful of rows
 * per month.
 *
 * Everything the UI shows is DERIVED from `txs` (`summarizeBuyback`), so the
 * headline figures can never disagree with the rows below them: record the buy
 * and the burn and "Bought", "Burned", "SOL spent" and the run count follow.
 *
 * Pure types + maths — safe to import from client components. The fs side lives
 * in `buyback-store.ts` (server-only).
 */

export type BuybackKind = "buy" | "burn";

export type BuybackTx = {
  /** Base58 transaction signature — the on-chain receipt. */
  signature: string;
  /** ISO timestamp of the swap / burn. */
  at: string;
  kind: BuybackKind;
  /** SOL spent on the buy. Only meaningful (and only allowed) on `buy` rows. */
  sol?: number;
  /** Tokens moved, always positive — `kind` supplies the sign in the UI. */
  tokens: number;
};

export type BuybackData = {
  /** Share of collected platform fees routed to buybacks (%). */
  feeSharePct: number;
  /** Circulating supply in human units — the denominator of "burned %". */
  supply: number;
  /** ISO timestamp of the next planned run ("" when nothing is scheduled). */
  nextRunAt: string;
  /** ISO timestamp written by the API on every save. */
  updatedAt: string;
  /** Newest first. */
  txs: BuybackTx[];
};

export type BuybackSummary = {
  /** Tokens bought back (human units). */
  bought: number;
  /** Tokens burned (human units) — ≤ bought when every buy is burned. */
  burned: number;
  /** Burned as a share of `supply` (%). 0 when supply isn't set. */
  burnedPct: number;
  /** SOL spent across every buy row. */
  spentSol: number;
  /** Completed runs — one per buy leg. */
  runs: number;
  /** Timestamp of the newest row, or null when the ledger is empty. */
  lastAt: string | null;
};

/** Empty ledger — also the fallback when `data/buyback.json` is missing. */
export const EMPTY_BUYBACK: BuybackData = {
  feeSharePct: 70,
  supply: 0,
  nextRunAt: "",
  updatedAt: "",
  txs: [],
};

/** Upper bound on rows: this is a hand-kept ledger, not an indexer. */
export const MAX_BUYBACK_TXS = 500;

/** Base58 charset, length-guarded. Real Solana signatures are 87–88 chars. */
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{32,128}$/;

/** Roll the ledger up into the figures the card renders. Pure, no I/O. */
export function summarizeBuyback(data: BuybackData): BuybackSummary {
  let bought = 0;
  let burned = 0;
  let spentSol = 0;
  let runs = 0;
  let lastAt: string | null = null;
  let lastMs = Number.NEGATIVE_INFINITY;

  for (const t of data.txs) {
    if (t.kind === "buy") {
      bought += t.tokens;
      spentSol += t.sol ?? 0;
      runs += 1;
    } else {
      burned += t.tokens;
    }
    const ms = Date.parse(t.at);
    if (Number.isFinite(ms) && ms > lastMs) {
      lastMs = ms;
      lastAt = t.at;
    }
  }

  return {
    bought,
    burned,
    burnedPct: data.supply > 0 ? (burned / data.supply) * 100 : 0,
    spentSol,
    runs,
    lastAt,
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validate + coerce an arbitrary JSON body into a `BuybackData`.
 *
 * Returns `errors` keyed by dotted path (`feeSharePct`, `txs.3.signature`) so
 * the admin form can put each message under the field that caused it. Invalid
 * rows are dropped from `data` — callers must treat a non-empty `errors` as
 * "do not write anything".
 */
export function normalizeBuyback(input: unknown): {
  data: BuybackData;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  const src =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  const rawTxs = Array.isArray(src.txs) ? src.txs : [];
  if (src.txs !== undefined && src.txs !== null && !Array.isArray(src.txs)) {
    errors.txs = "The ledger must be a list of transactions.";
  } else if (rawTxs.length > MAX_BUYBACK_TXS) {
    errors.txs = `Keep the ledger under ${MAX_BUYBACK_TXS} rows.`;
  }

  const feeSharePct = num(src.feeSharePct) ?? 0;
  if (feeSharePct < 0 || feeSharePct > 100) {
    errors.feeSharePct = "Use a percentage between 0 and 100.";
  }

  const supply = num(src.supply) ?? 0;
  if (supply < 0) errors.supply = "Supply cannot be negative.";

  const nextRunAt = text(src.nextRunAt);
  if (nextRunAt && Number.isNaN(Date.parse(nextRunAt))) {
    errors.nextRunAt = "That is not a valid date.";
  }

  const txs: BuybackTx[] = [];
  const seen = new Set<string>();

  rawTxs.slice(0, MAX_BUYBACK_TXS).forEach((row, i) => {
    const path = `txs.${i}`;
    const r =
      row && typeof row === "object" ? (row as Record<string, unknown>) : {};

    const kind = r.kind === "buy" || r.kind === "burn" ? r.kind : null;
    const signature = text(r.signature);
    const at = text(r.at);
    const tokens = num(r.tokens);
    const sol =
      r.sol === undefined || r.sol === null || r.sol === "" ? null : num(r.sol);
    let bad = false;

    if (!kind) {
      errors[`${path}.kind`] = "Pick buy or burn.";
      bad = true;
    }
    if (!signature) {
      errors[`${path}.signature`] = "Paste the transaction signature.";
      bad = true;
    } else if (!SIGNATURE_RE.test(signature)) {
      errors[`${path}.signature`] = "That is not a base58 Solana signature.";
      bad = true;
    } else if (seen.has(signature)) {
      errors[`${path}.signature`] = "This signature is already in the ledger.";
      bad = true;
    } else {
      seen.add(signature);
    }
    if (!at) {
      errors[`${path}.at`] = "Pick the date and time.";
      bad = true;
    } else if (Number.isNaN(Date.parse(at))) {
      errors[`${path}.at`] = "That is not a valid date.";
      bad = true;
    }
    if (tokens === null || tokens <= 0) {
      errors[`${path}.tokens`] = "Enter a token amount above 0.";
      bad = true;
    }
    if (kind === "buy") {
      if (sol === null || sol <= 0) {
        errors[`${path}.sol`] = "Enter the SOL spent on the buy.";
        bad = true;
      }
    } else if (sol) {
      errors[`${path}.sol`] = "A burn spends no SOL — leave this empty.";
      bad = true;
    }

    if (bad || !kind || tokens === null) return;
    txs.push({
      signature,
      at,
      kind,
      ...(kind === "buy" && sol ? { sol } : {}),
      tokens,
    });
  });

  // Newest first, matching what both the card and the editor show.
  txs.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return {
    data: {
      feeSharePct,
      supply,
      nextRunAt,
      updatedAt: text(src.updatedAt),
      txs,
    },
    errors,
  };
}


/** Numbers may arrive as JSON numbers or as strings from the admin form. */
function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
