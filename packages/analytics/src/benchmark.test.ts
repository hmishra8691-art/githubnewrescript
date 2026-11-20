import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBenchmark, compare, distribution, standing, type BenchmarkRow } from "./benchmark.js";

const row = (score: number | null, dept: string | null = null, extra: Record<string, number | null> = {}): BenchmarkRow => ({ values: { calm: score, ...extra }, cohort: { dept } });
const people = (n: number, dept: string | null, from = 1) => Array.from({ length: n }, (_, i) => row(from + i, dept));

test("a distribution: count, mean, spread, median and 101 cut points", () => {
  const d = distribution([5, 1, 3, 2, 4]);
  assert.deepEqual([d.n, d.mean, d.median, d.sd], [5, 3, 3, 1.58]);
  assert.equal(d.cuts.length, 101); assert.equal(d.cuts[0], 1); assert.equal(d.cuts[100], 5); assert.equal(d.cuts[25], 2);
});

test("fewer than ten people: no figure at all, and the floor cannot be lowered", () => {
  const nine = buildBenchmark(people(9, null), { fingerprint: "f", minCohort: 3 });
  assert.equal(nine.minCohort, 10); assert.deepEqual(nine.all, {});
  const ten = buildBenchmark(people(10, null), { fingerprint: "f" });
  assert.equal(ten.all.calm!.n, 10);
  const stricter = buildBenchmark(people(15, null), { fingerprint: "f", minCohort: 20 });
  assert.deepEqual(stricter.all, {}, "a higher minimum is respected");
});

test("only people who have the score are counted", () => {
  const rows = [...people(9, null), row(null), row(null), row(Number.NaN)];
  assert.deepEqual(buildBenchmark(rows, { fingerprint: "f" }).all, {});
  assert.equal(buildBenchmark([...rows, row(4)], { fingerprint: "f" }).all.calm!.n, 10);
});

test("a group below ten is not shown; and when the hidden people are few, the smallest shown group goes too", () => {
  /* 12 + 15 + 4: the 4 could be recovered from everyone − Sales − Ops, so Sales (the smaller) is hidden as well */
  const a = buildBenchmark([...people(12, "Sales"), ...people(15, "Ops"), ...people(4, "Legal")], { fingerprint: "f" });
  assert.equal(a.all.calm!.n, 31);
  assert.deepEqual(Object.keys(a.groups.dept ?? {}), ["Ops"]);
  /* 12 + 15 + 6 + 5: eleven hidden people cannot be singled out by subtraction */
  const b = buildBenchmark([...people(12, "Sales"), ...people(15, "Ops"), ...people(6, "Legal"), ...people(5, "HR")], { fingerprint: "f" });
  assert.deepEqual(Object.keys(b.groups.dept!).sort(), ["Ops", "Sales"]);
  /* people with no group are hidden people too */
  const c = buildBenchmark([...people(12, "Sales"), ...people(15, "Ops"), ...people(2, null)], { fingerprint: "f" });
  assert.deepEqual(Object.keys(c.groups.dept!), ["Ops"]);
  /* nobody hidden: every group shown */
  const d = buildBenchmark([...people(12, "Sales"), ...people(15, "Ops")], { fingerprint: "f" });
  assert.deepEqual(Object.keys(d.groups.dept!).sort(), ["Ops", "Sales"]);
  /* two groups, one small: no group figure survives */
  const e = buildBenchmark([...people(20, "Sales"), ...people(3, "Ops")], { fingerprint: "f" });
  assert.equal(e.groups.dept, undefined);
});

test("standing: whole-number shares below and above, close to an exact count, never 100", () => {
  const scores = Array.from({ length: 200 }, (_, i) => (i * 37) % 101);
  const d = distribution(scores);
  for (const s of [0, 10, 50, 77, 100]) {
    const exact = (scores.filter((x) => x < s).length / scores.length) * 100;
    assert.ok(Math.abs(standing(d, s).below - exact) <= 2, `score ${s}: ${standing(d, s).below} vs ${exact}`);
  }
  assert.deepEqual(standing(distribution([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]), 1), { below: 0, above: 0 }, "everyone tied");
  assert.equal(standing(d, 1000).below, 99); assert.equal(standing(d, -5).above, 99);
});

test("a person sees everyone and their own group — never another group, never a group that is hidden", () => {
  const snap = buildBenchmark([...people(12, "Sales"), ...people(15, "Ops", 10)], { fingerprint: "f" });
  const [c] = compare(snap, { calm: 9, stress: null }, { dept: "Sales" }, "f");
  assert.equal(c!.everyone!.n, 27);
  assert.deepEqual(c!.groups.map((g) => [g.grouping, g.group, g.n]), [["dept", "Sales", 12]]);
  assert.ok(!JSON.stringify(c).includes("cuts"), "no cut points leave the snapshot");
  assert.deepEqual(compare(snap, { calm: 9 }, { dept: "Legal" }, "f")[0]!.groups, []);
  assert.deepEqual(compare(snap, { calm: 9 }, { dept: null }, "f")[0]!.groups, []);
});

test("no comparison across different scorings, and a plain reason when there is none", () => {
  const snap = buildBenchmark(people(12, null), { fingerprint: "f" });
  assert.match(compare(snap, { calm: 3 }, {}, "other")[0]!.note!, /not available/);
  assert.match(compare(null, { calm: 3 }, {}, "f")[0]!.note!, /not available/);
  assert.match(compare(snap, { work: 3 }, {}, "f")[0]!.note!, /at least 10 people/);
  assert.deepEqual(compare(snap, { calm: null }, {}, "f"), [], "no score, nothing to compare");
});
