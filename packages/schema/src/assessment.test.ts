import { test } from "node:test";
import assert from "node:assert/strict";
import { AssessmentSettings, QuestionAssessment, parseSurvey } from "./index.js";

/**
 * ASSESSMENTS (ported 2026-10-29): `question.assessment` and `def.assessment`
 * are optional — a survey that is not a test parses exactly as before.
 */

const base = {
  meta: { id: "s1", title: "Paper" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_choice", text: "Capital of India?",
      options: [{ code: "1", label: "Delhi" }, { code: "2", label: "Mumbai" }] },
  ],
};

test("a survey without assessment parses unchanged (no assessment keys appear)", () => {
  const def = parseSurvey(base);
  assert.equal(def.assessment, undefined);
  assert.equal((def.questions[0] as { assessment?: unknown }).assessment, undefined);
});

test("question.assessment and def.assessment parse with their defaults", () => {
  const def = parseSurvey({
    ...base,
    assessment: { passPercent: 33 },
    questions: [{ ...base.questions[0], assessment: { correct: ["1"], topic: "Polity", explanation: "Delhi." } }],
  });
  assert.equal(def.assessment?.enabled, true);
  assert.equal(def.assessment?.defaultMarks, 1);
  assert.equal(def.assessment?.defaultNegativeMarks, 0);
  assert.equal(def.assessment?.showResults, "after_submit");
  assert.equal(def.assessment?.report.weakAreas, true);
  const qa = (def.questions[0] as { assessment?: QuestionAssessment }).assessment;
  assert.deepEqual(qa?.correct, ["1"]);
  assert.equal(qa?.topic, "Polity");
});

test("invalid marking is refused (negative deduction must be positive, pass % ≤ 100)", () => {
  assert.equal(QuestionAssessment.safeParse({ correct: ["1"], negativeMarks: -1 }).success, false);
  assert.equal(AssessmentSettings.safeParse({ passPercent: 120 }).success, false);
  assert.equal(AssessmentSettings.safeParse({ showResults: "sometimes" }).success, false);
});
