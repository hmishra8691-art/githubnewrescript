/**
 * ADAPTIVE CBC — the estimator. F4, 2026-10-22.
 *
 * Sawtooth's ACBC/HB coding: every section of the interview is a set of choices in ONE multinomial
 * logit, so one set of part-worths explains the whole transcript (the engine's `AcbcAnswer`).
 *
 *   BYO          per attribute, a choice among its levels (only that attribute's columns vary; with a
 *                summed price, each level carries its price increment, so price trades off in the BYO)
 *   screening    every concept is a binary choice between the concept and a THRESHOLD alternative
 *                (a "None" parameter): "a possibility" = the concept chosen, "won't work" = threshold
 *   rules        (optional, default on) a confirmed UNACCEPTABLE level = the BYO concept with that level
 *                rejected against the threshold; a confirmed MUST-HAVE = the BYO concept with each other
 *                level of that attribute rejected — the respondent's stated rules as implied screens
 *   tournament   each round is a choice among its concepts (no threshold)
 *
 * Coding: effects coding per attribute (levels in configured order, first level = −1 on every column,
 * part-worths sum to zero), then the threshold, then — with a summed price — price as ONE linear term,
 * x = (price − reference) / unit, reference = the middle of the list-price range and unit = half that
 * range, so the coefficient is per `unit` currency (reported per currency unit too).
 *
 * The same sets feed the aggregate logit (quick look) and HB-MNL (models/hb.ts) for individual
 * utilities, importances, RLH and R̂, and the market simulator (the threshold acts as None).
 */
import type { AnalysisDefinition, AnalysisResult, ResultTable } from "../types.js";
import type { Dataset } from "../dataset.js";
import { conditionalLogit, type ChoiceSet } from "../stats/choice.js";
import { fmtNum, fmtPct, makeResult, opt, pct, refused, round } from "../analyses/common.js";
import { acbcListPrice, isAcbcAnswer, normalizeAcbc, type AcbcAnswer, type AcbcConfig, type AcbcNormalized } from "@rescript/engine";
import { scenariosFor, simulatorTables } from "./simulatorTables.js";
import type { UtilityModel } from "./simulator.js";

export interface AcbcCoding {
  attrs: { name: string; levels: string[] }[];
  /** coded parameters: attribute columns, threshold, then price (when summed) */
  p: number;
  col: (attribute: string, level: string) => number;
  thresholdIdx: number;
  priceIdx: number;
  price: { reference: number; unit: number; min: number; max: number; currency: string } | null;
  cfg: AcbcNormalized;
  /** a concept's features (attributes + price) */
  concept(profile: Record<string, string>, price?: number): number[];
  threshold(): number[];
  /** reported quantities: every level, the threshold, then price at the bottom and top of the shown range */
  levelRows(): { names: string[]; attr: (string | null)[]; level: string[]; rows: number[][] };
  blocks: number[][];
}

export function acbcCoding(config: AcbcConfig): AcbcCoding {
  const cfg = normalizeAcbc(config);
  const attrs = cfg.attributes.map((a) => ({ name: a.name, levels: a.levels.map(String) }));
  const cols = new Map<string, number>();
  const blocks: number[][] = [];
  let p = 0;
  for (const a of attrs) { const b: number[] = []; for (const l of a.levels.slice(1)) { cols.set(`${a.name}\u0000${l}`, p); b.push(p++); } blocks.push(b); }
  const thresholdIdx = p++;
  const sp = cfg.summedPrice;
  let price: AcbcCoding["price"] = null, priceIdx = -1;
  if (sp) {
    const lo = acbcListPrice(sp, cfg.attributes, Object.fromEntries(attrs.map((a) => [a.name, a.levels[(sp.increments[a.name] ?? []).indexOf(Math.min(...(sp.increments[a.name] ?? [0])))] ?? a.levels[0]])));
    const hi = acbcListPrice(sp, cfg.attributes, Object.fromEntries(attrs.map((a) => [a.name, a.levels[(sp.increments[a.name] ?? []).indexOf(Math.max(...(sp.increments[a.name] ?? [0])))] ?? a.levels[0]])));
    const reference = (lo + hi) / 2;
    const unit = (hi - lo) / 2 || Math.abs(reference) / 2 || 1;
    price = { reference, unit, min: lo * (1 - sp.variation), max: hi * (1 + sp.variation), currency: sp.currency };
    priceIdx = p++;
  }
  const codeAttr = (x: number[], a: { name: string; levels: string[] }, level: string) => {
    const k = a.levels.indexOf(level);
    if (k === 0) for (const l of a.levels.slice(1)) x[cols.get(`${a.name}\u0000${l}`)!] = -1;
    else if (k > 0) x[cols.get(`${a.name}\u0000${level}`)!] = 1;
  };
  const concept = (profile: Record<string, string>, pr?: number) => {
    const x = new Array(p).fill(0);
    for (const a of attrs) codeAttr(x, a, String(profile[a.name]));
    if (price && pr != null) x[priceIdx] = (pr - price.reference) / price.unit;
    return x;
  };
  const threshold = () => { const x = new Array(p).fill(0); x[thresholdIdx] = 1; return x; };
  const levelRows = () => {
    const names: string[] = [], attr: (string | null)[] = [], level: string[] = [], rows: number[][] = [];
    for (const a of attrs) for (const l of a.levels) { const x = new Array(p).fill(0); codeAttr(x, a, l); names.push(`${a.name}: ${l}`); attr.push(a.name); level.push(l); rows.push(x); }
    { const x = new Array(p).fill(0); x[thresholdIdx] = 1; names.push("None"); attr.push(null); level.push("Threshold (None)"); rows.push(x); }
    if (price) for (const [lab, v] of [["low", price.min], ["high", price.max]] as const) {
      const x = new Array(p).fill(0); x[priceIdx] = (v - price.reference) / price.unit;
      names.push(`Price (summed): ${lab} ${round(v, 2)}`); attr.push("Price (summed)"); level.push(`${price.currency}${round(v, 2)}`); rows.push(x);
    }
    return { names, attr, level, rows };
  };
  return { attrs, p, col: (a, l) => cols.get(`${a}\u0000${l}`) ?? -1, thresholdIdx, priceIdx, price, cfg, concept, threshold, levelRows, blocks };
}

export type AcbcStage = "byo" | "screen" | "rule" | "tournament";
export interface AcbcSetsOptions { byo?: boolean; rules?: boolean; screening?: boolean; tournament?: boolean }

/** one transcript → its choice sets (with the stage of each), the coding's way */
export function acbcSets(coding: AcbcCoding, a: AcbcAnswer, opts: AcbcSetsOptions = {}): { sets: ChoiceSet[]; stages: AcbcStage[] } {
  const sets: ChoiceSet[] = [], stages: AcbcStage[] = [];
  const sp = coding.cfg.summedPrice;
  const push = (s: ChoiceSet, st: AcbcStage) => { sets.push(s); stages.push(st); };
  const byoComplete = coding.attrs.every((at) => a.byo[at.name] != null);
  if (opts.byo !== false && byoComplete) {
    for (const at of coding.attrs) {
      const chosen = at.levels.indexOf(String(a.byo[at.name]));
      if (chosen < 0 || at.levels.length < 2) continue;
      const alts = at.levels.map((l) => {
        const x = new Array(coding.p).fill(0);
        const k = at.levels.indexOf(l);
        if (k === 0) for (const m of at.levels.slice(1)) x[coding.col(at.name, m)] = -1; else x[coding.col(at.name, l)] = 1;
        if (coding.price && sp) { const inc = sp.increments[at.name]?.[k]; if (inc != null && Number.isFinite(inc)) x[coding.priceIdx] = inc / coding.price.unit; }
        return x;
      });
      push({ alternatives: alts, chosen }, "byo");
    }
  }
  if (opts.screening !== false) for (const s of a.screens) for (const c of s.concepts) {
    const v = s.verdicts[c.id]; if (v !== "yes" && v !== "no") continue;
    push({ alternatives: [coding.concept(c.profile, c.price), coding.threshold()], chosen: v === "yes" ? 0 : 1 }, "screen");
  }
  if (opts.rules !== false && byoComplete) {
    const byoPrice = sp ? acbcListPrice(sp, coding.cfg.attributes, a.byo) : undefined;
    const variant = (attr: string, level: string) => {
      const prof = { ...a.byo, [attr]: level };
      const pr = sp && byoPrice != null ? acbcListPrice(sp, coding.cfg.attributes, prof) : undefined;
      return { alternatives: [coding.concept(prof, pr), coding.threshold()], chosen: 1 };
    };
    for (const r of a.unacceptable) if (r.confirmed && coding.col(r.attribute, r.level) !== undefined) push(variant(r.attribute, r.level), "rule");
    for (const r of a.mustHave) if (r.confirmed) {
      const at = coding.attrs.find((x) => x.name === r.attribute);
      for (const l of at?.levels ?? []) if (l !== r.level) push(variant(r.attribute, l), "rule");
    }
  }
  if (opts.tournament !== false) for (const round of a.tournament) {
    if (!round.chosen || round.concepts.length < 2) continue;
    const k = round.concepts.findIndex((c) => c.id === round.chosen);
    if (k < 0) continue;
    push({ alternatives: round.concepts.map((c) => coding.concept(c.profile, c.price)), chosen: k }, "tournament");
  }
  return { sets, stages };
}

/** every respondent's ACBC transcript as choice sets */
export function acbcRespondentSets(ds: Dataset, qid: string, opts: AcbcSetsOptions = {}) {
  const q = ds.def.questions.find((x) => x.id === qid);
  const design = q ? ds.def.designs.find((d) => d.id === q.settings.designRef) : undefined;
  if (!q || !design || design.kind !== "acbc") return null;
  const coding = acbcCoding((design.config ?? {}) as AcbcConfig);
  const respondents: { ci: number; id: string; sets: ChoiceSet[]; stages: AcbcStage[]; answer: AcbcAnswer }[] = [];
  let incomplete = 0;
  ds.cases.forEach((c, ci) => {
    const a = c.answers[qid];
    if (!isAcbcAnswer(a)) return;
    if (a.stage !== "done") incomplete++;
    const { sets, stages } = acbcSets(coding, a, opts);
    if (sets.length) respondents.push({ ci, id: String(c.id ?? ci), sets, stages, answer: a });
  });
  return { q, design, coding, respondents, incomplete };
}

/** the coded parameters as reported quantities (levels zero-centred, threshold, price per unit) */
export function acbcReport(coding: AcbcCoding, beta: ArrayLike<number>) {
  const lr = coding.levelRows();
  const val = (row: number[]) => row.reduce((t, v, k) => t + v * beta[k], 0);
  const levels: Record<string, number[]> = {};
  for (const a of coding.attrs) levels[a.name] = a.levels.map((l) => val(lr.rows[lr.names.indexOf(`${a.name}: ${l}`)]));
  const threshold = beta[coding.thresholdIdx];
  const pricePerUnit = coding.price ? beta[coding.priceIdx] / coding.price.unit : null;
  return { levels, threshold, pricePerUnit };
}

/** a simulator model from one coded β (aggregate) or many (HB individual means) */
export function acbcUtilityModel(coding: AcbcCoding, betas: { id: string; beta: ArrayLike<number> }[], source: string): UtilityModel {
  return {
    kind: "choice", source,
    attributes: coding.attrs.map((a) => ({ name: a.name, levels: a.levels })),
    ...(coding.price ? { linearPrice: { reference: coding.price.reference, min: coding.price.min, max: coding.price.max, label: "Summed price" } } : {}),
    respondents: betas.map((b) => { const r = acbcReport(coding, b.beta); return { id: b.id, levels: r.levels, none: r.threshold, ...(r.pricePerUnit != null ? { priceCoef: r.pricePerUnit } : {}) }; }),
  };
}

const r3 = (x: number | null | undefined) => round(x, 3);

/**
 * THE ACBC ANALYSIS (kind `conjoint` on an ACBC question): the aggregate logit over every stage —
 * a quick look, labelled as pooled — the counts, fit by stage, and the simulator. Individual
 * utilities come from the Hierarchical Bayes analysis on the same question.
 */
export function acbcAnalysis(def: AnalysisDefinition, ds: Dataset, totalCases: number, qid: string): AnalysisResult {
  const opts: AcbcSetsOptions = { byo: opt(def, "acbcByo", true) as boolean, rules: opt(def, "acbcRules", true) as boolean };
  const data = acbcRespondentSets(ds, qid, opts);
  if (!data) return refused(def, ds, totalCases, "The ACBC design was not found.", ["attribute_importance"]);
  const { coding, respondents } = data;
  if (!respondents.length) return refused(def, ds, totalCases, "No ACBC answers recorded yet.", ["attribute_importance"]);
  const sets = respondents.flatMap((r) => r.sets);
  if (sets.length < coding.p * 3) return refused(def, ds, totalCases, `Only ${sets.length} ACBC choices recorded — too few to estimate ${coding.p} parameters.`, ["attribute_importance"]);
  const fit = conditionalLogit(sets, coding.p);
  const rep = acbcReport(coding, fit.beta);
  const lr = coding.levelRows();
  const ranges = coding.attrs.map((a) => ({ attribute: a.name, range: Math.max(...rep.levels[a.name]) - Math.min(...rep.levels[a.name]) }));
  if (coding.price && rep.pricePerUnit != null) ranges.push({ attribute: "Price (summed)", range: Math.abs(rep.pricePerUnit) * (coding.price.max - coding.price.min) });
  const totalRange = ranges.reduce((t, x) => t + x.range, 0) || 1;
  const importance = ranges.map((x) => ({ ...x, importance: (100 * x.range) / totalRange })).sort((a, b) => b.importance - a.importance);
  // fit and hit rate by stage
  const stageNames: Record<AcbcStage, string> = { byo: "Build-your-own", screen: "Screening (vs threshold)", rule: "Rules (implied screens)", tournament: "Tournament" };
  const byStage = new Map<AcbcStage, { n: number; hits: number; ll: number; null0: number }>();
  for (const r of respondents) r.sets.forEach((s, k) => {
    const st = r.stages[k]; const e = byStage.get(st) ?? byStage.set(st, { n: 0, hits: 0, ll: 0, null0: 0 }).get(st)!;
    const u = s.alternatives.map((x) => x.reduce((t, v, i) => t + v * fit.beta[i], 0)); const mx = Math.max(...u);
    const Z = u.reduce((t, v) => t + Math.exp(v - mx), 0);
    e.n++; e.ll += u[s.chosen] - mx - Math.log(Z); e.null0 -= Math.log(s.alternatives.length); if (u.indexOf(mx) === s.chosen) e.hits++;
  });
  // counts (quick look)
  const counts = new Map<string, { byo: number; shown: number; accepted: number; tShown: number; tWon: number; unacc: number; must: number }>();
  const key = (a: string, l: string) => `${a}\u0000${l}`;
  const get = (a: string, l: string) => counts.get(key(a, l)) ?? counts.set(key(a, l), { byo: 0, shown: 0, accepted: 0, tShown: 0, tWon: 0, unacc: 0, must: 0 }).get(key(a, l))!;
  for (const { answer: a } of respondents) {
    for (const [at, l] of Object.entries(a.byo)) get(at, l).byo++;
    for (const s of a.screens) for (const c of s.concepts) for (const [at, l] of Object.entries(c.profile)) { const e = get(at, l); if (s.verdicts[c.id]) e.shown++; if (s.verdicts[c.id] === "yes") e.accepted++; }
    for (const r of a.tournament) if (r.chosen) for (const c of r.concepts) for (const [at, l] of Object.entries(c.profile)) { const e = get(at, l); e.tShown++; if (c.id === r.chosen) e.tWon++; }
    for (const r of a.unacceptable) if (r.confirmed) get(r.attribute, r.level).unacc++;
    for (const r of a.mustHave) if (r.confirmed) get(r.attribute, r.level).must++;
  }
  const N = respondents.length;
  const tables: ResultTable[] = [
    { id: "importance", title: "Attribute importance — ACBC (aggregate logit over BYO, screening and tournament)", columns: [{ key: "attribute", label: "Attribute" }, { key: "importance", label: "Relative importance %", type: "pct", decimals: 1 }, { key: "range", label: "Utility range", type: "number", decimals: 3 }], rows: importance.map((x) => ({ attribute: x.attribute, importance: pct(x.importance), range: r3(x.range) })), base: { n: N, label: `${N} respondents, ${sets.length} choices` }, notes: coding.price ? ["The summed price's range is its coefficient × the price range shown (after variation)."] : [] },
    { id: "partworths", title: "Part-worth utilities — ACBC aggregate multinomial logit (effects-coded, zero-centred)", columns: [{ key: "attribute", label: "Attribute" }, { key: "level", label: "Level" }, { key: "utility", label: "Utility", type: "number", decimals: 3 }, { key: "se", label: "SE", type: "number", decimals: 3 }],
      rows: [
        ...coding.attrs.flatMap((a) => a.levels.map((l, k) => { const c = coding.col(a.name, l); return { attribute: a.name, level: l, utility: r3(rep.levels[a.name][k]), se: c >= 0 ? r3(fit.se[c]) : null }; })),
        { attribute: "Threshold", level: "None (screening threshold)", utility: r3(rep.threshold), se: r3(fit.se[coding.thresholdIdx]) },
        ...(coding.price && rep.pricePerUnit != null ? [{ attribute: "Price (summed)", level: "per 1 currency unit", utility: round(rep.pricePerUnit, 5), se: round(fit.se[coding.priceIdx] / coding.price.unit, 5) }, { attribute: "Price (summed)", level: `per 100 currency units`, utility: r3(rep.pricePerUnit * 100), se: r3((fit.se[coding.priceIdx] / coding.price.unit) * 100) }] : []),
      ],
      notes: ["One set of utilities for the whole sample (pooled) — a quick look. Individual-level utilities: the Hierarchical Bayes analysis on this question uses the same coding (Sawtooth ACBC/HB): BYO choices, screening as concept-vs-threshold, confirmed unacceptable / must-have rules as implied rejections, tournament choices.", "The threshold is the utility a concept must beat to be “a possibility”; the simulator uses it as None."] },
    { id: "fit", title: "Model fit by stage", columns: [{ key: "stage", label: "Stage" }, { key: "n", label: "Choices", type: "number", decimals: 0 }, { key: "hit", label: "Hit rate %", type: "pct", decimals: 1 }, { key: "rlh", label: "RLH", type: "number", decimals: 3 }, { key: "chance", label: "Chance RLH", type: "number", decimals: 3 }],
      rows: [...byStage.entries()].map(([st, e]) => ({ stage: stageNames[st], n: e.n, hit: pct((100 * e.hits) / e.n), rlh: r3(Math.exp(e.ll / e.n)), chance: r3(Math.exp(e.null0 / e.n)) })), notes: [`McFadden R² ${fmtNum(fit.mcFaddenR2, 3)} overall; ${fit.converged ? "converged" : "did NOT converge"} in ${fit.iterations} iterations. ${data.incomplete ? `${data.incomplete} unfinished interviews contribute the stages they completed.` : ""}`] },
    { id: "counts", title: "Counts — ACBC quick look (raw, not a model)", columns: [{ key: "attribute", label: "Attribute" }, { key: "level", label: "Level" }, { key: "byo", label: "Chosen in BYO %", type: "pct", decimals: 1 }, { key: "accept", label: "Screening: a possibility %", type: "pct", decimals: 1 }, { key: "win", label: "Tournament: chosen when shown %", type: "pct", decimals: 1 }, { key: "unacc", label: "Unacceptable %", type: "pct", decimals: 1 }, { key: "must", label: "Must-have %", type: "pct", decimals: 1 }],
      rows: coding.attrs.flatMap((a) => a.levels.map((l) => { const e = get(a.name, l); return { attribute: a.name, level: l, byo: pct((100 * e.byo) / N), accept: pct(e.shown ? (100 * e.accepted) / e.shown : 0), win: pct(e.tShown ? (100 * e.tWon) / e.tShown : 0), unacc: pct((100 * e.unacc) / N), must: pct((100 * e.must) / N) }; })),
      notes: ["Counts are descriptive: ACBC shows concepts near each respondent's BYO, so a level's screening and tournament rates also reflect who saw it. The part-worths account for that."] },
  ];
  const insights = [`${importance[0].attribute} matters most in the ACBC (${fmtPct(importance[0].importance, 0)} of the utility range)${importance.length > 1 ? `, then ${importance[1].attribute} (${fmtPct(importance[1].importance, 0)})` : ""}.`];
  const warnings: string[] = [];
  if (!fit.converged) warnings.push("The ACBC aggregate logit did not fully converge — utilities are approximate.");
  const model = acbcUtilityModel(coding, [{ id: "aggregate", beta: fit.beta }], "ACBC aggregate logit");
  const sims = scenariosFor(def.options, data.design.config as Record<string, unknown>);
  for (const [k, sp] of sims.entries()) { const st = simulatorTables(model, sp, ds, { idPrefix: k ? `sim${k + 1}` : "sim" }); tables.push(...st.tables); insights.push(...st.insights); warnings.push(...st.warnings); }
  void lr;
  return makeResult(def, ds, {
    tables, chart: { categories: importance.map((x) => x.attribute), series: [{ name: "Importance %", values: importance.map((x) => pct(x.importance)) }], tree: coding.attrs.map((a) => ({ name: a.name, children: a.levels.map((l, k) => ({ name: l, value: r3(rep.levels[a.name][k]) ?? 0 })) })), kpis: [{ label: "Respondents", value: N }, { label: "McFadden R²", value: r3(fit.mcFaddenR2) ?? 0 }], valueFormat: "pct" },
    insights, warnings, recommendedCharts: ["attribute_importance", "part_worth", "utility_by_level", "preference_share"], variablesUsed: [data.q.variableName ?? qid], baseLabel: `${N} respondents`, totalCases, validN: N,
  });
}
