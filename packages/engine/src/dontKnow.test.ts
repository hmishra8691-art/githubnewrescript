import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState } from "./state.js";
import { setAnswer } from "./flow.js";
import { setDontKnow, responseStatus, isDontKnow, dontKnowEnabled, dontKnowEligible, dontKnowKey } from "./dontKnow.js";
import { validateQuestion } from "./validate.js";
import { flattenVariables } from "./flatten.js";
import { buildVariableDictionary } from "./variables.js";
import { checkSubmission } from "./serverValidation.js";
import { applySurveyActions } from "./surveyActions.js";
import { interpretRequest } from "./nlIntent.js";
import { translatableElements, localizeDefinition } from "./localization.js";
import { migrateQuestionType } from "./questionShape.js";

/** "I don't know" beside an open-text or numeric answer (2026-11-02) — stored beside the answer, never in it */
const def = () => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "S", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "SPEND", type: "numeric", text: "How much did you spend?", required: true, settings: { dontKnow: true }, validation: [{ kind: "min_value", value: 0 }, { kind: "max_value", value: 1000 }, { kind: "integer" }] },
    { id: "q2", code: "Q2", variableName: "WHY", type: "open_text", text: "Why?", required: true, settings: { dontKnow: true, dontKnowLabel: "Not sure" } },
    { id: "q3", code: "Q3", variableName: "PLAIN", type: "numeric", text: "Plain number", required: true },
    { id: "q4", code: "Q4", variableName: "COL", type: "single_select", text: "Colour", options: [{ code: 1, label: "Red" }, { code: 2, label: "Blue" }], settings: { dontKnow: true } },
  ],
  flow: [{ type: "block", id: "b", children: [{ type: "page", id: "p", questionIds: ["q1", "q2", "q3", "q4"] }] }, { type: "end", id: "e", status: "complete" }],
});
const errs = (d: SurveyDefinition, st: ReturnType<typeof createResponseState>, id: string) => validateQuestion(d, d.questions.find((q) => q.id === id)!, st.answers[id], { def: d, state: st, loop: null }).map((e) => e.message);

test("eligibility: open text, long text and numbers only; on only when the researcher turns it on", () => {
  const d = def();
  assert.deepEqual(d.questions.map((q) => dontKnowEligible(q)), [true, true, true, false]);
  assert.deepEqual(d.questions.map((q) => dontKnowEnabled(q)), [true, true, false, false], "off by default; a single choice never, whatever its settings say");
  assert.equal(dontKnowKey("q1"), "q1__dk");
  assert.equal(dontKnowKey("q1", { loopId: "L", loopVar: "BRAND", code: "a", label: "A", index: 0 } as never), "q1@a__dk");
});

test("mutually exclusive, in the engine: choosing it removes the answer; typing an answer clears it", () => {
  const d = def();
  const st = createResponseState(d, { seed: 1 });
  setAnswer(d, st, "q1", 40);
  assert.equal(responseStatus(st, d.questions[0]), "answered");
  assert.ok(setDontKnow(st, d.questions[0], true));
  assert.equal(st.answers.q1, undefined, "the answer is gone");
  assert.equal((st.answers as Record<string, unknown>).q1__dk, true);
  assert.equal(responseStatus(st, d.questions[0]), "dont_know");
  setAnswer(d, st, "q1", 12);
  assert.equal((st.answers as Record<string, unknown>).q1__dk, undefined, "a typed value clears the choice");
  assert.equal(responseStatus(st, d.questions[0]), "answered");
  // an EMPTY write (the box cleared) leaves a choice alone
  setDontKnow(st, d.questions[1], true);
  setAnswer(d, st, "q2", "");
  assert.ok(isDontKnow(st, d.questions[1]));
  // refused where it is not offered
  assert.equal(setDontKnow(st, d.questions[2], true), false);
  assert.equal(setDontKnow(st, d.questions[3], true), false);
  assert.equal(responseStatus(st, d.questions[2]), "unanswered");
});

test("validation: required is met by the choice; min / max / integer apply to a typed value and not to the choice; both together are refused", () => {
  const d = def();
  const st = createResponseState(d, { seed: 1 });
  assert.deepEqual(errs(d, st, "q1"), ["This question is required."]);
  setDontKnow(st, d.questions[0], true);
  setDontKnow(st, d.questions[1], true);
  assert.deepEqual(errs(d, st, "q1"), []);
  assert.deepEqual(errs(d, st, "q2"), []);
  setAnswer(d, st, "q1", 1500);
  assert.deepEqual(errs(d, st, "q1"), ["Value must be at most 1000."]);
  setAnswer(d, st, "q1", 12.5);
  assert.deepEqual(errs(d, st, "q1"), ["Please enter a whole number."]);
  setAnswer(d, st, "q1", 12);
  assert.deepEqual(errs(d, st, "q1"), []);
  // a crafted submission holding both
  (st.answers as Record<string, unknown>).q2 = "because";
  (st.answers as Record<string, unknown>).q2__dk = true;
  assert.deepEqual(errs(d, st, "q2"), ["Give an answer or choose “I don't know” — not both."]);
  // a question without the setting ignores a stray key
  (st.answers as Record<string, unknown>).q3__dk = true;
  assert.deepEqual(errs(d, st, "q3"), ["This question is required."]);
});

test("data: the answer column never holds the choice; VAR_DK is 1 / 0 / blank, declared with its labels", () => {
  const d = def();
  const a = createResponseState(d, { seed: 1 }); setAnswer(d, a, "q1", 25); setAnswer(d, a, "q2", "price");
  const b = createResponseState(d, { seed: 2 }); setDontKnow(b, d.questions[0], true); setDontKnow(b, d.questions[1], true);
  const c = createResponseState(d, { seed: 3 });
  const fa = flattenVariables(d, a), fb = flattenVariables(d, b), fc = flattenVariables(d, c);
  assert.deepEqual([fa.SPEND, fa.SPEND_DK, fa.WHY, fa.WHY_DK], [25, 0, "price", 0]);
  assert.deepEqual([fb.SPEND, fb.SPEND_DK, fb.WHY, fb.WHY_DK], [undefined, 1, undefined, 1]);
  assert.deepEqual([fc.SPEND_DK, fc.WHY_DK], [undefined, undefined]);
  assert.equal("PLAIN_DK" in fa, false, "no column for a question that does not offer it");
  const dict = buildVariableDictionary(d).filter((v) => /_DK$/.test(v.name));
  assert.deepEqual(dict.map((v) => [v.name, v.dataType, v.valueLabels]), [["SPEND_DK", "numeric", { "0": "Answered", "1": "Don't know" }], ["WHY_DK", "numeric", { "0": "Answered", "1": "Don't know" }]]);
  assert.match(dict[1].notes ?? "", /Not sure/, "the variable's note quotes the label respondents saw");
});

test("the server accepts the choice as a companion key and replays it", () => {
  const d = def();
  const ok = checkSubmission({ def: d, prior: { sessionId: "x", seed: 1 }, posted: { answers: { q1__dk: true, q2: "fine", q3: 4, q4: 1 }, stepIndex: 1, status: "complete" } } as never);
  assert.equal(ok.ok, true, JSON.stringify(ok.hard));
  const missing = checkSubmission({ def: d, prior: { sessionId: "x", seed: 1 }, posted: { answers: { q2: "fine", q3: 4, q4: 1 }, stepIndex: 1, status: "complete" } } as never);
  assert.ok(missing.hard.some((h) => h.questionId === "q1"), "without the choice or a value, Q1 is unanswered");
});

test("configuration: actions set it on eligible questions only; the sentence works; the label is translatable; it survives a text ↔ number conversion", () => {
  const d = def();
  const out = applySurveyActions(d, [{ op: "update_question", target: "Q3", settings: { dontKnow: true, dontKnowLabel: "No idea" } }] as never);
  assert.ok(out.valid && out.results[0].ok, JSON.stringify(out.results));
  assert.equal(out.def.questions[2].settings.dontKnow, true);
  const refused = applySurveyActions(d, [{ op: "update_question", target: "Q4", settings: { dontKnow: true } }] as never);
  assert.ok(!refused.results[0].ok && /has no setting dontKnow/.test(refused.results[0].error ?? ""));
  const said = interpretRequest(d, "allow don't know on Q3");
  assert.equal(said.kind, "actions");
  assert.deepEqual((said as { actions: unknown[] }).actions, [{ op: "update_question", target: "Q3", settings: { dontKnow: true } }]);
  // a choice question gets the ordinary exclusive answer instead
  const choice = interpretRequest(d, "add don't know to Q4");
  assert.deepEqual((choice as { actions: unknown[] }).actions, [{ op: "update_question", target: "Q4", addOptions: [{ label: "Don't know", exclusive: true }] }]);
  const keys = translatableElements(d).map((e) => e.key);
  assert.ok(keys.includes("q:q2:dk"), "a custom label is a translatable string");
  assert.ok(keys.includes("ui:dont_know"), "the default label is an interface string");
  const de = localizeDefinition(SurveyDefinition.parse({ ...d, localization: { sourceLanguage: "en", languages: [{ code: "de" }], translations: { de: { "q:q2:dk": { text: "Weiß nicht", status: "approved" } } } } }), "de");
  assert.equal(de.questions[1].settings.dontKnowLabel, "Weiß nicht");
  const moved = migrateQuestionType(d.questions[0], { baseType: "open_text" });
  assert.equal(moved.q.settings.dontKnow, true, "kept from a number to text");
  const gone = migrateQuestionType(d.questions[0], { baseType: "single_select" });
  assert.equal(gone.q.settings.dontKnow, undefined, "dropped on a choice question, which cannot carry it");
});
