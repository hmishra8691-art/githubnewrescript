import type { AnalysisMethod, AnalysisPlan, AnalysisRole, MeasurementLevel, PlannedCrosstab, PlannedDerived, PlannedSegment, PlannedTest, Question, QuestionAnalysis, SurveyDefinition } from "@rescript/schema";
import { hypothesisLabel } from "@rescript/schema";
import { listBlocks } from "./blocks.js";
import { questionOrder } from "./dependencies.js";
import { getQuestionByCodeOrVar } from "./state.js";
import { stripHtmlText } from "./html.js";

/**
 * THE ANALYSIS FRAMEWORK — planned from the questionnaire, before fieldwork.
 *
 * The brief's principle: analysis is not something that starts after data
 * collection. Every question has a purpose — a variable role, a measurement
 * level, the tables it will sit in, the hypothesis it serves — and the study
 * has a plan of tables and tests. This module works that out from what the
 * definition already says (the research design's constructs and hypotheses,
 * the question types, the screening and demographic blocks) so that:
 *
 *   inferQuestionAnalysis   what a question is for, explicit or inferred
 *   buildAnalysisFramework  the crosstabs, tests, derived variables and
 *                           segments the design implies — a proposal the
 *                           researcher reviews, never applied by itself
 *   prioritizeCrosstabs     "show me the most important crosstabs"
 *   hypothesisCoverage      is each hypothesis measured and testable?
 *   analysisDependencies    what in the plan reads this question — for the
 *                           delete dialog and the copilot's destructive note
 *   reviewAnalysisPlan      plan vs survey: dead references, tests on the
 *                           wrong level, hypotheses nothing measures
 *   methodologyAdvice       which method fits a stated goal, with trade-offs
 *
 * Deterministic and dependency-free: the model may propose roles and plans
 * (through the analysis actions), but what is CHECKED and what is RUN comes
 * from here and from `@rescript/analytics`, never from the model's prose.
 */

/* ------------------------------------------------------------ measurement */

const SCALE_WORDS = /\b(?:agree|disagree|satisf|dissatisf|likely|unlikely|important|unimportant|poor|fair|good|excellent|never|rarely|sometimes|often|always|very|extremely|somewhat|not at all|slightly|moderately|completely|neutral|neither)/i;

/** Is this choice list an ordered scale (points in order, numeric or anchored labels)? */
export function isOrderedScale(q: Pick<Question, "type" | "options">): boolean {
  if (!q.options?.length) return false;
  const n = q.options.length;
  if (n < 3 || n > 11) return false;
  const codes = q.options.map((o) => Number(o.code));
  if (!codes.every((c, i) => Number.isFinite(c) && (i === 0 || c === codes[i - 1] + 1))) return false;
  const labels = q.options.map((o) => stripHtmlText(o.label));
  const numeric = labels.filter((l) => /^\d+$/.test(l)).length;
  return numeric >= n - 2 || (SCALE_WORDS.test(labels[0]) && SCALE_WORDS.test(labels[n - 1]));
}

/** The level a question measures at, from its type — the researcher's `analysis.measurement` overrides it. */
export function measurementOf(q: Question): MeasurementLevel {
  if (q.analysis?.measurement) return q.analysis.measurement;
  switch (q.type) {
    case "numeric": case "numeric_list": case "allocation_total": return "ratio";
    case "slider": case "nps": return "interval";
    case "date": case "time": return "date";
    case "open_text": case "long_text": case "text_list": case "upload": return "text";
    case "ranking": case "image_ranking": return "rank";
    case "allocation": return "allocation";
    case "maxdiff_task": case "conjoint_task": case "acbc_task": case "experiment": return "choice";
    case "multi_select": case "multi_dropdown": case "matrix_multi": return "multi";
    case "matrix_numeric": return "ratio";
    case "matrix_text": return "text";
    case "hidden": case "calculated": case "embedded_data": {
      const dt = (q.settings as { dataType?: string } | undefined)?.dataType;
      return dt === "numeric" ? "ratio" : "nominal";
    }
    case "single_select": case "dropdown": case "image_select": case "matrix_single": case "matrix_dropdown":
      return isOrderedScale(q) ? "ordinal" : "nominal";
    default:
      return q.options?.length ? (isOrderedScale(q) ? "ordinal" : "nominal") : "nominal";
  }
}

/** a scale that behaves like a number for means, correlation and regression */
export const isScaleLike = (m: MeasurementLevel): boolean => m === "ordinal" || m === "interval" || m === "ratio";
export const isCategorical = (m: MeasurementLevel): boolean => m === "nominal" || m === "ordinal" || m === "multi";
const NOT_ASKED = new Set(["html", "custom_component", "media_timeline"]);

/* ------------------------------------------------------------ roles */

const SEGMENT_NAMES = /^(?:AGE|GENDER|SEX|REGION|STATE|COUNTRY|MARKET|CITY|INCOME|HHI|EDUCATION|EDU|ETHNICITY|MARITAL|EMPLOY(?:MENT)?|OCCUPATION|HOUSEHOLD|HH_?SIZE|KIDS|CHILDREN|URBAN(?:ICITY)?|SEGMENT|USER(?:_?TYPE)?|CUSTOMER(?:_?TYPE)?|TIER|GEN(?:ERATION)?|LANG(?:UAGE)?)(?:_|\d|$)/i;
const SEGMENT_TEXT = /\b(?:how old are you|your age|gender|which region|where do you live|household income|highest level of education|employment status|marital status|which country)\b/i;
const DEMO_BLOCK = /\b(?:demograph|about you|profile|classification|background)/i;
const SCREEN_BLOCK = /\b(?:screen|qualif|eligib|intro)/i;

/** The construct a question measures, from the research design. */
export function constructOf(def: SurveyDefinition, questionId: string) {
  return (def.research?.constructs ?? []).find((c) => c.questionIds.includes(questionId));
}

function screensOut(q: Question): boolean {
  return (q.skipLogic ?? []).some((s) => s.target.kind === "terminate" || s.target.status === "screened");
}

function blockTitleOf(def: SurveyDefinition, questionId: string): string {
  const b = listBlocks(def.flow as unknown[]).find((x) => x.pages.some((p) => p.node.questionIds.includes(questionId)));
  return (b?.title ?? "").trim();
}

/** The role a question plays, when nothing says so: the construct's role, else what its name, text and block suggest. */
export function inferRole(def: SurveyDefinition, q: Question): AnalysisRole {
  if (q.analysis?.role) return q.analysis.role;
  const c = constructOf(def, q.id);
  if (c) return c.role as AnalysisRole;
  if (NOT_ASKED.has(q.type)) return "descriptive";
  if (screensOut(q)) return "screening";
  const block = blockTitleOf(def, q.id);
  // a demographic is a cut of the results wherever it is asked — a screener's gender question still profiles the sample
  if (SEGMENT_NAMES.test(q.variableName) || SEGMENT_NAMES.test(String(q.code)) || SEGMENT_TEXT.test(stripHtmlText(q.text)) || DEMO_BLOCK.test(block)) return "segmentation";
  if (SCREEN_BLOCK.test(block)) return "screening";
  return "descriptive";
}

/** The analyses a measurement level reports on its own. */
export function primaryMethodsFor(q: Question, level = measurementOf(q)): AnalysisMethod[] {
  if (q.type === "nps") return ["nps", "frequencies"];
  if (q.type === "maxdiff_task") return ["maxdiff_scores"];
  if (q.type === "conjoint_task" || q.type === "acbc_task") return ["conjoint_utilities"];
  switch (level) {
    case "nominal": case "multi": return ["frequencies"];
    case "ordinal": return ["frequencies", "top_box", "mean"];
    case "interval": case "ratio": return ["mean", "median"];
    case "text": return ["text_themes"];
    case "rank": return ["ranking_scores"];
    case "allocation": return ["allocation_shares"];
    case "choice": return ["frequencies"];
    case "date": return ["frequencies"];
  }
}

/** The questions a study cuts its results by: explicit segmentation / control roles, or the inferred demographics. */
export function segmentationQuestions(def: SurveyDefinition): Question[] {
  return def.questions.filter((q) => {
    const r = inferRole(def, q);
    const m = measurementOf(q);
    return (r === "segmentation" || r === "control") && (m === "nominal" || m === "ordinal" || m === "multi");
  });
}

/**
 * What a question is for — the researcher's own `analysis` filled in with
 * what the engine infers for anything left blank. The explicit object always
 * wins field by field.
 */
export function inferQuestionAnalysis(def: SurveyDefinition, q: Question): Required<Pick<QuestionAnalysis, "role" | "measurement" | "primary" | "crosstabBy" | "modeling" | "relatedTo" | "hypotheses">> & Pick<QuestionAnalysis, "construct" | "notes"> & { inferred: (keyof QuestionAnalysis)[] } {
  const a = q.analysis;
  const inferred: (keyof QuestionAnalysis)[] = [];
  const role = a?.role ?? (inferred.push("role"), inferRole(def, q));
  const measurement = a?.measurement ?? (inferred.push("measurement"), measurementOf(q));
  const primary = a?.primary?.length ? a.primary : (inferred.push("primary"), primaryMethodsFor(q, measurement));
  const c = constructOf(def, q.id);
  const construct = a?.construct ?? c?.name;
  const analytic = role === "dependent" || role === "independent" || role === "mediator" || role === "moderator";
  const crosstabBy = a?.crosstabBy?.length ? a.crosstabBy : (inferred.push("crosstabBy"), analytic && !NOT_ASKED.has(q.type) ? segmentationQuestions(def).filter((s) => s.id !== q.id).map((s) => s.variableName) : []);
  const hypotheses = a?.hypotheses?.length ? a.hypotheses : (inferred.push("hypotheses"), construct ? hypothesesNaming(def, construct) : []);
  // an independent relates to the dependents, a dependent to the independents; mediators and moderators to both
  const relatedTo = a?.relatedTo?.length ? a.relatedTo : (inferred.push("relatedTo"), analytic ? def.questions.filter((o) => o.id !== q.id && !NOT_ASKED.has(o.type)).filter((o) => { const r = inferRole(def, o); return role === "dependent" ? r === "independent" || r === "mediator" || r === "moderator" : r === "dependent"; }).map((o) => o.variableName) : []);
  const modeling = a?.modeling?.length ? a.modeling : (inferred.push("modeling"), analytic && isScaleLike(measurement) ? (role === "dependent" ? ["regression"] : ["correlation", "regression"]) as AnalysisMethod[] : []);
  return { role, measurement, primary, crosstabBy, modeling, relatedTo, hypotheses, ...(construct ? { construct } : {}), ...(a?.notes ? { notes: a.notes } : {}), inferred };
}

/* ------------------------------------------------------------ hypotheses */

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/** The hypothesis labels whose text names this construct (by its name, or its name's distinctive words). */
export function hypothesesNaming(def: SurveyDefinition, construct: string): string[] {
  const hs = def.research?.hypotheses ?? [];
  const name = norm(construct);
  if (!name) return [];
  const words = name.split(" ").filter((w) => w.length > 3);
  return hs.map((h, i) => ({ h: norm(h), i })).filter(({ h }) => h.includes(name) || (words.length > 0 && words.every((w) => h.includes(w)))).map(({ i }) => hypothesisLabel(i));
}

export interface HypothesisCoverage {
  label: string;
  text: string;
  constructs: { name: string; role: string; questions: string[]; measured: boolean }[];
  tests: PlannedTest[];
  crosstabs: PlannedCrosstab[];
  /** testable: every construct measured and a test planned · partly: measured, nothing planned · unmeasured: a construct has no question · unlinked: no construct names it */
  status: "testable" | "partly" | "unmeasured" | "unlinked";
}

/** For every hypothesis: the constructs it names, whether each is measured, and what the plan runs for it. */
export function hypothesisCoverage(def: SurveyDefinition): HypothesisCoverage[] {
  const r = def.research;
  if (!r) return [];
  const plan = r.analysisPlan;
  const codeOf = (id: string) => def.questions.find((q) => q.id === id)?.code;
  return r.hypotheses.map((text, i) => {
    const label = hypothesisLabel(i);
    const constructs = (r.constructs ?? []).filter((c) => hypothesesNaming(def, c.name).includes(label)).map((c) => {
      const questions = c.questionIds.map(codeOf).filter((x): x is string => !!x);
      return { name: c.name, role: c.role, questions, measured: questions.length > 0 };
    });
    // a question tagged with the label counts as measuring the hypothesis even without a construct
    const tagged = def.questions.filter((q) => q.analysis?.hypotheses?.includes(label));
    const tests = (plan?.tests ?? []).filter((t) => t.hypotheses.includes(label));
    const crosstabs = (plan?.crosstabs ?? []).filter((t) => t.hypotheses.includes(label));
    const status: HypothesisCoverage["status"] = !constructs.length && !tagged.length ? "unlinked"
      : constructs.some((c) => !c.measured) ? "unmeasured"
      : tests.length || crosstabs.length ? "testable" : "partly";
    return { label, text, constructs, tests, crosstabs, status };
  });
}

/* ------------------------------------------------------------ the plan */

function uniq<T>(xs: T[]): T[] { return [...new Set(xs)]; }
const by = (q: Question) => q.variableName;

/**
 * The framework the design implies, as a complete plan. It is a PROPOSAL:
 * the Studio shows it and the researcher applies it (or the copilot refines
 * it) — nothing here writes to the definition.
 *
 *   crosstabs   each outcome against the segmentation banner (priority 1
 *               when a hypothesis names it); each independent × dependent
 *               pair where both are categorical
 *   tests       by the measurement levels of the pair:
 *                 scale × scale → correlation, and one regression per
 *                 outcome on all its predictors (moderators as interactions,
 *                 mediators as a route)
 *                 groups × scale → t-test (2 groups) or ANOVA (more)
 *                 groups × categorical → chi-square
 *               plus what a type demands: MaxDiff scores, conjoint
 *               utilities, NPS, reliability for a multi-item construct
 *   derived     a mean score per multi-item construct, top-2-box per
 *               ordinal outcome
 *   segments    one per segmentation variable
 */
export function buildAnalysisFramework(def: SurveyDefinition, opts: { now?: string } = {}): AnalysisPlan {
  const asked = def.questions.filter((q) => !NOT_ASKED.has(q.type));
  const info = new Map(asked.map((q) => [q.id, inferQuestionAnalysis(def, q)]));
  const role = (q: Question) => info.get(q.id)!.role;
  const level = (q: Question) => info.get(q.id)!.measurement;
  const hyp = (...qs: Question[]) => uniq(qs.flatMap((q) => info.get(q.id)!.hypotheses));
  const dependents = asked.filter((q) => role(q) === "dependent");
  const independents = asked.filter((q) => role(q) === "independent");
  const mediators = asked.filter((q) => role(q) === "mediator");
  const moderators = asked.filter((q) => role(q) === "moderator");
  const segments = segmentationQuestions(def);
  const crosstabs: PlannedCrosstab[] = [];
  const tests: PlannedTest[] = [];
  const derived: PlannedDerived[] = [];
  let n = 0;
  const id = (p: string) => `${p}_${++n}`;

  /* outcomes by the banner */
  for (const dv of dependents) {
    if (!isCategorical(level(dv)) && !isScaleLike(level(dv))) continue;
    const cols = segments.filter((s) => s.id !== dv.id).map(by);
    if (!cols.length) continue;
    const h = hyp(dv);
    crosstabs.push({ id: id("xt"), rows: [by(dv)], columns: cols, measure: isScaleLike(level(dv)) && level(dv) !== "ordinal" ? "mean" : "pct_col", priority: h.length ? 1 : 2, hypotheses: h, reason: `${dv.code} (${info.get(dv.id)!.construct ?? "the outcome"}) by the sample profile` });
  }
  /* independent × dependent, where a table can show it */
  for (const dv of dependents) for (const iv of [...independents, ...moderators]) {
    if (iv.id === dv.id) continue;
    // a table needs GROUPS across the top: a nominal or multi-select independent; a scale × scale pair is a correlation below
    if (!(level(iv) === "nominal" || level(iv) === "multi") || !(isCategorical(level(dv)) || isScaleLike(level(dv)))) continue;
    const h = hyp(dv, iv);
    crosstabs.push({ id: id("xt"), rows: [by(dv)], columns: [by(iv)], measure: isScaleLike(level(dv)) && level(dv) !== "ordinal" ? "mean" : "pct_col", priority: h.length ? 1 : 2, hypotheses: h, reason: `${dv.code} by ${iv.code}${h.length ? ` (${h.join(", ")})` : ""}` });
  }
  /* independent × independent profiling is exploratory; the sample profile itself is priority 3 */
  if (segments.length >= 2) crosstabs.push({ id: id("xt"), rows: segments.slice(1).map(by), columns: [by(segments[0])], measure: "pct_col", priority: 3, hypotheses: [], reason: "sample profile" });

  /* pairwise tests */
  for (const dv of dependents) {
    const dvl = level(dv);
    const predictors = [...independents, ...mediators, ...moderators].filter((p) => p.id !== dv.id);
    for (const iv of predictors) {
      const ivl = level(iv);
      const h = hyp(dv, iv);
      const r = `${iv.code} → ${dv.code}`;
      if (isScaleLike(ivl) && isScaleLike(dvl)) tests.push({ id: id("t"), method: "correlation", outcome: by(dv), variables: [by(iv)], priority: h.length ? 1 : 2, hypotheses: h, reason: r });
      else if (isCategorical(ivl) && ivl !== "ordinal" && isScaleLike(dvl)) {
        const groups = iv.options?.length ?? 0;
        tests.push({ id: id("t"), method: groups === 2 ? "t_test" : "anova", outcome: by(dv), variables: [], groupBy: by(iv), priority: h.length ? 1 : 2, hypotheses: h, reason: `${dv.code} compared across ${iv.code}` });
      } else if (isCategorical(ivl) && isCategorical(dvl)) tests.push({ id: id("t"), method: "chi_square", outcome: by(dv), variables: [by(iv)], priority: h.length ? 1 : 2, hypotheses: h, reason: r });
    }
    /* one model per outcome */
    const scalePredictors = predictors.filter((p) => isScaleLike(level(p)) || (isCategorical(level(p)) && (p.options?.length ?? 0) === 2));
    if (scalePredictors.length >= 1 && (isScaleLike(dvl) || (isCategorical(dvl) && (dv.options?.length ?? 0) === 2))) {
      const logistic = isCategorical(dvl) && dvl !== "ordinal";
      const mod = moderators.find((m) => scalePredictors.includes(m));
      const med = mediators.find((m) => scalePredictors.includes(m));
      tests.push({ id: id("t"), method: logistic ? "logistic_regression" : "regression", outcome: by(dv), variables: scalePredictors.filter((p) => p !== mod && p !== med).map(by), ...(mod ? { moderator: by(mod) } : {}), ...(med ? { mediator: by(med) } : {}), priority: 1, hypotheses: hyp(dv, ...scalePredictors), reason: `what drives ${dv.code}${mod ? `, and whether ${mod.code} changes it` : ""}${med ? `, through ${med.code}` : ""}` });
    }
  }
  /* what a type demands */
  for (const q of asked) {
    if (q.type === "maxdiff_task") tests.push({ id: id("t"), method: "maxdiff_scores", variables: [by(q)], priority: 1, hypotheses: hyp(q), reason: `${q.code} is a MaxDiff exercise` });
    if (q.type === "conjoint_task" || q.type === "acbc_task") tests.push({ id: id("t"), method: "conjoint_utilities", variables: [by(q)], priority: 1, hypotheses: hyp(q), reason: `${q.code} is a conjoint exercise` });
    if (q.type === "nps") tests.push({ id: id("t"), method: "nps", variables: [by(q)], priority: 1, hypotheses: hyp(q), reason: `${q.code} is an NPS question` });
  }
  /* multi-item constructs: reliability and a mean score */
  for (const c of def.research?.constructs ?? []) {
    const items = c.questionIds.map((i) => asked.find((q) => q.id === i)).filter((q): q is Question => !!q && isScaleLike(level(q)));
    if (items.length < 2) continue;
    const stem = c.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "SCORE";
    tests.push({ id: id("t"), method: "reliability", variables: items.map(by), priority: 2, hypotheses: hypothesesNaming(def, c.name), reason: `${c.name} is measured by ${items.length} items` });
    derived.push({ name: `${stem}_SCORE`, kind: "mean_score", from: items.map(by), reason: `${c.name}: the mean of its ${items.length} items` });
  }
  for (const dv of dependents) if (level(dv) === "ordinal") derived.push({ name: `${by(dv)}_T2B`.slice(0, 40), kind: "top_box", from: [by(dv)], reason: `${dv.code} top-2-box` });

  const segs: PlannedSegment[] = segments.map((s) => ({ name: stripHtmlText(s.text).slice(0, 60) || s.variableName, by: [by(s)] }));
  return { crosstabs, tests, derived, segments: segs, source: "engine", updatedAt: opts.now ?? new Date().toISOString() };
}

/** The plan's crosstabs by importance: the more hypotheses a table serves the higher, then by priority, then the wider banner. */
export function prioritizeCrosstabs(def: SurveyDefinition, limit = 10, plan = def.research?.analysisPlan ?? buildAnalysisFramework(def)): PlannedCrosstab[] {
  return [...plan.crosstabs].sort((a, b) => b.hypotheses.length - a.hypotheses.length || a.priority - b.priority || b.columns.length - a.columns.length).slice(0, limit);
}

/* ------------------------------------------------------------ dependencies */

export interface AnalysisDependencies {
  constructs: string[];
  hypotheses: string[];
  crosstabs: PlannedCrosstab[];
  tests: PlannedTest[];
  derived: PlannedDerived[];
  segments: PlannedSegment[];
  /** questions whose own analysis names this one (crosstabBy / relatedTo), by code */
  questions: string[];
}

function namesOf(def: SurveyDefinition, questionId: string): Set<string> {
  const q = def.questions.find((x) => x.id === questionId);
  return new Set(q ? [q.id, String(q.code), q.variableName] : [questionId]);
}
const names = (t: PlannedTest) => [t.outcome, t.groupBy, t.moderator, t.mediator, ...t.variables].filter((x): x is string => !!x);

/** Everything in the analysis framework that reads this question. */
export function analysisDependencies(def: SurveyDefinition, questionId: string): AnalysisDependencies {
  const ns = namesOf(def, questionId);
  const has = (xs: string[]) => xs.some((x) => ns.has(x));
  const plan = def.research?.analysisPlan;
  const constructs = (def.research?.constructs ?? []).filter((c) => c.questionIds.includes(questionId)).map((c) => c.name);
  const hypotheses = uniq([...constructs.flatMap((c) => hypothesesNaming(def, c)), ...(def.questions.find((q) => q.id === questionId)?.analysis?.hypotheses ?? [])]);
  return {
    constructs, hypotheses,
    crosstabs: (plan?.crosstabs ?? []).filter((x) => has(x.rows) || has(x.columns)),
    tests: (plan?.tests ?? []).filter((t) => has(names(t))),
    derived: (plan?.derived ?? []).filter((d) => has(d.from)),
    segments: (plan?.segments ?? []).filter((s) => has(s.by)),
    questions: def.questions.filter((q) => q.id !== questionId && (has(q.analysis?.crosstabBy ?? []) || has(q.analysis?.relatedTo ?? []))).map((q) => String(q.code)),
  };
}

/** The dependencies as sentences for a delete dialog — empty when nothing in the plan reads the question. */
export function describeAnalysisImpact(def: SurveyDefinition, questionId: string): string[] {
  const d = analysisDependencies(def, questionId);
  const out: string[] = [];
  if (d.constructs.length) out.push(`it measures ${d.constructs.map((c) => `“${c}”`).join(", ")}${d.hypotheses.length ? ` (${d.hypotheses.join(", ")})` : ""}`);
  else if (d.hypotheses.length) out.push(`it serves ${d.hypotheses.join(", ")}`);
  if (d.crosstabs.length) out.push(`${d.crosstabs.length} planned crosstab${d.crosstabs.length === 1 ? "" : "s"} read${d.crosstabs.length === 1 ? "s" : ""} it`);
  if (d.tests.length) out.push(`${d.tests.length} planned test${d.tests.length === 1 ? "" : "s"} (${uniq(d.tests.map((t) => t.method.replace(/_/g, " "))).join(", ")})`);
  if (d.derived.length) out.push(`derived variable${d.derived.length === 1 ? "" : "s"} ${d.derived.map((x) => x.name).join(", ")}`);
  if (d.segments.length) out.push(`segment${d.segments.length === 1 ? "" : "s"} ${d.segments.map((x) => `“${x.name}”`).join(", ")}`);
  if (d.questions.length) out.push(`${d.questions.join(", ")} ${d.questions.length === 1 ? "is" : "are"} tabulated against it`);
  return out;
}

export interface PrunedAnalysisReference { where: string; effect: string; path: string; kind: "removed" | "cleared" }

/**
 * Take a question out of the analysis framework, in place: a crosstab or test
 * that loses its only row, column or outcome goes; one that keeps enough
 * stays with the reference removed; other questions' `crosstabBy` and
 * `relatedTo` drop it. Returns what changed, for the delete dialog.
 */
export function pruneAnalysisReferences(def: SurveyDefinition, ns: Set<string>): PrunedAnalysisReference[] {
  const out: PrunedAnalysisReference[] = [];
  const drop = (xs: string[]) => xs.filter((x) => !ns.has(x));
  def.questions.forEach((q, qi) => {
    if (!q.analysis) return;
    for (const key of ["crosstabBy", "relatedTo"] as const) {
      const before = q.analysis[key] ?? [];
      const after = drop(before);
      if (after.length !== before.length) { q.analysis[key] = after; out.push({ where: `${q.code} — analysis (${key === "crosstabBy" ? "tabulated against" : "related to"})`, effect: "the question is no longer listed", path: `questions[${qi}].analysis.${key}`, kind: "cleared" }); }
    }
  });
  const plan = def.research?.analysisPlan;
  if (!plan) return out;
  plan.crosstabs = plan.crosstabs.filter((x, i) => {
    const rows = drop(x.rows), columns = drop(x.columns);
    if (rows.length === x.rows.length && columns.length === x.columns.length) return true;
    if (!rows.length || !columns.length) { out.push({ where: `Analysis plan — crosstab ${x.reason ? `“${x.reason}”` : x.id}`, effect: "removed: it has nothing left to tabulate", path: `research.analysisPlan.crosstabs[${i}]`, kind: "removed" }); return false; }
    x.rows = rows; x.columns = columns;
    out.push({ where: `Analysis plan — crosstab ${x.reason ? `“${x.reason}”` : x.id}`, effect: "the variable is taken out of it", path: `research.analysisPlan.crosstabs[${i}]`, kind: "cleared" });
    return true;
  });
  plan.tests = plan.tests.filter((t, i) => {
    const touched = names(t).some((x) => ns.has(x));
    if (!touched) return true;
    const where = `Analysis plan — ${t.method.replace(/_/g, " ")}${t.reason ? ` “${t.reason}”` : ""}`;
    const variables = drop(t.variables);
    const lostCore = (t.outcome && ns.has(t.outcome)) || (t.groupBy && ns.has(t.groupBy)) || (!variables.length && !t.groupBy && t.method !== "reliability") || (t.method === "reliability" && variables.length < 2);
    if (lostCore) { out.push({ where, effect: "removed: it has lost what it tests", path: `research.analysisPlan.tests[${i}]`, kind: "removed" }); return false; }
    t.variables = variables;
    if (t.moderator && ns.has(t.moderator)) delete t.moderator;
    if (t.mediator && ns.has(t.mediator)) delete t.mediator;
    out.push({ where, effect: "the variable is taken out of it", path: `research.analysisPlan.tests[${i}]`, kind: "cleared" });
    return true;
  });
  plan.derived = plan.derived.filter((d, i) => {
    const from = drop(d.from);
    if (from.length === d.from.length) return true;
    if (!from.length || (d.kind === "top_box" || d.kind === "bottom_box" || d.kind === "recode")) { out.push({ where: `Analysis plan — derived variable ${d.name}`, effect: "removed: its source is gone", path: `research.analysisPlan.derived[${i}]`, kind: "removed" }); return false; }
    d.from = from;
    out.push({ where: `Analysis plan — derived variable ${d.name}`, effect: "built from one item fewer", path: `research.analysisPlan.derived[${i}]`, kind: "cleared" });
    return true;
  });
  plan.segments = plan.segments.filter((s, i) => {
    const b = drop(s.by);
    if (b.length === s.by.length) return true;
    if (!b.length) { out.push({ where: `Analysis plan — segment “${s.name}”`, effect: "removed: nothing defines it", path: `research.analysisPlan.segments[${i}]`, kind: "removed" }); return false; }
    s.by = b; out.push({ where: `Analysis plan — segment “${s.name}”`, effect: "defined by one variable fewer", path: `research.analysisPlan.segments[${i}]`, kind: "cleared" });
    return true;
  });
  return out;
}

/** Rename a variable wherever the analysis framework names it, in place. */
export function renameAnalysisReferences(def: SurveyDefinition, oldName: string, newName: string): number {
  let n = 0;
  const ren = (xs: string[]) => xs.map((x) => (x === oldName ? (n++, newName) : x));
  for (const q of def.questions) {
    if (!q.analysis) continue;
    q.analysis.crosstabBy = ren(q.analysis.crosstabBy ?? []);
    q.analysis.relatedTo = ren(q.analysis.relatedTo ?? []);
  }
  const plan = def.research?.analysisPlan;
  if (!plan) return n;
  for (const x of plan.crosstabs) { x.rows = ren(x.rows); x.columns = ren(x.columns); }
  for (const t of plan.tests) {
    t.variables = ren(t.variables);
    for (const k of ["outcome", "groupBy", "moderator", "mediator"] as const) if (t[k] === oldName) { t[k] = newName; n++; }
  }
  for (const d of plan.derived) d.from = ren(d.from);
  for (const s of plan.segments) s.by = ren(s.by);
  return n;
}

/* ------------------------------------------------------------ review */

export interface AnalysisPlanIssue {
  level: "critical" | "warning" | "suggestion";
  message: string;
  questionIds: string[];
  suggestion?: string;
}

const resolve = (def: SurveyDefinition, ref: string): Question | undefined => getQuestionByCodeOrVar(def, ref) ?? def.questions.find((q) => q.id === ref);

/** The plan against the survey: dead references, tests on the wrong level, hypotheses nothing measures or tests. */
export function reviewAnalysisPlan(def: SurveyDefinition): AnalysisPlanIssue[] {
  const out: AnalysisPlanIssue[] = [];
  const plan = def.research?.analysisPlan;
  const ids = (refs: string[]) => refs.map((r) => resolve(def, r)?.id).filter((x): x is string => !!x);
  if (plan) {
    for (const x of plan.crosstabs) {
      const dead = [...x.rows, ...x.columns].filter((r) => !resolve(def, r));
      if (dead.length) out.push({ level: "critical", message: `Planned crosstab ${x.reason ? `“${x.reason}”` : x.id} reads ${dead.join(", ")}, which ${dead.length === 1 ? "is" : "are"} not in the survey.`, questionIds: ids([...x.rows, ...x.columns]), suggestion: "Remove it from the plan, or add the question back." });
      const same = x.rows.filter((r) => x.columns.includes(r));
      if (same.length) out.push({ level: "warning", message: `Planned crosstab ${x.id} tabulates ${same.join(", ")} against itself.`, questionIds: ids(same) });
      for (const r of [...x.rows, ...x.columns]) { const q = resolve(def, r); if (q && measurementOf(q) === "text") out.push({ level: "warning", message: `Planned crosstab ${x.id} tabulates ${q.code}, an open text — code it first, or use text themes.`, questionIds: [q.id] }); }
    }
    for (const t of plan.tests) {
      const refs = names(t);
      const dead = refs.filter((r) => !resolve(def, r));
      if (dead.length) { out.push({ level: "critical", message: `Planned ${t.method.replace(/_/g, " ")}${t.reason ? ` “${t.reason}”` : ""} reads ${dead.join(", ")}, which ${dead.length === 1 ? "is" : "are"} not in the survey.`, questionIds: ids(refs), suggestion: "Remove it from the plan, or add the question back." }); continue; }
      const outcome = t.outcome ? resolve(def, t.outcome) : undefined;
      const ol = outcome ? measurementOf(outcome) : undefined;
      const group = t.groupBy ? resolve(def, t.groupBy) : undefined;
      if ((t.method === "t_test" || t.method === "anova" || t.method === "mann_whitney" || t.method === "kruskal_wallis") && ol && !isScaleLike(ol)) out.push({ level: "warning", message: `A ${t.method.replace(/_/g, " ")} compares means, but ${outcome!.code} is ${ol} — use a chi-square, or treat it as a scale deliberately.`, questionIds: [outcome!.id] });
      if (t.method === "t_test" && group && (group.options?.length ?? 0) > 2) out.push({ level: "warning", message: `A t-test compares two groups, but ${group.code} has ${group.options.length} — use ANOVA.`, questionIds: [group.id] });
      if (t.method === "anova" && group && (group.options?.length ?? 0) === 2) out.push({ level: "suggestion", message: `${group.code} has two groups — a t-test says the same thing more simply than ANOVA.`, questionIds: [group.id] });
      if (t.method === "chi_square" && ((ol && isScaleLike(ol) && ol !== "ordinal") || refs.some((r) => { const q = resolve(def, r); return q && (measurementOf(q) === "ratio" || measurementOf(q) === "interval"); }))) out.push({ level: "warning", message: `A chi-square needs categories; ${t.reason ?? t.id} includes a numeric variable — band it, or compare means.`, questionIds: ids(refs) });
      if ((t.method === "correlation" || t.method === "regression") && refs.some((r) => { const q = resolve(def, r); return q && (measurementOf(q) === "nominal" && (q.options?.length ?? 0) > 2); })) out.push({ level: "warning", message: `${t.method === "correlation" ? "A correlation" : "A regression"} treats its variables as numbers; ${t.reason ?? t.id} includes a nominal variable with more than two categories — recode it to dummies or use a different test.`, questionIds: ids(refs) });
      if (t.method === "logistic_regression" && outcome && !(isCategorical(ol!) && (outcome.options?.length ?? 0) === 2)) out.push({ level: "warning", message: `Logistic regression needs a two-category outcome; ${outcome.code} is not one.`, questionIds: [outcome.id] });
      if (t.method === "reliability" && t.variables.length < 2) out.push({ level: "warning", message: `Reliability (${t.reason ?? t.id}) needs at least two items.`, questionIds: ids(t.variables) });
      if (t.method === "maxdiff_scores" && refs.every((r) => resolve(def, r)?.type !== "maxdiff_task")) out.push({ level: "critical", message: `MaxDiff scores are planned on ${refs.join(", ")}, but none is a MaxDiff exercise.`, questionIds: ids(refs) });
      if (t.method === "conjoint_utilities" && refs.every((r) => !/conjoint|acbc/.test(resolve(def, r)?.type ?? ""))) out.push({ level: "critical", message: `Conjoint utilities are planned on ${refs.join(", ")}, but none is a conjoint exercise.`, questionIds: ids(refs) });
    }
    for (const d of plan.derived) {
      const dead = d.from.filter((r) => !resolve(def, r));
      if (dead.length) out.push({ level: "critical", message: `Derived variable ${d.name} is built from ${dead.join(", ")}, which ${dead.length === 1 ? "is" : "are"} not in the survey.`, questionIds: ids(d.from) });
      if (def.questions.some((q) => q.variableName === d.name) || (def.calculations ?? []).some((c) => c.targetVariable === d.name)) out.push({ level: "warning", message: `Derived variable ${d.name} has the same name as an existing variable.`, questionIds: ids(d.from) });
    }
  }
  for (const q of def.questions) {
    const a = q.analysis;
    if (!a) continue;
    const dead = [...(a.crosstabBy ?? []), ...(a.relatedTo ?? [])].filter((r) => !resolve(def, r));
    if (dead.length) out.push({ level: "warning", message: `${q.code}'s analysis names ${dead.join(", ")}, which ${dead.length === 1 ? "is" : "are"} not in the survey.`, questionIds: [q.id] });
    const hs = def.research?.hypotheses.length ?? 0;
    const badH = (a.hypotheses ?? []).filter((h) => { const m = /^H(\d+)$/i.exec(h); return !m || Number(m[1]) < 1 || Number(m[1]) > hs; });
    if (badH.length) out.push({ level: "warning", message: `${q.code} is tagged with ${badH.join(", ")}, but the research design has ${hs} hypothes${hs === 1 ? "is" : "es"}.`, questionIds: [q.id] });
    if (a.role === "dependent" && measurementOf(q) === "text") out.push({ level: "suggestion", message: `${q.code} is a dependent variable measured as open text — it cannot be tested statistically without coding.`, questionIds: [q.id], suggestion: "Add a closed measure beside it, or plan a coding frame." });
  }
  for (const h of hypothesisCoverage(def)) {
    if (h.status === "unlinked") out.push({ level: "warning", message: `${h.label} (“${h.text.slice(0, 80)}${h.text.length > 80 ? "…" : ""}”) names no construct and no question is tagged with it, so nothing in the survey tests it.`, questionIds: [], suggestion: `Name its constructs in the research design, or tag the questions that measure it with ${h.label}.` });
    else if (h.status === "partly" && def.research?.analysisPlan) out.push({ level: "suggestion", message: `${h.label} is measured but no planned test or crosstab reads it.`, questionIds: [], suggestion: "Add a test or crosstab for it to the analysis plan." });
  }
  return out;
}

/* ------------------------------------------------------------ methodology */

export interface MethodologyOption {
  method: string;
  /** what it is good for, in one line */
  fit: string;
  strengths: string[];
  tradeoffs: string[];
  /** the question type(s) that implement it here */
  implementedAs: string;
}
export interface MethodologyAdvice {
  goal: string;
  recommended: string;
  options: MethodologyOption[];
}

const METHODS: Record<string, MethodologyOption> = {
  rating: { method: "Rating scales", fit: "quick importance or agreement per item", strengths: ["fast", "familiar", "one item per concept"], tradeoffs: ["everything rates 'important' — poor discrimination", "scale-use bias across cultures"], implementedAs: "matrix (Likert) or single-select scale" },
  ranking: { method: "Ranking", fit: "a strict order of a short list", strengths: ["forces discrimination", "easy to read"], tradeoffs: ["hard beyond ~7 items", "no distance between ranks", "no interaction with price or other attributes"], implementedAs: "ranking (drag)" },
  maxdiff: { method: "MaxDiff (best–worst scaling)", fit: "the relative importance of 8–30 items on one ratio scale", strengths: ["strong discrimination", "scale-free, comparable across markets", "individual-level scores"], tradeoffs: ["longer than rating", "importance only — not trade-off against price or features together", "needs a design"], implementedAs: "maxdiff_task" },
  conjoint: { method: "Choice-based conjoint", fit: "trade-offs between attribute levels, price included; share simulation", strengths: ["realistic choices", "part-worths and willingness to pay", "market simulation"], tradeoffs: ["needs careful attribute design", "the longest of these", "attribute count limited (~6)"], implementedAs: "conjoint_task (CBC) or acbc_task (adaptive)" },
  turf: { method: "TURF", fit: "which combination of items reaches the most people", strengths: ["answers the line-up question directly"], tradeoffs: ["needs a reach measure per item (appeal, purchase)", "says nothing about why"], implementedAs: "multi-select or rating items, analysed as TURF" },
  vanw: { method: "Van Westendorp price sensitivity", fit: "the acceptable price range for one concept", strengths: ["four questions", "readable range"], tradeoffs: ["stated, not chosen", "no competitive context"], implementedAs: "four numeric questions, analysed as pricing" },
  gabor: { method: "Gabor–Granger", fit: "demand at set price points", strengths: ["a demand curve", "revenue-optimal price"], tradeoffs: ["price only, no features", "anchoring between points"], implementedAs: "a sequence of purchase-intent questions, analysed as pricing" },
  monadic: { method: "Monadic concept test", fit: "how one concept performs on its own", strengths: ["clean read per concept", "no contrast effects"], tradeoffs: ["needs a cell per concept — sample multiplies"], implementedAs: "a randomizer showing one concept block of N, with the same KPI battery" },
  sequential: { method: "Sequential monadic", fit: "several concepts rated by each respondent", strengths: ["smaller sample", "within-person comparison"], tradeoffs: ["order and contrast effects — rotate the concepts"], implementedAs: "a randomizer over the concept blocks, all shown" },
  funnel: { method: "Brand funnel", fit: "awareness → consideration → usage → preference by brand", strengths: ["conversion between stages", "benchmarkable"], tradeoffs: ["describes, does not explain — add image attributes for drivers"], implementedAs: "aided/unaided awareness, consideration, usage, preference questions, analysed as brand" },
  drivers: { method: "Key driver analysis", fit: "which attributes move an outcome (satisfaction, intent)", strengths: ["derived importance — no asking 'how important'", "actionable"], tradeoffs: ["needs the attributes rated AND the outcome", "collinearity between attributes"], implementedAs: "attribute ratings plus an outcome scale, analysed by regression / relative weights" },
  segmentation: { method: "Segmentation", fit: "groups of respondents with different needs or behaviour", strengths: ["targets the strategy"], tradeoffs: ["needs a basis battery", "segments must be reproducible"], implementedAs: "attitude / needs battery, analysed by cluster or factor + cluster" },
  nps: { method: "NPS", fit: "a single loyalty KPI", strengths: ["widely benchmarked"], tradeoffs: ["coarse", "needs follow-up for why"], implementedAs: "nps plus an open-ended reason" },
  abtest: { method: "A/B (split) test", fit: "one stimulus against another, between respondents", strengths: ["clean causal comparison"], tradeoffs: ["needs enough respondents per cell", "one factor at a time unless designed factorially"], implementedAs: "a randomizer showing one of the stimulus blocks; the same questions after each" },
};

/**
 * Which method fits a goal — "which features do consumers value most",
 * "what price", "does the ad work" — as the recommended one and the
 * alternatives with their trade-offs. A deterministic lookup the copilot
 * can quote and the researcher can overrule; null when the goal names no
 * method decision.
 */
export function methodologyAdvice(goal: string): MethodologyAdvice | null {
  const g = goal.toLowerCase();
  const pick = (recommended: string, ...others: string[]): MethodologyAdvice => ({ goal, recommended: METHODS[recommended].method, options: [recommended, ...others].map((k) => METHODS[k]) });
  if (/\b(?:price|pricing|willing(?:ness)? to pay|wtp|how much would)\b/.test(g)) {
    if (/\b(?:feature|attribute|bundle|configuration|trade[- ]?off|package)\b/.test(g)) return pick("conjoint", "gabor", "vanw");
    return /\b(?:demand|price points?|elasticity|revenue)\b/.test(g) ? pick("gabor", "vanw", "conjoint") : pick("vanw", "gabor", "conjoint");
  }
  if (/\b(?:feature|attribute|benefit|claim|message|statement)s?\b.*\b(?:value|prefer|important|prioriti[sz]|rank|matter|most)\b|\b(?:value|prefer|important|prioriti[sz]e|rank)\b.*\b(?:feature|attribute|benefit|claim|message|statement)s?\b/.test(g)) {
    if (/\btrade[- ]?offs?\b|\bprice\b|\bconfigur|\bbundle/.test(g)) return pick("conjoint", "maxdiff", "ranking");
    if (/\b(?:line[- ]?up|portfolio|reach|combination|assortment)\b/.test(g)) return pick("turf", "maxdiff", "rating");
    return pick("maxdiff", "ranking", "rating", "conjoint");
  }
  if (/\b(?:driver|drives|what (?:explains|influences|affects)|why do .* (?:choose|prefer|buy)|key drivers?)\b/.test(g)) return pick("drivers", "maxdiff", "rating");
  if (/\bsegment(?:ation|s)?\b|\bpersonas?\b|\bclusters?\b/.test(g)) return pick("segmentation", "drivers");
  if (/\b(?:awareness|consideration|funnel|brand health|brand tracking|track(?:ing|er)?)\b/.test(g)) return pick("funnel", "nps", "drivers");
  if (/\bconcepts?\b|\bidea testing\b|\bnew product\b|\bproposition\b/.test(g)) return /\b(?:several|multiple|two|three|four|\d+ concepts|compare)\b/.test(g) ? pick("sequential", "monadic", "abtest") : pick("monadic", "sequential", "abtest");
  if (/\b(?:a\/b|ab test|split test|which (?:ad|creative|version|variant|execution)(?: \w+)? (?:works|performs|is better|wins))\b|\badvertising (?:test|effectiveness)\b|\bad test\b|\bcopy test/.test(g)) return pick("abtest", "sequential", "monadic");
  if (/\b(?:nps|net promoter|loyalty|recommend)\b/.test(g)) return pick("nps", "drivers");
  if (/\b(?:satisfaction|csat|customer experience)\b/.test(g)) return pick("drivers", "nps", "rating");
  return null;
}
