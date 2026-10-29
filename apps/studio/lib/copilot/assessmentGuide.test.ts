import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, validateAssessment } from "@rescript/engine";
import { COPILOT_ASSESSMENT_GUIDE, assessmentIntent } from "./assessmentGuide.ts";
import { COPILOT_SYSTEM_PROMPT, copilotUserPrompt } from "./prompt.ts";
import { COPILOT_STABLE_GUIDES, copilotCall } from "../aiPromptCache.ts";
import { GUIDE_ORDER, guideForOp, itemGuideSelection } from "./guideSelect.ts";

/* THE ASSESSMENT GUIDE (2026-10-25, K4): sent with test / quiz / answer-key requests only, cached; examples apply as written */
const lines = (g: string) => g.split("\n").filter((l) => l.startsWith('{"op":')).map((l) => JSON.parse(l));
const def = () => SurveyDefinition.parse({
  meta: { id: "g", code: "G", title: "Mock" },
  questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Which Article protects life and liberty?", options: [{ code: 1, label: "Article 14" }, { code: 2, label: "Article 19" }, { code: 3, label: "Article 21" }, { code: 4, label: "Article 32" }] }],
  flow: [{ type: "page", id: "p", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }],
});

test("sent for test / quiz / answer key / results requests (English and Hindi), not otherwise; cached; prompt cap kept", () => {
  for (const m of ["create a 100-question UPSC Prelims GS paper with answer key", "for every question show which answer was correct, what I selected, explanations and weak areas", "make this a quiz with negative marking", "set the pass mark to 40%", "100 प्रश्नों का प्रश्न पत्र उत्तर कुंजी के साथ", "add explanations for each question"]) {
    assert.ok(assessmentIntent(m), m);
    const p = copilotUserPrompt({ outline: "(survey)", surveyLanguage: "English", mode: "edit", message: m });
    const [system] = copilotCall(p);
    assert.ok(system.some((b) => b.includes(COPILOT_ASSESSMENT_GUIDE)), `lifted into the cached prefix: ${m}`);
  }
  for (const m of ["Add a question about price", "make Q3 required", "translate to Urdu", "add a page break after Q2"]) assert.ok(!assessmentIntent(m), m);
  assert.ok(COPILOT_STABLE_GUIDES.includes(COPILOT_ASSESSMENT_GUIDE));
  assert.ok(GUIDE_ORDER.includes("assessment"));
  assert.equal(guideForOp("set_answer_key"), "assessment");
  assert.equal(guideForOp("set_assessment"), "assessment");
  assert.ok(COPILOT_SYSTEM_PROMPT.length < 14_800);
  assert.ok(COPILOT_ASSESSMENT_GUIDE.length < 2_800, `${COPILOT_ASSESSMENT_GUIDE.length}`);
  assert.match(COPILOT_ASSESSMENT_GUIDE, /NEVER write results/);
});

test("a staged item that names an answer key gets the assessment guide", () => {
  const sel = itemGuideSelection({ item: { id: "i1", kind: "questions", title: "Polity questions 1–20 with answer keys", reason: "", objects: [] } as never, build: {}, mode: "generate" });
  assert.ok(sel.all.includes("assessment"));
});

test("the worked examples apply as written and make a valid one-question paper", () => {
  const c = coerceSurveyActions(lines(COPILOT_ASSESSMENT_GUIDE));
  assert.deepEqual(c.rejected, []);
  assert.equal(c.actions.length, 2);
  const r = applySurveyActions(def(), c.actions);
  assert.deepEqual(r.errors, []);
  assert.equal(r.def.assessment!.defaultNegativeMarks, 0.66);
  assert.deepEqual(r.def.questions[0].assessment!.correct, [3]);
  assert.equal(validateAssessment(r.def, { requireExplanations: true, requireTopics: true, expectedCount: 1 }).ok, true);
});
