import type { ChartData } from "./types.js";

/**
 * HOW MANY DECIMALS A CHART SHOWS — one answer for the browser chart, the
 * PowerPoint export and the shared page (Data Analytics audit, Oct 2026, C-3).
 *
 * The browser used "the theme's number, else 0 or 1"; PowerPoint used "the
 * theme's number, else 0, but one decimal for a percent"; the three stock
 * themes all said 0. So a mean of 3.8 was drawn "4" in a theme and "3.8" in
 * the preview, and a percent had a decimal on a slide and none on the screen.
 * Now: what the researcher set on the chart, else what the theme explicitly
 * sets (the stock themes no longer do), else what the values call for.
 */
export function chartDecimals(chart: ChartData | undefined, explicit?: number | null, themeDefault?: number | null): number {
  const set = explicit ?? themeDefault;
  if (typeof set === "number" && Number.isFinite(set)) return Math.max(0, Math.min(4, Math.round(set)));
  if (chart?.valueFormat === "pct") return 0;
  const values: number[] = [];
  for (const s of chart?.series ?? []) for (const v of s.values) if (typeof v === "number" && Number.isFinite(v)) values.push(v);
  for (const row of chart?.matrix?.values ?? []) for (const v of row) if (typeof v === "number" && Number.isFinite(v)) values.push(v);
  if (!values.length) return 0;
  if (values.every((v) => Number.isInteger(v))) return 0;
  return 1;
}

/** the spreadsheet number-format code for the same choice ("0", "0.0", "0.0%" style for a percent shown as a number) */
export function chartFormatCode(decimals: number, pct: boolean): string {
  const base = decimals > 0 ? `0.${"0".repeat(decimals)}` : "0";
  return pct ? `${base}"%"` : base;
}
