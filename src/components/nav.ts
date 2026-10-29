/**
 * Shared sidebar navigation — single source of truth consumed by both the
 * homepage (src/app/page.tsx) and AppShell (src/components/AppShell.tsx), so
 * adding a route only needs an edit here. Icon names map to the Icon set in
 * components/ui.tsx.
 */
export type NavItem = { label: string; href: string; icon: string };

export const NAV: NavItem[] = [
  { label: "Home", href: "/", icon: "home" },
  { label: "Draws", href: "/draws", icon: "draws" },
  { label: "Eligibility", href: "/eligibility", icon: "user-check" },
  { label: "Treasury", href: "/treasury", icon: "wallet-minimal" },
  { label: "Stats", href: "/stats", icon: "chart-line" },
  { label: "Verify", href: "/verify", icon: "check" },
  { label: "How it works", href: "/how-it-works", icon: "circle-question-mark" },
];

/**
 * Active-link test shared by both sidebars (the homepage renders its own copy of
 * the shell), so the two can never disagree about which row is highlighted.
 * Sub-routes light up their parent: `/rounds/37` is opened from the draws list,
 * so it keeps "Draws" active instead of leaving the sidebar with nothing lit.
 */
export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (pathname === href || pathname.startsWith(href + "/")) return true;
  if (href === "/draws" && pathname.startsWith("/rounds/")) return true;
  return false;
}

/**
 * External community links — rendered under the "Social media" heading pinned to
 * the bottom of the sidebar (same grouping otcdesks.cash uses for Docs / Terms /
 * X, minus the docs and terms pages this project doesn't have yet). Both entries
 * open in a new tab.
 *
 * Only the LABEL and ICON come from here: the URLs are admin-editable
 * (Admin → SEO → X link / Telegram link) and `page.tsx` + `AppShell.tsx` map
 * `icon === "x" | "telegram"` to `useSite().social`, dropping any entry whose URL
 * is empty. The `href` values below are therefore inert defaults — editing them
 * changes nothing, edit the admin fields instead.
 */
export const INFORMATION: NavItem[] = [
  { label: "X", href: "https://x.com/", icon: "x" },
  { label: "Telegram", href: "https://t.me/", icon: "telegram" },
];