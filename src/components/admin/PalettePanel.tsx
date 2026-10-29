"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  Separator,
} from "@heroui/react";
import {
  diffPalette,
  paletteCss,
  type Palette,
} from "@/lib/palette-css";

/**
 * Admin → Palette.
 *
 * Edits the HeroUI semantic color tokens that drive the whole UI (they live in
 * `src/app/globals.css`). Saved overrides go through `/api/admin/palette` into
 * the `AdminSetting` key/value table and are injected by the root layout as a
 * `<style>` block — no rebuild, no migration. "Reset" just deletes the row, so
 * globals.css always remains the source of truth.
 *
 * Edits preview instantly: a `<style id="palette-preview">` element is appended
 * to <body> (after the server-injected `#theme-palette`) and removed when the
 * panel unmounts, so leaving /admin never leaves stale colors behind.
 */

type Mode = "light" | "dark";

type TokenInfo = {
  token: string;
  label: string;
  hint: string;
  group: string;
  light: string;
  dark: string;
};

type PaletteResponse = {
  palette?: Palette;
  defaults?: Palette;
  tokens?: TokenInfo[];
  groups?: string[];
  error?: string;
};

const EMPTY: Palette = { light: {}, dark: {} };
const MODES: { mode: Mode; label: string; hint: string }[] = [
  {
    mode: "light",
    label: "Light theme",
    hint: "Used when the theme toggle is on light.",
  },
  {
    mode: "dark",
    label: "Dark theme",
    hint: "Used when the theme toggle is on dark (the project default).",
  },
];

/** Order-independent fingerprint of a set of overrides. */
function signature(palette: Palette): string {
  const sort = (values: Record<string, string>) =>
    JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
  return `${sort(palette.light)}|${sort(palette.dark)}`;
}

/** Total overridden colors across both themes. */
function countAll(palette: Palette): number {
  return Object.keys(palette.light).length + Object.keys(palette.dark).length;
}

/**
 * Hex text field with its own buffer: you can type a partial value (e.g. `#0f`)
 * without fighting the picker. Commits on valid 6-digit hex, reverts on blur.
 */
function HexField({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (hex: string) => void;
}) {
  const [text, setText] = useState(value);

  useEffect(() => {
    setText(value);
  }, [value]);

  return (
    <input
      type="text"
      aria-label="Hex color"
      spellCheck={false}
      value={text}
      onChange={(e) => {
        const next = e.target.value.trim();
        setText(next);
        if (/^#[0-9a-fA-F]{6}$/.test(next)) onCommit(next.toLowerCase());
      }}
      onBlur={() => {
        if (!/^#[0-9a-fA-F]{6}$/.test(text.trim())) setText(value);
      }}
      className="w-24 rounded-md border border-(--border) bg-field-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-(--focus)"
    />
  );
}

export function PalettePanel() {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const [defaults, setDefaults] = useState<Palette>(EMPTY);
  const [saved, setSaved] = useState<Palette>(EMPTY);
  const [draft, setDraft] = useState<Palette>(EMPTY);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [notice, setNotice] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/palette", { cache: "no-store" });
      const data = (await r.json()) as PaletteResponse;
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      const palette = data.palette ?? EMPTY;
      if (data.tokens) setTokens(data.tokens);
      if (data.groups) setGroups(data.groups);
      if (data.defaults) setDefaults(data.defaults);
      setSaved(palette);
      setDraft(palette);
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

  /* Live preview — mirrors exactly what the layout will inject once saved. */
  useEffect(() => {
    if (loading) return;
    /*
     * Emit the *complete* palette (draft over defaults), never just the sparse
     * overrides: a per-row reset deletes a key, and on a statically cached page
     * `#theme-palette` can still hold the previous saved value for that token.
     * A full block here wins on every token, so the page always shows the
     * effective palette — saved or drafted.
     */
    const full: Palette = {
      light: { ...defaults.light, ...draft.light },
      dark: { ...defaults.dark, ...draft.dark },
    };
    let el = document.getElementById("palette-preview") as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = "palette-preview";
      document.body.appendChild(el);
    }
    el.textContent = paletteCss(full);
  }, [draft, defaults, loading]);

  useEffect(
    () => () => {
      document.getElementById("palette-preview")?.remove();
    },
    []
  );

  const overrides = useMemo(() => diffPalette(draft, defaults), [draft, defaults]);
  const savedOverrides = useMemo(
    () => diffPalette(saved, defaults),
    [saved, defaults]
  );
  const changed = countAll(overrides);
  const dirty = signature(overrides) !== signature(savedOverrides);
  const hasSaved = countAll(savedOverrides) > 0;

  const setColor = (mode: Mode, token: string, hex: string) =>
    setDraft((d) => ({ ...d, [mode]: { ...d[mode], [token]: hex } }));

  const resetToken = (mode: Mode, token: string) =>
    setDraft((d) => {
      const next = { ...d[mode] };
      delete next[token];
      return { ...d, [mode]: next };
    });

  async function save() {
    setSaving(true);
    setNotice(null);
    try {
      const r = await fetch("/api/admin/palette", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ palette: overrides }),
      });
      const data = (await r.json()) as PaletteResponse & { overridden?: number };
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      const palette = data.palette ?? draft;
      setSaved(palette);
      setDraft(palette);
      setNotice({
        kind: "ok",
        text:
          (data.overridden ?? 0) > 0
            ? `Palette saved — ${data.overridden} color override${
                data.overridden === 1 ? "" : "s"
              } live site-wide.`
            : "Palette saved — everything is back on the default colors.",
      });
      /*
       * No router.refresh() here: on this statically cached page it re-renders
       * the whole route, which clears the notice and drops the panel state.
       * The API already called revalidatePath, so every other route is fresh on
       * its next request; on this page the preview block (full palette) is what
       * the admin sees.
       */
    } catch (e) {
      setNotice({ kind: "err", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function resetAll() {
    if (!window.confirm("Delete every saved color override and go back to the built-in palette?")) {
      return;
    }
    setResetting(true);
    setNotice(null);
    try {
      const r = await fetch("/api/admin/palette", { method: "DELETE" });
      const data = (await r.json()) as PaletteResponse;
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      const palette = data.palette ?? defaults;
      setSaved(palette);
      setDraft(palette);
      setNotice({ kind: "ok", text: "Reset to the built-in palette." });
    } catch (e) {
      setNotice({ kind: "err", text: (e as Error).message });
    } finally {
      setResetting(false);
    }
  }

  const q = query.trim().toLowerCase();
  const visible = q
    ? tokens.filter((t) =>
        `${t.token} ${t.label} ${t.hint} ${t.group}`.toLowerCase().includes(q)
      )
    : tokens;


  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-2">
        <p className="font-bold">Palette</p>
        {dirty ? (
          <Chip size="sm" variant="soft" color="warning">
            Unsaved changes
          </Chip>
        ) : null}
        <span className="ml-auto text-xs text-muted">
          Every color token in the UI, light and dark
        </span>
        <Button
          size="sm"
          variant="ghost"
          onPress={load}
          isDisabled={loading || saving || resetting}
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
          <p className="text-sm text-muted">Loading palette…</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-(--border) bg-surface-secondary px-3 py-2">
              <Chip
                size="sm"
                variant="soft"
                color={changed > 0 ? "warning" : "success"}
              >
                {changed > 0
                  ? `${changed} override${changed === 1 ? "" : "s"}`
                  : "All defaults"}
              </Chip>
              <p className="min-w-0 flex-1 text-xs text-muted">
                Edits preview instantly on this page. Press{" "}
                <span className="font-medium text-foreground">Save palette</span>{" "}
                to publish them site-wide, or reset a single row to drop its
                override. Defaults come from <code>globals.css</code> — nothing
                here edits that file.
              </p>
            </div>

            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a token, e.g. accent, surface, muted…"
              className="w-full rounded-lg border border-(--border) bg-field-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-(--field-placeholder) focus:border-(--focus)"
            />


            {MODES.map(({ mode, label, hint }) => {
              const modeChanged = Object.keys(overrides[mode]).length;
              return (
                <section key={mode} className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                      {label}
                    </h3>
                    {modeChanged > 0 ? (
                      <Chip size="sm" variant="soft" color="warning">
                        {modeChanged} changed
                      </Chip>
                    ) : null}
                    <span className="text-xs text-muted">{hint}</span>
                  </div>

                  {groups.map((group) => {
                    const rows = visible.filter((t) => t.group === group);
                    if (rows.length === 0) return null;
                    return (
                      <div key={group} className="flex flex-col gap-2">
                        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                          {group}
                        </h4>
                        <div className="grid gap-2 xl:grid-cols-2">
                          {rows.map((t) => (
                            <PaletteRow
                              key={`${mode}-${t.token}`}
                              info={t}
                              mode={mode}
                              value={draft[mode][t.token] ?? t[mode]}
                              changed={Boolean(overrides[mode][t.token])}
                              onChange={(hex) => setColor(mode, t.token, hex)}
                              onReset={() => resetToken(mode, t.token)}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </section>
              );
            })}

            {visible.length === 0 ? (
              <p className="text-sm text-muted">
                No token matches “{query}”. Clear the search to see all{" "}
                {tokens.length} colors.
              </p>
            ) : null}


            <div className="flex flex-wrap items-center gap-2 border-t border-(--border) pt-4">
              <span className="text-xs text-muted">
                {dirty
                  ? "Unsaved changes — the preview shows them, other visitors still see the saved palette."
                  : hasSaved
                    ? "Saved. Overrides are served from the database on every page."
                    : "No overrides: the site uses the built-in palette."}
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => setDraft(saved)}
                  isDisabled={!dirty || saving || resetting}
                >
                  Discard changes
                </Button>
                <Button
                  size="sm"
                  variant="danger-soft"
                  onPress={resetAll}
                  isPending={resetting}
                  isDisabled={saving || !hasSaved}
                >
                  Reset to defaults
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onPress={save}
                  isPending={saving}
                  isDisabled={resetting || !dirty}
                >
                  Save palette
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** One token row: swatch, name + usage hint, hex field, per-row reset. */
function PaletteRow({
  info,
  mode,
  value,
  changed,
  onChange,
  onReset,
}: {
  info: TokenInfo;
  mode: Mode;
  value: string;
  changed: boolean;
  onChange: (hex: string) => void;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-(--border) bg-surface-secondary/60 px-3 py-2">
      <input
        type="color"
        aria-label={`${info.label} (${mode})`}
        className="palette-swatch shrink-0"
        value={value}
        onChange={(e) => onChange(e.target.value.toLowerCase())}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {info.label}
          </span>
          <code className="rounded-md bg-default px-1.5 py-0.5 font-mono text-[11px] text-muted">
            --{info.token}
          </code>
          {changed ? (
            <Chip size="sm" variant="soft" color="warning">
              changed
            </Chip>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs text-muted">{info.hint}</p>
      </div>
      <div className="flex items-center gap-1.5">
        <HexField value={value} onCommit={onChange} />
        <Button
          size="sm"
          variant="ghost"
          onPress={onReset}
          isDisabled={!changed}
          aria-label={`Reset ${info.label} to its default`}
        >
          Reset
        </Button>
      </div>
    </div>
  );
}

