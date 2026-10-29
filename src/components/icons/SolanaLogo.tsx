/**
 * Solana logo — official token mark on a navy disc.
 *
 * viewBox `0 0 36 36`: dark navy circle (#181E33) + 3 diagonal bars with
 * brand gradient #00FFA3 (green) → #DC1FFF (magenta).
 *
 * Exports:
 *  - `SolanaMark({ uid? })`: inner content (defs + circle + 3 paths) for
 *    embedding inside a parent <svg> (e.g. nested as a travelling coin).
 *    Pass a unique `uid` when rendering multiple instances so the 3 gradient
 *    ids don't collide.
 *  - default `SolanaLogo({ size?, className? })`: standalone <svg> for HTML.
 */

export const SOLANA_BG = "#181E33";
export const SOLANA_GRAD_FROM = "#00FFA3";
export const SOLANA_GRAD_TO = "#DC1FFF";

/** gradient geometries (from the official Solana SVG). */
const SOLANA_GRADIENTS = [
  { id: "a", x1: "90.737%", y1: "34.776%", x2: "35.509%", y2: "55.415%" },
  { id: "b", x1: "66.588%", y1: "43.8%", x2: "11.36%", y2: "64.439%" },
  { id: "c", x1: "78.586%", y1: "39.317%", x2: "23.358%", y2: "59.956%" },
] as const;

/** the three diagonal bars (pre-transform; rendered with translate(6 9)). */
const SOLANA_PATHS = [
  "M3.9 14.355a.785.785 0 0 1 .554-.23h19.153c.35 0 .525.423.277.67l-3.783 3.784a.785.785 0 0 1-.555.23H.393a.392.392 0 0 1-.277-.67l3.783-3.784z",
  "M3.9.23c.15-.146.35-.23.554-.23h19.153c.35 0 .525.422.277.67l-3.783 3.783a.785.785 0 0 1-.555.23H.393a.392.392 0 0 1-.277-.67L3.899.229z",
  "M20.1 7.247a.785.785 0 0 0-.554-.23H.393a.392.392 0 0 0-.277.67l3.783 3.784c.145.145.344.23.555.23h19.153c.35 0 .525-.423.277-.67l-3.783-3.784z",
] as const;

interface SolanaMarkProps {
  /** unique suffix for gradient ids — required when rendering >1 instance. */
  uid?: string;
}

/** Inner mark: 3 gradients + navy disc + 3 bars. Drop inside any <svg>. */
export function SolanaMark({ uid = "" }: SolanaMarkProps) {
  const g = (id: string) => (uid ? `${id}-${uid}` : id);
  return (
    <>
      <defs>
        {SOLANA_GRADIENTS.map((gr) => (
          <linearGradient key={gr.id} id={g(gr.id)} x1={gr.x1} y1={gr.y1} x2={gr.x2} y2={gr.y2}>
            <stop offset="0%" stopColor={SOLANA_GRAD_FROM} />
            <stop offset="100%" stopColor={SOLANA_GRAD_TO} />
          </linearGradient>
        ))}
      </defs>
      <g fill="none" fillRule="nonzero">
        <circle cx="18" cy="18" r="18" fill={SOLANA_BG} />
        <path d={SOLANA_PATHS[0]} fill={`url(#${g("a")})`} transform="translate(6 9)" />
        <path d={SOLANA_PATHS[1]} fill={`url(#${g("b")})`} transform="translate(6 9)" />
        <path d={SOLANA_PATHS[2]} fill={`url(#${g("c")})`} transform="translate(6 9)" />
      </g>
    </>
  );
}

interface SolanaLogoProps {
  size?: number;
  className?: string;
}

/** Standalone Solana logo for use in HTML/JSX (renders its own <svg>). */
export default function SolanaLogo({ size = 36, className }: SolanaLogoProps) {
  return (
    <svg
      role="img"
      viewBox="0 0 36 36"
      width={size}
      height={size}
      className={className}
      aria-label="Solana"
      xmlns="http://www.w3.org/2000/svg"
    >
      <SolanaMark />
    </svg>
  );
}