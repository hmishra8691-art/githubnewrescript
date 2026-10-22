import type { AnalysisDefinition } from "./types.js";
import type { VariableMeta } from "./dataset.js";
import { crosstabDefinition, testDefinition, type PlannedAnalysis } from "./planBridge.js";
import { scaleOf } from "./questionChart.js";
import type { PlannedCrosstab, PlannedTest, SurveyDefinition } from "@rescript/schema";
import { isNonQuestionVariable } from "@rescript/engine";
import { checkSemSyntax } from "./models/sem.js";

/**
 * ONE CHECK FOR EVERY ANALYSIS BEFORE IT IS KEPT — generated or hand-built.
 *
 * The plan generator and the workspace could both put an analysis in front of
 * the researcher that could not be computed (a variable that is not in the
 * survey, a mean of a text answer, a crosstab with nothing on one axis) or
 * that repeated another (a chi-square test beside the crosstab that already
 * carries the same chi-square). Those then ran, "failed" into a warning, and
 * showed as blank or wall-of-warning results. They are caught here instead,
 * with a reason the researcher can act on.
 */
export type IssueCode = "unknown_variable" | "no_variables" | "missing_axis" | "wrong_type" | "needs_groups" | "same_variable" | "missing_input" | "not_identified" | "invalid_model";
export interface PlanIssue { code: IssueCode; message: string; variables?: string[]; severity: "error" | "warning" }

const NUMERIC_KINDS = new Set(["regression", "correlation", "factor", "reliability", "cluster"]);

/**
 * How many items the runner will read from these names — a battery (a matrix
 * question, a multi-select's option flags) named by its question counts each
 * of its items, exactly as the runners' `expandBattery` reads it. A name the
 * dictionary does not describe counts once.
 */
export function expandedItemCount(names: readonly string[], variables: readonly VariableMeta[]): number {
  const byName = new Map(variables.map((v) => [v.name, v]));
  const out = new Set<string>();
  for (const n of names) {
    if (!n) continue;
    const meta = byName.get(n);
    const isItem = meta && (meta.optionCode != null || meta.rowCode != null);
    const siblings = meta?.questionId && !isItem ? variables.filter((v) => v.questionId === meta.questionId && (v.optionCode != null || v.rowCode != null) && !v.derived) : [];
    if (siblings.length) for (const s of siblings) out.add(s.name); else out.add(n);
  }
  return out.size;
}

/** the one-sample tests read one variable; every other test compares two or more */
const ONE_VARIABLE_TESTS = new Set(["t_one_sample", "proportion_one_sample"]);
const THREE_VARIABLE_TESTS = new Set(["anova_two_way"]);

/**
 * WHAT EACH KIND OF ANALYSIS NEEDS BEFORE IT CAN RUN (the Apply audit, 2026-10-17).
 * The same minimums the runners refuse below (each runner's own early return),
 * so a definition this calls ready is one the runner computes, and one it calls
 * not ready names the missing input in the researcher's words. Shape only:
 * whether a name exists is `unknown_variable`, not this.
 */
export function missingInputs(def: AnalysisDefinition, variables: readonly VariableMeta[] = []): PlanIssue[] {
  const vs = (def.variables ?? []).filter(Boolean);
  const items = () => expandedItemCount(vs, variables);
  const o = (def.options ?? {}) as Record<string, unknown>;
  const list = (k: string) => (Array.isArray(o[k]) ? (o[k] as unknown[]).filter((x) => typeof x === "string" && x) as string[] : []);
  const out: PlanIssue[] = [];
  const need = (message: string) => out.push({ code: "missing_input", severity: "error", message });
  switch (def.kind) {
    case "correlation": if (vs.length && items() < 2) need("Correlation needs at least two numeric or scale variables — add a second variable."); break;
    case "factor": if (vs.length && items() < 3) need("Factor analysis needs at least three numeric or scale items — add more items of the battery."); break;
    case "reliability":
      if (vs.length && items() < 2) need("Reliability needs at least two items of the same scale — add the other items.");
      /* ω (2026-10-22) is read from a one-factor model: two items do not identify it */
      else if (o.omega === true && vs.length && items() < 3) need(`McDonald's ω needs at least three items (a one-factor model of ${items()} items is not identified) — add an item, or ask for α only.`);
      break;
    case "cluster": if (vs.length && items() < 2) need("Cluster analysis needs at least two numeric or scale variables to cluster on — add a second variable."); break;
    case "regression": {
      const model = String(o.model ?? "linear");
      if (model === "mediation" && vs.length && vs.length < 3) need("Mediation needs three variables in order: the outcome, the predictor and the mediator.");
      else if (vs.length === 1) need("Regression needs the dependent variable first, then at least one predictor — add a predictor.");
      /* the bootstrap of the indirect effect (2026-10-22) */
      if (o.bootstrap !== undefined && o.bootstrap !== null && o.bootstrap !== false) {
        const draws = o.bootstrap === true ? 5000 : Number(o.bootstrap);
        if (model !== "mediation") out.push({ code: "missing_input", severity: "warning", message: "A bootstrap is run for the indirect effect of a mediation only; this regression has no mediator, so it is ignored." });
        else if (!(Number.isFinite(draws) && draws >= 200 && draws <= 20_000)) need(`The bootstrap needs between 200 and 20,000 resamples (${String(o.bootstrap)} asked) — 5,000 is the usual choice.`);
      }
      break;
    }
    case "test": {
      const t = String(o.test ?? "auto");
      if (ONE_VARIABLE_TESTS.has(t)) break;
      if (THREE_VARIABLE_TESTS.has(t) && vs.length && vs.length < 3) need("A two-way ANOVA needs the outcome and two grouping factors.");
      break;   // fewer than two variables for a two-sample test is `needs_groups` below
    }
    case "brand": { const stages = Array.isArray(o.stages) ? (o.stages as unknown[]).length : 0; if (stages < 2 && vs.length === 1) need("A brand funnel needs at least two stages over the same brand list (e.g. awareness and consideration) — add the next stage's question."); break; }
    case "gap": {
      const imp = list("importance"), perf = list("performance");
      if (imp.length || perf.length) {
        if (!imp.length) need("Importance × performance needs the importance items — set them in Options.");
        else if (!perf.length) need("Importance × performance needs the performance items (in the same order as the importance items) — set them in Options.");
      } else if (vs.length && vs.length < 2) need("Importance × performance needs matched importance and performance items — set them in Options, or pick both sets of variables.");
      break;
    }
    case "pricing": {
      if (String(o.method ?? "van_westendorp") === "gabor_granger") {
        const prices = Array.isArray(o.prices) ? (o.prices as unknown[]).length : 0;
        /* from the plan (2026-10-22) the prices are required and must match: a planned demand curve on the positions 1, 2, 3 would name a "revenue-maximising price" that is not a price */
        const planned = typeof o.planned === "string" && !!o.planned;
        const bad = Array.isArray(o.prices) ? (o.prices as unknown[]).filter((p) => !(typeof p === "number" && Number.isFinite(p) && p > 0)) : [];
        if (planned && vs.length && items() < 2) need("Gabor–Granger needs a purchase-intent question at two or more price points.");
        else if (planned && vs.length && !prices) need(`Gabor–Granger from the plan needs the price of each of the ${items()} purchase-intent questions (options.prices, in question order).`);
        else if (bad.length) need("Every Gabor–Granger price must be a positive number.");
        else if (prices && vs.length && prices !== items()) out.push({ code: "missing_input", severity: planned ? "error" : "warning", message: `Gabor-Granger has ${prices} price point${prices === 1 ? "" : "s"} for ${items()} purchase-intent item${items() === 1 ? "" : "s"} — give one price per item, in item order.` });
      } else {
        const named = ["tooCheap", "cheap", "expensive", "tooExpensive"].filter((k) => typeof o[k] === "string" && o[k]).length;
        if (vs.length && Math.max(vs.length, named) < 4) need(`Van Westendorp needs the four price questions in order — too cheap, bargain, expensive, too expensive (${Math.max(vs.length, named)} chosen).`);
      }
      break;
    }
    case "segmentation": if (!(def.segments?.length)) need("A segment profile compares saved segments — choose at least one in Segments & weighting."); break;
    case "weighting": if (!(def.weighting && (def.weighting.variable || def.weighting.rim?.length))) need("Weighting needs rim targets or a weight variable — add them in Segments & weighting."); break;
    /* advanced models (2026-10-18) — the same minimums the runners in analyses/advanced.ts refuse */
    case "hb": {
      if (vs.length > 1) need("Hierarchical Bayes reads one CBC, ACBC, menu or MaxDiff question — choose only that question.");
      const meta = variables.find((v) => v.name === vs[0]);
      /* F4 2026-10-22: ACBC (acbc_task) and menu-based conjoint are estimated by HB too */
      if (vs.length === 1 && meta?.questionType && meta.questionType !== "conjoint_task" && meta.questionType !== "maxdiff_task" && meta.questionType !== "acbc_task") need(`Hierarchical Bayes needs a CBC, ACBC, menu-based (conjoint) or MaxDiff question; ${vs[0]} is a ${meta.questionType.replace(/_/g, " ")} question.`);
      const iters = (Number(o.burnIn ?? 5000) || 0) + (Number(o.draws ?? 5000) || 0);
      if (iters > 200_000) need(`Burn-in plus draws is ${iters.toLocaleString()} iterations per chain — the limit is 200,000.`);
      break;
    }
    case "lca": {
      if (vs.length && items() < 2) need("Latent class analysis needs at least two categorical indicators — add more variables.");
      const minK = Number(o.minClasses ?? 1), maxK = Number(o.maxClasses ?? 4);
      /* covariates (2026-10-22): asked for by name, refused in words — the estimator has no covariate (one- or three-step) model */
      if (Array.isArray(o.covariates) && (o.covariates as unknown[]).length) need(`Latent class with covariates (${(o.covariates as unknown[]).map(String).join(", ")}) is not estimated here — the model has no covariate step. Run it on the indicators alone, then profile the classes by ${(o.covariates as unknown[]).length === 1 ? "that variable" : "those variables"} with a crosstab of the assigned class.`);
      if (!(minK >= 1 && maxK <= 8 && minK <= maxK)) need("The class range must run from 1 to at most 8 classes, the smallest first.");
      else if (vs.length && items() >= 2) {
        const metas = vs.map((n) => variables.find((v) => v.name === n));
        const cats = metas.map((m) => m?.categories?.length ?? 0);
        if (cats.every((c) => c >= 2)) {
          const cells = cats.reduce((t, c) => t * c, 1);
          const npar = (k: number) => (k - 1) + k * cats.reduce((t, c) => t + c - 1, 0);
          if (cells - 1 - npar(maxK) < 0) {
            const ok = Array.from({ length: maxK }, (_, i) => i + 1).filter((k) => cells - 1 - npar(k) >= 0).pop() ?? 1;
            out.push({ code: "not_identified", severity: minK > ok ? "error" : "warning", message: `${maxK} classes are not identified with these ${vs.length} indicators (${npar(maxK)} parameters for ${cells - 1} response-pattern frequencies) — at most ${ok} class${ok === 1 ? "" : "es"} can be estimated; larger K will be reported as not identified.` });
          }
        }
      }
      break;
    }
    case "sem": {
      const syntax = typeof o.syntax === "string" ? o.syntax.trim() : "";
      if (!syntax) { need("Write the model in Options — for example “F1 =~ q1 + q2 + q3” (measurement) and “F2 ~ F1” (structural path)."); break; }
      const known = variables.length ? new Set(variables.map((v) => v.name)) : null;
      const b = checkSemSyntax(syntax, { scaling: o.scaling === "unit_variance" ? "unit_variance" : "marker", ...(known ? { available: (n: string) => known.has(n) } : {}) });
      for (const e of b.errors) out.push({ code: /not identified|t-rule|no scale|single indicator|two indicators/.test(e) ? "not_identified" : "invalid_model", severity: "error", message: e });
      for (const w of b.warnings) out.push({ code: "not_identified", severity: "warning", message: w });
      /* the hypotheses' paths (2026-10-22): each must be a path the model estimates, or its verdict could never be read */
      const hp = o.hypothesisPaths && typeof o.hypothesisPaths === "object" ? Object.entries(o.hypothesisPaths as Record<string, unknown>) : [];
      for (const [h, path] of hp) {
        const pm = /^\s*([\w.]+)\s*~\s*([\w.]+)\s*$/.exec(String(path)), dm = /^\s*:=\s*([\w.]+)\s*$/.exec(String(path));
        const known = pm ? b.parse.statements.some((s) => s.op === "~" && s.lhs === pm[1] && s.rhs.name === pm[2]) : dm ? b.parse.defined.some((d) => d.name === dm[1]) : false;
        if (!known) out.push({ code: "invalid_model", severity: "warning", message: `${h} is linked to “${String(path)}”, which is not a path in the model — its verdict will read nothing.` });
      }
      if (!b.errors.length && known) {
        const metas = new Map(variables.map((v) => [v.name, v]));
        const observed = b.model?.observed ?? [];
        const bad = observed.filter((n) => { const sc = scaleOf(metas.get(n)); return sc === "text" || sc === "multi" || sc === "time"; });
        if (bad.length) out.push({ code: "wrong_type", severity: "error", message: `SEM treats every observed variable as continuous; ${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} not numeric or scale.` });
        const nominal = observed.filter((n) => scaleOf(metas.get(n)) === "nominal");
        if (nominal.length) out.push({ code: "wrong_type", severity: "warning", message: `${nominal.join(", ")} ${nominal.length === 1 ? "is" : "are"} unordered categories; SEM will treat the codes as numbers.` });
      }
      break;
    }
    default: break;
  }
  return out;
}

/** the kinds whose inputs are set somewhere other than the variable list, so an empty list is not by itself "no variables" */
const kindNeedsNoVariables = (def: AnalysisDefinition): boolean => {
  if (def.kind === "quality" || def.kind === "weighting" || def.kind === "segmentation") return true;
  if (def.kind === "sem") return typeof def.options?.syntax === "string" && def.options.syntax.trim().length > 0;
  const o = (def.options ?? {}) as Record<string, unknown>;
  if (def.kind === "gap") return Array.isArray(o.importance) && (o.importance as unknown[]).length > 0;
  if (def.kind === "brand") return Array.isArray(o.stages) && (o.stages as unknown[]).length >= 2;
  if (def.kind === "pricing") return ["tooCheap", "cheap", "expensive", "tooExpensive"].every((k) => typeof o[k] === "string" && o[k]);
  return false;
};

/** Names the analysis refers to that the dataset does not know. */
export function unknownVariables(def: Pick<AnalysisDefinition, "variables" | "rows" | "columns" | "segments">, known: { has(n: string): boolean }): string[] {
  const refs = [...(def.variables ?? []), ...(def.rows ?? []), ...(def.columns ?? [])].filter(Boolean);
  return [...new Set(refs.filter((v) => !known.has(v)))];
}

/** `extra` is either more known names, or a predicate for "is this name known" (see surveyKnownNames) */
export type KnownNames = Iterable<string> | ((name: string) => boolean);
const knownSet = (variables: readonly VariableMeta[], extra: KnownNames): { has(n: string): boolean } => {
  const base = new Set(variables.map((v) => v.name));
  if (typeof extra === "function") return { has: (n) => base.has(n) || extra(n) };
  for (const n of extra) base.add(n);
  return base;
};

export function validateAnalysis(def: AnalysisDefinition, variables: readonly VariableMeta[], extraNames: KnownNames = []): PlanIssue[] {
  const known = knownSet(variables, extraNames);
  const meta = new Map(variables.map((v) => [v.name, v]));
  const out: PlanIssue[] = [];
  const dead = unknownVariables(def, known);
  if (dead.length) out.push({ code: "unknown_variable", severity: "error", variables: dead, message: `${dead.join(", ")} ${dead.length === 1 ? "is" : "are"} not in this survey's data.` });
  if (def.kind === "crosstab") {
    if (!(def.rows?.length) || !(def.columns?.length)) out.push({ code: "missing_axis", severity: "error", message: "A crosstab needs at least one row variable and one column variable." });
    const same = (def.rows ?? []).filter((r) => (def.columns ?? []).includes(r));
    if (same.length) out.push({ code: "same_variable", severity: "error", variables: same, message: `${same.join(", ")} is tabulated against itself.` });
  } else if (!kindNeedsNoVariables(def) && !(def.variables?.filter(Boolean).length)) {
    out.push({ code: "no_variables", severity: "error", message: "This analysis has no variables chosen." });
  }
  out.push(...missingInputs(def, variables));
  if (NUMERIC_KINDS.has(def.kind)) {
    const bad = (def.variables ?? []).filter((v) => { const s = scaleOf(meta.get(v)); return s === "text" || s === "nominal" && def.kind !== "regression" && def.kind !== "cluster"; });
    if (bad.length && !dead.length) out.push({ code: "wrong_type", severity: "error", variables: bad, message: `${def.kind} needs numeric or scale variables; ${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} categorical or text.` });
  }
  if (def.kind === "descriptive" && (def.options?.statistic === "mean" || def.measure === "mean")) {
    const bad = (def.variables ?? []).filter((v) => { const s = scaleOf(meta.get(v)); return s === "text" || s === "nominal" || s === "multi"; });
    if (bad.length && !dead.length) out.push({ code: "wrong_type", severity: "error", variables: bad, message: `A mean needs a numeric or scale variable; ${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} not.` });
  }
  const oneSample = def.kind === "test" && ONE_VARIABLE_TESTS.has(String(def.options?.test ?? "auto"));
  if (def.kind === "test" && !oneSample && !dead.length && (def.variables?.length ?? 0) === 1) out.push({ code: "needs_groups", severity: "error", message: "A significance test compares an outcome across a grouping or a second variable — one variable is not enough. Add the grouping variable, or choose a one-sample test in Options." });
  if (def.kind === "test" && !dead.length && (def.variables?.length ?? 0) >= 2 && new Set(def.variables).size < 2) out.push({ code: "same_variable", severity: "error", variables: [...new Set(def.variables)], message: `${def.variables![0]} is tested against itself.` });
  return out;
}

/**
 * CAN THIS ANALYSIS BE APPLIED? — the ONE rule the builder's Run button, the
 * run route, the plan editor and the plan's item states all read (the Apply
 * audit, 2026-10-17). `ready` is false exactly when `validateAnalysis` has an
 * error; `missing` lists each in the researcher's words, so a disabled button
 * always says what to add. Names are checked only when asked (`checkNames`):
 * the builder picks from the dictionary, and the server resolves the plan's
 * own computed variables, so a name check there would refuse what runs.
 */
export interface Readiness { ready: boolean; missing: string[]; warnings: string[]; codes: IssueCode[] }
export function analysisReadiness(def: AnalysisDefinition, variables: readonly VariableMeta[] = [], opts: { checkNames?: boolean; extraNames?: KnownNames } = {}): Readiness {
  const issues = validateAnalysis(def, variables, opts.checkNames ? (opts.extraNames ?? []) : () => true)
    .filter((i) => opts.checkNames || i.code !== "unknown_variable");
  const errors = issues.filter((i) => i.severity === "error");
  return { ready: !errors.length, missing: errors.map((i) => i.message), warnings: issues.filter((i) => i.severity === "warning").map((i) => i.message), codes: errors.map((i) => i.code) };
}

/* ------------------------------------------------------------------ duplicates */

const sorted = (a?: readonly string[]) => [...(a ?? [])].sort().join("|");
const canon = (o: unknown): string => JSON.stringify(o, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]])) : v));

/** the kinds of test whose result does not depend on which variable is named first */
const symmetric = (def: AnalysisDefinition): boolean => def.kind === "correlation" || (def.kind === "test" && def.options?.test === "chi_square");

/**
 * What an analysis IS, independent of its name, folder and bookkeeping. Two with the same signature compute the same numbers.
 *
 * Audit P-4: everything that changes a number is in it — the weighting, the saved filters it uses (`filterIds`),
 * the layers and the segments (a weighted and an unweighted crosstab used to have the same signature) — and a test
 * that is symmetric in its two variables (chi-square, correlation) is the same test whichever is named first.
 */
export function analysisSignature(def: AnalysisDefinition): string {
  const o = { ...(def.options ?? {}) } as Record<string, unknown>;
  /* presentation and bookkeeping — they change how the table looks or where it came from, not a number in it */
  for (const k of ["planned", "plannedHash", "plannedReads", "requested", "hypotheses", "formatting", "title", "subtitle", "layout", "significance", "decimals", "sigLevel", "alpha"]) delete o[k];
  const scope = `${canon(o)}:${canon(def.filter ?? null)}:${sorted(def.filterIds)}:${canon(def.weighting ?? null)}:${sorted(def.layers)}:${canon(def.segments ?? null)}:${canon(def.dataset ?? null)}`;
  if (def.kind === "crosstab") return `crosstab:${sorted(def.rows)}>${sorted(def.columns)}:${def.measure ?? "pct_col"}:${scope}`;
  return `${def.kind}:${symmetric(def) ? sorted(def.variables) : (def.variables ?? []).join("|")}:${scope}`;
}

/** the chi-square a crosstab already prints for its one row × one column pair — a separate test for the same pair repeats it */
export const crosstabCarriesChiSquare = (x: AnalysisDefinition, t: AnalysisDefinition): boolean =>
  x.kind === "crosstab" && t.kind === "test" && (t.options?.test === "chi_square" || t.options?.test === "auto")
  && (x.rows?.length === 1 && x.columns?.length === 1) && (t.variables?.length === 2)
  && ((x.rows![0] === t.variables[0] && x.columns![0] === t.variables[1]) || (x.rows![0] === t.variables[1] && x.columns![0] === t.variables[0]));

export interface DroppedPlanItem { item: PlannedAnalysis; reason: string; duplicateOf?: string }

/**
 * The planned items worth keeping: dead references and uncomputable items are
 * blocked (with the reason), exact repeats and tests a crosstab already
 * carries are dropped (naming what they repeat). Order is preserved.
 */
export function reviewPlanned(items: readonly PlannedAnalysis[], variables: readonly VariableMeta[], extraNames: KnownNames = []): { kept: PlannedAnalysis[]; blocked: (DroppedPlanItem & { issues: PlanIssue[] })[]; duplicates: DroppedPlanItem[] } {
  const extra = extraNames;
  const kept: PlannedAnalysis[] = []; const blocked: (DroppedPlanItem & { issues: PlanIssue[] })[] = []; const duplicates: DroppedPlanItem[] = [];
  const seen = new Map<string, PlannedAnalysis>();
  for (const it of items) {
    const issues = validateAnalysis(it.definition, variables, extra).filter((i) => i.severity === "error");
    if (issues.length) { blocked.push({ item: it, reason: issues.map((i) => i.message).join(" "), issues }); continue; }
    const sig = analysisSignature(it.definition);
    const same = seen.get(sig);
    if (same) { duplicates.push({ item: it, reason: "It computes exactly what another planned analysis already does.", duplicateOf: same.definition.name }); continue; }
    const carrier = kept.find((k) => crosstabCarriesChiSquare(k.definition, it.definition));
    if (carrier) { duplicates.push({ item: it, reason: "The crosstab for the same two variables already reports this chi-square test.", duplicateOf: carrier.definition.name }); continue; }
    /* a test planned BEFORE its crosstab: the crosstab wins and the test is removed from what was kept */
    const idx = kept.findIndex((k) => crosstabCarriesChiSquare(it.definition, k.definition));
    if (idx >= 0) { duplicates.push({ item: kept[idx], reason: "The crosstab for the same two variables already reports this chi-square test.", duplicateOf: it.definition.name }); kept.splice(idx, 1); }
    seen.set(sig, it); kept.push(it);
  }
  return { kept, blocked, duplicates };
}

/** an already-saved analysis (hand-built or earlier-planned) that a new planned item would repeat */
export function findExistingDuplicate(def: AnalysisDefinition, existing: readonly { id: string; name: string; definition: AnalysisDefinition }[]): { id: string; name: string } | null {
  const sig = analysisSignature(def);
  for (const e of existing) {
    if (analysisSignature(e.definition) === sig) return { id: e.id, name: e.name };
    if (crosstabCarriesChiSquare(e.definition, def) || crosstabCarriesChiSquare(def, e.definition)) return { id: e.id, name: e.name };
  }
  return null;
}

/** an analysis made by the plan generator, as opposed to one a person built or added */
export const isPlanned = (def: Pick<AnalysisDefinition, "options">): boolean => typeof def.options?.planned === "string" && def.options.planned.length > 0;

/**
 * Every name an analysis may legitimately read in this survey: the dataset's
 * variables, every question's variable name and code (design tasks — conjoint,
 * MaxDiff — are read through their question, not as a column), and the names
 * the plan computes itself (derived variables, segments, calculations, embedded data).
 */
export function surveyKnownNames(def: SurveyDefinition, variables: readonly VariableMeta[]): (name: string) => boolean {
  const out = new Set<string>(variables.map((v) => v.name));
  for (const q of def.questions) { if (q.variableName) out.add(q.variableName); if (q.code) out.add(q.code); }
  return (name) => out.has(name) || isNonQuestionVariable(def, name);
}

/**
 * The full review for "create the planned analyses": dead / uncomputable items
 * blocked, repeats collapsed, and anything the researcher already has — a
 * planned item saved earlier (by its planned id), or a hand-built analysis that
 * computes the same thing under any name — left alone. Pure, so the same
 * decision is made (and tested) wherever it is needed.
 */
export interface SavedAnalysisRef { id: string; name: string; definition: AnalysisDefinition }
export function reviewAgainstSaved(
  items: readonly PlannedAnalysis[], variables: readonly VariableMeta[], known: KnownNames, saved: readonly SavedAnalysisRef[],
): { toCreate: PlannedAnalysis[]; existingFor: Map<string, string>; blocked: { name: string; reason: string }[]; duplicates: { name: string; reason: string; duplicateOf?: string }[] } {
  const review = reviewPlanned(items, variables, known);
  const blocked = review.blocked.map((b) => ({ name: b.item.definition.name, reason: b.reason }));
  const duplicates = review.duplicates.map((d) => ({ name: d.item.definition.name, reason: d.reason, ...(d.duplicateOf ? { duplicateOf: d.duplicateOf } : {}) }));
  const byPlanned = new Map<string, string>();
  for (const r of saved) { const p = r.definition?.options?.planned; if (typeof p === "string" && p && !byPlanned.has(p)) byPlanned.set(p, r.id); }
  const toCreate: PlannedAnalysis[] = []; const existingFor = new Map<string, string>(byPlanned);
  for (const it of review.kept) {
    const planned = String(it.definition.options?.planned ?? "");
    if (planned && byPlanned.has(planned)) continue;   // already saved from this very plan item
    const mine = findExistingDuplicate(it.definition, saved);
    if (mine) { duplicates.push({ name: it.definition.name, reason: "You already have an analysis that computes this.", duplicateOf: mine.name }); if (planned) existingFor.set(planned, mine.id); continue; }
    toCreate.push(it);
  }
  return { toCreate, existingFor, blocked, duplicates };
}

/* ------------------------------------------------------------------ a planned item, before it is saved */

const words = (m: string) => m.replace(/_/g, " ");
/** a method named the way a sentence starts with it: "An ANOVA", "A t-test" */
const A_METHOD: Record<string, string> = { t_test: "A t-test", anova: "An ANOVA", mann_whitney: "A Mann–Whitney test", kruskal_wallis: "A Kruskal–Wallis test", regression: "A regression", logistic_regression: "A logistic regression", driver_analysis: "A driver analysis", hb: "A hierarchical Bayes model", latent_class: "A latent class analysis", sem: "A structural equation model" };
const aMethod = (m: string) => A_METHOD[m] ?? `${/^[aeiou]/i.test(m) ? "An" : "A"} ${words(m)}`;
const GROUP_TESTS = new Set(["t_test", "anova", "mann_whitney", "kruskal_wallis"]);
const MODEL_TESTS = new Set(["regression", "logistic_regression", "driver_analysis"]);

/**
 * A PLANNED crosstab or test (the plan editor, the copilot's plan actions, the
 * plan's item states) judged by the same rule as a built analysis: the roles
 * its method needs (an outcome, a grouping, predictors) first, in the plan's
 * own words, then `analysisReadiness` on the analysis it becomes. The editor's
 * "Add to the plan" and the apply's "skipped (invalid)" can no longer disagree.
 */
export function plannedItemReadiness(item: { kind: "crosstab"; crosstab: Pick<PlannedCrosstab, "rows" | "columns"> & Partial<PlannedCrosstab> } | { kind: "test"; test: Pick<PlannedTest, "method" | "variables"> & Partial<PlannedTest> }, variables: readonly VariableMeta[] = [], def?: SurveyDefinition): Readiness {
  const spec = { environment: "LIVE" as const, dataset: "all" as const };
  const missing: string[] = [];
  if (item.kind === "crosstab") {
    const x = item.crosstab;
    if (!x.rows?.length) missing.push("Choose at least one row variable.");
    if (!x.columns?.length) missing.push("Choose at least one column variable.");
    const same = (x.rows ?? []).filter((r) => (x.columns ?? []).includes(r));
    if (same.length) missing.push(`${same.join(", ")} cannot be both a row and a column.`);
    if (missing.length) return { ready: false, missing, warnings: [], codes: missing.map(() => "missing_input") };
    const r = analysisReadiness(crosstabDefinition({ id: x.id ?? "draft", rows: x.rows, columns: x.columns, measure: x.measure, priority: x.priority ?? 2, hypotheses: x.hypotheses ?? [] } as PlannedCrosstab, spec, def), variables);
    return r;
  }
  const t = item.test;
  const vars = (t.variables ?? []).filter(Boolean);
  const m = t.method;
  if (GROUP_TESTS.has(m)) {
    if (!t.outcome && !vars.length) missing.push(`${aMethod(m)} compares an outcome across groups — choose the outcome.`);
    if (!t.groupBy && !(t.outcome && vars.length)) missing.push(`${aMethod(m)} compares groups — choose the grouping variable.`);
  } else if (m === "chi_square") {
    const n = [t.outcome, t.groupBy, ...vars].filter(Boolean).length;
    if (n < 2) missing.push("A chi-square test needs two categorical variables — an outcome and a grouping (or a second variable).");
  } else if (MODEL_TESTS.has(m)) {
    if (!t.outcome) missing.push(`${aMethod(m)} needs an outcome (the dependent variable).`);
    if (!vars.length && !t.moderator && !t.mediator) missing.push(`${aMethod(m)} needs at least one predictor — add it under Variables.`);
  } else if (m === "correlation") {
    if ([t.outcome, ...vars].filter(Boolean).length < 2) missing.push("A correlation needs two or more numeric or scale variables (the outcome and a variable, or two variables).");
  } else if (m === "reliability") {
    if (vars.length + (t.outcome ? 1 : 0) < 2 && expandedItemCount([...(t.outcome ? [t.outcome] : []), ...vars], variables) < 2) missing.push("Reliability needs at least two items.");
  } else if (m === "hb") {
    /* advanced models from the plan (2026-10-22): the roles first, in the plan's words; the model-level rules in missingInputs */
    const n = new Set([...(t.outcome ? [t.outcome] : []), ...vars]).size;
    if (!n) missing.push("Hierarchical Bayes reads one CBC (conjoint) or MaxDiff question — choose it under Variables.");
    else if (n > 1) missing.push("Hierarchical Bayes reads exactly one CBC or MaxDiff question — plan one item per exercise.");
  } else if (m === "latent_class") {
    if (!vars.length) missing.push("Latent class analysis needs its indicators — choose two or more categorical questions under Variables.");
  } else if (m === "sem") {
    if (!(typeof t.options?.syntax === "string" && t.options.syntax.trim())) missing.push("A structural equation model needs its model (the measurement model of each construct and the paths of the hypotheses) — plan it from the research design, or write it in the item's options.");
  } else if (!t.outcome && !vars.length && !t.groupBy) missing.push(`${aMethod(m)} needs the variable it reads — choose it under Variables.`);
  /* a mediation with a bootstrap needs all three roles */
  if (MODEL_TESTS.has(m) && t.options?.bootstrap && !t.mediator) missing.push("The bootstrap is for the indirect effect of a mediation — name the mediator (or drop the bootstrap).");
  if (missing.length) return { ready: false, missing, warnings: [], codes: missing.map(() => "missing_input") };
  return analysisReadiness(testDefinition({ id: t.id ?? "draft", priority: t.priority ?? 2, hypotheses: t.hypotheses ?? [], ...t, variables: vars } as PlannedTest, spec, def), variables);
}
