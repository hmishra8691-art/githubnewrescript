/**
 * ADVANCED MODELS IN DATA ANALYTICS (§8): hierarchical Bayes for CBC / MaxDiff
 * (`hb`), latent class analysis (`lca`) and structural equation modelling
 * (`sem`). Each runner turns the dataset into the model's validated input,
 * calls the estimator in `../models`, and turns the envelope into tables.
 *
 * The rule every runner keeps: a model that did not converge, is not
 * identified or reached an improper solution shows its diagnostics and the
 * reason, never coefficients or fit indices as if valid — and never a silent
 * fallback to a simpler model (HB never quietly becomes the aggregate logit;
 * the aggregate is shown beside it, labelled, for comparison only).
 *
 * HB runs in chunks: `hbJobStart` / `hbJobContinue` advance a serialisable
 * chain state within a time budget (the Studio persists it between requests,
 * migration 0066); the synchronous `hb` runner finishes small runs in one go
 * and otherwise says how long the run needs instead of returning a partial one.
 */
import type { AnalysisDefinition, AnalysisResult, ResultTable, ChartData } from "../types.js";
import { categoricalColumn, categoriesOf, labelOf, numericColumn, type Dataset } from "../dataset.js";
import { conditionalLogit, logitShares, type ChoiceSet } from "../stats/choice.js";
import { cbcRespondentSets, choiceQuestionFor, maxdiffRespondentSets } from "./choice.js";
import { expandBattery } from "./basics.js";
import { fmtNum, fmtP, fmtPct, makeResult, opt, pct, refused, round } from "./common.js";
import { effectsPriorShape, hbAdvance, hbDone, hbInit, hbSummarise, resolveHbOptions, type HbData, type HbOptions, type HbOutput, type HbState } from "../models/hb.js";
import { latentClass, type LcaFit } from "../models/lca.js";
import { fitSem, type SemEstimate } from "../models/sem.js";
import { MODELS_VERSION, intOpt, nowMs } from "../models/spec.js";

const r3 = (x: number | null | undefined) => round(x, 3);

/* ================================================================== HB */

interface HbPrep {
  kind: "cbc" | "maxdiff";
  qid: string;
  variable: string;
  data: HbData;
  /** for each reported quantity: attribute (null for None / MaxDiff items) and level label */
  attr: (string | null)[];
  level: string[];
  attrs: string[];
  sets: ChoiceSet[];
  respondents: number;
  holdoutTasks: number;
  warnings: string[];
}

function prepareHb(def: AnalysisDefinition, ds: Dataset): HbPrep | { refuse: string } {
  const name = def.variables[0] ?? "";
  const q = choiceQuestionFor(ds, name);
  if (!q) return { refuse: "Hierarchical Bayes needs a CBC (conjoint_task) or MaxDiff question — none was found in this survey." };
  if (q.type !== "conjoint_task" && q.type !== "maxdiff_task") return { refuse: q.type === "acbc_task" ? "Adaptive CBC is not estimated here: its screening and tournament stages need an ACBC-specific HB model. The transcripts are exported for an external estimator." : `Hierarchical Bayes needs a CBC or MaxDiff question; ${name} is a ${q.type} question.` };
  const qrow = ds.def.questions.find((x) => x.id === q.id);
  const variable = qrow?.variableName ?? q.id;
  const toData = (resp: { id: string; sets: ChoiceSet[] }[], p: number, transform: { names: string[]; rows: number[][] }): HbData => ({
    p, paramNames: transform.names.slice(0, p), transform,
    respondents: resp.map((r) => ({ id: r.id, X: Float64Array.from(r.sets.flatMap((s) => s.alternatives.flat())), taskSizes: Int32Array.from(r.sets.map((s) => s.alternatives.length)), chosen: Int32Array.from(r.sets.map((s) => s.chosen)) })),
  });
  if (q.type === "conjoint_task") {
    const s = cbcRespondentSets(ds, q.id, { includeHoldouts: opt(def, "includeHoldouts", false) as boolean });
    if (!s) return { refuse: "The conjoint design file has not been generated (or the question is a menu-based exercise, which has no choice model here)." };
    const lr = s.coding.levelRows();
    const data = toData(s.respondents, s.coding.p, { names: lr.names, rows: lr.rows });
    data.priorShape = effectsPriorShape(s.coding.p, s.coding.attrs.map((a) => s.coding.idx.filter((e) => e.attr === a).map((e) => e.i)));
    return { kind: "cbc", qid: q.id, variable, data, attr: lr.attr, level: lr.level, attrs: s.coding.attrs, sets: s.respondents.flatMap((r) => r.sets), respondents: s.respondents.length, holdoutTasks: s.holdoutTasks, warnings: [] };
  }
  const m = maxdiffRespondentSets(ds, q.id);
  if (!m) return { refuse: "The MaxDiff design file has not been generated." };
  if (m.unsupported) return { refuse: m.unsupported };
  const md = m as Exclude<typeof m, { unsupported: string }>;
  const data = toData(md.respondents, md.p, { names: md.items.map((i) => i.label), rows: md.levelRows });
  data.priorShape = effectsPriorShape(md.p, [Array.from({ length: md.p }, (_, i) => i)]);
  return { kind: "maxdiff", qid: q.id, variable, data, attr: md.items.map(() => null), level: md.items.map((i) => i.label), attrs: [], sets: md.respondents.flatMap((r) => r.sets), respondents: md.respondents.length, holdoutTasks: 0, warnings: [] };
}

function hbRefusal(def: AnalysisDefinition, ds: Dataset, totalCases: number, prep: HbPrep | { refuse: string }): AnalysisResult | null {
  if ("refuse" in prep) return refused(def, ds, totalCases, prep.refuse, ["attribute_importance"]);
  const minResp = 20;
  if (prep.respondents < minResp) return refused(def, ds, totalCases, `Hierarchical Bayes needs choices from at least ${minResp} respondents to estimate the population distribution — ${prep.respondents} answered. Use the aggregate ${prep.kind === "cbc" ? "conjoint" : "MaxDiff"} analysis until more data is in.`, ["attribute_importance"]);
  if (prep.sets.length < prep.data.p * 3) return refused(def, ds, totalCases, `Only ${prep.sets.length} choice tasks answered — too few to estimate ${prep.data.p} parameters.`, ["attribute_importance"]);
  return null;
}

export const hbOptionsOf = (def: AnalysisDefinition): HbOptions => resolveHbOptions({
  chains: opt(def, "chains", undefined), burnIn: opt(def, "burnIn", undefined), draws: opt(def, "draws", undefined), thin: opt(def, "thin", undefined),
  seed: opt(def, "seed", undefined), priorVariance: opt(def, "priorVariance", undefined), priorDf: opt(def, "priorDf", undefined), targetAcceptance: opt(def, "targetAcceptance", undefined),
});

/** the result tables for a finished chain state */
export function hbResultFromState(def: AnalysisDefinition, ds: Dataset, totalCases: number, prep: HbPrep, state: HbState): AnalysisResult {
  const out: HbOutput = hbSummarise(state, prep.data);
  const o = out.options;
  const L = out.names.length;
  const warnings: string[] = [...prep.warnings];
  for (const d of out.diagnostics) if (d.severity !== "info") warnings.push(d.message);
  const diagRows: { m: string; v: string | number | null }[] = [
    { m: "Model", v: `Hierarchical Bayes multinomial logit (${prep.kind === "cbc" ? "CBC, effects-coded" + (prep.attr.includes(null) ? ", None constant" : "") : "MaxDiff, sequential best–worst, effects-coded"})` },
    { m: "Verdict", v: out.converged ? "Converged — estimates below are valid" : "NOT converged — estimates are withheld" },
    { m: "Chains", v: o.chains },
    { m: "Burn-in iterations (per chain)", v: o.burnIn },
    { m: "Iterations kept from (per chain)", v: o.draws },
    { m: "Thinning", v: o.thin },
    { m: "Draws used (all chains)", v: out.chains.reduce((t, c) => t + c.kept, 0) },
    { m: "Largest R̂ (population means)", v: r3(out.maxRhat) },
    { m: "Smallest effective sample size", v: round(out.minEss, 0) },
    ...out.chains.map((c) => ({ m: `Chain ${c.chain}: acceptance after burn-in / jump size`, v: `${fmtPct(c.acceptance * 100, 1)} / ${fmtNum(c.jump, 3)}` })),
    ...out.chains.map((c) => { const worst = c.geweke.reduce((b, g) => (Math.abs(g.z) > Math.abs(b.z) ? g : b), { name: "—", z: 0 }); return { m: `Chain ${c.chain}: largest |Geweke z|`, v: `${fmtNum(Math.abs(worst.z), 2)} (${worst.name})` }; }),
    { m: "Prior", v: `μ flat; Σ ~ inverse-Wishart(df = ${prep.data.p} + ${o.priorDf}, scale = df × ${o.priorVariance} × effects-coding shape: every level, reference included, has prior variance (k−1)/k × ${o.priorVariance})` },
    { m: "Seed", v: o.seed },
    { m: "Estimator version", v: MODELS_VERSION },
    { m: "Data fingerprint", v: out.fingerprint },
  ];
  const tables: ResultTable[] = [
    { id: "hb_diagnostics", title: "Convergence diagnostics — hierarchical Bayes", columns: [{ key: "m", label: "Diagnostic" }, { key: "v", label: "Value" }], rows: diagRows, notes: ["R̂ (split, across chains) below 1.1 and effective sample sizes of several hundred indicate the chains agree and have mixed. Acceptance is tuned toward 30% during burn-in and then held fixed."] },
    { id: "hb_trace", title: "Trace summary — mean log-likelihood by block", columns: [{ key: "phase", label: "Phase" }, { key: "block", label: "Block", type: "number", decimals: 0 }, ...out.chains.map((c) => ({ key: `c${c.chain}`, label: `Chain ${c.chain} log-likelihood`, type: "number" as const, decimals: 1 })), { key: "rlh", label: "RLH", type: "number", decimals: 3 }],
      rows: out.trace.map((t) => ({ phase: t.phase, block: t.block, ...Object.fromEntries(out.chains.map((c, i) => [`c${c.chain}`, round(t.logLik[i], 1)])), rlh: r3(t.rlh) })), notes: ["The log-likelihood should rise during burn-in and then stay flat across the kept-draw blocks, at the same level in every chain."] },
  ];
  const chart: ChartData = {};
  const insights: string[] = [];
  if (!out.converged) {
    return makeResult(def, ds, { tables, chart, warnings, insights: ["The HB chains did not converge; no part-worths are reported. Increase the burn-in and draws (Options) and run again."], recommendedCharts: ["table"], variablesUsed: [prep.variable], baseLabel: `${prep.respondents} respondents`, totalCases, validN: prep.respondents });
  }
  // aggregate MNL on the same sets, for comparison only
  const agg = conditionalLogit(prep.sets, prep.data.p);
  const T = prep.data.transform!;
  const aggLevel = T.rows.map((row) => row.reduce((t, v, k) => t + v * agg.beta[k], 0));
  const hbMean = out.mu.map((m) => m.mean);
  const corr = (a: number[], b: number[]) => { const n = a.length, ma = a.reduce((t, v) => t + v, 0) / n, mb = b.reduce((t, v) => t + v, 0) / n; let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return sab / Math.sqrt(saa * sbb); };
  const rAgg = corr(hbMean, aggLevel);
  const slope = hbMean.reduce((t, v, i) => t + v * aggLevel[i], 0) / (aggLevel.reduce((t, v) => t + v * v, 0) || 1);
  const levelCols = out.names.map((_, l) => `u${l}`);
  if (prep.kind === "cbc") {
    tables.push({ id: "hb_mean", title: "Population mean part-worths — hierarchical Bayes (posterior)", columns: [{ key: "attribute", label: "Attribute" }, { key: "level", label: "Level" }, { key: "mean", label: "Posterior mean", type: "number", decimals: 3 }, { key: "sd", label: "Posterior SD", type: "number", decimals: 3 }, { key: "lo", label: "95% CrI low", type: "number", decimals: 3 }, { key: "hi", label: "95% CrI high", type: "number", decimals: 3 }, { key: "popSd", label: "Heterogeneity SD", type: "number", decimals: 3 }, { key: "rhat", label: "R̂", type: "number", decimals: 3 }, { key: "ess", label: "ESS", type: "number", decimals: 0 }],
      rows: out.mu.map((m, l) => ({ attribute: prep.attr[l] ?? "None", level: prep.level[l], mean: r3(m.mean), sd: r3(m.sd), lo: r3(m.lo), hi: r3(m.hi), popSd: r3(m.popSd), rhat: r3(m.rhat), ess: round(m.ess, 0) })),
      notes: ["μ: the mean of the individual part-worth distribution (effects-coded, zero-centred per attribute). Heterogeneity SD: the posterior mean of the population standard deviation of that level across respondents."] });
  } else {
    tables.push({ id: "hb_mean", title: "Population mean utilities — hierarchical Bayes (posterior)", columns: [{ key: "item", label: "Item" }, { key: "mean", label: "Posterior mean", type: "number", decimals: 3 }, { key: "sd", label: "Posterior SD", type: "number", decimals: 3 }, { key: "lo", label: "95% CrI low", type: "number", decimals: 3 }, { key: "hi", label: "95% CrI high", type: "number", decimals: 3 }, { key: "popSd", label: "Heterogeneity SD", type: "number", decimals: 3 }, { key: "rhat", label: "R̂", type: "number", decimals: 3 }, { key: "ess", label: "ESS", type: "number", decimals: 0 }],
      rows: out.mu.map((m, l) => ({ item: prep.level[l], mean: r3(m.mean), sd: r3(m.sd), lo: r3(m.lo), hi: r3(m.hi), popSd: r3(m.popSd), rhat: r3(m.rhat), ess: round(m.ess, 0) })).sort((a, b) => (b.mean ?? 0) - (a.mean ?? 0)),
      notes: ["Zero-centred (effects-coded, last item as reference). Individual-level utilities are in the respondent table."] });
  }
  // importances (CBC) per respondent from the posterior-mean part-worths
  const indImp: number[][] = [];
  if (prep.kind === "cbc") {
    for (const ind of out.individual) {
      const ranges = prep.attrs.map((a) => { const us = ind.mean.filter((_, l) => prep.attr[l] === a); return Math.max(...us) - Math.min(...us); });
      const tot = ranges.reduce((t, v) => t + v, 0) || 1;
      indImp.push(ranges.map((r) => (r / tot) * 100));
    }
    const imp = prep.attrs.map((a, k) => { const xs = indImp.map((r) => r[k]); const m = xs.reduce((t, v) => t + v, 0) / xs.length; const sdv = Math.sqrt(xs.reduce((t, v) => t + (v - m) ** 2, 0) / Math.max(1, xs.length - 1)); const sorted = [...xs].sort((x, y) => x - y); return { attribute: a, mean: m, sd: sdv, median: sorted[Math.floor(sorted.length / 2)] }; }).sort((x, y) => y.mean - x.mean);
    tables.push({ id: "hb_importance", title: "Attribute importance — mean of individual importances (HB)", columns: [{ key: "attribute", label: "Attribute" }, { key: "mean", label: "Mean importance %", type: "pct", decimals: 1 }, { key: "sd", label: "SD across respondents", type: "number", decimals: 1 }, { key: "median", label: "Median %", type: "pct", decimals: 1 }], rows: imp.map((x) => ({ attribute: x.attribute, mean: pct(x.mean), sd: round(x.sd, 1), median: pct(x.median) })), notes: ["Each respondent's importance = the range of their part-worths for the attribute over the sum of ranges (posterior-mean part-worths), then averaged."] });
    chart.categories = imp.map((x) => x.attribute); chart.series = [{ name: "Mean importance %", values: imp.map((x) => pct(x.mean)) }]; chart.valueFormat = "pct";
    chart.tree = prep.attrs.map((a) => ({ name: a, children: out.mu.map((m, l) => ({ m, l })).filter((x) => prep.attr[x.l] === a).map((x) => ({ name: prep.level[x.l], value: r3(x.m.mean) ?? 0 })) }));
    insights.push(`${imp[0].attribute} is the most important attribute on average (${fmtPct(imp[0].mean, 0)} of each respondent's utility range; SD ${fmtNum(imp[0].sd, 0)} points across respondents).`);
  }
  // simulation on individual utilities
  const nIdx = prep.attr.indexOf(null);
  type Profile = { name: string; levels: Record<string, string> };
  let simRows: Record<string, unknown>[] = [];
  if (prep.kind === "cbc") {
    const scenario = opt(def, "scenario", []) as Profile[];
    const best = (us: number[]) => Object.fromEntries(prep.attrs.map((a) => { const ls = out.mu.map((m, l) => ({ m: m.mean, l })).filter((x) => prep.attr[x.l] === a); return [a, prep.level[ls.reduce((b, x) => (x.m > b.m ? x : b)).l]]; }));
    const worst = () => Object.fromEntries(prep.attrs.map((a) => { const ls = out.mu.map((m, l) => ({ m: m.mean, l })).filter((x) => prep.attr[x.l] === a); return [a, prep.level[ls.reduce((b, x) => (x.m < b.m ? x : b)).l]]; }));
    const profiles: Profile[] = scenario.length ? scenario : [{ name: "Best profile", levels: best(hbMean) }, { name: "Worst profile", levels: worst() }];
    const lIndex = (a: string, lv: string | undefined) => { const i = prep.attr.findIndex((x, l) => x === a && prep.level[l] === lv); return i >= 0 ? i : prep.attr.indexOf(a); };
    const uOf = (us: number[], pr: Profile) => prep.attrs.reduce((t, a) => t + us[lIndex(a, pr.levels[a])], 0);
    const shares = new Array(profiles.length + (nIdx >= 0 ? 1 : 0)).fill(0);
    for (const ind of out.individual) { const us = profiles.map((pr) => uOf(ind.mean, pr)); if (nIdx >= 0) us.push(ind.mean[nIdx]); logitShares(us).forEach((s, k) => { shares[k] += s / out.individual.length; }); }
    const aggU = profiles.map((pr) => uOf(aggLevel, pr)); if (nIdx >= 0) aggU.push(aggLevel[nIdx]);
    const aggShares = logitShares(aggU);
    simRows = profiles.map((pr, k) => ({ profile: pr.name, description: prep.attrs.map((a) => `${a}: ${pr.levels[a] ?? prep.level[prep.attr.indexOf(a)]}`).join("; "), share: pct(shares[k] * 100), aggShare: pct(aggShares[k] * 100) }));
    if (nIdx >= 0) simRows.push({ profile: "None", description: "No purchase", share: pct(shares[shares.length - 1] * 100), aggShare: pct(aggShares[aggShares.length - 1] * 100) });
    tables.push({ id: "hb_simulation", title: "Share-of-preference simulation on individual utilities (HB)", columns: [{ key: "profile", label: "Profile" }, { key: "description", label: "Levels" }, { key: "share", label: "HB share % (mean of individual logit shares)", type: "pct", decimals: 1 }, { key: "aggShare", label: "Aggregate-logit share % (comparison)", type: "pct", decimals: 1 }], rows: simRows, notes: ["Each respondent's shares follow the logit rule on their own posterior-mean part-worths; the table averages them. Individual-level simulation reflects taste heterogeneity that the aggregate model averages away."] });
  } else {
    const shares = new Array(L).fill(0);
    for (const ind of out.individual) logitShares(ind.mean).forEach((s, k) => { shares[k] += s / out.individual.length; });
    const order = out.mu.map((_, l) => l).sort((a, b) => out.mu[b].mean - out.mu[a].mean);
    tables.push({ id: "hb_shares", title: "Preference shares on individual utilities (HB)", columns: [{ key: "item", label: "Item" }, { key: "share", label: "Mean individual share %", type: "pct", decimals: 1 }], rows: order.map((l) => ({ item: prep.level[l], share: pct(shares[l] * 100) })), notes: ["Each respondent's shares across all items by the logit rule on their own utilities, averaged."] });
    chart.categories = order.map((l) => prep.level[l]); chart.series = [{ name: "Preference share %", values: order.map((l) => pct(shares[l] * 100)) }]; chart.valueFormat = "pct";
    insights.push(`“${prep.level[order[0]]}” has the highest mean individual preference share (${fmtPct(shares[order[0]] * 100, 1)}).`);
  }
  tables.push({ id: "hb_fit", title: "Fit — hierarchical Bayes", columns: [{ key: "m", label: "Statistic" }, { key: "v", label: "Value" }], rows: [
    { m: "Respondents", v: out.fit.respondents }, { m: "Choice tasks", v: out.fit.tasks },
    { m: "Root likelihood (RLH), at posterior means", v: r3(out.fit.rlh) },
    { m: "Percent certainty", v: fmtPct(out.fit.pctCert * 100, 1) },
    { m: "Mean respondent RLH", v: r3(out.individual.reduce((t, i) => t + i.rlh, 0) / out.individual.length) },
    { m: "Chance RLH (1 / alternatives)", v: r3(Math.exp(out.fit.nullLogLik / out.fit.tasks)) },
    { m: "Log-likelihood at posterior means", v: round(out.fit.logLik, 1) },
    { m: "Mean log-likelihood of the draws", v: round(out.fit.meanDrawLogLik, 1) },
    ...(prep.holdoutTasks ? [{ m: "Holdout tasks set aside", v: prep.holdoutTasks }] : []),
  ], notes: ["RLH: the geometric mean of the predicted probability of each choice made; percent certainty = 1 − LL / LL(chance). In-sample measures — individual utilities fit the respondent's own answers closely by construction."] });
  tables.push({ id: "hb_vs_aggregate", title: "HB population means vs the aggregate logit (same data, comparison only)", columns: [{ key: "name", label: prep.kind === "cbc" ? "Level" : "Item" }, { key: "hb", label: "HB mean", type: "number", decimals: 3 }, { key: "agg", label: "Aggregate MNL", type: "number", decimals: 3 }],
    rows: out.names.map((n, l) => ({ name: n, hb: r3(hbMean[l]), agg: r3(aggLevel[l]) })), notes: [`Correlation ${fmtNum(rAgg, 3)}; HB means are ${fmtNum(slope, 2)}× the aggregate on average. The aggregate logit's scale is attenuated by taste heterogeneity, so HB means are typically larger in magnitude with the same pattern.`] });
  const indCols = [{ key: "id", label: "Respondent" }, { key: "rlh", label: "RLH", type: "number" as const, decimals: 3 }, { key: "pc", label: "Pct. certainty", type: "pct" as const, decimals: 1 }, ...out.names.map((n, l) => ({ key: levelCols[l], label: n, type: "number" as const, decimals: 3 })), ...(prep.kind === "cbc" ? prep.attrs.map((a, k) => ({ key: `imp${k}`, label: `Importance: ${a} %`, type: "pct" as const, decimals: 1 })) : [])];
  const caseCode = (id: string) => ds.cases.find((c) => c.id === id)?.code ?? id;
  tables.push({ id: "hb_individual", title: "Individual utilities — posterior means (one row per respondent)", columns: indCols, rows: out.individual.map((ind, i) => ({ id: caseCode(ind.id), rlh: r3(ind.rlh), pc: pct(ind.pctCert * 100), ...Object.fromEntries(ind.mean.map((v, l) => [levelCols[l], r3(v)])), ...(prep.kind === "cbc" ? Object.fromEntries(indImp[i].map((v, k) => [`imp${k}`, pct(v)])) : {}) })) });
  tables.push({ id: "hb_individual_sd", title: "Individual utilities — posterior SDs", columns: [{ key: "id", label: "Respondent" }, ...out.names.map((n, l) => ({ key: levelCols[l], label: n, type: "number" as const, decimals: 3 }))], rows: out.individual.map((ind) => ({ id: caseCode(ind.id), ...Object.fromEntries(ind.sd.map((v, l) => [levelCols[l], r3(v)])) })), notes: ["Posterior standard deviation of each respondent's utility over the kept draws: how precisely that respondent's preferences are pinned down."] });
  insights.push(`HB fit: RLH ${fmtNum(out.fit.rlh, 3)} (chance ${fmtNum(Math.exp(out.fit.nullLogLik / out.fit.tasks), 3)}), percent certainty ${fmtPct(out.fit.pctCert * 100, 0)}; chains converged (largest R̂ ${fmtNum(out.maxRhat, 3)}).`);
  chart.kpis = [{ label: "Respondents", value: out.fit.respondents }, { label: "RLH", value: r3(out.fit.rlh) ?? 0 }, { label: "Largest R̂", value: r3(out.maxRhat) ?? 0 }];
  return makeResult(def, ds, { tables, chart, warnings, insights, recommendedCharts: prep.kind === "cbc" ? ["attribute_importance", "part_worth", "utility_by_level", "preference_share"] : ["maxdiff_preference", "maxdiff_utility", "bar_horizontal"], variablesUsed: [prep.variable], baseLabel: `${prep.respondents} respondents`, totalCases, validN: prep.respondents });
}

export interface HbJobStep {
  status: "running" | "done" | "refused";
  progress: { done: number; total: number; unit: "iterations" };
  state?: HbState;
  result?: AnalysisResult;
  /** projected total run time, from the iterations so far */
  projectedMs?: number;
}

function step(def: AnalysisDefinition, ds: Dataset, totalCases: number, prep: HbPrep, state: HbState, budget: { deadline: number; now: () => number }): HbJobStep {
  hbAdvance(state, prep.data, { deadline: budget.deadline, now: budget.now });
  const progress = { done: state.iteration, total: state.total, unit: "iterations" as const };
  const projectedMs = state.iteration ? (state.elapsedMs / state.iteration) * state.total : undefined;
  if (!hbDone(state)) return { status: "running", progress, state, projectedMs };
  return { status: "done", progress, state, result: hbResultFromState(def, ds, totalCases, prep, state), projectedMs };
}

/** start a chunked HB run: advance until `budgetMs` elapses (or the run ends) */
export function hbJobStart(def: AnalysisDefinition, ds: Dataset, budgetMs: number, now: () => number = nowMs, totalCases = ds.cases.length): HbJobStep {
  const prep = prepareHb(def, ds);
  const no = hbRefusal(def, ds, totalCases, prep);
  if (no) return { status: "refused", progress: { done: 0, total: 0, unit: "iterations" }, result: no };
  const p = prep as HbPrep;
  return step(def, ds, totalCases, p, hbInit(p.data, hbOptionsOf(def)), { deadline: now() + budgetMs, now });
}

/** continue a chunked HB run from its saved state (refused if the data changed since it started) */
export function hbJobContinue(def: AnalysisDefinition, ds: Dataset, state: HbState, budgetMs: number, now: () => number = nowMs, totalCases = ds.cases.length): HbJobStep {
  const prep = prepareHb(def, ds);
  const no = hbRefusal(def, ds, totalCases, prep);
  if (no) return { status: "refused", progress: { done: state.iteration, total: state.total, unit: "iterations" }, result: no };
  const p = prep as HbPrep;
  try { return step(def, ds, totalCases, p, state, { deadline: now() + budgetMs, now }); }
  catch (e) { return { status: "refused", progress: { done: state.iteration, total: state.total, unit: "iterations" }, result: refused(def, ds, totalCases, `This HB run cannot be continued: ${(e as Error).message}`) }; }
}

/** synchronous HB (the run route, exports): finishes within `options.timeBudgetMs` (default 25 s) or says how long it needs */
export function hb(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const budget = intOpt(def.options?.timeBudgetMs, 25_000, 100, 600_000);
  const r = hbJobStart(def, ds, budget, nowMs, totalCases);
  if (r.result) return r.result;
  const secs = Math.ceil((r.projectedMs ?? budget * 2) / 1000);
  return refused(def, ds, totalCases, `This hierarchical Bayes run needs about ${secs} s (${r.progress.total.toLocaleString()} iterations per chain for ${ds.cases.length.toLocaleString()} respondents) — longer than one request allows, so no partial result is shown. Run it from the analysis builder, which runs HB as a background job with progress, or reduce burn-in / draws in Options.`, ["attribute_importance"]);
}

/* ================================================================== LCA */

export function lca(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const vars = expandBattery(ds, def.variables).filter((v) => ds.byName.has(v) && ["categorical", "scale", "numeric"].includes(ds.byName.get(v)!.role));
  if (vars.length < 2) return refused(def, ds, totalCases, "Latent class analysis needs at least two categorical indicators (three or more for more than two classes).", ["heatmap"]);
  const cats = vars.map((v) => categoriesOf(ds, v));
  const tooMany = vars.filter((_, j) => cats[j].length > 15);
  if (tooMany.length) return refused(def, ds, totalCases, `${tooMany.map((v) => labelOf(ds, v)).join(", ")} ${tooMany.length === 1 ? "has" : "have"} more than 15 distinct values — latent class indicators must be categorical. Recode or band ${tooMany.length === 1 ? "it" : "them"} first.`, ["heatmap"]);
  const cols = vars.map((v) => categoricalColumn(ds, v));
  const data = ds.cases.map((_, i) => vars.map((_, j) => { const x = cols[j][i]; if (x == null || Array.isArray(x)) return null; const k = cats[j].findIndex((c) => c.code === x); return k >= 0 ? k : null; }));
  const run = latentClass({ data, categories: cats.map((c) => c.length), itemNames: vars.map((v) => labelOf(ds, v)), ids: ds.cases.map((c) => c.id) }, {
    minClasses: intOpt(def.options?.minClasses, 1, 1, 8), maxClasses: intOpt(def.options?.maxClasses, 4, 1, 8), starts: intOpt(def.options?.starts, 20, 1, 200), seed: intOpt(def.options?.seed, 1, 0, 2 ** 31 - 1), maxIter: intOpt(def.options?.maxIter, 2000, 50, 20000),
  });
  const notes = run.diagnostics.filter((d) => d.code === "listwise" || d.code === "constant_indicator").map((d) => d.message);
  if (!run.output) return refused(def, ds, totalCases, [run.error?.message ?? "No valid latent class solution.", ...run.diagnostics.filter((d) => d.severity === "error").map((d) => d.message)].filter((v, i, a) => a.indexOf(v) === i).join(" "), ["heatmap"]);
  const out = run.output;
  const chosenK = intOpt(def.options?.classes, out.recommended ?? out.fits.find((f) => f.identified && f.converged)?.k ?? 1, 1, 8);
  const sel: LcaFit | undefined = out.fits.find((f) => f.k === chosenK && f.identified && f.converged) ?? out.fits.find((f) => f.k === out.recommended);
  const fitTable: ResultTable = {
    id: "lca_fit", title: "Latent class models compared", columns: [{ key: "k", label: "Classes", type: "number", decimals: 0 }, { key: "ll", label: "Log-likelihood", type: "number", decimals: 2 }, { key: "npar", label: "Parameters", type: "number", decimals: 0 }, { key: "aic", label: "AIC", type: "number", decimals: 2 }, { key: "bic", label: "BIC", type: "number", decimals: 2 }, { key: "sabic", label: "SABIC", type: "number", decimals: 2 }, { key: "entropy", label: "Entropy", type: "number", decimals: 3 }, { key: "smallest", label: "Smallest class %", type: "pct", decimals: 1 }, { key: "rep", label: "Best LL replicated" }, { key: "status", label: "Status" }],
    rows: out.fits.map((f) => ({ k: f.k, ll: round(f.logLik, 2), npar: f.npar, aic: round(f.aic, 2), bic: round(f.bic, 2), sabic: round(f.sabic, 2), entropy: f.entropy == null ? null : r3(f.entropy), smallest: f.classSizes.length ? pct(Math.min(...f.classSizes) * 100) : null, rep: f.identified ? `${f.replicated} of ${f.starts}` : "—", status: !f.identified ? "not identified" : !f.converged ? "not converged" : f.warnings.some((w) => w.code === "empty_class") ? "empty class" : f.k === out.recommended ? "lowest BIC ✓" : f.warnings.some((w) => w.code === "local_maximum") ? "possible local maximum" : "valid" })),
    notes: [out.recommendation, "AIC = −2LL + 2p; BIC = −2LL + p·ln N; SABIC uses (N + 2) / 24 in place of N. Entropy is the relative entropy (1 = classes perfectly separated)."],
  };
  const tables: ResultTable[] = [fitTable];
  const chart: ChartData = {};
  const insights: string[] = [out.recommendation.split(". ")[0] + "."];
  if (sel) {
    const K = sel.k;
    const cls = Array.from({ length: K }, (_, k) => `Class ${k + 1}`);
    tables.push({ id: "lca_sizes", title: `Class sizes — ${K}-class model`, columns: [{ key: "cls", label: "Class" }, { key: "size", label: "Estimated share %", type: "pct", decimals: 1 }, { key: "modal", label: "Assigned (modal) %", type: "pct", decimals: 1 }, { key: "n", label: "Assigned n", type: "number", decimals: 0 }], rows: cls.map((c, k) => ({ cls: c, size: pct(sel.classSizes[k] * 100), modal: pct(sel.modalSizes[k] * 100), n: Math.round(sel.modalSizes[k] * out.nUsed) })), notes: ["Classes are numbered largest first."] });
    const profRows: Record<string, unknown>[] = [];
    vars.forEach((v, j) => cats[j].forEach((c, r) => profRows.push({ indicator: labelOf(ds, v), category: c.label, ...Object.fromEntries(cls.map((_, k) => [`c${k}`, pct(sel.itemProbs[k][j][r] * 100)])) })));
    tables.push({ id: "lca_profiles", title: `Item-response probabilities — ${K}-class model`, columns: [{ key: "indicator", label: "Indicator" }, { key: "category", label: "Category" }, ...cls.map((c, k) => ({ key: `c${k}`, label: `${c} %`, type: "pct" as const, decimals: 1 }))], rows: profRows, notes: ["P(category | class): each indicator's probabilities sum to 100% within a class."] });
    tables.push({ id: "lca_classification", title: "Classification uncertainty — mean posterior probability by assigned class", columns: [{ key: "assigned", label: "Assigned to" }, ...cls.map((c, k) => ({ key: `c${k}`, label: `P(${c})`, type: "number" as const, decimals: 3 }))], rows: cls.map((c, a) => ({ assigned: c, ...Object.fromEntries(cls.map((_, k) => [`c${k}`, r3(sel.avgPosteriorByModal[a][k])])) })), notes: ["Diagonal values near 1 mean respondents are assigned with confidence; values below about 0.8 mean the class boundary is fuzzy."] });
    const used = out.usedIndex;
    tables.push({ id: "lca_membership", title: `Posterior class membership — ${K}-class model (one row per respondent)`, columns: [{ key: "id", label: "Respondent" }, { key: "cls", label: "Assigned class" }, { key: "max", label: "Max probability", type: "number", decimals: 3 }, ...cls.map((c, k) => ({ key: `c${k}`, label: `P(${c})`, type: "number" as const, decimals: 3 }))], rows: sel.posterior.map((row, i) => ({ id: ds.cases[used[i]].code ?? ds.cases[used[i]].id, cls: cls[sel.modal[i]], max: r3(Math.max(...row)), ...Object.fromEntries(row.map((v, k) => [`c${k}`, r3(v)])) })) });
    chart.categories = cls; chart.series = [{ name: "Class share %", values: sel.classSizes.map((v) => pct(v * 100)) }]; chart.valueFormat = "pct";
    chart.matrix = { rows: profRows.map((r) => `${r.indicator}: ${r.category}`), columns: cls, values: profRows.map((r) => cls.map((_, k) => r[`c${k}`] as number)) };
    chart.kpis = [{ label: "Classes", value: K }, { label: "BIC", value: round(sel.bic, 1) ?? 0 }, ...(sel.entropy != null ? [{ label: "Entropy", value: r3(sel.entropy) ?? 0 }] : [])];
    if (K > 1) insights.push(`${K}-class model: class sizes ${sel.classSizes.map((v) => fmtPct(v * 100, 0)).join(", ")}; entropy ${fmtNum(sel.entropy, 2)}.`);
  }
  const warnings = [...notes, ...(sel ? sel.warnings.filter((w) => w.severity !== "info").map((w) => w.message) : [])];
  return makeResult(def, ds, { tables, chart, insights, warnings, recommendedCharts: ["heatmap", "bar_vertical", "segment_size"], variablesUsed: vars, totalCases, validN: out.nUsed });
}

/* ================================================================== SEM */

export function sem(def: AnalysisDefinition, ds: Dataset, totalCases: number): AnalysisResult {
  const syntax = String(def.options?.syntax ?? "").trim();
  if (!syntax) return refused(def, ds, totalCases, "Write the model in Options (e.g. “F1 =~ q1 + q2 + q3”).", ["network"]);
  const scaling = def.options?.scaling === "unit_variance" ? "unit_variance" : "marker";
  const data: Record<string, (number | null)[]> = {};
  const usable = (n: string) => ds.byName.has(n) && ["numeric", "scale", "categorical"].includes(ds.byName.get(n)!.role);
  for (const v of ds.variables) if (usable(v.name)) data[v.name] = numericColumn(ds, v.name);
  const run = fitSem({ syntax, data }, { scaling, confidence: 0.95 });
  if (!run.output) {
    const extra = run.diagnostics.filter((d) => d.severity === "error" && d.message !== run.error?.message).map((d) => d.message);
    return refused(def, ds, totalCases, [run.error?.message ?? "The model could not be estimated.", ...extra].join(" "), ["network"]);
  }
  const out = run.output;
  const f = out.fit;
  const row = (e: SemEstimate) => ({ lhs: e.lhs, op: e.op, rhs: e.rhs, label: e.label ?? "", est: r3(e.est), se: e.free ? r3(e.se) : null, z: e.free ? round(e.z, 2) : null, p: e.free ? fmtP(e.p) : "(fixed)", ci: e.free && e.ciLow != null ? `[${fmtNum(e.ciLow, 3)}, ${fmtNum(e.ciHigh, 3)}]` : "", std: r3(e.std) });
  const estCols = (a: string, b: string) => [{ key: "lhs", label: a }, { key: "rhs", label: b }, { key: "label", label: "Label" }, { key: "est", label: "Estimate", type: "number" as const, decimals: 3 }, { key: "se", label: "SE", type: "number" as const, decimals: 3 }, { key: "z", label: "z", type: "number" as const, decimals: 2 }, { key: "p", label: "p" }, { key: "ci", label: "95% CI" }, { key: "std", label: "Std. (all)", type: "number" as const, decimals: 3 }];
  const fitRows = [
    { m: "Estimator", v: `ML (covariance matrix, divisor N), expected-information SEs, listwise deletion; ${scaling === "marker" ? "first loading fixed to 1" : "latent variances fixed to 1"}` },
    { m: "Complete cases (N)", v: f.n }, { m: "Free parameters", v: f.npar },
    { m: "χ²", v: round(f.chisq, 3) }, { m: "df", v: f.df }, { m: "p (χ²)", v: f.pvalue == null ? "—" : fmtP(f.pvalue) },
    { m: "CFI", v: r3(f.cfi) }, { m: "TLI", v: r3(f.tli) },
    { m: "RMSEA [90% CI]", v: f.rmsea == null ? "—" : `${fmtNum(f.rmsea, 3)} [${fmtNum(f.rmseaLow, 3)}, ${fmtNum(f.rmseaHigh, 3)}]` },
    { m: "SRMR", v: r3(f.srmr) }, { m: "AIC", v: round(f.aic, 2) }, { m: "BIC", v: round(f.bic, 2) }, { m: "Log-likelihood", v: round(f.logLik, 2) },
    { m: "Baseline χ² (df)", v: `${fmtNum(f.baselineChisq, 2)} (${f.baselineDf})` },
    { m: "Iterations", v: out.iterations },
  ];
  const tables: ResultTable[] = [
    { id: "sem_fit", title: "Model fit — structural equation model", columns: [{ key: "m", label: "Statistic" }, { key: "v", label: "Value" }], rows: fitRows, notes: ["Conventional cut-offs (Hu & Bentler 1999): CFI / TLI ≥ .95, RMSEA ≤ .06, SRMR ≤ .08 — guidelines, not tests. χ² is sensitive to sample size."] },
  ];
  const load = out.estimates.filter((e) => e.kind === "loading");
  const reg = out.estimates.filter((e) => e.kind === "regression");
  const cov = out.estimates.filter((e) => e.kind === "covariance" || e.kind === "residual_covariance");
  const vars = out.estimates.filter((e) => e.kind === "variance" || e.kind === "residual_variance");
  if (load.length) tables.push({ id: "sem_measurement", title: "Measurement model — factor loadings", columns: estCols("Factor", "Indicator"), rows: load.map(row) });
  if (reg.length) tables.push({ id: "sem_structural", title: "Structural model — regression paths", columns: estCols("Outcome", "Predictor"), rows: reg.map(row) });
  if (cov.length) tables.push({ id: "sem_covariances", title: "Covariances (std. = correlation)", columns: estCols("Variable", "With"), rows: cov.map(row) });
  tables.push({ id: "sem_variances", title: "Variances and residual variances (std. = proportion unexplained)", columns: estCols("Variable", "Variable"), rows: vars.map(row) });
  if (out.defined.length) tables.push({ id: "sem_indirect", title: "Indirect and defined effects (delta-method SEs)", columns: [{ key: "name", label: "Effect" }, { key: "expr", label: "Definition" }, { key: "est", label: "Estimate", type: "number", decimals: 3 }, { key: "se", label: "SE", type: "number", decimals: 3 }, { key: "z", label: "z", type: "number", decimals: 2 }, { key: "p", label: "p" }, { key: "ci", label: "95% CI" }], rows: out.defined.map((d) => ({ name: d.name, expr: d.expr, est: r3(d.est), se: r3(d.se), z: round(d.z, 2), p: fmtP(d.p), ci: d.ciLow == null ? "" : `[${fmtNum(d.ciLow, 3)}, ${fmtNum(d.ciHigh, 3)}]` })), notes: ["Indirect effects are products of paths; their SEs use the delta method (first-order), which assumes the product is approximately normal — a bootstrap is not run."] });
  if (out.r2.length) tables.push({ id: "sem_r2", title: "R² of endogenous variables", columns: [{ key: "variable", label: "Variable" }, { key: "r2", label: "R²", type: "number", decimals: 3 }], rows: out.r2.map((x) => ({ variable: x.variable, r2: r3(x.r2) })) });
  if (out.residualCorrelations.length) tables.push({ id: "sem_residuals", title: "Largest standardised residuals (observed − implied, in correlation units)", columns: [{ key: "a", label: "Variable" }, { key: "b", label: "With" }, { key: "residual", label: "Residual", type: "number", decimals: 3 }], rows: out.residualCorrelations.map((r) => ({ ...r, residual: r3(r.residual) })), notes: ["Residuals beyond about ±0.10 point at relations the model does not reproduce."] });
  // a simple path diagram: nodes and directed links with standardised coefficients
  const chart: ChartData = {
    nodes: [...out.latent.map((l) => ({ id: l, label: l, group: "latent", value: 20 })), ...out.observed.map((o) => ({ id: o, label: labelOf(ds, o) === o ? o : `${o}`, group: "observed", value: 5 }))],
    links: [...load.map((e) => ({ source: e.lhs, target: e.rhs, value: round(e.std, 3) ?? 0 })), ...reg.map((e) => ({ source: e.rhs, target: e.lhs, value: round(e.std, 3) ?? 0 }))],
    categories: [...load, ...reg].map((e) => (e.kind === "loading" ? `${e.lhs} → ${e.rhs}` : `${e.rhs} → ${e.lhs}`)),
    series: [{ name: "Standardised coefficient", values: [...load, ...reg].map((e) => round(e.std, 3)) }],
    kpis: [{ label: "CFI", value: r3(f.cfi) ?? 0 }, { label: "RMSEA", value: r3(f.rmsea) ?? 0 }, { label: "SRMR", value: r3(f.srmr) ?? 0 }],
  };
  const good = (f.cfi ?? 0) >= 0.95 && (f.rmsea ?? 1) <= 0.06 && f.srmr <= 0.08;
  const insights = [`Fit: χ²(${f.df}) = ${fmtNum(f.chisq, 2)}, p ${f.pvalue == null ? "—" : f.pvalue < 0.001 ? "< .001" : `= ${fmtP(f.pvalue)}`}; CFI ${fmtNum(f.cfi, 3)}, TLI ${fmtNum(f.tli, 3)}, RMSEA ${fmtNum(f.rmsea, 3)}, SRMR ${fmtNum(f.srmr, 3)} — ${f.df === 0 ? "just-identified (fit not testable)" : good ? "acceptable by conventional cut-offs" : "below conventional cut-offs on at least one index"}.`];
  const sigInd = out.defined.filter((d) => d.p != null && d.p < 0.05);
  if (sigInd.length) insights.push(`Significant indirect / defined effect${sigInd.length === 1 ? "" : "s"}: ${sigInd.slice(0, 3).map((d) => `${d.name} = ${fmtNum(d.est, 3)} (p ${fmtP(d.p)})`).join("; ")}.`);
  const warnings = run.diagnostics.filter((d) => d.severity !== "info" || d.code === "listwise" || d.code === "just_identified").map((d) => d.message);
  return makeResult(def, ds, { tables, chart, insights, warnings, recommendedCharts: ["network", "coefficient_plot", "table"], variablesUsed: out.observed, totalCases, validN: out.nUsed });
}
