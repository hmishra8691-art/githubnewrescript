import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataset } from "../dataset.js";
import { runAnalysis } from "./index.js";
import { segmentBases } from "./common.js";
import type { AnalysisDefinition } from "../types.js";
import { def, rule, synthRows } from "./fixture.js";

const dsSpec = { environment: "LIVE" as const, dataset: "all" as const };
const SEGS = [{ id: "m", name: "Men", condition: rule("q_gender", 1) }, { id: "f", name: "Women", condition: rule("q_gender", 2) }];
const D = (kind: AnalysisDefinition["kind"], variables: string[], extra: Partial<AnalysisDefinition> = {}): AnalysisDefinition => ({ name: kind, kind, dataset: dsSpec, variables, ...extra });

test("segmentBases: warns below 30, names the first three, and hides only on request", () => {
  const mk = (name: string, n: number) => ({ name, n, chart: { categories: ["a"], series: [{ name, values: [1] }] } });
  const none = segmentBases([mk("A", 120), mk("B", 80)]);
  assert.equal(none.warning, null);
  const warn = segmentBases([mk("A", 120), mk("B", 12), mk("C", 5), mk("D", 3), mk("E", 2)]);
  assert.match(warn.warning!, /^Segments B \(n = 12\), C \(n = 5\), D \(n = 3\) and 1 more have fewer than 30 respondents — read with caution\.$/);
  assert.ok(warn.segments!.every((x) => x.chart.series), "warning only: every segment keeps its values");
  const hide = segmentBases([mk("A", 120), mk("B", 40)], 50);
  assert.match(hide.warning!, /below the minimum base of 50 are not shown/);
  assert.deepEqual(hide.segments!.map((x) => Object.keys(x.chart).length > 0), [true, false], "only the segment under 50 is hidden");
  const both = segmentBases([mk("A", 55), mk("B", 40)], 60);
  assert.deepEqual(both.segments!.map((x) => Object.keys(x.chart).length), [0, 0]);
  assert.match(segmentBases([mk("A", 0), mk("B", 50)]).warning!, /Segment A has no respondents\./);
});

test("a descriptive result warns about thin segments, and hides them under minBase", () => {
  const small = buildDataset(def, synthRows(40), { spec: dsSpec });
  const r = runAnalysis(D("descriptive", ["SAT"], { segments: SEGS }), small);
  assert.ok(r.segments!.length === 2 && r.segments!.every((x) => x.n < 30));
  assert.ok(r.warnings.some((w) => /^Segments Men \(n = \d+\), Women \(n = \d+\) have fewer than 30 respondents/.test(w)), r.warnings.join("|"));
  assert.ok(r.segments!.every((x) => x.chart.series?.length), "kept by default");
  const hidden = runAnalysis(D("descriptive", ["SAT"], { segments: SEGS, options: { minBase: 30 } }), small);
  assert.ok(hidden.segments!.every((x) => !x.chart.series), "hidden under a minimum base");
  const big = runAnalysis(D("descriptive", ["SAT"], { segments: SEGS }), buildDataset(def, synthRows(400), { spec: dsSpec }));
  assert.ok(!big.warnings.some((w) => /Segment/.test(w)));
});

import { chartDecimals } from "../chartFormat.js";
import { displayDecimals } from "../story/charts.js";

test("one decimals rule: the story player's labels use the same rule as the browser chart and the PowerPoint", () => {
  const cases: { valueFormat: "pct" | "mean" | "number" | "count"; values: number[]; want: number }[] = [
    { valueFormat: "pct", values: [12.4, 55.6, 32], want: 0 },
    { valueFormat: "mean", values: [3.8, 4.2], want: 1 },
    { valueFormat: "number", values: [0.3, 0.7], want: 1 },            // the story used to draw these with two decimals, the chart with one
    { valueFormat: "number", values: [153.4, 210.9], want: 1 },        // …and these with none
    { valueFormat: "number", values: [3.84, 3.81], want: 2 },          // one decimal would draw both as 3.8
    { valueFormat: "number", values: [4, 7, 12], want: 0 },
  ];
  for (const c of cases) {
    const data = { valueFormat: c.valueFormat, series: [{ name: "s", values: c.values }] };
    const browser = chartDecimals({ valueFormat: c.valueFormat === "pct" ? "pct" : undefined, categories: [], series: data.series } as never);
    assert.equal(browser, c.want, `browser ${c.valueFormat} ${c.values}`);
    assert.equal(displayDecimals(data, 0), c.want, `story ${c.valueFormat} ${c.values}`);
  }
  assert.equal(displayDecimals({ valueFormat: "mean", series: [{ name: "s", values: [3.8] }] }, 2), 2, "a design that asks for more keeps it");
  assert.equal(chartDecimals({ valueFormat: undefined, categories: [], series: [{ name: "s", values: [3.84, 3.81] }] } as never, 1), 1, "what the researcher set on the chart is never overridden");
});

import { methodFlag, versionBefore, ANALYTICS_ENGINE_VERSION, NUMBERS_CORRECTED_IN } from "../provenance.js";

test("old reports are flagged, never rewritten: a result with no recorded method, or an engine before the corrected numbers, raises the flag", () => {
  const rec = (v: string) => ({ provenance: { engineVersion: v } as never });
  assert.equal(methodFlag({ a: rec(ANALYTICS_ENGINE_VERSION), b: rec(NUMBERS_CORRECTED_IN) }), null, "the corrected engine, and later, is not flagged");
  assert.ok(methodFlag({ a: rec("2026.10.2") }), "the engine before this one is flagged");
  const none = methodFlag({ a: {}, b: {} })!;
  assert.equal(none.count, 2); assert.match(none.text, /^These numbers were computed with an earlier method \(the result records none\)\./);
  const some = methodFlag({ a: rec(ANALYTICS_ENGINE_VERSION), b: {}, c: rec("2026.9.4") })!;
  assert.equal(some.count, 2); assert.equal(some.total, 3); assert.match(some.text, /^2 of 3 analyses were computed with an earlier method\./);
  assert.equal(methodFlag({}), null);
  assert.ok(versionBefore("2026.9.9", "2026.10.1") && !versionBefore("2026.10.2", "2026.10.1") && !versionBefore("2026.10.1", "2026.10.1") && versionBefore("2026.10", "2026.10.1"));
});

/* ---------------------------------------------------------------- S-8 */
const ds400 = buildDataset(def, synthRows(400), { spec: dsSpec });
const XT7 = (extra: Partial<AnalysisDefinition>): AnalysisDefinition => ({ name: "xt", kind: "crosstab", dataset: dsSpec, variables: [], rows: ["REGION"], columns: ["GENDER"], ...extra });

test("S-8: a mean of unordered categories is refused with the reason, not computed (REGION used to 'average' 1.97)", () => {
  const r = runAnalysis(XT7({ measure: "mean" }), ds400);
  assert.equal(r.error?.code, "not_computable");
  assert.match(r.error!.message, /A mean needs a numeric or scale variable, and “[^”]+” is a set of unordered categories\./);
  assert.equal(r.tables.length, 0);
  const ok = runAnalysis(XT7({ rows: ["AGE"], measure: "mean" }), ds400);
  assert.equal(ok.error, undefined, "a numeric row still gets its mean");
  const scale = runAnalysis(XT7({ rows: ["SAT"], measure: "mean" }), ds400);
  assert.equal(scale.error, undefined, "so does an ordered scale");
});

test("S-8: summary rows are skipped, with a warning, for a nominal row variable and kept for a scale", () => {
  const nominal = runAnalysis(XT7({ rows: ["REGION"], options: { summaryRows: ["mean", "top2"] } }), ds400);
  assert.ok(!nominal.tables[0].rows.some((x) => x.__kind === "summary"));
  assert.ok(nominal.warnings.some((w) => /Summary rows \(mean, top2\) are not shown/.test(w)));
  const scale = runAnalysis(XT7({ rows: ["SAT"], options: { summaryRows: ["mean", "top2"] } }), ds400);
  assert.ok(scale.tables[0].rows.some((x) => x.__kind === "summary"));
});

test("S-8: a linear regression on a nominal outcome, or a mediation through a nominal mediator, is refused; a two-group predictor is fine", () => {
  const lin = runAnalysis({ name: "r", kind: "regression", dataset: dsSpec, variables: ["REGION", "SAT"], options: { model: "linear" } }, ds400);
  assert.equal(lin.error?.code, "not_computable");
  assert.match(lin.error!.message, /Linear regression needs numeric or scale variables, and “[^”]+” is categorical\. Use logistic regression/);
  const med = runAnalysis({ name: "m", kind: "regression", dataset: dsSpec, variables: ["NPS", "SAT", "REGION"], options: { model: "mediation" } }, ds400);
  assert.equal(med.error?.code, "not_computable");
  const ok = runAnalysis({ name: "m", kind: "regression", dataset: dsSpec, variables: ["NPS", "GENDER", "SAT"], options: { model: "mediation" } }, ds400);
  assert.equal(ok.error, undefined);
});

test("S-10: running NPS on the 1–5 satisfaction item is refused with the reason; the 0–10 item still works", () => {
  const bad = runAnalysis({ name: "n", kind: "nps", dataset: dsSpec, variables: ["SAT"] }, ds400);
  assert.equal(bad.error?.code, "not_computable");
  assert.match(bad.error!.message, /needs the 0–10 likelihood-to-recommend question/);
  const good = runAnalysis({ name: "n", kind: "nps", dataset: dsSpec, variables: ["NPS"] }, ds400);
  assert.equal(good.error, undefined);
  assert.ok(good.tables[0].rows.some((x) => x.m === "NPS" && typeof x.v === "number"));
});

import { orderPeriods } from "./business.js";
test("S-11: trend periods come in the order they happened — wave 10 after wave 2, a code frame's own order, dates as dates", () => {
  assert.deepEqual(orderPeriods(["1", "10", "11", "2", "9"]), ["1", "2", "9", "10", "11"]);
  assert.deepEqual(orderPeriods(["wave_b", "wave_a", "wave_c"], [{ code: "wave_c" }, { code: "wave_a" }, { code: "wave_b" }]), ["wave_c", "wave_a", "wave_b"]);
  assert.deepEqual(orderPeriods(["2026-10", "2026-02", "2026-09"]), ["2026-02", "2026-09", "2026-10"]);
  assert.deepEqual(orderPeriods(["-3", "5", "0.5"]), ["-3", "0.5", "5"]);
  assert.deepEqual(orderPeriods([]), []);
});
test("S-11: grouping 40,000 cases into periods is quick (the copy per case made it quadratic)", () => {
  const big = buildDataset(def, synthRows(2000), { spec: dsSpec });
  const base = big.cases; const many: typeof base = [];
  for (let i = 0; i < 20; i++) for (const c of base) many.push({ ...c, vars: { ...c.vars, _started_month: `2026-${String(1 + (i % 12)).padStart(2, "0")}` } });
  const t0 = Date.now();
  const r = runAnalysis({ name: "t", kind: "trend", dataset: dsSpec, variables: ["SAT"], options: { period: "_started_month", metric: "mean" } }, { ...big, cases: many });
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  assert.equal(r.error, undefined);
});

/* ---------------------------------------------------------------- S-12: CSAT vs CES, Gabor-Granger */
const shareOf = (vals: unknown[], pick: (n: number) => boolean) => { const xs = vals.map(Number).filter(Number.isFinite); return (xs.filter(pick).length / xs.length) * 100; };

test("S-12: CES is an effort score, not CSAT under another name — different headline, label and, with lowIsEasy, a different box", () => {
  const cs = runAnalysis({ name: "c", kind: "csat", dataset: dsSpec, variables: ["SAT"], options: { metric: "csat" } }, ds400);
  const ce = runAnalysis({ name: "c", kind: "csat", dataset: dsSpec, variables: ["SAT"], options: { metric: "ces" } }, ds400);
  assert.match(cs.insights[0], /^CSAT for .*: \d+% satisfied \(top-2 box\)/);
  assert.match(ce.insights[0], /^CES for .*: mean [\d.]+ .*found it easy \(top-2 box\)/);
  assert.notEqual(cs.insights[0], ce.insights[0]);
  const low = runAnalysis({ name: "c", kind: "csat", dataset: dsSpec, variables: ["SAT"], options: { metric: "ces", lowIsEasy: true } }, ds400);
  const row = (r: ReturnType<typeof runAnalysis>) => r.tables[0].rows[0].score as number;
  assert.notEqual(row(low), row(ce), "the bottom box is not the top box");
  assert.match(low.tables[0].columns.find((c) => c.key === "score")!.label, /bottom-2/);
  const sat = ds400.cases.map((c) => c.vars.SAT);
  assert.ok(Math.abs(row(cs) - shareOf(sat, (n) => n >= 4)) < 0.2, "CSAT is the top-2 share");
  assert.ok(Math.abs(row(low) - shareOf(sat, (n) => n <= 2)) < 0.2, "lowIsEasy is the bottom-2 share");
});

test("S-12: Gabor-Granger counts the top two points of an intent scale as 'would buy' — code 1 ('definitely not') is not acceptance", () => {
  const gg = runAnalysis({ name: "g", kind: "pricing", dataset: dsSpec, variables: ["ITEMS_a", "ITEMS_b"], options: { method: "gabor_granger", prices: [10, 20] } }, ds400);
  assert.equal(gg.error, undefined);
  const rows = gg.tables[0].rows;
  const expectedA = shareOf(ds400.cases.map((c) => c.vars.ITEMS_a), (n) => n >= 4);
  assert.ok(Math.abs((rows.find((r) => r.price === 10)!.probability as number) - expectedA) < 0.2, `${rows[0].probability} vs ${expectedA}`);
  const ones = shareOf(ds400.cases.map((c) => c.vars.ITEMS_a), (n) => n === 1);
  assert.ok(ones > 0, "the fixture has 1s, so this test would catch counting them");
});

/* ---------------------------------------------------------------- S-13: one base */
test("S-13: a multi-select left empty is no answer in every runner — descriptive and crosstab report the same base", () => {
  const d = buildDataset(def, synthRows(300), { spec: dsSpec });
  for (let i = 0; i < 30; i++) d.cases[i].vars.AWARE = [];
  for (let i = 30; i < 45; i++) d.cases[i].vars.AWARE = null;
  const desc = runAnalysis({ name: "d", kind: "descriptive", dataset: dsSpec, variables: ["AWARE"] }, d);
  const xt = runAnalysis({ name: "x", kind: "crosstab", dataset: dsSpec, variables: [], rows: ["AWARE"], columns: ["GENDER"] }, d);
  assert.equal(xt.base.n, desc.base.n, `crosstab ${xt.base.n} vs descriptive ${desc.base.n}`);
  assert.ok(desc.base.n <= 255);
});

test("S-13: a zero-weight respondent is not a case in the crosstab either (it was counted there and not in descriptive)", () => {
  const d = buildDataset(def, synthRows(300), { spec: dsSpec });
  d.weighted = true;
  d.cases.forEach((c, i) => { c.weight = i < 40 ? 0 : 1; });
  const desc = runAnalysis({ name: "d", kind: "descriptive", dataset: dsSpec, variables: ["SAT"] }, d);
  const xt = runAnalysis({ name: "x", kind: "crosstab", dataset: dsSpec, variables: [], rows: ["SAT"], columns: ["GENDER"] }, d);
  assert.equal(xt.base.n, desc.base.n, `crosstab ${xt.base.n} vs descriptive ${desc.base.n}`);
  assert.ok(xt.base.n <= 260);
});

/* ---------------------------------------------------------------- I-2: the largest gap is a real one */
const stream7 = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const hasGap = (r: ReturnType<typeof runAnalysis>) => r.insights.some((x) => /^Largest gap/.test(x));

test("I-2: null data does not produce a 'largest gap'; the unadjusted option still does most of the time", () => {
  const dsb = buildDataset(def, synthRows(600, 5), { spec: dsSpec });
  const R = stream7(77);
  let withGap = 0, rawWithGap = 0; const reps = 120;
  for (let rep = 0; rep < reps; rep++) {
    for (const c of dsb.cases) { c.vars.COUNTRY = String(1 + Math.floor(R() * 8)); c.vars.SAT = String(1 + Math.floor(R() * 5)); }
    if (hasGap(runAnalysis(XT7({ rows: ["SAT"], columns: ["COUNTRY"] }), dsb))) withGap++;
    if (hasGap(runAnalysis(XT7({ rows: ["SAT"], columns: ["COUNTRY"], options: { correction: "none" } }), dsb))) rawWithGap++;
  }
  assert.ok(withGap / reps <= 0.1, `a gap on ${withGap} of ${reps} null tables`);
  assert.ok(rawWithGap / reps > 0.3, `without the adjustment it appears on ${rawWithGap} of ${reps}`);
});

test("I-2: a planted difference is still reported, with the adjustment named; a thin column is never the largest gap", () => {
  const planted = buildDataset(def, synthRows(600, 5), { spec: dsSpec });
  planted.cases.forEach((c, i) => { c.vars.GENDER = i % 2 ? "1" : "2"; c.vars.SAT = i % 2 ? (i % 10 < 8 ? "5" : "3") : (i % 10 < 2 ? "5" : "3"); });
  const r = runAnalysis(XT7({ rows: ["SAT"], columns: ["GENDER"] }), planted);
  assert.ok(r.insights.some((x) => /^Largest gap: .*significant after Holm adjustment/.test(x)), r.insights.join(" | "));
  const thin = buildDataset(def, synthRows(40), { spec: dsSpec });
  assert.ok(!hasGap(runAnalysis(XT7({ rows: ["SAT"], columns: ["REGION"] }), thin)), "columns under 30 respondents are not compared");
});

/* ---------------------------------------------------------------- S-6 */
test("S-6: a weighted study's tests and models say they ignore the weights, and no longer imply they used them", () => {
  const w = buildDataset(def, synthRows(300), { spec: dsSpec });
  w.weighted = true; w.cases.forEach((c, i) => { c.weight = i % 3 === 0 ? 3 : 0.5; });
  w.weightInfo = { efficiency: 55, designEffect: 1.8 } as never;
  const t = runAnalysis({ name: "t", kind: "test", dataset: dsSpec, variables: ["SAT", "GENDER"] }, w);
  assert.ok(t.warnings.some((x) => /^The study is weighted, but this test is computed without the weights/.test(x)), t.warnings.join("|"));
  assert.ok(!t.warnings.some((x) => /Weighting efficiency/.test(x)), "no 'effective sample size is reduced' line on a result that ignored them");
  const r = runAnalysis({ name: "r", kind: "regression", dataset: dsSpec, variables: ["NPS", "SAT"] }, w);
  assert.ok(r.warnings.some((x) => /this model is computed without the weights/.test(x)));
  const d = runAnalysis({ name: "d", kind: "descriptive", dataset: dsSpec, variables: ["SAT"] }, w);
  assert.ok(!d.warnings.some((x) => /without the weights/.test(x)), "a weighted analysis is not labelled");
  assert.ok(d.warnings.some((x) => /Weighting efficiency/.test(x)));
  const plain = runAnalysis({ name: "t", kind: "test", dataset: dsSpec, variables: ["SAT", "GENDER"] }, ds400);
  assert.ok(!plain.warnings.some((x) => /without the weights/.test(x)), "an unweighted study has nothing to say");
});

test("C-10: label colour is chosen by contrast, not always white", async () => {
  const { readableOn, contrastRatio, THEME_PRESETS } = await import("../themes.js");
  assert.equal(readableOn("#ffffff"), "#111827");
  assert.equal(readableOn("#1f2937"), "#ffffff");
  for (const p of THEME_PRESETS) for (const c of p.colors.palette) {
    const label = readableOn(c);
    assert.ok(contrastRatio(label, c) >= 3, `${p.name}: label on ${c} should reach 3:1, got ${contrastRatio(label, c).toFixed(2)}`);
  }
});

/* ---------------------------------------------------------------- D-1, D-2 */
test("D-2: a two-variable correlation reports its interval in the table, the insight and the test detail", () => {
  const r = runAnalysis({ name: "c", kind: "correlation", dataset: dsSpec, variables: ["SAT", "NPS"] }, ds400);
  assert.equal(r.error, undefined);
  const row = r.tables[0].rows[0] as { ci: string };
  assert.match(row.ci, /^-?\d\.\d\d to -?\d\.\d\d$/);
  assert.match(r.insights[0], /95% CI -?\d\.\d\d to -?\d\.\d\d/);
  assert.ok(Array.isArray((r.tests?.[0]?.detail as { ci95?: number[] } | undefined)?.ci95));
  const m = runAnalysis({ name: "c", kind: "correlation", dataset: dsSpec, variables: ["SAT", "NPS", "AGE"] }, ds400);
  const pairs = m.tables.find((t) => t.id === "corr_pairs")!;
  assert.ok(pairs.columns.some((c) => c.key === "ci"));
  assert.ok(pairs.rows.every((x) => /to/.test(String((x as { ci: string }).ci))));
});

test("D-1: the trend test runs through the test analysis, reports a direction, and refuses a category that is not an answer", () => {
  const r = runAnalysis({ name: "t", kind: "test", dataset: dsSpec, variables: ["SAT", "GENDER"], options: { test: "trend_proportion" } }, ds400);
  assert.equal(r.error, undefined, r.error?.message);
  const t = r.tests?.find((x) => x.test === "trend_proportion");
  assert.ok(t && t.statistic != null && t.p != null);
  assert.ok(r.insights.some((x) => /Cochran–Armitage z = /.test(x)));
  const bad = runAnalysis({ name: "t", kind: "test", dataset: dsSpec, variables: ["SAT", "GENDER"], options: { test: "trend_proportion", category: "nope" } }, ds400);
  assert.equal(bad.error?.code, "not_computable");
});

test("F-3: conjoint and MaxDiff on a very large study finish quickly, say they were fitted on a sample, and converge", () => {
  const big = buildDataset(def, synthRows(30_000), { spec: dsSpec });
  for (const [kind, v] of [["conjoint", "CBC"], ["maxdiff", "MD"]] as const) {
    const t0 = Date.now();
    const r = runAnalysis({ name: kind, kind, dataset: dsSpec, variables: [v] }, big);
    const ms = Date.now() - t0;
    assert.equal(r.error, undefined, r.error?.message);
    assert.ok(ms < 20_000, `${kind} took ${ms} ms on 30,000 respondents`);
    assert.ok(r.warnings.some((w) => /fitted on every second respondent/.test(w)), `${kind}: sampling is stated`);
    assert.ok(!r.warnings.some((w) => /did not fully converge/.test(w)), `${kind}: converges on a large sample`);
  }
});
