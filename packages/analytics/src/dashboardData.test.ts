import { test } from "node:test";
import assert from "node:assert/strict";
import { synthDataset, D } from "./analyses/fixture.js";
import { runAnalysis } from "./analyses/index.js";
import { DEFAULT_VARIANT_MIN_BASE, drillCondition, drillPlan, minBasesFor, protectResult, protectSnapshot } from "./dashboardData.js";

/* R2 — what a shared dashboard may show: frozen answers only, nothing from fewer than the minimum base */
const ds = synthDataset();
const byRegion = runAnalysis(D("crosstab", [], { rows: ["SAT"], columns: ["REGION"] }), ds);

test("a column under the minimum base is blanked in the table and the chart, and said so", () => {
  const { result, withheld } = protectResult(byRegion, 130);
  const t = result.tables[0];
  assert.equal(t.columns.find((c) => c.key === "2")!.suppressed, true, "South (n = 125) is suppressed");
  assert.ok(t.rows.every((r) => r["2"] === null || typeof r["2"] !== "number"), "no South number is left");
  assert.ok(t.rows.some((r) => typeof r["1"] === "number"), "North (n = 144) stays");
  assert.ok(result.chart.series!.find((s) => s.name === "South")!.values.every((v) => v === null));
  assert.ok(result.chart.series!.find((s) => s.name === "North")!.values.some((v) => v !== null));
  assert.ok(withheld.some((w) => /column South \(b\) \(n = 125\)/.test(w)), withheld.join("; "));
  assert.ok(t.notes!.some((n) => /fewer than 130/.test(n)));
  /* idempotent: protecting twice changes nothing more */
  assert.deepEqual(protectResult(result, 130).result, result);
});

test("a whole result under the base is withheld; a segment under it is removed; nothing changes above it", () => {
  const all = protectResult(byRegion, 500);
  assert.equal(all.result.tables.length, 0);
  assert.equal(all.result.insights.length, 0);
  assert.match(all.result.warnings[0], /fewer than 500 respondents \(n = 400\)/);
  const seg = runAnalysis({ ...D("descriptive", ["SAT"]), segments: [{ id: "g", name: "Young", condition: drillCondition("AGE", 0) as never }] }, ds);
  const segSmall = { ...seg, segments: [{ name: "Young", n: 14, chart: seg.chart }, { name: "Old", n: 200, chart: seg.chart }] };
  const p = protectResult(segSmall, 30);
  assert.deepEqual(p.result.segments!.map((s) => s.name), ["Old"]);
  assert.deepEqual(protectResult(byRegion, 30).withheld, []);
  assert.equal(protectResult(byRegion, 0).result, byRegion);
  const snap = protectSnapshot({ a: byRegion, b: byRegion }, 500);
  assert.equal(snap.withheld.length, 2);
});

test("drill-down: one variable, 1–12 labelled values, duplicates dropped; the condition is a plain equals rule", () => {
  assert.deepEqual(drillPlan({}), { plan: null, problems: [] });
  const ok = drillPlan({ drillDown: { variable: "REGION", values: [{ value: 1, label: "North" }, { value: 1, label: "again" }, { value: 2, label: "South" }] } });
  assert.deepEqual(ok.plan!.values.map((v) => v.label), ["North", "South"]);
  assert.match(drillPlan({ drillDown: { variable: "bad name;", values: [] } }).problems.join(" "), /variable name.*at least one value/);
  assert.match(drillPlan({ drillDown: { variable: "X", values: Array.from({ length: 13 }, (_, i) => ({ value: i, label: String(i) })) } }).problems[0], /at most 12/);
  assert.deepEqual(drillCondition("REGION", 2), { type: "rule", source: { kind: "variable", ref: "REGION" }, operator: "eq", value: 2 });
});

test("bases: variants always protected (30 by default); the main results only when the report asks", () => {
  assert.deepEqual(minBasesFor({}), { main: 0, variants: DEFAULT_VARIANT_MIN_BASE });
  assert.deepEqual(minBasesFor({ minBase: 50 }), { main: 50, variants: 50 });
});

test("a drill condition filters an analysis to that value (North: n = 144 of 400)", () => {
  const north = runAnalysis({ ...D("descriptive", ["SAT"]), filter: drillCondition("REGION", 1) as never }, ds);
  assert.equal(north.base.n, 144);
});
