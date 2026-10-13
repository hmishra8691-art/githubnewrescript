/*
 * The Charts library used to compute the analysis behind every saved chart the
 * moment it opened. A project with a few hundred charts therefore ran a few
 * hundred analyses to show the first screen. The library now shows (and computes)
 * one page at a time; "Show more" asks for the next page.
 */
export const CHART_PAGE = 12;

/** The charts on screen when `pages` pages have been asked for. */
export function visibleCharts<T>(charts: readonly T[], pages: number, size = CHART_PAGE): T[] {
  const n = Math.max(1, Math.floor(pages)) * size;
  return charts.slice(0, n);
}

/** Distinct analysis ids that the visible charts need, in the order they appear. */
export function analysisIdsFor(visible: readonly object[]): string[] {
  return [...new Set(visible.map((c) => String((c as { analysis_id?: unknown }).analysis_id)))];
}

/** How many more charts a further page would reveal (0 when everything is shown). */
export function hiddenCount(total: number, pages: number, size = CHART_PAGE): number {
  return Math.max(0, total - Math.max(1, Math.floor(pages)) * size);
}
