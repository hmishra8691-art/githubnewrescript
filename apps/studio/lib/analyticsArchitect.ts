import type { AnalysisCatalogue, CatalogueCategory, CatalogueEntry } from "@rescript/analytics";
import { searchCatalogue } from "@rescript/analytics";

/**
 * ANALYTICS ARCHITECT MODE — the state the shell keeps, kept free of React so it is tested on its own.
 *
 *   explorer    which category is open ("all" is the flat view), the filter text
 *   selection   the entries ticked in the Explorer — the workspace-wide selection (selection.tsx) — and the
 *               one entry the Focus view opens
 *   panes       the Explorer's and the Properties panel's widths, remembered per browser
 */

export const PANES_KEY = "rescript.analytics.architect.panes";

export interface Panes { explorer: number; properties: number }
export const DEFAULT_PANES: Panes = { explorer: 300, properties: 380 };
export const PANE_MIN = 220, PANE_MAX = 640;

export function readPanes(raw: string | null | undefined): Panes {
  try {
    const p = raw ? (JSON.parse(raw) as Partial<Panes>) : null;
    if (p && typeof p.explorer === "number" && typeof p.properties === "number") return { explorer: clampPane(p.explorer), properties: clampPane(p.properties) };
  } catch { /* fine */ }
  return DEFAULT_PANES;
}
export const clampPane = (n: number) => Math.max(PANE_MIN, Math.min(PANE_MAX, Math.round(n)));

export type ExplorerCategory = CatalogueCategory | "all";

export interface Selection { keys: string[]; focus: string | null }

/** the entries on show in the Explorer: the open category (or all), narrowed by the filter text */
export function explorerEntries(c: AnalysisCatalogue, category: ExplorerCategory, filter: string): CatalogueEntry[] {
  const hits = searchCatalogue(c, filter);
  return category === "all" ? hits : hits.filter((e) => e.category === category);
}

/** an entry a chart/table can be drawn for: a saved analysis, or a chart of one */
export const isRenderable = (e: CatalogueEntry): boolean => !!e.analysisId && (e.category === "crosstabs" || e.category === "tests" || e.category === "models" || e.category === "correlations" || e.category === "charts");

/** the selected entries, in Explorer order, that a chart/table can be drawn for — what the All view and a bulk export take */
export function renderable(c: AnalysisCatalogue, s: Selection): CatalogueEntry[] {
  const set = new Set(s.keys);
  return c.all.filter((e) => set.has(e.key) && isRenderable(e));
}

/** one line for the Workspace head: "4 selected · 3 can be shown" */
export function selectionSummary(c: AnalysisCatalogue, s: Selection): string {
  if (!s.keys.length) return "Nothing selected — tick entries in the Explorer, or open one";
  const r = renderable(c, s).length;
  return `${s.keys.length} selected${r !== s.keys.length ? ` · ${r} can be shown` : ""}`;
}
