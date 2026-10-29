"use client";

import { useState } from "react";

/**
 * Brand mark shown in the sidebar header (home has its own sidebar, every other
 * route uses AppShell, so both render this).
 *
 * The logo is a plain file in /public — drop it in as `drawfi_logo.png` and it
 * appears on the next load; no import, no build step. Until that file exists
 * (or if it is renamed), `onError` falls back to the old tinted initial so the
 * header never shows a broken-image glyph. Change the extension here if the
 * upload is a .svg / .webp instead.
 */
const BRAND_LOGO_SRC = "/drawfi_logo.png";

export function BrandMark({
  brandName,
  className = "h-7 w-7",
}: {
  brandName: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const initial = brandName.trim().charAt(0).toUpperCase() || "P";

  if (failed) {
    return (
      <span
        className={`flex shrink-0 items-center justify-center rounded-md bg-accent/15 text-sm font-bold text-accent ${className}`}
        aria-hidden="true"
      >
        {initial}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={BRAND_LOGO_SRC}
      alt=""
      aria-hidden="true"
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-md object-contain ${className}`}
    />
  );
}
