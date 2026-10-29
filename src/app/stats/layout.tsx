import type { Metadata } from "next";
import type { ReactNode } from "react";
// Chain-aware display unit ("SOL" on Solana, "ETH" on Robinhood Chain).
import { NATIVE_SYMBOL } from "@/lib/chain/network";

export const metadata: Metadata = {
  title: "Stats",
  description: `Every completed draw in one place: ${NATIVE_SYMBOL} paid to winners, wallet counts, and the leaderboard.`,
};

export default function StatsLayout({ children }: { children: ReactNode }) {
  return children;
}
