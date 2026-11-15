import test from "node:test";
import assert from "node:assert/strict";
import { runAnalysis } from "./index.js";
import { synthDataset } from "./fixture.js";
import { normalCdf } from "../stats/distributions.js";
import { layerName, DEFAULT_AGE_BANDS, type LayerVariable } from "../analysisLayer.js";

const spec = { environment: "LIVE" as const, dataset: "all" as const };

/* the expected values, computed here from the raw answers with nothing from the module under test except the normal CDF */
function expected(ds: ReturnType<typeof synthDataset>, group: (c: (typeof ds.cases)[number]) => string | null) {
  const by = new Map<string, number[]>();
  for (const c of ds.cases) {
    const g = group(c); const v = c.vars.NPS;
    if (g == null || v == null || v === "") continue;
    const s = Number(v) >= 9 ? 100 : Number(v) >= 7 ? 0 : -100;
    if (!by.has(g)) by.set(g, []);
    by.get(g)!.push(s);
  }
  const out = new Map<string, { n: number; nps: number; se: number; pro: number; det: number }>();
  for (const [g, xs] of by) {
    const n = xs.length, mean = xs.reduce((a, b) => a + b, 0) / n;
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;   // population variance of the score
    out.set(g, { n, nps: mean, se: Math.sqrt(variance / n), pro: (xs.filter((x) => x === 100).length / n) * 100, det: (xs.filter((x) => x === -100).length / n) * 100 });
  }
  return out;
}

test("NPS by gender: every number in the table equals the independent computation, and the letter matches the z-test", () => {
  const ds = synthDataset(400);
  const res = runAnalysis({ name: "NPS by gender", kind: "nps", dataset: spec, variables: ["NPS"], options: { by: ["GENDER"], confidence: 0.95 } }, ds);
  assert.equal(res.error, undefined);
  const t = res.tables.find((x) => x.id === "by_GENDER")!;
  assert.ok(t, res.tables.map((x) => x.id).join(","));
  const exp = expected(ds, (c) => (c.vars.GENDER == null ? null : String(c.vars.GENDER)));
  const male = exp.get("1")!, female = exp.get("2")!;
  const rowM = t.rows.find((r) => r.group === "Male")!, rowF = t.rows.find((r) => r.group === "Female")!;
  assert.equal(rowM.n, male.n); assert.equal(rowF.n, female.n);
  assert.ok(Math.abs(Number(rowM.nps) - male.nps) < 0.06 && Math.abs(Number(rowF.nps) - female.nps) < 0.06, `${rowM.nps} vs ${male.nps}; ${rowF.nps} vs ${female.nps}`);
  assert.ok(Math.abs(Number(rowM.promoters) - male.pro) < 0.06 && Math.abs(Number(rowF.detractors) - female.det) < 0.06);
  const zv = (female.nps - male.nps) / Math.sqrt(male.se ** 2 + female.se ** 2);
  const p = 2 * (1 - normalCdf(Math.abs(zv)));
  /* the fixture plants more satisfied women: the difference is large and the letter is on the women's row */
  assert.ok(p < 0.05, `p = ${p}`);
  assert.equal(rowF.sig, rowM.letter, "Female is marked higher than Male");
  assert.equal(rowM.sig, "");
  const ci = 1.959964 * female.se;
  assert.ok(Math.abs(Number(rowF.lo) - (female.nps - ci)) < 0.1 && Math.abs(Number(rowF.hi) - (female.nps + ci)) < 0.1);
  assert.ok(res.insights.some((s) => /By .*Gender.*highest among Female.*Statistically significant: Female > Male/.test(s)), res.insights.join(" | "));
  assert.equal(res.chart.categories?.[0], "Total");
  assert.deepEqual(res.chart.series?.map((s) => s.name), ["Detractors (0–6)", "Passives (7–8)", "Promoters (9–10)"]);
});

test("NPS by two groupings, one of them a derived age band; a 99% level changes the interval; a multi-select grouping is not tested", () => {
  const ds = synthDataset(400);
  const bands: LayerVariable = { label: "Age group", kind: "group_numeric", from: ["AGE"], bins: DEFAULT_AGE_BANDS };
  const age = layerName(bands);
  const r95 = runAnalysis({ name: "NPS", kind: "nps", dataset: spec, variables: ["NPS"], options: { by: ["GENDER", age], layer: [bands], confidence: 0.95 } }, ds);
  const r99 = runAnalysis({ name: "NPS", kind: "nps", dataset: spec, variables: ["NPS"], options: { by: ["GENDER", age], layer: [bands], confidence: 0.99 } }, ds);
  const ageT95 = r95.tables.find((t) => t.id === `by_${age}`)!, ageT99 = r99.tables.find((t) => t.id === `by_${age}`)!;
  assert.ok(ageT95 && ageT99);
  assert.equal(ageT95.rows.reduce((a, r) => a + Number(r.n), 0), r95.layer!.reports[0]!.populated, "the age groups' bases add up to the respondents the band variable populated");
  const w95 = Number(ageT95.rows[0]!.hi) - Number(ageT95.rows[0]!.lo), w99 = Number(ageT99.rows[0]!.hi) - Number(ageT99.rows[0]!.lo);
  assert.ok(w99 > w95, "a 99% interval is wider");
  assert.ok(ageT95.columns.some((c) => c.label === "95% CI low") && ageT99.columns.some((c) => c.label === "99% CI low"));
  const multi = runAnalysis({ name: "NPS", kind: "nps", dataset: spec, variables: ["NPS"], options: { by: ["AWARE"] } }, ds);
  assert.ok(multi.warnings.some((w) => /multi-choice question .* not tested/.test(w)), multi.warnings.join(" | "));
  assert.ok(multi.tables.find((t) => t.id === "by_AWARE")!.rows.every((r) => r.sig === "" || r.sig === "n<30"));
});

test("small groups are shown but never tested; a legacy single `by` keeps its old table", () => {
  const ds = synthDataset(60);
  const res = runAnalysis({ name: "NPS", kind: "nps", dataset: spec, variables: ["NPS"], options: { by: ["REGION"] } }, ds);
  const t = res.tables.find((x) => x.id === "by_REGION")!;
  assert.ok(t.rows.every((r) => Number(r.n) < 30 ? r.sig === "n<30" : true));
  assert.ok(res.warnings.some((w) => /fewer than 30 respondents — shown, not tested|fewer than two groups/.test(w)));
  const legacy = runAnalysis({ name: "NPS", kind: "nps", dataset: spec, variables: ["NPS"], options: { by: "GENDER" } }, synthDataset(400));
  assert.ok(legacy.tables.some((x) => x.id === "by"), "the old single-grouping table is unchanged");
});
