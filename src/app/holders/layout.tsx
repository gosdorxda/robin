import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getTokenName } from "@/lib/seo";

export async function generateMetadata(): Promise<Metadata> {
  const token = await getTokenName();
  return {
    title: "Holders",
    description: `Every wallet holding ${token}, its balance, and whether it qualifies for the next draw.`,
  };
}

export default function HoldersLayout({ children }: { children: ReactNode }) {
  return children;
}
