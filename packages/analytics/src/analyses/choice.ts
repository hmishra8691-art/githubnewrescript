import type { AnalysisDefinition, AnalysisResult, ResultTable } from "../types.js";
import { categoricalColumn, categoriesOf, labelOf, type Dataset } from "../dataset.js";
import { conditionalLogit, logitShares, type ChoiceSet } from "../stats/choice.js";
import { fmtNum, fmtP, fmtPct, makeResult, opt, pct, round } from "./common.js";
/* F4 2026-10-22: the conjoint suite — ACBC, menu and CVA estimators, dual-response None, the simulator */
import { acbcAnalysis } from "../conjoint/acbc.js";
import { cvaAnalysis } from "../conjoint/cva.js";
import { menuModelTables, menuTasks } from "../conjoint/menu.js";
import { scenariosFor, simulatorTables } from "../conjoint/simulatorTables.js";
import { numericValues, type UtilityModel } from "../conjoint/simulator.js";

/** dual-response None codings (F4): "dual" = forced choice + a buy/no-buy task (Sawtooth's default); "single_none" = one task with None chosen when they would not buy; "forced" = the forced choice only (no None) */
export type DualCoding = "dual" | "single_none" | "forced";
export const dualCodingOf = (v: unknown): DualCoding => (v === "single_none" || v === "forced" ? v : "dual");

const DESIGN_COLS = new Set(["version", "task", "alt", "is_holdout", "none_option", "position", "item_index", "item_label"]);

function designFor(ds: Dataset, questionId: string) {
  const q = ds.def.questions.find((x) => x.id === questionId);
  const design = q ? ds.def.designs.find((d) => d.id === q.settings.designRef) : undefined;
  return { q, design, rows: (design?.file?.rows ?? []) as Record<string, unknown>[], columns: design?.file?.columns ?? [] };
}

/** the alternatives of one task for one version, looked up from an index built once — the filter it replaces ran over the whole design for every task of every respondent (audit F-3) */
function designIndex(rows: Record<string, unknown>[]) {
  const byVersion = new Map<string, Record<string, unknown>[]>(), byTask = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const t = String(r.task), v = `${String(r.version ?? "1")}\u0000${t}`;
    (byVersion.get(v) ?? byVersion.set(v, []).get(v)!).push(r);
    (byTask.get(t) ?? byTask.set(t, []).get(t)!).push(r);
  }
  return (task: string, version: string): Record<string, unknown>[] => byVersion.get(`${version}\u0000${task}`) ?? byTask.get(task) ?? [];
}

/**
 * THE CBC DESIGN MATRIX — one coding for every choice model on the platform
 * (the aggregate MNL below and the HB-MNL in models/hb.ts): levels in the
 * configured order, effects coding with the first level as reference (−1 on
 * every level column of its attribute, so part-worths sum to zero per
 * attribute), then a None constant when the design has a None row.
 */
export function cbcCoding(rows: Record<string, unknown>[], columns: string[], config: unknown, opts: { dual?: DualCoding } = {}) {
  const attrs = columns.filter((c) => !DESIGN_COLS.has(c));
  const levels: Record<string, string[]> = {};
  // levels in the order the design was configured with (the file's first-appearance order otherwise)
  const configured = ((config as { attributes?: { name: string; levels: string[] }[] } | undefined)?.attributes ?? []);
  for (const a of attrs) {
    /* "" is a not-applicable cell of a brand-specific design (F4): never a level, coded as zeros */
    const seen = [...new Set(rows.filter((r) => Number(r.none_option) !== 1).map((r) => String(r[a] ?? "")).filter((l) => l !== ""))];
    const cfg = configured.find((x) => x.name === a)?.levels?.map(String).filter((l) => seen.includes(l));
    levels[a] = cfg && cfg.length === seen.length ? cfg : seen;
  }
  // parameter layout: for each attribute, levels[1..] (first = reference, effects-coded so utilities sum to zero per attribute), then none constant if present
  /* a dual-response design has no None row but a None constant (unless the forced-choice-only coding is asked for) — F4 */
  const dualDesign = (config as { dualResponseNone?: boolean } | undefined)?.dualResponseNone === true;
  const hasNone = rows.some((r) => Number(r.none_option) === 1) || (dualDesign && (opts.dual ?? "dual") !== "forced");
  const idx: { attr: string; level: string; i: number }[] = [];
  let p = 0;
  for (const a of attrs) for (const l of levels[a].slice(1)) idx.push({ attr: a, level: l, i: p++ });
  const noneIdx = hasNone ? p++ : -1;
  const featuresOf = (r: Record<string, unknown>): number[] => {
    const x = new Array(p).fill(0);
    if (Number(r.none_option) === 1) { if (noneIdx >= 0) x[noneIdx] = 1; return x; }
    for (const a of attrs) {
      const l = String(r[a]), ls = levels[a];
      const k = ls.indexOf(l);
      if (k === 0) for (const e of idx) { if (e.attr === a) x[e.i] = -1; }  // effects coding: reference = −1 on every level column
      else { const e = idx.find((e) => e.attr === a && e.level === l); if (e) x[e.i] = 1; }
    }
    return x;
  };
  /** every level (reference included) as a linear combination of the coded parameters, then None */
  const levelRows = (): { names: string[]; attr: (string | null)[]; level: string[]; rows: number[][] } => {
    const names: string[] = [], attr: (string | null)[] = [], level: string[] = [], out: number[][] = [];
    for (const a of attrs) for (const l of levels[a]) {
      const r = new Array(p).fill(0);
      if (l === levels[a][0]) for (const e of idx) { if (e.attr === a) r[e.i] = -1; }
      else r[idx.find((e) => e.attr === a && e.level === l)!.i] = 1;
      names.push(`${a}: ${l}`); attr.push(a); level.push(l); out.push(r);
    }
    if (noneIdx >= 0) { const r = new Array(p).fill(0); r[noneIdx] = 1; names.push("None"); attr.push(null); level.push("None"); out.push(r); }
    return { names, attr, level, rows: out };
  };
  const noneVector = (): number[] => { const x = new Array(p).fill(0); if (noneIdx >= 0) x[noneIdx] = 1; return x; };
  return { attrs, levels, idx, p, hasNone, noneIdx, featuresOf, levelRows, noneVector, dualDesign, dual: dualDesign ? (opts.dual ?? "dual") : null };
}

/**
 * DUAL-RESPONSE NONE (F4 2026-10-22): one answered task's choice sets under the chosen coding.
 * `alts` are the task's design rows (no None row), `chosen` the forced choice, `buy` the follow-up.
 */
export function dualResponseSets(coding: ReturnType<typeof cbcCoding>, alts: Record<string, unknown>[], chosen: number, buy: unknown, weight?: number): ChoiceSet[] {
  const X = alts.map(coding.featuresOf);
  const w = weight != null ? { weight } : {};
  const b = buy === "yes" ? true : buy === "no" ? false : null;
  if (coding.dual === "forced" || coding.noneIdx < 0) return [{ alternatives: X, chosen, ...w }];
  if (coding.dual === "single_none") return b == null ? [{ alternatives: X, chosen, ...w }] : [{ alternatives: [...X, coding.noneVector()], chosen: b ? chosen : X.length, ...w }];
  return [{ alternatives: X, chosen, ...w }, ...(b == null ? [] : [{ alternatives: [X[chosen], coding.noneVector()], chosen: b ? 0 : 1, ...w }])];
}

/**
 * The CBC answers of every respondent as choice sets, read exactly as the
 * aggregate model reads them (version from the seed-derived column, design
 * alternatives sorted, the chosen alternative located, holdouts set aside) —
 * grouped per respondent for an individual-level model.
 */
export function cbcRespondentSets(ds: Dataset, qid: string, opts: { includeHoldouts?: boolean; dual?: DualCoding } = {}) {
  const { q, design, rows, columns } = designFor(ds, qid);
  if (!design || !rows.length || design.kind === "menu" || design.kind === "cva") return null;
  const coding = cbcCoding(rows, columns, design.config, { dual: opts.dual });
  const altsOf = designIndex(rows);
  const respondents: { ci: number; id: string; sets: ChoiceSet[] }[] = [];
  let holdoutTasks = 0;
  ds.cases.forEach((c, ci) => {
    const ans = c.answers[qid] as Record<string, unknown> | undefined;
    if (!ans || typeof ans !== "object") return;
    const version = String(c.answers[`${qid}_version`] ?? c.vars[`${q?.variableName}_VERSION`] ?? "1");
    const sets: ChoiceSet[] = [];
    for (const [task, choice] of Object.entries(ans)) {
      if (choice == null || choice === "") continue;
      let alts = altsOf(task, version);
      if (!alts.length) continue;
      alts = [...alts].sort((a, b) => Number(a.alt) - Number(b.alt));
      const chosenIdx = alts.findIndex((r) => String(r.alt) === String(choice));
      if (chosenIdx < 0) continue;
      if (Number(alts[0].is_holdout) === 1 && !opts.includeHoldouts) { holdoutTasks++; continue; }
      if (coding.dual) { sets.push(...dualResponseSets(coding, alts, chosenIdx, ans[`${task}_buy`])); continue; }
      sets.push({ alternatives: alts.map(coding.featuresOf), chosen: chosenIdx });
    }
    if (sets.length) respondents.push({ ci, id: String(c.id ?? ci), sets });
  });
  return { q, design, coding, respondents, holdoutTasks };
}

/**
 * The MaxDiff answers per respondent as choice sets — the same sequential
 * best–worst coding as the aggregate model (best from the set; worst from the
 * rest with negated features; effects coding, last item as reference).
 * Anchored designs are not modelled individually (null + reason).
 */
export function maxdiffRespondentSets(ds: Dataset, qid: string) {
  const { q, design, rows } = designFor(ds, qid);
  if (!design || !rows.length) return null;
  if ((design.config as { anchored?: boolean } | undefined)?.anchored === true) return { unsupported: "Anchored (dual-response) MaxDiff is not estimated with HB here: the anchor constraints need a different parameterisation. The aggregate anchored model is available in the MaxDiff analysis." as const };
  const items = [...new Map(rows.map((r) => [String(r.item_index), String(r.item_label ?? r.item_index)])).entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
  const itemIdx = new Map(items.map(([code], i) => [code, i]));
  const K = items.length, P = K - 1;
  const feat = (i: number) => { const x = new Array(P).fill(0); if (i === K - 1) x.fill(-1); else x[i] = 1; return x; };
  const practice = new Set(rows.filter((r) => Number(r.practice) === 1).map((r) => String(r.task)));
  const altsOf = designIndex(rows);
  const respondents: { ci: number; id: string; sets: ChoiceSet[] }[] = [];
  ds.cases.forEach((c, ci) => {
    const ans = c.answers[qid] as Record<string, { best?: string; worst?: string }> | undefined;
    if (!ans || typeof ans !== "object") return;
    const version = String(c.answers[`${qid}_version`] ?? c.vars[`${q?.variableName}_VERSION`] ?? "1");
    const sets: ChoiceSet[] = [];
    for (const [task, bw] of Object.entries(ans)) {
      if (!bw || typeof bw !== "object" || practice.has(task)) continue;
      const ids = altsOf(task, version).map((r) => itemIdx.get(String(r.item_index))!).filter((x) => x != null);
      if (ids.length < 2) continue;
      const b = bw.best != null ? itemIdx.get(String(bw.best)) : undefined, w = bw.worst != null ? itemIdx.get(String(bw.worst)) : undefined;
      if (b != null && w != null && b === w) continue;
      if (b != null && ids.includes(b)) sets.push({ alternatives: ids.map(feat), chosen: ids.indexOf(b) });
      if (w != null && ids.includes(w)) { const rest = ids.filter((i) => i !== b); if (rest.length >= 2) sets.push({ alternatives: rest.map((i) => feat(i).map((v) => -v)), chosen: rest.indexOf(w) }); }
    }
    if (sets.length) respondents.push({ ci, id: String(c.id ?? ci), sets });
  });
  const levelRows = items.map((_, i) => (i === K - 1 ? new Array(P).fill(-1) : Array.from({ length: P }, (__, j) => (j === i ? 1 : 0))));
  return { q, design, items: items.map(([code, label]) => ({ code, label })), p: P, levelRows, respondents };
}

/** the question an analysis names, resolved the way the choice runners do (exported for the HB runner) */
export function choiceQuestionFor(ds: Dataset, name: string): { id: string; type: string } | null {
  const meta = ds.byName.get(name);
  const q = ds.def.questions.find((x) => x.id === meta?.questionId || x.id === name || x.code === name || x.variableName === name)
    ?? ds.def.questions.find((x) => x.type === "conjoint_task" || x.type === "maxdiff_task");
  return q ? { id: q.id, type: q.type } : null;
}

const samplingWarning = (respondents: number, step: number) => `The model was fitted on every ${step === 2 ? "second" : `${step}th`} respondent (about ${Math.ceil(respondents / step).toLocaleString()} of ${respondents.toLocaleString()}) to keep the run within its time limit; counts and shares of choice use everyone. Estimates from this many respondents are already very precise.`;

/** the most respondents whose tasks go into the model fit; beyond it every k-th respondent is used and the result says so (audit F-3) */
export const MAX_MODEL_RESPONDENTS = 25_000;

function questionIdFor(ds: Dataset, name: string, type: string): string | undefined {
  const meta = ds.byName.get(name);
  if (meta?.questionId && ds.def.questions.find((q) => q.id === meta.questionId)?.type === type) return meta.questionId;
  const q = ds.def.questions.find((q) => q.id === name || q.code === name || q.variableName === name);
  return q?.type === type ? q.id : ds.def.questions.find((q) => q.type === type)?.id;
}

/* ============================================================ conjoint */

export function conjoint(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  /*
   * Conjoint audit 2026-10-17: the question NAMED must be the one analysed.
   * `questionIdFor` falls back to any conjoint_task in the survey, so a plan
   * item on an ACBC question (the analysis framework plans conjoint_utilities
   * for it) silently analysed a DIFFERENT question — or a menu — and reported
   * "Only 0 choice tasks answered". A named question of another type is now
   * refused in words.
   */
  const named = def.variables[0] ? (() => {
    const meta = ds.byName.get(def.variables[0]!);
    return ds.def.questions.find((x) => x.id === meta?.questionId || x.id === def.variables[0] || x.code === def.variables[0] || x.variableName === def.variables[0]);
  })() : undefined;
  /* F4 2026-10-22: ACBC is estimated (BYO + screening + rules + tournament) */
  if (named && named.type === "acbc_task") return acbcAnalysis(def, ds, totalCases, named.id);
  if (named && named.type !== "conjoint_task") {
    return makeResult(def, ds, { tables: [], chart: {}, warnings: [`${named.code} is not a conjoint question (${named.type}).`], recommendedCharts: ["attribute_importance"], totalCases });
  }
  const qid = named?.id ?? questionIdFor(ds, def.variables[0] ?? "", "conjoint_task");
  if (!qid) return makeResult(def, ds, { tables: [], chart: {}, warnings: ["No conjoint task question found in this survey."], recommendedCharts: ["attribute_importance"], totalCases });
  const { q, design, rows, columns } = designFor(ds, qid);
  if (!design || !rows.length) return makeResult(def, ds, { tables: [], chart: {}, warnings: ["The conjoint design file has not been generated."], recommendedCharts: ["attribute_importance"], totalCases });
  if (design.kind === "menu") return menuCounts(def, ds, totalCases, qid);
  if (design.kind === "cva") return cvaAnalysis(def, ds, totalCases, qid);
  const coding = cbcCoding(rows, columns, design.config, { dual: dualCodingOf(opt(def, "dualCoding", "dual")) });
  const { attrs, levels, idx, p, hasNone, noneIdx, featuresOf } = coding;
  const altsOf = designIndex(rows);
  const sampleStep = Math.max(1, Math.ceil(ds.cases.length / MAX_MODEL_RESPONDENTS));
  const includeHoldout = opt(def, "includeHoldouts", false) as boolean;
  const sets: ChoiceSet[] = [], holdouts: ChoiceSet[] = [];
  const noneCode = String(((design.config as { alternativesPerTask?: number })?.alternativesPerTask ?? Math.max(...rows.map((r) => Number(r.alt) || 0))) + (hasNone ? 1 : 0));
  let respondents = 0, tasksAnswered = 0, noneChosen = 0;
  /* RAW COUNTS (not a model): per level, how often it was shown in an answered estimation task and how often the alternative carrying it was chosen */
  const shownN = new Map<string, number>(), chosenN = new Map<string, number>();
  const lk = (a: string, l: string) => `${a}\u0000${l}`;
  const wOf = (i: number) => (ds.weighted ? ds.cases[i].weight : 1);
  ds.cases.forEach((c, ci) => {
    const ans = c.answers[qid] as Record<string, unknown> | undefined;
    if (!ans || typeof ans !== "object") return;
    const version = String(c.answers[`${qid}_version`] ?? c.vars[`${q?.variableName}_VERSION`] ?? "1");
    let any = false;
    for (const [task, choice] of Object.entries(ans)) {
      if (choice == null || choice === "") continue;
      let alts = altsOf(task, version);
      if (!alts.length) continue;
      alts = [...alts].sort((a, b) => Number(a.alt) - Number(b.alt));
      const chosenIdx = alts.findIndex((r) => String(r.alt) === String(choice));
      if (chosenIdx < 0) continue;
      const isNone = Number(alts[chosenIdx].none_option) === 1 || String(choice) === noneCode && Number(alts[chosenIdx].none_option) === 1;
      if (isNone) noneChosen++;
      /* dual-response None: "would not buy" is the None answer (F4) */
      if (coding.dualDesign && ans[`${task}_buy`] === "no") noneChosen++;
      if (Number(alts[0].is_holdout) !== 1) {
        for (let k = 0; k < alts.length; k++) {
          if (Number(alts[k].none_option) === 1) continue;
          for (const a of attrs) {
            const key = lk(a, String(alts[k][a]));
            shownN.set(key, (shownN.get(key) ?? 0) + wOf(ci));
            if (k === chosenIdx) chosenN.set(key, (chosenN.get(key) ?? 0) + wOf(ci));
          }
        }
      }
      if (ci % sampleStep === 0) {
        const set: ChoiceSet = { alternatives: alts.map(featuresOf), chosen: chosenIdx, weight: wOf(ci) };
        if (Number(alts[0].is_holdout) === 1 && !includeHoldout) holdouts.push(set);
        else if (coding.dual) sets.push(...dualResponseSets(coding, alts, chosenIdx, ans[`${task}_buy`], wOf(ci)));
        else sets.push(set);
      }
      tasksAnswered++; any = true;
    }
    if (any) respondents++;
  });
  if (sets.length < p * 3) return makeResult(def, ds, { tables: [], chart: {}, warnings: [`Only ${sets.length} choice tasks answered — too few to estimate ${p} parameters.`], recommendedCharts: ["attribute_importance"], totalCases });
  const dualWords = coding.dual === "dual" ? "dual-response None coded as a forced choice plus a buy / no-buy task" : coding.dual === "single_none" ? "dual-response None coded as one task with None chosen when they would not buy" : coding.dual === "forced" ? "dual-response design, forced choices only (None not estimated)" : "";
  const fit = conditionalLogit(sets, p);
  // part-worths per level (reference = −Σ others)
  const partWorths = attrs.map((a) => {
    const ls = levels[a];
    const utils = ls.map((l, k) => { if (k === 0) return -idx.filter((e) => e.attr === a).reduce((t, e) => t + fit.beta[e.i], 0); const e = idx.find((e) => e.attr === a && e.level === l)!; return fit.beta[e.i]; });
    const range = Math.max(...utils) - Math.min(...utils);
    return { attribute: a, levels: ls.map((l, k) => { const e = idx.find((x) => x.attr === a && x.level === l); return { level: l, utility: utils[k], se: e ? fit.se[e.i] : null, p: e ? fit.p[e.i] : null }; }), range };
  });
  const totalRange = partWorths.reduce((t, a) => t + a.range, 0) || 1;
  const importance = partWorths.map((a) => ({ attribute: a.attribute, importance: (a.range / totalRange) * 100, range: a.range })).sort((x, y) => y.importance - x.importance);
  // holdout hit rate
  let holdoutHits = 0;
  for (const h of holdouts) { const u = h.alternatives.map((x) => x.reduce((t, v, i) => t + v * fit.beta[i], 0)); if (u.indexOf(Math.max(...u)) === h.chosen) holdoutHits++; }
  // simulation: options.scenario = [{name, levels:{attr: level}}]; default = best vs worst vs none
  const scenario = (opt(def, "scenario", []) as { name: string; levels: Record<string, string> }[]);
  const utilityOf = (lv: Record<string, string>) => attrs.reduce((t, a) => { const pw = partWorths.find((x) => x.attribute === a)!; const l = pw.levels.find((x) => x.level === lv[a]) ?? pw.levels[0]; return t + l.utility; }, 0);
  const profiles = scenario.length ? scenario : [
    { name: "Best profile", levels: Object.fromEntries(partWorths.map((a) => [a.attribute, a.levels.reduce((b, l) => (l.utility > b.utility ? l : b)).level])) },
    { name: "Worst profile", levels: Object.fromEntries(partWorths.map((a) => [a.attribute, a.levels.reduce((b, l) => (l.utility < b.utility ? l : b)).level])) },
  ];
  const simUtils = profiles.map((pr) => utilityOf(pr.levels));
  if (hasNone && noneIdx >= 0) simUtils.push(fit.beta[noneIdx]);
  const shares = logitShares(simUtils);
  const simRows = profiles.map((pr, i) => ({ profile: pr.name, description: attrs.map((a) => `${a}: ${pr.levels[a] ?? partWorths.find((x) => x.attribute === a)!.levels[0].level}`).join("; "), utility: round(simUtils[i], 3), share: pct(shares[i] * 100) }));
  if (hasNone && noneIdx >= 0) simRows.push({ profile: "None", description: "No purchase", utility: round(fit.beta[noneIdx], 3), share: pct(shares[shares.length - 1] * 100) });
  // willingness to pay: if a price attribute with numeric levels exists
  const priceAttr = (opt(def, "priceAttribute", null) as string | null) ?? attrs.find((a) => /price|cost|fee/i.test(a) && levels[a].every((l) => Number.isFinite(parseFloat(l.replace(/[^0-9.-]/g, "")))));
  let wtp: { attribute: string; level: string; wtp: number }[] = [];
  if (priceAttr) {
    const pw = partWorths.find((x) => x.attribute === priceAttr)!;
    const pts = pw.levels.map((l) => ({ price: parseFloat(l.level.replace(/[^0-9.-]/g, "")), u: l.utility })).sort((a, b) => a.price - b.price);
    // utility per currency unit via least squares on the price levels
    const mx = pts.reduce((t, x) => t + x.price, 0) / pts.length, mu = pts.reduce((t, x) => t + x.u, 0) / pts.length;
    const slope = pts.reduce((t, x) => t + (x.price - mx) * (x.u - mu), 0) / (pts.reduce((t, x) => t + (x.price - mx) ** 2, 0) || 1);
    if (slope < 0) wtp = partWorths.filter((a) => a.attribute !== priceAttr).flatMap((a) => a.levels.map((l) => ({ attribute: a.attribute, level: l.level, wtp: (l.utility - a.levels[0].utility) / -slope })));
  }
  const tables: ResultTable[] = [
    { id: "importance", title: "Attribute importance", columns: [{ key: "attribute", label: "Attribute" }, { key: "importance", label: "Relative importance %", type: "pct", decimals: 1 }, { key: "range", label: "Utility range", type: "number", decimals: 3 }], rows: importance.map((a) => ({ ...a, importance: pct(a.importance), range: round(a.range, 3) })), base: { n: respondents, label: `${respondents} respondents, ${sets.length} choice tasks` } },
    { id: "partworths", title: "Part-worth utilities — aggregate multinomial logit (effects-coded, zero-centred)", notes: ["One set of utilities for the whole sample (pooled conditional logit, Newton–Raphson). Not individual-level: no hierarchical Bayes or latent-class model is estimated here — the Hierarchical Bayes analysis (Advanced models) estimates individual utilities from the same answers."], columns: [{ key: "attribute", label: "Attribute" }, { key: "level", label: "Level" }, { key: "utility", label: "Utility", type: "number", decimals: 3 }, { key: "se", label: "SE", type: "number", decimals: 3 }, { key: "p", label: "p-value" }], rows: partWorths.flatMap((a) => a.levels.map((l) => ({ attribute: a.attribute, level: l.level, utility: round(l.utility, 3), se: round(l.se, 3), p: l.p == null ? "(reference)" : fmtP(l.p) }))) },
    { id: "fit", title: "Model fit", columns: [{ key: "m", label: "Statistic" }, { key: "v", label: "Value" }], rows: [{ m: "Respondents", v: respondents }, { m: "Choice tasks", v: sets.length }, { m: "Log-likelihood", v: round(fit.logLikelihood, 2) }, { m: "Null log-likelihood", v: round(fit.nullLogLikelihood, 2) }, { m: "McFadden R²", v: round(fit.mcFaddenR2, 3) }, { m: "In-sample hit rate", v: fmtPct(fit.hitRate * 100, 1) }, ...(holdouts.length ? [{ m: `Holdout hit rate (${holdouts.length} tasks)`, v: fmtPct((holdoutHits / holdouts.length) * 100, 1) }] : []), ...(hasNone ? [{ m: "“None” chosen", v: fmtPct(tasksAnswered ? (noneChosen / tasksAnswered) * 100 : 0, 1) }] : []), { m: "Converged", v: fit.converged ? "yes" : "no" }, { m: "Model", v: `Aggregate multinomial logit, effects-coded${hasNone ? ", None constant" : ""}${dualWords ? ` (${dualWords})` : ""}, ${fit.iterations} Newton–Raphson iterations` }] },
    { id: "simulation", title: "Share-of-preference simulation (from the aggregate logit)", columns: [{ key: "profile", label: "Profile" }, { key: "description", label: "Levels" }, { key: "utility", label: "Total utility", type: "number", decimals: 3 }, { key: "share", label: "Preference share %", type: "pct", decimals: 1 }], rows: simRows, notes: ["Shares follow the logit rule over the listed profiles" + (hasNone ? " plus the none option." : ".")] },
  ];
  if (wtp.length) tables.push({ id: "wtp", title: `Willingness to pay (vs. reference level, in ${priceAttr} units)`, columns: [{ key: "attribute", label: "Attribute" }, { key: "level", label: "Level" }, { key: "wtp", label: "WTP", type: "number", decimals: 2 }], rows: wtp.map((x) => ({ ...x, wtp: round(x.wtp, 2) })) });
  // raw counts last, so the model's tables keep their places (importance, part-worths, fit, simulation)
  const countsAt = tables.length;
  tables.push({ id: "counts", title: "Counts — choice share of each level (raw, not a model)", columns: [{ key: "attribute", label: "Attribute" }, { key: "level", label: "Level" }, { key: "shown", label: "Times shown", type: "number", decimals: 0 }, { key: "chosen", label: "Times chosen", type: "number", decimals: 0 }, { key: "share", label: "Chosen when shown %", type: "pct", decimals: 1 }], rows: attrs.flatMap((a) => levels[a].map((l) => { const sh = shownN.get(lk(a, l)) ?? 0, ch = chosenN.get(lk(a, l)) ?? 0; return { attribute: a, level: l, shown: round(sh, 0), chosen: round(ch, 0), share: pct(sh ? (ch / sh) * 100 : 0) }; })), notes: ["Counts are descriptive: a level's share also reflects the levels it happened to be shown with. The part-worths table is the estimated model."] });
  void countsAt;
  const insights = [`${importance[0].attribute} is the most important attribute (${fmtPct(importance[0].importance, 0)} of total utility range)${importance.length > 1 ? `, followed by ${importance[1].attribute} (${fmtPct(importance[1].importance, 0)})` : ""}; ${importance[importance.length - 1].attribute} matters least (${fmtPct(importance[importance.length - 1].importance, 0)}).`];
  /*
   * THE MARKET SIMULATOR (F4 2026-10-22) — only when asked (options.simulator) or when scenarios are saved on the design
   * (simulate_conjoint), appended after the counts, so an existing analysis's tables are exactly what they were.
   */
  const simSpecs = scenariosFor(def.options, design.config as Record<string, unknown>);
  const simWarnings: string[] = [];
  if (simSpecs.length) {
    const model = cbcUtilityModel(partWorths.map((a) => ({ name: a.attribute, levels: a.levels.map((l) => l.level), utils: a.levels.map((l) => l.utility) })), hasNone && noneIdx >= 0 ? fit.beta[noneIdx] : undefined, priceAttr ?? undefined, "aggregate multinomial logit");
    for (const [k, sp] of simSpecs.entries()) { const st = simulatorTables(model, sp, ds, { idPrefix: k ? `sim${k + 1}` : "sim" }); tables.push(...st.tables); insights.push(...st.insights); simWarnings.push(...st.warnings); }
  }
  for (const a of partWorths.slice(0, 3)) { const best = a.levels.reduce((b, l) => (l.utility > b.utility ? l : b)); insights.push(`Preferred ${a.attribute}: ${best.level} (utility ${fmtNum(best.utility, 2)}).`); }
  insights.push(`Model fit: McFadden R² ${fmtNum(fit.mcFaddenR2, 2)}, hit rate ${fmtPct(fit.hitRate * 100, 0)}${holdouts.length ? `, holdout hit rate ${fmtPct((holdoutHits / holdouts.length) * 100, 0)}` : ""}.`);
  return makeResult(def, ds, {
    tables, chart: { categories: importance.map((a) => a.attribute), series: [{ name: "Importance %", values: importance.map((a) => pct(a.importance)) }], tree: partWorths.map((a) => ({ name: a.attribute, children: a.levels.map((l) => ({ name: l.level, value: round(l.utility, 3) ?? 0 })) })), kpis: [{ label: "Respondents", value: respondents }, { label: "McFadden R²", value: round(fit.mcFaddenR2, 2) ?? 0 }, { label: "Hit rate", value: round(fit.hitRate * 100, 0) ?? 0, unit: "%" }], valueFormat: "pct" },
    insights, warnings: [...(sampleStep > 1 ? [samplingWarning(respondents, sampleStep)] : []), ...(fit.converged ? [] : ["The choice model did not fully converge — utilities are approximate."]), ...simWarnings], recommendedCharts: ["attribute_importance", "part_worth", "utility_by_level", "preference_share", "wtp"], variablesUsed: [q?.variableName ?? qid], baseLabel: `${respondents} respondents`, totalCases,
  });
}

/** a CBC utility model for the simulator: one respondent (the aggregate) or many (HB individual means) — F4 */
export function cbcUtilityModel(attributes: { name: string; levels: string[]; utils: number[] }[], none: number | undefined, priceAttribute: string | undefined, source: string, individuals?: { id: string; levels: Record<string, number[]>; none?: number }[]): UtilityModel {
  const price = priceAttribute && attributes.find((a) => a.name === priceAttribute);
  const values = price ? numericValues(price.levels) : undefined;
  return {
    kind: "choice", source,
    attributes: attributes.map((a) => ({ name: a.name, levels: a.levels, ...(a === price && values ? { values } : {}) })),
    ...(price && values ? { priceAttribute: price.name } : {}),
    respondents: individuals ?? [{ id: "aggregate", levels: Object.fromEntries(attributes.map((a) => [a.name, a.utils])), ...(none != null ? { none } : {}) }],
  };
}

/**
 * MENU-BASED CONJOINT — counts, said to be counts (conjoint audit 2026-10-17).
 *
 * A menu answer is a set of ticked items per task, not one alternative, so
 * the CBC model cannot read it (it used to report "Only 0 choice tasks
 * answered"). No menu choice model (per-item binary logits on own and cross
 * prices) is estimated on this platform; what is honest and useful is the
 * take rate of each item at each price it was shown at.
 */
function menuCounts(def: AnalysisDefinition, ds: Dataset, totalCases: number, qid: string): AnalysisResult {
  const { q, rows } = designFor(ds, qid);
  const byTask = designIndex(rows);
  const shown = new Map<string, number>(), taken = new Map<string, number>();
  const items = new Map<string, string>();
  const prices = new Map<string, string[]>();
  for (const r of rows) {
    const it = String(r.item);
    items.set(it, String(r.item_label ?? it));
    const ps = prices.get(it) ?? prices.set(it, []).get(it)!;
    if (!ps.includes(String(r.price))) ps.push(String(r.price));
  }
  let respondents = 0, tasks = 0, none = 0;
  ds.cases.forEach((c) => {
    const ans = c.answers[qid] as Record<string, unknown> | undefined;
    if (!ans || typeof ans !== "object") return;
    const version = String(c.vars[`${q?.variableName}_VERSION`] ?? "1");
    let any = false;
    for (const [task, v] of Object.entries(ans)) {
      if (!Array.isArray(v)) continue;
      const chosen = v.map(String);
      const w = ds.weighted ? c.weight : 1;
      tasks++; any = true;
      if (chosen.includes("none")) none += 1;
      for (const r of byTask(task, version)) {
        const key = `${r.item}\u0000${r.price}`;
        shown.set(key, (shown.get(key) ?? 0) + w);
        if (!chosen.includes("none") && (Number(r.required) === 1 || chosen.includes(String(r.item)))) taken.set(key, (taken.get(key) ?? 0) + w);
      }
    }
    if (any) respondents++;
  });
  const tableRows = [...items.entries()].flatMap(([it, label]) => (prices.get(it) ?? []).map((pr) => {
    const sh = shown.get(`${it}\u0000${pr}`) ?? 0, tk = taken.get(`${it}\u0000${pr}`) ?? 0;
    return { item: label, price: pr, shown: round(sh, 0), taken: round(tk, 0), rate: pct(sh ? (tk / sh) * 100 : 0) };
  }));
  /* F4 2026-10-22: the menu choice model and simulator follow the counts table (which keeps its place and numbers) */
  const mt = menuTasks(ds, qid);
  const model = mt ? menuModelTables(def, ds, mt) : { tables: [], insights: [], warnings: [] };
  return makeResult(def, ds, {
    tables: [{ id: "menu_counts", title: "Menu-based conjoint — take rate by item and price (counts, not a model)", columns: [{ key: "item", label: "Item" }, { key: "price", label: "Price" }, { key: "shown", label: "Times offered", type: "number", decimals: 0 }, { key: "taken", label: "Times chosen", type: "number", decimals: 0 }, { key: "rate", label: "Take rate %", type: "pct", decimals: 1 }], rows: tableRows, base: { n: respondents, label: `${respondents} respondents, ${tasks} menu tasks` }, notes: ["Raw counts. Required (base) items count as chosen whenever the respondent did not choose None."] }, ...model.tables],
    chart: { categories: tableRows.map((r) => `${r.item} @ ${r.price}`), series: [{ name: "Take rate %", values: tableRows.map((r) => r.rate) }], valueFormat: "pct" },
    insights: [...(tasks ? [`“None” was chosen in ${fmtPct((none / tasks) * 100, 1)} of menu tasks.`] : []), ...model.insights],
    warnings: [...(model.tables.length ? [] : ["Menu-based conjoint: these are take-rate counts — the choice model needs more answered menus (see below)."]), ...model.warnings],
    recommendedCharts: ["bar_horizontal"], variablesUsed: [q?.variableName ?? qid], baseLabel: `${respondents} respondents`, totalCases,
  });
}

/* ============================================================ maxdiff */

export function maxdiff(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const qid = questionIdFor(ds, def.variables[0] ?? "", "maxdiff_task");
  if (!qid) return makeResult(def, ds, { tables: [], chart: {}, warnings: ["No MaxDiff task question found in this survey."], recommendedCharts: ["maxdiff_utility"], totalCases });
  const { q, design, rows } = designFor(ds, qid);
  if (!design || !rows.length) return makeResult(def, ds, { tables: [], chart: {}, warnings: ["The MaxDiff design file has not been generated."], recommendedCharts: ["maxdiff_utility"], totalCases });
  const items = [...new Map(rows.map((r) => [String(r.item_index), String(r.item_label ?? r.item_index)])).entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
  const itemIdx = new Map(items.map(([code], i) => [code, i]));
  const K = items.length;
  const best = new Array(K).fill(0), worst = new Array(K).fill(0), shown = new Array(K).fill(0);
  const sets: ChoiceSet[] = [];
  const scratch: ChoiceSet[] = [];
  const altsOf = designIndex(rows);
  const sampleStep = Math.max(1, Math.ceil(ds.cases.length / MAX_MODEL_RESPONDENTS));
  const perCase: { ci: number; score: number[] }[] = [];
  let respondents = 0;
  /* tasks skipped because the answer could not be modelled (METHOD-03) */
  let sameItem = 0, outsideSet = 0;
  /*
   * ANCHORED (DUAL-RESPONSE) MAXDIFF (§17), AND WHY IT CHANGES THE CODING.
   *
   * Standard best-worst utilities are RELATIVE. They say how items rank
   * against each other and cannot say whether any of them matter at all: an
   * item can lead the ranking in a list where nothing is important. That is
   * the known limitation of the method, and the dual-response follow-up
   * ("all / some / none of these are important") is the standard answer to it.
   *
   * The follow-up fixes an absolute zero, which the model can only use if the
   * scale is free to move — and the standard coding here does not allow that.
   * Effects coding (last item = all −1) CONSTRAINS the utilities to sum to
   * zero: it is a zero-CENTRED scale by construction, so an anchor at zero
   * would be fighting the parameterisation rather than informing it, and the
   * result would look like anchoring while meaning nothing.
   *
   * So an anchored design is estimated with a free parameter per item and the
   * ANCHOR as the reference alternative — all-zero features, utility zero by
   * definition. A positive utility then means "above the threshold this
   * respondent described", which is a statement about the item and not about
   * its neighbours. Both scales are reported: the absolute one, and a
   * zero-centred one so an anchored study is still comparable with a standard
   * one.
   */
  const anchored = (design.config as { anchored?: boolean } | undefined)?.anchored === true;
  /* MD-P1: practice tasks (rows with practice = 1) are answered but are not part of the experiment */
  const practiceTasks = new Set(rows.filter((r) => Number(r.practice) === 1).map((r) => String(r.task)));
  const bestOnly = (design.config as { responseMode?: string } | undefined)?.responseMode === "best_only";
  const P = anchored ? K : K - 1;
  const anchorCounts: Record<string, number> = { all: 0, some: 0, none: 0 };
  let anchorObservations = 0;
  /*
   * Anchored: a plain dummy per item (the anchor is the reference).
   * Standard:  effects coding, last item as reference — unchanged, so every
   *            existing MaxDiff analysis produces exactly the numbers it did.
   */
  const feat = anchored
    ? (i: number) => { const x = new Array(P).fill(0); x[i] = 1; return x; }
    : (i: number) => { const x = new Array(P).fill(0); if (i === K - 1) x.fill(-1); else x[i] = 1; return x; };
  const anchorFeat = () => new Array(P).fill(0);
  ds.cases.forEach((c, ci) => {
    const ans = c.answers[qid] as Record<string, { best?: string; worst?: string; anchor?: string }> | undefined;
    if (!ans || typeof ans !== "object") return;
    /* the block this respondent answered: flatten writes `<VAR>_VERSION` from the seed — the same fallback the conjoint runner uses. Without it every respondent was scored against version 1's item sets (METHOD-02). */
    const version = String(c.answers[`${qid}_version`] ?? c.vars[`${q?.variableName}_VERSION`] ?? "1");
    const w = ds.weighted ? c.weight : 1;
    const score = new Array(K).fill(0);
    let any = false;
    /* every respondent is counted; only every k-th goes into the model fit, so a very large study still finishes (audit F-3) */
    scratch.length = 0;
    const target = ci % sampleStep === 0 ? sets : scratch;
    for (const [task, bw] of Object.entries(ans)) {
      if (!bw || typeof bw !== "object") continue;
      if (practiceTasks.has(task)) continue;
      const alts = altsOf(task, version);
      const ids = alts.map((r) => itemIdx.get(String(r.item_index))!).filter((x) => x != null);
      if (ids.length < 2) continue;
      const b = bw.best != null ? itemIdx.get(String(bw.best)) : undefined, wo = bw.worst != null ? itemIdx.get(String(bw.worst)) : undefined;
      /*
       * A task answered with the same item as best and worst says nothing about
       * the item and used to take the whole analysis down: the worst set
       * excluded the best, `chosen` became −1, and the logit threw. It is
       * skipped and counted (METHOD-03). A code outside the task's set is
       * likewise skipped and counted rather than silently dropped.
       */
      if (b != null && wo != null && b === wo) { sameItem++; continue; }
      const given = (v: unknown) => v != null && v !== "";
      if ((given(bw.best) && (b == null || !ids.includes(b))) || (given(bw.worst) && (wo == null || !ids.includes(wo)))) { outsideSet++; continue; }
      for (const i of ids) shown[i] += w;
      if (b != null && ids.includes(b)) { best[b] += w; score[b] += 1; target.push({ alternatives: ids.map(feat), chosen: ids.indexOf(b), weight: w }); any = true; }
      if (wo != null && ids.includes(wo)) { worst[wo] += w; score[wo] -= 1; const rest = ids.filter((i) => i !== b); if (rest.length >= 2) target.push({ alternatives: rest.map((i) => feat(i).map((v) => -v)), chosen: rest.indexOf(wo), weight: w }); any = true; }
      if (anchored && typeof bw.anchor === "string" && bw.anchor in anchorCounts) {
        anchorCounts[bw.anchor] += w;
        /*
         * One binary comparison per constraint — the item against the anchor.
         * `chosen: 0` is the item winning, `chosen: 1` is the anchor winning.
         */
        const versus = (i: number, itemWins: boolean) =>
          target.push({ alternatives: [feat(i), anchorFeat()], chosen: itemWins ? 0 : 1, weight: w });
        if (bw.anchor === "all") { for (const i of ids) versus(i, true); anchorObservations += ids.length; }
        else if (bw.anchor === "none") { for (const i of ids) versus(i, false); anchorObservations += ids.length; }
        else {
          /*
           * "Some" tells us about the two ends and nothing about the middle.
           * Constraining the rest would be putting words in the respondent's
           * mouth, and it is the modal answer — so getting this restraint
           * right matters more than the other two branches.
           */
          if (b != null) { versus(b, true); anchorObservations++; }
          if (wo != null) { versus(wo, false); anchorObservations++; }
        }
        any = true;
      }
    }
    if (any) { respondents++; perCase.push({ ci, score }); }
  });
  if (!sets.length) return makeResult(def, ds, { tables: [], chart: {}, warnings: ["No MaxDiff choices recorded yet."], recommendedCharts: ["maxdiff_utility"], totalCases });
  const fit = conditionalLogit(sets, P);
  /*
   * Anchored: the coefficient IS the utility, measured against the anchor.
   * Standard: the reference item's utility is minus the sum of the rest,
   *           which is what effects coding means.
   */
  const util = anchored
    ? items.map((_, i) => fit.beta[i])
    : items.map((_, i) => (i === K - 1 ? -fit.beta.reduce((t, v) => t + v, 0) : fit.beta[i]));
  /* the zero-centred view, so an anchored study still compares with a standard one */
  const utilMean = util.reduce((t, v) => t + v, 0) / Math.max(K, 1);
  const centred = util.map((u) => u - utilMean);
  // rescaled probability scores (0–100 summing to 100): exp(u)/(exp(u)+k−1) normalised
  const kPer = rows.filter((r) => String(r.task) === String(rows[0].task) && String(r.version ?? "1") === String(rows[0].version ?? "1")).length || 4;
  const prob = util.map((u) => Math.exp(u) / (Math.exp(u) + kPer - 1));
  const probSum = prob.reduce((t, v) => t + v, 0) || 1;
  const table = items.map(([code, label], i) => ({ code, item: label, best: round(best[i], 0), worst: round(worst[i], 0), shown: round(shown[i], 0), bw: shown[i] ? ((best[i] - worst[i]) / shown[i]) * 100 : 0, utility: util[i], centred: centred[i], se: i < P ? fit.se[i] : null, share: (prob[i] / probSum) * 100, /* above the threshold the respondents described — only meaningful on an anchored design */ aboveAnchor: anchored ? util[i] > 0 : null })).sort((a, b) => b.utility - a.utility);
  const maxShare = Math.max(...table.map((t) => t.share));
  const rowsOut = table.map((t, r) => ({ rank: r + 1, item: t.item, best: t.best, worst: t.worst, shown: t.shown, bw: pct(t.bw), utility: round(t.utility, 3), se: round(t.se, 3), share: pct(t.share), relative: pct((t.share / maxShare) * 100), ...(anchored ? { centred: round(t.centred, 3), important: t.aboveAnchor ? "yes" : "no" } : {}) }));
  const tables: ResultTable[] = [
    { id: "maxdiff", title: "MaxDiff item scores", columns: [{ key: "rank", label: "Rank" }, { key: "item", label: "Item" }, { key: "shown", label: "Times shown", type: "number", decimals: 0 }, { key: "best", label: "Best", type: "number", decimals: 0 }, { key: "worst", label: "Worst", type: "number", decimals: 0 }, { key: "bw", label: "B−W score %", type: "number", decimals: 1 }, { key: "utility", label: "Logit utility", type: "number", decimals: 3 }, { key: "se", label: "SE", type: "number", decimals: 3 }, { key: "share", label: "Preference share %", type: "pct", decimals: 1 }, { key: "relative", label: "Relative to top %", type: "pct", decimals: 1 }, ...(anchored ? [{ key: "centred", label: "Zero-centred utility", type: "number" as const, decimals: 3 }, { key: "important", label: "Above the anchor" }] : [])], rows: rowsOut, base: { n: respondents, label: `${respondents} respondents, ${sets.length} choices` }, notes: anchored ? ["“B−W score %” is a descriptive count, not a model estimate; the utilities come from the pooled logit model below.", "Utilities from an aggregate conditional logit against the ANCHOR, whose utility is zero by definition — so a positive utility means the item is important in absolute terms, not merely more important than the rest of the list.", "Zero-centred utilities are also shown, for comparison with a standard (unanchored) MaxDiff.", "Preference share = rescaled choice probability summing to 100."] : [bestOnly ? "Utilities from an aggregate (pooled) conditional logit on the best choices, zero-centred. Preference share = rescaled choice probability summing to 100." : "Utilities from an aggregate (pooled) conditional logit (best choices plus worst choices with reversed sign — the sequential best-worst model), zero-centred. Preference share = rescaled choice probability summing to 100.",
      "“B−W score %” is a descriptive COUNT — (times best − times worst) / times shown — not a model estimate; it is shown beside the logit utilities, which account for which items each one was shown with. The model is pooled across respondents: individual-level (HB) utilities are not estimated here — the Hierarchical Bayes analysis (Advanced models) estimates them.", "This scale is RELATIVE: it ranks the items against each other and cannot say whether any of them matter. Generate the design as anchored (dual-response) if that question matters."] },
    { id: "fit", title: "Model fit", columns: [{ key: "m", label: "Statistic" }, { key: "v", label: "Value" }], rows: [{ m: "Respondents", v: respondents }, { m: "Choices modelled", v: sets.length }, { m: "McFadden R²", v: round(fit.mcFaddenR2, 3) }, { m: "Hit rate", v: fmtPct(fit.hitRate * 100, 1) }, { m: "Converged", v: fit.converged ? "yes" : "no" }, ...(anchored ? [{ m: "Anchor observations", v: anchorObservations }, { m: "“All important”", v: round(anchorCounts.all, 0) }, { m: "“Some important”", v: round(anchorCounts.some, 0) }, { m: "“None important”", v: round(anchorCounts.none, 0) }] : [])] },
  ];
  // by segment variable: mean B−W count score per group
  const by = opt(def, "by", def.columns?.[0] ?? null) as string | null;
  const chartMatrix: { rows: string[]; columns: string[]; values: (number | null)[][] } | undefined = (() => {
    if (!by || !ds.byName.has(by)) return undefined;
    const cats = categoriesOf(ds, by), col = categoricalColumn(ds, by);
    const vals = table.map((t) => cats.map((c) => { const pc = perCase.filter((p) => { const x = col[p.ci]; return Array.isArray(x) ? x.includes(c.code) : x === c.code; }); const i = itemIdx.get(t.code)!; return pc.length ? round((pc.reduce((s, p) => s + p.score[i], 0) / pc.length) * 100 / Math.max(1, shown[i] / respondents), 1) : null; }));
    tables.push({ id: "by", title: `Best−worst score by ${labelOf(ds, by)}`, columns: [{ key: "item", label: "Item" }, ...cats.map((c, j) => ({ key: `c${j}`, label: c.label, type: "number" as const, decimals: 1 }))], rows: table.map((t, i) => ({ item: t.item, ...Object.fromEntries(cats.map((_, j) => [`c${j}`, vals[i][j]])) })) });
    return { rows: table.map((t) => t.item), columns: cats.map((c) => c.label), values: vals };
  })();
  const insights = [`“${table[0].item}” is the most preferred item (preference share ${fmtPct(table[0].share, 1)}, best−worst ${fmtNum(table[0].bw, 0)}); “${table[K - 1].item}” is least preferred (${fmtPct(table[K - 1].share, 1)}).`, `The top item is ${fmtNum(table[0].share / Math.max(table[K - 1].share, 0.01), 1)}× as likely to be chosen as the bottom item.`];
  const top3 = table.slice(0, 3).reduce((t, x) => t + x.share, 0);
  insights.push(`The top three items account for ${fmtPct(top3, 0)} of total preference.`);
  if (anchored) {
    const above = table.filter((t) => t.aboveAnchor).length;
    /*
     * The sentence a standard MaxDiff cannot produce, and the reason to run
     * an anchored one: how much of the list is worth anything at all.
     */
    insights.push(
      above === 0
        ? "NONE of the items clears the anchor: respondents ranked them against each other but did not consider any of them important."
        : above === K
          ? "Every item clears the anchor — respondents considered all of them important, so the ranking is between good options."
          : `${above} of ${K} items clear the anchor. The remaining ${K - above} rank where they rank but were not considered important.`,
    );
  }
  return makeResult(def, ds, {
    tables, chart: { categories: table.map((t) => t.item), series: [{ name: "Preference share %", values: table.map((t) => pct(t.share)) }, { name: "Best %", values: table.map((t) => pct(t.shown ? (best[itemIdx.get(t.code)!] / t.shown) * 100 : 0)) }, { name: "Worst %", values: table.map((t) => pct(t.shown ? (-worst[itemIdx.get(t.code)!] / t.shown) * 100 : 0)) }], matrix: chartMatrix, kpis: [{ label: "Respondents", value: respondents }, { label: "Top item", value: table[0].item }], valueFormat: "pct" },
    insights, warnings: [
      ...(sampleStep > 1 ? [samplingWarning(respondents, sampleStep)] : []),
      ...(fit.converged ? [] : ["The choice model did not fully converge — utilities are approximate."]),
      ...(sameItem ? [`${sameItem} task${sameItem === 1 ? "" : "s"} ignored: best and worst were the same item.`] : []),
      ...(outsideSet ? [`${outsideSet} task${outsideSet === 1 ? "" : "s"} ignored: the best or worst was not an item of that task.`] : []),
      /*
       * An anchored design whose follow-up was never answered would silently
       * produce an absolute-looking scale identified by nothing. Say so.
       */
      ...(anchored && anchorObservations === 0
        ? ["This design is anchored but no anchor answers were recorded, so the utilities below are not anchored to anything. Check that the follow-up is being asked and saved."]
        : []),
    ], recommendedCharts: ["maxdiff_utility", "maxdiff_best_worst", "maxdiff_preference", "bar_horizontal", "maxdiff_heatmap"], variablesUsed: [q?.variableName ?? qid], baseLabel: `${respondents} respondents`, totalCases,
  });
}
