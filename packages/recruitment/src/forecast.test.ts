import test from "node:test";
import assert from "node:assert/strict";
import { forecast, forecastStatement, MIN_COMPLETES_TO_FORECAST, MIN_HOURS_TO_FORECAST } from "./forecast.js";

const NOW = new Date("2026-11-03T18:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

test("below the sample gate it refuses, and says what is missing", () => {
  const f = forecast({ startedAt: hoursAgo(24), now: NOW, target: 1000, accepted: 29 });
  assert.equal(f.status, "insufficient");
  assert.equal(f.reason, "too_few_completes");
  assert.equal(f.needCompletes, MIN_COMPLETES_TO_FORECAST);
  assert.match(f.explanation, /too few to project from/);
});

test("below the window gate it refuses even when the sample is large", () => {
  // 400/hour clears 30 completes in minutes. The clock still has to run.
  const f = forecast({ startedAt: hoursAgo(2), now: NOW, target: 5000, accepted: 800 });
  assert.equal(f.status, "insufficient");
  assert.equal(f.reason, "too_early");
  assert.match(f.explanation, /rate of the launch, not of the project/);
  assert.equal(f.needHours, MIN_HOURS_TO_FORECAST);
});

test("there is no third outcome — no low-confidence estimate to misread", () => {
  const f = forecast({ startedAt: hoursAgo(1), now: NOW, target: 1000, accepted: 5 });
  assert.equal(f.status, "insufficient");
  assert.ok(!("completionAt" in f), "an insufficient result carries no date at all");
  assert.ok(!("ratePerHour" in f), "nor a rate someone could multiply out themselves");
});

test("zero completes after a full day is reported as a problem, not as a slow forecast", () => {
  const f = forecast({ startedAt: hoursAgo(24), now: NOW, target: 1000, accepted: 0 });
  assert.equal(f.status, "insufficient");
  assert.equal(f.reason, "no_progress");
  assert.match(f.explanation, /check the links, the quotas and the screener/);
});

test("past both gates it projects completion from the observed rate", () => {
  // 300 completes in 12 hours = 25/hour; 700 to go ⇒ 28 hours.
  const f = forecast({ startedAt: hoursAgo(12), now: NOW, target: 1000, accepted: 300 });
  assert.equal(f.status, "forecast");
  assert.equal(f.ratePerHour, 25);
  assert.equal(f.remaining, 700);
  assert.equal(f.hoursToComplete, 28);
  assert.equal(f.completionAt, new Date(NOW.getTime() + 28 * 3_600_000).toISOString());
});

test("the range brackets the point estimate and is wide enough to be worth printing", () => {
  const f = forecast({ startedAt: hoursAgo(12), now: NOW, target: 1000, accepted: 300 });
  assert.equal(f.status, "forecast");
  const earliest = Date.parse(f.completionRange!.earliest);
  const latest = Date.parse(f.completionRange!.latest);
  const point = Date.parse(f.completionAt!);
  assert.ok(earliest < point && point < latest, "the point estimate sits inside its own range");
  const spreadHours = (latest - earliest) / 3_600_000;
  assert.ok(spreadHours > 5, `a 300-complete sample gives a real spread, got ${spreadHours.toFixed(1)}h`);
});

test("more evidence narrows the range", () => {
  const thin = forecast({ startedAt: hoursAgo(12), now: NOW, target: 10000, accepted: 50 });
  const thick = forecast({ startedAt: hoursAgo(12), now: NOW, target: 10000, accepted: 5000 });
  assert.equal(thin.status, "forecast");
  assert.equal(thick.status, "forecast");
  const spread = (f: typeof thin & { status: "forecast" }) =>
    (Date.parse(f.completionRange!.latest) - Date.parse(f.completionRange!.earliest)) / (f.hoursToComplete ?? 1);
  assert.ok(spread(thick as never) < spread(thin as never), "relative uncertainty falls as completes accumulate");
});

test("cost is projected to the target and flagged when it breaches the budget", () => {
  const f = forecast({
    startedAt: hoursAgo(12), now: NOW, target: 1000, accepted: 300,
    spend: 1800, budget: 5000, currency: "GBP",
  });
  assert.equal(f.status, "forecast");
  assert.equal(f.projectedCost, 6000, "£6 a complete to a target of 1,000");
  assert.equal(f.overBudget, true);
  assert.match(forecastStatement(f), /over budget/);
});

test("no spend means no projected cost — not a projected cost of zero", () => {
  const f = forecast({ startedAt: hoursAgo(12), now: NOW, target: 1000, accepted: 300, budget: 5000 });
  assert.equal(f.status, "forecast");
  assert.equal(f.projectedCost, null);
  assert.equal(f.overBudget, false, "unknown cost cannot breach a budget");
});

test("a finished project forecasts nothing further and says so", () => {
  const f = forecast({ startedAt: hoursAgo(40), now: NOW, target: 1000, accepted: 1000 });
  assert.equal(f.status, "forecast");
  assert.equal(f.remaining, 0);
  assert.equal(f.hoursToComplete, null);
  assert.equal(f.completionRange, null);
  assert.match(forecastStatement(f), /Target reached/);
});

test("a start time in the future is refused rather than divided by", () => {
  const f = forecast({ startedAt: new Date(NOW.getTime() + 3_600_000).toISOString(), now: NOW, target: 100, accepted: 10 });
  assert.equal(f.status, "insufficient");
  assert.equal(f.reason, "not_started");
});
