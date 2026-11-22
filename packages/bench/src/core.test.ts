import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, meets, pct, renderScorecard, runSuites, type Metric, type Scorecard, type Suite } from "./core.js";

const metric = (over: Partial<Metric> = {}): Metric => ({ id: "m", label: "Detected", value: 80, unit: "%", better: "higher", target: 95, ...over });
const card = (value: number, extra: Partial<Metric> = {}): Scorecard => ({ version: 1, at: "t", commit: null, suites: [{ id: "s", area: "fraud", title: "Suite", status: "measured", metrics: [metric({ value, ...extra })], cases: [], ms: 1 }] });

test("a target is a goal, a baseline is a floor", () => {
  assert.equal(meets(metric({ value: 95 })), true);
  assert.equal(meets(metric({ value: 94.9 })), false);
  assert.equal(meets(metric({ better: "lower", unit: "ms", value: 150, target: 150 })), true);
  assert.equal(pct(1, 3), 33.3);
  /* below target but not worse than before: a gap, and the run is fine */
  const same = compare(card(80), card(80));
  assert.deepEqual([same.ok, same.gaps.length, same.regressions.length], [true, 1, 0]);
  /* worse than before by more than a point: a regression, and the run fails */
  const worse = compare(card(78), card(80));
  assert.deepEqual([worse.ok, worse.regressions.map((r) => [r.was, r.now])], [false, [[80, 78]]]);
  /* within tolerance is noise */
  assert.equal(compare(card(79.5), card(80)).ok, true);
  assert.equal(compare(card(90), card(80)).improvements.length, 1);
  /* no baseline yet: nothing can regress */
  assert.equal(compare(card(10), null).ok, true);
});

test("a timing that got slower warns instead of failing, because the machine may differ", () => {
  const t = { unit: "ms" as const, better: "lower" as const, target: 100, machineDependent: true };
  const c = compare(card(400, t), card(200, t));
  assert.deepEqual([c.ok, c.regressions.length, c.warnings.length], [true, 0, 1]);
});

test("a benchmark cannot disappear quietly", () => {
  const baseline = card(80);
  const none: Scorecard = { version: 1, at: "t", commit: null, suites: [] };
  assert.deepEqual([compare(none, baseline).ok, compare(none, baseline).missing.length], [false, 1]);
  const blocked: Scorecard = { ...none, suites: [{ id: "s", area: "fraud", title: "Suite", status: "blocked", reason: "no key", metrics: [], cases: [], ms: 0 }] };
  const c = compare(blocked, baseline);
  assert.deepEqual([c.ok, c.blocked, c.missing.length], [false, [{ suite: "s", reason: "no key" }], 1]);
  const renamed: Scorecard = { ...none, suites: [{ ...baseline.suites[0]!, metrics: [metric({ id: "other" })] }] };
  assert.match(compare(renamed, baseline).missing[0]!, /no longer reports m/);
});

test("a suite that throws is blocked with its error, never scored", async () => {
  const suites: Suite[] = [
    { id: "good", area: "fraud", title: "Good", run: () => ({ status: "measured", metrics: [metric()], cases: [{ id: "c1", pass: false, detail: "missed" }] }) },
    { id: "bad", area: "import", title: "Bad", run: () => { throw new Error("boom"); } },
  ];
  let clock = 0;
  const out = await runSuites(suites, { now: () => (clock += 5), at: "2026-11-22T00:00:00Z", commit: "abc" });
  assert.deepEqual(out.suites.map((s) => [s.id, s.status, s.ms]), [["good", "measured", 5], ["bad", "blocked", 5]]);
  assert.match(out.suites[1]!.reason!, /boom/);
  const md = renderScorecard(out, compare(out, null));
  assert.match(md, /1 of 2 benchmarks measured\. 0 of 1 metrics meet their Level 5 target/);
  assert.match(md, /\| Detected \| 80% \| at least 95% \| no \|/);
  assert.match(md, /\*\*Not measured\.\*\* the suite failed to run: boom/);
  assert.match(md, /1 cases, 1 not passing\. First: c1 \(missed\)/);
  assert.match(md, /## AI design agents\n\nNo benchmark yet\./);
});

test("an informational metric is shown and compared but is neither a gap nor counted as meeting a target", async () => {
  const suite = (v: number): Suite => ({ id: "fraud.x", area: "fraud", title: "X", run: () => ({ status: "measured", metrics: [{ id: "share", label: "Share", value: v, unit: "%", better: "lower", target: 0, informational: true }], cases: [] }) });
  const base = await runSuites([suite(40)]), now = await runSuites([suite(60)]);
  const cmp = compare(now, base);
  assert.equal(cmp.gaps.length, 0);
  assert.equal(cmp.regressions.length, 1);
  assert.match(renderScorecard(now), /0 of 0 metrics meet/);
  assert.match(renderScorecard(now), /none set/);
});
