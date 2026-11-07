import test from "node:test";
import assert from "node:assert/strict";
import { assessSurvey } from "./engine.js";
import { syntheticLabelledCorpus } from "./validation.js";
import { cleaningImpact, qualityDimensions, qualityOutcome, DIMENSIONS } from "./impact.js";

const { def, responses } = syntheticLabelledCorpus({ genuine: 120, perProblem: 15 });
const result = assessSurvey(def, responses.map((l) => l.response), undefined, 1_800_000_000_000);
const label = new Map(responses.map((l) => [l.response.sessionId, l.label]));
const rows = responses.map((l) => {
  const q = result.bySession.get(l.response.sessionId)!;
  return { sessionId: l.response.sessionId, status: "complete", answers: l.response.answers, quality: q, reviewStatus: q.verdict === "FLAGGED" ? "REMOVE" : q.verdict === "REVIEW" ? "REVIEW_LATER" : "KEEP" };
});

test("six dimensions cover every scored category except custom; outcomes split FLAGGED by what the evidence is about", () => {
  const covered = new Set(DIMENSIONS.flatMap((d) => d.categories));
  for (const c of ["timing", "matrix", "consistency", "pattern", "attention", "open_end", "interaction", "navigation", "device", "network", "bot", "duplicate", "cluster", "screener"]) assert.ok(covered.has(c as never), c);
  assert.equal(qualityDimensions({ timing: 40, bot: 10, interaction: 70 }).behavioural_integrity, 70);
  const outcomeBy = (lab: string) => rows.filter((r) => label.get(r.sessionId) === lab).map((r) => qualityOutcome(r.quality));
  assert.ok(outcomeBy("fraudulent").every((o) => o === "suspected_fraud"), outcomeBy("fraudulent").join());
  assert.ok(outcomeBy("duplicate").every((o) => o === "suspected_fraud"));
  assert.ok(outcomeBy("inattentive").every((o) => o === "low_quality"), outcomeBy("inattentive").join());
  assert.ok(outcomeBy("genuine").filter((o) => o === "verified").length >= 100);
});

test("a pass the engine could not test is inconclusive, not verified", () => {
  const a = { ...rows[0]!.quality, verdict: "PASS" as const, notMeasured: ["timing"] };
  assert.equal(qualityOutcome(a as never), "inconclusive");
});

test("the before-and-after report: counts, reasons, quality up, outcomes, and the shares cleaning moved", () => {
  const r = cleaningImpact(def, rows);
  assert.equal(r.before, rows.length);
  assert.equal(r.removed, rows.filter((x) => x.reviewStatus === "REMOVE").length);
  assert.equal(r.after, r.before - r.removed);
  assert.ok(r.removedBecause.length > 0 && r.removedBecause.reduce((s, x) => s + x.count, 0) === r.removed);
  assert.ok(r.qualityScore.after! > r.qualityScore.before!, JSON.stringify(r.qualityScore));
  assert.equal(r.outcomes.after.suspected_fraud, 0);
  /* the bots all answered "Never" to driving frequency: removing them moves that share, and the report says so */
  const never = r.shifts.find((s) => s.code === "Q2" && s.option === "Never");
  assert.ok(never && never.points < 0, JSON.stringify(r.shifts.slice(0, 5)));
  assert.ok(r.shifts.every((s) => Math.abs(s.points) >= r.notablePoints));
  for (let i = 1; i < r.shifts.length; i++) assert.ok(Math.abs(r.shifts[i - 1]!.points) >= Math.abs(r.shifts[i]!.points));
});
