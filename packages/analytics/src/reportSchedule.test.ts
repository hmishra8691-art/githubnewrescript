import { test } from "node:test";
import assert from "node:assert/strict";
import { synthDataset, D } from "./analyses/fixture.js";
import { runAnalysis } from "./analyses/index.js";
import { changeSummary, checkAlert, digestResults, nextRunAt, type MetricDigest } from "./reportSchedule.js";

/* R5 + R6 — what changed since the last run, when the next run is, and alerts that fire once when a metric crosses */
const ds = synthDataset();

test("a digest keeps the base, the KPIs and the first series by category — from real results", () => {
  const nps = runAnalysis(D("nps", ["NPS"]), ds);
  const region = runAnalysis(D("descriptive", ["REGION"]), ds);
  const d = digestResults({ nps, region, bad: { ...region, error: { message: "x" } } as never }, "2026-11-01T00:00:00Z");
  assert.equal(d.analyses.nps.n, nps.base.n);
  assert.ok(Object.keys(d.analyses.nps.kpis).length >= 1);
  assert.ok(Object.keys(d.analyses.region.values).length >= 2);
  assert.ok(!("bad" in d.analyses));
});

const prev: MetricDigest = { at: "2026-11-15T07:00:00Z", analyses: {
  a: { name: "Awareness", n: 400, kpis: {}, values: { "Brand A": 41, "Brand B": 30 }, pct: true },
  k: { name: "NPS", n: 400, kpis: { NPS: 12 }, values: {}, pct: false },
  g: { name: "Gone", n: 50, kpis: {}, values: {}, pct: false },
  s: { name: "Small cell", n: 20, kpis: {}, values: { Yes: 50 }, pct: true },
} };
const next: MetricDigest = { at: "2026-11-22T07:00:00Z", analyses: {
  a: { name: "Awareness", n: 520, kpis: {}, values: { "Brand A": 47.5, "Brand B": 31 }, pct: true },
  k: { name: "NPS", n: 520, kpis: { NPS: 8 }, values: {}, pct: false },
  n: { name: "New one", n: 520, kpis: {}, values: {}, pct: false },
  s: { name: "Small cell", n: 24, kpis: {}, values: { Yes: 70 }, pct: true },
} };

test("the change summary: biggest movement first, bases, new and removed, small bases not called findings", () => {
  const c = changeSummary(prev, next);
  assert.equal(c.changes[0].label, "Awareness · Brand A");
  assert.match(c.changes[0].sentence, /“Brand A” up 6\.5 points, 41% → 47\.5%/);
  assert.ok(c.changes.some((x) => x.kind === "kpi" && /NPS fell from 12 to 8/.test(x.sentence)));
  assert.ok(!c.changes.some((x) => x.label === "Awareness · Brand B"), "a 1-point move is below the 3-point threshold");
  assert.ok(c.changes.some((x) => x.kind === "added" && x.label === "New one"));
  assert.ok(c.changes.some((x) => x.kind === "removed" && x.label === "Gone"));
  const small = c.changes.find((x) => x.label === "Small cell · Yes")!;
  assert.equal(small.magnitude, 0);
  assert.match(small.sentence, /fewer than 30 respondents, so not a finding/);
  assert.match(c.headline, /^2 figures moved since 2026-11-15; the largest: Awareness: “Brand A” up 6\.5 points/);
  assert.match(changeSummary(null, next).headline, /First run/);
  assert.match(changeSummary(next, next).headline, /Nothing changed/);
});

test("next run: daily, weekly on a weekday, monthly on a day that some months do not have", () => {
  const after = new Date("2026-11-22T10:30:00Z"); // a Sunday
  assert.equal(nextRunAt({ cadence: "daily", hourUtc: 7 }, after).toISOString(), "2026-11-23T07:00:00.000Z");
  assert.equal(nextRunAt({ cadence: "daily", hourUtc: 11 }, after).toISOString(), "2026-11-22T11:00:00.000Z");
  assert.equal(nextRunAt({ cadence: "weekly", hourUtc: 7, weekday: 1 }, after).toISOString(), "2026-11-23T07:00:00.000Z");
  assert.equal(nextRunAt({ cadence: "weekly", hourUtc: 7, weekday: 0 }, after).toISOString(), "2026-11-29T07:00:00.000Z", "today's hour has passed: next week");
  assert.equal(nextRunAt({ cadence: "monthly", hourUtc: 6, dayOfMonth: 31 }, after).toISOString(), "2026-11-30T06:00:00.000Z");
  assert.equal(nextRunAt({ cadence: "monthly", hourUtc: 6, dayOfMonth: 31 }, new Date("2026-11-30T07:00:00Z")).toISOString(), "2026-12-31T06:00:00.000Z");
});

test("an alert fires once when the metric crosses, not on every run it stays over; never on a small base", () => {
  const rule = { analysisId: "a", metric: "Brand A", op: "above" as const, threshold: 45 };
  const crossed = checkAlert(rule, next, prev);
  assert.equal(crossed.fire, true);
  assert.match(crossed.sentence, /Brand A is 47\.5%, above the threshold of 45% \(it was 41%\) — n = 520/);
  assert.equal(checkAlert(rule, next, next).fire, false, "still over: not told again");
  assert.equal(checkAlert({ analysisId: "k", metric: "NPS", op: "below", threshold: 10 }, next, prev).fire, true);
  const smallRule = checkAlert({ analysisId: "s", metric: "Yes", op: "above", threshold: 60 }, next, prev);
  assert.equal(smallRule.fire, false);
  assert.match(smallRule.sentence, /rests on 24 respondents/);
  assert.match(checkAlert({ ...rule, metric: "Nope" }, next, prev).sentence, /not in the latest results/);
});
