import type { AnalysisMethod, AnalysisPlan, AnalysisRole, MeasurementLevel, PlannedCrosstab, PlannedDerived, PlannedSegment, PlannedTest, Question, QuestionAnalysis, SurveyDefinition } from "@rescript/schema";
import { hypothesisConstructs, structuredHypotheses } from "./hypotheses.js";
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
  const structured = structuredHypotheses(def);
  return r.hypotheses.map((text, i) => {
    const label = hypothesisLabel(i);
    // the constructs on the hypothesis's sides (recorded or parsed, Phase 3), and any whose name the statement carries
    const named = new Set(hypothesisConstructs(structured[i]).map((c) => c.name));
    const constructs = (r.constructs ?? []).filter((c) => named.has(c.name) || hypothesesNaming(def, c.name).includes(label)).map((c) => {
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
  /*
   * THE SAMPLE THE STUDY EXPECTS (the quotas' targets, or the research
   * design's sample size) bounds how finely the plan may split it: a banner
   * column needs about 30 per group to be read, an ANOVA about 20 per group.
   * A split the sample cannot carry is left out of the banner, or kept with
   * "consider banding" in its reason — never proposed as if it were fine.
   */
  const expected = expectedSample(def)?.n ?? null;
  const groupsOf = (q: Question) => Math.max(q.options?.length ?? 0, 2);

  /* outcomes by the banner */
  for (const dv of dependents) {
    if (!isCategorical(level(dv)) && !isScaleLike(level(dv))) continue;
    const all = segments.filter((s) => s.id !== dv.id);
    if (!all.length) continue;
    const fits = expected == null ? all : all.filter((s) => BANNER_PER_COLUMN * groupsOf(s) <= expected);
    // nothing fits: keep the coarsest cut rather than no profile at all, and say so
    const keep = fits.length ? fits : [...all].sort((a, b) => groupsOf(a) - groupsOf(b)).slice(0, 1);
    const left = all.filter((s) => !keep.includes(s));
    const tight = expected != null ? keep.filter((s) => BANNER_PER_COLUMN * groupsOf(s) > expected) : [];
    const h = hyp(dv);
    const note = [
      left.length ? `${left.map((s) => `${s.code} (${groupsOf(s)} groups)`).join(", ")} left out of the banner — ${expected} expected completes cannot give each group ${BANNER_PER_COLUMN}; consider banding ${left.length === 1 ? "it" : "them"}` : "",
      tight.length ? `${tight.map((s) => s.code).join(", ")} ha${tight.length === 1 ? "s" : "ve"} more groups than ${expected} completes read well — consider banding` : "",
    ].filter(Boolean).join("; ");
    crosstabs.push({ id: id("xt"), rows: [by(dv)], columns: keep.map(by), measure: isScaleLike(level(dv)) && level(dv) !== "ordinal" ? "mean" : "pct_col", priority: h.length ? 1 : 2, hypotheses: h, reason: `${dv.code} (${info.get(dv.id)!.construct ?? "the outcome"}) by the sample profile${note ? ` — ${note}` : ""}` });
  }
  /* independent × dependent, where a table can show it */
  for (const dv of dependents) for (const iv of [...independents, ...moderators]) {
    if (iv.id === dv.id) continue;
    // a table needs GROUPS across the top: a nominal or multi-select independent; a scale × scale pair is a correlation below
    if (!(level(iv) === "nominal" || level(iv) === "multi") || !(isCategorical(level(dv)) || isScaleLike(level(dv)))) continue;
    const h = hyp(dv, iv);
    /*
     * A MULTI-SELECT ACROSS THE TOP is a table, never a t-test or ANOVA: a
     * respondent who ticked two brands is in two columns, so the "groups"
     * overlap and a test that assumes independent groups would count them
     * twice. Each option is its own column; the per-column significance letters
     * of the crosstab compare each option's buyers with the rest.
     */
    const multi = level(iv) === "multi" ? ` — ${iv.code} is multi-select: each option is a column and a respondent can be in several, so the groups overlap and no t-test or ANOVA across its options is proposed` : "";
    crosstabs.push({ id: id("xt"), rows: [by(dv)], columns: [by(iv)], measure: isScaleLike(level(dv)) && level(dv) !== "ordinal" ? "mean" : "pct_col", priority: h.length ? 1 : 2, hypotheses: h, reason: `${dv.code} by ${iv.code}${h.length ? ` (${h.join(", ")})` : ""}${multi}` });
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
      // a multi-select independent is a crosstab above (its options overlap) — not a grouping variable for a test
      if (ivl === "multi") continue;
      if (isScaleLike(ivl) && isScaleLike(dvl)) tests.push({ id: id("t"), method: "correlation", outcome: by(dv), variables: [by(iv)], priority: h.length ? 1 : 2, hypotheses: h, reason: r });
      else if (isCategorical(ivl) && ivl !== "ordinal" && isScaleLike(dvl)) {
        const groups = iv.options?.length ?? 0;
        const band = expected != null && groups > 2 && ANOVA_PER_GROUP * groups > expected ? ` — ${groups} groups need about ${ANOVA_PER_GROUP * groups} completes and ${expected} are expected; consider banding ${iv.code} into ${Math.max(2, Math.floor(expected / ANOVA_PER_GROUP))} or fewer groups` : "";
        tests.push({ id: id("t"), method: groups === 2 ? "t_test" : "anova", outcome: by(dv), variables: [], groupBy: by(iv), priority: h.length ? 1 : 2, hypotheses: h, reason: `${dv.code} compared across ${iv.code}${band}` });
      } else if (isCategorical(ivl) && isCategorical(dvl)) tests.push({ id: id("t"), method: "chi_square", outcome: by(dv), variables: [by(iv)], priority: h.length ? 1 : 2, hypotheses: h, reason: r });
    }
    /* one model per outcome */
    const scalePredictors = predictors.filter((p) => isScaleLike(level(p)) || (isCategorical(level(p)) && level(p) !== "multi" && (p.options?.length ?? 0) === 2));
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

  /*
   * A MONADIC DESIGN: a randomizer that shows each respondent ONE of its
   * blocks, and an outcome measured after (or the same outcome inside every
   * block). The comparison the design exists for is between the arms — and
   * it can only run when the arm a respondent saw is recorded. When each
   * block sets the same embedded variable, the plan compares the outcome
   * across it (the per-block versions of an outcome first combined into one
   * score — each respondent answered exactly one of them); when nothing
   * records the arm, the review says so and offers the variable.
   */
  for (const m of monadicDesigns(def)) {
    if (!m.armVariable) continue;
    const method: AnalysisMethod = m.arms.length === 2 ? "t_test" : "anova";
    for (const dv of m.outcomesAfter) {
      if (!isScaleLike(level(dv)) && !(isCategorical(level(dv)) && level(dv) !== "multi")) continue;
      const scale = isScaleLike(level(dv));
      tests.push({ id: id("t"), method: scale ? method : "chi_square", outcome: by(dv), variables: scale ? [] : [m.armVariable], ...(scale ? { groupBy: m.armVariable } : {}), priority: 1, hypotheses: hyp(dv), reason: `between-arms comparison: each respondent saw one of ${m.arms.length} blocks of “${m.title}”, so ${dv.code} is compared across ${m.armVariable}` });
    }
    for (const set of m.parallel) {
      const name = `${by(set[0]).replace(/_?[A-Z0-9]{1,3}$/i, "") || by(set[0])}_ARMS`.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 40);
      if (derived.some((d) => d.name === name) || def.questions.some((q) => q.variableName === name)) continue;
      derived.push({ name, kind: "mean_score", from: set.map(by), reason: `${set.map((q) => q.code).join(", ")} are one outcome asked in each arm of “${m.title}” — each respondent answered one, so their mean is the one they gave` });
      if (set.every((q) => isScaleLike(level(q)))) tests.push({ id: id("t"), method, outcome: name, variables: [], groupBy: m.armVariable, priority: 1, hypotheses: hyp(...set), reason: `between-arms comparison: ${name} (${set.map((q) => q.code).join(" / ")}) compared across ${m.armVariable}` });
    }
  }

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
  /** the action that fixes it, when one does — in the survey-action vocabulary (`create_embedded` for an unrecorded arm) */
  fix?: { op: "create_embedded"; name: string; source: "static"; value?: string };
  /** the plan item it is about, when it is about one */
  itemId?: string;
}

const resolve = (def: SurveyDefinition, ref: string): Question | undefined => getQuestionByCodeOrVar(def, ref) ?? def.questions.find((q) => q.id === ref);

/** The plan against the survey: dead references, tests on the wrong level, hypotheses nothing measures or tests. */
export function reviewAnalysisPlan(def: SurveyDefinition): AnalysisPlanIssue[] {
  const out: AnalysisPlanIssue[] = [];
  const plan = def.research?.analysisPlan;
  const ids = (refs: string[]) => refs.map((r) => resolve(def, r)?.id).filter((x): x is string => !!x);
  // a derived variable, a segment, an embedded field or a calculation is a variable the run has, not a dead reference
  const missing = (r: string) => !resolve(def, r) && !isNonQuestionVariable(def, r, plan);
  if (plan) {
    for (const x of plan.crosstabs) {
      const dead = [...x.rows, ...x.columns].filter(missing);
      if (dead.length) out.push({ level: "critical", message: `Planned crosstab ${x.reason ? `“${x.reason}”` : x.id} reads ${dead.join(", ")}, which ${dead.length === 1 ? "is" : "are"} not in the survey.`, questionIds: ids([...x.rows, ...x.columns]), suggestion: "Remove it from the plan, or add the question back." });
      const same = x.rows.filter((r) => x.columns.includes(r));
      if (same.length) out.push({ level: "warning", message: `Planned crosstab ${x.id} tabulates ${same.join(", ")} against itself.`, questionIds: ids(same) });
      for (const r of [...x.rows, ...x.columns]) { const q = resolve(def, r); if (q && measurementOf(q) === "text") out.push({ level: "warning", message: `Planned crosstab ${x.id} tabulates ${q.code}, an open text — code it first, or use text themes.`, questionIds: [q.id] }); }
    }
    for (const t of plan.tests) {
      const refs = names(t);
      const dead = refs.filter(missing);
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
      const dead = d.from.filter(missing);
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
  /* the sample: what each planned item needs against what the study expects */
  if (plan) out.push(...sampleSizeReview(def, plan));
  /* a monadic design whose arm is not recorded cannot compare its arms */
  out.push(...monadicReview(def));
  for (const h of hypothesisCoverage(def)) {
    if (h.status === "unlinked") out.push({ level: "warning", message: `${h.label} (“${h.text.slice(0, 80)}${h.text.length > 80 ? "…" : ""}”) names no construct and no question is tagged with it, so nothing in the survey tests it.`, questionIds: [], suggestion: `Name its constructs in the research design, or tag the questions that measure it with ${h.label}.` });
    else if (h.status === "partly" && def.research?.analysisPlan) out.push({ level: "suggestion", message: `${h.label} is measured but no planned test or crosstab reads it.`, questionIds: [], suggestion: "Add a test or crosstab for it to the analysis plan." });
  }
  return out;
}

/* ------------------------------------------------------------ sample size */

/*
 * HOW MANY COMPLETES A PLANNED ITEM NEEDS — rules of thumb, each stated with
 * where it comes from, so the researcher can overrule them knowingly. None is
 * a power analysis (that needs an effect size nobody has before fieldwork);
 * each is the floor below which the result is not worth reading.
 *
 *   crosstab / chi-square  an expected count of ≥ 5 in every cell (Cochran
 *                          1954) → about 5 × rows × columns if the answers
 *                          spread evenly; and a banner column is read at ≥ 30
 *   t-test                 ≥ 30 per group, two groups (the central-limit rule)
 *   ANOVA                  ≥ 20 per group × the groups
 *   correlation            ≥ 30 to estimate r at all; ≥ 85 to detect r = .3
 *                          with 80% power at α = .05 (Cohen 1988)
 *   linear regression      max(50 + 8k, 104 + k) for k predictors (Green 1991:
 *                          the model, and each predictor)
 *   logistic regression    10 events of the rarer outcome per predictor
 *                          (Peduzzi et al. 1996) → 10·k ÷ that outcome's share
 *   factor / reliability   ≥ 5 per item and ≥ 100 (Gorsuch 1983)
 *   cluster / segmentation ≥ 100, and ≥ 2^k for k clustering variables
 *                          (Formann 1984) — kept simple
 *   MaxDiff / conjoint     ≥ 200 (Orme's rule of thumb for stable aggregate
 *                          utilities; the design's tasks and versions do the rest)
 *   a segment              ≥ 30 per segment
 *   a descriptive          ≥ 30 — the base this platform reads any result at
 */
export const CELL_EXPECTED = 5;
export const BANNER_PER_COLUMN = 30;
export const T_TEST_PER_GROUP = 30;
export const ANOVA_PER_GROUP = 20;
export const MIN_READ_BASE = 30;

export interface ExpectedSample {
  n: number;
  source: "quotas" | "research" | "population";
  /** for a sentence's end: "the quotas target 120" */
  note: string;
  /** where the number comes from, in full */
  detail: string;
}

/**
 * The completes the study expects: the quotas' targets (a quota's target
 * total, else the sum of its cells' targets, else of their maximums — the
 * largest quota, since each independent quota covers the whole sample), else
 * the research design's `sampleSize`, else a number in its population note
 * ("n = 400", "500 respondents"); null when nothing says.
 */
export function expectedSample(def: SurveyDefinition): ExpectedSample | null {
  const quotas = (def.quotas ?? []).map((q) => {
    const counts = q.cells.filter((c) => c.limitType !== "percent");
    const targeted = counts.filter((c) => typeof c.target === "number" && c.target > 0);
    if (typeof q.targetTotal === "number" && q.targetTotal > 0) return { q, n: q.targetTotal, how: "its target total" };
    if (counts.length && targeted.length === counts.length) return { q, n: targeted.reduce((t, c) => t + (c.target ?? 0), 0), how: `the sum of its ${counts.length} cells' targets` };
    if (counts.length) return { q, n: counts.reduce((t, c) => t + c.limit, 0), how: `the sum of its ${counts.length} cells' maximums` };
    return { q, n: 0, how: "" };
  }).filter((x) => x.n > 0).sort((a, b) => Number(/maximums/.test(a.how)) - Number(/maximums/.test(b.how)) || b.n - a.n);
  // a stated target beats a cap: the largest quota that says what it aims for, else the largest sum of maximums
  if (quotas.length) { const b = quotas[0]; return { n: b.n, source: "quotas", note: `the quotas target ${b.n}`, detail: `${b.n} completes — quota “${b.q.name}”, ${b.how}` }; }
  const size = def.research?.sampleSize;
  if (typeof size === "number" && size > 0) return { n: size, source: "research", note: `the research design plans ${size}`, detail: `${size} completes — the research design's sample size` };
  const pop = def.research?.population ?? "";
  const m = /\bn\s*=\s*([\d][\d,.\s]*\d|\d)/i.exec(pop) ?? /\b(\d[\d,]*)\s+(?:respondents|completes|completed\s+interviews|interviews|participants|people|consumers|adults)\b/i.exec(pop) ?? /\bsample\s+(?:size\s+)?(?:of\s+)?(\d[\d,]*)\b/i.exec(pop);
  const n = m ? Number(m[1].replace(/[,.\s]/g, "")) : NaN;
  if (Number.isFinite(n) && n > 0) return { n, source: "population", note: `the population note says ${n}`, detail: `${n} completes — from the research design's population “${pop.slice(0, 60)}”` };
  return null;
}

export interface RequiredBase {
  /** the completes below which the item is not worth reading */
  minimum: number;
  /** how the number was reached: "5 per cell × 6 × 5" */
  note: string;
  /** the rule in words, with its source */
  rule: string;
  /** a larger, better number when the rule has one (a correlation's power) */
  recommended?: number;
}

type PlanItem = PlannedCrosstab | PlannedTest | PlannedDerived | PlannedSegment;
export type PlanItemKind = "crosstab" | "test" | "derived" | "segment";
export const planItemKind = (x: PlanItem): PlanItemKind => ("rows" in x ? "crosstab" : "method" in x ? "test" : "from" in x ? "derived" : "segment");

/** the variable name a planned segment is computed as — its name when that is a variable name, else SEG_<NAME> */
export function segmentVariableName(seg: Pick<PlannedSegment, "name">): string {
  if (/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(seg.name)) return seg.name;
  return `SEG_${seg.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32) || "1"}`;
}

/** Does `name` name a variable the run has that is not a question — a derived variable, a segment, an embedded field, a calculation, a design's arm? */
export function isNonQuestionVariable(def: SurveyDefinition, name: string, plan = def.research?.analysisPlan): boolean {
  if ((plan?.derived ?? []).some((d) => d.name === name)) return true;
  if ((plan?.segments ?? []).some((s) => s.name === name || segmentVariableName(s) === name)) return true;
  if ((def.calculations ?? []).some((c) => c.targetVariable === name)) return true;
  return embeddedNames(def).includes(name);
}

function embeddedNames(def: SurveyDefinition): string[] {
  const out: string[] = [];
  const walk = (nodes: unknown[]): void => {
    for (const n of (nodes ?? []) as { type?: string; fields?: { name: string }[]; children?: unknown[]; branches?: { children: unknown[] }[]; otherwise?: unknown[] }[]) {
      if (n.type === "embedded_data") out.push(...(n.fields ?? []).map((f) => f.name).filter(Boolean));
      if (n.children) walk(n.children);
      for (const b of n.branches ?? []) walk(b.children);
      if (n.otherwise) walk(n.otherwise);
    }
  };
  walk(def.flow as unknown[]);
  return out;
}

/** how many categories a variable splits the sample into — null for a number (no categories) */
function categoriesOfVariable(def: SurveyDefinition, name: string, plan?: AnalysisPlan): number | null {
  const q = resolve(def, name);
  if (q) {
    const m = measurementOf(q);
    if (m === "nominal" || m === "ordinal" || m === "multi") return Math.max(q.options?.length ?? 0, 2);
    return null;
  }
  const d = plan?.derived.find((x) => x.name === name);
  if (d) return d.kind === "top_box" || d.kind === "bottom_box" || d.kind === "flag" ? 2 : null;
  const s = plan?.segments.find((x) => x.name === name || segmentVariableName(x) === name);
  if (s) return s.by.reduce((t, v) => t * (categoriesOfVariable(def, v, plan) ?? 3), 1);
  const arm = monadicDesigns(def).find((m) => m.armVariable === name);
  if (arm) return arm.arms.length;
  return null;
}

/** predictors a model estimates: its variables, a moderator and its interaction, a mediator */
const predictorCount = (t: PlannedTest) => t.variables.length + (t.moderator ? 2 : 0) + (t.mediator ? 1 : 0);

/** How many completes a planned item needs, by the rules above — with how the number was reached. */
export function requiredBase(def: SurveyDefinition, item: PlanItem, opts: { plan?: AnalysisPlan; /** the rarer outcome's share, for a logistic model, when known */ outcomeShare?: number } = {}): RequiredBase {
  const plan = opts.plan ?? def.research?.analysisPlan;
  const cats = (v: string) => categoriesOfVariable(def, v, plan);
  const C = (v: string) => resolve(def, v)?.code ?? v;
  const floor: RequiredBase = { minimum: MIN_READ_BASE, note: `a base of ${MIN_READ_BASE}`, rule: `≥ ${MIN_READ_BASE} — the base below which this platform reads any result with caution` };
  switch (planItemKind(item)) {
    case "crosstab": {
      const x = item as PlannedCrosstab;
      let best: RequiredBase = { minimum: BANNER_PER_COLUMN, note: `${BANNER_PER_COLUMN} per column`, rule: "" };
      for (const r of x.rows) for (const c of x.columns) {
        const rc = cats(r), cc = cats(c);
        if (cc == null) continue; // a number across the top must be banded first — the review says so
        const banner = BANNER_PER_COLUMN * cc;
        const cell = rc == null || x.measure === "mean" ? 0 : CELL_EXPECTED * rc * cc;
        const need = Math.max(banner, cell);
        if (need > best.minimum) best = { minimum: need, note: cell >= banner ? `${CELL_EXPECTED} per cell × ${rc} × ${cc}${x.rows.length * x.columns.length > 1 ? `, ${C(r)} by ${C(c)}` : ""}` : `${BANNER_PER_COLUMN} per column × ${cc} columns of ${C(c)}`, rule: "" };
      }
      return { ...best, rule: `an expected count of at least ${CELL_EXPECTED} in every cell for the chi-square (Cochran 1954) — about ${CELL_EXPECTED} × rows × columns when answers spread evenly, more when a category is rare — and at least ${BANNER_PER_COLUMN} per banner column to read it` };
    }
    case "test": {
      const t = item as PlannedTest;
      switch (t.method) {
        case "t_test": case "mann_whitney":
          return { minimum: T_TEST_PER_GROUP * 2, note: `${T_TEST_PER_GROUP} per group × 2 groups`, rule: `at least ${T_TEST_PER_GROUP} per group (the central-limit rule of thumb for comparing two means)` };
        case "anova": case "kruskal_wallis": {
          const g = (t.groupBy ? cats(t.groupBy) : null) ?? 3;
          return { minimum: ANOVA_PER_GROUP * g, note: `${ANOVA_PER_GROUP} per group × ${g} groups${t.groupBy ? ` of ${C(t.groupBy)}` : ""}`, rule: `at least ${ANOVA_PER_GROUP} per group (rule of thumb for a one-way comparison of several means)` };
        }
        case "chi_square": {
          const a = t.outcome ? cats(t.outcome) ?? 2 : 2, b = (t.variables[0] ?? t.groupBy) ? cats(t.variables[0] ?? t.groupBy!) ?? 2 : 2;
          return { minimum: CELL_EXPECTED * a * b, note: `${CELL_EXPECTED} per cell × ${a} × ${b}`, rule: `an expected count of at least ${CELL_EXPECTED} in every cell (Cochran 1954), about ${CELL_EXPECTED} × rows × columns when answers spread evenly` };
        }
        case "correlation":
          return { minimum: 30, recommended: 85, note: "30 to estimate r; 85 to detect r = .3", rule: "at least 30 to estimate a correlation at all; 85 to detect a correlation of .3 with 80% power at α = .05 (Cohen 1988)" };
        case "regression": case "driver_analysis": {
          const k = Math.max(1, predictorCount(t));
          const n = Math.max(50 + 8 * k, 104 + k);
          return { minimum: n, note: `max(50 + 8·${k}, 104 + ${k}) for ${k} predictor${k === 1 ? "" : "s"}`, rule: `Green (1991): 50 + 8k completes to test the model and 104 + k to test each predictor, for k predictors${t.mediator ? "; an indirect (mediated) effect usually needs more — Fritz & MacKinnon (2007) put it between about 70 and 460 depending on the paths' sizes" : ""}` };
        }
        case "logistic_regression": {
          const k = Math.max(1, predictorCount(t));
          // the rule is about the RARER outcome: a share above one half is the common outcome's, so its complement is the rarer one's
          const given = opts.outcomeShare && opts.outcomeShare > 0 && opts.outcomeShare < 1 ? opts.outcomeShare : null;
          const share = given === null ? null : Math.round(Math.min(given, 1 - given) * 1e6) / 1e6;
          const n = Math.ceil((10 * k) / (share ?? 0.5));
          return { minimum: n, note: share ? `10 events × ${k} predictor${k === 1 ? "" : "s"} ÷ ${Math.round(share * 100)}% rarer outcome` : `10 events × ${k} predictor${k === 1 ? "" : "s"} ÷ 50% — the rarer outcome's share is unknown before fieldwork; at 20% it would be ${Math.ceil((10 * k) / 0.2)}`, rule: "10 events of the rarer outcome per predictor (Peduzzi et al. 1996): 10·k divided by the rarer outcome's share" };
        }
        case "factor": case "reliability": {
          const p = Math.max(2, t.variables.length);
          return { minimum: Math.max(100, 5 * p), note: `max(100, 5 × ${p} items)`, rule: `at least 5 respondents per item and never fewer than 100 (Gorsuch 1983)${t.method === "reliability" ? " — α is estimated from the items' correlations, so it follows the factor-analysis rule" : ""}` };
        }
        case "cluster": {
          const k = Math.max(1, t.variables.length);
          const n = Math.max(100, Math.min(2 ** k, 5000));
          return { minimum: n, note: `max(100, 2^${k}) for ${k} clustering variable${k === 1 ? "" : "s"}`, rule: "at least 2^k respondents for k clustering variables (Formann 1984) and never fewer than 100 — a simple floor; a stable segmentation usually needs more" };
        }
        case "maxdiff_scores": case "conjoint_utilities":
          return { minimum: 200, note: "200 respondents", rule: "at least 200 respondents (Orme's rule of thumb for stable aggregate utilities; 200 per subgroup to compare segments) — the design's tasks per respondent and its versions set the rest" };
        case "turf": case "pricing": case "brand_funnel":
          return { minimum: 100, note: "100 respondents", rule: "at least 100 (rule of thumb for a stable reach or price curve)" };
        default:
          return floor;
      }
    }
    case "derived":
      return { ...floor, rule: `${floor.rule}; it is computed for every respondent who answered its sources — a test that reads it needs that test's base` };
    case "segment": {
      const s = item as PlannedSegment;
      const combos = s.by.reduce((t, v) => t * (cats(v) ?? 3), 1);
      return { minimum: MIN_READ_BASE * combos, note: `${MIN_READ_BASE} per segment × ${combos} segment${combos === 1 ? "" : "s"}`, rule: `at least ${MIN_READ_BASE} in each segment — the base a segment's column is read at` };
    }
  }
}

/** a plan item in a few words: "Q6 by S2, S3", "the t-test of Q6 across S2" */
export function planItemTitle(def: SurveyDefinition, item: PlanItem): string {
  const C = (v: string) => resolve(def, v)?.code ?? v;
  switch (planItemKind(item)) {
    case "crosstab": { const x = item as PlannedCrosstab; return `${x.rows.map(C).join(", ")} by ${x.columns.map(C).join(", ")}`; }
    case "test": {
      const t = item as PlannedTest;
      const m = METHOD_WORDS[t.method] ?? t.method.replace(/_/g, " ");
      if (t.groupBy) return `the ${m} of ${t.outcome ? C(t.outcome) : t.variables.map(C).join(", ")} across ${C(t.groupBy)}`;
      if (t.outcome && t.variables.length) return `the ${m} of ${C(t.outcome)} ${/regression|driver/.test(t.method) ? "on" : "with"} ${codeList(def, t.variables)}`;
      return `the ${m} of ${t.outcome ? C(t.outcome) : codeList(def, t.variables)}`;
    }
    case "derived": { const d = item as PlannedDerived; return `derived variable ${d.name}`; }
    case "segment": { const s = item as PlannedSegment; return `segment “${s.name}”`; }
  }
}

const METHOD_WORDS: Partial<Record<AnalysisMethod, string>> = {
  t_test: "t-test", anova: "ANOVA", chi_square: "chi-square test", mann_whitney: "Mann–Whitney test", kruskal_wallis: "Kruskal–Wallis test", correlation: "correlation",
  regression: "regression", logistic_regression: "logistic regression", factor: "factor analysis", reliability: "reliability analysis", cluster: "cluster analysis",
  conjoint_utilities: "conjoint utilities", maxdiff_scores: "MaxDiff scores", driver_analysis: "driver analysis", nps: "NPS", top_box: "top-2-box", turf: "TURF analysis",
};

/** "Q18–Q23" for a run in the survey's order, "Q18, Q20" otherwise */
function codeList(def: SurveyDefinition, names: string[]): string {
  const qs = names.map((n) => resolve(def, n));
  if (qs.length >= 3 && qs.every((q): q is Question => !!q)) {
    const order = questionOrder(def);
    const ix = qs.map((q) => order.indexOf(q.id));
    if (ix.every((v, i) => v >= 0 && (i === 0 || v === ix[i - 1] + 1))) return `${qs[0].code}–${qs[qs.length - 1].code}`;
  }
  return names.map((n, i) => qs[i]?.code ?? n).join(", ");
}

/**
 * Each saved plan item against the sample the study expects: a warning for
 * what needs more completes than are planned ("Q5 by S3 needs about 150
 * completes (5 per cell × 6 × 5) — the quotas target 120"), with the usual
 * remedy; a suggestion when only the better number (a correlation's power)
 * is out of reach. Empty when the study names no sample.
 */
export function sampleSizeReview(def: SurveyDefinition, plan = def.research?.analysisPlan): AnalysisPlanIssue[] {
  const expected = expectedSample(def);
  if (!expected || !plan) return [];
  const out: AnalysisPlanIssue[] = [];
  const ids = (refs: string[]) => refs.map((r) => resolve(def, r)?.id).filter((x): x is string => !!x);
  // `split`: the variables that divide the sample — the ones banding would help (never the outcome)
  const items: { item: PlanItem; id: string; refs: string[]; split: string[] }[] = [
    ...plan.crosstabs.map((x) => ({ item: x as PlanItem, id: x.id, refs: [...x.rows, ...x.columns], split: x.columns })),
    ...plan.tests.map((t) => ({ item: t as PlanItem, id: t.id, refs: names(t), split: t.groupBy ? [t.groupBy] : t.variables })),
    ...plan.segments.map((s) => ({ item: s as PlanItem, id: `segment:${s.name}`, refs: s.by, split: s.by })),
  ];
  for (const { item, id, refs, split } of items) {
    const rb = requiredBase(def, item, { plan });
    const title = planItemTitle(def, item);
    if (rb.minimum > expected.n) {
      const kind = planItemKind(item);
      const t = item as PlannedTest;
      const remedy = kind === "test" && /regression|driver/.test(t.method) ? "Use fewer predictors (or combine them into scores), or raise the sample."
        : kind === "test" && (t.method === "factor" || t.method === "reliability" || t.method === "cluster" || t.method === "maxdiff_scores" || t.method === "conjoint_utilities") ? "Raise the sample, or read the result as exploratory."
        : `Consider banding ${split.filter((r) => (categoriesOfVariable(def, r, plan) ?? 0) > 2).map((r) => resolve(def, r)?.code ?? r).join(", ") || "the groups"} into fewer groups, or raise the sample.`;
      out.push({ level: "warning", message: `${title[0].toUpperCase()}${title.slice(1)} needs about ${rb.minimum} completes (${rb.note}) — ${expected.note}.`, questionIds: ids(refs), suggestion: remedy, itemId: id });
    } else if (rb.recommended && rb.recommended > expected.n) {
      out.push({ level: "suggestion", message: `${title[0].toUpperCase()}${title.slice(1)} can be estimated with ${expected.n} completes, but detecting a modest effect needs about ${rb.recommended} (${rb.note}).`, questionIds: ids(refs), itemId: id });
    }
  }
  return out;
}

/* ------------------------------------------------------------ monadic designs */

export interface MonadicDesign {
  randomizerId: string;
  title: string;
  arms: { id: string; title: string; questionIds: string[] }[];
  /** the embedded variable every arm sets to its own value — the arm a respondent saw; null when nothing records it */
  armVariable: string | null;
  /** dependents asked after the randomizer — of everyone, whichever arm they saw */
  outcomesAfter: Question[];
  /** the same outcome asked inside every arm (one question per arm, same type and answers) */
  parallel: Question[][];
}

interface FlowLike { type?: string; id?: string; title?: string; show?: number; children?: FlowLike[]; questionIds?: string[]; fields?: { name: string; source?: string; value?: string }[]; branches?: { children: FlowLike[] }[]; otherwise?: FlowLike[] }

/**
 * The randomizers that show each respondent ONE of their blocks (`show: 1`)
 * and whose blocks measure the same outcome — after the randomizer, or the
 * same question inside each block. Each with the variable that records the
 * arm, when every block sets one embedded field to a value of its own.
 */
export function monadicDesigns(def: SurveyDefinition): MonadicDesign[] {
  const out: MonadicDesign[] = [];
  const order = questionOrder(def);
  const qOf = (id: string) => def.questions.find((q) => q.id === id);
  const qIds = (n: FlowLike): string[] => [...(n.questionIds ?? []), ...(n.children ?? []).flatMap(qIds), ...(n.branches ?? []).flatMap((b) => b.children.flatMap(qIds)), ...(n.otherwise ?? []).flatMap(qIds)];
  const fields = (n: FlowLike): { name: string; value?: string }[] => [...(n.type === "embedded_data" ? (n.fields ?? []).filter((f) => !f.source || f.source === "static").map((f) => ({ name: f.name, value: f.value })) : []), ...(n.children ?? []).flatMap(fields)];
  const visit = (nodes: FlowLike[]): void => {
    for (const n of nodes ?? []) {
      if (n.type === "randomizer" && n.show === 1 && (n.children ?? []).length >= 2) {
        const arms = (n.children ?? []).map((c, i) => ({ id: c.id ?? `arm${i + 1}`, title: (c.title ?? "").trim() || `arm ${i + 1}`, questionIds: qIds(c), fields: fields(c) }));
        // the arm is recorded when every arm sets the same field, each to a different value
        const shared = arms[0].fields.map((f) => f.name).filter((name) => arms.every((a) => a.fields.some((f) => f.name === name)));
        const armVariable = shared.find((name) => new Set(arms.map((a) => a.fields.find((f) => f.name === name)?.value ?? "")).size === arms.length) ?? null;
        const last = Math.max(-1, ...arms.flatMap((a) => a.questionIds.map((id) => order.indexOf(id))));
        const after = last >= 0 ? order.slice(last + 1) : [];
        const outcomesAfter = after.map(qOf).filter((q): q is Question => !!q && !NOT_ASKED.has(q.type) && inferRole(def, q) === "dependent");
        // the same question in every arm: one per arm with the same type and the same answers
        const sig = (q: Question) => `${q.type}|${(q.options ?? []).map((o) => `${o.code}:${stripHtmlText(o.label).toLowerCase()}`).join(",")}|${(q.rows ?? []).length}`;
        const asked = arms.map((a) => a.questionIds.map(qOf).filter((q): q is Question => !!q && !NOT_ASKED.has(q.type) && measurementOf(q) !== "text"));
        const parallel: Question[][] = [];
        for (const q of asked[0] ?? []) {
          const set = asked.map((qs) => qs.filter((x) => sig(x) === sig(q)));
          if (set.every((xs) => xs.length === 1) && (q.options?.length || isScaleLike(measurementOf(q)))) parallel.push(set.map((xs) => xs[0]));
        }
        if (outcomesAfter.length || parallel.length) out.push({ randomizerId: n.id ?? "", title: (n.title ?? "").trim() || arms.map((a) => a.title).join(" / "), arms: arms.map(({ fields: _f, ...a }) => { void _f; return a; }), armVariable, outcomesAfter, parallel });
      }
      visit(n.children ?? []);
      for (const b of n.branches ?? []) visit(b.children);
      visit(n.otherwise ?? []);
    }
  };
  visit(def.flow as unknown as FlowLike[]);
  return out;
}

/** a monadic design without its arm recorded: the arms cannot be compared — the fix is a variable set in each block */
function monadicReview(def: SurveyDefinition): AnalysisPlanIssue[] {
  return monadicDesigns(def).filter((m) => !m.armVariable).map((m) => {
    const stem = (m.title.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "CONCEPT");
    let name = `${stem}_ARM`;
    for (let i = 2; def.questions.some((q) => q.variableName === name) || embeddedNames(def).includes(name); i++) name = `${stem}_ARM${i}`;
    const what = [...m.outcomesAfter.map((q) => q.code), ...m.parallel.map((set) => set.map((q) => q.code).join("/"))].join(", ");
    return {
      level: "warning" as const,
      message: `Randomizer “${m.title}” shows each respondent one of ${m.arms.length} blocks (${m.arms.map((a) => a.title).join(", ")}) — a monadic design — but which one a respondent saw is not recorded, so ${what} cannot be compared between the arms.`,
      questionIds: [...m.outcomesAfter.map((q) => q.id), ...m.parallel.flat().map((q) => q.id)],
      suggestion: `Record the arm: create the embedded variable ${name} and set it, as a static value, to the block's name inside each block — the plan then compares the arms across it.`,
      fix: { op: "create_embedded" as const, name, source: "static" as const },
    };
  });
}

/* ------------------------------------------------------------ explanation */

export interface PlanVariable {
  name: string;
  code: string;
  text: string;
  /** its measurement level (a derived score is "interval", a 0/1 flag "nominal") */
  level: MeasurementLevel;
  /** what it is in THIS item: outcome, grouping, predictor, moderator, mediator, row, column, item, source, segment variable */
  role: string;
  /** what it is in the design (dependent, independent …, or derived / segment / arm) */
  designRole: string;
  /** the categories it splits the sample into, when it does */
  categories?: number;
}

export interface PlanExplanation {
  kind: PlanItemKind;
  id: string;
  title: string;
  /** the research objective and the hypotheses the item serves, in one sentence */
  objective: string;
  hypotheses: { label: string; text: string }[];
  variables: PlanVariable[];
  /** the rule that chose this method, in words */
  why: string;
  /** what the runner produces for it: tables, statistics, chart */
  expectedOutput: string;
  requiredBase: RequiredBase;
  expectedSample: ExpectedSample | null;
  limitations: string[];
  /** all of it as one paragraph */
  text: string;
}

const plainText = (s: string | undefined, n = 70) => { const t = stripHtmlText(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** "an ordinal 5-point scale", "nominal with 2 groups", "a multi-select of 4 options", "a number" */
function levelWords(q: Question | undefined, v: PlanVariable): string {
  const n = q?.options?.length ?? v.categories ?? 0;
  switch (v.level) {
    case "ordinal": return `an ordinal ${n}-point scale`;
    case "interval": return q?.type === "nps" ? "an interval 0–10 scale" : q ? "an interval scale" : "a score (treated as interval)";
    case "ratio": return "a number (ratio)";
    case "nominal": return n ? `nominal with ${n} groups` : "nominal";
    case "multi": return `a multi-select of ${n} options`;
    case "text": return "open text";
    case "rank": return "a ranking";
    case "allocation": return "an allocation";
    case "choice": return "a choice exercise";
    case "date": return "a date";
  }
}

/**
 * WHY THIS ANALYSIS — the deterministic explanation of one planned item:
 * which objective and hypotheses it serves, which variables it reads and at
 * what level, the rule that chose its method, what the runner will produce,
 * the base it needs against the sample the study expects, and what to keep
 * in mind reading it. "Why are you recommending a regression?" is answered
 * from here, by the engine, not written by a model.
 */
export function explainPlanItem(def: SurveyDefinition, item: PlanItem, plan: AnalysisPlan = def.research?.analysisPlan ?? buildAnalysisFramework(def, { now: "" })): PlanExplanation {
  const kind = planItemKind(item);
  const C = (v: string) => resolve(def, v)?.code ?? v;
  const describe = (name: string, role: string): PlanVariable => {
    const q = resolve(def, name);
    if (q) {
      const a = inferQuestionAnalysis(def, q);
      const cats = categoriesOfVariable(def, name, plan);
      return { name: q.variableName, code: String(q.code), text: plainText(q.text), level: a.measurement, role, designRole: a.role, ...(cats != null ? { categories: cats } : {}) };
    }
    const d = plan.derived.find((x) => x.name === name);
    if (d) return { name, code: name, text: `${d.kind.replace(/_/g, " ")} of ${codeList(def, d.from)}`, level: d.kind === "top_box" || d.kind === "bottom_box" || d.kind === "flag" ? "nominal" : d.kind === "recode" ? "nominal" : "interval", role, designRole: "derived", ...(d.kind === "top_box" || d.kind === "bottom_box" || d.kind === "flag" ? { categories: 2 } : {}) };
    const s = plan.segments.find((x) => x.name === name || segmentVariableName(x) === name);
    if (s) return { name: segmentVariableName(s), code: segmentVariableName(s), text: `segment of ${codeList(def, s.by)}`, level: "nominal", role, designRole: "segment", categories: categoriesOfVariable(def, name, plan) ?? undefined };
    const arm = monadicDesigns(def).find((m) => m.armVariable === name);
    if (arm) return { name, code: name, text: `which arm of “${arm.title}” the respondent saw`, level: "nominal", role, designRole: "arm", categories: arm.arms.length };
    return { name, code: name, text: "", level: "nominal", role, designRole: "variable" };
  };
  const hypLabels = "hypotheses" in item ? (item as PlannedCrosstab | PlannedTest).hypotheses ?? [] : [];
  const hs = def.research?.hypotheses ?? [];
  const hypotheses = hypLabels.map((label) => ({ label, text: hs[Number(/^H(\d+)$/i.exec(label)?.[1] ?? 0) - 1] ?? "" })).filter((h) => h.text);
  const obj = def.research?.objective?.trim();
  const objective = `${obj ? `The study's objective: ${obj.replace(/\.$/, "")}.` : "No research objective is recorded."} ${hypotheses.length ? `This serves ${hypotheses.map((h) => `${h.label} (“${h.text}”)`).join(" and ")}.` : kind === "crosstab" || kind === "test" ? "No hypothesis is tagged on it — it profiles the results." : ""}`.trim();

  let variables: PlanVariable[] = [];
  let why = "", output = "", lead = "";
  const limitations: string[] = [];
  const what = (v: PlanVariable) => { const q = resolve(def, v.name); const c = q ? constructOf(def, q.id)?.name : undefined; return c ? c.toLowerCase() : v.text ? `“${plainText(v.text, 50)}”` : v.name; };

  switch (kind) {
    case "crosstab": {
      const x = item as PlannedCrosstab;
      variables = [...x.rows.map((r) => describe(r, "row")), ...x.columns.map((c) => describe(c, "column"))];
      const rows = variables.filter((v) => v.role === "row"), cols = variables.filter((v) => v.role === "column");
      const mean = x.measure === "mean";
      why = `${rows.map((v) => `${v.code} is ${levelWords(resolve(def, v.name), v)}`).join(", ")} and ${cols.map((v) => `${v.code} is ${levelWords(resolve(def, v.name), v)}`).join(", ")}: groups across the top and ${mean ? "a number down the side, so the table shows each column's mean" : "categories down the side, so the table shows each column's distribution (column percentages)"} with a significance letter on every column that differs from another.`;
      output = `a crosstab of ${rows.map((v) => v.code).join(", ")} by ${cols.map((v) => v.code).join(", ")} (${mean ? "column means" : "column percentages"}${cols.length > 1 ? ", one banner" : ""}) with significance letters between columns and a chi-square test per column variable; a ${mean ? "bar chart of the means" : "stacked bar chart"}`;
      lead = `A crosstab of ${rows.map((v) => v.code).join(", ")} by ${cols.map((v) => v.code).join(", ")} is recommended because ${rows.map((v) => `${v.code} measures ${what(v)}`).join(" and ")} and ${cols.length > 1 ? `${codeList(def, cols.map((v) => v.name))} profile the sample` : `${cols[0].code} ${cols[0].designRole === "segmentation" ? "profiles the sample" : `measures ${what(cols[0])}`}`}.`;
      for (const c of cols) if (c.level === "multi") limitations.push(`${c.code} is multi-select: a respondent counts in every column they chose, so the columns overlap and are not independent groups — read each column against the rest, not against each other.`);
      for (const c of cols) if ((c.categories ?? 0) >= 6) limitations.push(`${c.code} has ${c.categories} groups: unless the sample is large, each column's base is small — consider banding it.`);
      break;
    }
    case "test": {
      const t = item as PlannedTest;
      const out = t.outcome ? describe(t.outcome, "outcome") : undefined;
      const grp = t.groupBy ? describe(t.groupBy, "grouping") : undefined;
      const regression = /regression|driver/.test(t.method);
      const preds = t.variables.map((v) => describe(v, t.method === "reliability" || t.method === "factor" || t.method === "cluster" || t.method === "maxdiff_scores" || t.method === "conjoint_utilities" || t.method === "nps" ? "item" : regression || t.method === "correlation" ? "predictor" : "variable"));
      const mod = t.moderator ? describe(t.moderator, "moderator") : undefined;
      const med = t.mediator ? describe(t.mediator, "mediator") : undefined;
      variables = [out, grp, ...preds, mod, med].filter((v): v is PlanVariable => !!v);
      const O = out ? out.code : "", L = (v?: PlanVariable) => (v ? levelWords(resolve(def, v.name), v) : "");
      const predList = codeList(def, preds.map((p) => p.name));
      switch (t.method) {
        case "t_test":
          why = `${O} is ${L(out)} and ${grp?.code} is ${L(grp)}, so the comparison of means is a t-test; with 3+ groups it would be ANOVA.`;
          if ((grp?.categories ?? 2) > 2) why = `${O} is ${L(out)} and ${grp?.code} is ${L(grp)} — a t-test compares two groups, so it reads only the first two; with ${grp?.categories} groups ANOVA is the right test.`;
          output = "a table of means by group (n, mean, SD, median, 95% CI) with the t statistic, p-value and Cohen's d; a bar chart of the means with their confidence intervals";
          lead = `A t-test is recommended because ${O} measures ${out ? what(out) : "the outcome"} and ${grp?.code} splits the sample into two groups.`;
          break;
        case "anova": case "kruskal_wallis":
          why = `${O} is ${L(out)} and ${grp?.code} is ${L(grp)}, so the comparison of means across ${grp?.categories ?? "several"} groups is ${t.method === "anova" ? "a one-way ANOVA (a t-test compares only two)" : "a Kruskal–Wallis test (ANOVA's rank-based twin, with no assumption of equal intervals)"}.`;
          output = `a table of means by group (n, mean, SD, 95% CI) with the ${t.method === "anova" ? "F statistic, p-value and η²" : "H statistic and p-value"}; a bar chart of the group means`;
          lead = `${t.method === "anova" ? "An ANOVA" : "A Kruskal–Wallis test"} is recommended because ${O} measures ${out ? what(out) : "the outcome"} and ${grp?.code} splits the sample into ${grp?.categories ?? "several"} groups.`;
          break;
        case "mann_whitney":
          why = `${O} is ${L(out)} and ${grp?.code} has two groups; the Mann–Whitney test compares them by ranks, without treating the scale's points as equally spaced.`;
          output = "the U statistic, p-value and rank-biserial correlation, with the groups' medians; a box plot";
          lead = `A Mann–Whitney test is recommended because ${O} is a scale whose points need not be equally spaced and ${grp?.code} has two groups.`;
          break;
        case "chi_square": {
          const other = preds[0] ?? grp;
          why = `${O} is ${L(out)} and ${other?.code} is ${L(other)} — both categorical, so their association is a chi-square test of independence.`;
          output = "a contingency table (counts and column percentages) with the χ² statistic, p-value and Cramér's V; a clustered bar chart";
          lead = `A chi-square test is recommended because ${O} measures ${out ? what(out) : "the outcome"} and ${other?.code} ${other ? `measures ${what(other)}` : ""}, and both are categories.`;
          break;
        }
        case "correlation":
          why = `${O} is ${L(out)} and ${predList} ${preds.length === 1 ? `is ${L(preds[0])}` : "are scales"} — scale against scale, so the relationship is a (Pearson) correlation; a categorical pair would be a crosstab instead.`;
          output = "a correlation table (r, p-value, n) for each pair; a scatter plot";
          lead = `A correlation is recommended because ${O} measures ${out ? what(out) : "the outcome"} and ${predList} ${preds.length === 1 ? "measures" : "measure"} ${preds.length === 1 ? what(preds[0]) : "what may move with it"}, and both sides are scales.`;
          break;
        case "regression": case "driver_analysis":
          why = `${O} (the outcome) is ${L(out)} and ${predList} ${preds.length === 1 ? "is a scale or two-group predictor" : "are scale or two-group predictors"}, so a linear regression estimates each one's effect on ${O} holding the others constant${mod ? `; ${mod.code} enters with its interaction, which tests whether it changes the effect` : ""}${med ? `; the route through ${med.code} is tested as mediation (the indirect path)` : ""}. A two-category outcome would make it a logistic regression.`;
          output = med ? "the indirect, direct and total paths with their estimates and p-values; a path diagram" : "a coefficient table (estimate, standardized β, p-value) and the model fit (R², adjusted R², F); a driver chart of the standardized coefficients";
          lead = `Driver analysis is recommended because ${O} measures ${out ? what(out) : "the outcome"} and ${predList} measure potential drivers.`;
          break;
        case "logistic_regression":
          why = `${O} has two categories, so the model of what predicts it is a logistic regression (a linear one would predict impossible shares); ${predList} enter as predictors.`;
          output = "a coefficient table with odds ratios and p-values, and the model fit (McFadden pseudo-R², classification accuracy); a bar chart of the odds ratios";
          lead = `A logistic regression is recommended because ${O} is a yes/no outcome (${out ? what(out) : "the outcome"}) and ${predList} measure what may predict it.`;
          break;
        case "reliability":
          why = `${predList} are ${preds.length} items meant to measure one construct, so their internal consistency is Cronbach's α before they are averaged into one score.`;
          output = "Cronbach's α and standardized α, with item statistics (item-total r, α if the item is deleted)";
          lead = `A reliability analysis is recommended because ${predList} measure one construct together and are combined into a score.`;
          break;
        case "factor":
          why = `${predList} are ${preds.length} scale items; a factor analysis finds the few dimensions underneath them.`;
          output = "rotated factor loadings, eigenvalues and variance explained; a scree chart";
          lead = `A factor analysis is recommended because ${predList} are a battery of related items.`;
          break;
        case "cluster":
          why = `${predList} are the basis variables; a cluster analysis groups respondents who answer them alike.`;
          output = "cluster sizes and a profile of the basis variables' means per cluster";
          lead = `A cluster analysis is recommended because ${predList} describe needs or attitudes that may define segments.`;
          break;
        case "maxdiff_scores":
          why = `${predList} is a MaxDiff exercise: best–worst choices give every item a score on one ratio scale.`;
          output = "a score per item (share of preference) with best and worst counts; a ranked bar chart";
          lead = `MaxDiff scores are recommended because ${predList} is a MaxDiff exercise.`;
          break;
        case "conjoint_utilities":
          why = `${predList} is a conjoint exercise: its choices give part-worth utilities for every attribute level.`;
          output = "part-worth utilities per attribute level and attribute importances; a bar chart of the importances";
          lead = `Conjoint utilities are recommended because ${predList} is a conjoint exercise.`;
          break;
        case "nps":
          why = `${predList} is a 0–10 recommendation question, read as the Net Promoter Score.`;
          output = "the NPS with the shares of promoters, passives and detractors; a stacked bar";
          lead = `NPS is recommended because ${predList} asks how likely respondents are to recommend.`;
          break;
        default:
          why = `${METHOD_WORDS[t.method] ?? t.method.replace(/_/g, " ")} is what ${O || predList} calls for at ${out ? L(out) : "its"} level.`;
          output = "the method's tables and its recommended chart";
          lead = `${(METHOD_WORDS[t.method] ?? t.method.replace(/_/g, " ")).replace(/^./, (c) => c.toUpperCase())} is recommended for ${O || predList}.`;
      }
      // item-specific cautions
      const meanBased = ["t_test", "anova", "regression", "driver_analysis", "correlation"].includes(t.method);
      for (const v of [out, ...(t.method === "correlation" || regression ? preds : [])]) if (v && meanBased && v.level === "ordinal") limitations.push(`${v.code} is an ordinal ${resolve(def, v.name)?.options?.length ?? ""}-point scale treated as interval — equal distances between its points are assumed${t.method === "t_test" ? "; the Mann–Whitney test makes no such assumption" : t.method === "anova" ? "; the Kruskal–Wallis test makes no such assumption" : ""}.`.replace(/ -point/, " "));
      if (grp?.level === "multi") limitations.push(`${grp.code} is multi-select: its groups overlap, so it cannot be a grouping variable for a test — use a crosstab with each option as a column.`);
      if (grp && (grp.categories ?? 0) >= 6) limitations.push(`${grp.code} has ${grp.categories} groups — small groups make the test weak; consider banding it.`);
      if (regression || t.method === "correlation") limitations.push(`Correlation is not causation: ${regression ? "a significant coefficient shows an association with the outcome holding the other predictors constant" : "a significant r shows that the two move together"}, not that one causes the other.`);
      if (regression && preds.length >= 3) limitations.push("Predictors that measure related things are correlated (collinearity): their individual coefficients can be unstable even when the model fits.");
      if (regression) limitations.push("Respondents missing any variable of the model are left out (listwise deletion), so the model's base can be smaller than the sample.");
      break;
    }
    case "derived": {
      const d = item as PlannedDerived;
      variables = d.from.map((v) => describe(v, "source"));
      const src = codeList(def, d.from);
      const box = (top: boolean) => { const q = resolve(def, d.from[0]); const codes = (q?.options ?? []).map((o) => Number(o.code)).filter(Number.isFinite).sort((a, b) => a - b); const two = top ? codes.slice(-2) : codes.slice(0, 2); return two.length ? ` (codes ${two.join(" and ")}${q ? ` — ${two.map((c) => `“${plainText(q.options.find((o) => Number(o.code) === c)?.label, 24)}”`).join(", ")}` : ""})` : ""; };
      const RULES: Record<PlannedDerived["kind"], string> = {
        mean_score: `the mean of ${src} over the items each respondent answered — one score per respondent, steadier than any single item`,
        sum_score: `the sum of ${src} — a total per respondent`,
        top_box: `1 when ${src} is in the top two points of its scale${box(true)}, 0 otherwise — the headline share of a scale`,
        bottom_box: `1 when ${src} is in the bottom two points of its scale${box(false)}, 0 otherwise`,
        count: `how many of ${src} the respondent answered or selected`,
        flag: `1 when any of ${src} is selected or answered, 0 otherwise`,
        recode: d.expression ? `${src} recoded by the expression ${d.expression}` : `${src} recoded — it needs an expression to be computed`,
        index: d.expression ? `the index ${d.expression}` : `an index of ${src} — it needs an expression to be computed`,
      };
      why = `${d.name} is ${RULES[d.kind]}.${d.reason ? ` ${d.reason.replace(/^./, (c) => c.toUpperCase())}.` : ""}`.replace(/\.\.$/, ".");
      output = `a new column ${d.name} computed for every respondent before the planned tests run (a 0/1 flag or a score), and its distribution; the tests and tables that name it read that column`;
      lead = `${d.name} is planned because ${(RULES[d.kind].split(" — ")[0])}.`;
      if ((d.kind === "recode" || d.kind === "index") && !d.expression) limitations.push(`${d.name} has no expression, so the run cannot compute it — add one.`);
      if (d.kind === "mean_score" && d.from.length < 2) limitations.push(`${d.name} averages a single item — it is that item.`);
      if (d.kind === "mean_score") limitations.push("A respondent who answered only some of the items gets the mean of those — check the items' reliability first.");
      break;
    }
    case "segment": {
      const s = item as PlannedSegment;
      variables = s.by.map((v) => describe(v, "segment variable"));
      why = `Respondents are grouped by ${s.by.length > 1 ? "every combination of " : ""}${codeList(def, s.by)}, so each group's results can be read as a column of its own.`;
      output = `a segment variable ${segmentVariableName(s)} with one label per ${s.by.length > 1 ? "combination" : "group"}, usable as a banner, and the size of each segment`;
      lead = `Segment “${s.name}” is planned because ${codeList(def, s.by)} ${s.by.length === 1 ? "is a cut" : "are cuts"} the results are read by.`;
      if (s.by.length > 1) limitations.push("Crossing variables multiplies the segments: each combination's base is small unless the sample is large.");
      break;
    }
  }
  // what the methodology card says about the method behind the item
  const card = kind === "test" ? METHOD_CARD[(item as PlannedTest).method] : undefined;
  if (card) limitations.push(...METHODS[card].tradeoffs.map((x) => `${METHODS[card].method}: ${x}.`));
  // missing data: a variable not everyone is asked
  for (const v of variables) {
    const q = resolve(def, v.name);
    if (q?.displayLogic) limitations.push(`${q.code} is asked only of some respondents (display logic) — its base is smaller than the sample, and the analysis reads those who answered.`);
  }
  const rb = requiredBase(def, item, { plan });
  const expected = expectedSample(def);
  const id = kind === "crosstab" || kind === "test" ? (item as PlannedCrosstab | PlannedTest).id : kind === "derived" ? `derived:${(item as PlannedDerived).name}` : `segment:${(item as PlannedSegment).name}`;
  const base = `It needs about ${rb.minimum} completes (${rb.note})${expected ? (rb.minimum > expected.n ? ` — more than the ${expected.n} expected (${expected.note})` : `; ${expected.note}`) : ""}.`;
  const uniqueLimits = [...new Set(limitations)];
  const text = `${lead} ${why} It produces ${output}. ${base}${uniqueLimits.length ? ` Keep in mind: ${uniqueLimits.slice(0, 3).map((l) => l.replace(/\.$/, "")).join("; ")}.` : ""}`.replace(/\s+/g, " ").trim();
  return { kind, id, title: planItemTitle(def, item).replace(/^./, (c) => c.toUpperCase()), objective, hypotheses, variables, why, expectedOutput: output, requiredBase: rb, expectedSample: expected, limitations: uniqueLimits, text };
}

/** the methodology card behind a test method, for its trade-offs */
const METHOD_CARD: Partial<Record<AnalysisMethod, keyof typeof METHODS>> = {
  regression: "drivers", driver_analysis: "drivers", logistic_regression: "drivers", maxdiff_scores: "maxdiff", conjoint_utilities: "conjoint", nps: "nps", cluster: "segmentation", turf: "turf", brand_funnel: "funnel",
};

/** Every item of the plan (saved, else the engine's), explained. */
export function explainPlan(def: SurveyDefinition, plan: AnalysisPlan = def.research?.analysisPlan ?? buildAnalysisFramework(def, { now: "" })): PlanExplanation[] {
  return [...plan.crosstabs, ...plan.tests, ...plan.derived, ...plan.segments].map((x) => explainPlanItem(def, x as PlanItem, plan));
}

/**
 * The sample the whole plan needs: the largest required base, with the item
 * that drives it, against the sample the study expects.
 */
export function planSampleSize(def: SurveyDefinition, plan: AnalysisPlan = def.research?.analysisPlan ?? buildAnalysisFramework(def, { now: "" })): { minimum: number; driver: PlanExplanation | null; expected: ExpectedSample | null; items: { title: string; minimum: number; note: string }[] } {
  const items = [...plan.crosstabs, ...plan.tests, ...plan.segments].map((x) => ({ x: x as PlanItem, rb: requiredBase(def, x as PlanItem, { plan }) })).sort((a, b) => b.rb.minimum - a.rb.minimum);
  const top = items[0];
  return { minimum: top?.rb.minimum ?? MIN_READ_BASE, driver: top ? explainPlanItem(def, top.x, plan) : null, expected: expectedSample(def), items: items.map(({ x, rb }) => ({ title: planItemTitle(def, x), minimum: rb.minimum, note: rb.note })) };
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
  monadic: { method: "Monadic concept test", fit: "how one concept performs on its own", strengths: ["clean read per concept", "no contrast effects"], tradeoffs: ["needs a cell per concept — sample multiplies", "the arm each respondent saw must be recorded (an embedded variable set in each block) to compare the arms"], implementedAs: "a randomizer showing one concept block of N, with the same KPI battery" },
  sequential: { method: "Sequential monadic", fit: "several concepts rated by each respondent", strengths: ["smaller sample", "within-person comparison"], tradeoffs: ["order and contrast effects — rotate the concepts"], implementedAs: "a randomizer over the concept blocks, all shown" },
  funnel: { method: "Brand funnel", fit: "awareness → consideration → usage → preference by brand", strengths: ["conversion between stages", "benchmarkable"], tradeoffs: ["describes, does not explain — add image attributes for drivers"], implementedAs: "aided/unaided awareness, consideration, usage, preference questions, analysed as brand" },
  drivers: { method: "Key driver analysis", fit: "which attributes move an outcome (satisfaction, intent)", strengths: ["derived importance — no asking 'how important'", "actionable"], tradeoffs: ["needs the attributes rated AND the outcome", "collinearity between attributes"], implementedAs: "attribute ratings plus an outcome scale, analysed by regression / relative weights" },
  segmentation: { method: "Segmentation", fit: "groups of respondents with different needs or behaviour", strengths: ["targets the strategy"], tradeoffs: ["needs a basis battery", "segments must be reproducible"], implementedAs: "attitude / needs battery, analysed by cluster or factor + cluster" },
  nps: { method: "NPS", fit: "a single loyalty KPI", strengths: ["widely benchmarked"], tradeoffs: ["coarse", "needs follow-up for why"], implementedAs: "nps plus an open-ended reason" },
  abtest: { method: "A/B (split) test", fit: "one stimulus against another, between respondents", strengths: ["clean causal comparison"], tradeoffs: ["needs enough respondents per cell", "one factor at a time unless designed factorially", "the cell each respondent saw must be recorded (an embedded variable set in each block)"], implementedAs: "a randomizer showing one of the stimulus blocks; the same questions after each" },
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
