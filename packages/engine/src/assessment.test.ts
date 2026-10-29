import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, SURVEY_ACTION_OPS } from "./surveyActions.js";
import {
  assessmentAnalytics, assessmentColumnNames, assessmentColumns, assessmentKeyFingerprint, assessmentSecretsPresent,
  respondentAssessmentReport, scoreAssessment, stripAssessmentSecrets, validateAssessment, assessmentSelectedCodes as selectedCodes,
  assessmentKeyLeaks, stripAssessmentForRespondent,
} from "./assessment.js";
import { resolveKeyOption } from "./assessmentActions.js";

const opts4 = () => [{ code: 1, label: "Article 14" }, { code: 2, label: "Article 19" }, { code: 3, label: "Article 21" }, { code: 4, label: "Article 32" }];
const mcq = (n: number, topic: string, correct: number[], extra: Record<string, unknown> = {}) => ({
  id: `q${n}`, code: `Q${n}`, variableName: `Q${n}`, type: correct.length > 1 ? "multi_select" : "single_select", text: `Question ${n}`,
  options: opts4(),
  assessment: { correct, topic, explanation: `Because ${correct.join("+")} is right`, optionExplanations: { "1": "14 is equality" }, ...extra },
});
const paper = (assessment: Record<string, unknown> = {}) => SurveyDefinition.parse({
  meta: { id: "s", code: "UPSC", title: "UPSC GS", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [mcq(1, "Polity", [3]), mcq(2, "Polity", [2]), mcq(3, "Economy", [4]), mcq(4, "Economy", [1]), mcq(5, "History", [2, 3])],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4", "q5"] }, { type: "end", id: "e1", status: "complete" }],
  assessment: { defaultMarks: 2, defaultNegativeMarks: 0.66, passPercent: 40, ...assessment },
});

test("UPSC marking: +2 correct, −0.66 wrong, 0 unattempted; totals, percentage, pass", () => {
  const def = paper();
  const r = scoreAssessment(def, { q1: 3, q2: 1, q3: "4", q5: [2, 3] });
  assert.deepEqual(r.questions.map((q) => q.status), ["correct", "incorrect", "correct", "unattempted", "correct"]);
  assert.deepEqual(r.questions.map((q) => q.marks), [2, -0.66, 2, 0, 2]);
  assert.equal(r.marks, 5.34); assert.equal(r.maxMarks, 10); assert.equal(r.negative, 0.66);
  assert.equal(r.percentage, 53.4); assert.equal(r.passMark, 4); assert.equal(r.passed, true);
  assert.equal(r.attempted, 4); assert.equal(r.correct, 3); assert.equal(r.incorrect, 1); assert.equal(r.unattempted, 1);
  assert.equal(r.questions[1].mistakeExplanation, "14 is equality", "the explanation of the option the respondent chose");
  assert.deepEqual(r.questions[1].selectedLabels, ["Article 14"]);
  assert.deepEqual(r.questions[1].correctLabels, ["Article 19"]);
  // all wrong → negative total, fail
  const bad = scoreAssessment(def, { q1: 1, q2: 1, q3: 1, q4: 2, q5: [1] });
  assert.equal(bad.marks, -3.3); assert.equal(bad.passed, false); assert.ok(bad.percentage < 0);
});

test("multi-answer: none = all or nothing; proportional; proportional_no_wrong", () => {
  const none = paper();
  assert.equal(scoreAssessment(none, { q5: [2] }).questions[4].status, "incorrect");
  assert.equal(scoreAssessment(none, { q5: [2] }).questions[4].marks, -0.66);
  const prop = paper({ partialCredit: "proportional" });
  let q5 = scoreAssessment(prop, { q5: [2] }).questions[4];
  assert.equal(q5.status, "partial"); assert.equal(q5.marks, 1); assert.equal(q5.credit, 0.5);
  q5 = scoreAssessment(prop, { q5: [2, 1] }).questions[4];
  assert.equal(q5.status, "incorrect", "one right and one wrong cancel out"); assert.equal(q5.marks, -0.66);
  const strict = paper({ partialCredit: "proportional_no_wrong" });
  assert.equal(scoreAssessment(strict, { q5: [3] }).questions[4].marks, 1);
  assert.equal(scoreAssessment(strict, { q5: [3, 4] }).questions[4].status, "incorrect");
  // per-question override wins
  const def = paper();
  def.questions[4].assessment!.partialCredit = "proportional";
  assert.equal(scoreAssessment(def, { q5: [3] }).questions[4].status, "partial");
});

test("topic breakdown, weak areas (lowest first, threshold) and revision recommendations", () => {
  const def = paper();
  def.questions[2].assessment!.subtopic = "Banking";
  const r = scoreAssessment(def, { q1: 3, q2: 2, q3: 1, q5: [2, 3] });
  const t = Object.fromEntries(r.topics.map((x) => [x.topic, x]));
  assert.deepEqual([t.Polity.correct, t.Polity.attempted, t.Polity.accuracy, t.Polity.marks], [2, 2, 100, 4]);
  assert.deepEqual([t.Economy.correct, t.Economy.attempted, t.Economy.unattempted, t.Economy.accuracy, t.Economy.scoreRate, t.Economy.marks], [0, 1, 1, 0, 0, -0.66]);
  assert.deepEqual(r.weakAreas.map((w) => w.topic), ["Economy"]);
  assert.match(r.weakAreas[0].reason, /0 of 2 correct.*1 not attempted.*1 wrong/);
  assert.deepEqual(r.recommendations[0], { topic: "Economy", subtopics: ["Banking"], questions: ["Q3", "Q4"], reason: "Revise Economy: Banking (2 questions missed)" });
  // counting only attempted questions: History 1/1 fine, Economy 0/1 weak
  const r2 = scoreAssessment(paper({ weakCountsUnattempted: false, weakThreshold: 60 }), { q1: 3, q2: 1, q3: 1 });
  assert.deepEqual(r2.weakAreas.map((w) => w.topic), ["Economy", "Polity"]);
});

test("deterministic: same answers → identical result (re-score on reload), key fingerprint changes with the key", () => {
  const def = paper();
  const a = { q1: 3, q2: 1, q5: [3, 2] };
  assert.deepEqual(scoreAssessment(def, a), scoreAssessment(structuredClone(def), JSON.parse(JSON.stringify(a))));
  const fp = assessmentKeyFingerprint(def);
  def.questions[0].assessment!.correct = [2];
  assert.notEqual(assessmentKeyFingerprint(def), fp);
});

test("answer shapes: scalar, string, array, {code:true}", () => {
  assert.deepEqual(selectedCodes(3), ["3"]);
  assert.deepEqual(selectedCodes(""), []);
  assert.deepEqual(selectedCodes([1, "2", null]), ["1", "2"]);
  assert.deepEqual(selectedCodes({ 1: true, 2: false, 3: 1 }), ["1", "3"]);
});

test("stripping: no key, explanation or option meta reaches a respondent payload; marks/topics stay; the original is untouched", () => {
  const def = paper();
  def.questions[0].options![2].meta = { correct: true, explanation: "secret", image: "x" };
  (def as { localization?: unknown }).localization = { translations: { hi: { "q:q1:assessment.explanation": { text: "गुप्त" }, "q:q1:text": { text: "प्रश्न" } } } };
  const out = stripAssessmentSecrets(def);
  assert.deepEqual(assessmentSecretsPresent(out), []);
  const json = JSON.stringify(out);
  assert.doesNotMatch(json, /Because|14 is equality|secret|गुप्त/);
  assert.deepEqual(out.questions[0].assessment, { correct: [], withheld: true, topic: "Polity" });
  assert.deepEqual(out.questions[0].options![2].meta, { image: "x" });
  assert.ok(json.includes("प्रश्न"), "other translations stay");
  assert.ok(assessmentSecretsPresent(def).length > 0, "the stored definition keeps its key");
  assert.equal(SurveyDefinition.safeParse(out).success, true, "still a valid definition");
  // per-question feedback necessarily keeps the key; a non-assessment survey is returned as is
  const pq = paper({ showResults: "per_question" });
  assert.equal(stripAssessmentSecrets(pq), pq);
  const plainSurvey = SurveyDefinition.parse({ meta: { id: "x", title: "x" }, questions: [{ id: "a", code: "A", variableName: "A", type: "single_select", text: "?", options: [{ code: 1, label: "a", meta: { correct: true } }] }] });
  assert.equal(stripAssessmentSecrets(plainSurvey), plainSurvey, "the legacy quiz variant without an assessment keeps its behaviour");
  // a survey switched off still strips (the key is still a key)
  const off = paper({ enabled: false });
  assert.deepEqual(assessmentSecretsPresent(stripAssessmentSecrets(off)), []);
});

test("respondent report follows the settings: never → null; sections switched off are absent", () => {
  const r = scoreAssessment(paper(), { q1: 2 });
  assert.equal(respondentAssessmentReport(paper({ showResults: "never" }), r), null);
  const full = respondentAssessmentReport(paper(), r)!;
  assert.equal(full.questions!.length, 5); assert.ok(full.questions![0].explanation); assert.ok(full.weakAreas);
  const lean = respondentAssessmentReport(paper({ report: { explanations: false, weakAreas: false, recommendations: false } }), r)!;
  assert.equal(lean.questions![0].explanation, undefined); assert.equal(lean.questions![0].mistakeExplanation, undefined);
  assert.equal(lean.weakAreas, undefined); assert.equal(lean.recommendations, undefined); assert.ok(lean.topics);
  const some = respondentAssessmentReport(paper({ reportQuestionIds: ["q2"] }), r)!;
  assert.deepEqual(some.questions!.map((q) => q.id), ["q2"]);
});

test("export columns: SCORE, PCT, PASS, <TOPIC>_SCORE, <VAR>_CORRECT; stable header; prefix on collision", () => {
  const def = paper();
  const r = scoreAssessment(def, { q1: 3, q2: 1, q5: [2] });
  const c = assessmentColumns(def, r);
  assert.equal(c.SCORE, r.marks); assert.equal(c.PCT, r.percentage); assert.equal(c.PASS, 0);
  assert.equal(c.POLITY_SCORE, 1.34); assert.equal(c.Q1_CORRECT, 1); assert.equal(c.Q2_CORRECT, 0); assert.equal(c.Q4_CORRECT, null); assert.equal(c.Q2_MARKS, -0.66);
  assert.deepEqual(Object.keys(c), assessmentColumnNames(def).columns);
  assert.deepEqual(Object.keys(assessmentColumns(def, null)), assessmentColumnNames(def).columns);
  def.questions[0].variableName = "SCORE";
  assert.equal(assessmentColumnNames(def).prefix, "ASMT_");
});

test("item analysis: p-value, corrected point-biserial, distribution, flags", () => {
  const def = paper();
  const sets = [
    { q1: 3, q2: 2, q3: 4, q4: 1, q5: [2, 3] }, { q1: 3, q2: 2, q3: 4, q4: 1, q5: [2] }, { q1: 3, q2: 2, q3: 4, q4: 2 },
    { q1: 3, q2: 1, q3: 1 }, { q1: 3, q2: 1, q3: 2, q4: 3 }, { q1: 3 },
  ];
  const results = sets.map((a) => scoreAssessment(def, a));
  const an = assessmentAnalytics(def, results);
  assert.equal(an.n, 6);
  const q1 = an.items.find((i) => i.id === "q1")!;
  assert.equal(q1.pValue, 1); assert.equal(q1.pointBiserial, null, "no variance"); assert.equal(q1.flag, "too easy");
  const q2 = an.items.find((i) => i.id === "q2")!;
  assert.equal(q2.pValue, 0.5); assert.ok(q2.pointBiserial! > 0.5, `q2 discriminates (${q2.pointBiserial})`);
  assert.equal(an.distribution.reduce((t, b) => t + b.count, 0), 6);
  assert.ok(an.passRate !== null && an.mean !== null && an.sd !== null);
});

test("validation: count, keys referencing real options, marks, explanations, topics, report ids — each error names its question", () => {
  const def = paper({ expectedQuestions: 5 });
  assert.equal(validateAssessment(def, { requireExplanations: true, requireTopics: true }).ok, true);
  assert.deepEqual(validateAssessment(def, { expectedCount: 100 }).errors.map((e) => e.code), ["count_mismatch"]);
  def.questions[0].assessment!.correct = [9];
  def.questions[1].assessment!.correct = [1, 2];
  delete def.questions[2].assessment!.explanation;
  delete def.questions[3].assessment!.topic;
  def.questions[4].assessment!.marks = -1;
  def.assessment!.reportQuestionIds = ["nope"];
  const v = validateAssessment(def, { requireExplanations: true, requireTopics: true });
  assert.equal(v.ok, false);
  const by = (code: string) => v.errors.filter((e) => e.code === code).map((e) => e.questionCode ?? e.questionId);
  assert.deepEqual(by("key_unknown_option"), ["Q1"]);
  assert.deepEqual(by("single_multi_key"), ["Q2"]);
  assert.deepEqual(by("no_explanation"), ["Q3"]);
  assert.deepEqual(by("no_topic"), ["Q4"]);
  assert.deepEqual(by("marks_invalid"), ["Q5"]);
  assert.deepEqual(by("report_unknown_question"), ["nope"]);
  assert.deepEqual(v.missingExplanations, ["q3"]);
  // without the requirement, missing explanations are warnings
  assert.ok(validateAssessment(def).warnings.some((w) => w.code === "no_explanation"));
  // scoped to a batch: only those questions, no settings/count checks
  const scoped = validateAssessment(paper(), { scopeCodes: ["Q1", "Q2"], requireExplanations: true });
  assert.equal(scoped.ok, true); assert.equal(scoped.graded, 2);
  // no settings at all
  const noSettings = SurveyDefinition.parse({ meta: { id: "x", title: "x" }, questions: [] });
  assert.deepEqual(validateAssessment(noSettings).errors.map((e) => e.code), ["not_enabled"]);
});

test("Intelligent Mode actions: set_assessment, set_answer_key by code / label / letter, refused unknown options, clear", () => {
  for (const op of ["set_answer_key", "clear_answer_key", "set_assessment"]) assert.ok((SURVEY_ACTION_OPS as readonly string[]).includes(op), op);
  const def = SurveyDefinition.parse({
    meta: { id: "s", title: "t" },
    questions: [
      { id: "a", code: "Q1", variableName: "Q1", type: "single_select", text: "Which article?", options: opts4() },
      { id: "b", code: "Q2", variableName: "Q2", type: "multi_select", text: "Which ones?", options: opts4() },
      { id: "c", code: "Q3", variableName: "Q3", type: "open_text", text: "Why?" },
    ],
    flow: [{ type: "page", id: "p", questionIds: ["a", "b", "c"] }, { type: "end", id: "e", status: "complete" }],
  });
  const c = coerceSurveyActions([
    { op: "set_assessment", defaultMarks: 2, defaultNegativeMarks: -0.66, passPercent: 33, expectedQuestions: 2, title: "Mock 1" },
    { op: "set_answer_key", target: "Q1", correct: ["Article 21"], topic: "Polity", explanation: "Right to life", optionExplanations: { A: "Equality" } },
    { op: "set_answer_key", target: "Q2", correct: ["b", 3], topic: "Polity", explanation: "Both" },
  ]);
  assert.deepEqual(c.rejected, []);
  const r = applySurveyActions(def, c.actions);
  assert.deepEqual(r.errors, []);
  assert.equal(r.def.assessment!.defaultNegativeMarks, 0.66, "a negative number is read as the deduction");
  assert.equal(r.def.assessment!.passPercent, 33);
  assert.deepEqual(r.def.questions[0].assessment, { correct: [3], topic: "Polity", explanation: "Right to life", optionExplanations: { "1": "Equality" } });
  assert.deepEqual(r.def.questions[1].assessment!.correct, [2, 3]);
  assert.equal(validateAssessment(r.def, { requireExplanations: true, requireTopics: true }).ok, true);
  // follow-up: only the explanation — the key is kept
  const r2 = applySurveyActions(r.def, coerceSurveyActions([{ op: "set_answer_key", target: "Q1", explanation: "Article 21 — life and liberty" }]).actions);
  assert.deepEqual(r2.def.questions[0].assessment!.correct, [3]);
  assert.equal(r2.def.questions[0].assessment!.explanation, "Article 21 — life and liberty");
  // refused: an option that does not exist, two answers on a single-choice question, an open end
  for (const [a, re] of [
    [{ op: "set_answer_key", target: "Q1", correct: ["Article 99"] }, /no option “Article 99”/],
    [{ op: "set_answer_key", target: "Q1", correct: [1, 2] }, /single-choice/],
    [{ op: "set_answer_key", target: "Q3", correct: ["x"] }, /open_text/],
    [{ op: "set_answer_key", target: "Q9", correct: [1] }, /no question/],
  ] as const) {
    const rr = applySurveyActions(r.def, coerceSurveyActions([a]).actions);
    assert.equal(rr.results[0].ok, false); assert.match(rr.results[0].error!, re);
  }
  // created and keyed in one batch (the generation step's shape): the key applies after the question exists
  const r3 = applySurveyActions(def, coerceSurveyActions([
    { op: "set_answer_key", target: "Q4", correct: ["Gamma"], topic: "Geo", explanation: "x" },
    { op: "create_question", type: "single_select", code: "Q4", text: "Pick", options: [{ code: 1, label: "Alpha" }, { code: 2, label: "Beta" }, { code: 3, label: "Gamma" }] },
  ]).actions);
  assert.deepEqual(r3.errors, []);
  assert.deepEqual(r3.def.questions.find((q) => q.code === "Q4")!.assessment!.correct, [3]);
  assert.ok(r3.def.assessment, "keying a question switches the assessment on");
  // clear
  const r4 = applySurveyActions(r.def, coerceSurveyActions([{ op: "clear_answer_key", target: "Q2" }]).actions);
  assert.equal(r4.def.questions[1].assessment, undefined);
  assert.ok(r4.destructive.length > 0);
  // coerce refusals
  assert.match(String(coerceSurveyActions([{ op: "set_answer_key", target: "Q1" }]).rejected[0]?.reason), /nothing to set/);
});

test("resolveKeyOption: code, label, letter, letter-prefixed label", () => {
  const q = SurveyDefinition.parse({ meta: { id: "s", title: "t" }, questions: [{ id: "a", code: "Q1", variableName: "Q1", type: "single_select", text: "?", options: opts4() }] }).questions[0];
  assert.equal(resolveKeyOption(q, 2), "2");
  assert.equal(resolveKeyOption(q, "article 32"), "4");
  assert.equal(resolveKeyOption(q, "(c)"), "3");
  assert.equal(resolveKeyOption(q, "B) Article 19"), "2");
  assert.equal(resolveKeyOption(q, "E"), null);
});

test("backward compatible: a survey without assessment parses, scores to an empty result and validates as not enabled", () => {
  const def = SurveyDefinition.parse({ meta: { id: "x", title: "x" }, questions: [{ id: "a", code: "A", variableName: "A", type: "single_select", text: "?", options: [{ code: 1, label: "a" }] }] });
  assert.equal(def.assessment, undefined);
  assert.equal(def.questions[0].assessment, undefined);
  const r = scoreAssessment(def, { a: 1 });
  assert.equal(r.totalQuestions, 0); assert.equal(r.percentage, 0);
});


test("the one leak check (4A): a keyed paper is safe once stripped; per_question, smuggled keys and scripts are named", () => {
  assert.equal(stripAssessmentForRespondent, stripAssessmentSecrets);
  // the stored paper carries its key, and the respondent version of it does not
  assert.deepEqual(assessmentKeyLeaks(paper()), []);
  // per_question results are served with the key — named
  const pq = assessmentKeyLeaks(paper({ showResults: "per_question" }));
  assert.ok(pq.some((m) => /questions\[0\]\.assessment\.correct carries an answer key/.test(m)), pq.join(" | "));
  assert.ok(pq.some((m) => /Q1\.assessment carries an explanation/.test(m)), pq.join(" | "));
  // a key smuggled outside question.assessment is not stripped, so it is named
  const smuggled = { ...JSON.parse(JSON.stringify(paper())), meta_extensions: { answer_key: { q1: 3 } } };
  assert.deepEqual(assessmentKeyLeaks(smuggled).length, 1);
  // a raw object that never went through the schema, without any assessment
  const raw = { meta: { id: "x", title: "x" }, questions: [{ id: "a", code: "A", settings: { correct: "2" } }] } as never;
  assert.ok(assessmentKeyLeaks(raw).some((m) => /questions\[0\]\.settings\.correct/.test(m)));
  // a script that holds the key as text
  const scripted = SurveyDefinition.parse({ ...JSON.parse(JSON.stringify(paper())), scripts: [{ id: "s1", name: "m", scope: "survey", event: "on_load", code: "const answerKey = {q1:3};" }] });
  assert.ok(assessmentKeyLeaks(scripted).some((m) => /mentions an answer key in its source/.test(m)));
});

test("set_assessment_settings is read as set_assessment (one op, one gate)", () => {
  const c = coerceSurveyActions([{ op: "set_assessment_settings", passPercent: 40, showResults: "never" }]);
  assert.deepEqual(c.rejected, []);
  assert.equal(c.actions[0].op, "set_assessment");
  const def = SurveyDefinition.parse({ meta: { id: "s", title: "t" }, questions: [] });
  const r = applySurveyActions(def, c.actions);
  assert.deepEqual(r.errors, []);
  assert.equal(r.def.assessment!.passPercent, 40);
  assert.equal(r.def.assessment!.showResults, "never");
});
