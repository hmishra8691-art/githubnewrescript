import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relativeImportance } from "./relativeImportance.js";

/* reference values computed independently with NumPy (src/fixtures/relative-importance-reference.json: exact Shapley over all
   subsets with np.linalg.solve, Johnson's weights with np.linalg.eigh) on 300 cases where x1 and x2 are strongly correlated */
const ref = JSON.parse(readFileSync(new URL("../../src/fixtures/relative-importance-reference.json", import.meta.url), "utf8")) as { y: number[]; xs: number[][]; r2: number; shapley: number[]; johnson: number[] };

test("Shapley (LMG) shares and Johnson's relative weights match an independent NumPy computation to 1e-9", () => {
  const r = relativeImportance(ref.y, ref.xs);
  assert.ok(!("error" in r));
  assert.ok(Math.abs(r.r2 - ref.r2) < 1e-9);
  r.shapley!.forEach((v, j) => assert.ok(Math.abs(v - ref.shapley[j]) < 1e-9, `shapley ${j}: ${v} vs ${ref.shapley[j]}`));
  r.johnson.forEach((v, j) => assert.ok(Math.abs(v - ref.johnson[j]) < 1e-9, `johnson ${j}: ${v} vs ${ref.johnson[j]}`));
  assert.ok(Math.abs(r.shapley!.reduce((a, b) => a + b, 0) - r.r2) < 1e-9, "Shapley shares add up to R²");
  assert.ok(Math.abs(r.johnson.reduce((a, b) => a + b, 0) - r.r2) < 1e-9, "Johnson's weights add up to R²");
});

test("uncorrelated drivers: both methods give each driver its own r²; missing values are dropped listwise", () => {
  const n = 400, a: (number | null)[] = [], b: (number | null)[] = [], y: (number | null)[] = [];
  for (let i = 0; i < n; i++) { const u = Math.sin(i * 1.7), v = Math.cos(i * 2.3); a.push(u); b.push(v); y.push(2 * u + v); }
  a[5] = null; y[9] = null;
  const r = relativeImportance(y, [a, b]);
  assert.ok(!("error" in r));
  assert.equal(r.n, n - 2);
  assert.ok(Math.abs(r.r2 - 1) < 1e-9);
  assert.ok(Math.abs(r.shapley![0] - r.johnson[0]) < 0.01 && Math.abs(r.shapley![1] - r.johnson[1]) < 0.01);
});

test("too few cases or a perfectly collinear pair is refused with the reason", () => {
  assert.match((relativeImportance([1, 2, 3], [[1, 2, 3], [3, 2, 1]]) as { error: string }).error, /complete cases/);
  const x = Array.from({ length: 50 }, (_, i) => i), y = x.map((v) => v * 2 + Math.sin(v));
  assert.match((relativeImportance(y, [x, x.map((v) => v * 3)]) as { error: string }).error, /collinear/);
});
