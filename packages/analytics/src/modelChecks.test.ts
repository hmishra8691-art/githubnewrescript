import test from "node:test";
import assert from "node:assert/strict";
import { logistic, ols } from "./stats/regression.js";
import { linearModelChecks, logisticModelChecks, failedChecks } from "./modelChecks.js";

/* a fixed pseudo-random stream, so the data are the same every run */
let s = 7;
const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
const normal = () => { const u = Math.max(1e-12, rnd()), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const state = (cs: { id: string; state: string }[], id: string) => cs.find((c) => c.id === id)?.state;

test("a well-behaved linear model: every check holds", () => {
  s = 7;
  const x1 = Array.from({ length: 300 }, () => normal()), x2 = Array.from({ length: 300 }, () => normal());
  const y = x1.map((a, i) => 2 + a - 0.5 * x2[i]! + normal() * 0.8);
  const spec = { predictors: [{ name: "x1", values: x1 }, { name: "x2", values: x2 }], interactions: [] };
  const fit = ols(y, spec); assert.ok(!("error" in fit));
  const c = linearModelChecks(fit as never, spec, y);
  for (const id of ["cases_per_predictor", "collinearity", "normal_residuals", "constant_variance", "influence"]) assert.equal(state(c, id), "holds", `${id}: ${JSON.stringify(c.find((x) => x.id === id))}`);
  assert.deepEqual(failedChecks(c), []);
});

test("spread that grows with the predictor is caught, with what to do", () => {
  s = 11;
  const x = Array.from({ length: 300 }, () => rnd() * 10);
  const y = x.map((a) => 1 + a + normal() * (0.2 + a));
  const spec = { predictors: [{ name: "x", values: x }], interactions: [] };
  const c = linearModelChecks(ols(y, spec) as never, spec, y);
  const cv = c.find((x) => x.id === "constant_variance")!;
  assert.equal(cv.state, "caution");
  assert.match(cv.whatToDo!, /robust/);
});

test("one wild case that decides the fit, and too many predictors for the cases", () => {
  s = 3;
  const x = Array.from({ length: 40 }, () => rnd());
  const y = x.map((a) => a + normal() * 0.1);
  x.push(25); y.push(-30);
  const spec = { predictors: [{ name: "x", values: x }], interactions: [] };
  const c = linearModelChecks(ols(y, spec) as never, spec, y);
  assert.equal(state(c, "influence"), "fails");
  assert.ok(failedChecks(c).some((w) => /single case decides/.test(w)));
  s = 5;
  const preds = Array.from({ length: 6 }, (_, k) => ({ name: `p${k}`, values: Array.from({ length: 40 }, () => normal()) }));
  const yy = Array.from({ length: 40 }, () => normal());
  const spec2 = { predictors: preds, interactions: [] };
  assert.equal(state(linearModelChecks(ols(yy, spec2) as never, spec2, yy), "cases_per_predictor"), "fails");
});

test("two predictors that are nearly the same are flagged as overlapping", () => {
  s = 9;
  const a = Array.from({ length: 200 }, () => normal()), b = a.map((v) => v + normal() * 0.05);
  const y = a.map((v) => v + normal());
  const spec = { predictors: [{ name: "a", values: a }, { name: "b", values: b }], interactions: [] };
  const c = linearModelChecks(ols(y, spec) as never, spec, y);
  assert.equal(state(c, "collinearity"), "fails");
});

test("logistic: perfect separation and too few events per predictor fail", () => {
  s = 13;
  const x = Array.from({ length: 80 }, () => rnd());
  const y = x.map((v) => (v > 0.5 ? 1 : 0));
  const spec = { predictors: [{ name: "x", values: x }], interactions: [] };
  const fit = logistic(y, spec);
  if (!("error" in fit)) assert.equal(state(logisticModelChecks(fit, spec, y), "separation"), "fails");
  s = 17;
  const preds = Array.from({ length: 4 }, (_, k) => ({ name: `p${k}`, values: Array.from({ length: 120 }, () => normal()) }));
  const yy = Array.from({ length: 120 }, (_, i) => (i % 12 === 0 ? 1 : 0));
  const spec2 = { predictors: preds, interactions: [] };
  const fit2 = logistic(yy, spec2);
  assert.ok(!("error" in fit2));
  assert.equal(state(logisticModelChecks(fit2 as never, spec2, yy), "events_per_predictor"), "fails");
});
