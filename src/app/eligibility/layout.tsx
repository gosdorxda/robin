import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getTokenName } from "@/lib/seo";

export async function generateMetadata(): Promise<Metadata> {
  const token = await getTokenName();
  return {
    title: "Eligibility",
    description: `Check whether a Solana wallet holds enough ${token} to enter the next draw.`,
  };
}

export default function EligibilityLayout({
  children,
}: {
  children: ReactNode;
}) {
  return children;
}
