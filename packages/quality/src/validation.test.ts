import test from "node:test";
import assert from "node:assert/strict";
import { syntheticLabelledCorpus, evaluateQuality, exclusionGate, DEFAULT_GATE } from "./validation.js";

/*
 * The engine against a labelled benchmark (SYNTHETIC — labels true by construction). These are regression floors:
 * a change to a rule or a weight that starts flagging genuine respondents, or stops catching the clear-cut cases,
 * fails here with the numbers. They are NOT the validation the roadmap requires before automatic exclusion — that
 * needs a person-labelled sample of real responses, and the gate below says so.
 */
const { def, responses } = syntheticLabelledCorpus();
const report = evaluateQuality(def, responses, 1_800_000_000_000);

test("the corpus covers every label, with hard negatives among the genuine", () => {
  for (const l of ["genuine", "inattentive", "duplicate", "suspicious", "fraudulent"]) assert.ok((report.byLabel[l]?.n ?? 0) >= 30, l);
  for (const p of ["fast careful reader", "strong opinions", "shared office IP", "terse mobile answers"]) assert.equal(report.byPersona[p]?.label, "genuine", p);
  assert.equal(report.responses, 360);
});

test("FLAGGED is precise and never lands on a genuine respondent, in any segment", () => {
  assert.ok(report.flagged.precision.rate >= 0.98, JSON.stringify(report.flagged));
  assert.equal(report.flagged.genuineFalsePositive.hits, 0, JSON.stringify(report.falsePositives.filter((f) => f.verdict === "FLAGGED")));
  for (const [k, s] of Object.entries(report.genuineBySegment)) assert.equal(s.flagged.hits, 0, k);
});

test("the clear-cut problems are caught; suspicious cases go to review, not exclusion", () => {
  assert.ok(report.recallByLabel.fraudulent!.rate >= 0.95);
  assert.ok(report.recallByLabel.duplicate!.rate >= 0.95);
  assert.ok(report.recallByLabel.inattentive!.rate >= 0.95);
  assert.ok(report.recallByLabel.suspicious!.rate >= 0.8);
  assert.equal(report.byPersona["pasted polished text, locale/timezone mismatch"]!.FLAGGED, 0, "circumstantial evidence is never an exclusion");
});

test("the review queue stays mostly free of genuine respondents (hard negatives included)", () => {
  assert.ok(report.detected.genuineFalsePositive.rate <= 0.12, `${report.detected.genuineFalsePositive.rate}`);
  for (const p of ["fast careful reader", "strong opinions", "shared office IP"]) assert.ok(report.byPersona[p]!.REVIEW <= 3, p);
});

test("the gate stays locked on a synthetic corpus, whatever the numbers, and names why", () => {
  const g = exclusionGate(report);
  assert.equal(g.open, false);
  assert.ok(g.reasons.some((r) => r.startsWith("manual labels")), g.reasons.join(" | "));
  /* the same report presented as person-labelled would clear every other check */
  const asManual = exclusionGate({ ...report, source: "manual" });
  assert.deepEqual(asManual.reasons, [], asManual.reasons.join(" | "));
  /* and a stricter genuine-review ceiling locks it again */
  assert.equal(exclusionGate({ ...report, source: "manual" }, { ...DEFAULT_GATE, maxGenuineReview: 0.01 }).open, false);
});
