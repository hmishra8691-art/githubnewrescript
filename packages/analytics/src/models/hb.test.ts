import { test } from "node:test";
import assert from "node:assert/strict";
import { advancedDataset, CBC_ATTRIBUTES, CBC_MU, CBC_NONE_MU, MD_MU, MD_ITEMS, advSpec } from "./fixture.js";
import { Rng } from "./rng.js";
import { drawInvWishart, effectiveSize, effectsPriorShape, gewekeZ, hbAdvance, hbDone, hbInit, hbSummarise, splitRhat, type HbData } from "./hb.js";
import { runAnalysis } from "../analyses/index.js";
import { hbJobContinue, hbJobStart } from "../analyses/advanced.js";
import { cbcRespondentSets } from "../analyses/choice.js";
import type { AnalysisDefinition } from "../types.js";

/**
 * HIERARCHICAL BAYES (HB-MNL) — validated, not asserted.
 *
 * Respondents are drawn from a KNOWN population of effects-coded part-worths
 * (μ = CBC_MU, heterogeneity SD 0.8 per level before centring) and answer a
 * real 10-version efficient CBC design from @rescript/designs with Gumbel
 * errors, so HB-MNL is the true model. Measured at 300 respondents × 12 tasks:
 * max |μ̂ − μ| ≈ 0.11, r(individual posterior means, true part-worths) ≈ 0.8,
 * the aggregate MNL attenuated by ~0.6× with the same pattern.
 */

const corr = (a: number[], b: number[]) => { const n = a.length, ma = a.reduce((t, v) => t + v, 0) / n, mb = b.reduce((t, v) => t + v, 0) / n; let ab = 0, aa = 0, bb = 0; for (let i = 0; i < n; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; } return ab / Math.sqrt(aa * bb); };
const D = (variables: string[], options: Record<string, unknown> = {}): AnalysisDefinition => ({ name: "hb", kind: "hb", dataset: advSpec, variables, options: { timeBudgetMs: 600_000, ...options } });

const study = advancedDataset({ n: 300, heterogeneity: 0.8 });

test("HB-CBC recovers the population means, the heterogeneity and individual part-worths on a real efficient design (300 × 12)", { timeout: 120_000 }, () => {
  const r = runAnalysis(D(["CBC"], { seed: 3 }), study.ds);   // the defaults: 2 chains × (5,000 burn-in + 5,000 draws), thin 5
  assert.equal(r.error, undefined, JSON.stringify(r.warnings));
  const mean = r.tables.find((t) => t.id === "hb_mean")!;
  assert.ok(mean, `no hb_mean table: ${r.tables.map((t) => t.id)} ${r.warnings}`);
  assert.match(mean.title, /hierarchical Bayes/i, "labelled as HB");
  const errs: number[] = [];
  for (const a of CBC_ATTRIBUTES) a.levels.forEach((l, k) => {
    const row = mean.rows.find((x) => x.attribute === a.name && x.level === l)!;
    errs.push(Math.abs((row.mean as number) - CBC_MU[a.name][k]));
    assert.ok((row.rhat as number) < 1.1, `${a.name}=${l} R̂ ${row.rhat}`);
    // true SD of a centred level = 0.8 · √(2/3) ≈ 0.65
    assert.ok(Math.abs((row.popSd as number) - 0.8 * Math.sqrt(2 / 3)) < 0.25, `${a.name}=${l} heterogeneity SD ${row.popSd}`);
  });
  const maxErr = Math.max(...errs);
  assert.ok(maxErr < 0.2, `max |μ̂ − μ| = ${maxErr.toFixed(3)}`);
  const none = mean.rows.find((x) => x.attribute === "None")!;
  assert.ok(Math.abs((none.mean as number) - CBC_NONE_MU) < 0.3, `None ${none.mean} vs ${CBC_NONE_MU}`);
  // individual part-worths against each respondent's truth
  const ind = r.tables.find((t) => t.id === "hb_individual")!;
  assert.equal(ind.rows.length, 300);
  const est: number[] = [], tru: number[] = [];
  ind.rows.forEach((row, i) => {
    const t = study.truth.cbc[i];
    let l = 0;
    for (const a of CBC_ATTRIBUTES) a.levels.forEach((_, k) => { est.push(row[`u${l}`] as number); tru.push(t.levels[a.name][k]); l++; });
  });
  const rInd = corr(est, tru);
  assert.ok(rInd > 0.7, `r(individual) = ${rInd.toFixed(3)}`);
  // HB vs the aggregate MNL: same pattern, aggregate attenuated by heterogeneity
  const cmp = r.tables.find((t) => t.id === "hb_vs_aggregate")!;
  const lv = cmp.rows.filter((x) => x.name !== "None");
  const hbv = lv.map((x) => x.hb as number), agg = lv.map((x) => x.agg as number);
  assert.ok(corr(hbv, agg) > 0.95, `same pattern as the aggregate: r = ${corr(hbv, agg)} ${JSON.stringify(cmp.rows)}`);
  const slope = hbv.reduce((t, v, i) => t + v * agg[i], 0) / agg.reduce((t, v) => t + v * v, 0);
  assert.ok(slope > 1.15, `HB/aggregate scale ${slope.toFixed(2)}`);
  // the remaining outputs exist and are labelled
  for (const id of ["hb_diagnostics", "hb_trace", "hb_importance", "hb_simulation", "hb_fit", "hb_individual_sd"]) assert.ok(r.tables.some((t) => t.id === id), id);
  const fit = r.tables.find((t) => t.id === "hb_fit")!;
  const rlh = fit.rows.find((x) => String(x.m).startsWith("Root likelihood"))!.v as number;
  assert.ok(rlh > 0.45 && rlh < 0.9, `RLH ${rlh} (chance 0.25)`);
  const sim = r.tables.find((t) => t.id === "hb_simulation")!;
  const total = sim.rows.reduce((t, x) => t + (x.share as number), 0);
  assert.ok(Math.abs(total - 100) < 0.5, "shares sum to 100");
  assert.ok(!r.tables.some((t) => /aggregate multinomial logit/i.test(t.title) && t.id !== "hb_vs_aggregate"), "never silently the aggregate model");
  console.log(`  HB-CBC recovery: max |μ̂−μ| = ${maxErr.toFixed(3)}, r(individual) = ${rInd.toFixed(3)}, HB/aggregate scale = ${slope.toFixed(2)}, RLH = ${rlh}`);
});

test("HB-MaxDiff recovers item utilities (8 items, 300 respondents)", { timeout: 120_000 }, () => {
  const r = runAnalysis(D(["MD"], { burnIn: 1500, draws: 2500, seed: 5 }), study.ds);
  const mean = r.tables.find((t) => t.id === "hb_mean")!;
  assert.ok(mean, r.warnings.join(" "));
  const muC = MD_MU.map((m) => m - MD_MU.reduce((t, v) => t + v, 0) / MD_MU.length);
  const est = MD_ITEMS.map((it) => mean.rows.find((x) => x.item === it)!.mean as number);
  const err = Math.max(...est.map((e, i) => Math.abs(e - muC[i])));
  assert.ok(err < 0.25, `max |μ̂ − μ| = ${err.toFixed(3)}`);
  assert.ok(corr(est, muC) > 0.98);
  const ind = r.tables.find((t) => t.id === "hb_individual")!;
  const e2: number[] = [], t2: number[] = [];
  ind.rows.forEach((row, i) => { const tm = study.truth.md[i]; const c = tm.reduce((t, v) => t + v, 0) / tm.length; MD_ITEMS.forEach((_, k) => { e2.push(row[`u${k}`] as number); t2.push(tm[k] - c); }); });
  const rInd = corr(e2, t2);
  assert.ok(rInd > 0.7, `r(individual) = ${rInd.toFixed(3)}`);
  console.log(`  HB-MaxDiff recovery: max |μ̂−μ| = ${err.toFixed(3)}, r(individual) = ${rInd.toFixed(3)}`);
});

function smallData(n = 40): HbData {
  const s = cbcRespondentSets(study.ds, "q_cbc")!;
  const resp = s.respondents.slice(0, n);
  const lr = s.coding.levelRows();
  return { p: s.coding.p, paramNames: lr.names.slice(0, s.coding.p), transform: { names: lr.names, rows: lr.rows }, priorShape: effectsPriorShape(s.coding.p, s.coding.attrs.map((a) => s.coding.idx.filter((e) => e.attr === a).map((e) => e.i))),
    respondents: resp.map((r) => ({ id: r.id, X: Float64Array.from(r.sets.flatMap((x) => x.alternatives.flat())), taskSizes: Int32Array.from(r.sets.map((x) => x.alternatives.length)), chosen: Int32Array.from(r.sets.map((x) => x.chosen)) })) };
}

test("HB is reproducible: same seed, same draws — and chunked + JSON round-tripped runs equal an uninterrupted one", () => {
  const data = smallData();
  const opts = { burnIn: 150, draws: 150, thin: 3, chains: 2, seed: 42 };
  const a = hbInit(data, opts); hbAdvance(a, data);
  const b = hbInit(data, opts);
  let st = b;
  for (const k of [37, 101, 1000]) { hbAdvance(st, data, { maxIterations: k }); st = JSON.parse(JSON.stringify(st)); }
  assert.ok(hbDone(st) && hbDone(a));
  const sa = hbSummarise(a, data), sb = hbSummarise(st, data);
  assert.deepEqual(sb.mu.map((m) => m.mean), sa.mu.map((m) => m.mean));
  assert.deepEqual(sb.individual.map((i) => i.mean), sa.individual.map((i) => i.mean));
  const c = hbInit(data, { ...opts, seed: 43 }); hbAdvance(c, data);
  assert.notDeepEqual(hbSummarise(c, data).mu.map((m) => m.mean), sa.mu.map((m) => m.mean), "a different seed gives different draws");
  // continuing on different data is refused
  const other = smallData(41);
  assert.throws(() => hbAdvance(hbInit(data, opts), other), /fingerprint/);
});

test("the chunked job API gives the same result as one synchronous run, with progress", { timeout: 60_000 }, () => {
  const def = D(["CBC"], { burnIn: 200, draws: 200, seed: 9 });
  let clock = 0; const now = () => (clock += 1);   // a fake clock: every check advances 1 ms
  let step = hbJobStart(def, study.ds, 4, now);
  let chunks = 1;
  while (step.status === "running") { assert.ok(step.progress.done < step.progress.total && step.progress.done > 0); step = hbJobContinue(def, study.ds, JSON.parse(JSON.stringify(step.state)), 4, now); chunks++; }
  assert.equal(step.status, "done");
  assert.ok(chunks > 3, `ran in ${chunks} chunks`);
  const sync = runAnalysis(def, study.ds);
  const a = step.result!.tables.find((t) => t.id === "hb_diagnostics")!, b = sync.tables.find((t) => t.id === "hb_diagnostics")!;
  assert.deepEqual(a.rows.filter((x) => x.m !== "Estimator version"), b.rows.filter((x) => x.m !== "Estimator version"));
  assert.deepEqual(step.result!.tables.find((t) => t.id === "hb_trace")!.rows, sync.tables.find((t) => t.id === "hb_trace")!.rows);
});

test("non-convergence is detected and the estimates are withheld (diagnostics only)", { timeout: 60_000 }, () => {
  // far too short: 100 burn-in, 100 draws, dispersed second chain
  const r = runAnalysis(D(["CBC"], { burnIn: 100, draws: 100, thin: 1, seed: 2 }), study.ds);
  const verdict = r.tables.find((t) => t.id === "hb_diagnostics")!.rows.find((x) => x.m === "Verdict")!.v as string;
  if (/NOT converged/.test(verdict)) {
    assert.ok(!r.tables.some((t) => ["hb_mean", "hb_individual", "hb_simulation", "hb_importance"].includes(t.id)), "no part-worths when not converged");
    assert.ok(r.warnings.some((w) => /not converged/i.test(w)));
  } else {
    // if a short run happens to pass R̂, the ESS warning must still flag it
    assert.ok(r.warnings.some((w) => /effective sample size/i.test(w)), JSON.stringify(r.warnings));
  }
  // R̂ itself: two chains with different means
  const g = new Rng(1);
  const c1 = Array.from({ length: 400 }, () => g.normal()), c2 = Array.from({ length: 400 }, () => 3 + g.normal());
  assert.ok(splitRhat([c1, c2]) > 1.5);
  const c3 = Array.from({ length: 400 }, () => g.normal());
  assert.ok(Math.abs(splitRhat([c1, c3]) - 1) < 0.02);
  assert.ok(effectiveSize([c1, c3]) > 500, "iid draws have ESS near n");
  const ar = [0]; for (let i = 1; i < 2000; i++) ar.push(0.95 * ar[i - 1] + g.normal());
  assert.ok(effectiveSize([ar]) < 150, "autocorrelated draws have a small ESS");
  const drift = Array.from({ length: 400 }, (_, i) => i / 100 + 0.1 * g.normal());
  assert.ok(Math.abs(gewekeZ(drift)) > 3, "Geweke flags a drifting chain");
});

test("insufficient data and wrong questions are refused in words, never estimated", () => {
  const few = advancedDataset({ n: 12 });
  const r = runAnalysis(D(["CBC"]), few.ds);
  assert.ok(r.error && /at least 20 respondents/.test(r.error.message), JSON.stringify(r.error));
  assert.equal(r.tables.length, 0);
  // the picker's dictionary name for the question resolves to the same exercise
  const viaPicker = runAnalysis(D(["CBC_TASKS"], { burnIn: 100, draws: 100 }), study.ds);
  assert.ok(viaPicker.tables.some((t) => t.id === "hb_diagnostics"), JSON.stringify(viaPicker.error));
  const wrong = runAnalysis(D(["U1"]), study.ds);
  assert.ok(wrong.error && /CBC or MaxDiff/.test(wrong.error.message), JSON.stringify(wrong.error));
  // the synchronous runner never returns a partial run
  const slow = runAnalysis(D(["CBC"], { burnIn: 50_000, draws: 50_000, timeBudgetMs: 200 }), study.ds);
  assert.ok(slow.error && /needs about \d+ s/.test(slow.error.message) && /background job/.test(slow.error.message), JSON.stringify(slow.error));
  assert.equal(slow.tables.length, 0);
});

test("inverse-Wishart draws have the right mean; the effects prior gives every level equal variance", () => {
  const rng = new Rng(5); const p = 3, df = 20; const Psi = Float64Array.from([4, 1, 0, 1, 3, 0.5, 0, 0.5, 2]);
  const acc = new Float64Array(9); const R = 8000;
  for (let i = 0; i < R; i++) { const S = drawInvWishart(rng, df, Psi, p)!; for (let k = 0; k < 9; k++) acc[k] += S[k] / R; }
  for (let k = 0; k < 9; k++) assert.ok(Math.abs(acc[k] - Psi[k] / (df - p - 1)) < 0.01, `E[Σ]_${k} ${acc[k]} vs ${Psi[k] / (df - p - 1)}`);
  // an attribute with 3 levels (2 coded columns): every level's implied variance = 2/3
  const S = effectsPriorShape(3, [[0, 1]]);
  const v = (row: number[]) => row.reduce((t, a, i) => t + row.reduce((u, b, j) => u + a * S[i * 3 + j] * b, 0), 0);
  assert.ok(Math.abs(v([1, 0, 0]) - 2 / 3) < 1e-12 && Math.abs(v([0, 1, 0]) - 2 / 3) < 1e-12 && Math.abs(v([-1, -1, 0]) - 2 / 3) < 1e-12);
  assert.equal(S[8], 1, "the None column keeps prior variance 1");
});
