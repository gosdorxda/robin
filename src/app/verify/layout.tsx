import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Verify",
  description:
    "Check a draw in your browser: the saved random number must match the one drand published, and re-running the shuffle must produce the same winners.",
};

export default function VerifyLayout({ children }: { children: ReactNode }) {
  return children;
}
