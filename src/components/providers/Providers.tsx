"use client";

/**
 * Root-level client providers.
 *
 * HeroUI v3 needs no React provider wrapper — styling is driven entirely by
 * CSS custom properties (see globals.css) and overlay/portal state is managed
 * automatically via React Aria's internal context. So this component is now a
 * simple pass-through.
 *
 * The Solana wallet-adapter stack (@solana/web3.js + wallet adapters) is heavy;
 * mounting it at the root would force EVERY route to bundle it. Wallet
 * connection is scoped to the `(wallet)` route group instead — see
 * `src/app/(wallet)/layout.tsx`, which wraps its children in <WalletProvider />.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
