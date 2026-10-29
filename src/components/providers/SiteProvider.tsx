"use client";

import { createContext, useContext } from "react";

/**
 * Exposes the admin-configured brand to client components (sidebar wordmark,
 * breadcrumbs, headings). Values are resolved on the server in the root layout
 * and passed down as a plain serialisable object.
 *
 * Importing `SEO_DEFAULTS` from `@/lib/seo` would pull Prisma into the client
 * bundle, so the fallback is defined locally here instead.
 */
export type SiteBrand = {
  brandName: string;
  /** Public social links (Admin → SEO). Empty string = hide the entry. */
  social: { x: string; telegram: string };
  /** Token ticker (e.g. "DrawFi") — one admin setting, read by every page. */
  tokenName: string;
  /** Versioned favicon URL injected from the admin upload; "" when unset. */
  faviconUrl: string;
  siteTitle: string;
  description: string;
};

/**
 * Mirrors `SEO_DEFAULTS` in `src/lib/seo.ts` (kept in sync by hand — see the
 * note above about not importing it into the client bundle).
 */
const FALLBACK: SiteBrand = {
  brandName: "DrawFi",
  social: { x: "", telegram: "" },
  tokenName: "DrawFi",
  faviconUrl: "",
  siteTitle: "DrawFi — verifiable holder draws",
  description:
    "DrawFi runs verifiable holder draws on Solana: creator fees fund the prize pool, drand picks the winners, and anyone can re-run the draw in a browser.",
};

const SiteContext = createContext<SiteBrand>(FALLBACK);

export function SiteProvider({
  value,
  children,
}: {
  value: SiteBrand;
  children: React.ReactNode;
}) {
  return <SiteContext.Provider value={value}>{children}</SiteContext.Provider>;
}

/** Current site branding. Safe outside the provider (returns defaults). */
export function useSite(): SiteBrand {
  return useContext(SiteContext);
}
