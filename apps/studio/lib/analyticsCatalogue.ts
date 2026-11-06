import type { SupabaseClient } from "@supabase/supabase-js";
import type { SurveyDefinition } from "@rescript/schema";
import { buildCatalogue, variableMetadata, type AnalysisCatalogue, type DatasetSpec, type SavedAnalysisRow, type SavedChartRow } from "@rescript/analytics";
import type { LoadedContext } from "./analytics";
import { planPayload } from "./analysisPlanService";
import type { PlanPayload } from "./analysisPlanCore";
import { loadRows as loadQualRows } from "./qual/qualStore";
import { codingState } from "./qual/qualWorkspace";

/**
 * THE ARCHITECT'S EXPLORER, from the server (Analytics Architect Mode, AA1).
 *
 * One payload: the plan workspace's own payload (items, hypotheses, the latest run) plus the saved analyses and
 * charts, every report and dashboard of the survey (not only the plan's two), and the qualitative phase's
 * reviewed themes — folded by `buildCatalogue` into the tree the Explorer shows, with research labels. The plan
 * payload is returned beside the catalogue so the Architect's workspace needs one request, not two.
 */
export interface CataloguePayload { catalogue: AnalysisCatalogue; plan: PlanPayload }

export async function cataloguePayload(db: SupabaseClient, surveyId: string, ctx: LoadedContext, dataset: DatasetSpec): Promise<CataloguePayload> {
  const def = ctx.def as SurveyDefinition;
  const [plan, rows, outputs, qual] = await Promise.all([
    planPayload(db, surveyId, ctx, dataset),
    Promise.all([
      db.from("analytics_analyses").select("id, name, kind, version, updated_at, folder, definition").eq("survey_id", surveyId).is("deleted_at", null).order("updated_at", { ascending: false }),
      db.from("analytics_charts").select("id, analysis_id, name, spec, theme_id, style_version").eq("survey_id", surveyId).is("deleted_at", null),
    ]),
    db.from("analytics_reports").select("id, kind, name, updated_at, definition, published_version").eq("survey_id", surveyId).is("deleted_at", null).order("updated_at", { ascending: false }),
    /* the qual tables may not exist on an older database: themes are then simply absent */
    loadQualRows(db, surveyId).catch(() => null),
  ]);
  const analyses = (rows[0].data ?? []) as SavedAnalysisRow[];
  const charts = (rows[1].data ?? []) as SavedChartRow[];
  const d = plan.run?.discoveries ?? null;
  const discoveries = d ? [...d.segments, ...d.trends, ...d.anomalies].map((f) => ({ kind: f.kind, headline: f.headline, detail: f.detail })) : [];
  const catalogue = buildCatalogue({
    def, dictionary: variableMetadata(def).filter((v) => !v.hidden),
    analyses, charts, planItems: plan.items, hypotheses: plan.hypotheses, findings: plan.run?.findings ?? [],
    outputs: (outputs.data ?? []) as never,
    qualThemes: qual ? codingState(qual.coding).state.codebook.themes : [],
    discoveries,
  });
  return { catalogue, plan };
}
