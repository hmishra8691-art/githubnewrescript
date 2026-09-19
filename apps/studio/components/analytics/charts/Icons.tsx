"use client";
import React from "react";
import type { IconKey } from "@rescript/analytics";

/**
 * §38 — the operational-dashboard glyph set.
 *
 * A closed set of nine plain-SVG icons (no icon font, no new dependency),
 * used by the pictogram panel, the numbered-step panel and the iconed
 * ranked list — the widgets modelled on Forsta/Dapresy-style CX/EX
 * dashboards. Every glyph is drawn on a 24×24 grid with `currentColor`, so
 * it inherits whatever color the caller sets and needs no theme wiring of
 * its own.
 */

export const ICON_OPTIONS: { key: IconKey; label: string }[] = [
  { key: "person", label: "Person" },
  { key: "star", label: "Star" },
  { key: "flag", label: "Flag" },
  { key: "check", label: "Check" },
  { key: "trend_up", label: "Trend up" },
  { key: "trend_down", label: "Trend down" },
  { key: "building", label: "Building" },
  { key: "car", label: "Car" },
  { key: "hotel", label: "Hotel" },
  { key: "generic", label: "Dot" },
];

const PATHS: Record<IconKey, React.ReactNode> = {
  person: <><circle cx="12" cy="7" r="3.4" /><path d="M5 20c0-3.9 3.1-6.4 7-6.4s7 2.5 7 6.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>,
  star: <path d="M12 2.5l2.9 6.1 6.6.7-4.9 4.6 1.3 6.6L12 17.5 6.1 20.5l1.3-6.6-4.9-4.6 6.6-.7z" />,
  flag: <><path d="M6 2v20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" /><path d="M6 3.2h12.5L15 8l3.5 4.8H6z" /></>,
  check: <path d="M4.5 12.8l4.8 4.8L19.5 6.4" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />,
  trend_up: <><path d="M3 17l6.2-6.2 4 4L21 6.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /><path d="M15 6.5h6v6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></>,
  trend_down: <><path d="M3 7l6.2 6.2 4-4L21 17.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /><path d="M15 17.5h6v-6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></>,
  building: <><rect x="4" y="3" width="10" height="18" rx="0.5" fill="none" stroke="currentColor" strokeWidth="2" /><rect x="14" y="9" width="6" height="12" rx="0.5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M7 7h1M11 7h1M7 11h1M11 11h1M7 15h1M11 15h1M17 13h1M17 17h1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  car: <><path d="M4 16v-3.3l2-4.2c.3-.6.9-1 1.6-1h8.8c.7 0 1.3.4 1.6 1l2 4.2V16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><circle cx="7.5" cy="17" r="1.6" /><circle cx="16.5" cy="17" r="1.6" /><path d="M4 13h16" stroke="currentColor" strokeWidth="2" /></>,
  hotel: <><path d="M3 20V6l9-3 9 3v14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><path d="M8 20v-6h8v6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><path d="M9 10h1M14 10h1M9 13h1M14 13h1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  generic: <circle cx="12" cy="12" r="6" />,
};

export function Icon({ name, size = 18, color, style }: { name: IconKey; size?: number; color?: string; style?: React.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={{ color, flex: "none", ...style }} aria-hidden focusable="false">
      {PATHS[name] ?? PATHS.generic}
    </svg>
  );
}

/**
 * A pictogram row: `filled` of `total` glyphs colored, the rest dim — the
 * isotype-chart convention Junicom's demographic panel uses (e.g. 7 of 10
 * person icons colored for a 70% figure).
 */
export function IconPictogram({ icon, pct, total = 10, color, dim = "#d8dce6" }: { icon: IconKey; pct: number; total?: number; color: string; dim?: string }) {
  const filled = Math.max(0, Math.min(total, Math.round((pct / 100) * total)));
  return (
    <span style={{ display: "inline-flex", gap: 2 }}>
      {Array.from({ length: total }, (_, i) => <Icon key={i} name={icon} size={15} color={i < filled ? color : dim} />)}
    </span>
  );
}
