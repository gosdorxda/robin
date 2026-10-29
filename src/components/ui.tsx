"use client";

import { type ReactNode, useEffect } from "react";
import { Button, Skeleton as HeroSkeleton } from "@heroui/react";
import { animate, motion, useMotionValue, useTransform } from "framer-motion";
import { useTheme } from "@/lib/use-theme";
import { ChartLine, CircleCheckBig, CircleQuestionMark, CreditCardCheck, Dices, FaceSlightlyFrowning, FaceSlightlySmiling, House, Radio, Send, ShieldCheck, UserCheck, UsersRound, WalletMinimal } from "lucide-react";

/**
 * Skeleton placeholders built on HeroUI's Skeleton so the loading animation
 * matches the rest of the UI library (theme tokens, dark mode, shimmer/pulse).
 * `Skeleton` is a sized bar; `SkeletonStat` a labelled stat-card placeholder;
 * `SkeletonRows` a stack of table-row placeholders. animationType is pinned to
 * "pulse" to keep the subtle look already shipped — switch to "shimmer" (the
 * HeroUI default) for a sweeping gradient if preferred.
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <HeroSkeleton
      animationType="pulse"
      className={`rounded-md ${className}`}
    />
  );
}

/** Stat-card placeholder: small mono label + a bar where the value will sit. */
export function SkeletonStat({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-mono uppercase text-muted">{label}</span>
      <Skeleton className="h-7 w-24" />
    </div>
  );
}

/** Stack of row placeholders for tables / winner lists while data loads. */
export function SkeletonRows({
  count = 5,
  className = "",
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div className={`flex flex-col ${className}`}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-(--border) py-3"
        >
          <Skeleton className="h-4 w-6" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="ml-auto h-4 w-20" />
        </div>
      ))}
    </div>
  );
}

/**
 * Animated count-up using framer-motion — renders 0 → target over ~0.8s.
 * Lives here (next to Skeleton/SkeletonStat) so any stats card can animate
 * numeric values the same way. Pass a `format` fn for non-integer display
 * (SOL amounts, percentages, etc.) — it receives the RAW float so you control
 * precision; the default path (no format) rounds to an integer with locale
 * grouping, which is what plain counts want.
 */
export function CountUp({
  value,
  format,
}: {
  value: number;
  format?: (n: number) => string;
}) {
  const count = useMotionValue(0);
  const display = useTransform(count, (latest) =>
    format ? format(latest) : Math.round(latest).toLocaleString("en-US"),
  );
  useEffect(() => {
    const controls = animate(count, value, { duration: 0.8, ease: "easeOut" });
    return () => controls.stop();
  }, [value, count]);
  return <motion.span>{display}</motion.span>;
}

/**
 * Inline line-icon set (no icon library needed). Shared across every page —
 * the homepage and AppShell both import Icon + ThemeToggle from here, so new
 * routes get the same sidebar/header icons without re-defining them.
 */
export function Icon({ name, className }: { name: string; className?: string }) {
  if (name === "home") {
    return <House className={className} size={18} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (name === "draws") {
    return <Dices className={className} size={18} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (name === "holders") {
    return <UsersRound className={className} size={18} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (name === "circle-check-big") {
    return <CircleCheckBig className={className} size={18} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (name === "face-slightly-smiling") {
    return <FaceSlightlySmiling className={className} size={18} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (name === "face-slightly-frowning") {
    return <FaceSlightlyFrowning className={className} size={18} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (name === "check") {
    return <ShieldCheck className={className} size={18} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (name === "chart-line") {
    return <ChartLine className={className} size={18} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (name === "wallet-minimal") {
    // Treasury is a wallet, not a bank building. Lucide's minimal outline reads
    // at 18 px next to the other route glyphs.
    return <WalletMinimal className={className} size={18} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (name === "circle-question-mark") {
    // "How it works" reads as a help entry, so it gets a question mark rather
    // than the neutral info circle it used before.
    return <CircleQuestionMark className={className} size={18} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (name === "draw") {
    return <Radio className={className} size={18} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (name === "user-check") {
    return <UserCheck className={className} size={18} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (name === "eligibility") {
    return <CreditCardCheck className={className} size={18} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (name === "telegram") {
    return <Send className={className} size={18} strokeWidth={1.8} aria-hidden="true" />;
  }
  if (name === "x") {
    // Filled X mark - the outline set has no brand glyph and a stroked cross
    // reads as a close button, so this one path opts out of the stroke style.
    return (
      <svg
        className={className}
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    );
  }
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {name === "how" ? (
        <g>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v5M12 8h.01" />
        </g>
      ) : name === "fair" ? (
        <path d="M12 3 20 6v6c0 4.4-3 7.6-8 9-5-1.4-8-4.6-8-9V6z" />
      ) : name === "admin" ? (
        <g>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" />
        </g>
      ) : name === "wallet" ? (
        <g>
          <rect x="3" y="6" width="18" height="13" rx="2" />
          <path d="M3 10h18" />
          <circle cx="16.5" cy="14" r="1.2" />
        </g>
      ) : name === "search" ? (
        <g>
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </g>
      ) : name === "arrow-left" ? (
        <path d="M19 12H5M11 18l-6-6 6-6" />
      ) : name === "arrow-right" ? (
        <path d="M5 12h14M13 6l6 6-6 6" />
      ) : name === "external" ? (
        // Legacy glyph (box + arrow, 3 paths). Kept only so old references keep
        // rendering; outbound/explorer links must use "arrow-up-right" — see
        // .clinerules and ExternalLink below.
        <g>
          <path d="M14 5h5v5" />
          <path d="M19 5l-9 9" />
          <path d="M19 13v6H5V5h6" />
        </g>
      ) : name === "arrow-up-right" ? (
        <g>
          <path d="M7 7h10v10" />
          <path d="M7 17 17 7" />
        </g>
      ) : name === "menu" ? (
        <path d="M4 7h16M4 12h16M4 17h16" />
      ) : name === "close" ? (
        <path d="M6 6l12 12M18 6L6 18" />
      ) : name === "collapse" ? (
        <path d="M15 6l-6 6 6 6" />
      ) : name === "expand" ? (
        <path d="M9 6l6 6-6 6" />
      ) : name === "bell" ? (
        <g>
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </g>
      ) : null}
    </svg>
  );
}

/**
 * Outbound link — opens a new tab and follows the homepage's Information links:
 * muted label that brightens on hover plus the same `arrow-up-right` glyph.
 * Deliberately NOT accent-colored (accent is blue in this theme) and NOT the
 * browser's default blue, so external links read as secondary navigation.
 *
 * `className` is for placement/size overrides (e.g. `self-start`, `text-sm`);
 * pass `text-foreground` when the link sits inside muted prose and must stand out.
 */
export function ExternalLink({
  href,
  children,
  tone = "muted",
  className = "",
  iconClassName = "h-3.5 w-3.5 opacity-50",
}: {
  href: string;
  children: ReactNode;
  /** "muted" for standalone links, "foreground" inside muted prose. */
  tone?: "muted" | "foreground";
  className?: string;
  iconClassName?: string;
}) {
  const color = tone === "foreground" ? "text-foreground" : "text-muted";
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={`inline-flex items-center gap-1.5 underline decoration-(--border) underline-offset-4 transition-colors hover:text-foreground hover:decoration-(--muted) ${color} ${className}`}
    >
      {children}
      <Icon name="arrow-up-right" className={`shrink-0 ${iconClassName}`} />
    </a>
  );
}

export function ThemeToggle() {
  const { theme, toggle, mounted } = useTheme();
  const isDark = !mounted || theme === "dark";
  return (
    <Button isIconOnly size="sm" variant="ghost" aria-label="Toggle theme" onPress={toggle}>
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {isDark ? (
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        ) : (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
          </>
        )}
      </svg>
    </Button>
  );
}