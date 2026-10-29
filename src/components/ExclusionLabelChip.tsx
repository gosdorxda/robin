"use client";

import type { ComponentProps } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Droplets,
  Landmark,
  Network,
  Split,
  Tag,
  UsersRound,
} from "lucide-react";
import { Chip } from "@heroui/react";
import type { ChipVariants } from "@heroui/react";

type ChipColor = NonNullable<ChipVariants["color"]>;
type ChipSize = NonNullable<ChipVariants["size"]>;

/**
 * One place for how an exclusion label LOOKS, so the admin list and the public
 * /eligibility table can never drift apart.
 *
 * Presets are the reasons an account actually gets removed in practice, each
 * with its own icon + colour and a one-line explanation. Labels are free text on
 * the server (`ExcludedWallet.label`), so anything typed by hand that isn't a
 * preset still renders — just with the neutral `Tag` treatment.
 *
 * Venue accounts (pump.fun bonding curve / PumpSwap pool authority) are a
 * different story: they are derived from TOKEN_MINT, not labelled by an admin,
 * so they get their own `VenueChip` wording.
 */

export type ExclusionLabelPreset = {
  /** Exact label written to `ExcludedWallet.label`. */
  value: string;
  icon: LucideIcon;
  color: ChipColor;
  /** Tooltip / helper line: why this wallet is out of the draw. */
  hint: string;
};

export const EXCLUSION_LABEL_PRESETS: readonly ExclusionLabelPreset[] = [
  {
    value: "Split wallet",
    icon: Split,
    color: "accent",
    hint: "Same owner on a second wallet — one holder, two tickets.",
  },
  {
    value: "Sybil cluster",
    icon: Network,
    color: "danger",
    hint: "Wallets acting together to farm extra draw entries.",
  },
  {
    value: "Bot / sniper",
    icon: Bot,
    color: "warning",
    hint: "Automated trading wallet, not a real participant.",
  },
  {
    value: "Team",
    icon: UsersRound,
    color: "success",
    hint: "Core team / insider wallet kept out of the prize pool.",
  },
  {
    value: "Treasury",
    icon: Landmark,
    color: "default",
    hint: "Project treasury or operations wallet.",
  },
];

/** Case-insensitive preset lookup; null for free-text labels. */
export function matchExclusionPreset(
  label?: string | null
): ExclusionLabelPreset | null {
  const value = label?.trim().toLowerCase();
  if (!value) return null;
  return (
    EXCLUSION_LABEL_PRESETS.find((p) => p.value.toLowerCase() === value) ?? null
  );
}

const chip = "gap-1";

/**
 * Chip for an admin blacklist row: the matching preset colour + icon, a neutral
 * `Tag` for custom text, and a plain "Excluded" chip when the admin left the
 * label empty (That case only shows on the public list, which has no other hint).
 */
export function ExclusionLabelChip({
  label,
  className,
  size = "sm",
  ...rest
}: {
  label?: string | null;
  className?: string;
  /** Defaults to `sm` for tables; the eligibility banner passes `lg`. */
  size?: ChipSize;
} & Omit<ComponentProps<typeof Chip>, "children" | "color" | "size">) {
  const preset = matchExclusionPreset(label);
  // Inline glyphs stay just under the chip's text size (12 px text → 12 px icon);
  // the `lg` banner chip gets one step up so it doesn't look lost.
  const glyph = size === "lg" ? "h-3.5 w-3.5" : "h-3 w-3";

  if (preset) {
    const Glyph = preset.icon;
    return (
      <span title={preset.hint} className="inline-flex">
        <Chip
          size={size}
          variant="soft"
          color={preset.color}
          className={`${chip} ${className ?? ""}`}
          {...rest}
        >
          <Glyph className={`${glyph} shrink-0`} aria-hidden />
          <Chip.Label>{preset.value}</Chip.Label>
        </Chip>
      </span>
    );
  }

  if (!label?.trim()) {
    return (
      <span
        title="Removed from the draw by the organiser."
        className="inline-flex"
      >
        <Chip
          size={size}
          variant="soft"
          color="danger"
          className={`${chip} ${className ?? ""}`}
          {...rest}
        >
          <Chip.Label>Excluded</Chip.Label>
        </Chip>
      </span>
    );
  }

  return (
    <span title={label} className="inline-flex">
      <Chip
        size={size}
        variant="soft"
        color="default"
        className={`${chip} ${className ?? ""}`}
        {...rest}
      >
        <Tag className={`${glyph} shrink-0`} aria-hidden />
        <Chip.Label>{label}</Chip.Label>
      </Chip>
    </span>
  );
}

/**
 * Auto-excluded venue account (bonding curve / pool authority). Amber because it
 * is a "not a player" note, not an accusation.
 */
export function VenueChip({
  text,
  title,
  className,
  size = "sm",
}: {
  text: string;
  title?: string;
  className?: string;
  /** Defaults to `sm` for tables; the eligibility banner passes `lg`. */
  size?: ChipSize;
}) {
  return (
    <span title={title} className="inline-flex">
      <Chip
        size={size}
        variant="soft"
        color="warning"
        className={`${chip} ${className ?? ""}`}
      >
        <Droplets
          className={`${size === "lg" ? "h-3.5 w-3.5" : "h-3 w-3"} shrink-0`}
          aria-hidden
        />
        <Chip.Label>{text}</Chip.Label>
      </Chip>
    </span>
  );
}
