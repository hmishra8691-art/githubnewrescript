import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { buildDataset, type AnalyticsRow } from "../dataset.js";
import { runAnalysis } from "./index.js";
import { ladderDemand, nmsAnalysis, nmsCalibrationFor, nmsProbability, vanWestendorpCurves, vanWestendorpPoints, type NmsRow } from "./pricingModels.js";

/*
 * S5c — REFERENCE VALUES, computed by hand (and re-checked with an independent script) — never "it runs".
 *
 * VAN WESTENDORP on six respondents (too cheap, cheap, expensive, too expensive):
 *   (5,10,12,20) (8,12,15,25) (10,14,18,30) (6,9,11,16) (12,15,20,28) (4,8,10,14)
 * Curves at the grid prices that matter (%):
 *   p    tooCheap  cheap  expensive  tooExp  notCheap  notExp
 *   9     33.33    83.33     0         0      16.67    100
 *   10    33.33    66.67    16.67      0      33.33    83.33
 *   11    16.67    50       33.33      0      50       66.67
 *   12    16.67    50       50         0      50       50
 *   14     0       33.33    50        16.67   66.67    50
 *   15     0       16.67    66.67     16.67   83.33    33.33
 *   16     0        0       66.67     33.33  100       33.33
 * proxy:    PMC tooCheap∩expensive: +16.67 at 10, −16.67 at 11 → 10.5;  PME cheap∩tooExp: equal at 15 → 15
 * textbook: PMC tooCheap∩notCheap: equal at 10 → 10;                    PME tooExp∩notExp: equal at 16 → 16
 * OPP tooCheap∩tooExp: +16.67 at 12, −16.67 at 14 → 13;  IPP cheap∩expensive: equal at 12 → 12
 */
const VW = [[5, 10, 12, 20], [8, 12, 15, 25], [10, 14, 18, 30], [6, 9, 11, 16], [12, 15, 20, 28], [4, 8, 10, 14]].map(([tooCheap, cheap, expensive, tooExpensive]) => ({ tooCheap, cheap, expensive, tooExpensive }));

test("Van Westendorp: proxy and textbook end-points against the hand-computed curves", () => {
  const curves = vanWestendorpCurves(VW);
  const at = (p: number) => curves.find((c) => c.price === p)!;
  assert.deepEqual([at(10).tooCheap, at(10).expensive, at(10).notCheap].map((x) => Math.round(x * 100) / 100), [33.33, 16.67, 33.33]);
  assert.equal(Math.round(at(16).notExpensive * 100) / 100, 33.33);
  const proxy = vanWestendorpPoints(curves, "proxy");
  assert.deepEqual(proxy, { pmc: 10.5, pme: 15, opp: 13, ipp: 12 });
  const textbook = vanWestendorpPoints(curves, "textbook");
  assert.deepEqual(textbook, { pmc: 10, pme: 16, opp: 13, ipp: 12 });
});

/*
 * NMS on two respondents, default calibration (top box 0.7, second 0.5):
 *   R1 TC 5, C 10, E 20, TE 30, pCheap 0.7, pExp 0.5    R2 TC 10, C 15, E 25, TE 40, pCheap 0.5, pExp 0.5
 *   price   R1      R2      trial    revenue = p × trial
 *   5       0       0       0        0
 *   10      0.7     0       0.35     3.5
 *   15      0.6     0.5     0.55     8.25     ← trial optimum
 *   20      0.5     0.5     0.5      10       ← revenue optimum (the 20→25 parabola's vertex is at 20)
 *   25      0.25    0.5     0.375    9.375
 *   30      0       1/3     1/6      5
 *   40      0       0       0        0
 */
const NMS: NmsRow[] = [
  { tooCheap: 5, cheap: 10, expensive: 20, tooExpensive: 30, pCheap: 0.7, pExpensive: 0.5 },
  { tooCheap: 10, cheap: 15, expensive: 25, tooExpensive: 40, pCheap: 0.5, pExpensive: 0.5 },
];

test("Newton–Miller–Smith: per-respondent probability, trial and revenue optima match the hand computation", () => {
  assert.equal(nmsProbability(NMS[0], 15), 0.6);
  assert.equal(nmsProbability(NMS[0], 25), 0.25);
  assert.ok(Math.abs(nmsProbability(NMS[1], 30) - 1 / 3) < 1e-12);
  assert.equal(nmsProbability(NMS[0], 5), 0, "at too cheap: 0");
  assert.equal(nmsProbability(NMS[0], 31), 0, "above too expensive: 0");
  const r = nmsAnalysis(NMS);
  const trial = Object.fromEntries(r.curve.map((c) => [c.price, Math.round(c.trial * 1e6) / 1e6]));
  assert.deepEqual(trial, { 5: 0, 10: 0.35, 15: 0.55, 20: 0.5, 25: 0.375, 30: 0.166667, 40: 0 });
  assert.equal(r.trialOptimum!.price, 15);
  assert.equal(r.revenueOptimum!.price, 20);
  assert.equal(r.revenueOptimum!.revenue, 10);
});

test("NMS revenue optimum inside a segment: the parabola's vertex, not a grid price", () => {
  /* one respondent: TC 0, C 10 (p 1), E 30 (p 0), TE 40 → between 10 and 30, T(p) = 1 − (p−10)/20, p·T(p) peaks at p = 15 (revenue 11.25) */
  const r = nmsAnalysis([{ tooCheap: 0, cheap: 10, expensive: 30, tooExpensive: 40, pCheap: 1, pExpensive: 0 }]);
  assert.equal(r.revenueOptimum!.price, 15);
  assert.equal(r.revenueOptimum!.revenue, 11.25);
});

test("NMS calibration: the 5-point default top box first, an explicit map, and refusals in words", () => {
  const m = nmsCalibrationFor([1, 2, 3, 4, 5]) as Map<number, number>;
  assert.deepEqual([...m.entries()], [[5, 0.7], [4, 0.5], [3, 0.3], [2, 0.1], [1, 0]]);
  assert.match(String(nmsCalibrationFor([1, 2, 3])), /3 points; the default calibration is for 5/);
  assert.match(String(nmsCalibrationFor([1, 2], { 1: 0.2 })), /no probability for code 2/);
  assert.match(String(nmsCalibrationFor([1, 2], { 1: 0.2, 2: 7 })), /0–1/);
});

/* adaptive Gabor–Granger: highest accepted price per respondent on the ladder 10/15/20/25 (0 = none):
 *   [25, 20, 15, 15, 10, 0, null, 20]  → base 7 (null = not asked)
 *   demand 10: 6/7 = 85.71 %, 15: 5/7 = 71.43 %, 20: 3/7 = 42.86 %, 25: 1/7 = 14.29 %
 *   revenue 8.571, 10.714 (max), 8.571, 3.571 */
test("adaptive Gabor–Granger: demand and revenue from the highest accepted price", () => {
  const r = ladderDemand([25, 20, 15, 15, 10, 0, null, 20], [20, 10, 25, 15]);
  assert.equal(r.n, 7);
  assert.deepEqual(r.rows.map((x) => x.price), [10, 15, 20, 25]);
  assert.deepEqual(r.rows.map((x) => Math.round(x.demand * 100) / 100), [85.71, 71.43, 42.86, 14.29]);
  assert.deepEqual(r.rows.map((x) => Math.round(x.revenue * 1000) / 1000), [8.571, 10.714, 8.571, 3.571]);
});

/* the same numbers through runAnalysis: the pricing analysis reads the stored answers */
const def = SurveyDefinition.parse({
  meta: { id: "p", code: "P", title: "Pricing", version: "1.0" },
  questions: [
    ...["TC", "C", "E", "TE"].map((v) => ({ id: `q_${v}`, code: v, variableName: v, type: "numeric", text: v })),
    ...["NMS_C", "NMS_E"].map((v) => ({ id: `q_${v}`, code: v, variableName: v, type: "single_select", text: v, options: [5, 4, 3, 2, 1].map((c) => ({ code: c, label: ["", "Definitely not", "Probably not", "Might or might not", "Probably would", "Definitely would"][c] })) })),
  ],
  flow: [],
});
const row = (i: number, a: Record<string, unknown>): AnalyticsRow => ({ id: `r${i}`, session_id: `s${i}`, status: "complete", answers: a, calculated: {}, embedded: {}, flags: [] });
const spec = { environment: "LIVE" as const, dataset: "all" as const };

test("pricing analysis: textbook option, NMS tables and the proxy note, end to end", () => {
  const rows = VW.map((r, i) => row(i, { q_TC: r.tooCheap, q_C: r.cheap, q_E: r.expensive, q_TE: r.tooExpensive }));
  const ds = buildDataset(def, rows, { spec });
  const proxy = runAnalysis({ name: "vw", kind: "pricing", dataset: spec, variables: ["TC", "C", "E", "TE"] }, ds);
  const v = (res: typeof proxy, m: RegExp) => res.tables[0].rows.find((r) => m.test(String(r.m)))!.v;
  assert.equal(v(proxy, /PMC/), 10.5);
  assert.equal(v(proxy, /PME/), 15);
  assert.match(proxy.tables[0].notes![0], /PROXY definition.*textbook.*are 10 and 16\./);
  const tb = runAnalysis({ name: "vw", kind: "pricing", dataset: spec, variables: ["TC", "C", "E", "TE"], options: { vwCurves: "textbook" } }, ds);
  assert.equal(v(tb, /PMC/), 10);
  assert.equal(v(tb, /PME/), 16);
  assert.equal(v(tb, /OPP/), 13);

  const nRows = [row(0, { q_TC: 5, q_C: 10, q_E: 20, q_TE: 30, q_NMS_C: 5, q_NMS_E: 4 }), row(1, { q_TC: 10, q_C: 15, q_E: 25, q_TE: 40, q_NMS_C: 4, q_NMS_E: 4 })];
  const nms = runAnalysis({ name: "nms", kind: "pricing", dataset: spec, variables: ["TC", "C", "E", "TE"], options: { nmsCheap: "NMS_C", nmsExpensive: "NMS_E" } }, buildDataset(def, nRows, { spec }));
  const opt = nms.tables.find((t) => t.id === "nms_optimum")!;
  assert.deepEqual(opt.rows.map((r) => [r.price, r.trial, r.revenue]), [[15, 55, 8.25], [20, 50, 10]]);
  assert.ok(nms.variablesUsed.includes("NMS_E"));
  const bad = runAnalysis({ name: "nms", kind: "pricing", dataset: spec, variables: ["TC", "C", "E", "TE"], options: { nmsCheap: "NMS_C" } }, buildDataset(def, nRows, { spec }));
  assert.ok(bad.warnings.some((w) => /needs both likelihood questions/.test(w)));
});

/* the adaptive ladder through runAnalysis: the same eight answers as the ladderDemand reference above */
test("pricing analysis, gabor_granger ladder: demand and revenue from the stored highest accepted price", () => {
  const ldef = SurveyDefinition.parse({ meta: { id: "l", code: "L", title: "L", version: "1.0" }, questions: [{ id: "q_l", code: "PRICE_LADDER", variableName: "PRICE_LADDER", type: "numeric", variant: "numeric.price_ladder", text: "x", settings: { minValue: 0, maxValue: 25, priceLadder: { prices: [10, 15, 20, 25] } } }], flow: [] });
  const rows = [25, 20, 15, 15, 10, 0, null, 20].map((v, i) => row(i, v == null ? {} : { q_l: v }));
  const res = runAnalysis({ name: "gg", kind: "pricing", dataset: spec, variables: ["PRICE_LADDER"], options: { method: "gabor_granger", ladder: true, prices: [10, 15, 20, 25] } }, buildDataset(ldef, rows, { spec }));
  assert.deepEqual(res.tables[0].rows.map((r) => [r.price, r.probability, r.revenue]), [[10, 85.7, 8.57], [15, 71.4, 10.71], [20, 42.9, 8.57], [25, 14.3, 3.57]]);
  assert.equal(res.tables[0].base?.n, 7);
  assert.match(res.insights[0], /Revenue-maximising price on the ladder: 15/);
  const none = runAnalysis({ name: "gg", kind: "pricing", dataset: spec, variables: ["PRICE_LADDER"], options: { method: "gabor_granger", ladder: true } }, buildDataset(ldef, rows, { spec }));
  assert.ok(none.error || none.warnings.some((w) => /needs the ladder's prices/.test(w)));
});
