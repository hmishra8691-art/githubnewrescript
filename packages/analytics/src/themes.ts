import type { ReportTheme } from "./types.js";
import { DEFAULT_THEME } from "./types.js";

/**
 * THEME SURFACES AND PRESETS (§42).
 *
 * A theme has always carried a background and a text colour, and the report
 * honoured both. Everything AROUND the content did not: widget cards were a
 * stylesheet variable, chart grid lines were the literal `#e5e9f0`. On a light
 * theme nobody noticed. Set a dark background and the result was a dark page
 * carrying white cards ruled with near-white lines — a dark theme in name only.
 *
 * So the surfaces are DERIVED from the theme rather than declared beside it.
 * One colour decision (the background) settles the card, the border and the
 * grid, which is also why a dark preset is three colours rather than thirty.
 */

/** #rgb / #rrggbb → [r,g,b]; anything unparseable reads as mid-grey rather than throwing into a render. */
export function hexToRgb(hex: string): [number, number, number] {
  const s = (hex || "").trim().replace("#", "");
  if (/^[0-9a-f]{3}$/i.test(s)) return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16)];
  if (/^[0-9a-f]{6}$/i.test(s)) return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  return [128, 128, 128];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** `t` of the way from `a` to `b`. */
export function mixHex(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a), [r2, g2, b2] = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  return rgbToHex(r1 + (r2 - r1) * k, g1 + (g2 - g1) * k, b1 + (b2 - b1) * k);
}

/** Relative luminance (sRGB), for deciding whether a colour is a dark surface. */
export function luminance(hex: string): number {
  const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function isDarkTheme(theme: Pick<ReportTheme, "colors">): boolean {
  return luminance(theme.colors?.background ?? "#ffffff") < 0.4;
}

export interface ThemeSurfaces {
  /** the card a widget or block is drawn on */
  surface: string;
  /** its edge */
  border: string;
  /** chart grid lines */
  grid: string;
  /** the page behind everything */
  background: string;
  text: string;
  subtle: string;
  dark: boolean;
}

/**
 * The surfaces implied by a theme.
 *
 * A card is a step from the background TOWARDS the text colour — lighter on a
 * dark theme, barely-there grey on a light one — which is the same rule in
 * both directions instead of two sets of hard-coded colours. Grid lines take a
 * smaller step still: they have to be visible without competing with the data,
 * and `#e5e9f0` on a near-black chart is a cage.
 */
export function themeSurfaces(theme: ReportTheme): ThemeSurfaces {
  const background = theme.colors?.background ?? "#ffffff";
  const text = theme.colors?.text ?? "#131a2b";
  const dark = isDarkTheme(theme);
  return {
    background, text,
    subtle: theme.colors?.subtle ?? mixHex(background, text, 0.6),
    surface: mixHex(background, text, dark ? 0.08 : 0),
    border: mixHex(background, text, dark ? 0.22 : 0.12),
    grid: mixHex(background, text, dark ? 0.18 : 0.1),
    dark,
  };
}

/**
 * Themes to start from. A preset is not a locked style: it fills the editor,
 * and everything in it stays editable — the point is that "make it dark" is
 * one click rather than eight colour pickers and a guess at what a card
 * should be.
 */
export const THEME_PRESETS: ReportTheme[] = [
  DEFAULT_THEME,
  {
    name: "Midnight",
    colors: {
      primary: "#7c8cff", secondary: "#cbd5f5", accent: "#22d3ee",
      background: "#0f1524", text: "#eef2ff", subtle: "#94a3c4",
      palette: ["#7c8cff", "#22d3ee", "#fbbf24", "#34d399", "#fb7185", "#c084fc", "#fb923c", "#a3e635", "#f472b6", "#94a3b8"],
    },
    fontFamily: "Inter, system-ui, sans-serif",
    chart: { gridLines: true, dataLabels: true, decimals: 0 },
    typography: { baseSize: 12, titleSize: 16 },
    cover: { background: "#0b1020", textColor: "#ffffff", layout: "left" },
  },
  {
    name: "Graphite",
    colors: {
      primary: "#f59e0b", secondary: "#d4d4d8", accent: "#38bdf8",
      background: "#1c1c1f", text: "#f4f4f5", subtle: "#a1a1aa",
      palette: ["#f59e0b", "#38bdf8", "#a3e635", "#f472b6", "#c084fc", "#2dd4bf", "#fb7185", "#facc15", "#60a5fa", "#a1a1aa"],
    },
    fontFamily: "Inter, system-ui, sans-serif",
    chart: { gridLines: true, dataLabels: true, decimals: 0 },
    typography: { baseSize: 12, titleSize: 16 },
    cover: { background: "#121214", textColor: "#ffffff", layout: "left" },
  },
  {
    name: "Warm paper",
    colors: {
      primary: "#b45309", secondary: "#78350f", accent: "#0f766e",
      background: "#fdfaf4", text: "#1f2937", subtle: "#78716c",
      palette: ["#b45309", "#0f766e", "#4338ca", "#be123c", "#65a30d", "#0369a1", "#a21caf", "#ca8a04", "#7c2d12", "#78716c"],
    },
    fontFamily: "Inter, system-ui, sans-serif",
    chart: { gridLines: true, dataLabels: true, decimals: 0 },
    typography: { baseSize: 12, titleSize: 16 },
    cover: { background: "#78350f", textColor: "#ffffff", layout: "left" },
  },
];
