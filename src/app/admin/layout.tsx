import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * The admin panel is a client-side dashboard; this layout only supplies its
 * title and keeps it out of search results regardless of the site-wide
 * indexing setting.
 */
export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return children;
}
