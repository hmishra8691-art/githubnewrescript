import type { AnalysisPlan, PlannedTest, Question, SurveyDefinition } from "@rescript/schema";
import { expectedSample, isCategorical, isScaleLike, measurementOf } from "./analysisFramework.js";
import { structuredHypotheses, type StructuredHypothesis } from "./hypotheses.js";
import { rowColumn } from "./derivedNames.js";

/**
 * ADVANCED MODELS IN THE ANALYSIS PLAN (2026-10-22) — the design-level half.
 *
 * `@rescript/analytics` estimates hierarchical Bayes, latent class and SEM and
 * checks a planned item against the data dictionary (`planCheck`). What the
 * ENGINE decides, before any data exists, is whether the DESIGN calls for one
 * of them and whether the design can carry it:
 *
 *   semModelFromDesign     the lavaan-style syntax of the research design: one
 *                          measurement model per construct (construct → its
 *                          items), one structural path per hypothesis
 *                          (IV → DV), a mediated hypothesis as X → M → Y with
 *                          its indirect effect defined, and the map from each
 *                          hypothesis to the path that answers it
 *   advancedSuitability    the method-suitability rules — sample size
 *                          minimums, number of indicators, identification,
 *                          tasks per respondent — as blocking reasons (the
 *                          item is refused, in words) and warnings
 *   gaborGrangerPattern    the purchase-intent-at-price-points questions, with
 *                          their prices, when the survey has them
 *   advancedPlanItems      what the plan generator adds when the design calls
 *                          for it: HB beside a CBC / MaxDiff exercise, SEM for
 *                          hypotheses between multi-item constructs, a
 *                          bootstrapped mediation for a mediated hypothesis,
 *                          ω for a scale of three or more items, Gabor–Granger
 *                          for a price ladder, latent class when the
 *                          objective is segmentation and indicators are tagged
 *
 * Pure: no data, no model. Every rule says why, so the copilot's refusal and
 * the research validator read the same sentence.
 */

/* ------------------------------------------------------------ thresholds (stated once; the validator and the guide quote them) */

export const ADVANCED_RULES = {
  /** HB: below this many respondents the population distribution is not estimable (the runner refuses at 20); below `hbWarn` the individual estimates lean on the prior */
  hbMin: 50, hbWarn: 200,
  /** CBC: tasks per respondent below which individual part-worths are mostly prior */
  cbcTasksMin: 4, cbcTasksWarn: 8,
  /** MaxDiff: times each item is shown to a respondent */
  maxdiffShowsMin: 1, maxdiffShowsWarn: 3,
  /** latent class: indicators and sample */
  lcaIndicatorsMin: 2, lcaIndicatorsWarn: 3, lcaMin: 100, lcaWarn: 300, lcaCategoriesMax: 15,
  /** SEM: indicators per factor, sample, cases per free parameter */
  semIndicatorsWarn: 3, semMin: 100, semWarn: 200, semPerParamMin: 5, semPerParamWarn: 10,
  /** bootstrap mediation */
  mediationMin: 50, mediationWarn: 100,
  /** Gabor–Granger price points */
  ggPointsMin: 2, ggPointsWarn: 4,
} as const;

export interface Suitability { blocking: string[]; warnings: string[] }

const asked = (def: SurveyDefinition) => def.questions.filter((q) => !["html", "custom_component", "media_timeline"].includes(q.type));
const byVar = (def: SurveyDefinition, name: string): Question | undefined => def.questions.find((q) => q.variableName === name || String(q.code) === name);
const GRID = new Set(["matrix_single", "matrix_dropdown"]);

/** the variables a question contributes as items: a rating grid's rows, else itself */
export function itemVariables(def: SurveyDefinition, q: Question): string[] {
  if (GRID.has(q.type) && q.rows?.length) return q.rows.map((r) => rowColumn(q.variableName, r.code, def.variableNaming));
  return [q.variableName];
}
/** the number of answer categories an item has (a grid row reads its columns' scale) */
function categoriesOf(q: Question): number {
  if (GRID.has(q.type)) return (q.columns?.[0]?.options?.length ? q.columns[0].options : q.options)?.length ?? 0;
  return q.options?.length ?? 0;
}

/* ------------------------------------------------------------ SEM from the research design */

export interface SemDesignModel {
  syntax: string;
  /** hypothesis label → the path that answers it ("INTENT ~ TRUST") or the defined indirect effect (":= ind_h3") */
  hypothesisPaths: Record<string, string>;
  /** latent name → its construct and items */
  latents: { name: string; construct: string; items: string[] }[];
  /** constructs read through one observed variable (a single question) */
  observedConstructs: { name: string; construct: string }[];
  /** every observed variable the model reads */
  observed: string[];
  hypotheses: string[];
  /** hypotheses left out, each with why */
  skipped: { label: string; reason: string }[];
  /** t-rule: moments − free parameters (≥ 0 to be identified) */
  df: number;
  freeParameters: number;
}

const latentName = (def: SurveyDefinition, construct: string, taken: Set<string>): string => {
  let base = construct.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "F";
  if (/^\d/.test(base)) base = `F_${base}`;
  let name = base;
  for (let i = 2; taken.has(name) || def.questions.some((q) => q.variableName === name || String(q.code) === name); i++) name = `${base}_F${i === 2 ? "" : i}`;
  taken.add(name);
  return name;
};

/** a construct as the SEM reads it: a latent factor of its items, one observed variable, or nothing usable */
function constructMeasure(def: SurveyDefinition, c: { name: string; questionIds: string[] }): { items: string[]; reason?: string } {
  const qs = c.questionIds.map((id) => def.questions.find((q) => q.id === id)).filter((q): q is Question => !!q);
  if (!qs.length) return { items: [], reason: `construct “${c.name}” has no question measuring it` };
  const bad = qs.filter((q) => !isScaleLike(measurementOf(q)) && !(isCategorical(measurementOf(q)) && measurementOf(q) !== "multi" && (q.options?.length ?? 0) === 2));
  if (bad.length) return { items: [], reason: `construct “${c.name}” is measured by ${bad.map((q) => `${q.code} (${measurementOf(q)})`).join(", ")} — SEM needs numeric or rating-scale items` };
  return { items: qs.flatMap((q) => itemVariables(def, q)) };
}

/**
 * THE MODEL A RESEARCH DESIGN DESCRIBES. Every hypothesis whose two sides
 * resolve to constructs (or single questions) the survey measures becomes a
 * structural path; its constructs get measurement models (a construct with
 * two or more items is a latent factor, a single item is used as observed); a
 * mediated hypothesis is X → M → Y with `ind_<h> := a_<h>*b_<h>`. Moderated
 * hypotheses are left to the regression's interaction (latent interactions are
 * not estimated) and said so. `only` restricts it to some hypotheses.
 */
export function semModelFromDesign(def: SurveyDefinition, opts: { only?: string[] } = {}): SemDesignModel | { error: string } {
  const hs = structuredHypotheses(def).filter((h) => !opts.only?.length || opts.only.includes(h.label));
  if (!hs.length) return { error: opts.only?.length ? `${opts.only.join(", ")} ${opts.only.length === 1 ? "is" : "are"} not a hypothesis of the research design` : "the research design has no hypotheses to model" };
  const taken = new Set<string>();
  const measure = new Map<string, { kind: "latent"; name: string; items: string[] } | { kind: "observed"; name: string }>();
  const skipped: SemDesignModel["skipped"] = [];
  const sideOf = (c: { name: string; questionIds: string[] } | undefined, phrase: string | undefined, h: StructuredHypothesis): { kind: "latent" | "observed"; name: string } | string => {
    if (!c) return `${h.label}: “${phrase ?? "a side"}” is not a construct of the research design (record it under constructs with the questions that measure it)`;
    const got = measure.get(c.name);
    if (got) return got;
    const m = constructMeasure(def, c);
    if (!m.items.length) return `${h.label}: ${m.reason}`;
    const entry = m.items.length >= 2 ? { kind: "latent" as const, name: latentName(def, c.name, taken), items: m.items } : { kind: "observed" as const, name: m.items[0] };
    measure.set(c.name, entry);
    return entry;
  };
  const paths: { lhs: string; rhs: string; label: string; hyps: string[] }[] = [];
  const defined: { name: string; expr: string }[] = [];
  const hypothesisPaths: Record<string, string> = {};
  const used: string[] = [];
  const addPath = (lhs: string, rhs: string, label: string, h: string): string => {
    const p = paths.find((x) => x.lhs === lhs && x.rhs === rhs);
    if (p) { p.hyps.push(h); return p.label; }
    paths.push({ lhs, rhs, label, hyps: [h] });
    return label;
  };
  for (const h of hs) {
    const lab = h.label.toLowerCase();
    if (h.type === "difference" || h.type === "descriptive") { skipped.push({ label: h.label, reason: `${h.label} compares groups or describes a level — a t-test / ANOVA or a descriptive answers it, not a structural model` }); continue; }
    if (h.moderator) { skipped.push({ label: h.label, reason: `${h.label} is a moderation — latent interactions are not estimated here; the plan tests it as a regression interaction` }); continue; }
    const x = sideOf(h.constructs.independent, h.independent, h), y = sideOf(h.constructs.dependent, h.dependent, h);
    if (typeof x === "string" || typeof y === "string") { skipped.push({ label: h.label, reason: typeof x === "string" ? x : y as string }); continue; }
    if (x.name === y.name) { skipped.push({ label: h.label, reason: `${h.label}: both sides resolve to the same construct` }); continue; }
    if (h.mediator) {
      const m = sideOf(h.constructs.mediator, h.mediator, h);
      if (typeof m === "string") { skipped.push({ label: h.label, reason: m }); continue; }
      const a = addPath(m.name, x.name, `a_${lab}`, h.label), b = addPath(y.name, m.name, `b_${lab}`, h.label);
      addPath(y.name, x.name, `c_${lab}`, h.label);
      defined.push({ name: `ind_${lab}`, expr: `${a}*${b}` });
      hypothesisPaths[h.label] = `:=ind_${lab}`;
    } else {
      addPath(y.name, x.name, `p_${lab}`, h.label);
      hypothesisPaths[h.label] = `${y.name} ~ ${x.name}`;
    }
    used.push(h.label);
  }
  if (!paths.length) return { error: skipped.length ? `no hypothesis could be modelled — ${skipped.map((s) => s.reason).join("; ")}` : "no hypothesis names two measured constructs" };
  const latents = [...measure.entries()].filter(([, m]) => m.kind === "latent").map(([c, m]) => ({ name: m.name, construct: c, items: (m as { items: string[] }).items }));
  const observedConstructs = [...measure.entries()].filter(([, m]) => m.kind === "observed").map(([c, m]) => ({ name: m.name, construct: c }));
  const lines: string[] = [];
  lines.push("# measurement model: each construct by its items");
  for (const l of latents) lines.push(`${l.name} =~ ${l.items.join(" + ")}`);
  lines.push("# structural model: one path per hypothesis");
  for (const p of paths) lines.push(`${p.lhs} ~ ${p.label}*${p.rhs}   # ${p.hyps.join(", ")}`);
  if (defined.length) { lines.push("# indirect effects of the mediated hypotheses"); for (const d of defined) lines.push(`${d.name} := ${d.expr}`); }
  /* the t-rule, counted the way the estimator counts (marker scaling: first loading fixed) */
  const observed = [...new Set([...latents.flatMap((l) => l.items), ...observedConstructs.map((o) => o.name)])];
  const pObs = observed.length;
  const moments = (pObs * (pObs + 1)) / 2;
  const endogenous = new Set(paths.map((p) => p.lhs));
  const exoLatent = latents.filter((l) => !endogenous.has(l.name)).length;
  const exoObserved = observedConstructs.filter((o) => !endogenous.has(o.name)).length;
  const free = latents.reduce((t, l) => t + l.items.length - 1, 0)          // loadings
    + latents.reduce((t, l) => t + l.items.length, 0)                         // residual variances of the indicators
    + paths.length                                                            // structural paths
    + (exoLatent * (exoLatent + 1)) / 2                                       // exogenous latent variances and covariances
    + (exoObserved * (exoObserved + 1)) / 2                                   // exogenous observed variances and covariances
    + latents.filter((l) => endogenous.has(l.name)).length                    // residual variances of endogenous factors
    + observedConstructs.filter((o) => endogenous.has(o.name)).length;        // residual variances of endogenous observed
  return { syntax: lines.join("\n"), hypothesisPaths, latents, observedConstructs, observed, hypotheses: used, skipped, df: moments - free, freeParameters: free };
}

/* ------------------------------------------------------------ Gabor–Granger */

const PRICE = /(?:[$€£₹¥]\s?(\d[\d,]*(?:\.\d+)?)|(?:Rs\.?|INR|USD|EUR|GBP)\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:USD|EUR|GBP|INR|dollars?|euros?|pounds?|rupees?|€|£))/i;
const INTENT = /\b(?:buy|purchase|subscribe|pay|order|sign\s+up|likely|would\s+you)\b/i;
const priceIn = (text: string): number | null => { const m = PRICE.exec(text.replace(/<[^>]+>/g, " ")); const v = m ? Number((m[1] ?? m[2] ?? m[3]).replace(/,/g, "")) : NaN; return Number.isFinite(v) && v > 0 ? v : null; };
const optionKey = (q: Question) => (q.options ?? []).map((o) => o.label.trim().toLowerCase()).join("|");

/**
 * A GABOR–GRANGER LADDER: two or more consecutive single-choice purchase-intent
 * questions with the same answer scale, each naming one price, the prices all
 * different. The longest such run; null when the survey has none.
 */
export function gaborGrangerPattern(def: SurveyDefinition): { questions: string[]; prices: number[] } | null {
  const qs = asked(def);
  let best: { questions: string[]; prices: number[] } | null = null;
  let run: Question[] = [];
  const close = () => {
    if (run.length >= ADVANCED_RULES.ggPointsMin) {
      const prices = run.map((q) => priceIn(q.text)!);
      if (new Set(prices).size === prices.length && (!best || run.length > best.questions.length)) best = { questions: run.map((q) => q.variableName), prices };
    }
    run = [];
  };
  for (const q of qs) {
    const ok = (q.type === "single_select" || q.type === "dropdown") && (q.options?.length ?? 0) >= 2 && priceIn(q.text) != null && INTENT.test(q.text);
    if (ok && run.length && optionKey(run[0]) === optionKey(q)) { run.push(q); continue; }
    close();
    if (ok) run = [q];
  }
  close();
  return best;
}

/* ------------------------------------------------------------ suitability */

function hbExercise(def: SurveyDefinition, q: Question | undefined): { kind: "cbc" | "maxdiff"; tasks: number | null; alternatives: number | null; shows: number | null } | string {
  if (!q) return "Hierarchical Bayes needs the CBC, ACBC, menu or MaxDiff question — none was named";
  if (q.type !== "conjoint_task" && q.type !== "maxdiff_task" && q.type !== "acbc_task") return `Hierarchical Bayes reads a CBC, ACBC, menu-based or MaxDiff exercise; ${q.code} is a ${q.type.replace(/_/g, " ")} question`;
  const ref = (q.settings as { designRef?: string } | undefined)?.designRef;
  const d = ref ? (def.designs ?? []).find((x) => x.id === ref) : undefined;
  if (!d) return `${q.code} has no design attached yet — generate its design (create_conjoint / create_maxdiff) before planning HB`;
  const cfg = (d.config ?? {}) as Record<string, unknown>, sum = (d.file?.summary ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);
  /* F4 2026-10-22: the HB runner estimates ACBC (BYO + screening + tournament) and menu-based exercises too; the number of tasks of an adaptive interview is not fixed, so no tasks rule applies */
  if (q.type === "acbc_task") return { kind: "cbc", tasks: null, alternatives: null, shows: null };
  if (q.type === "conjoint_task") {
    if (d.kind === "cva") return `${q.code} is a rating-based conjoint (CVA): it is estimated per respondent by least squares in the conjoint analysis — HB here is a choice model`;
    if (d.kind === "menu") return { kind: "cbc", tasks: n(sum.tasksPerVersion) ?? n(cfg.tasks), alternatives: null, shows: null };
    if (d.kind !== "conjoint") return `${q.code}'s design (${d.kind}) is not a CBC design`;
    return { kind: "cbc", tasks: n(sum.tasksPerVersion) ?? n(cfg.tasks), alternatives: n(sum.alternativesPerTask) ?? n(cfg.alternativesPerTask) ?? n(cfg.alternatives), shows: null };
  }
  if (cfg.anchored) return `${q.code} is an anchored MaxDiff: the anchor is not part of the HB model here — the aggregate anchored analysis reads it`;
  const items = Array.isArray(cfg.items) ? cfg.items.length : null;
  const tasks = n(cfg.tasks) ?? n(sum.tasksPerVersion), per = n(cfg.itemsPerTask) ?? n(cfg.perTask);
  const shown = n(cfg.itemsPerVersion) ?? items;
  return { kind: "maxdiff", tasks, alternatives: per, shows: tasks && per && shown ? (tasks * per) / shown : null };
}

/**
 * CAN THE DESIGN CARRY THIS ADVANCED ITEM? Blocking reasons refuse it (the
 * copilot says why and changes nothing); warnings travel with it. The sample
 * is the design's expected completes (quotas, else the research design's
 * sample size) — unknown sample sizes are a warning, never a refusal.
 */
export function advancedSuitability(def: SurveyDefinition, t: Pick<PlannedTest, "method" | "variables" | "outcome" | "mediator" | "options">): Suitability {
  const blocking: string[] = [], warnings: string[] = [];
  const exp = expectedSample(def)?.n ?? null;
  const sample = (min: number, warn: number, what: string) => {
    if (exp == null) warnings.push(`No sample size is recorded — ${what} needs about ${warn} completes (at least ${min}); set the sample size in the research design.`);
    else if (exp < min) blocking.push(`${what} needs at least ${min} completes and the design expects ${exp}.`);
    else if (exp < warn) warnings.push(`${what} with ${exp} expected completes is thin — about ${warn} make it stable.`);
  };
  const o = (t.options ?? {}) as Record<string, unknown>;
  switch (t.method) {
    case "hb": {
      const names = [...new Set([...(t.outcome ? [t.outcome] : []), ...t.variables])];
      if (names.length !== 1) { blocking.push(names.length ? "Hierarchical Bayes reads exactly one CBC, ACBC, menu or MaxDiff question — plan one item per exercise." : "Hierarchical Bayes needs the CBC, ACBC, menu or MaxDiff question."); break; }
      const ex = hbExercise(def, byVar(def, names[0]));
      if (typeof ex === "string") { blocking.push(`${ex}.`); break; }
      if (ex.kind === "cbc" && ex.tasks != null) {
        if (ex.tasks < ADVANCED_RULES.cbcTasksMin) blocking.push(`Each respondent answers ${ex.tasks} choice tasks — HB needs at least ${ADVANCED_RULES.cbcTasksMin} (and ${ADVANCED_RULES.cbcTasksWarn}+ for individual utilities to rest on the respondent rather than the prior).`);
        else if (ex.tasks < ADVANCED_RULES.cbcTasksWarn) warnings.push(`${ex.tasks} tasks per respondent: individual utilities will lean on the population prior; ${ADVANCED_RULES.cbcTasksWarn}–12 tasks are usual.`);
      }
      if (ex.kind === "maxdiff" && ex.shows != null) {
        if (ex.shows < ADVANCED_RULES.maxdiffShowsMin) blocking.push(`Each item is shown about ${ex.shows.toFixed(1)} times per respondent — HB needs every item shown at least once to each respondent.`);
        else if (ex.shows < ADVANCED_RULES.maxdiffShowsWarn) warnings.push(`Each item is shown about ${ex.shows.toFixed(1)} times per respondent; ${ADVANCED_RULES.maxdiffShowsWarn} times is the usual minimum for stable individual scores.`);
      }
      sample(ADVANCED_RULES.hbMin, ADVANCED_RULES.hbWarn, "Hierarchical Bayes");
      const iters = (Number(o.burnIn ?? 5000) || 0) + (Number(o.draws ?? 5000) || 0);
      if (iters > 200_000) blocking.push(`Burn-in plus draws is ${iters.toLocaleString("en")} iterations per chain — the limit is 200,000.`);
      break;
    }
    case "latent_class": {
      if (Array.isArray(o.covariates) && o.covariates.length) blocking.push(`Latent class with covariates is not estimated here (no one- or three-step covariate model) — run it on the indicators alone and profile the classes by ${o.covariates.map(String).join(", ")} with a crosstab of the assigned class.`);
      const qs = t.variables.map((v) => byVar(def, v));
      const missing = t.variables.filter((_, i) => !qs[i]);
      if (missing.length) { blocking.push(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not a question in this survey.`); break; }
      const items = qs.flatMap((q) => (GRID.has(q!.type) ? (q!.rows ?? []).map(() => q!) : [q!]));
      const notCat = qs.filter((q) => !(isCategorical(measurementOf(q!)) && measurementOf(q!) !== "multi") && !(GRID.has(q!.type)));
      if (notCat.length) blocking.push(`Latent class indicators must be categorical answers; ${notCat.map((q) => `${q!.code} is ${measurementOf(q!)}`).join(", ")} — band a numeric question first, or use cluster analysis for scales.`);
      const wide = qs.filter((q) => categoriesOf(q!) > ADVANCED_RULES.lcaCategoriesMax);
      if (wide.length) blocking.push(`${wide.map((q) => q!.code).join(", ")} ${wide.length === 1 ? "has" : "have"} more than ${ADVANCED_RULES.lcaCategoriesMax} answer categories — recode before using ${wide.length === 1 ? "it" : "them"} as indicators.`);
      if (items.length < ADVANCED_RULES.lcaIndicatorsMin) blocking.push(`Latent class analysis needs at least ${ADVANCED_RULES.lcaIndicatorsMin} indicators (${items.length} named).`);
      else if (items.length < ADVANCED_RULES.lcaIndicatorsWarn) warnings.push(`With ${items.length} indicators at most two classes can be identified; ${ADVANCED_RULES.lcaIndicatorsWarn}+ are usual.`);
      const minK = Number(o.minClasses ?? 1), maxK = Number(o.maxClasses ?? 4);
      if (!(minK >= 1 && maxK <= 8 && minK <= maxK)) blocking.push("The class range must run from 1 to at most 8 classes, the smallest first.");
      else if (items.length >= 2 && !wide.length) {
        const cats = items.map((q) => Math.max(2, categoriesOf(q)));
        const cells = cats.reduce((p, c) => p * c, 1);
        const npar = (k: number) => (k - 1) + k * cats.reduce((s, c) => s + c - 1, 0);
        if (cells - 1 - npar(minK) < 0) blocking.push(`${minK} class${minK === 1 ? "" : "es"} cannot be identified from these indicators (${npar(minK)} parameters for ${cells - 1} response patterns) — add indicators.`);
        else if (cells - 1 - npar(maxK) < 0) { const ok = Array.from({ length: maxK }, (_, i) => i + 1).filter((k) => cells - 1 - npar(k) >= 0).pop() ?? 1; warnings.push(`At most ${ok} classes are identified with these indicators; larger K will be reported as not identified.`); }
      }
      sample(ADVANCED_RULES.lcaMin, ADVANCED_RULES.lcaWarn, "Latent class analysis");
      break;
    }
    case "sem": {
      const syntax = typeof o.syntax === "string" ? o.syntax : "";
      if (!syntax.trim()) { blocking.push("A structural equation model needs its model — plan it from the hypotheses and constructs, or write the syntax."); break; }
      const lines = syntax.split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
      const factors = lines.filter((l) => /=~/.test(l)).map((l) => { const [lhs, rhs] = l.split("=~"); return { name: lhs.trim(), items: rhs.split("+").map((s) => s.trim().replace(/^[^*]*\*/, "")).filter(Boolean) }; });
      const thin = factors.filter((f) => f.items.length < 2);
      if (thin.length) blocking.push(`${thin.map((f) => f.name).join(", ")} ${thin.length === 1 ? "has" : "have"} a single indicator — a factor needs at least two (three to be identified on its own).`);
      const two = factors.filter((f) => f.items.length === 2);
      if (two.length) warnings.push(`${two.map((f) => f.name).join(", ")} ${two.length === 1 ? "has" : "have"} only two indicators: identified only through ${two.length === 1 ? "its" : "their"} relations with other factors; ${ADVANCED_RULES.semIndicatorsWarn} or more are recommended.`);
      const observed = [...new Set(factors.flatMap((f) => f.items))];
      const notScale = observed.map((v) => ({ v, q: byVar(def, v) ?? def.questions.find((q) => itemVariables(def, q).includes(v)) })).filter((x) => x.q && !isScaleLike(measurementOf(x.q)));
      if (notScale.length) blocking.push(`SEM treats indicators as continuous; ${notScale.map((x) => `${x.v} (${measurementOf(x.q!)})`).join(", ")} ${notScale.length === 1 ? "is" : "are"} not a numeric or rating-scale answer.`);
      const short = observed.map((v) => def.questions.find((q) => itemVariables(def, q).includes(v))).filter((q): q is Question => !!q && (GRID.has(q.type) || q.type === "single_select") && categoriesOf(q) > 0 && categoriesOf(q) < 5);
      if (short.length) warnings.push(`${[...new Set(short.map((q) => q.code))].join(", ")} ${short.length === 1 ? "has" : "have"} fewer than five scale points; ML treats ${short.length === 1 ? "it" : "them"} as continuous (no ordinal estimator here), which can bias loadings downward.`);
      const free = typeof o.freeParameters === "number" ? o.freeParameters : null;
      const q = free ?? Math.max(1, observed.length * 2 + lines.filter((l) => /(^|[^=])~(?!~)/.test(l) && !/=~/.test(l)).length);
      sample(Math.max(ADVANCED_RULES.semMin, ADVANCED_RULES.semPerParamMin * q), Math.max(ADVANCED_RULES.semWarn, ADVANCED_RULES.semPerParamWarn * q), `A structural equation model with about ${q} free parameters`);
      break;
    }
    case "regression": case "logistic_regression": case "driver_analysis": {
      if (!o.bootstrap) break;
      if (!t.mediator) { blocking.push("A bootstrapped indirect effect needs a mediation — name the mediator."); break; }
      const roles = [t.outcome, t.variables[0], t.mediator].map((v) => (v ? byVar(def, v) : undefined));
      const [y, x, m] = roles;
      if (y && !isScaleLike(measurementOf(y))) blocking.push(`The outcome of a mediation must be numeric or a rating scale; ${y.code} is ${measurementOf(y)}.`);
      if (m && !isScaleLike(measurementOf(m))) blocking.push(`The mediator must be numeric or a rating scale; ${m.code} is ${measurementOf(m)}.`);
      if (x && !isScaleLike(measurementOf(x)) && !((x.options?.length ?? 0) === 2)) blocking.push(`The predictor of a mediation must be numeric, a rating scale or a two-group variable; ${x.code} is ${measurementOf(x)} with ${x.options?.length ?? 0} categories.`);
      const draws = o.bootstrap === true ? 5000 : Number(o.bootstrap);
      if (!(draws >= 200 && draws <= 20_000)) blocking.push("The bootstrap needs between 200 and 20,000 resamples (5,000 is usual).");
      sample(ADVANCED_RULES.mediationMin, ADVANCED_RULES.mediationWarn, "A bootstrapped mediation");
      break;
    }
    case "reliability": {
      if (o.omega !== true) break;
      const items = t.variables.map((v) => byVar(def, v)).flatMap((q) => (q ? itemVariables(def, q) : []));
      const n = Math.max(items.length, t.variables.length);
      if (n < 3) blocking.push(`McDonald's ω comes from a one-factor model, which needs at least three items — ${n} named.`);
      break;
    }
    case "pricing": {
      if (o.method !== "gabor_granger") break;
      const prices = Array.isArray(o.prices) ? o.prices : [];
      if (t.variables.length < ADVANCED_RULES.ggPointsMin) blocking.push("Gabor–Granger needs a purchase-intent question at two or more price points.");
      if (prices.length !== t.variables.length) blocking.push(`Gabor–Granger needs one price per purchase-intent question (${prices.length} price${prices.length === 1 ? "" : "s"} for ${t.variables.length} question${t.variables.length === 1 ? "" : "s"}).`);
      if (prices.some((p) => !(typeof p === "number" && p > 0))) blocking.push("Every Gabor–Granger price must be a positive number.");
      if (new Set(prices.map(Number)).size !== prices.length) blocking.push("Two Gabor–Granger questions name the same price.");
      if (t.variables.length >= ADVANCED_RULES.ggPointsMin && t.variables.length < ADVANCED_RULES.ggPointsWarn) warnings.push(`${t.variables.length} price points make a coarse demand curve; ${ADVANCED_RULES.ggPointsWarn}–6 are usual.`);
      const notSingle = t.variables.map((v) => byVar(def, v)).filter((q) => q && q.type !== "single_select" && q.type !== "dropdown");
      if (notSingle.length) blocking.push(`Gabor–Granger reads single-choice purchase-intent questions; ${notSingle.map((q) => `${q!.code} is ${q!.type.replace(/_/g, " ")}`).join(", ")}.`);
      break;
    }
    default: break;
  }
  return { blocking, warnings };
}

/* ------------------------------------------------------------ what the generator adds */

export interface AdvancedProposal { test: Omit<PlannedTest, "id">; why: string; warnings: string[] }
const has = (plan: Pick<AnalysisPlan, "tests">, pred: (t: PlannedTest) => boolean) => plan.tests.some(pred);

/**
 * THE ADVANCED ITEMS THE DESIGN CALLS FOR, given the plan built so far. Each is
 * proposed only when `advancedSuitability` has no blocking reason, and never
 * twice. Items for an existing method (a mediation regression, a reliability)
 * are not added here — the generator sets their options (bootstrap, ω).
 */
export function advancedPlanItems(def: SurveyDefinition, plan: Pick<AnalysisPlan, "tests">): AdvancedProposal[] {
  const out: AdvancedProposal[] = [];
  const push = (test: Omit<PlannedTest, "id">, why: string) => { const s = advancedSuitability(def, test); if (!s.blocking.length) out.push({ test: { ...test, reason: why }, why, warnings: s.warnings }); };
  /* HB beside every CBC / MaxDiff exercise the design can carry */
  for (const q of asked(def)) {
    if (q.type !== "conjoint_task" && q.type !== "maxdiff_task" && q.type !== "acbc_task") continue;
    if (has(plan, (t) => t.method === "hb" && t.variables.includes(q.variableName))) continue;
    const agg = plan.tests.find((t) => (t.method === "conjoint_utilities" || t.method === "maxdiff_scores") && t.variables.includes(q.variableName));
    const kindWord = q.type === "maxdiff_task" ? "MaxDiff" : q.type === "acbc_task" ? "adaptive CBC (ACBC)" : (def.designs ?? []).find((d) => d.id === (q.settings as { designRef?: string } | undefined)?.designRef)?.kind === "menu" ? "menu-based conjoint" : "CBC";
    push({ method: "hb", variables: [q.variableName], priority: 2, tier: "recommended", hypotheses: agg?.hypotheses ?? [], options: { chains: 2, burnIn: 5000, draws: 5000, seed: 1 } }, `${q.code} is a ${kindWord} exercise — individual utilities by hierarchical Bayes, for importances by respondent and the simulator`);
  }
  /*
   * SEM when the hypotheses link LATENT constructs: at least two constructs measured by three or more items each
   * (the scales whose measurement error a regression on mean scores would ignore), a sample the model can carry —
   * or the design itself asks for a structural / confirmatory model. Otherwise the regressions on the mean scores
   * stand, and SEM stays one sentence away ("test H1 and H2 with a structural equation model").
   */
  const sem = semModelFromDesign(def);
  const designText = `${def.research?.methodology ?? ""} ${(def.research?.analysis ?? []).join(" ")}`;
  const askedFor = /\bstructural equation|\bSEM\b|\bpath (?:model|analysis)\b|\bconfirmatory factor|\bCFA\b|\blatent (?:variable|construct)s?\b/i.test(designText);
  const exp = expectedSample(def)?.n ?? null;
  const carries = (m: SemDesignModel) => m.latents.filter((l) => l.items.length >= 3).length >= 2 && (exp == null || exp >= Math.max(ADVANCED_RULES.semWarn, ADVANCED_RULES.semPerParamWarn * m.freeParameters));
  if (!("error" in sem) && sem.latents.length >= 1 && sem.hypotheses.length >= 1 && sem.df >= 0 && (askedFor || carries(sem)) && !has(plan, (t) => t.method === "sem")) {
    push({ method: "sem", variables: sem.observed, priority: 1, tier: "essential", hypotheses: sem.hypotheses, options: { syntax: sem.syntax, scaling: "marker", hypothesisPaths: sem.hypothesisPaths, freeParameters: sem.freeParameters } }, `${sem.hypotheses.join(", ")} link${sem.hypotheses.length === 1 ? "s" : ""} constructs measured by several items — a structural equation model tests ${sem.hypotheses.length === 1 ? "it" : "them"} with the measurement error of the scales accounted for`);
  }
  /* Gabor–Granger when the survey asks purchase intent at a ladder of prices */
  const gg = gaborGrangerPattern(def);
  if (gg && !has(plan, (t) => t.method === "pricing" && t.options?.method === "gabor_granger")) {
    push({ method: "pricing", variables: gg.questions, priority: 1, tier: "essential", hypotheses: [], options: { method: "gabor_granger", prices: gg.prices } }, `purchase intent is asked at ${gg.prices.length} price points — a Gabor–Granger demand curve and the revenue-maximising price`);
  }
  /* latent class when the objective is segmentation and the researcher tagged its indicators */
  const objective = `${def.research?.objective ?? ""} ${def.research?.methodology ?? ""}`;
  if (/\bsegment\w*|\btypolog\w*|\bpersonas?\b|\blatent[\s-]class/i.test(objective) && !has(plan, (t) => t.method === "latent_class")) {
    const ind = asked(def).filter((q) => q.analysis?.modeling?.includes("latent_class")).map((q) => q.variableName);
    if (ind.length >= ADVANCED_RULES.lcaIndicatorsMin) push({ method: "latent_class", variables: ind, priority: 1, tier: "essential", hypotheses: [], options: { minClasses: 1, maxClasses: 5, starts: 20, seed: 1 } }, "the objective is segmentation — latent classes of the tagged indicators, compared by BIC");
  }
  return out;
}

/** the options the generator sets on items it already plans: a bootstrap on every mediation, ω on every scale of three or more items */
export function advancedOptionsFor(def: SurveyDefinition, t: PlannedTest): PlannedTest["options"] | undefined {
  if ((t.method === "regression" || t.method === "logistic_regression") && t.mediator && t.method === "regression") return { ...(t.options ?? {}), bootstrap: 5000, seed: 1 };
  if (t.method === "reliability") {
    const items = t.variables.flatMap((v) => { const q = byVar(def, v); return q ? itemVariables(def, q) : [v]; });
    if (items.length >= 3) return { ...(t.options ?? {}), omega: true };
  }
  return undefined;
}
