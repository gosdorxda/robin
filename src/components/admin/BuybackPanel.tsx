"use client";

import { useCallback, useEffect, useState } from "react";
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
import type { BuybackData, BuybackKind } from "@/lib/buyback";
import { fmtSolNum } from "@/lib/format";
// Chain-aware display unit ("SOL" on Solana, "ETH" on Robinhood Chain).
import { NATIVE_SYMBOL } from "@/lib/chain/network";
import { useSite } from "@/components/providers/SiteProvider";

/**
 * Admin → Buyback & burn.
 *
 * Writes the hand-maintained ledger in `data/buyback.json` through
 * `PUT /api/buyback`. Only three programme-wide fields plus the buy / burn rows
 * are editable: every headline figure on `/treasury` is derived from the rows
 * (see `summarizeBuyback`), so there is nothing to keep in sync by hand.
 */

type DraftTx = {
  signature: string;
  /** `datetime-local` value in UTC (converted to ISO on save). */
  at: string;
  kind: BuybackKind;
  sol: string;
  tokens: string;
};

type Draft = {
  feeSharePct: string;
  supply: string;
  nextRunAt: string;
  txs: DraftTx[];
};

type Errors = Record<string, string>;

type BuybackResponse = {
  buyback?: BuybackData;
  errors?: Errors;
  error?: string;
};

/** ISO → `datetime-local`, read and written in UTC (the site's clock). */
function toUtcInput(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())}`;
}

/**
 * `datetime-local` → ISO. The value is read as UTC, matching every timestamp on
 * the site (before this it was read as the browser's local time, so an admin in
 * WIB typed 15:32 and /treasury showed 08:32). Empty stays empty (optional).
 */
function fromUtcInput(value: string): string {
  if (!value) return "";
  const d = new Date(`${value}Z`);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function toDraft(data: BuybackData): Draft {
  return {
    feeSharePct: String(data.feeSharePct),
    supply: data.supply > 0 ? String(data.supply) : "",
    nextRunAt: toUtcInput(data.nextRunAt),
    txs: data.txs.map((t) => ({
      signature: t.signature,
      at: toUtcInput(t.at),
      kind: t.kind,
      sol: t.kind === "buy" && t.sol != null ? String(t.sol) : "",
      tokens: String(t.tokens),
    })),
  };
}

function toPayload(draft: Draft) {
  return {
    feeSharePct: Number(draft.feeSharePct || 0),
    supply: Number(draft.supply || 0),
    nextRunAt: fromUtcInput(draft.nextRunAt),
    txs: draft.txs.map((t) => ({
      signature: t.signature.trim(),
      at: fromUtcInput(t.at),
      kind: t.kind,
      ...(t.kind === "buy" ? { sol: Number(t.sol || 0) } : {}),
      tokens: Number(t.tokens || 0),
    })),
  };
}

/** Live preview of the numbers `/treasury` will derive from this draft. */
function preview(draft: Draft) {
  let bought = 0;
  let burned = 0;
  let spent = 0;
  let runs = 0;
  for (const t of draft.txs) {
    const tokens = Number(t.tokens);
    if (!Number.isFinite(tokens) || tokens <= 0) continue;
    if (t.kind === "buy") {
      bought += tokens;
      spent += Number(t.sol) || 0;
      runs += 1;
    } else {
      burned += tokens;
    }
  }
  return { bought, burned, spent, runs };
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {children}
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function BuybackPanel() {
  const { tokenName } = useSite();
  const [draft, setDraft] = useState<Draft>({
    feeSharePct: "",
    supply: "",
    nextRunAt: "",
    txs: [],
  });
  const [errors, setErrors] = useState<Errors>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/buyback", { cache: "no-store" });
      const data = (await r.json()) as BuybackResponse;
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      if (data.buyback) setDraft(toDraft(data.buyback));
      setErrors({});
      setDirty(false);
      setNotice(null);
    } catch (e) {
      setNotice({ kind: "err", text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Drop the server errors a given edit just made stale (keeps the rest visible). */
  function clearErrors(match: (key: string) => boolean) {
    setErrors((prev) => {
      const stale = Object.keys(prev).filter(match);
      if (stale.length === 0) return prev;
      const next = { ...prev };
      for (const k of stale) delete next[k];
      return next;
    });
  }

  /** Any edit re-enables Save and retires the previous save notice. */
  function touch() {
    setDirty(true);
    setNotice(null);
  }

  function setField(patch: Partial<Omit<Draft, "txs">>) {
    setDraft((d) => ({ ...d, ...patch }));
    touch();
    for (const key of Object.keys(patch)) clearErrors((k) => k === key);
  }

  function setTx(i: number, patch: Partial<DraftTx>) {
    setDraft((d) => ({
      ...d,
      txs: d.txs.map((t, j) => (j === i ? { ...t, ...patch } : t)),
    }));
    touch();
    clearErrors((k) => k.startsWith(`txs.${i}.`));
  }

  /** New rows go on top: the API sorts newest-first anyway. */
  function addTx(kind: BuybackKind) {
    const at = toUtcInput(new Date().toISOString());
    setDraft((d) => ({
      ...d,
      txs: [{ signature: "", at, kind, sol: "", tokens: "" }, ...d.txs],
    }));
    touch();
    // Row indices shift, so every row-scoped message is stale now.
    setErrors((prev) =>
      Object.keys(prev).some((k) => k.startsWith("txs.")) ? {} : prev
    );
  }

  function removeTx(i: number) {
    setDraft((d) => ({ ...d, txs: d.txs.filter((_, j) => j !== i) }));
    touch();
    setErrors((prev) =>
      Object.keys(prev).some((k) => k.startsWith("txs.")) ? {} : prev
    );
  }

  async function save() {
    setSaving(true);
    setNotice(null);
    try {
      const r = await fetch("/api/buyback", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buyback: toPayload(draft) }),
      });
      const data = (await r.json()) as BuybackResponse;
      if (r.status === 400 && data.errors) {
        setErrors(data.errors);
        setNotice({
          kind: "err",
          text: "Some rows need attention — nothing was written.",
        });
        return;
      }
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      if (data.buyback) setDraft(toDraft(data.buyback));
      setErrors({});
      setDirty(false);
      setNotice({
        kind: "ok",
        text: "Saved to data/buyback.json. /treasury picks it up on the next load.",
      });
    } catch (e) {
      setNotice({ kind: "err", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  const p = preview(draft);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-2">
        <p className="font-bold">Buyback &amp; burn</p>
        {dirty ? (
          <Chip size="sm" variant="soft" color="warning">
            Unsaved changes
          </Chip>
        ) : null}
        <span className="ml-auto text-xs text-muted">
          Hand-kept ledger · data/buyback.json
        </span>
        <Button
          size="sm"
          variant="ghost"
          onPress={load}
          isDisabled={loading || saving}
        >
          Reload
        </Button>
      </CardHeader>
      <Separator />
      <CardContent className="gap-6">
        {notice ? (
          <div
            className={`rounded-lg border px-3 py-2 text-sm ${
              notice.kind === "ok"
                ? "border-(--border) bg-success/10 text-success"
                : "border-(--border) bg-danger/10 text-danger"
            }`}
          >
            {notice.text}
          </div>
        ) : null}

        {loading ? (
          <p className="text-sm text-muted">Loading buyback ledger…</p>
        ) : (
          <>
            <section className="flex flex-col gap-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Programme
              </h3>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field
                  label="Buyback share"
                  hint="% of collected platform fees routed to buybacks."
                  error={errors.feeSharePct}
                >
                  <TextField
                    aria-label="Buyback share"
                    value={draft.feeSharePct}
                    onChange={(v) => setField({ feeSharePct: v })}
                    isInvalid={!!errors.feeSharePct}
                  >
                    <Input inputMode="decimal" placeholder="70" />
                  </TextField>
                </Field>
                <Field
                  label="Supply"
                  hint={`${tokenName} in circulation (human units) — the denominator of “burned %”.`}
                  error={errors.supply}
                >
                  <TextField
                    aria-label="Supply"
                    value={draft.supply}
                    onChange={(v) => setField({ supply: v })}
                    isInvalid={!!errors.supply}
                  >
                    <Input inputMode="decimal" placeholder="1000000000" />
                  </TextField>
                </Field>
                <Field
                  label="Next run (UTC)"
                  hint="Shown as “next …” on /treasury. Times are UTC. Leave empty when nothing is scheduled."
                  error={errors.nextRunAt}
                >
                  <TextField
                    aria-label="Next run (UTC)"
                    value={draft.nextRunAt}
                    onChange={(v) => setField({ nextRunAt: v })}
                    isInvalid={!!errors.nextRunAt}
                  >
                    <Input type="datetime-local" />
                  </TextField>
                </Field>
              </div>
            </section>


            <Separator />

            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Ledger
                </h3>
                <span className="text-xs text-muted">
                  {draft.txs.length} row{draft.txs.length === 1 ? "" : "s"} ·
                  newest first on /treasury
                </span>
                <div className="ml-auto flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => addTx("buy")}
                  >
                    Add buy
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() => addTx("burn")}
                  >
                    Add burn
                  </Button>
                </div>
              </div>

              {errors.txs ? (
                <p className="text-xs text-danger">{errors.txs}</p>
              ) : null}

              {draft.txs.length === 0 ? (
                <p className="rounded-lg border border-dashed border-(--border) px-4 py-6 text-center text-sm text-muted">
                  No rows yet. Add the buy first, then the burn of the tokens it
                  bought — /treasury derives every figure from these rows.
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  {draft.txs.map((t, i) => (
                    <div
                      key={i}
                      className="flex flex-col gap-3 rounded-lg border border-(--border) bg-default/40 p-3"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="inline-flex overflow-hidden rounded-md border border-(--border)">
                          {(["buy", "burn"] as const).map((k) => (
                            <button
                              key={k}
                              type="button"
                              aria-pressed={t.kind === k}
                              onClick={() => setTx(i, { kind: k })}
                              className={`px-2.5 py-1 text-xs font-medium transition ${
                                t.kind === k
                                  ? "bg-surface text-foreground"
                                  : "text-muted hover:bg-default/40"
                              }`}
                            >
                              {k === "buy" ? "Buy" : "Burn"}
                            </button>
                          ))}
                        </div>
                        <span className="font-mono text-xs text-muted">
                          row {i + 1}
                        </span>
                        {errors[`txs.${i}.kind`] ? (
                          <span className="text-xs text-danger">
                            {errors[`txs.${i}.kind`]}
                          </span>
                        ) : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-auto"
                          onPress={() => removeTx(i)}
                        >
                          Remove
                        </Button>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="sm:col-span-2">
                          <Field
                            label="Transaction"
                            hint="Paste the signature from Solscan — /treasury links it to the explorer."
                            error={errors[`txs.${i}.signature`]}
                          >
                            <TextField
                              aria-label={`Transaction ${i + 1}`}
                              value={t.signature}
                              onChange={(v) => setTx(i, { signature: v })}
                              isInvalid={!!errors[`txs.${i}.signature`]}
                            >
                              <Input
                                placeholder="5Dm7… base58 signature"
                                className="font-mono text-xs"
                              />
                            </TextField>
                          </Field>
                        </div>
                        <Field label="When (UTC)" error={errors[`txs.${i}.at`]}>
                          <TextField
                            aria-label={`When ${i + 1} (UTC)`}
                            value={t.at}
                            onChange={(v) => setTx(i, { at: v })}
                            isInvalid={!!errors[`txs.${i}.at`]}
                          >
                            <Input type="datetime-local" />
                          </TextField>
                        </Field>
                        <Field
                          label="Tokens"
                          hint={
                            t.kind === "buy"
                              ? "Tokens received (human units, no sign)."
                              : "Tokens destroyed (human units, no sign)."
                          }
                          error={errors[`txs.${i}.tokens`]}
                        >
                          <TextField
                            aria-label={`Tokens ${i + 1}`}
                            value={t.tokens}
                            onChange={(v) => setTx(i, { tokens: v })}
                            isInvalid={!!errors[`txs.${i}.tokens`]}
                          >
                            <Input inputMode="decimal" placeholder="2046667" />
                          </TextField>
                        </Field>
                        {t.kind === "buy" ? (
                          <Field label={`${NATIVE_SYMBOL} spent`} error={errors[`txs.${i}.sol`]}>
                            <TextField
                              aria-label={`${NATIVE_SYMBOL} spent ${i + 1}`}
                              value={t.sol}
                              onChange={(v) => setTx(i, { sol: v })}
                              isInvalid={!!errors[`txs.${i}.sol`]}
                            >
                              <Input inputMode="decimal" placeholder="1.386" />
                            </TextField>
                          </Field>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <p className="text-xs text-muted">
                /treasury will show {p.runs} run{p.runs === 1 ? "" : "s"} ·{" "}
                {p.bought.toLocaleString("en-US")} bought ·{" "}
                {p.burned.toLocaleString("en-US")} burned ·{" "}
                {fmtSolNum(p.spent)}{" "}
                {NATIVE_SYMBOL} spent.
              </p>
            </section>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-(--border) pt-4">
              <p className="text-xs text-muted">
                Saving rewrites data/buyback.json atomically — no database row is
                involved.
              </p>
              <Button
                variant="primary"
                onPress={save}
                isDisabled={saving || !dirty}
              >
                {saving ? "Saving…" : "Save ledger"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
