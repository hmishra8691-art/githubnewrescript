import type { AnalysisPlan, PlannedCrosstab, PlannedTest, SurveyDefinition } from "@rescript/schema";
import { isNonQuestionVariable, inferQuestionAnalysis, planItemTitle, planScope, planTierOf, reviewAnalysisPlan, sampleSizeReview, segmentVariableName, type AnalysisPlanIssue, type PlanTier } from "@rescript/engine";
import type { AnalysisDefinition, ChartSpec, ChartType, DashboardDefinition, DashboardWidget, DatasetSpec, OutputOrigin, ReportDefinition } from "./types.js";
import type { VariableMeta } from "./dataset.js";
import { hashDefinition } from "./analyses/common.js";
import { plannedAnalyses, type PlannedAnalysis } from "./planBridge.js";
import { surveyKnownNames, validateAnalysis } from "./planCheck.js";
import type { AnalysisRun, Finding, RunItem } from "./findings.js";
import { briefText } from "./findings.js";
import { firstFreeSlot, normalizeLayout } from "./dashboardLayout.js";

/**
 * THE ANALYSIS PLAN AS DATA ANALYTICS SHOWS AND APPLIES IT.
 *
 * The plan is written in the survey definition (`research.analysisPlan`,
 * Intelligent → Analysis) and `planBridge` turns it into analysis
 * definitions. This module is the pure part of everything Data Analytics
 * does with it beyond that:
 *
 *   - reads the plan against the variable dictionary, the saved analyses,
 *     the saved charts and the latest run into ONE VIEW per planned item —
 *     what it is, what it reads, whether it is configured, whether its saved
 *     analysis still matches the plan, what the run found for it;
 *   - decides what "apply the plan" must create or update so that applying
 *     the same plan twice changes nothing (the planned id is the identity of
 *     every output, and a hash of the planned definition says whether the
 *     plan moved since the output was last written);
 *   - lays the plan's charts out on the one dashboard the apply maintains,
 *     keeping whatever the researcher moved or added by hand.
 *
 * Nothing here reads a database or a response: the Studio's analytics
 * service feeds it rows and stores what it decides.
 */

/* ------------------------------------------------------------ identity */

/** the plan item behind a saved analysis, chart or widget — `options.planned` */
export const plannedIdOf = (def: AnalysisDefinition | null | undefined): string | null => {
  const p = def?.options?.planned;
  return typeof p === "string" && p ? p : null;
};

/**
 * The plan-derived definition, hashed without the parts the apply chooses
 * (the dataset) or stamps (the hash itself, the survey version). Two applies
 * of an unchanged plan produce the same hash; an edit to the planned item —
 * other columns, another measure, a different grouping — does not.
 */
export function plannedHash(def: AnalysisDefinition): string {
  const { plannedHash: _h, plannedReads: _r, ...options } = (def.options ?? {}) as Record<string, unknown>;
  void _h; void _r;
  const { dataset: _d, surveyVersion: _v, id: _i, version: _n, ...rest } = def;
  void _d; void _v; void _i; void _n;
  return fnv(JSON.stringify(sortKeys({ ...rest, options })));
}

/** FNV-1a over a canonical JSON — key order never makes two equal values differ */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") { const o = v as Record<string, unknown>; return Object.fromEntries(Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => [k, sortKeys(o[k])])); }
  return v;
}

/** the saved analysis's record of the plan it was last written from */
export const savedPlannedHash = (def: AnalysisDefinition | null | undefined): string | null => {
  const h = def?.options?.plannedHash;
  return typeof h === "string" && h ? h : null;
};

/** the record of what the item's variables and hypotheses were when the analysis was last written from the plan (audit P-6) */
export const savedPlannedReads = (def: AnalysisDefinition | null | undefined): string | null => {
  const h = def?.options?.plannedReads;
  return typeof h === "string" && h ? h : null;
};

/**
 * WHAT A PLAN ITEM'S RESULT DEPENDS ON BEYOND ITS OWN DEFINITION (audit P-6).
 * The item's definition names variables; it does not say what they ARE. Retype
 * a question (a rating becomes a category list), reorder or relabel its
 * answers, or reword a hypothesis the item serves, and the saved analysis
 * still matches the plan — yet it no longer says what it was written to say.
 * This hash covers exactly the variables the item reads (through a derived
 * variable, the items it is built from) and the hypotheses it serves, so a
 * change touches the items that read it and no others.
 */
export function planReadsHash(def: SurveyDefinition, plan: AnalysisPlan | undefined, variables: readonly string[], hypotheses: readonly string[], dictionary: readonly VariableMeta[]): string {
  const byName = new Map(dictionary.map((v) => [v.name, v]));
  const spec = (name: string, depth = 0): unknown => {
    const m = byName.get(name);
    if (m) return { n: name, r: m.role, t: m.questionType ?? null, c: (m.categories ?? []).map((c) => [c.code, c.label]), h: m.hidden || undefined };
    const d = plan?.derived.find((x) => x.name === name);
    if (d) return { n: name, derived: d.kind, expression: d.expression ?? null, from: depth < 4 ? d.from.map((f) => spec(f, depth + 1)) : d.from };
    const calc = (def.calculations ?? []).find((c) => c.targetVariable === name);
    if (calc) return { n: name, calculation: JSON.stringify(calc) };
    return { n: name, absent: true };
  };
  const texts = hypotheses.map((label) => { const i = Number(/\d+/.exec(label)?.[0]) - 1; return [label, def.research?.hypotheses[i] ?? null]; });
  return fnv(JSON.stringify(sortKeys({ v: [...variables].sort().map((n) => spec(n)), h: texts })));
}

/* ------------------------------------------------------------ the view */

export type PlanItemState =
  /** in the plan, no saved analysis yet */
  | "planned"
  /** a variable it reads is not in the survey (or it fails the plan review) — it will not run */
  | "invalid"
  /** a saved analysis exists and matches the plan */
  | "configured"
  /** the plan changed after the saved analysis was written from it — the next apply updates the analysis */
  | "stale"
  /** the researcher edited the saved analysis in Analytics; the plan is unchanged, so the edit is kept */
  | "refined";

export interface PlanItemIssue { level: AnalysisPlanIssue["level"]; message: string; suggestion?: string }

export interface SavedAnalysisRow { id: string; name: string; kind: string; version: number; updated_at?: string | null; folder?: string | null; definition: AnalysisDefinition }
export interface SavedChartRow { id: string; analysis_id: string; name: string; spec: ChartSpec; theme_id?: string | null; style_version?: number }

/** a stored run's item, as `compactRun` keeps it (no result) */
export type StoredRunItem = Omit<RunItem, "result"> & { result?: unknown };
export interface StoredRunLike { id?: string; computedAt: string; trigger: string; environment: DatasetSpec["environment"]; n: number; items: StoredRunItem[]; findings: Finding[]; warnings: string[]; verdicts: AnalysisRun["verdicts"]; discoveries?: AnalysisRun["discoveries"]; kpis?: AnalysisRun["kpis"]; since?: AnalysisRun["since"] }

export interface PlanItemView {
  id: string;
  kind: "crosstab" | "test";
  title: string;
  /** the method, for a test; "crosstab" for a crosstab */
  method: string;
  priority: number;
  hypotheses: string[];
  reason?: string;
  /** every variable it reads, in the plan's own names */
  variables: string[];
  /** variables it reads that the run would not have */
  missing: string[];
  /** the definition the plan derives — what the apply saves (dataset-less until applied) */
  derived: AnalysisDefinition;
  hash: string;
  /** a hash of the variables it reads (as the dictionary describes them) and the hypotheses it serves — what the saved analysis was written against */
  readsHash: string;
  issues: PlanItemIssue[];
  state: PlanItemState;
  /** why it is stale, when the plan did not change but what it reads did */
  staleBecause?: string;
  /** essential (answers a hypothesis or what the design demands), recommended or exploratory */
  tier: PlanTier;
  /** false when the plan's cap leaves it out of "apply" — it is listed under "not shown" instead of silently dropped */
  inScope: boolean;
  analysis?: { id: string; name: string; version: number; updatedAt: string | null; hash: string | null; definitionHash: string };
  chart?: { id: string; type: ChartType; name: string; /** the saved chart as the researcher styled it — the plan's own pages draw from this, not from a fresh default (audit P-10) */ spec: ChartSpec; styleVersion: number };
  /** what the latest run made of it */
  run?: { findings: Finding[]; chart?: ChartType; significant: number; adaptedFrom?: string };
  /** the raw plan item, for the editor */
  item: PlannedCrosstab | PlannedTest;
}

export interface PlanVariableView {
  name: string;
  label: string;
  /** question | derived | segment | calculation | embedded | missing */
  kind: "question" | "derived" | "segment" | "calculation" | "embedded" | "missing";
  questionId?: string;
  questionCode?: string;
  questionType?: string;
  role?: string;
  measurement?: string;
  categories?: { code: string; label: string }[];
  construct?: string;
  hypotheses: string[];
  crosstabs: string[];
  tests: string[];
  warnings: string[];
}

export interface PlanOverview {
  crosstabs: number;
  tests: number;
  derived: number;
  segments: number;
  hypotheses: number;
  variables: number;
  missingVariables: number;
  configured: number;
  stale: number;
  refined: number;
  invalid: number;
  charts: number;
  /** items the latest run produced findings for */
  run: number;
  /** items by tier, and the ones the cap leaves out of "apply" */
  tiers: Record<PlanTier, number>;
  notShown: { id: string; title: string; tier: PlanTier; why: string }[];
  attention: { id: string; title: string; why: string }[];
}

const names = (t: PlannedTest): string[] => [...new Set([t.outcome, ...t.variables, t.groupBy, t.moderator, t.mediator].filter((v): v is string => !!v))];
const words = (m: string) => m.replace(/_/g, " ");

/** does the run know this name — a dictionary variable, or one the plan computes */
function known(def: SurveyDefinition, dictionary: Set<string>, name: string, plan: AnalysisPlan): boolean {
  return dictionary.has(name) || def.questions.some((q) => q.variableName === name || q.code === name) || isNonQuestionVariable(def, name, plan);
}

/** the issues of the plan review that are about this item */
function issuesFor(all: AnalysisPlanIssue[], item: PlannedCrosstab | PlannedTest): PlanItemIssue[] {
  const id = item.id;
  const reason = item.reason;
  return all.filter((i) => i.itemId === id || i.message.includes(` ${id} `) || i.message.includes(` ${id},`) || i.message.endsWith(` ${id}.`) || (reason && i.message.includes(`“${reason}”`)))
    .map((i) => ({ level: i.level, message: i.message, ...(i.suggestion ? { suggestion: i.suggestion } : {}) }));
}

/**
 * One view per planned crosstab and test. `dataset` is what the derived
 * definitions carry; the rows are the survey's saved analyses and charts
 * (every one, not only the plan's — the planned id in `options.planned` is
 * what links them) and the latest run.
 */
export function planItemViews(def: SurveyDefinition, dataset: DatasetSpec, ctx: { dictionary: VariableMeta[]; analyses: SavedAnalysisRow[]; charts: SavedChartRow[]; run?: StoredRunLike | null; plan?: AnalysisPlan }): PlanItemView[] {
  const plan = ctx.plan ?? def.research?.analysisPlan;
  if (!plan) return [];
  const dictionary = new Set(ctx.dictionary.map((v) => v.name));
  const knownNames = surveyKnownNames(def, ctx.dictionary);
  const review = [...reviewAnalysisPlan({ ...def, research: { ...def.research!, analysisPlan: plan } }), ...sampleSizeReview(def, plan)];
  const planned = plannedAnalyses(def, dataset, { plan, primaries: false });
  const byPlanned = new Map<string, PlannedAnalysis>();
  for (const p of planned) { const id = plannedIdOf(p.definition); if (id) byPlanned.set(id, p); }
  const analysisByPlanned = new Map<string, SavedAnalysisRow>();
  for (const a of ctx.analyses) { const id = plannedIdOf(a.definition); if (id && !analysisByPlanned.has(id)) analysisByPlanned.set(id, a); }
  const chartsByAnalysis = new Map<string, SavedChartRow[]>();
  for (const c of ctx.charts) { const list = chartsByAnalysis.get(c.analysis_id) ?? []; list.push(c); chartsByAnalysis.set(c.analysis_id, list); }
  const runByPlanned = new Map<string, StoredRunItem>();
  for (const it of ctx.run?.items ?? []) { const id = plannedIdOf(it.definition); if (id && !it.adaptedFrom && !runByPlanned.has(id)) runByPlanned.set(id, it); }

  /* what the cap applies: every essential item, the rest by tier — and whatever already has a saved analysis stays */
  const scope = planScope(plan, { keep: new Set(analysisByPlanned.keys()) });
  const view = (item: PlannedCrosstab | PlannedTest, kind: "crosstab" | "test"): PlanItemView => {
    const p = byPlanned.get(item.id);
    const variables = kind === "crosstab" ? [...new Set([...(item as PlannedCrosstab).rows, ...(item as PlannedCrosstab).columns])] : names(item as PlannedTest);
    const missing = variables.filter((v) => !known(def, dictionary, v, plan));
    const derived = p?.definition ?? { name: planItemTitle(def, item), kind: "crosstab" as const, dataset, variables, options: { planned: item.id } };
    const hash = plannedHash(derived);
    const issues = issuesFor(review, item);
    /* the plan review says the same thing about a dead variable in its own words — keep one */
    if (missing.length) for (let i = issues.length - 1; i >= 0; i--) if (missing.some((m) => issues[i].message.includes(m))) issues.splice(i, 1);
    if (missing.length) issues.unshift({ level: "critical", message: `Reads ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not in this survey's data.`, suggestion: "Change the variable, or remove the item from the plan." });
    /* ONE VALIDATOR (audit P-13): what "create the planned analyses" refuses (a shape the runner cannot compute) is invalid here too, so the apply and that button agree */
    for (const i of validateAnalysis(derived, ctx.dictionary, knownNames).filter((x) => x.severity === "error" && x.code !== "unknown_variable")) issues.push({ level: "critical", message: i.message });
    const saved = analysisByPlanned.get(item.id);
    const chartRow = saved ? (chartsByAnalysis.get(saved.id) ?? []).find((c) => c.spec?.id === `plan:${item.id}`) ?? (chartsByAnalysis.get(saved.id) ?? [])[0] : undefined;
    const runItem = runByPlanned.get(item.id);
    const invalid = missing.length > 0 || issues.some((i) => i.level === "critical");
    const readsHash = planReadsHash(def, plan, variables, item.hypotheses, ctx.dictionary);
    let state: PlanItemState = "planned";
    let staleBecause: string | undefined;
    if (invalid) state = "invalid";
    else if (saved) {
      const savedHash = savedPlannedHash(saved.definition);
      const matches = plannedHash({ ...saved.definition, name: derived.name }) === hash;
      state = matches ? "configured" : savedHash && savedHash !== hash ? "stale" : "refined";
      /* the plan did not move, but a variable it reads or a hypothesis it serves did — only this item's analysis is out of date (an analysis written before this was recorded is left alone) */
      const savedReads = savedPlannedReads(saved.definition);
      if (state !== "stale" && savedReads && savedReads !== readsHash) { state = "stale"; staleBecause = "a variable it reads, or a hypothesis it serves, changed since it was written"; }
    }
    return {
      id: item.id, kind, title: derived.name, method: kind === "crosstab" ? "crosstab" : words((item as PlannedTest).method), priority: item.priority, hypotheses: item.hypotheses,
      ...(item.reason ? { reason: item.reason } : {}), variables, missing, derived, hash, readsHash, issues, state, ...(staleBecause ? { staleBecause } : {}), tier: planTierOf(item), inScope: scope.inScope.has(item.id),
      ...(saved ? { analysis: { id: saved.id, name: saved.name, version: saved.version, updatedAt: saved.updated_at ?? null, hash: savedPlannedHash(saved.definition), definitionHash: hashDefinition(saved.definition) } } : {}),
      ...(chartRow ? { chart: { id: chartRow.id, type: chartRow.spec.type, name: chartRow.name, spec: chartRow.spec, styleVersion: chartRow.style_version ?? 1 } } : {}),
      ...(runItem ? { run: { findings: runItem.findings, ...(runItem.chart ? { chart: runItem.chart } : {}), significant: runItem.findings.filter((f) => f.significant).length, ...(runItem.adaptedFrom ? { adaptedFrom: runItem.adaptedFrom } : {}) } } : {}),
      item,
    };
  };
  return [...plan.crosstabs.map((x) => view(x, "crosstab")), ...plan.tests.map((t) => view(t, "test"))];
}

/** Every variable the plan reads, with what it is and what reads it. */
export function planVariableViews(def: SurveyDefinition, items: PlanItemView[], dictionary: VariableMeta[], plan = def.research?.analysisPlan): PlanVariableView[] {
  const byName = new Map(dictionary.map((v) => [v.name, v]));
  const out = new Map<string, PlanVariableView>();
  const touch = (name: string): PlanVariableView => {
    let v = out.get(name);
    if (v) return v;
    const meta = byName.get(name);
    const q = def.questions.find((x) => x.variableName === name || x.code === name) ?? (meta?.questionId ? def.questions.find((x) => x.id === meta.questionId) : undefined);
    const a = q ? inferQuestionAnalysis(def, q) : null;
    const derived = plan?.derived.find((d) => d.name === name);
    const segment = plan?.segments.find((s) => s.name === name || segmentVariableName(s) === name);
    const calc = (def.calculations ?? []).find((c) => c.targetVariable === name);
    const kind: PlanVariableView["kind"] = q ? "question" : derived ? "derived" : segment ? "segment" : calc ? "calculation" : meta ? "embedded" : isNonQuestionVariable(def, name, plan) ? "embedded" : "missing";
    v = {
      name, label: meta?.label ?? q?.text ?? (derived ? `${words(derived.kind)} of ${derived.from.join(", ")}` : segment ? `Segment by ${segment.by.join(" × ")}` : name), kind,
      ...(q ? { questionId: q.id, questionCode: q.code, questionType: q.type } : {}),
      ...(a ? { role: a.role, measurement: a.measurement, ...(a.construct ? { construct: a.construct } : {}) } : {}),
      ...(meta?.categories ? { categories: meta.categories } : q?.options?.length ? { categories: q.options.map((o) => ({ code: String(o.code), label: o.label })) } : {}),
      hypotheses: a?.hypotheses ?? [], crosstabs: [], tests: [], warnings: [],
    };
    if (kind === "missing") v.warnings.push("Not in this survey's data — the question may have been deleted or renamed. Change or remove the items that read it.");
    if (derived && derived.from.some((f) => !byName.has(f) && !def.questions.some((x) => x.variableName === f || x.code === f))) v.warnings.push(`Built from ${derived.from.filter((f) => !byName.has(f)).join(", ")}, which the survey does not have.`);
    if (meta?.hidden) v.warnings.push("Hidden in the data dictionary.");
    out.set(name, v);
    return v;
  };
  for (const it of items) for (const name of it.variables) { const v = touch(name); (it.kind === "crosstab" ? v.crosstabs : v.tests).push(it.id); for (const h of it.hypotheses) if (!v.hypotheses.includes(h)) v.hypotheses.push(h); }
  for (const d of plan?.derived ?? []) for (const f of d.from) touch(f);
  return [...out.values()].sort((a, b) => (a.kind === "missing" ? -1 : 0) - (b.kind === "missing" ? -1 : 0) || a.name.localeCompare(b.name));
}

/** The counts the Overview shows — every one from the views, nothing invented. */
export function planOverview(def: SurveyDefinition, items: PlanItemView[], variables: PlanVariableView[], plan = def.research?.analysisPlan): PlanOverview {
  const attention: PlanOverview["attention"] = [];
  for (const it of items) {
    if (it.state === "invalid") attention.push({ id: it.id, title: it.title, why: it.issues[0]?.message ?? "cannot run" });
    else if (it.state === "stale") attention.push({ id: it.id, title: it.title, why: it.staleBecause ? `${it.staleBecause} — apply the plan to update it` : "the plan changed after its analysis was written — apply the plan to update it" });
  }
  const tiers: Record<PlanTier, number> = { essential: 0, recommended: 0, exploratory: 0 };
  for (const it of items) tiers[it.tier]++;
  const notShown = items.filter((i) => !i.inScope).map((i) => ({ id: i.id, title: i.title, tier: i.tier, why: `${i.tier} — beyond the items the plan applies by default` }));
  return {
    crosstabs: plan?.crosstabs.length ?? 0, tests: plan?.tests.length ?? 0, derived: plan?.derived.length ?? 0, segments: plan?.segments.length ?? 0,
    hypotheses: def.research?.hypotheses.length ?? 0,
    variables: variables.length, missingVariables: variables.filter((v) => v.kind === "missing").length,
    configured: items.filter((i) => i.state === "configured" || i.state === "refined" || i.state === "stale").length,
    stale: items.filter((i) => i.state === "stale").length,
    refined: items.filter((i) => i.state === "refined").length,
    invalid: items.filter((i) => i.state === "invalid").length,
    charts: items.filter((i) => i.chart).length,
    run: items.filter((i) => i.run).length,
    tiers, notShown,
    attention,
  };
}

/* ------------------------------------------------------------ applying */

/** what the apply did to the item's saved analysis */
export type ApplySyncStatus = "created" | "updated" | "repointed" | "unchanged" | "kept_refined" | "skipped_invalid" | "not_applied";
/** what happened to it on the data: run, failed to compute, waiting for data, or not run at all (skipped) */
export type ApplyItemStatus = "run" | "failed" | "pending_data" | "skipped";
export interface ApplyItemResult { id: string; title: string; sync: ApplySyncStatus; status: ApplyItemStatus; reason?: string; analysisId?: string; chartId?: string }

/** what the apply has to do to one planned item's saved analysis, before anything runs */
export type AnalysisSync =
  | { kind: "skip"; item: PlanItemView; reason: string; /** left out by the cap, not invalid */ notApplied?: boolean }
  | { kind: "create"; item: PlanItemView; definition: AnalysisDefinition; tags: string[] }
  | { kind: "update"; item: PlanItemView; analysisId: string; definition: AnalysisDefinition; tags: string[]; summary: string; /** the dataset it was reading before, when the apply moved it (audit P-5) */ repointedFrom?: DatasetSpec }
  | { kind: "keep"; item: PlanItemView; analysisId: string; refined: boolean };

/** the definition as it is saved — the plan's, stamped with the hash it came from */
export function stampedDefinition(view: PlanItemView, dataset: DatasetSpec, surveyVersion: string | null): AnalysisDefinition {
  const name = view.derived.name.slice(0, 160);
  return { ...view.derived, name, dataset, ...(surveyVersion ? { surveyVersion } : {}), options: { ...(view.derived.options ?? {}), planned: view.id, plannedHash: view.hash, plannedReads: view.readsHash } };
}

/*
 * WHO OWNS WHAT IN A SAVED PLANNED ANALYSIS (audit P-2).
 *
 * The plan owns what it says: the kind, the variables, the table's rows,
 * columns and measure, the name and notes (its reason), and the options the
 * plan generator sets. The researcher owns everything they added in Analytics:
 * the filter and saved filters, the weighting, layers, segments, and every
 * option the plan does not set (decimals, sorting, confidence, …). Updating an
 * analysis from a changed plan used to replace the whole definition, so a
 * researcher's filter and weighting vanished the next time the plan moved.
 */
const PLAN_OPTION_KEYS = ["planned", "plannedHash", "plannedReads", "hypotheses", "layout", "significance", "test", "model", "moderation", "interactions", "method", "primaryBox"];

/** the saved definition with the plan's part replaced and the researcher's part kept */
export function mergePlanUpdate(saved: AnalysisDefinition, fromPlan: AnalysisDefinition): AnalysisDefinition {
  const keep = Object.fromEntries(Object.entries(saved.options ?? {}).filter(([k]) => !PLAN_OPTION_KEYS.includes(k)));
  const planOptions = Object.fromEntries(Object.entries(fromPlan.options ?? {}).filter(([k]) => PLAN_OPTION_KEYS.includes(k)));
  const { filter, filterIds, weighting, layers, segments } = saved;
  const out: AnalysisDefinition = {
    ...fromPlan,
    ...(filter !== undefined ? { filter } : {}), ...(filterIds !== undefined ? { filterIds } : {}), ...(weighting !== undefined ? { weighting } : {}),
    ...(layers !== undefined ? { layers } : {}), ...(segments !== undefined ? { segments } : {}),
    options: { ...keep, ...(fromPlan.options ?? {}), ...planOptions },
  };
  return out;
}

const sameDataset = (a: DatasetSpec | null | undefined, b: DatasetSpec | null | undefined): boolean => JSON.stringify(sortKeys(a ?? null)) === JSON.stringify(sortKeys(b ?? null));
const datasetWords = (d: DatasetSpec | null | undefined): string => (d ? `${d.environment}${d.dataset && d.dataset !== "all" ? ` (${d.dataset})` : ""}` : "no dataset");

/**
 * THE RULE THAT KEEPS BOTH WORKFLOWS: the plan is the source of every
 * planned analysis, and a researcher may still refine one in Analytics.
 *
 *   - no saved analysis         → create it from the plan
 *   - saved and matching        → nothing
 *   - plan changed since it was written (its stamped hash is not the plan's
 *     hash now)                 → update the PLAN'S part from the plan (new
 *     version) and keep the researcher's filter, weighting, layers, segments
 *     and other options (mergePlanUpdate)
 *   - plan unchanged but the saved definition differs → the researcher's
 *     refinement; keep it (an analysis saved before hashes existed counts
 *     as refined too, rather than being overwritten on the first apply)
 *   - whichever of the above, a saved analysis that reads another dataset than
 *     the apply is running on (LIVE → TEST, all → clean) is RE-POINTED at it
 *     and the apply says so (audit P-5): reports and dashboards read the saved
 *     analysis, so leaving it on its old dataset made them differ from the run
 *   - invalid                   → skip; an existing analysis is left as it is
 *
 * `analyses` are the survey's saved analyses, so the researcher's part can be kept.
 */
export function planAnalysisSync(items: PlanItemView[], dataset: DatasetSpec, surveyVersion: string | null, analyses: readonly Pick<SavedAnalysisRow, "id" | "definition">[] = []): AnalysisSync[] {
  const byId = new Map(analyses.map((a) => [a.id, a.definition]));
  return items.map((item): AnalysisSync => {
    if (item.state === "invalid") return { kind: "skip", item, reason: item.issues[0]?.message ?? "cannot run" };
    /* beyond the cap (audit P-7): not applied, and listed — an analysis that already exists is never touched by the cap */
    if (!item.inScope && !item.analysis) return { kind: "skip", item, reason: `${item.tier} — beyond the items the plan applies by default; it stays in the plan and is listed as not shown`, notApplied: true };
    const definition = stampedDefinition(item, dataset, surveyVersion);
    if (!item.analysis) return { kind: "create", item, definition, tags: item.hypotheses };
    const saved = byId.get(item.analysis.id);
    const moved = saved && !sameDataset(saved.dataset, dataset) ? saved.dataset : undefined;
    if (item.state === "stale") {
      const merged = saved ? mergePlanUpdate(saved, definition) : definition;
      return { kind: "update", item, analysisId: item.analysis.id, definition: merged, tags: item.hypotheses, summary: `Updated from the analysis plan${saved ? "; your filter, weighting and other refinements were kept" : ""}${moved ? `; now reads ${datasetWords(dataset)} (was ${datasetWords(moved)})` : ""}`, ...(moved ? { repointedFrom: moved } : {}) };
    }
    if (moved && saved) return { kind: "update", item, analysisId: item.analysis.id, definition: { ...saved, dataset, ...(surveyVersion ? { surveyVersion } : {}) }, tags: item.hypotheses, summary: `Re-pointed from ${datasetWords(moved)} to ${datasetWords(dataset)} by applying the analysis plan`, repointedFrom: moved };
    return { kind: "keep", item, analysisId: item.analysis.id, refined: item.state === "refined" };
  });
}

/* ------------------------------------------------------------ links that moved (audit P-1) */

/** what an analysis computes, without the id it is linked by or anything the researcher layers on */
const coreSignature = (d: AnalysisDefinition): string => {
  const o = d.options ?? {};
  const symmetric = d.kind === "correlation" || (d.kind === "test" && o.test === "chi_square");
  const vars = d.kind === "crosstab" ? `${[...(d.rows ?? [])].sort()}>${[...(d.columns ?? [])].sort()}` : (symmetric ? [...(d.variables ?? [])].sort() : d.variables ?? []).join(",");
  return [d.kind, vars, d.kind === "crosstab" ? d.measure ?? "pct_col" : "", o.test ?? "", o.model ?? "", o.method ?? "", o.moderation ? "mod" : ""].join("|");
};

export interface PlanRelink { analysisId: string; name: string; from: string; to: string }

/**
 * SAVED ANALYSES WHOSE PLAN ITEM IS NOT THE ONE THEIR ID NAMES. Plan ids used
 * to be counters, so after the survey grew an id could name a different item
 * than the analysis saved under it was written for — and the next apply would
 * overwrite that analysis with the other item's definition. For each saved
 * planned analysis whose item computes something else: if exactly one OTHER
 * item computes what it does (and has no analysis of its own), it is
 * re-linked to that item. When no item matches, the plan was edited (not
 * shifted) and the ordinary update from the plan applies.
 */
export function planRelinks(items: readonly PlanItemView[], analyses: readonly SavedAnalysisRow[]): PlanRelink[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const linked = new Set<string>();
  for (const a of analyses) { const p = plannedIdOf(a.definition); const it = p ? byId.get(p) : undefined; if (it && coreSignature(it.derived) === coreSignature(a.definition)) linked.add(it.id); }
  const out: PlanRelink[] = [];
  const taken = new Set<string>();
  for (const a of analyses) {
    const p = plannedIdOf(a.definition); if (!p) continue;
    const it = byId.get(p);
    if (it && coreSignature(it.derived) === coreSignature(a.definition)) continue;
    const sig = coreSignature(a.definition);
    const candidates = items.filter((i) => i.id !== p && !linked.has(i.id) && !taken.has(i.id) && coreSignature(i.derived) === sig);
    if (candidates.length === 1) { taken.add(candidates[0].id); out.push({ analysisId: a.id, name: a.name, from: p, to: candidates[0].id }); }
  }
  return out;
}

/** the definition after a relink: linked to its right item, stamped as written from it */
export function relinkedDefinition(def: AnalysisDefinition, to: { id: string; hash: string }): AnalysisDefinition {
  const { planned: _p, plannedHash: _h, ...rest } = (def.options ?? {}) as Record<string, unknown>;
  void _p; void _h;
  return { ...def, options: { ...rest, planned: to.id, plannedHash: to.hash } };
}

/** the chart the apply keeps for an item: one per planned id, typed as the run recommends, never restyled once the researcher customised it */
export interface ChartSync { item: PlanItemView; analysisId: string; type: ChartType; existing?: SavedChartRow; action: "create" | "retype" | "keep" }
export function planChartSync(items: PlanItemView[], analysisIdFor: (plannedId: string) => string | undefined, charts: SavedChartRow[], runItems: Pick<RunItem, "definition" | "chart">[]): ChartSync[] {
  const out: ChartSync[] = [];
  const recommended = new Map<string, ChartType>();
  for (const it of runItems) { const id = plannedIdOf(it.definition); if (id && it.chart) recommended.set(id, it.chart); }
  for (const item of items) {
    const analysisId = analysisIdFor(item.id);
    if (!analysisId || item.state === "invalid") continue;
    const type = recommended.get(item.id) ?? item.run?.chart ?? (item.kind === "crosstab" ? "bar_grouped" : "bar_vertical");
    const existing = charts.find((c) => c.analysis_id === analysisId && c.spec?.id === `plan:${item.id}`);
    if (!existing) { out.push({ item, analysisId, type, action: "create" }); continue; }
    const customised = (existing.style_version ?? 1) > 1;
    out.push({ item, analysisId, type, existing, action: !customised && existing.spec.type !== type ? "retype" : "keep" });
  }
  return out;
}

export const planChartSpec = (item: PlanItemView, type: ChartType): ChartSpec => ({ id: `plan:${item.id}`, type, options: { title: item.title, dataLabels: true } });

/** one line on the dashboard for the planned charts it has no room for — the count and the first few by name */
export function omittedNote(left: readonly Pick<PlanItemView, "title">[]): string {
  if (!left.length) return "";
  const names = left.slice(0, 4).map((i) => i.title).join("; ");
  return `\n\nNot on this dashboard (${left.length} more planned chart${left.length === 1 ? "" : "s"}): ${names}${left.length > 4 ? "; …" : ""}. They are in the plan, and in the report.`;
}

/**
 * THE DASHBOARD the apply maintains. Widgets made from the plan carry
 * `plan:<id>` ids; those are added, retyped (never moved) and removed as the
 * plan changes, and every other widget — one the researcher added, resized
 * or dragged — is kept exactly where it is. The summary text widget is the
 * run's own brief: the verdicts and the strongest findings in their words.
 */
export function planDashboard(existing: DashboardDefinition | null, title: string, items: PlanItemView[], ctx: { analysisIdFor: (plannedId: string) => string | undefined; chartSpecFor: (plannedId: string) => ChartSpec | undefined; run: StoredRunLike | null; max?: number }): DashboardDefinition {
  const max = ctx.max ?? 16;
  const eligible = items.filter((i) => i.state !== "invalid" && ctx.analysisIdFor(i.id) && ctx.chartSpecFor(i.id))
    .sort((a, b) => (b.hypotheses.length ? 1 : 0) - (a.hypotheses.length ? 1 : 0) || a.priority - b.priority);
  const wanted = eligible.slice(0, max);
  /* what the dashboard has no room for is said on the dashboard, not dropped (audit P-7) */
  const left = eligible.slice(max);
  const wantedIds = new Set(wanted.map((i) => `plan:${i.id}`));
  const keep = (existing?.widgets ?? []).filter((w) => !w.id.startsWith("plan:") || wantedIds.has(w.id) || w.id === "plan:summary");
  let widgets: DashboardWidget[] = keep.map((w) => {
    if (!w.id.startsWith("plan:") || w.id === "plan:summary") return w;
    const item = wanted.find((i) => `plan:${i.id}` === w.id)!;
    const spec = ctx.chartSpecFor(item.id)!;
    return { ...w, title: item.title, analysisId: ctx.analysisIdFor(item.id), chart: w.chart && w.chart.type !== spec.type && (w.chart.version ?? 1) <= 1 ? { ...w.chart, type: spec.type } : w.chart ?? spec };
  });
  const summaryText = (ctx.run ? briefText(ctx.run, { maxFindings: 6 }) : "The plan has not been run on responses yet — apply it once completes exist and the findings appear here.") + omittedNote(left);
  const summary = widgets.find((w) => w.id === "plan:summary");
  if (summary) widgets = widgets.map((w) => (w.id === "plan:summary" ? { ...w, text: summaryText } : w));
  else widgets = [{ id: "plan:summary", type: "text", title: "Findings", text: summaryText, x: 0, y: 0, w: 12, h: 2 }, ...widgets.map((w) => ({ ...w, y: w.y + 2 }))];
  for (const item of wanted) {
    const id = `plan:${item.id}`;
    if (widgets.some((w) => w.id === id)) continue;
    const slot = firstFreeSlot(widgets, 6, 4);
    widgets.push({ id, type: "chart", title: item.title, analysisId: ctx.analysisIdFor(item.id), chart: ctx.chartSpecFor(item.id), w: 6, h: 4, ...slot });
  }
  return { ...(existing ?? { crossFilter: true }), title: existing?.title ?? title, widgets: normalizeLayout(widgets) };
}

/** hash of a report or dashboard definition without its origin — what "edited by hand since the apply" is judged against */
export function outputHash(definition: ReportDefinition | DashboardDefinition): string {
  const { origin: _o, ...rest } = definition as { origin?: OutputOrigin };
  void _o;
  return fnv(JSON.stringify(sortKeys(rest)));
}

/** was this output changed by hand after the apply wrote it? (an output without a hash is treated as untouched) */
export function editedSinceApply(definition: ReportDefinition | DashboardDefinition): boolean {
  const h = definition.origin?.definitionHash;
  return !!h && outputHash(definition) !== h;
}

export function withOrigin<T extends ReportDefinition | DashboardDefinition>(definition: T, origin: Omit<OutputOrigin, "definitionHash">): T {
  const base = { ...definition, origin: undefined } as T;
  return { ...base, origin: { ...origin, definitionHash: outputHash(base) } };
}

/* ------------------------------------------------------------ the apply's verdict */

export interface ApplySummary {
  /** what happened overall */
  status: "applied" | "partial" | "no_data" | "nothing_planned" | "failed";
  n: number;
  environment: DatasetSpec["environment"];
  items: ApplyItemResult[];
  counts: { created: number; updated: number; repointed: number; unchanged: number; keptRefined: number; skipped: number; notApplied: number; run: number; failed: number; charts: number };
  message: string;
}

export function summarizeApply(env: DatasetSpec["environment"], n: number, items: ApplyItemResult[], extra: { charts: number; planned: number; relinked?: number; adopted?: number }): ApplySummary {
  const sync = (s: ApplySyncStatus) => items.filter((i) => i.sync === s).length;
  const count = (s: ApplyItemStatus) => items.filter((i) => i.status === s).length;
  const counts = { created: sync("created"), updated: sync("updated"), repointed: sync("repointed"), unchanged: sync("unchanged"), keptRefined: sync("kept_refined"), skipped: sync("skipped_invalid"), notApplied: sync("not_applied"), run: count("run"), failed: count("failed"), charts: extra.charts };
  const words: string[] = [];
  if (counts.created) words.push(`${counts.created} created`);
  if (counts.updated) words.push(`${counts.updated} updated from the plan`);
  if (counts.repointed) words.push(`${counts.repointed} moved to ${env === "ALL" ? "all responses" : env.toLowerCase()} data`);
  if (extra.relinked) words.push(`${extra.relinked} re-linked to the plan item they were written for`);
  if (extra.adopted) words.push(`${extra.adopted} use${extra.adopted === 1 ? "s" : ""} an analysis you already had`);
  if (counts.keptRefined) words.push(`${counts.keptRefined} kept as refined in Analytics`);
  if (counts.skipped) words.push(`${counts.skipped} skipped (invalid)`);
  if (counts.notApplied) words.push(`${counts.notApplied} not applied (beyond the plan's cap; listed as not shown)`);
  if (counts.failed) words.push(`${counts.failed} failed to compute`);
  const configured = `${extra.planned} planned ${extra.planned === 1 ? "analysis" : "analyses"}${words.length ? ` — ${words.join(", ")}` : ""}`;
  if (!extra.planned) return { status: "nothing_planned", n, environment: env, items, counts, message: "Nothing is planned yet." };
  if (n === 0) return { status: "no_data", n, environment: env, items, counts, message: `${configured}. No complete ${env === "ALL" ? "" : env.toLowerCase() + " "}responses yet, so nothing was computed: the outputs are configured and will fill when data arrives.` };
  const runWord = `${counts.run} run on ${n} completes${counts.charts ? `, ${counts.charts} chart${counts.charts === 1 ? "" : "s"}` : ""}`;
  if (counts.failed || counts.skipped) return { status: "partial", n, environment: env, items, counts, message: `${configured}. ${runWord}.` };
  return { status: "applied", n, environment: env, items, counts, message: `${configured}. ${runWord}.` };
}
