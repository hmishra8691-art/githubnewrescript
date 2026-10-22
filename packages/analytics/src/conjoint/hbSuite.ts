/**
 * HIERARCHICAL BAYES FOR THE CONJOINT SUITE (F4, 2026-10-22) — the same HB-MNL sampler and chunked
 * job (models/hb.ts, analyses/advanced.ts, migration 0066), fed by the suite's codings:
 *
 *   ACBC   BYO + screening (vs the threshold) + implied rule screens + tournament (conjoint/acbc.ts);
 *          reported like CBC (levels, the threshold as None, a summed price as its low / high ends)
 *   menu   the buy-anything logit, the item logits and the section MNLs as one parameter vector
 *          (conjoint/menu.ts) — a binary logit is a two-alternative MNL
 *   CBC    dual-response None under the chosen coding (analyses/choice.ts dualResponseSets)
 *
 * and, after any finished run, the market / menu simulator on the individual posterior means.
 */
import type { AnalysisDefinition, AnalysisResult, ResultTable } from "../types.js";
import type { Dataset } from "../dataset.js";
import type { ChoiceSet } from "../stats/choice.js";
import { effectsPriorShape, type HbData, type HbOutput } from "../models/hb.js";
import { opt, pct, round } from "../analyses/common.js";
import { acbcRespondentSets, type AcbcCoding } from "./acbc.js";
import { menuModelSpec, menuSimTables, menuTaskSets, menuTasks, type MenuLayout, type MenuScenario } from "./menu.js";
import { scenariosFor, simulatorTables } from "./simulatorTables.js";
import { numericValues, type UtilityModel } from "./simulator.js";

export interface SuiteHbPrep {
  kind: "cbc" | "menu";
  variant: "acbc" | "menu";
  qid: string; variable: string; data: HbData;
  attr: (string | null)[]; level: string[]; attrs: string[];
  sets: ChoiceSet[]; respondents: number; holdoutTasks: number; warnings: string[];
  acbc?: AcbcCoding; menu?: { layout: MenuLayout; design: { config?: unknown } };
}

const toData = (resp: { id: string; sets: ChoiceSet[] }[], p: number, transform: { names: string[]; rows: number[][] }): HbData => ({
  p, paramNames: transform.names.slice(0, p), transform,
  respondents: resp.map((r) => ({ id: r.id, X: Float64Array.from(r.sets.flatMap((s) => s.alternatives.flat())), taskSizes: Int32Array.from(r.sets.map((s) => s.alternatives.length)), chosen: Int32Array.from(r.sets.map((s) => s.chosen)) })),
});

/** an ACBC or menu question → HB input (null: not the suite's; { refuse } in words) */
export function prepareSuiteHb(def: AnalysisDefinition, ds: Dataset, q: { id: string; type: string }): SuiteHbPrep | { refuse: string } | null {
  const qrow = ds.def.questions.find((x) => x.id === q.id);
  const variable = qrow?.variableName ?? q.id;
  if (q.type === "acbc_task") {
    const s = acbcRespondentSets(ds, q.id, { byo: opt(def, "acbcByo", true) as boolean, rules: opt(def, "acbcRules", true) as boolean });
    if (!s) return { refuse: "The ACBC design was not found." };
    const lr = s.coding.levelRows();
    const data = toData(s.respondents, s.coding.p, { names: lr.names, rows: lr.rows });
    data.priorShape = effectsPriorShape(s.coding.p, s.coding.blocks);
    return { kind: "cbc", variant: "acbc", qid: q.id, variable, data, attr: lr.attr, level: lr.level, attrs: [...s.coding.attrs.map((a) => a.name), ...(s.coding.price ? ["Price (summed)"] : [])], sets: s.respondents.flatMap((r) => r.sets), respondents: s.respondents.length, holdoutTasks: 0, warnings: s.incomplete ? [`${s.incomplete} unfinished ACBC interviews contribute the stages they completed.`] : [], acbc: s.coding };
  }
  const design = qrow ? ds.def.designs.find((d) => d.id === qrow.settings.designRef) : undefined;
  if (q.type === "conjoint_task" && design?.kind === "cva") return { refuse: "Rating-based conjoint (CVA) is estimated per respondent by least squares — every respondent rates enough profiles for their own regression — in the Conjoint analysis. Hierarchical Bayes here is a choice model (HB-MNL)." };
  if (q.type === "conjoint_task" && design?.kind === "menu") {
    const mt = menuTasks(ds, q.id);
    if (!mt) return { refuse: "The menu design has not been generated." };
    const spec = menuModelSpec(def, mt);
    const L = spec.layout;
    const resp = mt.respondents.map((r) => ({ id: r.id, sets: r.tasks.flatMap((t) => menuTaskSets(L, t).map((x) => x.set)) }));
    const names = L.blocks.flatMap((b) => b.names);
    const data = toData(resp, L.P, { names, rows: names.map((_, i) => names.map((__, j) => (i === j ? 1 : 0))) });
    return { kind: "menu", variant: "menu", qid: q.id, variable, data, attr: L.blocks.flatMap((b) => b.names.map(() => b.label)), level: names, attrs: [], sets: resp.flatMap((r) => r.sets), respondents: resp.length, holdoutTasks: 0, warnings: [], menu: { layout: L, design } };
  }
  return null;
}

const r3 = (x: number | null | undefined) => round(x, 3);

/** individual utilities (HB posterior means, reported units) → a simulator model, for CBC-like preps */
export function hbUtilityModel(prep: { attr: (string | null)[]; level: string[]; attrs: string[]; variant?: string; acbc?: AcbcCoding }, out: HbOutput, source: string, priceAttribute?: string): UtilityModel {
  const plain = prep.attrs.filter((a) => a !== "Price (summed)");
  const lvl = (a: string) => prep.level.filter((_, l) => prep.attr[l] === a);
  const noneIdx = prep.attr.indexOf(null);
  const pr = prep.acbc?.price ?? null;
  const pIdx = prep.attr.map((a, l) => (a === "Price (summed)" ? l : -1)).filter((x) => x >= 0);
  const price = priceAttribute && plain.includes(priceAttribute) ? numericValues(lvl(priceAttribute)) : undefined;
  return {
    kind: "choice", source,
    attributes: plain.map((a) => ({ name: a, levels: lvl(a), ...(a === priceAttribute && price ? { values: price } : {}) })),
    ...(priceAttribute && price ? { priceAttribute } : {}),
    ...(pr ? { linearPrice: { reference: pr.reference, min: pr.min, max: pr.max, label: "Summed price" } } : {}),
    respondents: out.individual.map((ind) => ({
      id: ind.id,
      levels: Object.fromEntries(plain.map((a) => [a, ind.mean.filter((_, l) => prep.attr[l] === a)])),
      ...(noneIdx >= 0 ? { none: ind.mean[noneIdx] } : {}),
      ...(pr && pIdx.length === 2 ? { priceCoef: (ind.mean[pIdx[1]] - ind.mean[pIdx[0]]) / (pr.max - pr.min || 1) } : {}),
    })),
  };
}

/** after a finished CBC / ACBC HB run: the ACBC price table and any saved / asked-for simulator scenarios */
export function suiteHbPost(def: AnalysisDefinition, ds: Dataset, prep: { attr: (string | null)[]; level: string[]; attrs: string[]; variant?: string; acbc?: AcbcCoding; qid: string }, out: HbOutput, result: AnalysisResult): AnalysisResult {
  const tables = [...result.tables], insights = [...result.insights], warnings = [...result.warnings];
  const q = ds.def.questions.find((x) => x.id === prep.qid);
  const design = q ? ds.def.designs.find((d) => d.id === q.settings.designRef) : undefined;
  if (prep.variant === "acbc" && prep.acbc?.price) {
    const pr = prep.acbc.price;
    const pIdx = prep.attr.map((a, l) => (a === "Price (summed)" ? l : -1)).filter((x) => x >= 0);
    const coefs = out.individual.map((i) => (i.mean[pIdx[1]] - i.mean[pIdx[0]]) / (pr.max - pr.min || 1)).sort((a, b) => a - b);
    const mu = (out.mu[pIdx[1]].mean - out.mu[pIdx[0]].mean) / (pr.max - pr.min || 1);
    tables.push({ id: "acbc_price", title: "Summed price — utility per currency unit (HB)", columns: [{ key: "m", label: "Statistic" }, { key: "v", label: "Value", type: "number", decimals: 5 }], rows: [{ m: "Population mean (per 1 unit)", v: round(mu, 5) }, { m: "Population mean (per 100 units)", v: r3(mu * 100) }, { m: "Median respondent (per 1 unit)", v: round(coefs[Math.floor(coefs.length / 2)], 5) }, { m: "Respondents with a positive price slope", v: coefs.filter((c) => c > 0).length }], notes: [`Price is one linear term over the shown range ${pr.currency}${round(pr.min, 2)}–${pr.currency}${round(pr.max, 2)}; the “Price (summed)” rows above are that term at the two ends.`] });
  }
  const sims = scenariosFor(def.options, design?.config as Record<string, unknown> | undefined);
  if (sims.length) {
    const priceAttr = (opt(def, "priceAttribute", null) as string | null) ?? prep.attrs.find((a) => /price|cost|fee/i.test(a) && a !== "Price (summed)" && numericValues(prep.level.filter((_, l) => prep.attr[l] === a)));
    const model = hbUtilityModel(prep, out, prep.variant === "acbc" ? "ACBC hierarchical Bayes (individual posterior means)" : "hierarchical Bayes (individual posterior means)", priceAttr ?? undefined);
    for (const [k, sp] of sims.entries()) { const st = simulatorTables(model, sp, ds, { idPrefix: k ? `sim${k + 1}` : "sim" }); tables.push(...st.tables); insights.push(...st.insights); warnings.push(...st.warnings); }
  }
  return { ...result, tables, insights, warnings };
}

/** a finished menu HB run → its tables (the diagnostics and trace tables come from the shared HB code) */
export function menuHbTables(def: AnalysisDefinition, prep: SuiteHbPrep, out: HbOutput): { tables: ResultTable[]; insights: string[] } {
  const L = prep.menu!.layout;
  const tables: ResultTable[] = [];
  tables.push({ id: "hb_mean", title: "Menu model — population means (hierarchical Bayes, posterior)", columns: [{ key: "model", label: "Model" }, { key: "parameter", label: "Parameter" }, { key: "mean", label: "Posterior mean", type: "number", decimals: 3 }, { key: "sd", label: "Posterior SD", type: "number", decimals: 3 }, { key: "lo", label: "95% CrI low", type: "number", decimals: 3 }, { key: "hi", label: "95% CrI high", type: "number", decimals: 3 }, { key: "popSd", label: "Heterogeneity SD", type: "number", decimals: 3 }, { key: "rhat", label: "R̂", type: "number", decimals: 3 }],
    rows: L.blocks.flatMap((b) => b.names.map((n, k) => { const m = out.mu[b.offset + k]; return { model: b.kind === "buy" ? "Buy anything" : b.kind === "group" ? `Section: ${b.label}` : `Item: ${b.label}`, parameter: n.replace(/^[^:]+:\s*/, ""), mean: r3(m.mean), sd: r3(m.sd), lo: r3(m.lo), hi: r3(m.hi), popSd: r3(m.popSd), rhat: r3(m.rhat) }; })),
    notes: ["Prices standardised per item as in the aggregate menu model. Individual utilities are in the respondent table; the simulator below uses them."] });
  const betas = out.individual.map((i) => ({ id: i.id, beta: i.mean }));
  const saved = Array.isArray((prep.menu!.design.config as { simulations?: unknown[] } | undefined)?.simulations) ? ((prep.menu!.design.config as { simulations: MenuScenario[] }).simulations) : [];
  const own = opt(def, "menuScenario", null) as MenuScenario | null;
  const insights: string[] = [];
  (own ? [own] : saved.length ? saved : [{ name: "Middle tested prices" }]).forEach((sc, k) => insights.push(...menuSimTables(L, betas, sc, tables, k ? `menu_sim${k + 1}` : "menu_sim", "menu hierarchical Bayes (individual posterior means)").insights));
  tables.push({ id: "hb_fit", title: "Fit — hierarchical Bayes (menu)", columns: [{ key: "m", label: "Statistic" }, { key: "v", label: "Value" }], rows: [{ m: "Respondents", v: out.fit.respondents }, { m: "Choices (buy / item / section decisions)", v: out.fit.tasks }, { m: "Root likelihood (RLH)", v: r3(out.fit.rlh) }, { m: "Percent certainty", v: pct(out.fit.pctCert * 100) }] });
  tables.push({ id: "hb_individual", title: "Individual menu utilities — posterior means", columns: [{ key: "id", label: "Respondent" }, { key: "rlh", label: "RLH", type: "number", decimals: 3 }, ...out.names.map((n, l) => ({ key: `u${l}`, label: n, type: "number" as const, decimals: 3 }))], rows: out.individual.map((i) => ({ id: i.id, rlh: r3(i.rlh), ...Object.fromEntries(i.mean.map((v, l) => [`u${l}`, r3(v)])) })) });
  return { tables, insights };
}
