import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SurveyDefinition } from "@rescript/schema";
import { assessmentSettings, gradedQuestions, isRespondentQuestion } from "@rescript/engine";
import { __resetTaskRegistry, getStepHandler, listCompletionValidators, pickTaskPlanner } from "../registry.ts";
import { __resetFakeResponders } from "../fakeResponders.ts";
import { buildDraft } from "../draft.ts";
import { runTaskInProcess } from "../testing.ts";
import { registerAllTaskHandlers } from "./index.ts";
import { assessmentPlanner, assessmentReportTurn, examValidation, markingFrom } from "./assessment.ts";

/*
 * A SCORED EXAM AS A TASK (step 4B, 2026-10-29): the planner on the production requests, whole tasks run in-process
 * (memory store, the generation family's fake responder as the model), the completion validator, and the
 * deterministic answer to the per-question results follow-up.
 */
const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "T" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
const UPSC_HI = "मुझे UPSC प्रीलिम्स की तैयारी के लिए एक मॉक टेस्ट चाहिए। इसमें General Studies Paper 1 के 100 questions होने चाहिए — इतिहास, भूगोल, राजव्यवस्था, अर्थव्यवस्था, पर्यावरण, विज्ञान और करंट अफेयर्स से। हर प्रश्न multiple choice हो, चार विकल्प के साथ, और हर प्रश्न का सही उत्तर और एक छोटी व्याख्या भी दो। कठिनाई स्तर असली UPSC परीक्षा जैसा होना चाहिए। प्रश्न हिंदी में हों।";
const SHORT = "100 questions, General Studies, UPSC, answer key, 2 marks, −0.66";
const FOLLOW = "for every question show what was correct, what I selected, explanations and weak areas";
function setup() { __resetTaskRegistry(); __resetFakeResponders(); registerAllTaskHandlers(); }

test("marking is read from the request: UPSC Prelims GS, '2 marks, −0.66', 'negative marking of 0.66 for each wrong', '+4 / −1', none", () => {
  assert.deepEqual([markingFrom(SHORT).defaultMarks, markingFrom(SHORT).defaultNegativeMarks], [2, 0.66]);
  const hi = markingFrom(UPSC_HI);
  assert.deepEqual([hi.defaultMarks, hi.defaultNegativeMarks], [2, 0.66], "UPSC प्रीलिम्स GS: +2 / −0.66");
  const en = markingFrom("Build a mock: 100 MCQs with an answer key, 2 marks for each correct answer and negative marking of 0.66 for each wrong one");
  assert.deepEqual([en.defaultMarks, en.defaultNegativeMarks], [2, 0.66]);
  const neet = markingFrom("50 question quiz, +4 for correct, -1 for wrong, pass at 40%");
  assert.deepEqual([neet.defaultMarks, neet.defaultNegativeMarks, neet.passPercent], [4, 1, 40]);
  const none = markingFrom("a 30-question quiz on world capitals with an answer key");
  assert.equal(none.defaultMarks, undefined, "30-question is not a mark");
  assert.equal(none.defaultNegativeMarks, undefined);
  assert.equal(markingFrom("20 questions, 1 mark each, no negative marking").defaultNegativeMarks, 0);
});

test("planner: an exam of ≥ 20 questions is forced into a task (0.95, above the generation planner's 0.7); other requests are not its", () => {
  setup();
  const m = (msg: string, s: unknown = empty()) => assessmentPlanner.matches({ message: msg, survey: s });
  assert.equal(m(SHORT), 0.95);
  assert.equal(m(UPSC_HI), 0.95);
  assert.equal(pickTaskPlanner({ message: UPSC_HI, survey: empty() })?.planner.id, "assessment");
  assert.equal(pickTaskPlanner({ message: SHORT, survey: empty() })?.planner.id, "assessment");
  assert.equal(m("Create a 100-question survey about mobile banking"), 0, "a survey, not a paper");
  assert.equal(m("a 10 question quiz"), 0, "small: a single turn");
  assert.equal(m(FOLLOW), 0, "the follow-up is not a task");
  assert.equal(pickTaskPlanner({ message: "Create a 104-question survey about mobile banking", survey: empty() })?.planner.id, "generation");
});

async function paperTask(message: string) {
  setup();
  const r = await runTaskInProcess({ message, definition: empty() });
  const def = buildDraft(r.task).def;
  return { r, def };
}

function assertPaper(r: Awaited<ReturnType<typeof paperTask>>["r"], def: SurveyDefinition, n: number) {
  assert.equal(r.task.planner, "assessment");
  assert.equal(r.task.kind, "scored_exam");
  assert.equal(r.task.status, "completed", JSON.stringify(r.task.report?.problems ?? r.task.steps.filter((s) => s.status !== "completed").map((s) => [s.stepId, s.status, s.validation])));
  const respondent = def.questions.filter(isRespondentQuestion);
  assert.equal(respondent.length, n, `${n} questions`);
  assert.equal(new Set(def.questions.map((q) => q.code)).size, def.questions.length, "unique codes");
  const graded = gradedQuestions(def);
  assert.equal(graded.length, n, `${n} keyed`);
  for (const q of graded) {
    const codes = (q.options ?? []).map((o) => String(o.code));
    assert.ok(q.assessment!.correct.length >= 1 && q.assessment!.correct.every((c) => codes.includes(String(c))), `${q.code}: the key names an existing option`);
    assert.ok((q.assessment!.explanation ?? "").trim(), `${q.code}: explanation`);
    assert.ok((q.assessment!.topic ?? "").trim(), `${q.code}: topic`);
  }
  const s = assessmentSettings(def)!;
  assert.ok(s, "the paper is switched on");
  assert.equal(s.showResults, "after_submit");
  assert.equal(s.expectedQuestions, n);
  /* the plan: settings first, content batches of ≤ 20 whose own actions carry one set_answer_key per question, then the check */
  const steps = r.task.steps.filter((x) => x.status !== "tombstoned");
  assert.equal(steps[0]?.stepId, "assess_settings");
  const batches = steps.filter((x) => x.kind === "gen.batch");
  assert.ok(batches.length >= 5 && batches.length <= 25, `${batches.length} batches`);
  for (const b of batches) {
    assert.ok((b.batchSize ?? 0) <= 20, `${b.stepId}: ${b.batchSize}`);
    const acts = ((b.output as { actions?: { op: string; target?: string }[] } | null)?.actions ?? []);
    const created = acts.filter((a) => a.op === "create_question").length;
    const keys = acts.filter((a) => a.op === "set_answer_key").length;
    assert.ok(created > 0 && keys === created, `${b.stepId}: ${created} questions, ${keys} keys in the batch's own actions`);
  }
  const check = steps.find((x) => x.stepId === "assess_check");
  assert.equal(check?.kind, "assessment.validate");
  assert.equal(check?.status, "completed");
  assert.equal(check?.validation?.status, "valid");
  assert.ok(r.task.completion?.includes(`assessment:${n}`));
  return s;
}

test("ACCEPTANCE: the production 650-char Hindi UPSC brief → one scored_exam task, 100 questions, 100 keyed, UPSC marking", async () => {
  assert.ok(UPSC_HI.length >= 300 && UPSC_HI.length < 1500, `${UPSC_HI.length} chars (below isLongBrief's 1,500)`);
  const { r, def } = await paperTask(UPSC_HI);
  const s = assertPaper(r, def, 100);
  assert.equal(s.defaultMarks, 2);
  assert.equal(s.defaultNegativeMarks, 0.66);
});

test("'100 questions, General Studies, UPSC, answer key, 2 marks, −0.66' → 100 keyed questions, +2 / −0.66", async () => {
  const { r, def } = await paperTask(SHORT);
  const s = assertPaper(r, def, 100);
  assert.deepEqual([s.defaultMarks, s.defaultNegativeMarks], [2, 0.66]);
});

test("the completion validator: registered, judges only this planner's tasks, and refuses a paper with an unkeyed question, a key on a missing option or a wrong count", async () => {
  setup();
  const v = listCompletionValidators().find(([id]) => id === "assessment.validate")?.[1];
  assert.ok(v, "registered");
  assert.ok(getStepHandler("assessment.settings") && getStepHandler("assessment.validate"));
  const { def } = await paperTask("a 20-question practice quiz on Indian polity with answer key, 1 mark each");
  assert.equal(v!(def, ["assessment:20"], { id: "t", planner: "generation", summary: {} }), null, "not its task");
  assert.equal(v!(def, ["assessment:20"], { id: "t", planner: "assessment", summary: {} })?.ok, true);
  assert.equal(v!(def, ["assessment:21"], { id: "t", planner: "assessment", summary: {} })?.ok, false, "count exact");
  const broken = structuredClone(def);
  broken.questions[0].assessment = { ...broken.questions[0].assessment!, correct: ["9"] };
  delete broken.questions[1].assessment;
  const bad = examValidation(broken, 20);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /no answer key/.test(e) && e.includes(String(broken.questions[1].code))), bad.errors.join(" | "));
  assert.ok(bad.errors.some((e) => e.includes(String(broken.questions[0].code))), "the key on a missing option names its question");
});

test("FOLLOW-UP: 'for every question show what was correct, what I selected, explanations and weak areas' → a deterministic answer, no task, no model", async () => {
  const { def } = await paperTask("a 20-question practice quiz on Indian polity with answer key, 1 mark each");
  /* the report already on: an answer, nothing to change */
  const on = assessmentReportTurn(FOLLOW, def)!;
  assert.ok(on, "answered");
  assert.equal(on.actions.length, 0);
  assert.match(on.reply, /results page/);
  assert.match(on.reply, /Data Analytics → Assessment results/);
  assert.match(on.reply, /All 20 choice questions are keyed/);
  /* the report off (or the survey never switched on): the one set_assessment that turns it on */
  const off = structuredClone(def);
  off.assessment = { ...off.assessment!, showResults: "never" };
  const r = assessmentReportTurn(FOLLOW, off)!;
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].op, "set_assessment");
  assert.equal((r.actions[0] as { showResults?: string }).showResults, "after_submit");
  /* the production case: a 104-question survey with NO key — answered, keys named as missing, never invented */
  const plain = structuredClone(def);
  delete plain.assessment;
  for (const q of plain.questions) delete q.assessment;
  const p = assessmentReportTurn(FOLLOW, plain)!;
  assert.match(p.reply, /20 of 20 choice questions have no answer key/);
  assert.equal(p.actions.length, 1);
  /* Hindi */
  assert.ok(assessmentReportTurn("हर प्रश्न के लिए दिखाओ कि सही उत्तर क्या था, मैंने क्या चुना, व्याख्या और कमजोर क्षेत्र", def));
  /* not this: a build request that mentions a weak-area report, an unrelated survey request, no choice questions */
  assert.equal(assessmentReportTurn("Create a 100-question UPSC Prelims GS practice paper with answer key, scoring, explanations and a final report of weak areas", def), null);
  assert.equal(assessmentReportTurn("Add a question on the weak areas of our product for every question block", plain), null, "not about a paper");
  assert.equal(assessmentReportTurn(FOLLOW, empty()), null);
  assert.equal(assessmentReportTurn("add an NPS question", def), null);
});

test("the turn route answers the follow-up before the plan-first path and before any model call", () => {
  const src = readFileSync(new URL("../../../app/api/copilot/turn/route.ts", import.meta.url), "utf8");
  const hook = src.indexOf("assessmentReportTurn(message, def)");
  assert.ok(hook > 0, "hooked");
  assert.ok(hook < src.indexOf("await taskForTurn("), "before the plan-first path");
  assert.ok(hook < src.indexOf("await billingProjectFor("), "before billing: no charge");
  assert.match(src.slice(hook, hook + 1400), /modelCalled: false/);
  assert.match(src.slice(hook, hook + 1400), /charge: 0/);
});
