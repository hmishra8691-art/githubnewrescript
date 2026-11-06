import type { SupabaseClient } from "@supabase/supabase-js";
import type { SurveyDefinition } from "@rescript/schema";
import { defaultCuts } from "@rescript/engine";
import { buildOverview, reportNarrative, variableMetadata, type AnalysisDefinition, type ChartData, type DatasetSpec, type NarrativeSections, type Overview } from "@rescript/analytics";
import { compute, latestRun, variablesPayload, type LoadedContext } from "./analytics";
import { gatedNarrativeFor } from "./analyticsNarrative";
import { researchVariable, namingContext } from "@rescript/analytics";
import { loadRows as loadQualRows } from "./qual/qualStore";
import { codingState } from "./qual/qualWorkspace";
import type { AuthedUser } from "./guard";

/**
 * THE OVERVIEW PAYLOAD (Analytics upgrade M2) — one request for the executive dashboard.
 *
 *   overview      the engine's reading of the latest run (packages/analytics overview.ts)
 *   counts        completes per environment, the survey version
 *   sample        who answered: the first demographic cuts of the questionnaire, each as a distribution (a
 *                 descriptive analysis through the same compute path everything else uses)
 *   quality       the data-quality analysis's summary rows (speeders, duplicates, quality classes)
 *   themes        the qualitative phase's reviewed themes, when there are any
 *   summary       the executive summary: the engine's words always; the model's, through the gate, when asked
 *                 for (`narrative`) and available — `gate` says which is shown
 *
 * Nothing is computed in the browser and nothing here is a placeholder: a section with no data says so.
 */
export interface SampleCut { variable: string; label: string; n: number; chart: ChartData }
export interface OverviewPayload {
  overview: Overview;
  counts: Record<string, number>;
  surveyVersion: string | null;
  dataset: DatasetSpec;
  sample: SampleCut[];
  quality: { metric: string; value: string }[] | null;
  themes: { id: string; name: string; status: string }[];
  summary: { engine: string | null; model: NarrativeSections | null; gate: string; source: "model" | "engine" };
  hasPlan: boolean;
}

export async function overviewPayload(db: SupabaseClient, surveyId: string, ctx: LoadedContext, dataset: DatasetSpec, user: AuthedUser | null, opts: { narrative?: boolean } = {}): Promise<OverviewPayload> {
  const def = ctx.def as SurveyDefinition;
  const [vars, run, qual] = await Promise.all([
    variablesPayload(db, surveyId, ctx),
    latestRun(db, surveyId, dataset.environment),
    loadQualRows(db, surveyId).catch(() => null),
  ]);
  const overview = buildOverview(def, run);
  const naming = namingContext(def, variableMetadata(def).filter((v) => !v.hidden));
  const haveData = (vars.counts[dataset.environment] ?? 0) > 0 || (dataset.environment === "ALL" && Object.values(vars.counts).some((n) => n > 0));

  /* who answered: up to four demographic cuts, each a descriptive through compute() (cached like everything else) */
  const cuts = defaultCuts(def).slice(0, 4);
  const sample: SampleCut[] = [];
  if (haveData) {
    for (const v of cuts) {
      const d: AnalysisDefinition = { name: `Who answered: ${v}`, kind: "descriptive", dataset, variables: [v] };
      try {
        const r = await compute(db, surveyId, ctx, d);
        if (r.chart.categories?.length && r.chart.series?.length) sample.push({ variable: v, label: researchVariable(v, naming).researchLabel, n: r.base.n, chart: { categories: r.chart.categories, series: r.chart.series.slice(0, 1) } });
      } catch { /* a cut that cannot be described is left out */ }
    }
  }

  /* data quality: the summary table of the quality analysis */
  let quality: OverviewPayload["quality"] = null;
  if (haveData) {
    try {
      const r = await compute(db, surveyId, ctx, { name: "Data quality", kind: "quality", dataset, variables: [] });
      const t = r.tables.find((x) => x.id === "summary");
      if (t) quality = t.rows.map((row) => ({ metric: String(row.m ?? ""), value: String(row.v ?? "") }));
    } catch { quality = null; }
  }

  const themes = qual ? codingState(qual.coding).state.codebook.themes.filter((t) => !t.parentId && t.status !== "rejected").map((t) => ({ id: t.id, name: t.name, status: t.status })) : [];

  /* the executive summary: the engine's words always; the model's through the gate when asked and available */
  let summary: OverviewPayload["summary"] = { engine: null, model: null, gate: "no run yet", source: "engine" };
  if (run) {
    const engine = reportNarrative(def, run as never).summary;
    summary = { engine, model: null, gate: "the engine's words", source: "engine" };
    if (opts.narrative) {
      const g = await gatedNarrativeFor(user, db, surveyId, run, { audience: "executive", operation: "overview_summary" });
      summary = { engine, model: g.narrative, gate: g.gate, source: g.source };
    }
  }

  return { overview, counts: vars.counts, surveyVersion: vars.surveyVersion, dataset, sample, quality, themes, summary, hasPlan: !!(def.research?.analysisPlan && (def.research.analysisPlan.crosstabs.length || def.research.analysisPlan.tests.length)) };
}
