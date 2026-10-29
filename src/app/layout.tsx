import type { Metadata } from "next";
import Script from "next/script";
import { GeistSans } from "geist/font/sans";
import "./globals.css";
import { Providers } from "@/components/providers/Providers";
import { SiteProvider } from "@/components/providers/SiteProvider";
import { getSiteSeo, faviconUrl, parseFavicon } from "@/lib/seo";
import { getPaletteCss } from "@/lib/palette";
import { getFontConfig, getFontCss } from "@/lib/font";

/**
 * Geist Sans (Vercel) — the single global typeface for the whole UI.
 * GeistSans.variable defines --font-geist-sans; the @theme block in globals.css
 * points both --font-sans and --font-mono at that same stack (the mono cut was
 * removed on 2026-10-26), so every `font-sans` / `font-mono` utility — including
 * inside HeroUI components — renders in Geist Sans. It is a variable font, so
 * `font-bold` / `font-semibold` produce true bold.
 */

/**
 * SEO + branding are editable from /admin → SEO. They are read per request and
 * cached as ISR; saving in the admin calls revalidatePath("/", "layout") so the
 * new <title>, meta tags, wordmark and GA tag appear immediately.
 */
export const revalidate = 300;

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSiteSeo();

  let metadataBase: URL | undefined;
  if (seo.siteUrl) {
    try {
      metadataBase = new URL(seo.siteUrl);
    } catch {
      metadataBase = undefined;
    }
  }

  // `SEO_OG_IMAGE` stays empty until an admin pastes an absolute URL, which left
  // every share with no preview at all. `public/og.png` ships with the app
  // (1200×630, rendered from the brand mark), so it is the fallback — Open Graph
  // crawlers ignore relative paths, so it only applies once a canonical
  // `siteUrl` exists to build the absolute URL from.
  const ogImage = seo.ogImage || (seo.siteUrl ? `${seo.siteUrl}/og.png` : "");
  const images = ogImage
    ? [{ url: ogImage, width: 1200, height: 630, alt: seo.siteTitle }]
    : undefined;
  const handle = seo.twitterHandle ? `@${seo.twitterHandle}` : undefined;
  const favicon = parseFavicon(seo.favicon);
  // Browsers keep favicons in a cache that ignores normal headers, so the URL
  // itself has to change when the upload changes: `faviconUrl()` folds a short
  // hash of the stored data URI into the query, making every new icon a new
  // address (and the old one unreachable).
  const iconUrl = faviconUrl(seo.favicon);
  const icons = favicon
    ? {
        icon: [{ url: iconUrl, type: favicon.mime }],
        shortcut: [{ url: iconUrl, type: favicon.mime }],
        apple: [{ url: iconUrl, type: favicon.mime }],
      }
    : undefined;

  return {
    metadataBase,
    title: {
      default: seo.siteTitle,
      template: `%s · ${seo.brandName}`,
    },
    description: seo.description,
    keywords: seo.keywords
      ? seo.keywords.split(",").map((k) => k.trim()).filter(Boolean)
      : undefined,
    applicationName: seo.brandName,
    icons,
    authors: [{ name: seo.brandName }],
    creator: seo.brandName,
    publisher: seo.brandName,
    alternates: metadataBase ? { canonical: "/" } : undefined,
    robots: seo.allowIndexing
      ? { index: true, follow: true }
      : { index: false, follow: false },
    verification: seo.googleSiteVerification
      ? { google: seo.googleSiteVerification }
      : undefined,
    openGraph: {
      type: "website",
      siteName: seo.brandName,
      title: seo.siteTitle,
      description: seo.description,
      url: metadataBase ? "/" : undefined,
      images,
      locale: "en_US",
    },
    twitter: {
      card: images ? "summary_large_image" : "summary",
      title: seo.siteTitle,
      description: seo.description,
      site: handle,
      creator: handle,
      images: images?.map((img) => img.url),
    },
  };
}

/**
 * Applied synchronously, before first paint, to set the `data-theme` attribute
 * on <html> from the stored preference (defaulting to dark). Prevents a flash
 * of the wrong theme. HeroUI v3 drives dark mode via `[data-theme="dark"]` CSS.
 */
const themeInitScript = `(function(){try{var t=localStorage.getItem('theme');var d=t?t==='dark':true;document.documentElement.setAttribute('data-theme',d?'dark':'light');}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const seo = await getSiteSeo();
  // Admin → Palette overrides, injected after globals.css. Empty when nothing
  // has been overridden, in which case no <style> tag is rendered at all.
  const paletteCss = await getPaletteCss();
  // Admin → Font: a Google Fonts <link> + a --font-sans override. Both are
  // absent for the default face (Geist is bundled with the build).
  const font = await getFontConfig();
  const fontCss = await getFontCss();
  // Re-validate before injecting: a stale malformed value must never end up in
  // an inline <script>.
  const gaId = /^G-[A-Z0-9]{4,20}$/i.test(seo.gaMeasurementId)
    ? seo.gaMeasurementId
    : "";

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={GeistSans.variable}
    >
      <body className="font-sans">
        {paletteCss ? (
          <style
            id="theme-palette"
            dangerouslySetInnerHTML={{ __html: paletteCss }}
          />
        ) : null}
        {font.href ? (
          <>
            <link rel="preconnect" href="https://fonts.googleapis.com" />
            <link
              rel="preconnect"
              href="https://fonts.gstatic.com"
              crossOrigin="anonymous"
            />
            <link rel="stylesheet" href={font.href} />
          </>
        ) : null}
        {fontCss ? (
          <style id="theme-font" dangerouslySetInnerHTML={{ __html: fontCss }} />
        ) : null}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        {gaId ? (
          <>
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
              strategy="afterInteractive"
            />
            <Script id="ga-init" strategy="afterInteractive">
              {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${gaId}');`}
            </Script>
          </>
        ) : null}
        <Providers>
          <SiteProvider
            value={{
              brandName: seo.brandName,
              social: { x: seo.xUrl, telegram: seo.telegramUrl },
              tokenName: seo.tokenName,
              faviconUrl: faviconUrl(seo.favicon),
              siteTitle: seo.siteTitle,
              description: seo.description,
            }}
          >
            {children}
          </SiteProvider>
        </Providers>
      </body>
    </html>
  );
}

