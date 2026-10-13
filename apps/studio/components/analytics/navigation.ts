/**
 * THE FIVE PLACES (Phase 5). The workspace used to be twelve tabs that mixed
 * places to work, things applied to analyses and ways to deliver. They are now
 * five places, ordered the way a researcher works, each holding the views that
 * used to be tabs — nothing removed, nothing renamed in the data. Ask is not a
 * place: it is a panel that opens from every one of them.
 *
 * Kept free of React and of `@/` aliases so it is tested on its own and so a
 * link written for any earlier tab (`?tab=reports`, `?tab=analysis`) still
 * lands where it always did.
 */
export type WsTab = "home" | "plan" | "analysis" | "charts" | "tables" | "segments" | "filters" | "findings" | "reports" | "ask" | "themes" | "exports" | "sharing";
export type PlaceKey = "overview" | "plan" | "explore" | "findings" | "deliver";

export interface View { key: Exclude<WsTab, "ask">; label: string }
export interface Place { key: PlaceKey; label: string; /** the question the place answers — shown as its tooltip */ question: string; views: View[] }

export const PLACES: Place[] = [
  { key: "overview", label: "Overview", question: "Where does this study stand?", views: [{ key: "home", label: "Overview" }] },
  { key: "plan", label: "Plan", question: "What are we trying to learn, and what will we run?", views: [{ key: "plan", label: "Analysis plan" }] },
  { key: "explore", label: "Explore", question: "What does the data show?", views: [{ key: "analysis", label: "Analysis" }, { key: "tables", label: "Tables" }, { key: "charts", label: "Charts" }, { key: "segments", label: "Segments" }, { key: "filters", label: "Filters" }] },
  { key: "findings", label: "Findings", question: "What matters, and is it reliable?", views: [{ key: "findings", label: "Findings" }, { key: "themes", label: "Themes" }] },
  { key: "deliver", label: "Deliver", question: "How do we get this to people?", views: [{ key: "reports", label: "Reports" }, { key: "exports", label: "Exports" }, { key: "sharing", label: "Sharing" }] },
];

export const DEFAULT_VIEW: Record<PlaceKey, View["key"]> = { overview: "home", plan: "plan", explore: "analysis", findings: "findings", deliver: "reports" };

/** the place a view lives in — every view of every earlier tab has one */
export function placeOf(tab: WsTab): PlaceKey {
  if (tab === "ask") return "overview";
  return PLACES.find((p) => p.views.some((v) => v.key === tab))!.key;
}

/**
 * What a link or a saved value means. An earlier tab name opens that view; a
 * place name opens the place's first view; `ask` opens the Ask panel (it is a
 * panel now, so the place stays Overview). Anything else is nothing, and the
 * workspace opens where it always opens.
 */
export function resolveTab(raw: string | null | undefined): WsTab | undefined {
  if (!raw) return undefined;
  const k = raw.trim().toLowerCase();
  if (k === "ask") return "ask";
  for (const p of PLACES) for (const v of p.views) if (v.key === k) return v.key;
  const place = PLACES.find((p) => p.key === k);
  return place ? DEFAULT_VIEW[place.key] : undefined;
}
