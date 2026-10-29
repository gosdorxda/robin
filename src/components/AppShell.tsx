"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Breadcrumbs } from "@heroui/react";
import { Icon, ThemeToggle } from "@/components/ui";
import { BrandMark } from "@/components/BrandMark";
import { INFORMATION, NAV, isNavActive } from "@/components/nav";
import { useSite } from "@/components/providers/SiteProvider";

export function AppShell({
  title = "Home",
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { brandName, social } = useSite();
  // Admin → SEO owns the URLs; an empty field hides that entry (never a dead
  // link to x.com / t.me's front page).
  const socialLinks = INFORMATION.map((item) => ({
    ...item,
    href:
      item.icon === "x"
        ? social.x
        : item.icon === "telegram"
          ? social.telegram
          : "",
  })).filter((item) => item.href.trim().length > 0);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  /* Drawer behaviour: Escape closes it, the page behind stops scrolling while
     it is open, and resizing up to desktop closes it (otherwise the body would
     stay scroll-locked once the sidebar becomes permanent). Cleanup restores
     the previous overflow, so nothing leaks between routes. */
  useEffect(() => {
    if (!mobileOpen) return;
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onResize = () => {
      if (desktop.matches) setMobileOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    desktop.addEventListener("change", onResize);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      desktop.removeEventListener("change", onResize);
      window.removeEventListener("keydown", onKey);
    };
  }, [mobileOpen]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Backdrop stays mounted so it can fade both ways — an unmounted overlay
          can only ever pop in. pointer-events-none keeps the closed state inert. */}
      <div
        className={`fixed inset-0 z-30 bg-black/55 transition-opacity duration-300 ease-out motion-reduce:transition-none lg:hidden ${
          mobileOpen ? "opacity-100 backdrop-blur-[2px]" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setMobileOpen(false)}
        aria-hidden="true"
      />

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-(--border) bg-surface shadow-2xl shadow-black/40 transition-[width,translate] duration-300 ease-[cubic-bezier(0.22,0.61,0.36,1)] will-change-[width,translate] motion-reduce:transition-none lg:translate-x-0 lg:shadow-none ${
          collapsed ? "lg:w-[68px]" : ""
        } ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}
        aria-label="Site navigation"
      >
        <div className={`flex h-14 shrink-0 items-center gap-2 border-b border-(--border) px-4 ${collapsed ? "lg:justify-center" : ""}`}>
          <Link href="/" className="flex items-center gap-2" aria-label={`${brandName} home`}>
            <BrandMark brandName={brandName} />
            {!collapsed && <span className="font-bold tracking-tight">{brandName}</span>}
          </Link>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
            className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition hover:bg-default/40 hover:text-foreground lg:hidden"
          >
            <Icon name="close" className="h-4 w-4" />
          </button>
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
          {NAV.map((item, index) => {
            const active = isNavActive(pathname, item.href);
            const cls = `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition w-full text-left ${collapsed ? "lg:justify-center lg:px-0" : ""} ${active ? "bg-default font-medium text-foreground" : "font-medium text-muted hover:bg-default/40 hover:text-foreground"} ${mobileOpen ? "drawer-item-in" : ""}`;
            // Stagger capped at 190ms so the last link never lags behind the
            // 300ms panel slide; mobile-only via the .drawer-item-in media query.
            const itemStyle = { animationDelay: `${Math.min(70 + index * 22, 190)}ms` };
            const inner = (
              <>
                <Icon name={item.icon} className="shrink-0 text-(--nav-icon)" />
                <span className={collapsed ? "lg:hidden" : ""}>{item.label}</span>
              </>
            );
            return (
              <Link
                key={item.label}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                title={collapsed ? item.label : undefined}
                aria-current={active ? "page" : undefined}
                className={cls}
                style={itemStyle}
              >
                {inner}
              </Link>
            );
          })}
          {/* Social media — external community links pinned to the bottom of the
              nav. The URLs come from Admin → SEO (X profile URL / Telegram
              link); an unset one is simply hidden instead of pointing at
              x.com's homepage. */}
          {socialLinks.length > 0 && (
            <div
              className={`mt-auto flex flex-col gap-1 pt-2 ${mobileOpen ? "drawer-item-in" : ""}`}
              style={{ animationDelay: `${Math.min(70 + NAV.length * 22, 190)}ms` }}
            >
              <span
                className={`px-3 pb-1 text-xs font-normal uppercase tracking-wider text-muted ${collapsed ? "lg:hidden" : ""}`}
              >
                Social media
              </span>
              {socialLinks.map((item) => (
              <a
                key={item.label}
                href={item.href}
                target="_blank"
                rel="noreferrer noopener"
                onClick={() => setMobileOpen(false)}
                title={collapsed ? item.label : undefined}
                className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted transition hover:bg-default/40 hover:text-foreground ${collapsed ? "lg:justify-center lg:px-0" : ""}`}
              >
                <Icon name={item.icon} className="shrink-0 text-(--nav-icon)" />
                <span className={collapsed ? "lg:hidden" : ""}>{item.label}</span>
                <Icon
                  name="arrow-up-right"
                  className={`ml-auto h-3.5 w-3.5 opacity-50 ${collapsed ? "lg:hidden" : ""}`}
                />
              </a>
              ))}
            </div>
          )}
        </nav>
        <div className="hidden shrink-0 border-t border-(--border) p-3 lg:block">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="flex items-center gap-2 text-xs text-muted transition hover:text-foreground"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <Icon name={collapsed ? "expand" : "collapse"} />
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>

      <div className={`transition-[padding] duration-200 ${collapsed ? "lg:pl-[68px]" : "lg:pl-60"}`}>
        <header className="sticky top-0 z-20 border-b border-(--border) bg-surface/80 backdrop-blur">
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="flex h-9 w-9 items-center justify-center rounded-md text-muted transition hover:bg-default/40 hover:text-foreground lg:hidden"
              aria-label="Open menu"
            >
              <Icon name="menu" />
            </button>
            {/* 13px/18px: one notch below the text-sm default so the trail sits quieter than the page title. */}
            <Breadcrumbs isDisabled className="[&_.breadcrumbs\_\_link]:text-[13px]! [&_.breadcrumbs\_\_link]:leading-[18px]!">
              <Breadcrumbs.Item href="/">{brandName}</Breadcrumbs.Item>
              <Breadcrumbs.Item>{title}</Breadcrumbs.Item>
            </Breadcrumbs>
            <div className="ml-auto flex items-center gap-4">
              <ThemeToggle />
            </div>
          </div>
        </header>

        {children}
      </div>
    </div>
  );
}
