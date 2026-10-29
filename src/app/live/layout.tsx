import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Live",
  description:
    "Watch the next draw approach in real time — live prize pool, eligible holder count, and draw execution status.",
};

export default function LiveLayout({ children }: { children: ReactNode }) {
  return children;
}
