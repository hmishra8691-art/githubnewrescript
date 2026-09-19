import type { DashboardBand, DashboardDefinition, DashboardHero, DashboardWidget } from "./types.js";
import { normalizeLayout } from "./dashboardLayout.js";

/**
 * DASHBOARD TEMPLATES (§42) — the shape of a dashboard, without the study in it.
 *
 * Reports have had templates since §36. Dashboards have not, which meant every
 * CX or engagement dashboard was assembled widget by widget from an empty
 * canvas. These are the same idea as `BUILT_IN_REPORT_TEMPLATES`, over
 * `DashboardDefinition` instead of `ReportDefinition`, and they follow the
 * same rule that matters most: applying one NEVER throws away a widget that
 * already points at an analysis.
 *
 * They are also where the last four phases meet — the built-ins are laid out
 * on the canvas (§40), carry a hero and a band (§41), and use the operational
 * widgets (§38) and the maps (§39) rather than only charts and tables.
 */

export interface TemplateWidget extends DashboardWidget {
  /** what a filled-in version of this widget is for, shown while it is empty */
  placeholder?: string;
}

export interface DashboardTemplate {
  id?: string;
  name: string;
  description?: string;
  /** shipped with the platform rather than authored in this workspace */
  builtIn?: boolean;
  kind: "dashboard";
  themeId?: string | null;
  widgets: TemplateWidget[];
  hero?: DashboardHero;
  bands?: DashboardBand[];
}

/**
 * A stored template written before dashboards had any tells us nothing about
 * its kind, and every one of those is a report. Reading a missing `kind` as
 * "report" is what keeps the existing gallery working.
 */
export function templateKind(t: { kind?: string }): "report" | "dashboard" {
  return t.kind === "dashboard" ? "dashboard" : "report";
}

let seq = 0;
const wid = (prefix = "w") => { seq += 1; return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`; };

/** Widget kinds that are nothing at all without an analysis behind them. */
const NEEDS_ANALYSIS = new Set(["kpi", "chart", "table", "icon_panel", "ranked_list"]);

/**
 * Turn a dashboard template into a definition.
 *
 * Deliberately conservative, exactly like `applyTemplate` for reports: every
 * widget in the existing dashboard that already points at an analysis is
 * carried across into the first placeholder of the same type, and anything
 * left over is appended rather than dropped. Choosing a template is not
 * allowed to be the action that loses somebody's afternoon.
 */
export function applyDashboardTemplate(
  template: DashboardTemplate,
  existing?: Partial<DashboardDefinition>,
): DashboardDefinition {
  const keep = (existing?.widgets ?? []).filter((w) => !!w.analysisId);
  const used = new Set<string>();
  const widgets: DashboardWidget[] = [];

  for (const t of template.widgets) {
    // the placeholder travels with the widget: it is the only thing telling
    // the author what this empty slot is for
    const fresh: DashboardWidget = { ...t, id: wid(t.type) };

    if (NEEDS_ANALYSIS.has(t.type)) {
      const match = keep.find((k) => k.type === t.type && !used.has(k.id));
      if (match) {
        used.add(match.id);
        /*
         * The template decides the LAYOUT and the title — that is what makes
         * it a house template — while the analysis, the chart type and any
         * other real configuration come from the widget that already had
         * them.
         */
        widgets.push({ ...match, id: fresh.id, x: fresh.x, y: fresh.y, w: fresh.w, h: fresh.h, title: t.title || match.title });
        continue;
      }
    }
    widgets.push(fresh);
  }

  // anything the template had no room for still belongs to its author
  for (const k of keep) {
    if (used.has(k.id)) continue;
    widgets.push({ ...k, id: wid(k.type) });
  }

  /*
   * The author's own hero IMAGE outlives the template. The template supplies a
   * banner's shape and wording; the photograph is the one part of it that was
   * the author's own upload, and silently replacing it with nothing is the
   * same class of loss as dropping a chart.
   */
  const hero: DashboardHero | undefined = template.hero || existing?.hero
    ? { ...template.hero, ...(existing?.hero?.imageUrl ? { imageUrl: existing.hero.imageUrl } : {}) }
    : undefined;

  return {
    title: existing?.title ?? template.name,
    themeId: template.themeId ?? existing?.themeId ?? null,
    crossFilter: existing?.crossFilter ?? true,
    widgets: normalizeLayout(widgets),
    ...(hero ? { hero } : {}),
    ...(template.bands?.length ? { bands: template.bands.map((b) => ({ ...b, id: wid("band") })) } : {}),
  };
}

/** A dashboard's shape, with every reference to this study stripped out of it. */
export function dashboardAsTemplate(name: string, def: Partial<DashboardDefinition>, description?: string): DashboardTemplate {
  return {
    name, description, kind: "dashboard",
    widgets: (def.widgets ?? []).map((w) => {
      const t: TemplateWidget = { ...w, analysisId: undefined };
      // a chart spec is styling, not a study, so it travels; the analysis does not
      return t;
    }),
    ...(def.hero ? { hero: { ...def.hero } } : {}),
    ...(def.bands?.length ? { bands: def.bands.map((b) => ({ ...b })) } : {}),
  };
}

/** One line describing what applying this template would produce. */
export function describeDashboardTemplate(t: DashboardTemplate): string {
  const counts = new Map<string, number>();
  for (const w of t.widgets) counts.set(w.type, (counts.get(w.type) ?? 0) + 1);
  const order = ["kpi", "chart", "table", "icon_panel", "ranked_list", "steps", "photo", "text", "filter"];
  const parts = order
    .filter((k) => counts.has(k))
    .map((k) => `${counts.get(k)} ${k.replace("_", " ")}${counts.get(k)! > 1 ? "s" : ""}`);
  const scenery = [t.hero ? "a hero banner" : null, t.bands?.length ? `${t.bands.length} band${t.bands.length > 1 ? "s" : ""}` : null].filter(Boolean);
  return `${t.widgets.length} widget${t.widgets.length === 1 ? "" : "s"} — ${parts.join(", ")}${scenery.length ? ` · ${scenery.join(", ")}` : ""}`;
}

/** Widgets still waiting for an analysis, so a dashboard can say it is unfinished. */
export function unfilledWidgets(widgets: DashboardWidget[]): DashboardWidget[] {
  return widgets.filter((w) => NEEDS_ANALYSIS.has(w.type) && !w.analysisId);
}

/* ------------------------------------------------------------ the built-ins */

const W = (
  type: DashboardWidget["type"], x: number, y: number, w: number, h: number,
  extra: Partial<TemplateWidget> = {},
): TemplateWidget => ({ id: `${type}_${x}_${y}`, type, x, y, w, h, ...extra });

export const BUILT_IN_DASHBOARD_TEMPLATES: DashboardTemplate[] = [
  {
    id: "builtin:cx_overview",
    kind: "dashboard",
    name: "Customer experience overview",
    description: "The shape a CX dashboard usually takes: headline NPS and satisfaction, where the scores are, what drives them, and who is saying it.",
    builtIn: true,
    hero: { title: "Customer experience", subtitle: "{period}", rows: 4, align: "left" },
    bands: [{ id: "cx_band", fromRow: 0, toRow: 2 }],
    widgets: [
      W("kpi", 0, 0, 3, 2, { title: "NPS", placeholder: "Your NPS analysis" }),
      W("kpi", 3, 0, 3, 2, { title: "Satisfaction", placeholder: "Overall satisfaction" }),
      W("kpi", 6, 0, 3, 2, { title: "Effort", placeholder: "CES, if you run one" }),
      W("photo", 9, 0, 3, 2, { title: "", placeholder: "A photograph of the place or product" }),
      W("chart", 0, 2, 6, 4, { title: "Satisfaction by market", chart: { type: "map_country", options: {} }, placeholder: "A measure broken by country or region" }),
      W("ranked_list", 6, 2, 6, 4, { title: "What drives the score", placeholder: "A driver or importance analysis" }),
      W("chart", 0, 6, 8, 4, { title: "Trend", chart: { type: "line", options: {} }, placeholder: "The headline measure over time" }),
      W("icon_panel", 8, 6, 4, 4, { title: "Who answered", icon: "person", placeholder: "A demographic breakdown" }),
      W("table", 0, 10, 12, 4, { title: "Detail", placeholder: "The crosstab behind the headline" }),
    ],
  },
  {
    id: "builtin:ex_overview",
    kind: "dashboard",
    name: "Employee experience",
    description: "Engagement at the top, the item-by-item heat map underneath, and the demographics that explain it — the shape of an EX readout.",
    builtIn: true,
    hero: { title: "Employee experience", subtitle: "{period}", rows: 4, align: "left" },
    widgets: [
      W("kpi", 0, 0, 4, 2, { title: "Engagement", placeholder: "Your engagement index" }),
      W("kpi", 4, 0, 4, 2, { title: "eNPS", placeholder: "Employee NPS" }),
      W("kpi", 8, 0, 4, 2, { title: "Response rate", placeholder: "Participation" }),
      W("table", 0, 2, 12, 5, { title: "Engagement by unit", placeholder: "Items × business unit — the heat map" }),
      W("ranked_list", 0, 7, 6, 4, { title: "Strengths", placeholder: "Highest-scoring items" }),
      W("ranked_list", 6, 7, 6, 4, { title: "Priorities", placeholder: "Lowest-scoring items" }),
      W("icon_panel", 0, 11, 6, 4, { title: "Who answered", icon: "person", placeholder: "A demographic breakdown" }),
      W("steps", 6, 11, 6, 4, {
        title: "What happens next",
        steps: [
          { icon: "flag", title: "Share the results", description: "Managers see their own unit first." },
          { icon: "check", title: "Pick two priorities", description: "Not ten." },
          { icon: "trend_up", title: "Re-measure", description: "The next wave says whether it worked." },
        ],
      }),
    ],
  },
  {
    id: "builtin:brand_tracker",
    kind: "dashboard",
    name: "Brand tracker",
    description: "Funnel at the top, the trend beside it, and competitors underneath — a wave-on-wave brand dashboard.",
    builtIn: true,
    hero: { title: "Brand tracker", subtitle: "{period}", rows: 3, align: "left" },
    widgets: [
      W("kpi", 0, 0, 3, 2, { title: "Awareness", placeholder: "Prompted awareness" }),
      W("kpi", 3, 0, 3, 2, { title: "Consideration", placeholder: "Consideration" }),
      W("kpi", 6, 0, 3, 2, { title: "Usage", placeholder: "Usage / purchase" }),
      W("kpi", 9, 0, 3, 2, { title: "Advocacy", placeholder: "Recommendation" }),
      W("chart", 0, 2, 5, 5, { title: "Brand funnel", chart: { type: "funnel_brand", options: {} }, placeholder: "The funnel analysis" }),
      W("chart", 5, 2, 7, 5, { title: "Awareness over time", chart: { type: "line_multi", options: {} }, placeholder: "A trend by wave" }),
      W("table", 0, 7, 7, 4, { title: "Versus competitors", placeholder: "Brand × measure, with significance" }),
      W("ranked_list", 7, 7, 5, 4, { title: "Brand associations", placeholder: "An image or attribute analysis" }),
    ],
  },
];
