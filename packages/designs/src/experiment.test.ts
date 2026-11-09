import { test } from "node:test";
import assert from "node:assert/strict";
import { experimentPlugin, fullFactorial, measureExperiment, recommendedRuns, williams, latinSquare, carryoverBalance, validateExperiment, mainEffectsParameters } from "./experiment.js";
import { customPlugin, readColumnSpec } from "./custom.js";

const F = (n: string, ...l: string[]) => ({ name: n, levels: l });

test("full factorial: every combination, orthogonal, prohibitions removed", () => {
  const f = [F("A", "a1", "a2"), F("B", "b1", "b2", "b3")];
  const r = experimentPlugin.generate({ designType: "full_factorial", factors: f, randomizeOrder: false }, 1);
  assert.equal(r.rows.length, 6);
  assert.equal(r.summary!.dEfficiency, 100);
  const p = experimentPlugin.generate({ designType: "full_factorial", factors: f, prohibitions: [{ a: { attribute: "A", level: "a1" }, b: { attribute: "B", level: "b3" } }] }, 1);
  assert.equal(p.rows.length, 5);
  assert.ok(!p.rows.some((x) => x.A === "a1" && x.B === "b3"));
  assert.equal(fullFactorial([F("X", ...Array.from({ length: 30 }, (_, i) => `${i}`)), F("Y", ...Array.from({ length: 30 }, (_, i) => `${i}`)), F("Z", ...Array.from({ length: 30 }, (_, i) => `${i}`))]), null, "too many to enumerate");
});

test("fractional: D-optimal finds orthogonal arrays where they exist", () => {
  const four3 = [F("A", "1", "2", "3"), F("B", "1", "2", "3"), F("C", "1", "2", "3"), F("D", "1", "2", "3")];
  assert.equal(recommendedRuns(four3), 9);
  const r = experimentPlugin.generate({ designType: "fractional", factors: four3 }, 7);
  assert.equal(r.rows.length, 9);
  assert.ok((r.summary!.dEfficiency as number) >= 99, `L9: ${r.summary!.dEfficiency}`);
  assert.equal(r.summary!.maxCorrelation, 0);
  const two = [F("A", "-", "+"), F("B", "-", "+"), F("C", "-", "+"), F("D", "-", "+"), F("E", "-", "+")];
  const t = experimentPlugin.generate({ designType: "fractional", factors: two, runs: 8 }, 3);
  assert.ok((t.summary!.dEfficiency as number) >= 99, `2^(5-2): ${t.summary!.dEfficiency}`);
});

test("fractional: mixed levels are efficient, balanced, and fewer runs than parameters is refused", () => {
  const mixed = [F("Brand", "A", "B", "C", "D"), F("Price", "$9", "$14", "$19"), F("Size", "S", "L"), F("Colour", "Red", "Blue", "Green")];
  const r = experimentPlugin.generate({ designType: "fractional", factors: mixed, versions: 2 }, 11);
  const q = r.summary as { dEfficiency: number; runs: number; levelBalance: { min: number; max: number }[] };
  assert.ok(q.dEfficiency >= 85, `mixed: ${q.dEfficiency}`);
  assert.ok(q.runs >= mainEffectsParameters(mixed));
  assert.ok(q.levelBalance.every((b) => b.max - b.min <= 2), JSON.stringify(q.levelBalance));
  assert.deepEqual([...new Set(r.rows.map((x) => x.version))].sort(), [1, 2]);
  assert.match(validateExperiment({ designType: "fractional", factors: mixed, runs: 5 }).join(" "), /cannot estimate/);
  const m = measureExperiment([F("A", "1", "2"), F("B", "1", "2")], [{ A: "1", B: "1" }, { A: "1", B: "1" }, { A: "2", B: "2" }]);
  assert.ok(m.maxCorrelation! > 0.4);
});

test("order designs: Latin square and Williams balance position and carry-over", () => {
  for (const n of [3, 4, 5, 6]) {
    const w = williams(n);
    assert.equal(w.length, n % 2 ? 2 * n : n);
    for (let pos = 0; pos < n; pos++) assert.equal(new Set(w.slice(0, n).map((s) => s[pos])).size, n, `position ${pos}`);
    const c = carryoverBalance(w, n);
    assert.equal(c.min, c.max, `williams ${n} carry-over`);
  }
  const l = latinSquare(4);
  for (let pos = 0; pos < 4; pos++) assert.equal(new Set(l.map((s) => s[pos])).size, 4);
  const r = experimentPlugin.generate({ designType: "williams", treatments: ["Ad A", "Ad B", "Ad C", "Ad D"] }, 5);
  assert.equal(r.rows.length, 16);
  assert.equal(r.summary!.carryoverBalanced, true);
  assert.match(String(r.summary!.explanation), /follows every other treatment exactly 1 time/);
});

test("balanced incomplete blocks: equal appearances, pairs as balanced as the sizes allow", () => {
  const r = experimentPlugin.generate({ designType: "bibd", treatments: ["A", "B", "C", "D", "E", "F", "G"], blockSize: 3, blocks: 7 }, 9);
  const s = r.summary as { appearances: { min: number; max: number }; pairConcurrence: { min: number; max: number } };
  assert.deepEqual(s.appearances, { min: 3, max: 3 });
  assert.ok(s.pairConcurrence.max <= 2);
  assert.equal(new Set(r.rows.map((x) => x.version)).size, 7);
});

test("the old free-form generator can be written one column per line", () => {
  assert.deepEqual(readColumnSpec("Cell: random_level A | B | C"), { name: "Cell", kind: "random_level", levels: ["A", "B", "C"] });
  assert.deepEqual(readColumnSpec("Score: random_int 1-5"), { name: "Score", kind: "random_int", min: 1, max: 5 });
  const r = customPlugin.generate({ rows: 6, columnsSpec: ["Row: sequence", "Cell: random_level A | B | C"] as never, versions: 1 }, 2);
  assert.equal(r.rows.length, 6);
  assert.deepEqual(["A", "B", "C"].map((l) => r.rows.filter((x) => x.Cell === l).length), [2, 2, 2]);
});

test("a large design (6 factors × 4 levels = 4,096 combinations) is fast and efficient", () => {
  const f = Array.from({ length: 6 }, (_, i) => ({ name: `F${i + 1}`, levels: ["1", "2", "3", "4"] }));
  const t0 = Date.now();
  const r = experimentPlugin.generate({ designType: "fractional", factors: f }, 4);
  const ms = Date.now() - t0;
  assert.ok(ms < 8000, `${ms} ms`);
  assert.ok((r.summary!.dEfficiency as number) >= 85, String(r.summary!.dEfficiency));
});
