import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getTokenName } from "@/lib/seo";

export async function generateMetadata(): Promise<Metadata> {
  const token = await getTokenName();
  return {
    title: "How it works",
    description: `Hold ${token} and you are on the list for every draw. Creator fees fill the pool, three wallets are picked by drand, and any finished draw can be checked.`,
  };
}

export default function HowItWorksLayout({ children }: { children: ReactNode }) {
  return children;
}