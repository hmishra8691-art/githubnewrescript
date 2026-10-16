/**
 * Controlled dataset audit for @rescript/analytics.
 * Builds a small survey (single, multi, numeric, matrix single, numeric with displayLogic hiding it for half the sample),
 * 40 synthetic responses (30 complete, 10 partial) with KNOWN distributions, runs the package's runners from dist,
 * and compares each number to expected values computed in plain JS here.
 */
import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import * as A from "/home/claude/rescript/packages/analytics/dist/index.js";

const mism = [];
const ok = [];
function check(fn, what, got, exp, tol = 1e-6) {
  const g = typeof got === "number" ? got : got == null ? null : Number(got);
  const e = typeof exp === "number" ? exp : exp == null ? null : Number(exp);
  const pass = g == null && e == null ? true : g == null || e == null ? false : Math.abs(g - e) <= tol;
  (pass ? ok : mism).push({ fn, what, got, exp });
}

/* ---------------------------------------------------------------- survey */
const def = SurveyDefinition.parse({
  meta: { id: "ctl", code: "CTL", title: "Controlled", version: "1.0" },
  questions: [
    { id: "q_gender", code: "Q1", variableName: "GENDER", type: "single_select", text: "Gender", options: [{ code: 1, label: "Male" }, { code: 2, label: "Female" }] },
    { id: "q_brands", code: "Q2", variableName: "AWARE", type: "multi_select", text: "Aware", options: [{ code: 1, label: "Alpha" }, { code: 2, label: "Beta" }, { code: 3, label: "Gamma" }] },
    { id: "q_age", code: "Q3", variableName: "AGE", type: "numeric", text: "Age" },
    { id: "q_items", code: "Q4", variableName: "ITEMS", type: "matrix_single", text: "Rate", rows: [{ code: "a", label: "Quality" }, { code: "b", label: "Value" }], options: [1, 2, 3, 4, 5].map((c) => ({ code: c, label: `${c}` })) },
    // asked only of males (display logic) — half the sample
    { id: "q_spend", code: "Q5", variableName: "SPEND", type: "numeric", text: "Spend (males only)", displayLogic: { type: "rule", source: { kind: "question", ref: "q_gender" }, operator: "eq", value: 1 } },
    { id: "q_sat", code: "Q6", variableName: "SAT", type: "single_select", text: "Satisfaction", options: [1, 2, 3, 4, 5].map((c) => ({ code: c, label: `${c}` })) },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q_gender", "q_brands", "q_age", "q_items", "q_spend", "q_sat"] }],
});

/* ---------------------------------------------------------------- responses (deterministic) */
// 40 rows: i = 0..39. Even i = male (1), odd i = female (2). 0..29 complete, 30..39 in_progress (partial).
// AWARE: everyone picks Alpha; i%2===0 also picks Beta; i%4===0 also picks Gamma. i%10===9 -> empty array (no answer).
// AGE: 20 + i (for complete rows); partial rows: AGE missing for i>=35.
// ITEMS: a = 1 + (i % 5), b = 5 - (i % 5). i % 7 === 6 -> ITEMS row 'b' missing.
// SPEND: asked for males only: 100 + i. Females have NO answer key (not asked).
// SAT: 1 + (i % 5), but i%6===5 -> skipped (null).
const rows = [];
for (let i = 0; i < 40; i++) {
  const complete = i < 30;
  const male = i % 2 === 0;
  const aware = i % 10 === 9 ? [] : [1, ...(i % 2 === 0 ? [2] : []), ...(i % 4 === 0 ? [3] : [])];
  const answers = { q_gender: male ? 1 : 2, q_brands: aware };
  if (!(i >= 35)) answers.q_age = 20 + i;
  answers.q_items = i % 7 === 6 ? { a: 1 + (i % 5) } : { a: 1 + (i % 5), b: 5 - (i % 5) };
  if (male) answers.q_spend = 100 + i;
  if (i % 6 !== 5) answers.q_sat = 1 + (i % 5);
  rows.push({
    id: `r${i}`, session_id: `s${i}`, respondent_code: `C${i}`, status: complete ? "complete" : "in_progress", is_test: false,
    started_at: new Date(Date.UTC(2026, 9, 1, 10, i)).toISOString(), completed_at: complete ? new Date(Date.UTC(2026, 9, 1, 10, i + 5)).toISOString() : null,
    quality: { classification: "CLEAN", qualityScore: 90, riskScore: 5 }, answers, calculated: {}, embedded: {}, flags: [],
  });
}

/* ---------------------------------------------------------------- expected values (plain JS, completes only i<30) */
const C = [...Array(30).keys()];
const exp = {};
exp.n = 30;
exp.gender = { male: C.filter((i) => i % 2 === 0).length, female: C.filter((i) => i % 2 === 1).length };
// multi: respondent base = respondents with at least one pick
const awareOf = (i) => (i % 10 === 9 ? [] : [1, ...(i % 2 === 0 ? [2] : []), ...(i % 4 === 0 ? [3] : [])]);
exp.awareRespondents = C.filter((i) => awareOf(i).length).length; // 27
exp.awareCounts = { 1: C.filter((i) => awareOf(i).includes(1)).length, 2: C.filter((i) => awareOf(i).includes(2)).length, 3: C.filter((i) => awareOf(i).includes(3)).length };
exp.awareMentions = exp.awareCounts[1] + exp.awareCounts[2] + exp.awareCounts[3];
// age: all 30 completes answered
const ages = C.map((i) => 20 + i);
exp.ageN = 30; exp.ageMean = ages.reduce((a, b) => a + b, 0) / 30;
const ageVar = ages.reduce((t, x) => t + (x - exp.ageMean) ** 2, 0) / 29; exp.ageSd = Math.sqrt(ageVar);
// matrix row b: i%7===6 missing -> i in {6,13,20,27} missing -> 26 valid
exp.itemsBN = C.filter((i) => i % 7 !== 6).length;
exp.itemsBMean = C.filter((i) => i % 7 !== 6).map((i) => 5 - (i % 5)).reduce((a, b) => a + b, 0) / exp.itemsBN;
// spend: males only (15), 100+i
const males = C.filter((i) => i % 2 === 0);
exp.spendN = males.length; exp.spendMean = males.map((i) => 100 + i).reduce((a, b) => a + b, 0) / males.length;
// sat: i%6===5 skipped -> i in {5,11,17,23,29} -> 25 valid
const satValid = C.filter((i) => i % 6 !== 5);
exp.satN = satValid.length; exp.satMissing = 30 - satValid.length;
exp.satCounts = {}; for (let c = 1; c <= 5; c++) exp.satCounts[c] = satValid.filter((i) => 1 + (i % 5) === c).length;
// crosstab SAT x GENDER column%: column base = respondents who answered both
exp.xt = {};
for (const g of [1, 2]) {
  const col = satValid.filter((i) => (i % 2 === 0 ? 1 : 2) === g);
  exp.xt[g] = { base: col.length, counts: {} };
  for (let c = 1; c <= 5; c++) exp.xt[g].counts[c] = col.filter((i) => 1 + (i % 5) === c).length;
}
// crosstab AWARE (multi rows) x GENDER: column base = respondents with >=1 pick in that gender
exp.xtAware = {};
for (const g of [1, 2]) {
  const col = C.filter((i) => (i % 2 === 0 ? 1 : 2) === g && awareOf(i).length);
  exp.xtAware[g] = { base: col.length, counts: { 1: col.filter((i) => awareOf(i).includes(1)).length, 2: col.filter((i) => awareOf(i).includes(2)).length, 3: col.filter((i) => awareOf(i).includes(3)).length } };
}
// AGE mean by gender
exp.ageByGender = { 1: males.map((i) => 20 + i).reduce((a, b) => a + b, 0) / males.length, 2: C.filter((i) => i % 2 === 1).map((i) => 20 + i).reduce((a, b) => a + b, 0) / 15 };
// filtered view: GENDER == 1 -> SAT frequencies among males
exp.satMalesN = satValid.filter((i) => i % 2 === 0).length;
// completes + partials (statuses complete,in_progress): age valid = i<35 -> 35, mean
const all40 = [...Array(40).keys()];
exp.ageAllN = all40.filter((i) => i < 35).length; exp.ageAllMean = all40.filter((i) => i < 35).map((i) => 20 + i).reduce((a, b) => a + b, 0) / exp.ageAllN;
// weighted: weight males 2, females 1 — SAT weighted % of code 1
const wOf = (i) => (i % 2 === 0 ? 2 : 1);
const wValid = satValid.reduce((t, i) => t + wOf(i), 0);
exp.satW1 = (satValid.filter((i) => 1 + (i % 5) === 1).reduce((t, i) => t + wOf(i), 0) / wValid) * 100;
exp.satWeightedValid = wValid;
exp.ageWMean = ages.reduce((t, x, i) => t + x * wOf(i), 0) / C.reduce((t, i) => t + wOf(i), 0);

/* ---------------------------------------------------------------- run */
const spec = { environment: "LIVE", dataset: "all" };
const ds = A.buildDataset(def, rows, { spec });
check("buildDataset", "cases (complete only by default)", ds.cases.length, exp.n);
check("buildDataset", "total (all rows before exclusions)", ds.total, 40);
const D = (kind, variables, extra = {}) => ({ name: kind, kind, dataset: spec, variables, ...extra });
const table = (r, id) => r.tables.find((t) => t.id === id) ?? r.tables[0];
const row = (t, pred) => t.rows.find(pred);

// descriptive single-select
let r = A.runAnalysis(D("descriptive", ["GENDER"]), ds);
let t = table(r, "freq_GENDER");
check("descriptive/frequencies", "GENDER base n", t.base.n, 30);
check("descriptive/frequencies", "GENDER Male count", row(t, (x) => x.code === "1").count, exp.gender.male);
check("descriptive/frequencies", "GENDER Male validPct", row(t, (x) => x.code === "1").validPct, (exp.gender.male / 30) * 100, 0.05);
check("makeResult", "GENDER result.base.n", r.base.n, 30);

// descriptive multi-select
r = A.runAnalysis(D("descriptive", ["AWARE"]), ds);
t = table(r, "freq_AWARE");
check("descriptive/frequencies(multi)", "AWARE base n = respondents with >=1 pick", t.base.n, exp.awareRespondents);
check("descriptive/frequencies(multi)", "AWARE Alpha count", row(t, (x) => x.code === "1").count, exp.awareCounts[1]);
check("descriptive/frequencies(multi)", "AWARE Beta validPct (respondent base)", row(t, (x) => x.code === "2").validPct, (exp.awareCounts[2] / exp.awareRespondents) * 100, 0.05);
check("descriptive/frequencies(multi)", "AWARE Missing count (empty arrays)", row(t, (x) => x.label === "Missing").count, 30 - exp.awareRespondents);
check("makeResult", "AWARE result.base.n", r.base.n, exp.awareRespondents);
const sumPct = t.rows.filter((x) => x.code).reduce((s, x) => s + x.validPct, 0);
console.log(`[info] multi validPct sum = ${sumPct.toFixed(1)}% (respondent base; mentions base would be 100%; mentions=${exp.awareMentions})`);

// numeric mean
r = A.runAnalysis(D("descriptive", ["AGE"]), ds);
t = table(r, "desc_AGE");
check("descriptive/describe", "AGE valid n", row(t, (x) => x.stat === "Valid n").value, exp.ageN);
check("descriptive/describe", "AGE mean", row(t, (x) => x.stat === "Mean").value, exp.ageMean, 0.005);
check("descriptive/describe", "AGE sd", row(t, (x) => x.stat === "Std. deviation").value, exp.ageSd, 0.005);

// matrix row (with one row missing for some)
r = A.runAnalysis(D("descriptive", ["ITEMS_b"], { options: { scaleAsNumeric: true } }), ds);
t = table(r, "desc_ITEMS_b");
check("descriptive/describe(matrix row)", "ITEMS_b valid n", row(t, (x) => x.stat === "Valid n").value, exp.itemsBN);
check("descriptive/describe(matrix row)", "ITEMS_b missing", row(t, (x) => x.stat === "Missing").value, 30 - exp.itemsBN);
check("descriptive/describe(matrix row)", "ITEMS_b mean", row(t, (x) => x.stat === "Mean").value, exp.itemsBMean, 0.005);
check("makeResult", "ITEMS_b result.base.n", r.base.n, exp.itemsBN);
console.log("[info] ITEMS_b role:", ds.byName.get("ITEMS_b")?.role);

// numeric hidden by display logic for females
r = A.runAnalysis(D("descriptive", ["SPEND"]), ds);
t = table(r, "desc_SPEND");
check("descriptive/describe(display-logic)", "SPEND valid n (asked males only)", row(t, (x) => x.stat === "Valid n").value, exp.spendN);
check("descriptive/describe(display-logic)", "SPEND missing (= not asked, 15)", row(t, (x) => x.stat === "Missing").value, 30 - exp.spendN);
check("descriptive/describe(display-logic)", "SPEND mean", row(t, (x) => x.stat === "Mean").value, exp.spendMean, 0.005);
check("makeResult", "SPEND result.base.n", r.base.n, exp.spendN);
console.log("[info] SPEND warnings:", JSON.stringify(r.warnings));

// single-select with skips
r = A.runAnalysis(D("descriptive", ["SAT"]), ds);
t = table(r, "freq_SAT");
check("descriptive/frequencies", "SAT base n (valid)", t.base.n, exp.satN);
check("descriptive/frequencies", "SAT missing", row(t, (x) => x.label === "Missing").count, exp.satMissing);
for (let c = 1; c <= 5; c++) check("descriptive/frequencies", `SAT code ${c} validPct`, row(t, (x) => x.code === String(c)).validPct, (exp.satCounts[c] / exp.satN) * 100, 0.05);
check("descriptive/frequencies", "SAT code 1 pct of total (base 30)", row(t, (x) => x.code === "1").pct, (exp.satCounts[1] / 30) * 100, 0.05);
console.log("[info] SAT role:", ds.byName.get("SAT")?.role);

// crosstab SAT x GENDER
r = A.runAnalysis(D("crosstab", ["SAT", "GENDER"]), ds);
t = r.tables[0];
const baseRow = row(t, (x) => x.row === "Base (n)");
check("crosstab", "SAT×GENDER Total base", baseRow.__total, exp.satN);
check("crosstab", "SAT×GENDER Male base", baseRow["1"], exp.xt[1].base);
check("crosstab", "SAT×GENDER Female base", baseRow["2"], exp.xt[2].base);
for (let c = 1; c <= 5; c++) {
  const rr = row(t, (x) => x.__code === String(c));
  check("crosstab", `SAT=${c} col% Male`, rr["1"], (exp.xt[1].counts[c] / exp.xt[1].base) * 100, 0.05);
  check("crosstab", `SAT=${c} n Male`, rr["1__n"], exp.xt[1].counts[c]);
  check("crosstab", `SAT=${c} col% Female`, rr["2"], (exp.xt[2].counts[c] / exp.xt[2].base) * 100, 0.05);
}
check("crosstab/makeResult", "result.base.n = total column base", r.base.n, exp.satN);
check("crosstab/chiSquare", "chi-square test present", r.tests.length, 1);
console.log("[info] crosstab tests:", JSON.stringify(r.tests.map((x) => ({ test: x.test, stat: x.statistic, p: x.p, df: x.df, detail: x.detail }))));

// crosstab row %
r = A.runAnalysis(D("crosstab", ["SAT", "GENDER"], { measure: "pct_row" }), ds);
t = r.tables[0];
{
  const c = 1; const rr = row(t, (x) => x.__code === String(c));
  const rowBase = exp.xt[1].counts[c] + exp.xt[2].counts[c];
  check("crosstab(pct_row)", "SAT=1 row% Male", rr["1"], (exp.xt[1].counts[c] / rowBase) * 100, 0.05);
  check("crosstab(pct_row)", "SAT=1 row% Total", rr.__total, 100, 0.05);
}

// crosstab base=all (No answer row)
r = A.runAnalysis(D("crosstab", ["SAT", "GENDER"], { options: { base: "all" } }), ds);
t = r.tables[0];
check("crosstab(base=all)", "Total base = everyone who answered GENDER", row(t, (x) => x.row === "Base (n)").__total, 30);
check("crosstab(base=all)", "No answer n Total", row(t, (x) => x.row === "No answer").__total__n, exp.satMissing);

// crosstab multi rows x gender
r = A.runAnalysis(D("crosstab", ["AWARE", "GENDER"]), ds);
t = r.tables[0];
check("crosstab(multi rows)", "AWARE×GENDER Male base (respondents)", row(t, (x) => x.row === "Base (n)")["1"], exp.xtAware[1].base);
check("crosstab(multi rows)", "AWARE Alpha col% Male", row(t, (x) => x.__code === "1")["1"], (exp.xtAware[1].counts[1] / exp.xtAware[1].base) * 100, 0.05);
check("crosstab(multi rows)", "AWARE Beta col% Male", row(t, (x) => x.__code === "2")["1"], (exp.xtAware[1].counts[2] / exp.xtAware[1].base) * 100, 0.05);
check("crosstab(multi rows)", "no chi-square for multi rows", r.tests.length, 0);

// crosstab numeric rows (mean by gender)
r = A.runAnalysis(D("crosstab", ["AGE", "GENDER"]), ds);
t = r.tables[0];
check("crosstab(mean rows)", "AGE mean Male", row(t, (x) => x.row === "Mean")["1"], exp.ageByGender[1], 0.005);
check("crosstab(mean rows)", "AGE mean Female", row(t, (x) => x.row === "Mean")["2"], exp.ageByGender[2], 0.005);
check("crosstab(mean rows)", "AGE n Male", row(t, (x) => x.row === "n")["1"], 15);
check("crosstab(mean rows)/anova", "ANOVA present", r.tests.length, 1);

// crosstab SPEND (display logic) x GENDER: female column should be base 0
r = A.runAnalysis(D("crosstab", ["SPEND", "GENDER"]), ds);
t = r.tables[0];
check("crosstab(display-logic rows)", "SPEND Female base", row(t, (x) => x.row === "Base (n)")["2"], 0);
check("crosstab(display-logic rows)", "SPEND Male base", row(t, (x) => x.row === "Base (n)")["1"], 15);
check("crosstab(display-logic rows)", "SPEND Total base", row(t, (x) => x.row === "Base (n)").__total, 15);

// filtered view
r = A.runAnalysis(D("descriptive", ["SAT"], { filter: { type: "rule", source: { kind: "question", ref: "q_gender" }, operator: "eq", value: 1 } }), ds);
t = table(r, "freq_SAT");
check("filterDataset+frequencies", "SAT among males valid n", t.base.n, exp.satMalesN);
check("filterDataset/makeResult", "base.filtered", r.base.filtered, 15);
check("filterDataset/makeResult", "base.total", r.base.total, 30);

// segments
r = A.runAnalysis(D("descriptive", ["SAT"], { segments: [{ id: "f", name: "Females", condition: { type: "rule", source: { kind: "question", ref: "q_gender" }, operator: "eq", value: 2 } }] }), ds);
check("segmentDatasets", "segment Females n (should be answered base 10)", r.segments[0].n, 10);
console.log(`[info] segment n = ${r.segments[0].n}; cases in segment 15, SAT valid among females = 10; warnings: ${JSON.stringify(r.warnings)}`);
// chi-square test runner vs crosstab chi-square: same numbers?
{
  const xt = A.runAnalysis(D("crosstab", ["SAT", "GENDER"]), ds).tests[0];
  const tr = A.runAnalysis(D("test", ["SAT", "GENDER"], { options: { test: "chi_square" } }), ds).tests[0];
  check("crosstab-vs-test chi_square", "same statistic", tr.statistic, xt.statistic, 1e-9);
  check("crosstab-vs-test chi_square", "same df", tr.df, xt.df);
}
// nps / csat on SAT scale
{
  const cs = A.runAnalysis(D("csat", ["SAT"]), ds);
  console.log("[info] csat tables:", JSON.stringify(cs.tables.map((t) => ({ id: t.id, base: t.base, rows: t.rows.slice(0, 3) }))), "base:", JSON.stringify(cs.base));
}

// completes + partials
const dsAll = A.buildDataset(def, rows, { spec: { ...spec, statuses: ["complete", "in_progress"] } });
check("buildDataset(statuses)", "cases with partials", dsAll.cases.length, 40);
r = A.runAnalysis(D("descriptive", ["AGE"], { dataset: { ...spec, statuses: ["complete", "in_progress"] } }), dsAll);
t = table(r, "desc_AGE");
check("describe(partials)", "AGE valid n incl partials", row(t, (x) => x.stat === "Valid n").value, exp.ageAllN);
check("describe(partials)", "AGE mean incl partials", row(t, (x) => x.stat === "Mean").value, exp.ageAllMean, 0.005);

// weighted: weight var via calculated? use variable weighting through a calculated column: put weight in vars via 'variable' option
// simplest: build a dataset then set weights manually as applyWeighting would with a variable named _w
const dsW = A.buildDataset(def, rows, { spec });
dsW.cases.forEach((c) => { c.vars.__W = c.vars.GENDER === "1" || c.vars.GENDER === 1 ? 2 : 1; });
A.applyWeighting(dsW, { variable: "__W" });
r = A.runAnalysis(D("descriptive", ["SAT"]), dsW);
t = table(r, "freq_SAT");
check("frequencies(weighted)", "SAT code 1 weighted validPct", row(t, (x) => x.code === "1").validPct, exp.satW1, 0.05);
check("frequencies(weighted)", "SAT weighted base", t.base.weightedN, exp.satWeightedValid, 0.05);
check("frequencies(weighted)", "SAT unweighted base n", t.base.n, exp.satN);
r = A.runAnalysis(D("descriptive", ["AGE"]), dsW);
t = table(r, "desc_AGE");
check("describe(weighted)", "AGE weighted mean", row(t, (x) => x.stat === "Mean").value, exp.ageWMean, 0.005);
r = A.runAnalysis(D("crosstab", ["SAT", "GENDER"]), dsW);
t = r.tables[0];
check("crosstab(weighted)", "Weighted base Male", row(t, (x) => x.row === "Weighted base")["1"], exp.xt[1].base * 2, 0.05);
check("crosstab(weighted)", "Base (n) Male unweighted", row(t, (x) => x.row === "Base (n)")["1"], exp.xt[1].base);

// topbox on SAT
r = A.runAnalysis(D("topbox", ["SAT"]), ds);
t = r.tables[0];
check("topbox/boxShares", "SAT top2 %", t.rows[0].top2, ((exp.satCounts[4] + exp.satCounts[5]) / exp.satN) * 100, 0.05);
check("topbox", "table base n (answered — ANALYTICS-02 fixed 2026-10-16; was 30 = all cases)", t.base.n, exp.satN);
check("topbox/makeResult", "result.base.n", r.base.n, exp.satN);

// NPS-like: csat on SAT? skip. Statistical test: t-test AGE by GENDER
r = A.runAnalysis(D("test", ["AGE", "GENDER"]), ds);
console.log("[info] test runner tests:", JSON.stringify(r.tests.map((x) => ({ test: x.test, stat: x.statistic, p: x.p, df: x.df }))), "warnings:", JSON.stringify(r.warnings));
// independent t expected (Welch)
{
  const a = males.map((i) => 20 + i), b = C.filter((i) => i % 2 === 1).map((i) => 20 + i);
  const m = (x) => x.reduce((s, v) => s + v, 0) / x.length; const v = (x) => { const mm = m(x); return x.reduce((s, q) => s + (q - mm) ** 2, 0) / (x.length - 1); };
  const tt = (m(a) - m(b)) / Math.sqrt(v(a) / a.length + v(b) / b.length);
  const tRes = r.tests.find((x) => /t/i.test(x.test));
  if (tRes) check("statisticalTest/independentT", "Welch t statistic", Math.abs(tRes.statistic), Math.abs(tt), 0.01);
}

/* ---------------------------------------------------------------- report */
console.log(`\nPASS ${ok.length}  MISMATCH ${mism.length}`);
for (const m of mism) console.log(`MISMATCH ${m.fn}: ${m.what} — got ${JSON.stringify(m.got)} expected ${JSON.stringify(m.exp)}`);
for (const o of ok) console.log(`ok ${o.fn}: ${o.what} = ${JSON.stringify(o.got)}`);
