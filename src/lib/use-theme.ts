"use client";

import { useEffect, useState } from "react";

export type ThemeMode = "dark" | "light";

/**
 * Minimal theme toggle for HeroUI v3's `data-theme` dark mode. No dependency
 * on next-themes: we set the `data-theme` attribute on <html> ("dark"|"light")
 * and persist the choice to localStorage. An inline script in layout.tsx
 * applies the stored theme before hydration to avoid a flash.
 *
 * `mounted` starts false so the toggle icon can render a neutral placeholder
 * on the server / first client render (no hydration mismatch), then swap to
 * the real sun/moon once the effect runs.
 */
export function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const stored = readStored();
    const attr = document.documentElement.getAttribute("data-theme");
    setTheme(stored ?? (attr === "light" ? "light" : "dark"));
  }, []);

  function apply(next: ThemeMode) {
    setTheme(next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      /* ignore (private mode / storage disabled) */
    }
    document.documentElement.setAttribute("data-theme", next);
  }

  const toggle = () => apply(theme === "dark" ? "light" : "dark");

  return { theme, toggle, mounted };
}

function readStored(): ThemeMode | null {
  try {
    const t = localStorage.getItem("theme");
    if (t === "dark" || t === "light") return t;
  } catch {
    /* ignore */
  }
  return null;
}
