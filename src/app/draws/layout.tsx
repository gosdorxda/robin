import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Draws",
  description:
    "Every completed draw in one place — winners, prize pool, and the drand randomness that picked them.",
};

export default function DrawsLayout({ children }: { children: ReactNode }) {
  return children;
}
