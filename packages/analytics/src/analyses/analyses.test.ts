import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDataset } from "../dataset.js";
import { runAnalysis } from "./index.js";
import { recommendCharts, chartsAvailable } from "../recommend.js";
import { executiveSummary } from "../summary.js";
import type { AnalysisDefinition } from "../types.js";
import { def, rule, synthRows } from "./fixture.js";

const rows = synthRows();
const dsSpec = { environment: "LIVE" as const, dataset: "all" as const };
const ds = buildDataset(def, rows, { spec: dsSpec });
const D = (kind: AnalysisDefinition["kind"], variables: string[], extra: Partial<AnalysisDefinition> = {}): AnalysisDefinition => ({ name: kind, kind, dataset: dsSpec, variables, ...extra });

test("dataset: dictionary-named columns, roles and system variables", () => {
  assert.equal(ds.cases.length, 400);
  assert.equal(ds.byName.get("GENDER")?.role, "categorical");
  assert.equal(ds.byName.get("SAT")?.role, "scale");
  assert.equal(ds.byName.get("AGE")?.role, "numeric");
  assert.equal(ds.byName.get("AWARE")?.role, "multi");
  assert.equal(ds.byName.get("AWARE_1")?.role, "categorical");
  assert.equal(ds.byName.get("ITEMS_a")?.role, "scale");
  assert.equal(ds.byName.get("TEXT")?.role, "text");
  assert.ok(ds.byName.has("_started_month"));
  assert.equal(ds.cases[0].vars._environment, "LIVE");
  // filtering through the survey engine
  const filtered = buildDataset(def, rows, { spec: dsSpec, filter: rule("q_gender", 2) });
  assert.ok(filtered.cases.length > 150 && filtered.cases.length < 250);
  assert.ok(filtered.cases.every((c) => c.vars.GENDER === 2));
  // clean-only dataset drops SUSPECT
  const clean = buildDataset(def, rows, { spec: { ...dsSpec, dataset: "clean" } });
  assert.ok(clean.cases.length < 400 && clean.cases.length > 330);
});

test("descriptive: frequencies for categorical, moments for numeric, batteries stacked", () => {
  const r = runAnalysis(D("descriptive", ["GENDER"]), ds);
  assert.equal(r.tables[0].rows.length, 3); // 2 codes + missing
  assert.ok(Math.abs((r.tables[0].rows[0].validPct as number) + (r.tables[0].rows[1].validPct as number) - 100) < 0.2);
  assert.ok(r.recommendedCharts.includes("pie"));
  const n = runAnalysis(D("descriptive", ["AGE"]), ds);
  const mean = n.tables[0].rows.find((x) => x.stat === "Mean")!.value as number;
  assert.ok(mean > 40 && mean < 56);
  assert.ok(n.recommendedCharts.includes("histogram"));
  const b = runAnalysis(D("descriptive", ["ITEMS_a", "ITEMS_b", "ITEMS_c"]), ds);
  assert.equal(b.chart.series!.length, 5);
  assert.ok(b.recommendedCharts.includes("bar_stacked_100"));
});

test("topbox: women's satisfaction planted higher", () => {
  const r = runAnalysis(D("topbox", ["SAT", "ITEMS_a", "ITEMS_b"], { segments: [{ id: "m", name: "Men", condition: rule("q_gender", 1) }, { id: "f", name: "Women", condition: rule("q_gender", 2) }] }), ds);
  assert.equal(r.tables[0].rows.length, 3);
  const men = r.segments!.find((s) => s.name === "Men")!, women = r.segments!.find((s) => s.name === "Women")!;
  assert.ok(women.chart.series![0].values[0]! > men.chart.series![0].values[0]!);
});

test("crosstab: column %, significance letters and chi-square", () => {
  const r = runAnalysis(D("crosstab", [], { rows: ["SAT"], columns: ["GENDER"], measure: "pct_col" }), ds);
  const t = r.tables[0];
  assert.equal(t.columns.length, 4);
  const top = t.rows.find((x) => x.row === "5")!;
  assert.ok((top["2"] as number) > (top["1"] as number), "women more in top box");
  assert.ok(String(top["2__sig"]).includes("a"), "female column significantly higher than male (a)");
  assert.equal(r.tests[0].test, "chi_square");
  assert.ok(r.tests[0].p! < 0.001);
  assert.ok(r.insights[0].includes("differs significantly"));
  // numeric rows → means by column
  const m = runAnalysis(D("crosstab", [], { rows: ["AGE"], columns: ["REGION"], measure: "mean" }), ds);
  assert.equal(m.tables[0].rows[0].row, "Mean");
  assert.equal(m.tests[0].test, "anova_one_way");
  // multi-select rows
  const mm = runAnalysis(D("crosstab", [], { rows: ["AWARE"], columns: ["GENDER"] }), ds);
  assert.equal(mm.tables[0].rows.length, 4);
});

test("tests: auto-selects t-test / anova / chi-square", () => {
  const t = runAnalysis(D("test", ["SAT", "GENDER"]), ds);
  assert.equal(t.tests[0].test, "t_welch");
  assert.ok(t.tests[0].p! < 0.001);
  const a = runAnalysis(D("test", ["AGE", "REGION"]), ds);
  assert.equal(a.tests[0].test, "anova_one_way");
  assert.ok(a.tests[0].p! > 0.01, "age is unrelated to region");
  const c = runAnalysis(D("test", ["GENDER", "REGION"]), ds);
  assert.equal(c.tests[0].test, "chi_square");
  const mw = runAnalysis(D("test", ["SAT", "GENDER"], { options: { test: "mann_whitney" } }), ds);
  assert.equal(mw.tests[0].test, "mann_whitney");
  const one = runAnalysis(D("test", ["AGE"], { options: { mu: 48 } }), ds);
  assert.equal(one.tests[0].test, "t_one_sample");
});

test("correlation and regression recover planted relationships", () => {
  const c = runAnalysis(D("correlation", ["SAT", "NPS"]), ds);
  const r = c.tables[0].rows[0].r as number;
  assert.ok(r > 0.6, `sat–nps r ${r}`);
  const m = runAnalysis(D("correlation", ["SAT", "NPS", "AGE", "ITEMS_a"]), ds);
  assert.ok(m.chart.matrix && m.chart.matrix.rows.length === 4);
  const reg = runAnalysis(D("regression", ["NPS", "SAT", "AGE", "GENDER"]), ds);
  const fit = reg.tables[0].rows.find((x) => x.stat === "R²")!.value as number;
  assert.ok(fit > 0.4);
  const sat = reg.tables[1].rows.find((x) => x.term === "Overall satisfaction")!;
  assert.ok((sat.estimate as number) > 1.2 && (sat.estimate as number) < 2.4);
  const lg = runAnalysis(D("regression", ["GENDER", "SAT"], { options: { model: "logistic", target: "2" } }), ds);
  assert.ok((lg.tables[1].rows[1].or as number) > 1, "higher satisfaction → higher odds of female");
  const med = runAnalysis(D("regression", ["NPS", "GENDER", "SAT"], { options: { model: "mediation" } }), ds);
  assert.ok(med.tables[0].rows.length >= 5);
});

test("factor, reliability, cluster, segmentation", () => {
  const f = runAnalysis(D("factor", ["ITEMS_a", "ITEMS_b", "ITEMS_c", "SAT", "NPS"]), ds);
  assert.ok(f.tables[1].rows.length === 5);
  const rel = runAnalysis(D("reliability", ["ITEMS_a", "ITEMS_b", "SAT"]), ds);
  const alpha = rel.tables[0].rows[0].value as number;
  assert.ok(alpha > 0.5, `alpha ${alpha}`);
  const cl = runAnalysis(D("cluster", ["SAT", "NPS", "AGE"], { options: { k: 3, profile: ["GENDER"] } }), ds);
  assert.equal(cl.tables[0].rows.length, 3);
  assert.ok(cl.tables.some((t) => t.id === "profile_GENDER"));
  const h = runAnalysis(D("cluster", ["SAT", "NPS"], { options: { k: 2, method: "hierarchical" } }), ds);
  assert.ok(h.chart.dendrogram && h.chart.dendrogram.length > 0);
  const seg = runAnalysis(D("segmentation", ["SAT", "REGION"], { segments: [{ id: "m", name: "Men", condition: rule("q_gender", 1) }, { id: "f", name: "Women", condition: rule("q_gender", 2) }] }), ds);
  assert.ok(seg.insights[0].includes("differs significantly"));
});

test("NPS, CSAT, trend", () => {
  const n = runAnalysis(D("nps", ["NPS"], { options: { by: "GENDER", drivers: ["ITEMS_a", "ITEMS_b", "ITEMS_c"] } }), ds);
  const npsv = n.tables[0].rows[0].v as number;
  assert.ok(npsv > -100 && npsv < 100);
  const by = n.tables.find((t) => t.id === "by")!;
  assert.ok((by.rows.find((x) => x.group === "Female")!.nps as number) > (by.rows.find((x) => x.group === "Male")!.nps as number));
  assert.ok(n.tables.some((t) => t.id === "drivers"));
  assert.ok(n.tables.some((t) => t.id === "trend"));
  const c = runAnalysis(D("csat", ["SAT"], { options: { by: "REGION" } }), ds);
  assert.ok((c.tables[0].rows[0].score as number) > 20);
  const tr = runAnalysis(D("trend", ["SAT"], { options: { period: "_started_month", rolling: 2 } }), ds);
  assert.ok(tr.chart.categories!.length >= 2);
  assert.equal(tr.chart.series!.length, 2);
});

test("TURF and brand funnel", () => {
  const t = runAnalysis(D("turf", ["AWARE"], { options: { maxSize: 3 } }), ds);
  assert.equal(t.tables[0].rows.length, 3);
  assert.ok((t.tables[0].rows[2].reach as number) >= (t.tables[0].rows[0].reach as number));
  assert.ok(String(t.tables[1].rows[0].item).includes("Alpha"));
  const b = runAnalysis(D("brand", ["AWARE", "CONSIDER"]), ds);
  const alpha = b.tables[0].rows.find((x) => x.brand === "Alpha")!;
  assert.ok((alpha.s0 as number) > 80 && (alpha.s1 as number) < (alpha.s0 as number));
  assert.ok(b.insights[0].includes("Alpha"));
});

test("ranking, allocation, gap", () => {
  const r = runAnalysis(D("ranking", ["RANK"]), ds);
  assert.equal(r.tables[0].rows[0].item, "Price");
  assert.equal(r.tables[1].rows.length, 3);
  const a = runAnalysis(D("allocation", ["ALLOC"]), ds);
  assert.equal(a.tables[0].rows.length, 3);
  const total = a.tables[0].rows.reduce((t, x) => t + (x.mean as number), 0);
  assert.ok(Math.abs(total - 100) < 1);
  const g = runAnalysis(D("gap", [], { options: { importance: ["ITEMS_a", "ITEMS_b"], performance: ["ITEMS_c", "SAT"] } }), ds);
  assert.equal(g.tables[0].rows.length, 2);
  assert.ok(g.chart.points!.length === 2);
});

test("pricing: Van Westendorp range ordered, Gabor-Granger revenue", () => {
  const vw = runAnalysis(D("pricing", ["P_CHEAP", "P_BARGAIN", "P_EXP", "P_TOOEXP"]), ds);
  const rows = Object.fromEntries(vw.tables[0].rows.map((x) => [String(x.m).split(" (")[0], x.v as number]));
  assert.ok(rows["Point of marginal cheapness"] < rows["Point of marginal expensiveness"]);
  assert.ok(rows["Optimal price point"] >= rows["Point of marginal cheapness"] - 1);
  const gg = runAnalysis(D("pricing", ["ITEMS_a", "ITEMS_b", "ITEMS_c"], { options: { method: "gabor_granger", prices: [10, 20, 30], acceptCodes: [4, 5] } }), ds);
  assert.equal(gg.tables[0].rows.length, 3);
});

test("text analytics: sentiment split and words", () => {
  const t = runAnalysis(D("text", ["TEXT"], { options: { by: "GENDER", themes: [{ name: "Service", keywords: ["service", "support"] }, { name: "Price", keywords: ["expensive", "value"] }] } }), ds);
  const words = t.tables.find((x) => x.id === "words")!;
  assert.ok(words.rows.length > 5);
  assert.ok(t.chart.words!.length > 5);
  const themes = t.tables.find((x) => x.id === "themes")!;
  assert.equal(themes.rows.length, 2);
  const by = t.tables.find((x) => x.id === "by")!;
  assert.ok((by.rows.find((x) => x.group === "Female")!.pos as number) > (by.rows.find((x) => x.group === "Male")!.pos as number));
});

test("quality and weighting", () => {
  const q = runAnalysis(D("quality", []), ds);
  assert.ok(q.tables[0].rows.some((x) => String(x.m).startsWith("Class: SUSPECT")));
  const wds = buildDataset(def, rows, { spec: dsSpec, weighting: { rim: [{ variable: "GENDER", targets: { 1: 70, 2: 30 } }] } });
  assert.ok(wds.weighted && wds.weightInfo!.converged);
  const w = runAnalysis(D("weighting", [], { weighting: { rim: [{ variable: "GENDER", targets: { 1: 70, 2: 30 } }] } }), wds);
  const male = w.tables[0].rows.find((x) => x.category === "Male")!;
  assert.ok(Math.abs((male.weighted as number) - 70) < 0.5);
  // weighted crosstab base reflects weights
  const xt = runAnalysis(D("crosstab", [], { rows: ["SAT"], columns: ["GENDER"] }), wds);
  assert.ok(xt.tables[0].rows.some((x) => x.row === "Weighted base"));
});

test("conjoint: price dominates, Alpha preferred, none share sensible", () => {
  const r = runAnalysis(D("conjoint", ["CBC"]), ds);
  assert.equal(r.tables[0].rows[0].attribute, "Price");
  const pw = r.tables[1].rows;
  const p10 = pw.find((x) => x.level === "$10")!.utility as number, p30 = pw.find((x) => x.level === "$30")!.utility as number;
  assert.ok(p10 > 0.6 && p30 < -0.6, `price utilities ${p10} ${p30}`);
  assert.ok((pw.find((x) => x.level === "Alpha")!.utility as number) > 0.2);
  const sim = r.tables.find((t) => t.id === "simulation")!;
  assert.ok((sim.rows[0].share as number) > (sim.rows[1].share as number));
  assert.ok(r.tables.some((t) => t.id === "wtp"));
  assert.ok(r.insights[0].startsWith("Price is the most important"));
});

test("maxdiff: planted item order recovered", () => {
  const r = runAnalysis(D("maxdiff", ["MD"], { options: { by: "GENDER" } }), ds);
  const order = r.tables[0].rows.map((x) => x.item);
  assert.equal(order[0], "Battery");
  assert.equal(order[5], "Design");
  assert.ok(Math.abs(r.tables[0].rows.reduce((t, x) => t + (x.share as number), 0) - 100) < 0.5);
  assert.ok(r.chart.matrix && r.chart.matrix.columns.length === 2);
});

test("recommendations respect data shape; summary traces to insights", () => {
  const r = runAnalysis(D("descriptive", ["REGION"]), ds);
  const rec = recommendCharts(r);
  assert.ok(rec[0].type === "pie" || rec[0].type === "bar_horizontal" || rec[0].type === "bar_vertical");
  assert.ok(chartsAvailable(r).includes("bar_vertical"));
  assert.ok(!chartsAvailable(r).includes("word_cloud"));
  const tr = runAnalysis(D("trend", ["SAT"]), ds);
  assert.equal(recommendCharts(tr)[0].type, "line");
  const s = executiveSummary([{ name: "Gender", result: r }]);
  assert.equal(s.length, 1);
  assert.ok(s[0].headline.includes("most common"));
});

test("every runner survives an empty dataset without throwing", () => {
  const empty = buildDataset(def, [], { spec: dsSpec });
  for (const kind of ["descriptive", "topbox", "crosstab", "test", "correlation", "regression", "segmentation", "cluster", "factor", "reliability", "trend", "nps", "csat", "turf", "gap", "pricing", "brand", "ranking", "allocation", "text", "quality", "weighting", "conjoint", "maxdiff"] as const) {
    const r = runAnalysis(D(kind, ["SAT", "GENDER"], { rows: ["SAT"], columns: ["GENDER"] }), empty);
    assert.equal(r.kind, kind);
    assert.ok(Array.isArray(r.tables));
  }
});
