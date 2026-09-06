import type { Metadata, Viewport } from "next";
// the renderer's own stylesheet, so a question drawn in the Live View is
// painted by exactly the rules that paint it for a respondent
import "@rescript/renderer/questions.css";
import "./globals.css";

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
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
