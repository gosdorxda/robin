import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Treasury",
  description:
    "Platform and fee wallet balances, the fee and payout history, and the buyback & burn ledger, all live.",
};

export default function TreasuryLayout({ children }: { children: ReactNode }) {
  return children;
}
