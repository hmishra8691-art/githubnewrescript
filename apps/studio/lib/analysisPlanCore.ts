import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnalysisPlan, SurveyDefinition } from "@rescript/schema";
import { SurveyDefinition as SurveyDefinitionSchema } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, droppedFieldPaths, ensureElementIds, hypothesisCoverage, isAnalysisOp, type SurveyAction } from "@rescript/engine";
import {
  variableMetadata, reportFromRun, planItemViews, planVariableViews, planOverview, planAnalysisSync, planChartSync, planChartSpec, planDashboard, stampedDefinition, summarizeApply, withOrigin, editedSinceApply, plannedIdOf,
  type AnalysisDefinition, type ChartSpec, type DashboardDefinition, type DatasetSpec, type ReportDefinition, type PlanItemView, type ApplyItemResult, type ApplySummary, type SavedAnalysisRow, type SavedChartRow, type StoredRunLike, type HypothesisVerdict,
} from "@rescript/analytics";
import type { LoadedContext, StoredRun } from "./analytics";
import type { AnalysisRun } from "@rescript/analytics";

/**
 * What the service needs from the server-only analytics module, injected so
 * this file stays free of the Next `server-only` chain and a test can drive
 * it with a stub database and a stub runner (the way analyticsRunStore is).
 */
export interface PlanDeps {
  latestRun(db: SupabaseClient, surveyId: string, environment?: DatasetSpec["environment"]): Promise<StoredRun | null>;
  runPlanFor(db: SupabaseClient, surveyId: string, ctx: LoadedContext, opts: { environment?: DatasetSpec["environment"]; dataset?: "all" | "clean"; trigger?: string; userId?: string | null; exclude?: Set<string>; skipEmpty?: boolean }): Promise<{ run: AnalysisRun; stored: StoredRun | null; error?: string }>;
  reportFacts(db: SupabaseClient, surveyId: string, def: SurveyDefinition): Promise<{ client?: string; fieldwork?: { from?: string; to?: string } }>;
}

/**
 * THE ANALYSIS PLAN IN DATA ANALYTICS — the server side (the pure-ish core;
 * `analysisPlanService.ts` binds it to the real runner).
 *
 * The plan lives in the survey definition (`research.analysisPlan`), written
 * in Intelligent mode; this is what Results → Data Analytics does with it:
 *
 *   planPayload   the plan read against the dictionary, the saved analyses,
 *                 the charts, the latest run, the plan's report and
 *                 dashboard, and the last apply — one request, every count
 *                 from stored data
 *   editPlan      analysis actions (the engine's own vocabulary: add /
 *                 update / remove / reorder) applied to the working
 *                 definition and saved as the draft through the same
 *                 conditional write the Studio's autosave uses — so an edit
 *                 here is the same edit Intelligent mode would have made,
 *                 refused the same way when the survey moved on
 *   applyPlan     validate, configure (the saved analyses, one per planned
 *                 id, created once and updated when the plan moved), run on
 *                 the responses when there are any, and keep the charts,
 *                 the dashboard and the findings report current — safe to
 *                 repeat, recorded in analytics_plan_applies
 *
 * The decisions are pure (`planWorkspace` in @rescript/analytics); this file
 * is the reads and writes around them.
 */

const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);
const missingTable = (message: string | undefined): boolean => !!message && /analytics_plan_applies|does not exist|schema cache/i.test(message);

/** a stable hash of the whole plan — what "the plan changed since the apply" is judged against */
export function planHash(plan: AnalysisPlan | undefined): string | null {
  if (!plan) return null;
  const s = JSON.stringify(sortKeys({ crosstabs: plan.crosstabs, tests: plan.tests, derived: plan.derived, segments: plan.segments }));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") { const o = v as Record<string, unknown>; return Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, sortKeys(o[k])])); }
  return v;
}

/* ------------------------------------------------------------ reads */

async function loadRows(db: SupabaseClient, surveyId: string) {
  const [a, c] = await Promise.all([
    db.from("analytics_analyses").select("id, name, kind, version, updated_at, folder, definition").eq("survey_id", surveyId).is("deleted_at", null),
    db.from("analytics_charts").select("id, analysis_id, name, spec, theme_id, style_version").eq("survey_id", surveyId).is("deleted_at", null),
  ]);
  return { analyses: (a.data ?? []) as SavedAnalysisRow[], charts: (c.data ?? []) as SavedChartRow[] };
}

export interface StoredApply {
  id: string; status: string; environment: string; dataset: DatasetSpec | null; planHash: string | null; planUpdatedAt: string | null; surveyRevision: number | null; surveyVersion: string | null;
  runId: string | null; reportId: string | null; dashboardId: string | null; summary: ApplySummary | Record<string, never>; error: string | null; startedAt: string; finishedAt: string | null; createdBy: string | null;
}
const applyFromRow = (r: Record<string, unknown>): StoredApply => ({
  id: String(r.id), status: String(r.status), environment: String(r.environment), dataset: (r.dataset as DatasetSpec | null) ?? null, planHash: (r.plan_hash as string | null) ?? null, planUpdatedAt: (r.plan_updated_at as string | null) ?? null,
  surveyRevision: r.survey_revision == null ? null : Number(r.survey_revision), surveyVersion: (r.survey_version as string | null) ?? null,
  runId: (r.run_id as string | null) ?? null, reportId: (r.report_id as string | null) ?? null, dashboardId: (r.dashboard_id as string | null) ?? null,
  summary: (r.summary as ApplySummary) ?? {}, error: (r.error as string | null) ?? null, startedAt: String(r.started_at), finishedAt: (r.finished_at as string | null) ?? null, createdBy: (r.created_by as string | null) ?? null,
});

/** the latest apply of this survey's plan, or null; `available: false` when the table is not there yet */
export async function latestApply(db: SupabaseClient, surveyId: string, environment?: DatasetSpec["environment"]): Promise<{ apply: StoredApply | null; available: boolean }> {
  /* per environment when asked: an apply on test data says nothing about the live outputs' state */
  let q = db.from("analytics_plan_applies").select("*").eq("survey_id", surveyId);
  if (environment) q = q.eq("environment", environment);
  const { data, error } = await q.order("started_at", { ascending: false }).limit(1);
  if (error) return { apply: null, available: !missingTable(error.message) };
  return { apply: data?.[0] ? applyFromRow(data[0] as Record<string, unknown>) : null, available: true };
}

/** the one report and the one dashboard the apply maintains for this survey */
export async function planOutputs(db: SupabaseClient, surveyId: string): Promise<{ report: Record<string, unknown> | null; dashboard: Record<string, unknown> | null }> {
  const { data } = await db.from("analytics_reports").select("id, kind, name, definition, theme_id, mode, published_version, updated_at, updated_by").eq("survey_id", surveyId).is("deleted_at", null).order("updated_at", { ascending: false });
  const rows = (data ?? []) as Record<string, unknown>[];
  const origin = (r: Record<string, unknown>) => ((r.definition as { origin?: { kind?: string } } | null)?.origin?.kind === "analysis_plan");
  return { report: rows.find((r) => r.kind === "report" && origin(r)) ?? null, dashboard: rows.find((r) => r.kind === "dashboard" && origin(r)) ?? null };
}

export interface HypothesisView { label: string; text: string; status: string; constructs: { name: string; role: string; questions: string[]; measured: boolean }[]; items: string[]; verdict: HypothesisVerdict | null }

/** Everything the Analysis plan workspace shows, from stored data. */
export async function planPayload(db: SupabaseClient, surveyId: string, ctx: LoadedContext, dataset: DatasetSpec, deps: PlanDeps) {
  const def = ctx.def as SurveyDefinition;
  const plan = def.research?.analysisPlan ?? null;
  const [{ analyses, charts }, run, applied, outputs, counts] = await Promise.all([
    loadRows(db, surveyId),
    deps.latestRun(db, surveyId, dataset.environment),
    latestApply(db, surveyId, dataset.environment),
    planOutputs(db, surveyId),
    completeCounts(db, surveyId),
  ]);
  const dictionary = variableMetadata(def).filter((v) => !v.hidden);
  const items = plan ? planItemViews(def, dataset, { dictionary, analyses, charts, run: run as StoredRunLike | null, plan }) : [];
  const variables = plan ? planVariableViews(def, items, dictionary, plan) : [];
  const overview = plan ? planOverview(def, items, variables, plan) : null;
  const hypotheses: HypothesisView[] = hypothesisCoverage(def).map((h) => ({
    label: h.label, text: h.text, status: h.status, constructs: h.constructs,
    items: items.filter((i) => i.hypotheses.includes(h.label)).map((i) => i.id),
    verdict: run?.verdicts.find((v) => v.label === h.label) ?? null,
  }));
  const hash = planHash(plan ?? undefined);
  const apply = applied.apply;
  const outputView = (r: Record<string, unknown> | null) => (r ? {
    id: String(r.id), kind: String(r.kind), name: String(r.name), updatedAt: String(r.updated_at ?? ""), publishedVersion: (r.published_version as number | null) ?? null, mode: String(r.mode ?? "live"),
    editedSinceApply: editedSinceApply(r.definition as ReportDefinition | DashboardDefinition),
    appliedAt: (r.definition as { origin?: { appliedAt?: string } }).origin?.appliedAt ?? null,
    /* which planned item each component came from */
    components: r.kind === "dashboard"
      ? ((r.definition as DashboardDefinition).widgets ?? []).map((w) => ({ id: w.id, type: w.type, title: w.title ?? "", analysisId: w.analysisId ?? null, planned: w.id.startsWith("plan:") && w.id !== "plan:summary" ? w.id.slice(5) : null }))
      : ((r.definition as ReportDefinition).blocks ?? []).map((b) => ({ id: b.id, type: b.type, title: ("title" in b ? b.title : undefined) ?? "", analysisId: "analysisId" in b ? b.analysisId : null, planned: "analysisId" in b && b.analysisId ? plannedIdOf(analyses.find((a) => a.id === b.analysisId)?.definition) : null })),
  } : null);
  return {
    plan, planHash: hash, planUpdatedAt: plan?.updatedAt ?? null, planSource: plan?.source ?? null,
    definition: { source: ctx.source ?? "draft", revision: ctx.revision, version: ctx.version, draftUpdatedAt: ctx.draftUpdatedAt ?? null },
    survey: { objective: def.research?.objective ?? null, hypotheses: def.research?.hypotheses ?? [] },
    dataset, counts,
    items, variables, overview, hypotheses,
    run: run ? { id: run.id, computedAt: run.computedAt, trigger: run.trigger, environment: run.environment, n: run.n, items: run.items.length, findings: run.findings, verdicts: run.verdicts, warnings: run.warnings, discoveries: run.discoveries ?? null, kpis: run.kpis ?? null, since: run.since ?? null } : null,
    apply: apply ? { ...apply, current: !!apply.planHash && apply.planHash === hash && (apply.status === "applied" || apply.status === "partial" || apply.status === "no_data") } : null,
    applyAvailable: applied.available,
    /* the run's data was gathered before responses arrived or after a new wave: say so */
    dataChangedSinceApply: !!apply && !!run && apply.runId === run.id && dataset.dataset === "all" && counts[dataset.environment] > run.n,
    report: outputView(outputs.report), dashboard: outputView(outputs.dashboard),
  };
}

export type PlanPayload = Awaited<ReturnType<typeof planPayload>>;
export type PlanPayloadItem = PlanPayload["items"][number];

async function completeCounts(db: SupabaseClient, surveyId: string): Promise<Record<"LIVE" | "TEST" | "ALL", number>> {
  const one = async (test: boolean) => { const { count } = await db.from("responses").select("id", { count: "exact", head: true }).eq("survey_id", surveyId).is("deleted_at", null).eq("status", "complete").eq("is_test", test); return count ?? 0; };
  const [LIVE, TEST] = await Promise.all([one(false), one(true)]);
  return { LIVE, TEST, ALL: LIVE + TEST };
}

/* ------------------------------------------------------------ editing */

export interface EditPlanInput { actions: unknown; baseRevision?: number | null; userId: string | null }
export type EditPlanOutcome =
  | { ok: true; plan: AnalysisPlan | null; revision: number | null; results: { op: string; ok: boolean; description: string; error?: string }[]; warnings: string[]; savedAt: string }
  | { ok: false; status: number; error: string; results?: { op: string; ok: boolean; description: string; error?: string }[]; conflict?: boolean; revision?: number | null };

/**
 * Edit the plan with analysis actions and save the definition as the draft.
 *
 * Only analysis actions are accepted here — this endpoint edits the plan,
 * not the questionnaire. The write is conditional on the revision the
 * caller read (the Studio's own rule); a survey that moved on refuses the
 * save with 409 and the current revision, and the caller reloads.
 */
export async function editPlan(db: SupabaseClient, surveyId: string, ctx: LoadedContext, input: EditPlanInput): Promise<EditPlanOutcome> {
  const { actions, rejected } = coerceSurveyActions(input.actions, 200);
  const notPlan = actions.filter((a) => !isAnalysisOp(a.op));
  if (notPlan.length) return { ok: false, status: 400, error: `Only analysis-plan actions are accepted here (${notPlan.map((a) => a.op).join(", ")} ${notPlan.length === 1 ? "is" : "are"} not).` };
  if (!actions.length) return { ok: false, status: 400, error: rejected.length ? `No valid action: ${rejected.map((r) => r.reason).join("; ")}` : "No actions." };
  const out = applySurveyActions(ctx.def as SurveyDefinition, actions as SurveyAction[]);
  const results = out.results.map((r) => ({ op: r.op, ok: r.ok, description: r.description, ...(r.error ? { error: r.error } : {}) }));
  if (!out.valid) return { ok: false, status: 422, error: "The edit does not produce a valid survey definition, so nothing was saved.", results };
  if (!out.results.some((r) => r.ok)) return { ok: false, status: 400, error: out.errors.join(" ") || "Nothing could be applied.", results };
  const parsed = SurveyDefinitionSchema.safeParse(out.def);
  if (!parsed.success) return { ok: false, status: 422, error: `The edited definition failed validation: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, results };
  if (droppedFieldPaths(out.def, parsed.data).length) return { ok: false, status: 422, error: "The edited definition would lose fields this server does not know; nothing was saved.", results };
  const definition = ensureElementIds(parsed.data).def;
  const baseRevision = typeof input.baseRevision === "number" && Number.isFinite(input.baseRevision) ? input.baseRevision : ctx.revision;
  if (baseRevision == null) return { ok: false, status: 501, error: "This database has no revision guard (migration 0004), so the plan cannot be saved safely from here. Edit it in Intelligent mode.", results };
  const { data, error } = await db.rpc("rescript_save_draft", { p_survey_id: surveyId, p_definition: definition, p_base_revision: baseRevision, p_base_version_id: ctx.source === "version" ? ctx.versionId ?? null : null, p_title: definition.meta.title });
  if (error) return { ok: false, status: 500, error: error.message, results };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    const { data: cur } = await db.from("surveys").select("revision").eq("id", surveyId).single();
    return { ok: false, status: 409, conflict: true, revision: cur?.revision ?? null, error: "This survey was changed somewhere else after the plan was loaded, so this save was refused rather than overwriting that work. Reload the plan and try again.", results };
  }
  return { ok: true, plan: definition.research?.analysisPlan ?? null, revision: Number(row.revision), results, warnings: out.warnings, savedAt: String(row.draft_updated_at ?? new Date().toISOString()) };
}

/* ------------------------------------------------------------ applying */

export interface ApplyPlanInput { dataset: DatasetSpec; userId: string | null; /** regenerate the findings report even when it was edited by hand */ replaceReport?: boolean }
export interface ApplyPlanOutcome {
  ok: boolean; status: number; error?: string;
  summary?: ApplySummary; applyId?: string | null; runId?: string | null; reportId?: string | null; dashboardId?: string | null;
  report?: { action: "created" | "updated" | "kept_edited" | "none" }; dashboard?: { action: "created" | "updated" | "none" };
  warnings?: string[];
}

/** a run item that produced nothing usable */
const failedResult = (warnings: string[] | undefined): string | null => (warnings ?? []).find((w) => /could not be computed|Unknown analysis kind|is not in this survey's dictionary|needs at least|has no respondents/.test(w)) ?? null;

export async function applyPlan(db: SupabaseClient, surveyId: string, ctx: LoadedContext, input: ApplyPlanInput, deps: PlanDeps): Promise<ApplyPlanOutcome> {
  const def = ctx.def as SurveyDefinition;
  const plan = def.research?.analysisPlan;
  if (!plan) return { ok: false, status: 400, error: "Nothing is planned yet — plan the analysis in Intelligent mode (Analysis tab), or add crosstabs and tests here first." };
  if (!plan.crosstabs.length && !plan.tests.length) return { ok: false, status: 400, error: "The plan has no crosstabs or tests yet, so there is nothing to apply." };
  const dataset = input.dataset;
  const warnings: string[] = [];

  /* the lock: one apply at a time per survey */
  const lock = await beginApply(db, surveyId, { dataset, planHash: planHash(plan), planUpdatedAt: plan.updatedAt ?? null, revision: ctx.revision, version: ctx.version, userId: input.userId });
  if (lock.conflict) return { ok: false, status: 409, error: "The plan is being applied right now — wait for it to finish, then refresh." };
  if (!lock.id) warnings.push("The apply could not be recorded (migration 0050 is not applied); the outputs were still produced.");
  const finish = async (patch: Record<string, unknown>) => { if (lock.id) await db.from("analytics_plan_applies").update({ ...patch, finished_at: new Date().toISOString() }).eq("id", lock.id); };

  try {
    const dictionary = variableMetadata(def).filter((v) => !v.hidden);
    const rows = await loadRows(db, surveyId);
    const items = planItemViews(def, dataset, { dictionary, analyses: rows.analyses, charts: rows.charts, run: null, plan });
    const results = new Map<string, ApplyItemResult>();
    const idFor = new Map<string, string>();

    /* 1. the saved analyses — created once, updated when the plan moved, kept when refined, skipped when invalid */
    for (const s of planAnalysisSync(items, dataset, ctx.version ?? null)) {
      const it = s.item;
      /* `status` is what happens on the data, decided below; until then every configured item is waiting */
      if (s.kind === "skip") { results.set(it.id, { id: it.id, title: it.title, sync: "skipped_invalid", status: "skipped", reason: s.reason, ...(it.analysis ? { analysisId: it.analysis.id } : {}) }); continue; }
      if (s.kind === "keep") { idFor.set(it.id, s.analysisId); results.set(it.id, { id: it.id, title: it.title, sync: s.refined ? "kept_refined" : "unchanged", status: "pending_data", analysisId: s.analysisId }); continue; }
      if (s.kind === "create") {
        const row = { survey_id: surveyId, name: s.definition.name, kind: s.definition.kind, definition: s.definition, version: 1, folder: "Planned", tags: s.tags, created_by: input.userId, updated_by: input.userId };
        const { data, error } = await db.from("analytics_analyses").insert(row).select("id").single();
        if (error || !data) { results.set(it.id, { id: it.id, title: it.title, sync: "skipped_invalid", status: "failed", reason: `The analysis could not be saved: ${error?.message ?? "not saved"}` }); continue; }
        await db.from("analytics_analysis_versions").insert({ analysis_id: data.id, survey_id: surveyId, version: 1, definition: s.definition, summary: `Created by applying the analysis plan${it.reason ? `: ${it.reason}` : ""}`, created_by: input.userId });
        idFor.set(it.id, String(data.id)); results.set(it.id, { id: it.id, title: it.title, sync: "created", status: "pending_data", analysisId: String(data.id) });
        continue;
      }
      /* update: a new version of the same analysis, from the plan */
      const version = (it.analysis?.version ?? 1) + 1;
      const { error } = await db.from("analytics_analyses").update({ name: s.definition.name, kind: s.definition.kind, definition: s.definition, version, tags: s.tags, updated_by: input.userId }).eq("id", s.analysisId).eq("survey_id", surveyId);
      if (error) { results.set(it.id, { id: it.id, title: it.title, sync: "unchanged", status: "failed", reason: `The analysis could not be updated: ${error.message}`, analysisId: s.analysisId }); continue; }
      await db.from("analytics_analysis_versions").insert({ analysis_id: s.analysisId, survey_id: surveyId, version, definition: s.definition, summary: s.summary, created_by: input.userId });
      idFor.set(it.id, s.analysisId); results.set(it.id, { id: it.id, title: it.title, sync: "updated", status: "pending_data", analysisId: s.analysisId });
    }

    /* 2. the data: is there anything to run on? */
    const counts = await completeCounts(db, surveyId);
    const available = counts[dataset.environment];
    const runnable = items.filter((i) => idFor.has(i.id));
    let stored: StoredRun | null = null;
    let runItems: { definition: AnalysisDefinition; chart?: ChartSpec["type"]; result?: { warnings: string[] } }[] = [];
    let n = 0;
    if (available > 0 && runnable.length) {
      const exclude = new Set(items.filter((i) => !idFor.has(i.id)).map((i) => i.id));
      const r = await deps.runPlanFor(db, surveyId, ctx, { environment: dataset.environment, dataset: dataset.dataset === "clean" ? "clean" : "all", trigger: "apply", userId: input.userId, exclude, skipEmpty: true });
      if (r.error && !r.stored) warnings.push(`The run was not stored: ${r.error}`);
      stored = r.stored; n = r.run.n;
      runItems = r.run.items.map((it) => ({ definition: it.definition, ...(it.chart ? { chart: it.chart } : {}), result: { warnings: it.result.warnings } }));
      for (const it of r.run.items) {
        const id = plannedIdOf(it.definition); if (!id || it.adaptedFrom) continue;
        const cur = results.get(id); if (!cur) continue;
        const failed = n === 0 ? null : failedResult(it.result.warnings);
        results.set(id, failed ? { ...cur, status: "failed", reason: failed } : n === 0 ? { ...cur, status: "pending_data" } : { ...cur, status: "run" });
      }
      if (n === 0) warnings.push(dataset.dataset === "clean" ? "No complete responses pass the quality engine, so nothing was computed." : "No complete responses in the chosen dataset, so nothing was computed.");
    }

    /* 3. the charts — one per planned item, typed as the run recommends */
    const chartsNow = (await loadRows(db, surveyId)).charts;
    let chartCount = 0;
    for (const c of planChartSync(items, (id) => idFor.get(id), chartsNow, runItems)) {
      if (c.action === "keep") { chartCount++; const cur = results.get(c.item.id); if (cur && c.existing) results.set(c.item.id, { ...cur, chartId: c.existing.id }); continue; }
      if (c.action === "retype" && c.existing) {
        const { error } = await db.from("analytics_charts").update({ spec: { ...c.existing.spec, type: c.type }, updated_by: input.userId }).eq("id", c.existing.id).eq("survey_id", surveyId);
        if (error) warnings.push(`Chart for ${c.item.title}: ${error.message}`); else { chartCount++; const cur = results.get(c.item.id); if (cur) results.set(c.item.id, { ...cur, chartId: c.existing.id }); }
        continue;
      }
      const spec = planChartSpec(c.item, c.type);
      const { data, error } = await db.from("analytics_charts").insert({ survey_id: surveyId, analysis_id: c.analysisId, name: c.item.title.slice(0, 160), spec, theme_id: null, created_by: input.userId, updated_by: input.userId }).select("id").single();
      if (error || !data) { warnings.push(`Chart for ${c.item.title}: ${error?.message ?? "not saved"}`); continue; }
      chartCount++; const cur = results.get(c.item.id); if (cur) results.set(c.item.id, { ...cur, chartId: String(data.id) });
    }
    const chartSpecs = new Map<string, ChartSpec>();
    for (const c of (await loadRows(db, surveyId)).charts) { const id = c.spec?.id; if (typeof id === "string" && id.startsWith("plan:")) chartSpecs.set(id.slice(5), c.spec); }

    /* 4. the dashboard — configured whether or not there is data; widgets fill when the data does */
    const outputs = await planOutputs(db, surveyId);
    const appliedAt = new Date().toISOString();
    const title = `${def.research?.objective ? def.research.objective.slice(0, 80) : def.meta.title} — analysis plan`;
    const existingDash = outputs.dashboard ? (outputs.dashboard.definition as DashboardDefinition) : null;
    const dashDef = withOrigin(planDashboard(existingDash, title, items, { analysisIdFor: (id) => idFor.get(id), chartSpecFor: (id) => chartSpecs.get(id), run: stored as StoredRunLike | null }), { kind: "analysis_plan", appliedAt, runId: stored?.id ?? null });
    let dashboardId: string | null = outputs.dashboard ? String(outputs.dashboard.id) : null;
    let dashboardAction: "created" | "updated" | "none" = "none";
    if (dashboardId) {
      const { error } = await db.from("analytics_reports").update({ definition: dashDef, updated_by: input.userId }).eq("id", dashboardId).eq("survey_id", surveyId);
      if (error) warnings.push(`Dashboard: ${error.message}`); else dashboardAction = "updated";
    } else {
      const { data, error } = await db.from("analytics_reports").insert({ survey_id: surveyId, kind: "dashboard", name: title.slice(0, 160), definition: dashDef, theme_id: null, mode: "live", created_by: input.userId, updated_by: input.userId }).select("id").single();
      if (error || !data) warnings.push(`Dashboard: ${error?.message ?? "not saved"}`); else { dashboardId = String(data.id); dashboardAction = "created"; }
    }

    /* 5. the findings report — from the run, so only when there is one; a report the researcher edited is left alone unless told otherwise */
    let reportId: string | null = outputs.report ? String(outputs.report.id) : null;
    let reportAction: "created" | "updated" | "kept_edited" | "none" = "none";
    if (stored && n > 0) {
      const existing = outputs.report ? (outputs.report.definition as ReportDefinition) : null;
      if (existing && editedSinceApply(existing) && !input.replaceReport) reportAction = "kept_edited";
      else {
        const facts = await deps.reportFacts(db, surveyId, def);
        const fresh = reportFromRun(def, stored as never, { analysisIdFor: (planned) => (planned ? idFor.get(planned) : undefined), ...facts, ...(existing ? { title: existing.title } : {}) });
        const reportDef = withOrigin({ ...fresh, ...(existing ? { themeId: existing.themeId, viewerSegments: existing.viewerSegments, viewerFilters: existing.viewerFilters, filterId: existing.filterId, branding: existing.branding, exportDefaults: existing.exportDefaults } : {}) } as ReportDefinition, { kind: "analysis_plan", appliedAt, runId: stored.id });
        if (reportId) {
          const { error } = await db.from("analytics_reports").update({ definition: reportDef, name: reportDef.title.slice(0, 160), updated_by: input.userId }).eq("id", reportId).eq("survey_id", surveyId);
          if (error) warnings.push(`Report: ${error.message}`); else reportAction = "updated";
        } else {
          const { data, error } = await db.from("analytics_reports").insert({ survey_id: surveyId, kind: "report", name: reportDef.title.slice(0, 160), definition: reportDef, theme_id: null, mode: "live", created_by: input.userId, updated_by: input.userId }).select("id").single();
          if (error || !data) warnings.push(`Report: ${error?.message ?? "not saved"}`); else { reportId = String(data.id); reportAction = "created"; }
        }
      }
    }

    const summary = summarizeApply(dataset.environment, n, [...results.values()], { charts: chartCount, planned: items.length });
    await finish({ status: summary.status === "nothing_planned" ? "failed" : summary.status, run_id: stored?.id ?? null, report_id: reportId, dashboard_id: dashboardId, summary: { ...summary, warnings, report: reportAction, dashboard: dashboardAction } });
    return { ok: true, status: 200, summary, applyId: lock.id, runId: stored?.id ?? null, reportId, dashboardId, report: { action: reportAction }, dashboard: { action: dashboardAction }, warnings };
  } catch (e) {
    const message = (e as Error).message;
    await finish({ status: "failed", error: message });
    return { ok: false, status: 500, error: `The plan could not be applied: ${message}`, warnings };
  }
}

/** insert the running row, refusing when one is already running */
async function beginApply(db: SupabaseClient, surveyId: string, meta: { dataset: DatasetSpec; planHash: string | null; planUpdatedAt: string | null; revision: number | null; version: string | null; userId: string | null }): Promise<{ id: string | null; conflict: boolean }> {
  const since = new Date(Date.now() - 2 * 60_000).toISOString();
  const { data: running, error: readError } = await db.from("analytics_plan_applies").select("id").eq("survey_id", surveyId).eq("status", "running").gte("started_at", since).limit(1);
  if (readError) { if (missingTable(readError.message)) return { id: null, conflict: false }; throw new Error(readError.message); }
  if (running?.length) return { id: null, conflict: true };
  const { data, error } = await db.from("analytics_plan_applies").insert({ survey_id: surveyId, status: "running", environment: meta.dataset.environment, dataset: meta.dataset, plan_hash: meta.planHash, plan_updated_at: meta.planUpdatedAt, survey_revision: meta.revision, survey_version: meta.version, created_by: meta.userId }).select("id").single();
  if (error) { if (missingTable(error.message)) return { id: null, conflict: false }; throw new Error(error.message); }
  return { id: String(data.id), conflict: false };
}

/** the apply's own view of one planned item, for a route that wants to retry a single one */
export const itemById = (items: PlanItemView[], id: string) => items.find((i) => i.id === id) ?? null;
export { stampedDefinition, isUuid };
