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
  Switch,
  TextArea,
  TextField,
} from "@heroui/react";
import { fmtDateTimeUtc } from "@/lib/format";
import { Skeleton } from "@/components/ui";
import {
  DEFAULT_DRAW_TEMPLATE,
  DEFAULT_ROUND_TEMPLATE,
  DRAW_PLACEHOLDER_HELP,
  MAX_TEMPLATE_LENGTH,
  ROUND_PLACEHOLDER_HELP,
  type PlaceholderHelp,
} from "@/lib/telegram-templates";

/**
 * Admin → Telegram Bot.
 *
 * Configures a bot that posts to ONE Telegram group:
 *   • a "current round" update every N minutes (default 2) — pool, eligible
 *     holders, estimated 1st prize, countdown to the next draw;
 *   • a result post the moment a round is drawn — winners, payouts, beacon,
 *     payout tx.
 *
 * Everything is saved through `/api/admin/telegram` (admin cookie guarded). The
 * token is write-only: the GET response only ever carries a masked hint, so an
 * empty token field means "keep the saved one". A token in `.env`
 * (`TELEGRAM_BOT_TOKEN`) works just as well and shows up as the source chip.
 *
 * Both message bodies are **editable templates** (Telegram HTML + `{placeholder}`
 * slots). Defaults live in `lib/telegram-templates.ts` so this client component
 * never imports the Prisma-backed bot module. "Preview edits" renders the draft
 * against live data without saving it.
 */

type TokenSource = "db" | "env" | "none";

type Preview = {
  round: string | null;
  draw: string | null;
  roundError: string | null;
};

type Overview = {
  ok?: boolean;
  config: {
    enabled: boolean;
    chatId: string;
    threadId: string;
    intervalMinutes: number;
    notifyRound: boolean;
    notifyDraw: boolean;
    roundTemplate: string;
    drawTemplate: string;
    tokenSource: TokenSource;
    tokenHint: string | null;
  };
  state: {
    lastRoundSentAt: string | null;
    lastDrawRound: number | null;
    lastDrawAttemptAt: string | null;
    lastError: string | null;
  };
  lotteryEnabled: boolean;
  lotteryCron: string;
  nextDrawAt: string | null;
  siteUrl: string;
  preview: Preview;
  history: { ts: string; level: string; message: string }[];
};

type Draft = {
  enabled: boolean;
  chatId: string;
  threadId: string;
  intervalMinutes: string;
  notifyRound: boolean;
  notifyDraw: boolean;
  roundTemplate: string;
  drawTemplate: string;
  token: string;
};

type Notice = { kind: "ok" | "err"; text: string } | null;

function toDraft(data: Overview): Draft {
  return {
    enabled: data.config.enabled,
    chatId: data.config.chatId,
    threadId: data.config.threadId,
    intervalMinutes: String(data.config.intervalMinutes),
    notifyRound: data.config.notifyRound,
    notifyDraw: data.config.notifyDraw,
    roundTemplate: data.config.roundTemplate,
    drawTemplate: data.config.drawTemplate,
    token: "",
  };
}

function fmtTime(iso: string | null): string {
  return fmtDateTimeUtc(iso);
}

function tokenLabel(source: TokenSource, hint: string | null): string {
  if (source === "db") return `Token saved${hint ? ` ${hint}` : ""}`;
  if (source === "env") return "Token from .env";
  return "No bot token";
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {error ? (
        <span className="text-[11px] leading-4 text-danger">{error}</span>
      ) : hint ? (
        <span className="text-[11px] leading-4 text-muted">{hint}</span>
      ) : null}
    </div>
  );
}

function TemplateField({
  label,
  value,
  error,
  placeholders,
  onChange,
  onReset,
}: {
  label: string;
  value: string;
  error?: string;
  placeholders: PlaceholderHelp[];
  onChange: (value: string) => void;
  onReset: () => void;
}) {
  return (
    <Field
      label={label}
      hint="Telegram HTML is allowed: <b>, <i>, <code>, <a href>. Blank lines left by empty placeholders collapse."
      error={error}
    >
      <TextField
        aria-label={`${label} message template`}
        value={value}
        onChange={onChange}
        isInvalid={!!error}
      >
        <TextArea
          rows={8}
          maxLength={MAX_TEMPLATE_LENGTH}
          spellCheck={false}
          className="font-mono text-xs"
        />
      </TextField>
      <div className="flex flex-wrap items-center gap-1.5">
        {placeholders.map((p) => (
          <code
            key={p.token}
            title={p.description}
            className="rounded-md bg-default px-1.5 py-0.5 font-mono text-[11px] text-muted"
          >
            {`{${p.token}}`}
          </code>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] tabular-nums text-muted">
          {value.length}/{MAX_TEMPLATE_LENGTH}
        </span>
        <Button size="sm" variant="ghost" onPress={onReset}>
          Reset to default
        </Button>
      </div>
    </Field>
  );
}

export function TelegramBotPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** Rendered from unsaved template edits until they are saved/discarded. */
  const [livePreview, setLivePreview] = useState<Preview | null>(null);
  const [chats, setChats] = useState<
    { id: string; title: string; type: string }[]
  >([]);

  const load = useCallback(async (opts: { keepDraft?: boolean } = {}) => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/telegram", { cache: "no-store" });
      const body = (await r.json()) as Overview & { error?: string };
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setData(body);
      setDraft((prev) => (opts.keepDraft && prev ? prev : toDraft(body)));
    } catch (e) {
      setNotice({ kind: "err", text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  async function save(extra: Record<string, unknown> = {}, label = "save") {
    if (!draft) return;
    setBusy(label);
    setNotice(null);
    setErrors({});
    try {
      const config: Record<string, unknown> = {
        enabled: draft.enabled,
        chatId: draft.chatId,
        threadId: draft.threadId,
        intervalMinutes: Number(draft.intervalMinutes || 0),
        notifyRound: draft.notifyRound,
        notifyDraw: draft.notifyDraw,
        roundTemplate: draft.roundTemplate,
        drawTemplate: draft.drawTemplate,
        ...extra,
      };
      if (draft.token.trim()) config.token = draft.token.trim();

      const r = await fetch("/api/admin/telegram", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const body = (await r.json()) as Overview & {
        error?: string;
        errors?: Record<string, string>;
      };
      if (!r.ok) {
        if (body.errors) setErrors(body.errors);
        throw new Error(
          body.error ??
            Object.values(body.errors ?? {})[0] ??
            "Could not save the bot settings."
        );
      }
      setData(body);
      setDraft(toDraft(body));
      setLivePreview(null);
      setNotice({ kind: "ok", text: "Settings saved." });
    } catch (e) {
      setNotice({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function run(action: "test" | "round" | "lastDraw" | "chats") {
    setBusy(action);
    setNotice(null);
    try {
      const r = await fetch("/api/admin/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = (await r.json()) as Overview & {
        error?: string;
        chats?: { id: string; title: string; type: string }[];
      };
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);

      if (action === "chats") {
        const found = body.chats ?? [];
        setChats(found);
        setNotice(
          found.length > 0
            ? { kind: "ok", text: "Pick the group below to fill in its chat id." }
            : { kind: "err", text: "No chats found — see the hint below." }
        );
        return;
      }

      setData(body);
      // Keep unsaved edits in the form; only refresh the server-owned fields.
      setDraft((prev) =>
        prev
          ? {
              ...prev,
              token: "",
              enabled: body.config.enabled,
              intervalMinutes: String(body.config.intervalMinutes),
              notifyRound: body.config.notifyRound,
              notifyDraw: body.config.notifyDraw,
            }
          : prev
      );
      const labels: Record<string, string> = {
        test: "Test message sent to the group.",
        round: "Current round posted.",
        lastDraw: "Last draw re-posted.",
      };
      setNotice({ kind: "ok", text: labels[action] });
    } catch (e) {
      setNotice({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  /**
   * Renders the DRAFT templates against live data without saving them. The
   * server owns the render so the preview can never drift from what the bot
   * actually sends.
   */
  async function previewEdits() {
    if (!draft) return;
    setBusy("preview");
    setNotice(null);
    setErrors({});
    try {
      const r = await fetch("/api/admin/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "preview",
          templates: {
            roundTemplate: draft.roundTemplate,
            drawTemplate: draft.drawTemplate,
          },
        }),
      });
      const body = (await r.json()) as {
        ok?: boolean;
        preview?: Preview;
        error?: string;
      };
      if (!r.ok || !body.preview) {
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      setLivePreview(body.preview);
      setNotice({
        kind: "ok",
        text: "Preview updated from your edits — not saved yet.",
      });
    } catch (e) {
      setNotice({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const src = data?.config.tokenSource ?? "none";
  const tokenHint = data?.config.tokenHint ?? null;
  const preview = livePreview ?? data?.preview ?? null;
  const templatesDirty =
    !!draft &&
    !!data &&
    (draft.roundTemplate !== data.config.roundTemplate ||
      draft.drawTemplate !== data.config.drawTemplate);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-2">
        <p className="font-bold">Telegram group bot</p>
        {data ? (
          <>
            <Chip
              size="sm"
              variant="soft"
              color={data.config.enabled ? "success" : "warning"}
            >
              {data.config.enabled ? "Active" : "Paused"}
            </Chip>
            <Chip
              size="sm"
              variant="soft"
              color={src === "none" ? "warning" : "success"}
            >
              {tokenLabel(src, tokenHint)}
            </Chip>
            <span className="text-small text-muted">
              every {data.config.intervalMinutes} min ·{" "}
              {data.config.chatId || "no chat id"}
            </span>
          </>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onPress={() => load()}
          isPending={loading}
        >
          Refresh
        </Button>
      </CardHeader>
      <Separator />
      <CardContent className="flex flex-col gap-5">
        {loading && !data ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : null}

        {!draft ? (
          <p className="text-small text-muted">
            {notice?.text ?? "Bot settings are unavailable right now."}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] leading-4 text-muted">
              <span>
                Next draw:{" "}
                {data?.lotteryEnabled
                  ? fmtTime(data?.nextDrawAt ?? null)
                  : "paused (manual trigger)"}
              </span>
              <span>
                Last round post: {fmtTime(data?.state.lastRoundSentAt ?? null)}
              </span>
              <span>
                Last announced draw:{" "}
                {data?.state.lastDrawRound
                  ? `#${data.state.lastDrawRound}`
                  : "—"}
              </span>
              {data?.state.lastError ? (
                <span className="text-danger">
                  Last error: {data.state.lastError}
                </span>
              ) : null}
            </div>

            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <p className="text-sm font-semibold">Connection</p>
                <span className="text-[11px] leading-4 text-muted">
                  Create the bot with @BotFather, add it to the group, then post
                  any message there.
                </span>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Bot token"
                  hint={
                    src === "db"
                      ? `A token is saved (${tokenHint}). Leave blank to keep it.`
                      : src === "env"
                      ? "Using TELEGRAM_BOT_TOKEN from .env — paste one to override it."
                      : "From @BotFather: 123456:ABC-DEF…"
                  }
                  error={errors.token}
                >
                  <TextField
                    aria-label="Bot token"
                    value={draft.token}
                    onChange={(v) => set("token", v)}
                    isInvalid={!!errors.token}
                  >
                    <Input
                      type="password"
                      placeholder={
                        src === "none" ? "123456:ABC-DEF…" : "••••••••"
                      }
                      className="font-mono text-xs"
                    />
                  </TextField>
                </Field>

                <Field
                  label="Group chat id"
                  hint="Numeric id (e.g. -1001234567890) or @channelusername."
                  error={errors.chatId}
                >
                  <TextField
                    aria-label="Group chat id"
                    value={draft.chatId}
                    onChange={(v) => set("chatId", v)}
                    isInvalid={!!errors.chatId}
                  >
                    <Input
                      placeholder="-1001234567890"
                      className="font-mono text-xs"
                    />
                  </TextField>
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Forum topic id (optional)"
                  hint="Only for groups with Topics enabled — leave blank for General."
                  error={errors.threadId}
                >
                  <TextField
                    aria-label="Forum topic id"
                    value={draft.threadId}
                    onChange={(v) => set("threadId", v)}
                    isInvalid={!!errors.threadId}
                  >
                    <Input
                      placeholder="—"
                      inputMode="numeric"
                      className="font-mono text-xs"
                    />
                  </TextField>
                </Field>

                <Field
                  label="Round update interval"
                  hint="Minutes between current-round posts (1–1440)."
                  error={errors.intervalMinutes}
                >
                  <TextField
                    aria-label="Round update interval in minutes"
                    value={draft.intervalMinutes}
                    onChange={(v) => set("intervalMinutes", v)}
                    isInvalid={!!errors.intervalMinutes}
                  >
                    <Input
                      inputMode="numeric"
                      placeholder="2"
                      className="font-mono text-xs"
                    />
                  </TextField>
                </Field>
              </div>

              {chats.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted">
                    Detected chats — click to use
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {chats.map((chat) => (
                      <Button
                        key={chat.id}
                        size="sm"
                        variant="secondary"
                        onPress={() => {
                          set("chatId", chat.id);
                          setChats([]);
                        }}
                      >
                        {chat.title} · {chat.id}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : null}
            </section>

            <section className="flex flex-col gap-3">
              <p className="text-sm font-semibold">Broadcasts</p>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1 rounded-lg border border-(--border) px-3 py-2.5">
                  <Switch
                    size="sm"
                    isSelected={draft.enabled}
                    onChange={(v) => set("enabled", v)}
                  >
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                      Bot enabled
                    </Switch.Content>
                  </Switch>
                  <span className="text-[11px] leading-4 text-muted">
                    Pausing stops every automatic post; manual sends still work.
                  </span>
                </div>

                <div className="flex flex-col gap-1 rounded-lg border border-(--border) px-3 py-2.5">
                  <Switch
                    size="sm"
                    isSelected={draft.notifyRound}
                    onChange={(v) => set("notifyRound", v)}
                  >
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                      Round updates
                    </Switch.Content>
                  </Switch>
                  <span className="text-[11px] leading-4 text-muted">
                    Pool, eligible holders and countdown every{" "}
                    {draft.intervalMinutes || "N"} min.
                  </span>
                </div>

                <div className="flex flex-col gap-1 rounded-lg border border-(--border) px-3 py-2.5">
                  <Switch
                    size="sm"
                    isSelected={draft.notifyDraw}
                    onChange={(v) => set("notifyDraw", v)}
                  >
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                      Draw results
                    </Switch.Content>
                  </Switch>
                  <span className="text-[11px] leading-4 text-muted">
                    Winners and payouts the moment a round completes.
                  </span>
                </div>
              </div>
            </section>

            <section className="flex flex-col gap-3 border-t border-(--border) pt-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <p className="text-sm font-semibold">Message templates</p>
                <span className="text-[11px] leading-4 text-muted">
                  The exact text of both posts — placeholders fill in live values.
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  className="ml-auto"
                  onPress={previewEdits}
                  isPending={busy === "preview"}
                >
                  Preview edits
                </Button>
              </div>

              <TemplateField
                label="Current round post"
                value={draft.roundTemplate}
                error={errors.roundTemplate}
                placeholders={ROUND_PLACEHOLDER_HELP}
                onChange={(v) => set("roundTemplate", v)}
                onReset={() => set("roundTemplate", DEFAULT_ROUND_TEMPLATE)}
              />
              <TemplateField
                label="Draw announcement"
                value={draft.drawTemplate}
                error={errors.drawTemplate}
                placeholders={DRAW_PLACEHOLDER_HELP}
                onChange={(v) => set("drawTemplate", v)}
                onReset={() => set("drawTemplate", DEFAULT_DRAW_TEMPLATE)}
              />

              {templatesDirty ? (
                <p className="text-[11px] leading-4 text-warning">
                  Template edits are unsaved — the group keeps receiving the saved
                  version until you press Save settings.
                </p>
              ) : null}
            </section>

            <div className="flex flex-wrap items-center gap-2 border-t border-(--border) pt-4">
              <Button
                variant="primary"
                onPress={() => save()}
                isPending={busy === "save"}
              >
                Save settings
              </Button>
              <Button
                variant="secondary"
                onPress={() => run("test")}
                isPending={busy === "test"}
              >
                Send test
              </Button>
              <Button
                variant="secondary"
                onPress={() => run("round")}
                isPending={busy === "round"}
              >
                Post round now
              </Button>
              <Button
                variant="secondary"
                onPress={() => run("lastDraw")}
                isPending={busy === "lastDraw"}
              >
                Resend last draw
              </Button>
              <Button
                variant="ghost"
                onPress={() => run("chats")}
                isPending={busy === "chats"}
              >
                Find chat id
              </Button>
              {src === "db" ? (
                <Button
                  variant="danger-soft"
                  className="ml-auto"
                  onPress={() => save({ clearToken: true }, "clear")}
                  isPending={busy === "clear"}
                >
                  Remove saved token
                </Button>
              ) : null}
            </div>

            {notice ? (
              <p
                className={
                  notice.kind === "ok"
                    ? "text-success text-small"
                    : "text-danger text-small"
                }
              >
                {notice.text}
              </p>
            ) : null}

            {data && !data.lotteryEnabled ? (
              <p className="text-[11px] leading-4 text-muted">
                Automatic draws are paused because LOTTERY_CRON_ENABLED is not
                true (development). Round posts say so instead of showing a
                countdown — enable it, or run in production, for live schedules.
              </p>
            ) : null}

            {data && !data.siteUrl ? (
              <p className="text-[11px] leading-4 text-muted">
                No site URL is configured, so messages go out without links. Set
                one in SEO &amp; Analytics → Site URL.
              </p>
            ) : null}

            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <p className="text-sm font-semibold">Message preview</p>
                <span className="text-[11px] leading-4 text-muted">
                  Exactly what the group will read.
                </span>
                {livePreview ? (
                  <Chip size="sm" color="warning" variant="soft">
                    unsaved edits
                  </Chip>
                ) : null}
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted">
                    Current round · every {draft.intervalMinutes || "N"} min
                  </span>
                  {preview?.round ? (
                    <pre className="rounded-md bg-default px-3 py-2.5 font-mono text-xs whitespace-pre-wrap break-words">
                      {preview.round}
                    </pre>
                  ) : (
                    <p className="text-small text-muted">
                      {preview?.roundError ?? "Loading preview…"}
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted">
                    After a draw
                  </span>
                  <pre className="rounded-md bg-default px-3 py-2.5 font-mono text-xs whitespace-pre-wrap break-words">
                    {preview?.draw ?? "Loading preview…"}
                  </pre>
                </div>
              </div>
            </section>

            <section className="flex flex-col gap-1.5 border-t border-(--border) pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold">Recent activity</p>
                <span className="text-[11px] leading-4 text-muted">
                  since server boot
                </span>
                <span className="ml-auto text-[11px] leading-4 text-muted">
                  last draw attempt:{" "}
                  {fmtTime(data?.state.lastDrawAttemptAt ?? null)}
                </span>
              </div>
              {!data || data.history.length === 0 ? (
                <p className="text-small text-muted">
                  Nothing sent yet. Use “Send test” to confirm the bot can reach
                  the group.
                </p>
              ) : (
                <div className="flex flex-col gap-1 max-h-56 overflow-auto font-mono text-xs">
                  {data.history.map((entry, i) => (
                    <div key={`${entry.ts}-${i}`} className="flex gap-2">
                      <span className="text-muted shrink-0">
                        {fmtTime(entry.ts)}
                      </span>
                      <span
                        className={
                          entry.level === "error"
                            ? "text-danger break-all"
                            : entry.level === "warn"
                            ? "text-warning break-all"
                            : "break-all"
                        }
                      >
                        {entry.message}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );




}

