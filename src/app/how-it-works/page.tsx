"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Chip, Typography } from "@heroui/react";
import { AppShell } from "@/components/AppShell";
import { ExternalLink, Icon } from "@/components/ui";
import { useSite } from "@/components/providers/SiteProvider";
// Chain-aware unit + payout shape ("SOL"/one tx on Solana, "ETH"/one tx per
// winner on Robinhood Chain) and the launchpad the fees come from.
import { CHAIN_KIND, FEE_SOURCE_TITLE, NATIVE_SYMBOL } from "@/lib/chain/network";

/**
 * Canonical transparency reference for the holder lottery. Consolidates the
 * draw lifecycle, the provably-fair verification story, eligibility, payouts,
 * the run schedule, and a FAQ, all grounded in the actual mechanics in
 * lib/lottery/engine.ts, lib/lottery/verify.ts, and lib/solana/randomness.ts.
 *
 * The drand quicknet chain hash below is the public beacon identifier; the same
 * value is exported from lib/solana/randomness.ts (DRAND_CHAIN_HASH). Kept inline
 * here so this static page pulls no server-only module into the client bundle.
 */
const DRAND_CHAIN_URL =
  "https://drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";

export default function HowItWorksPage() {
  const { tokenName } = useSite();
  return (
    <AppShell title="How it works">
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-10 pt-8 sm:pt-10 pb-12">
        <div className="max-w-3xl flex flex-col">
        {/* Header */}
        <header className="pb-8 border-b border-(--border)">
          <Typography type="h4">How draws work</Typography>
          <Typography type="body-sm" color="muted" className="mt-1.5">
            Hold at least the minimum {tokenName} and you are on the list for every draw, with
            no tickets and no sign-up. Creator fees from {FEE_SOURCE_TITLE} fill the prize pool,
            and the winners are picked by drand, a public randomness beacon run by independent
            organisations. Anyone can check a finished draw in their own browser.
          </Typography>
          <div className="flex flex-wrap gap-2 mt-4">
            <Chip variant="soft" color="default">Holding is the entry</Chip>
            <Chip variant="soft" color="default">Random draw</Chip>
            <Chip variant="soft" color="default">Paid in {NATIVE_SYMBOL}</Chip>
            <Chip variant="soft" color="default">Publicly checkable</Chip>
          </div>
        </header>

        {/* Draw lifecycle */}
        <Section title="From holder list to payout">
          <ol className="flex flex-col gap-5">
            <Step n={1} title="The holder list refreshes">
              Every 5 minutes, by default, the app re-reads {tokenName} balances on Solana. Every
              wallet holding at least the minimum {tokenName} goes on the list. The project
              wallet, the bonding curve, the pool authority and any blocked addresses are left
              out. That list is what the draw picks from.
            </Step>
            <Step n={2} title="The draw asks drand for a number">
              On the draw schedule (hourly by default) the app fetches the newest number from
              drand. It also asks a second drand server for the same round, and refuses to use
              the number if the two disagree.
            </Step>
            <Step n={3} title="That number shuffles the list">
              The number seeds a deterministic shuffle of the holder list, like a deck of
              cards. The list is sorted by address first, so every run starts from the same
              order, and the first wallets after the shuffle win, in rank order. The same
              number and the same list always give the same winners.
            </Step>
            <Step n={4} title="The prize is split by rank">
              The pool is divided by a fixed split that adds up to 100%: 50 / 30 / 20 by
              default, for three winners. Leftover rounding dust goes to first place, and so do
              the shares of winner slots the draw could not fill. A platform fee, if enabled,
              comes off the top first (see Where the money goes).
            </Step>
            <Step n={5} title={`Winners are paid in ${NATIVE_SYMBOL}`}>
              {CHAIN_KIND === "solana"
                ? "All winners are paid in one Solana transaction: a transfer per winner, sent together from the project wallet. The transaction signature is saved on the draw and shown next to each winner, so any payment can be looked up on Solana"
                : `Each winner is paid with its own transfer from the project wallet. Every transaction hash is saved on the draw and shown next to the winner, so any payment can be looked up on the explorer`}
              Explorer. A winner shows{" "}
              <Chip size="sm" variant="soft" color="warning">Pending</Chip>{" "}
              → <Chip size="sm" variant="soft" color="success">Paid</Chip>{" "}
              once the transfer confirms.
            </Step>
          </ol>
        </Section>

        {/* Provably fair */}
        <Section title="You can check a finished draw yourself">
          <p className="text-sm text-muted leading-relaxed">
            Two checks run in your browser. The first asks only drand; the second re-runs the
            shuffle on the wallet list saved with the draw.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-2">
            <Card title="① The random number is real">
              Your browser fetches that same drand round and confirms the number and its
              signature are exactly what drand published, so the number we saved cannot have
              been swapped after the fact.
            </Card>
            <Card title="② The winners really came from it">
              The same number and the same holder list are shuffled again in your browser.
              If the wallets come out in the same order, rank for rank, the winners follow
              from those two inputs.
            </Card>
          </div>

          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-4 border-t border-(--border) pt-6 mt-6">
            <Fact label="Beacon" value="quicknet" />
            <Fact label="Signature scheme" value="BLS unchained G1" hint="RFC 9380" />
            <Fact label="New number" value="every 3s" />
            <Fact label="Sources" value="drand.sh · cloudflare" />
          </dl>

          <div className="flex flex-wrap gap-x-5 gap-y-2 pt-5">
            <NavLink href="/verify">Open the verify tool</NavLink>
            <ExternalLink href={DRAND_CHAIN_URL} className="text-sm">
              drand beacon API
            </ExternalLink>
          </div>
        </Section>

        {/* Eligibility */}
        <Section title={`Hold ${tokenName}. That’s the whole entry.`}>
          <p className="text-sm text-muted leading-relaxed">
            No ticket to buy and nothing to sign. If your wallet holds at least the minimum{" "}
            {tokenName} in the snapshot a draw uses, you are in, once per draw, with the same
            chance as every other wallet on the list. Holding more does not improve the odds:
            one wallet is one entry. The list refreshes every 5 minutes, so a buy may take up to
            five minutes to count.
          </p>
          <div className="pt-4">
            <NavLink href="/eligibility">Check your wallet</NavLink>
          </div>
        </Section>

        {/* Payouts */}
        <Section title="Where the money goes">
          <p className="text-sm text-muted leading-relaxed">
            The pool is the {NATIVE_SYMBOL} in the project wallet, mostly creator fees that {FEE_SOURCE_TITLE} pays on{" "}
            {tokenName} trading. A small reserve (about 0.05&nbsp;{NATIVE_SYMBOL}) stays behind for network
            fees, and by default everything above it is paid out. If the pool is at or below
            that reserve, or below a minimum prize when one is set, the draw is skipped instead
            of run.
          </p>
          <p className="text-sm text-muted leading-relaxed">
            A platform fee is off by default (0%). If one is switched on, it is taken from
            the pool <em>before</em> the split.{" "}
            {CHAIN_KIND === "solana"
              ? "When a treasury wallet is configured, the fee leaves in the same transaction as the payouts; without one, it stays on the project wallet."
              : "On this chain the fee stays on the project wallet — payouts are not swept to a separate treasury yet."}{" "}
            The fee changes how much is split, never who wins.
          </p>
          <p className="text-sm text-muted leading-relaxed">
            {CHAIN_KIND === "solana"
              ? "All payouts for a draw leave in one transaction. If that transaction fails, nothing moves on-chain: no winner is recorded and the draw is marked failed."
              : "Each winner is paid with its own transfer. If a transfer fails the draw is marked failed and that winner is not recorded as paid — the saved transaction hashes are on the draw page."}{" "}
            The next draw starts from a clean slate.
          </p>
        </Section>

        {/* Schedule */}
        <Section title="How often things run">
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Fact label="Draws" value="Hourly" hint="top of the hour, by default" />
            <Fact label="Holder list" value="Every 5 min" hint="by default, refreshes who is eligible" />
            <Fact label="drand" value="Every 3 s" hint="a new number is always ready" />
          </dl>
          <p className="text-sm text-muted pt-4">
            Both schedules are configurable. The home page shows a countdown to the next draw.
          </p>
        </Section>

        {/* FAQ */}
        <Section title="Common questions">
          <div className="flex flex-col divide-y divide-(--border) border-y border-(--border)">
            <Faq q="Do I need to register or buy a ticket?">
              No. Hold at least the minimum {tokenName} and your wallet is on the list for the
              next draw automatically. Check your wallet on the{" "}
              <Link
                href="/eligibility"
                className="text-foreground underline decoration-(--border) underline-offset-4 transition-colors hover:decoration-(--muted)"
              >
                Eligibility
              </Link>{" "}
              page.
            </Faq>
            <Faq q="Can the team choose who wins?">
              Not by picking them. Winners are the first wallets after a deterministic shuffle
              of the eligible list by the drand number. The team can leave non-player accounts
              out of that list, such as the bonding curve and the pool authority, but the filter
              runs before the shuffle and the exact list is saved with the draw, so anyone can
              re-run it.
            </Faq>
            <Faq q="What stops the randomness from being rigged?">
              The number comes from drand, which is run by independent organisations and signs
              every value it publishes. The app also asks a second drand server for the same
              round and abandons the draw if the two disagree. The signature stays checkable
              forever, so the number can be confirmed afterwards.
            </Faq>
            <Faq q="When exactly am I entered?">
              At draw time, from the newest holder snapshot. That snapshot is at most five
              minutes old, so a buy made just before a draw may only count for the next one.
            </Faq>
            <Faq q="How are prizes paid?">
              In {NATIVE_SYMBOL}, sent straight to each winner’s wallet.{" "}
              {CHAIN_KIND === "solana"
                ? "All winners in a draw are paid in the same transaction, whose signature is saved and linked to Solana Explorer."
                : "Each winner gets its own transfer; every transaction hash is saved on the draw and linked to the block explorer."}{" "}
              A winner shows{" "}
              <Chip size="sm" variant="soft" color="warning">Pending</Chip> →{" "}
              <Chip size="sm" variant="soft" color="success">Paid</Chip>{" "}
              once the transfer confirms.
            </Faq>
            <Faq q="Is there a platform fee?">
              By default, no. If one is enabled it comes out of the pool before the split. With
              a treasury wallet configured it is sent there in the payout transaction; without
              one it stays on the project wallet.
            </Faq>
            <Faq q="How many winners per draw, and how is the prize split?">
              Three by default, ranked 1 to 3, on a 50 / 30 / 20 split. The split is fixed and
              adds up to 100%. If a draw has fewer eligible wallets than winner slots, only
              those wallets are paid, and the unclaimed shares roll into first place along with
              any rounding remainder.
            </Faq>
            <Faq q="Which network does this run on?">
              Solana mainnet, or devnet for a test deployment. Explorer links follow whichever
              network the deployment is on.
            </Faq>
          </div>
        </Section>

        {/* CTA: view draws */}
        <section className="pt-8">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <p className="text-sm text-muted">
              Want to see it in action? Every finished draw is on the Draws page, with its
              winners or the reason it was skipped.
            </p>
            <Link
              href="/draws"
              className="inline-flex items-center gap-1.5 rounded-lg bg-(--button) px-5 py-2.5 text-sm font-semibold text-(--button-foreground) transition hover:bg-(--button-hover) shrink-0"
            >
              View draws →
            </Link>
          </div>
        </section>
        </div>
      </main>
    </AppShell>
  );
}

/* ── small presentational helpers ────────────────────────────────────────── */

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 border-b border-(--border) py-8">
      <Typography type="h5">{title}</Typography>
      {children}
    </section>
  );
}

/** In-app action link: the quiet muted + arrow recipe of `ExternalLink`, no new tab. */
function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 text-sm text-muted underline decoration-(--border) underline-offset-4 transition-colors hover:text-foreground hover:decoration-(--muted)"
    >
      {children}
      <Icon name="arrow-up-right" className="h-3.5 w-3.5 opacity-50" />
    </Link>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="shrink-0 mt-0.5 size-7 rounded-full bg-accent/10 text-accent flex items-center justify-center text-xs font-bold ring-1 ring-accent/20">
        {n}
      </span>
      <div className="flex flex-col gap-1 min-w-0">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-sm text-muted leading-relaxed">{children}</p>
      </div>
    </li>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-(--border) bg-surface p-5 flex flex-col gap-2">
      <p className="text-sm font-semibold">{title}</p>
      <p className="text-sm text-muted leading-relaxed">{children}</p>
    </div>
  );
}

function Fact({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-mono uppercase text-muted">{label}</dt>
      <dd className="text-sm font-mono font-semibold">{value}</dd>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}

function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className="group py-4">
      <summary className="flex items-center justify-between gap-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <span className="text-sm font-semibold">{q}</span>
        <Icon
          name="expand"
          className="h-4 w-4 text-muted transition group-open:rotate-90"
        />
      </summary>
      <div className="mt-2 text-sm text-muted leading-relaxed">
        {children}
      </div>
    </details>
  );
}
