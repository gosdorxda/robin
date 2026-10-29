import { WalletProvider } from "@/components/providers/WalletProvider";

/**
 * Layout for the `(wallet)` route group.
 *
 * Wraps children in the Solana wallet-adapter stack (ConnectionProvider +
 * WalletProvider + WalletModalProvider). Pages that need wallet connection
 * (e.g. a public dashboard where users connect Phantom) live under this group.
 *
 * Route groups in parentheses do not affect the URL path, so
 * `src/app/(wallet)/dashboard/page.tsx` is still served at `/dashboard`.
 *
 * Keeping the wallet stack scoped here — instead of in the root layout — means
 * routes OUTSIDE this group (notably `/admin`) do not bundle @solana/web3.js /
 * wallet adapters and therefore compile & load fast in `next dev`.
 */
export default function WalletLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <WalletProvider>{children}</WalletProvider>;
}