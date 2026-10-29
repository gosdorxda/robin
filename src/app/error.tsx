"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary (App Router `error.js` convention).
 *
 * Why it exists: on the VPS a page occasionally showed Next's built-in
 * "This page couldn't load" screen while `pm2 logs` stayed clean — i.e. the error
 * happened in the browser, not on the server. Production builds hide the actual
 * message, which left nothing to diagnose. This boundary keeps the same safety
 * net but prints the message + digest, logs the error object to the console, and
 * distinguishes the two realistic causes:
 *
 *  - a stale chunk after a deploy (browser holding HTML from the previous build);
 *  - a render-time exception in a client component.
 *
 * `reset()` re-renders the segment; `window.location.reload()` refetches the
 * build (the fix for the first case).
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[route-error]", error);
  }, [error]);

  const message = error?.message || "Unknown error";
  const staleChunk =
    /chunk|dynamically imported|loading css|failed to fetch|importing a module/i.test(
      message
    );

  return (
    <div className="mx-auto flex max-w-xl flex-col items-start gap-3 px-4 py-16">
      <h1 className="text-lg font-semibold tracking-tight">This page hit an error</h1>
      <p className="text-sm text-muted">
        {staleChunk
          ? "The browser is still holding files from a previous version of the site — a deploy replaced them. Reload to pick up the new build; the rest of the site is fine."
          : "Something on this page failed while rendering. The rest of the site still works."}
      </p>
      <p className="w-full break-words rounded-md bg-default px-2.5 py-1.5 font-mono text-xs text-foreground">
        {message}
        {error?.digest ? ` · digest ${error.digest}` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground transition hover:opacity-90"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md border border-(--border) px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-default/40"
        >
          Reload
        </button>
      </div>
      <p className="text-xs text-muted">
        Still failing? Send the message above together with the browser console output.
      </p>
    </div>
  );
}
