import type { Metadata, Viewport } from "next";
// the renderer's own stylesheet, so a question drawn in the Live View is
// painted by exactly the rules that paint it for a respondent
import "@rescript/renderer/questions.css";
import "./globals.css";
import { platformBadge } from "@/lib/platform";

export const metadata: Metadata = {
  title: "Rescript Studio",
  description: "Professional survey programming, data collection, analytics and reporting",
};

export const viewport: Viewport = { themeColor: "#4f46e5", width: "device-width", initialScale: 1 };

/*
 * The typeface is loaded as a plain stylesheet with `display=swap` and a full
 * system fallback stack in the token, so nothing about the build depends on
 * the font host being reachable — the app is just as usable if it is not.
 */
/**
 * WHICH DEPLOYMENT YOU ARE LOOKING AT (§45).
 *
 * Two instances of this platform are visually identical, and the destructive
 * actions — publish, deploy, purge responses, freeze a project — are all one
 * click. Somebody who believes they are in staging and is in production finds
 * out afterwards. So a non-production instance says so, permanently, at the
 * top of every page.
 *
 * PRODUCTION SHOWS NOTHING, deliberately. A badge that is always there is a
 * badge everybody stops seeing, and then it fails at the one moment it
 * mattered. The signal is the ABSENCE of the banner.
 *
 * It renders in the root layout rather than through the middleware, so it is
 * also there on /login, /sandbox and a shared report — a person handed a
 * staging link should be told before they sign in, not after.
 */
function EnvironmentBanner() {
  const badge = platformBadge();
  if (!badge) return null;
  return (
    <div className={`env-banner env-${badge.tier}`} data-testid="env-banner" data-tier={badge.tier}>
      <strong>{badge.tier === "staging" ? "Staging" : "Development"}</strong>
      <span>
        {badge.tier === "staging"
          ? "This is not the production platform. Anything fielded from here reaches real respondents only if this instance is pointed at a live database."
          : "Local instance."}
      </span>
      {badge.database && <code className="mono">db: {badge.database}</code>}
    </div>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
      </head>
      <body>
        <EnvironmentBanner />
        {children}
      </body>
    </html>
  );
}
