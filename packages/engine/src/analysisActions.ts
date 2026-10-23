import type { AnalysisMethod, AnalysisPlan, AnalysisRole, MeasurementLevel, PlannedCrosstab, PlannedDerived, PlannedSegment, PlannedTest, Question, SurveyDefinition } from "@rescript/schema";
import { ANALYSIS_METHODS, ANALYSIS_ROLES, MEASUREMENT_LEVELS } from "@rescript/schema";
import { buildAnalysisFramework, crosstabKey, freePlanId, isNonQuestionVariable, testKey } from "./analysisFramework.js";
import type { IdMinter } from "./questionOps.js";
import { advancedSuitability, gaborGrangerPattern, itemVariables, semModelFromDesign } from "./advancedMethods.js";
import { checkPlanItem, type PlanItemForGate } from "./planItemGate.js";

/**
 * THE ANALYSIS ACTIONS — how the copilot (and the Studio's own buttons)
 * write the analysis framework.
 *
 * Like the survey and UX actions: a closed vocabulary, a gate that reads the
 * model's JSON into typed actions or refuses them with a reason, and an
 * apply step that resolves every variable against the real survey and fails
 * loudly rather than storing a reference to nothing. They write
 * `question.analysis` and `research.analysisPlan` and nothing else — no
 * action here can change what a respondent is asked.
 *
 *   set_question_analysis   role / measurement / primary / crosstabBy /
 *                           modeling / relatedTo / hypotheses / construct
 *   propose_analysis_plan   the engine's own framework (buildAnalysisFramework)
 *                           as the plan — "plan the analysis"
 *   set_analysis_plan       replace or merge crosstabs / tests / derived /
 *                           segments
 *   add_crosstab, remove_crosstab, add_analysis_test, remove_analysis_test,
 *   add_derived_variable, remove_derived_variable
 *   update_crosstab, update_analysis_test   change a planned item IN PLACE —
 *                           its id survives, so the saved analysis, the
 *                           chart and the dashboard widget made from it
 *                           stay linked to it (Data Analytics → Analysis plan)
 *   reorder_analysis_plan   the researcher's own order of the crosstabs
 *                           and tests
 */

type CrosstabSpec = { rows: string[]; columns: string[]; measure?: PlannedCrosstab["measure"]; priority?: number; hypotheses?: string[]; reason?: string };
type TestSpec = { method: AnalysisMethod; outcome?: string; variables?: string[]; groupBy?: string; moderator?: string; mediator?: string; priority?: number; hypotheses?: string[]; reason?: string; /** method settings (2026-10-22): see PlannedTestOptions */ options?: Record<string, unknown> };
type DerivedSpec = { name: string; kind: PlannedDerived["kind"]; from: string[]; expression?: string; reason?: string };
type SegmentSpec = { name: string; by: string[]; reason?: string };

export type AnalysisAction =
  | { op: "set_question_analysis"; target: string; role?: AnalysisRole | null; measurement?: MeasurementLevel | null; primary?: AnalysisMethod[]; crosstabBy?: string[]; modeling?: AnalysisMethod[]; relatedTo?: string[]; hypotheses?: string[]; construct?: string | null; notes?: string | null }
  | { op: "propose_analysis_plan"; merge?: boolean }
  | { op: "set_analysis_plan"; merge?: boolean; crosstabs?: CrosstabSpec[]; tests?: TestSpec[]; derived?: DerivedSpec[]; segments?: SegmentSpec[]; /** when the advanced models re-run on new completes (2026-10-22); null = back to manual */ advancedRerun?: { mode: "manual" | "threshold"; newResponses?: number } | null }
  | { op: "add_crosstab"; rows: string[]; columns: string[]; measure?: PlannedCrosstab["measure"]; priority?: number; hypotheses?: string[]; reason?: string }
  | { op: "remove_crosstab"; id: string }
  | { op: "add_analysis_test"; method: AnalysisMethod; outcome?: string; variables?: string[]; groupBy?: string; moderator?: string; mediator?: string; priority?: number; hypotheses?: string[]; reason?: string; options?: Record<string, unknown> }
  | { op: "remove_analysis_test"; id: string }
  | { op: "add_derived_variable"; name: string; kind: PlannedDerived["kind"]; from: string[]; expression?: string; reason?: string }
  | { op: "remove_derived_variable"; name: string }
  /** every field optional: only what is given changes; `hypotheses: []` clears them, `reason: null` clears the reason */
  | { op: "update_crosstab"; id: string; rows?: string[]; columns?: string[]; measure?: PlannedCrosstab["measure"] | null; priority?: number; hypotheses?: string[]; reason?: string | null }
  | { op: "update_analysis_test"; id: string; method?: AnalysisMethod; outcome?: string | null; variables?: string[]; groupBy?: string | null; moderator?: string | null; mediator?: string | null; priority?: number; hypotheses?: string[]; reason?: string | null; /** merged into the item's options; a key set to null is removed */ options?: Record<string, unknown> | null }
  /** the ids in the order wanted; an id left out keeps its relative place after the ones named */
  | { op: "reorder_analysis_plan"; crosstabs?: string[]; tests?: string[] };

export const ANALYSIS_ACTION_OPS = [
  "set_question_analysis", "propose_analysis_plan", "set_analysis_plan",
  "add_crosstab", "remove_crosstab", "add_analysis_test", "remove_analysis_test",
  "add_derived_variable", "remove_derived_variable",
  "update_crosstab", "update_analysis_test", "reorder_analysis_plan",
] as const;
const OPS = new Set<string>(ANALYSIS_ACTION_OPS);
export const isAnalysisOp = (op: string): boolean => OPS.has(op);

/* ------------------------------------------------------------ the gate */

const str = (v: unknown, max = 400): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const strs = (v: unknown, max = 60): string[] | undefined => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x.trim() : typeof x === "number" ? String(x) : "")).filter(Boolean).slice(0, max) : undefined);
const METHODS = new Set<string>(ANALYSIS_METHODS);
const ROLES = new Set<string>(ANALYSIS_ROLES);
const LEVELS = new Set<string>(MEASUREMENT_LEVELS);
const MEASURES = new Set(["pct_col", "pct_row", "count", "mean"]);
const DERIVED_KINDS = new Set(["mean_score", "sum_score", "top_box", "bottom_box", "recode", "count", "flag", "index"]);
const methods = (v: unknown): AnalysisMethod[] | undefined => { const xs = strs(v); return xs ? xs.map((m) => m.toLowerCase().replace(/[\s-]+/g, "_")).filter((m) => METHODS.has(m)) as AnalysisMethod[] : undefined; };
const hyps = (v: unknown): string[] | undefined => { const xs = strs(v); return xs ? xs.map((h) => h.toUpperCase().replace(/\s+/g, "")).filter((h) => /^H\d+$/.test(h)) : undefined; };
const priority = (v: unknown): number | undefined => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 3 ? n : undefined; };

function crosstabSpec(x: unknown): CrosstabSpec | string {
  const o = (x ?? {}) as Record<string, unknown>;
  const rows = strs(o.rows), columns = strs(o.columns ?? o.banner);
  if (!rows?.length || !columns?.length) return "a crosstab needs rows and columns";
  const measure = str(o.measure);
  return { rows, columns, ...(measure && MEASURES.has(measure) ? { measure: measure as PlannedCrosstab["measure"] } : {}), ...(priority(o.priority) ? { priority: priority(o.priority) } : {}), ...(hyps(o.hypotheses) ? { hypotheses: hyps(o.hypotheses) } : {}), ...(str(o.reason) ? { reason: str(o.reason) } : {}) };
}
function testSpec(x: unknown): TestSpec | string {
  const o = (x ?? {}) as Record<string, unknown>;
  const method = str(o.method ?? o.test)?.toLowerCase().replace(/[\s-]+/g, "_");
  if (!method || !METHODS.has(method)) return `“${method ?? ""}” is not an analysis method the platform runs (${[...METHODS].join(", ")})`;
  const variables = strs(o.variables ?? o.predictors ?? o.indicators) ?? [];
  const outcome = str(o.outcome ?? o.dependent), groupBy = str(o.groupBy ?? o.group_by ?? o.by);
  const options = testOptions(method as AnalysisMethod, o);
  if (typeof options === "string") return options;
  /* an SEM planned from the hypotheses has no variables of its own: the engine builds its model from the design */
  const fromDesign = method === "sem" && (hyps(o.hypotheses)?.length || typeof options?.syntax === "string");
  if (!variables.length && !outcome && !groupBy && !fromDesign) return `${method} needs an outcome, variables or a groupBy`;
  return { method: method as AnalysisMethod, ...(outcome ? { outcome } : {}), variables, ...(groupBy ? { groupBy } : {}), ...(str(o.moderator) ? { moderator: str(o.moderator) } : {}), ...(str(o.mediator) ? { mediator: str(o.mediator) } : {}), ...(priority(o.priority) ? { priority: priority(o.priority) } : {}), ...(hyps(o.hypotheses) ? { hypotheses: hyps(o.hypotheses) } : {}), ...(str(o.reason) ? { reason: str(o.reason) } : {}), ...(options && Object.keys(options).length ? { options } : {}) };
}

/**
 * THE SETTINGS A PLANNED TEST MAY CARRY (2026-10-22), read from `options` or
 * from the same keys at the top of the action (a model writes either). Each
 * method reads its own keys, typed and bounded here; anything else is not
 * kept. A value of the wrong type is refused with the reason, never coerced
 * into something the researcher did not ask for.
 */
const OPTION_KEYS: Partial<Record<AnalysisMethod, string[]>> = {
  hb: ["chains", "burnIn", "draws", "thin", "seed", "priorVariance", "priorDf"],
  latent_class: ["minClasses", "maxClasses", "starts", "seed", "classes", "covariates"],
  sem: ["syntax", "scaling", "hypothesisPaths"],
  regression: ["bootstrap", "seed"], logistic_regression: ["bootstrap", "seed"], driver_analysis: ["bootstrap", "seed"],
  reliability: ["omega"],
  pricing: ["method", "prices", "acceptCodes"],
};
const INT_BOUNDS: Record<string, [number, number]> = { chains: [1, 8], burnIn: [100, 100_000], draws: [100, 100_000], thin: [1, 100], seed: [0, 2 ** 31 - 1], minClasses: [1, 8], maxClasses: [1, 8], starts: [1, 200], classes: [1, 8] };
export function testOptions(method: AnalysisMethod, o: Record<string, unknown>): Record<string, unknown> | string | undefined {
  const keys = OPTION_KEYS[method];
  if (!keys) return undefined;
  const src = { ...(o.options && typeof o.options === "object" && !Array.isArray(o.options) ? o.options as Record<string, unknown> : {}) };
  for (const k of keys) if (o[k] !== undefined && src[k] === undefined) src[k] = o[k];
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = src[k];
    if (v === undefined || v === null) continue;
    if (k in INT_BOUNDS) { const n = Number(v); const [lo, hi] = INT_BOUNDS[k]; if (!Number.isInteger(n) || n < lo || n > hi) return `${k} must be a whole number from ${lo} to ${hi}`; out[k] = n; continue; }
    switch (k) {
      case "priorVariance": case "priorDf": { const n = Number(v); if (!(n > 0 && n < 1000)) return `${k} must be a positive number`; out[k] = n; break; }
      case "covariates": { const xs = strs(v); if (!xs) return "covariates is a list of variable names"; if (xs.length) out[k] = xs; break; }
      case "syntax": { const t = typeof v === "string" ? v.trim() : ""; if (!t) return "syntax is the model written lavaan-style (F =~ a + b + c; Y ~ F)"; out[k] = t.slice(0, 6000); break; }
      case "scaling": if (v !== "marker" && v !== "unit_variance") return "scaling is \"marker\" or \"unit_variance\""; out[k] = v; break;
      case "hypothesisPaths": { if (typeof v !== "object" || Array.isArray(v)) return "hypothesisPaths maps a hypothesis label to its path (\"H2\": \"INTENT ~ TRUST\")"; const e = Object.entries(v as Record<string, unknown>).filter(([h, p]) => /^H\d+$/i.test(h) && typeof p === "string").map(([h, p]) => [h.toUpperCase(), String(p).slice(0, 120)]); if (e.length) out[k] = Object.fromEntries(e); break; }
      case "bootstrap": { if (v === true) { out[k] = 5000; break; } if (v === false) break; const n = Number(v); if (!Number.isInteger(n) || n < 200 || n > 20_000) return "bootstrap is the number of resamples, 200 to 20,000 (5,000 is usual)"; out[k] = n; break; }
      case "omega": if (typeof v !== "boolean") return "omega is true or false"; if (v) out[k] = true; break;
      case "method": if (v !== "gabor_granger" && v !== "van_westendorp") return "pricing method is \"gabor_granger\" or \"van_westendorp\""; out[k] = v; break;
      case "prices": { if (!Array.isArray(v)) return "prices is a list of numbers, one per purchase-intent question"; const xs = v.map((x) => Number(typeof x === "string" ? x.replace(/[^\d.]/g, "") : x)); if (xs.some((x) => !(x > 0))) return "every price must be a positive number"; out[k] = xs; break; }
      case "acceptCodes": { const xs = strs(v); if (xs?.length) out[k] = xs; break; }
    }
  }
  return out;
}
function derivedSpec(x: unknown): DerivedSpec | string {
  const o = (x ?? {}) as Record<string, unknown>;
  const name = str(o.name, 40)?.toUpperCase().replace(/[^A-Z0-9_]+/g, "_");
  const kind = str(o.kind)?.toLowerCase().replace(/[\s-]+/g, "_");
  const from = strs(o.from ?? o.variables ?? o.items);
  if (!name || !/^[A-Z_][A-Z0-9_]*$/.test(name)) return "a derived variable needs a name (letters, digits, underscores)";
  if (!kind || !DERIVED_KINDS.has(kind)) return `“${kind ?? ""}” is not a derived-variable kind (${[...DERIVED_KINDS].join(", ")})`;
  if (!from?.length) return `derived variable ${name} needs the variables it is built from`;
  return { name, kind: kind as PlannedDerived["kind"], from, ...(str(o.expression, 2000) ? { expression: str(o.expression, 2000) } : {}), ...(str(o.reason) ? { reason: str(o.reason) } : {}) };
}
function segmentSpec(x: unknown): SegmentSpec | string {
  const o = (x ?? {}) as Record<string, unknown>;
  const name = str(o.name, 80), by = strs(o.by ?? o.variables);
  if (!name || !by?.length) return "a segment needs a name and the variables that define it";
  return { name, by, ...(str(o.reason) ? { reason: str(o.reason) } : {}) };
}
const list = <T,>(v: unknown, f: (x: unknown) => T | string): T[] | undefined => (Array.isArray(v) ? v.map(f).filter((x): x is T => typeof x !== "string") : undefined);

/** The model's JSON as a typed action, a reason it was refused, or null when the op is not one of ours. */
export function coerceAnalysisAction(op: string, o: Record<string, unknown>): AnalysisAction | string | null {
  switch (op) {
    case "set_question_analysis": {
      const target = str(o.target ?? o.question);
      if (!target) return "set_question_analysis needs a target";
      const role = o.role === null ? null : str(o.role)?.toLowerCase();
      if (role && !ROLES.has(role)) return `“${role}” is not a variable role (${[...ROLES].join(", ")})`;
      const measurement = o.measurement === null ? null : str(o.measurement)?.toLowerCase();
      if (measurement && !LEVELS.has(measurement)) return `“${measurement}” is not a measurement level (${[...LEVELS].join(", ")})`;
      const a: AnalysisAction = { op, target };
      if (role !== undefined) a.role = role as AnalysisRole | null;
      if (measurement !== undefined) a.measurement = measurement as MeasurementLevel | null;
      const primary = methods(o.primary), modeling = methods(o.modeling);
      if (primary) a.primary = primary;
      if (modeling) a.modeling = modeling;
      const crosstabBy = strs(o.crosstabBy ?? o.crosstab_by ?? o.by), relatedTo = strs(o.relatedTo ?? o.related_to), hypotheses = hyps(o.hypotheses ?? o.hypothesis);
      if (crosstabBy) a.crosstabBy = crosstabBy;
      if (relatedTo) a.relatedTo = relatedTo;
      if (hypotheses) a.hypotheses = hypotheses;
      if (o.construct === null) a.construct = null; else if (str(o.construct, 120)) a.construct = str(o.construct, 120);
      if (o.notes === null) a.notes = null; else if (str(o.notes, 1000)) a.notes = str(o.notes, 1000);
      if (Object.keys(a).length === 2) return "set_question_analysis changes nothing";
      return a;
    }
    case "propose_analysis_plan": return { op, ...(o.merge === true ? { merge: true } : {}) };
    case "set_analysis_plan": {
      const a: AnalysisAction = { op, ...(o.merge === true ? { merge: true } : {}) };
      const crosstabs = list(o.crosstabs, crosstabSpec), tests = list(o.tests, testSpec), derived = list(o.derived, derivedSpec), segments = list(o.segments, segmentSpec);
      if (crosstabs) a.crosstabs = crosstabs;
      if (tests) a.tests = tests;
      if (derived) a.derived = derived;
      if (segments) a.segments = segments;
      if (o.advancedRerun === null) a.advancedRerun = null;
      else if (o.advancedRerun !== undefined) {
        const r = (o.advancedRerun ?? {}) as Record<string, unknown>;
        if (r.mode !== "manual" && r.mode !== "threshold") return "advancedRerun.mode is \"manual\" (flag stale results, re-run by hand) or \"threshold\" (re-run after newResponses completes)";
        const n = r.newResponses === undefined ? undefined : Number(r.newResponses);
        if (r.mode === "threshold" && !(Number.isInteger(n) && n! >= 1 && n! <= 100_000)) return "a threshold re-run needs newResponses, a whole number of new completes from 1 to 100,000";
        a.advancedRerun = { mode: r.mode, ...(r.mode === "threshold" ? { newResponses: n } : {}) };
      }
      if (!crosstabs && !tests && !derived && !segments && a.advancedRerun === undefined) return "set_analysis_plan needs crosstabs, tests, derived, segments or advancedRerun";
      return a;
    }
    case "add_crosstab": { const c = crosstabSpec(o); return typeof c === "string" ? c : { op, ...c }; }
    case "remove_crosstab": { const id = str(o.id); return id ? { op, id } : "remove_crosstab needs an id"; }
    case "add_analysis_test": { const t = testSpec(o); return typeof t === "string" ? t : { op, ...t }; }
    case "remove_analysis_test": { const id = str(o.id); return id ? { op, id } : "remove_analysis_test needs an id"; }
    case "add_derived_variable": { const d = derivedSpec(o); return typeof d === "string" ? d : { op, ...d }; }
    case "remove_derived_variable": { const name = str(o.name, 40)?.toUpperCase(); return name ? { op, name } : "remove_derived_variable needs a name"; }
    case "update_crosstab": {
      const id = str(o.id);
      if (!id) return "update_crosstab needs an id";
      const a: AnalysisAction = { op, id };
      const rows = strs(o.rows), columns = strs(o.columns ?? o.banner);
      if (rows) { if (!rows.length) return "a crosstab needs at least one row variable"; a.rows = rows; }
      if (columns) { if (!columns.length) return "a crosstab needs at least one column variable"; a.columns = columns; }
      if (o.measure === null) a.measure = null;
      else if (o.measure !== undefined) { const m = str(o.measure); if (!m || !MEASURES.has(m)) return `“${String(o.measure)}” is not a crosstab measure (${[...MEASURES].join(", ")})`; a.measure = m as PlannedCrosstab["measure"]; }
      if (o.priority !== undefined) { const p = priority(o.priority); if (!p) return "priority is 1, 2 or 3"; a.priority = p; }
      if (o.hypotheses !== undefined) { const h = hyps(o.hypotheses); if (!h) return "hypotheses is a list of labels (H1, H2…)"; a.hypotheses = h; }
      if (o.reason === null) a.reason = null; else if (o.reason !== undefined) a.reason = str(o.reason) ?? null;
      if (Object.keys(a).length === 2) return "update_crosstab changes nothing";
      return a;
    }
    case "update_analysis_test": {
      const id = str(o.id);
      if (!id) return "update_analysis_test needs an id";
      const a: AnalysisAction = { op, id };
      if (o.method !== undefined) { const method = str(o.method)?.toLowerCase().replace(/[\s-]+/g, "_"); if (!method || !METHODS.has(method)) return `“${String(o.method)}” is not an analysis method the platform runs (${[...METHODS].join(", ")})`; a.method = method as AnalysisMethod; }
      for (const k of ["outcome", "groupBy", "moderator", "mediator"] as const) {
        /* `groupBy: null` clears it (2026-10-22: `??` read the null as absent, so the grouping could not be removed) */
        const raw = k === "groupBy" ? (o.groupBy !== undefined ? o.groupBy : o.group_by) : o[k];
        if (raw === null) a[k] = null; else if (raw !== undefined) a[k] = str(raw) ?? null;
      }
      if (o.variables !== undefined) { const v = strs(o.variables ?? o.predictors); if (!v) return "variables is a list of variable names"; a.variables = v; }
      if (o.priority !== undefined) { const p = priority(o.priority); if (!p) return "priority is 1, 2 or 3"; a.priority = p; }
      if (o.hypotheses !== undefined) { const h = hyps(o.hypotheses); if (!h) return "hypotheses is a list of labels (H1, H2…)"; a.hypotheses = h; }
      if (o.reason === null) a.reason = null; else if (o.reason !== undefined) a.reason = str(o.reason) ?? null;
      if (o.options === null) a.options = null;
      else if (o.options !== undefined) { if (typeof o.options !== "object" || Array.isArray(o.options)) return "options is an object of the method's settings"; a.options = o.options as Record<string, unknown>; }
      if (Object.keys(a).length === 2) return "update_analysis_test changes nothing";
      return a;
    }
    case "reorder_analysis_plan": {
      const crosstabs = strs(o.crosstabs, 1000), tests = strs(o.tests, 1000);
      if (!crosstabs?.length && !tests?.length) return "reorder_analysis_plan needs the crosstab or test ids in their new order";
      return { op, ...(crosstabs?.length ? { crosstabs } : {}), ...(tests?.length ? { tests } : {}) };
    }
    default: return null;
  }
}

/* ------------------------------------------------------------ applying */

export interface AnalysisEnv {
  /** a question by code, variable or batch ref */
  question(ref: string): Question | undefined;
  ids: IdMinter;
  now: string;
}
export interface AnalysisApplied { description: string; destructive?: string; touched: string[]; /** said with the change, not refusing it (an advanced model's suitability warnings, 2026-10-22) */ warnings?: string[] }

class ActionError extends Error {}
const fail = (m: string): never => { throw new ActionError(m); };

/** every variable the model named, resolved to the question's variable name — or refused */
function resolveVars(env: AnalysisEnv, refs: string[], what: string): string[] {
  return refs.map((r) => (env.question(r) ?? fail(`${what} names “${r}”, which is not a question in this survey`)).variableName);
}
function resolveVar(env: AnalysisEnv, ref: string | undefined, what: string): string | undefined {
  return ref === undefined ? undefined : resolveVars(env, [ref], what)[0];
}
function planOf(def: SurveyDefinition): AnalysisPlan {
  if (!def.research) def.research = { hypotheses: [], constructs: [], analysis: [], assumptions: [], sources: [] } as never;
  if (!def.research!.analysisPlan) def.research!.analysisPlan = { crosstabs: [], tests: [], derived: [], segments: [] };
  return def.research!.analysisPlan!;
}
const words = (xs: string[]) => xs.join(", ");

function crosstabOf(env: AnalysisEnv, c: CrosstabSpec): PlannedCrosstab {
  const rows = resolveVars(env, c.rows, "the crosstab's rows"), columns = resolveVars(env, c.columns, "the crosstab's columns");
  if (rows.some((r) => columns.includes(r))) fail(`a crosstab cannot tabulate ${words(rows.filter((r) => columns.includes(r)))} against itself`);
  return { id: env.ids("xt"), rows, columns, ...(c.measure ? { measure: c.measure } : {}), priority: c.priority ?? 2, hypotheses: c.hypotheses ?? [], ...(c.reason ? { reason: c.reason } : {}) };
}
function testOf(env: AnalysisEnv, t: TestSpec, def?: SurveyDefinition): PlannedTest {
  const what = `the ${t.method.replace(/_/g, " ")}`;
  if (t.method === "sem" && def) return semTestOf(def, env, t);
  const options = t.options && Object.keys(t.options).length ? { ...t.options } : undefined;
  /* a bootstrapped mediation of multi-item constructs reads their planned mean scores (2026-10-22): a plan's derived variable is a column of the run */
  const derivedOk = !!def && !!options?.bootstrap && !!t.mediator;
  const one = (ref: string | undefined) => (ref === undefined ? undefined : derivedOk ? resolvePlanVars(def!, env, [ref], what)[0] : resolveVar(env, ref, what));
  const variables = derivedOk ? resolvePlanVars(def!, env, t.variables ?? [], what) : resolveVars(env, t.variables ?? [], what);
  /* a Gabor–Granger ladder named without its prices: the prices its questions state (2026-10-22) */
  if (def && t.method === "pricing" && options?.method === "gabor_granger" && !options.prices) {
    const ladder = gaborGrangerPattern(def);
    const prices = variables.map((v) => { const i = ladder?.questions.indexOf(v) ?? -1; return i >= 0 ? ladder!.prices[i] : null; });
    if (prices.every((p) => p != null)) options.prices = prices;
  }
  return { id: env.ids("test"), method: t.method, ...(t.outcome ? { outcome: one(t.outcome) } : {}), variables, ...(t.groupBy ? { groupBy: resolveVar(env, t.groupBy, what) } : {}), ...(t.moderator ? { moderator: resolveVar(env, t.moderator, what) } : {}), ...(t.mediator ? { mediator: one(t.mediator) } : {}), priority: t.priority ?? 2, hypotheses: t.hypotheses ?? [], ...(t.reason ? { reason: t.reason } : {}), ...(options ? { options } : {}) };
}

/**
 * AN SEM ITEM. Without syntax the model is built from the research design
 * (the hypotheses named, else every hypothesis it can model); with syntax the
 * observed names must be variables of the survey (questions or grid rows).
 */
function semTestOf(def: SurveyDefinition, env: AnalysisEnv, t: TestSpec): PlannedTest {
  const options: Record<string, unknown> = { scaling: "marker", ...(t.options ?? {}) };
  let variables: string[];
  let hypotheses = t.hypotheses ?? [];
  if (typeof options.syntax !== "string") {
    const m = semModelFromDesign(def, { only: hypotheses });
    if ("error" in m) fail(`no structural model can be built from the research design: ${m.error}`);
    const model = m as Exclude<typeof m, { error: string }>;
    if (model.df < 0) fail(`the model the design describes is not identified (${model.freeParameters} free parameters for ${model.freeParameters + model.df} variances and covariances) — add indicators to the constructs`);
    options.syntax = model.syntax; options.hypothesisPaths = model.hypothesisPaths; options.freeParameters = model.freeParameters;
    variables = model.observed;
    hypotheses = model.hypotheses;
  } else {
    const known = new Set(def.questions.flatMap((q) => itemVariables(def, q)));
    const latent = new Set([...String(options.syntax).matchAll(/^\s*([A-Za-z_][\w.]*)\s*=~/gm)].map((x) => x[1]));
    const names = [...new Set([...String(options.syntax).replace(/#.*$/gm, "").replace(/^\s*\w+\s*:=.*$/gm, "").matchAll(/[A-Za-z_][\w.]*/g)].map((x) => x[0]))].filter((n) => !latent.has(n) && !/^(?:NA)$/.test(n) && !/^[a-z]+_h\d+$/.test(n));
    const labels = new Set([...String(options.syntax).matchAll(/([A-Za-z_][\w.]*)\s*\*/g)].map((x) => x[1]));
    const observed = names.filter((n) => !labels.has(n));
    const unknown = observed.filter((n) => !known.has(n) && !env.question(n));
    if (unknown.length) fail(`the model names ${unknown.join(", ")}, which ${unknown.length === 1 ? "is not a variable" : "are not variables"} of this survey (a grid row is VARIABLE_r<row code>)`);
    variables = observed.map((n) => env.question(n)?.variableName ?? n);
  }
  return { id: env.ids("test"), method: "sem", variables, priority: t.priority ?? 1, hypotheses, ...(t.reason ? { reason: t.reason } : {}), options };
}
function derivedOf(def: SurveyDefinition, env: AnalysisEnv, d: DerivedSpec): PlannedDerived {
  if (def.questions.some((q) => q.variableName === d.name) || (def.calculations ?? []).some((c) => c.targetVariable === d.name)) fail(`${d.name} is already a variable in this survey — choose another name for the derived variable`);
  return { name: d.name, kind: d.kind, from: resolveVars(env, d.from, `derived variable ${d.name}`), ...(d.expression ? { expression: d.expression } : {}), ...(d.reason ? { reason: d.reason } : {}) };
}
function segmentOf(env: AnalysisEnv, s: SegmentSpec): PlannedSegment {
  return { name: s.name, by: resolveVars(env, s.by, `segment “${s.name}”`), ...(s.reason ? { reason: s.reason } : {}) };
}
/* same content, whatever order the variables were listed in, and a moderated model is not the unmoderated one (audit P-1/P-4) */
const sameCrosstab = (a: PlannedCrosstab, b: PlannedCrosstab) => crosstabKey(a) === crosstabKey(b);
const sameTest = (a: PlannedTest, b: PlannedTest) => testKey(a) === testKey(b);

export function applyAnalysisAction(def: SurveyDefinition, a: AnalysisAction, env: AnalysisEnv): AnalysisApplied {
  switch (a.op) {
    case "set_question_analysis": {
      const q = env.question(a.target) ?? fail(`there is no question “${a.target}”`);
      const cur = q.analysis ?? { primary: [], crosstabBy: [], modeling: [], relatedTo: [], hypotheses: [] };
      const next = { ...cur };
      const changed: string[] = [];
      if (a.role !== undefined) { if (a.role === null) delete next.role; else next.role = a.role; changed.push(a.role ? `role ${a.role}` : "role cleared"); }
      if (a.measurement !== undefined) { if (a.measurement === null) delete next.measurement; else next.measurement = a.measurement; changed.push(a.measurement ? `measured as ${a.measurement}` : "measurement inferred again"); }
      if (a.primary) { next.primary = a.primary; changed.push(`reported as ${words(a.primary.map((m) => m.replace(/_/g, " ")))}`); }
      if (a.modeling) { next.modeling = a.modeling; changed.push(`modelled with ${words(a.modeling.map((m) => m.replace(/_/g, " ")))}`); }
      if (a.crosstabBy) { next.crosstabBy = resolveVars(env, a.crosstabBy, `${q.code}'s crosstabs`).filter((v) => v !== q.variableName); changed.push(next.crosstabBy.length ? `tabulated by ${words(next.crosstabBy)}` : "no crosstabs"); }
      if (a.relatedTo) { next.relatedTo = resolveVars(env, a.relatedTo, `${q.code}'s related variables`).filter((v) => v !== q.variableName); changed.push(`related to ${words(next.relatedTo) || "nothing"}`); }
      if (a.hypotheses) {
        const n = def.research?.hypotheses.length ?? 0;
        const bad = a.hypotheses.filter((h) => Number(h.slice(1)) > n);
        if (bad.length) fail(`${words(bad)} ${bad.length === 1 ? "does" : "do"} not exist — the research design has ${n} hypothes${n === 1 ? "is" : "es"}`);
        next.hypotheses = a.hypotheses; changed.push(a.hypotheses.length ? `serves ${words(a.hypotheses)}` : "no hypothesis");
      }
      if (a.construct !== undefined) {
        if (a.construct === null) delete next.construct;
        else {
          next.construct = a.construct;
          // the research design's construct list is the one source of "what measures what": keep it in step
          const r = def.research;
          if (r) {
            const c = r.constructs.find((x) => x.name.toLowerCase() === a.construct!.toLowerCase());
            if (c && !c.questionIds.includes(q.id)) c.questionIds = [...c.questionIds, q.id];
            else if (!c) r.constructs = [...r.constructs, { name: a.construct, role: (a.role ?? next.role ?? "descriptive") as never, questionIds: [q.id] }];
          }
        }
        changed.push(a.construct ? `measures “${a.construct}”` : "construct cleared");
      }
      if (a.notes !== undefined) { if (a.notes === null) delete next.notes; else next.notes = a.notes; }
      q.analysis = next;
      return { description: `${q.code} analysis: ${words(changed) || "notes"}`, touched: [q.id] };
    }
    case "propose_analysis_plan": {
      const plan = planOf(def);
      const built = buildAnalysisFramework(def, { now: env.now, previous: plan });
      const had = plan.crosstabs.length + plan.tests.length + plan.derived.length;
      if (a.merge) {
        /* an item already in the plan (same content) keeps its own id and is not added; a new one gets an id nothing else has */
        for (const x of built.crosstabs) if (!plan.crosstabs.some((y) => sameCrosstab(x, y))) { x.id = freePlanId(plan, x); plan.crosstabs.push(x); }
        for (const t of built.tests) if (!plan.tests.some((y) => sameTest(t, y))) { t.id = freePlanId(plan, t); plan.tests.push(t); }
        for (const d of built.derived) if (!plan.derived.some((y) => y.name === d.name)) plan.derived.push(d);
        for (const s of built.segments) if (!plan.segments.some((y) => y.by.join("|") === s.by.join("|"))) plan.segments.push(s);
        plan.updatedAt = env.now; plan.source = "engine";
      } else def.research!.analysisPlan = built;   // built with `previous`: an item that was in the plan keeps its id
      const p = def.research!.analysisPlan!;
      /* #12: the engine's own items are not refused (the model cannot repair the generator), but none is stored silently: what is not ready is said with the change */
      const notReady = notReadyItems(def, p);
      return { ...(notReady.length ? { warnings: [`${notReady.length} planned item${notReady.length === 1 ? " is" : "s are"} not ready to run yet and will show as invalid in Data Analytics until the missing input is added: ${notReady.slice(0, 6).join(" ")}${notReady.length > 6 ? " …" : ""}`] } : {}), description: `Analysis plan: ${p.crosstabs.length} crosstab${p.crosstabs.length === 1 ? "" : "s"}, ${p.tests.length} test${p.tests.length === 1 ? "" : "s"}, ${p.derived.length} derived variable${p.derived.length === 1 ? "" : "s"}, ${p.segments.length} segment${p.segments.length === 1 ? "" : "s"}`, ...(had && !a.merge ? { destructive: `Replaces the analysis plan (${had} planned item${had === 1 ? "" : "s"})` } : {}), touched: [] };
    }
    case "set_analysis_plan": {
      const plan = planOf(def);
      const crosstabs = a.crosstabs?.map((c) => crosstabOf(env, c)), tests = a.tests?.map((t) => checkedTest(def, testOf(env, t, def)).test), derived = a.derived?.map((d) => derivedOf(def, env, d)), segments = a.segments?.map((s) => segmentOf(env, s));
      /* #12: every item the action writes passes the one readiness rule, named by its place in the action */
      const readyWarnings: string[] = [];
      crosstabs?.forEach((x, i) => readyWarnings.push(...readyOrFail(def, { kind: "crosstab", crosstab: x }, `crosstabs[${i + 1}] (${words(x.rows)} by ${words(x.columns)})`)));
      tests?.forEach((t, i) => readyWarnings.push(...readyOrFail(def, { kind: "test", test: t }, `tests[${i + 1}] (${testWords(t)})`)));
      const replaced: string[] = [];
      if (a.merge) {
        for (const x of crosstabs ?? []) if (!plan.crosstabs.some((y) => sameCrosstab(x, y))) { x.id = freePlanId(plan, x); plan.crosstabs.push(x); }
        for (const t of tests ?? []) if (!plan.tests.some((y) => sameTest(t, y))) { t.id = freePlanId(plan, t); plan.tests.push(t); }
        for (const d of derived ?? []) { plan.derived = plan.derived.filter((y) => y.name !== d.name); plan.derived.push(d); }
        for (const s of segments ?? []) { plan.segments = plan.segments.filter((y) => y.name !== s.name); plan.segments.push(s); }
      } else {
        /* replacing the list must not move the link a saved analysis has to an item that is still in it: same content, same id */
        if (crosstabs) { if (plan.crosstabs.length) replaced.push(`${plan.crosstabs.length} crosstabs`); const old = plan.crosstabs; const used = new Set<string>(); for (const x of crosstabs) { const same = old.find((y) => sameCrosstab(x, y) && !used.has(y.id)); if (same) { x.id = same.id; used.add(same.id); } } plan.crosstabs = crosstabs; }
        if (tests) { if (plan.tests.length) replaced.push(`${plan.tests.length} tests`); const old = plan.tests; const used = new Set<string>(); for (const t of tests) { const same = old.find((y) => sameTest(t, y) && !used.has(y.id)); if (same) { t.id = same.id; used.add(same.id); } } plan.tests = tests; }
        if (derived) { if (plan.derived.length) replaced.push(`${plan.derived.length} derived variables`); plan.derived = derived; }
        if (segments) { if (plan.segments.length) replaced.push(`${plan.segments.length} segments`); plan.segments = segments; }
      }
      if (a.advancedRerun === null) delete plan.advancedRerun;
      else if (a.advancedRerun) plan.advancedRerun = a.advancedRerun;
      if (!crosstabs && !tests && !derived && !segments) {
        plan.updatedAt = env.now;
        return { description: a.advancedRerun?.mode === "threshold" ? `Advanced models re-run after ${a.advancedRerun.newResponses} new completes` : "Advanced models re-run by hand (stale results are flagged)", touched: [] };
      }
      plan.updatedAt = env.now; plan.source = "copilot";
      return { ...(readyWarnings.length ? { warnings: readyWarnings } : {}), description: `Analysis plan: ${[crosstabs && `${crosstabs.length} crosstab${crosstabs.length === 1 ? "" : "s"}`, tests && `${tests.length} test${tests.length === 1 ? "" : "s"}`, derived && `${derived.length} derived`, segments && `${segments.length} segment${segments.length === 1 ? "" : "s"}`].filter(Boolean).join(", ")}${a.merge ? " added" : ""}`, ...(replaced.length ? { destructive: `Replaces the planned ${replaced.join(" and ")}` } : {}), touched: [] };
    }
    case "add_crosstab": {
      const plan = planOf(def);
      const x = crosstabOf(env, a);
      if (plan.crosstabs.some((y) => sameCrosstab(x, y))) fail(`a crosstab of ${words(x.rows)} by ${words(x.columns)} is already planned`);
      readyOrFail(def, { kind: "crosstab", crosstab: x }, "the crosstab");
      plan.crosstabs.push(x); plan.updatedAt = env.now;
      return { description: `Planned crosstab: ${words(x.rows)} by ${words(x.columns)}${x.hypotheses.length ? ` (${words(x.hypotheses)})` : ""}`, touched: [] };
    }
    case "remove_crosstab": {
      const plan = planOf(def);
      const x = plan.crosstabs.find((y) => y.id === a.id) ?? fail(`there is no planned crosstab ${a.id}`);
      plan.crosstabs = plan.crosstabs.filter((y) => y !== x); plan.updatedAt = env.now;
      return { description: `Removed the planned crosstab ${words(x.rows)} by ${words(x.columns)}`, destructive: `Removes the planned crosstab ${words(x.rows)} by ${words(x.columns)}`, touched: [] };
    }
    case "add_analysis_test": {
      const plan = planOf(def);
      const { test: t, warnings } = checkedTest(def, testOf(env, a, def));
      if (plan.tests.some((y) => sameTest(t, y))) fail(`that ${t.method.replace(/_/g, " ")} is already planned`);
      warnings.push(...readyOrFail(def, { kind: "test", test: t }, testWords(t)));
      plan.tests.push(t); plan.updatedAt = env.now;
      return { description: `Planned ${ADVANCED_WORDS[t.method] ?? t.method.replace(/_/g, " ")}${t.outcome ? ` on ${t.outcome}` : ""}${t.variables.length ? ` with ${t.method === "sem" && t.variables.length > 8 ? `${words(t.variables.slice(0, 8))} and ${t.variables.length - 8} more` : words(t.variables)}` : ""}${t.groupBy ? ` across ${t.groupBy}` : ""}${t.mediator && t.options?.bootstrap ? ` through ${t.mediator}` : ""}${optionWords(t)}`, touched: [], ...(warnings.length ? { warnings } : {}) };
    }
    case "remove_analysis_test": {
      const plan = planOf(def);
      const t = plan.tests.find((y) => y.id === a.id) ?? fail(`there is no planned test ${a.id}`);
      plan.tests = plan.tests.filter((y) => y !== t); plan.updatedAt = env.now;
      return { description: `Removed the planned ${t.method.replace(/_/g, " ")}`, destructive: `Removes the planned ${t.method.replace(/_/g, " ")}${t.reason ? ` “${t.reason}”` : ""}`, touched: [] };
    }
    case "add_derived_variable": {
      const plan = planOf(def);
      const d = derivedOf(def, env, a);
      plan.derived = plan.derived.filter((y) => y.name !== d.name); plan.derived.push(d); plan.updatedAt = env.now;
      return { description: `Planned derived variable ${d.name} (${d.kind.replace(/_/g, " ")} of ${words(d.from)})`, touched: [] };
    }
    case "remove_derived_variable": {
      const plan = planOf(def);
      if (!plan.derived.some((y) => y.name === a.name)) fail(`there is no planned derived variable ${a.name}`);
      plan.derived = plan.derived.filter((y) => y.name !== a.name); plan.updatedAt = env.now;
      return { description: `Removed the planned derived variable ${a.name}`, destructive: `Removes the planned derived variable ${a.name}`, touched: [] };
    }
    /*
     * IN PLACE, BY ID. The item keeps its id, so everything made from it
     * downstream — the saved analysis whose `options.planned` names it, the
     * chart, the dashboard widget, the report block — stays its output and is
     * refreshed rather than duplicated the next time the plan is applied.
     * Variables are resolved exactly as on creation: a name that is not a
     * question (or a planned derived variable / segment) is refused.
     */
    case "update_crosstab": {
      const plan = planOf(def);
      const i = plan.crosstabs.findIndex((y) => y.id === a.id);
      if (i < 0) fail(`there is no planned crosstab ${a.id}`);
      const cur = plan.crosstabs[i];
      const rows = a.rows ? resolvePlanVars(def, env, a.rows, "the crosstab's rows") : cur.rows;
      const columns = a.columns ? resolvePlanVars(def, env, a.columns, "the crosstab's columns") : cur.columns;
      if (rows.some((r) => columns.includes(r))) fail(`a crosstab cannot tabulate ${words(rows.filter((r) => columns.includes(r)))} against itself`);
      if (a.hypotheses) checkHypotheses(def, a.hypotheses);
      const next: PlannedCrosstab = { ...cur, rows, columns, priority: a.priority ?? cur.priority, hypotheses: a.hypotheses ?? cur.hypotheses };
      if (a.measure === null) delete next.measure; else if (a.measure) next.measure = a.measure;
      if (a.reason === null) delete next.reason; else if (a.reason) next.reason = a.reason;
      const dup = plan.crosstabs.find((y) => y !== cur && sameCrosstab(next, y));
      if (dup) fail(`a crosstab of ${words(next.rows)} by ${words(next.columns)} is already planned`);
      /* #12: an edit that leaves the item not ready is refused — unless it touches none of its inputs and the item was already not ready (a priority or a reason may still be changed; the state is said) */
      const inputsTouched = !!(a.rows || a.columns);
      const xWarn = inputsTouched || itemReady(def, { kind: "crosstab", crosstab: cur }) ? readyOrFail(def, { kind: "crosstab", crosstab: next }, "the crosstab") : notReadyNote(def, { kind: "crosstab", crosstab: next }, "the crosstab");
      plan.crosstabs[i] = next; plan.updatedAt = env.now;
      return { ...(xWarn.length ? { warnings: xWarn } : {}), description: `Changed the planned crosstab: ${words(next.rows)} by ${words(next.columns)}${next.hypotheses.length ? ` (${words(next.hypotheses)})` : ""}`, touched: [] };
    }
    case "update_analysis_test": {
      const plan = planOf(def);
      const i = plan.tests.findIndex((y) => y.id === a.id);
      if (i < 0) fail(`there is no planned test ${a.id}`);
      const cur = plan.tests[i];
      const method = a.method ?? cur.method;
      const what = `the ${method.replace(/_/g, " ")}`;
      const one = (k: "outcome" | "groupBy" | "moderator" | "mediator"): string | undefined => (a[k] === null ? undefined : a[k] !== undefined ? resolvePlanVars(def, env, [a[k]!], what)[0] : cur[k]);
      const outcome = one("outcome"), groupBy = one("groupBy"), moderator = one("moderator"), mediator = one("mediator");
      const variables = a.variables ? resolvePlanVars(def, env, a.variables, what) : cur.variables;
      if (!variables.length && !outcome && !groupBy) fail(`${what} needs an outcome, variables or a grouping variable`);
      if (a.hypotheses) checkHypotheses(def, a.hypotheses);
      const next: PlannedTest = { id: cur.id, method, variables, priority: a.priority ?? cur.priority, hypotheses: a.hypotheses ?? cur.hypotheses,
        ...(outcome ? { outcome } : {}), ...(groupBy ? { groupBy } : {}), ...(moderator ? { moderator } : {}), ...(mediator ? { mediator } : {}) };
      const reason = a.reason === null ? undefined : a.reason ?? cur.reason;
      if (reason) next.reason = reason;
      /* the item's settings survive an edit (2026-10-22): merged with the patch, a null removes one; a changed method keeps only what it reads */
      if (a.options !== undefined || cur.options) {
        const merged: Record<string, unknown> = a.options === null ? {} : { ...(cur.options ?? {}), ...(a.options ?? {}) };
        for (const [k, v] of Object.entries(a.options ?? {})) if (v === null) delete merged[k];
        const typed = testOptions(method, merged);
        if (typeof typed === "string") return fail(typed);
        if (typed && Object.keys(typed).length) next.options = typed;
      }
      const { warnings } = checkedTest(def, next);
      const dup = plan.tests.find((y) => y !== cur && sameTest(next, y));
      if (dup) fail(`that ${method.replace(/_/g, " ")} is already planned`);
      const inputsTouched = a.method !== undefined || a.outcome !== undefined || a.variables !== undefined || a.groupBy !== undefined || a.moderator !== undefined || a.mediator !== undefined || a.options !== undefined;
      warnings.push(...(inputsTouched || itemReady(def, { kind: "test", test: cur }) ? readyOrFail(def, { kind: "test", test: next }, testWords(next)) : notReadyNote(def, { kind: "test", test: next }, testWords(next))));
      plan.tests[i] = next; plan.updatedAt = env.now;
      return { description: `Changed the planned ${method.replace(/_/g, " ")}${next.outcome ? ` on ${next.outcome}` : ""}${next.variables.length ? ` with ${words(next.variables)}` : ""}${next.groupBy ? ` across ${next.groupBy}` : ""}${optionWords(next)}`, touched: [], ...(warnings.length ? { warnings } : {}) };
    }
    case "reorder_analysis_plan": {
      const plan = planOf(def);
      const order = <T extends { id: string }>(items: T[], ids: string[] | undefined, what: string): T[] => {
        if (!ids?.length) return items;
        const byId = new Map(items.map((x) => [x.id, x]));
        for (const id of ids) if (!byId.has(id)) fail(`there is no planned ${what} ${id}`);
        const named = ids.map((id) => byId.get(id)!);
        return [...named, ...items.filter((x) => !ids.includes(x.id))];
      };
      plan.crosstabs = order(plan.crosstabs, a.crosstabs, "crosstab");
      plan.tests = order(plan.tests, a.tests, "test");
      plan.updatedAt = env.now;
      return { description: `Reordered the analysis plan${a.crosstabs?.length ? ` (${a.crosstabs.length} crosstabs)` : ""}${a.tests?.length ? ` (${a.tests.length} tests)` : ""}`, touched: [] };
    }
  }
}

/**
 * A variable a planned item may name: a question, or one of the plan's own
 * derived variables and segments (those are columns of the run's dataset —
 * see `withPlannedVariables` in @rescript/analytics). Creation resolves
 * questions only, because the model writes those; an edit by hand in Data
 * Analytics may keep a derived variable the engine planned.
 */
function resolvePlanVars(def: SurveyDefinition, env: AnalysisEnv, refs: string[], what: string): string[] {
  return refs.map((r) => env.question(r)?.variableName ?? (isNonQuestionVariable(def, r) ? r : fail(`${what} names “${r}”, which is not a question in this survey`)));
}
function checkHypotheses(def: SurveyDefinition, labels: string[]) {
  const n = def.research?.hypotheses.length ?? 0;
  const bad = labels.filter((h) => !/^H\d+$/.test(h) || Number(h.slice(1)) < 1 || Number(h.slice(1)) > n);
  if (bad.length) fail(`${words(bad)} ${bad.length === 1 ? "does" : "do"} not exist — the research design has ${n} hypothes${n === 1 ? "is" : "es"}`);
}

export function describeAnalysisAction(a: AnalysisAction): string {
  switch (a.op) {
    case "set_question_analysis": return `Analysis of ${a.target}`;
    case "propose_analysis_plan": return a.merge ? "Add the engine's analysis plan" : "Plan the analysis";
    case "set_analysis_plan": return !a.crosstabs && !a.tests && !a.derived && !a.segments && a.advancedRerun !== undefined ? "Set when the advanced models re-run" : a.merge ? "Add to the analysis plan" : "Set the analysis plan";
    case "add_crosstab": return `Plan a crosstab of ${a.rows.join(", ")} by ${a.columns.join(", ")}`;
    case "remove_crosstab": return `Remove planned crosstab ${a.id}`;
    case "add_analysis_test": return `Plan ${ADVANCED_WORDS[a.method] ?? `a ${a.method.replace(/_/g, " ")}`}`;
    case "remove_analysis_test": return `Remove planned test ${a.id}`;
    case "add_derived_variable": return `Plan derived variable ${a.name}`;
    case "remove_derived_variable": return `Remove planned derived variable ${a.name}`;
    case "update_crosstab": return `Change planned crosstab ${a.id}`;
    case "update_analysis_test": return `Change planned test ${a.id}`;
    case "reorder_analysis_plan": return "Reorder the analysis plan";
  }
}

/* ------------------------------------------------------------ advanced models (2026-10-22) */

const ADVANCED_WORDS: Partial<Record<AnalysisMethod, string>> = { hb: "hierarchical Bayes", latent_class: "a latent class analysis", sem: "a structural equation model" };
/** the settings an item carries, in words, for its description */
function optionWords(t: PlannedTest): string {
  const o = t.options ?? {};
  const bits: string[] = [];
  if (t.method === "latent_class") bits.push(`${String(o.minClasses ?? 1)}–${String(o.maxClasses ?? 4)} classes`);
  if (t.method === "sem" && o.hypothesisPaths) bits.push(`paths for ${Object.keys(o.hypothesisPaths as object).join(", ")}`);
  if (o.bootstrap) bits.push(`indirect effect bootstrapped (${String(o.bootstrap)} resamples)`);
  if (o.omega) bits.push("McDonald's ω beside α");
  if (o.method === "gabor_granger") bits.push(`Gabor–Granger at ${Array.isArray(o.prices) ? o.prices.join(", ") : "?"}`);
  return bits.length ? ` (${bits.join("; ")})` : "";
}
/** the design-level suitability rules: a blocking reason refuses the item, warnings travel with it */
function checkedTest(def: SurveyDefinition, t: PlannedTest): { test: PlannedTest; warnings: string[] } {
  const s = advancedSuitability(def, t);
  if (s.blocking.length) fail(s.blocking.join(" "));
  return { test: t, warnings: s.warnings };
}

/* ------------------------------------------------------------ the one readiness rule (#12, 2026-10-22) */

const testWords = (t: PlannedTest): string => `${ADVANCED_WORDS[t.method] ?? `the ${t.method.replace(/_/g, " ")}`}${t.outcome ? ` on ${t.outcome}` : ""}${t.groupBy ? ` across ${t.groupBy}` : ""}`;
/**
 * The registered readiness rule (`plannedItemReadiness`) on an item this action writes: not ready → refused with the
 * rule's own words (the missing role or variable), so the repair call can supply it; ready → its warnings travel
 * with the change. No rule registered → nothing (as before).
 */
function readyOrFail(def: SurveyDefinition, item: PlanItemForGate, what: string): string[] {
  const r = checkPlanItem(item, def);
  if (!r) return [];
  if (!r.ready) fail(`${what} is not ready to run, so it was not added to the plan — ${r.missing.join(" ")}`);
  return r.warnings.map((w) => `${what}: ${w}`);
}
const itemReady = (def: SurveyDefinition, item: PlanItemForGate): boolean => checkPlanItem(item, def)?.ready !== false;
function notReadyNote(def: SurveyDefinition, item: PlanItemForGate, what: string): string[] {
  const r = checkPlanItem(item, def);
  return r && !r.ready ? [`${what} is still not ready to run: ${r.missing.join(" ")}`] : [];
}
/** the items of a plan the rule calls not ready, each said once */
function notReadyItems(def: SurveyDefinition, plan: AnalysisPlan): string[] {
  const out: string[] = [];
  for (const x of plan.crosstabs) { const r = checkPlanItem({ kind: "crosstab", crosstab: x }, def); if (r && !r.ready) out.push(`crosstab ${words(x.rows)} by ${words(x.columns)}: ${r.missing.join(" ")}`); }
  for (const t of plan.tests) { const r = checkPlanItem({ kind: "test", test: t }, def); if (r && !r.ready) out.push(`${testWords(t)}: ${r.missing.join(" ")}`); }
  return out;
}
