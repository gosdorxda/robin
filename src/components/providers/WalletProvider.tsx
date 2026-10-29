"use client";

import { Buffer } from "buffer";
import { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { clusterApiUrl } from "@solana/web3.js";

import "@solana/wallet-adapter-react-ui/styles.css";

// Buffer polyfill required by @solana/web3.js + wallet adapter in the browser.
if (typeof window !== "undefined") {
  const w = window as unknown as { Buffer?: typeof Buffer };
  w.Buffer = w.Buffer || Buffer;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
    if (url && url.trim().length > 0) return url;
    return clusterApiUrl("mainnet-beta");
  }, []);

  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
