/**
 * THE FOUR MODES (Analytics upgrade 2026-11-06). The workspace was twelve tabs,
 * then five places; it is now four modes in the order a researcher works —
 * one continuous workflow over one engine:
 *
 *   OVERVIEW   the executive summary of the study, and the findings behind it
 *   EXPLORE    the interactive board (pick variables → the analysis that fits), the builder, tables, charts, segments, filters
 *   ARCHITECT  the three-pane research environment, and the analysis plan it runs
 *   PRESENT    the selection as one deliverable (export, save as report), reports, report themes, exports, sharing
 *
 * Nothing is removed and nothing is renamed in the data: every earlier view is
 * a view of exactly one mode, so a link written for any earlier tab or place
 * (`?tab=reports`, `?tab=deliver`, `?tab=plan`, `?tab=findings`) still lands
 * where it always did. Ask is not a mode: it is a panel that opens from every
 * one of them.
 *
 * Kept free of React and of `@/` aliases so it is tested on its own.
 */
export type WsTab = "home" | "findings" | "plan" | "architect" | "board" | "analysis" | "charts" | "tables" | "segments" | "filters" | "present" | "reports" | "ask" | "themes" | "exports" | "sharing";
export type PlaceKey = "overview" | "explore" | "architect" | "present";

export interface View { key: Exclude<WsTab, "ask">; label: string }
export interface Place { key: PlaceKey; label: string; /** the question the mode answers — shown as its tooltip */ question: string; views: View[] }

export const PLACES: Place[] = [
  { key: "overview", label: "Overview", question: "What did the study find?", views: [{ key: "home", label: "Overview" }, { key: "findings", label: "Findings" }] },
  { key: "explore", label: "Explore", question: "What does the data show?", views: [{ key: "board", label: "Explore" }, { key: "analysis", label: "Analysis" }, { key: "tables", label: "Tables" }, { key: "charts", label: "Charts" }, { key: "segments", label: "Segments" }, { key: "filters", label: "Filters" }] },
  { key: "architect", label: "Architect", question: "Every analysis, in research terms, under full control", views: [{ key: "architect", label: "Workspace" }, { key: "plan", label: "Analysis plan" }] },
  { key: "present", label: "Present", question: "How do we get this to people?", views: [{ key: "present", label: "Present" }, { key: "reports", label: "Reports" }, { key: "themes", label: "Themes" }, { key: "exports", label: "Exports" }, { key: "sharing", label: "Sharing" }] },
];

export const DEFAULT_VIEW: Record<PlaceKey, View["key"]> = { overview: "home", explore: "board", architect: "architect", present: "present" };

/** the earlier five places, read into the mode that holds what they held */
const LEGACY_PLACES: Record<string, View["key"]> = { plan: "plan", findings: "findings", deliver: "reports" };
/* the earlier place name still opens Reports — a link to "deliver" meant the reports */

/** the mode a view lives in — every view of every earlier tab has one */
export function placeOf(tab: WsTab): PlaceKey {
  if (tab === "ask") return "overview";
  return PLACES.find((p) => p.views.some((v) => v.key === tab))!.key;
}

/**
 * What a link or a saved value means. An earlier tab name opens that view; a
 * mode (or an earlier place) name opens its first view; `ask` opens the Ask
 * panel (it is a panel now, so the mode stays Overview). Anything else is
 * nothing, and the workspace opens where it always opens.
 */
export function resolveTab(raw: string | null | undefined): WsTab | undefined {
  if (!raw) return undefined;
  const k = raw.trim().toLowerCase();
  if (k === "ask") return "ask";
  for (const p of PLACES) for (const v of p.views) if (v.key === k) return v.key;
  const place = PLACES.find((p) => p.key === k);
  if (place) return DEFAULT_VIEW[place.key];
  return LEGACY_PLACES[k];
}
