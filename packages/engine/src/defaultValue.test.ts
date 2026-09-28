import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, diffSurveys } from "./surveyActions.js";
import { createResponseState } from "./state.js";
import { start, advance, goBack, setAnswer } from "./flow.js";
import { validateUxScript } from "./ux.js";

/**
 * A QUESTION'S DEFAULT VALUE is its starting answer: Properties → Default
 * value and the copilot's set_default_value write the same setting, and the
 * runtime fills it in once, never over the respondent's own answer. A script
 * cannot fill in answers — and says what to use instead.
 */
const survey = () => SurveyDefinition.parse({
  meta: { id: "d", code: "D", title: "Defaults" },
  questions: [
    { id: "q1", code: "Q1", variableName: "INTRO", type: "open_text", text: "Name?" },
    { id: "q2", code: "Q2", variableName: "AGE", type: "numeric", text: "Age?", validation: [{ kind: "min_value", value: 16 }, { kind: "max_value", value: 99 }] },
    { id: "q3", code: "Q3", variableName: "AGREE", type: "single_select", text: "Agree?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    { id: "q4", code: "Q4", variableName: "BRANDS", type: "multi_select", text: "Brands?", options: [{ code: 1, label: "Coke" }, { code: 2, label: "Pepsi" }, { code: 3, label: "Fanta" }] },
    { id: "q5", code: "Q5", variableName: "END", type: "open_text", text: "Anything else?" },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q1"] },
    { type: "page", id: "p2", questionIds: ["q2", "q3", "q4"] },
    { type: "page", id: "p3", questionIds: ["q5"] },
    { type: "end", id: "e", status: "complete" },
  ],
  deployment: { clientSlug: "c", studySlug: "s" },
});
const q = (d: SurveyDefinition, id: string) => d.questions.find((x) => x.id === id)!;

test("the runtime fills a default in when the question is first shown — once, and never over an answer", () => {
  const d = survey();
  q(d, "q2").settings.defaultValue = "19";           // as the Properties field stores it: text
  q(d, "q3").settings.defaultValue = "Yes";          // a label → its code
  q(d, "q4").settings.defaultValue = "Coke, option 3"; // a multi-select: a list, resolved to codes
  q(d, "q5").settings.defaultValue = "none";
  const st = createResponseState(d);
  start(d, st);
  assert.equal(st.answers.q2, undefined, "not before its page is shown");
  setAnswer(d, st, "q1", "Ann");
  advance(d, st);
  assert.equal(st.answers.q2, 19, "a number for a numeric question");
  assert.equal(st.answers.q3, 1, "the option code");
  assert.deepEqual(st.answers.q4, [1, 3]);
  // the respondent clears one and changes another, goes back and forward: their answers stand
  setAnswer(d, st, "q2", null);
  setAnswer(d, st, "q3", 2);
  goBack(d, st);
  advance(d, st);
  assert.equal(st.answers.q2, null, "a cleared default is not filled in again");
  assert.equal(st.answers.q3, 2, "the respondent's own answer is never overwritten");
  // an answer that was already there when the page opened is kept
  const d2 = survey();
  q(d2, "q2").settings.defaultValue = 19;
  const st2 = createResponseState(d2);
  start(d2, st2);
  st2.answers.q2 = 42;
  advance(d2, st2);
  assert.equal(st2.answers.q2, 42);
  // …and a question that opened already answered never takes its default later, even once the answer is cleared
  setAnswer(d2, st2, "q2", null);
  goBack(d2, st2); advance(d2, st2);
  assert.equal(st2.answers.q2, null);
  // a default that does not fit the question is ignored, not stored
  const d3 = survey();
  q(d3, "q2").settings.defaultValue = "nineteen";
  q(d3, "q3").settings.defaultValue = "Maybe";
  const st3 = createResponseState(d3);
  start(d3, st3); advance(d3, st3);
  assert.equal(st3.answers.q2, undefined); assert.equal(st3.answers.q3, undefined);
});

test("set_default_value: the Properties setting, look-only, shown in the diff, checked against the question", () => {
  const d = survey();
  const c = coerceSurveyActions([
    { op: "set_default_value", target: "Q2", value: 19 },
    { op: "prefill", question: "Q3", value: "Yes" },
    { op: "set_default_value", target: "Q4", value: ["Pepsi"] },
  ]);
  assert.deepEqual(c.rejected, []);
  const r = applySurveyActions(d, c.actions, { uxOnly: true });
  assert.deepEqual(r.errors, []);
  assert.equal(r.uxOnly, true); assert.equal(r.structureUnchanged, true, "a starting answer does not change the questions, codes or logic");
  assert.equal(q(r.def, "q2").settings.defaultValue, 19);
  assert.equal(q(r.def, "q3").settings.defaultValue, 1, "stored as the code");
  assert.deepEqual(q(r.def, "q4").settings.defaultValue, [2]);
  assert.match(r.results[0].description, /Set Q2's default value to 19 — filled in when the question is first shown, only if it has no answer yet/);
  const diff = diffSurveys(d, r.def);
  assert.equal(diff.empty, false, "a proposal that only sets defaults has something to apply");
  assert.ok(diff.summary.includes("Change Q2: default value"), diff.summary.join("\n"));
  // refused with the reason
  const bad = applySurveyActions(d, coerceSurveyActions([{ op: "set_default_value", target: "Q3", value: "Maybe" }, { op: "set_default_value", target: "Q2", value: "old" }]).actions, { uxOnly: true });
  assert.match(bad.errors[0], /Q3 has no option “Maybe” to start with — its options are 1 = Yes, 2 = No/);
  assert.match(bad.errors[1], /Q2 is numeric: its default must be a number, not “old”/);
  // outside the validation range: allowed, with a warning
  const out = applySurveyActions(d, coerceSurveyActions([{ op: "set_default_value", target: "Q2", value: 12 }]).actions, { uxOnly: true });
  assert.match(out.warnings.join(" "), /outside its validation range/);
  // removing it is destructive
  const rm = applySurveyActions(r.def, coerceSurveyActions([{ op: "set_default_value", target: "Q2", value: null }]).actions, { uxOnly: true });
  assert.equal(q(rm.def, "q2").settings.defaultValue, undefined);
  assert.ok(rm.destructive.some((x) => /Removes Q2's default value/.test(x)), rm.destructive.join("\n"));
});

test("a proposal that only sets custom HTML is a change (Apply has something to do)", () => {
  const d = survey();
  const r = applySurveyActions(d, coerceSurveyActions([{ op: "set_custom_html", target: "Q2", html: "<img src=\"https://cdn.example.com/a.png\" alt=\"\">" }]).actions, { uxOnly: true });
  assert.deepEqual(r.errors, []);
  const diff = diffSurveys(d, r.def);
  assert.equal(diff.empty, false);
  assert.ok(diff.summary.includes("Change Q2: custom HTML"), diff.summary.join("\n"));
});

test("a script cannot fill in answers — the refusal says what to use; page_enter is the page event", () => {
  const d = survey();
  const fill = validateUxScript(`rs.listen("page_enter", "self", () => { if (rs.getAnswer("Q2") == null) rs.setAnswer("Q2", 19); });`, d);
  assert.ok(fill.errors.some((e) => /scripts cannot fill in or change answers — to start a question with an answer, set its default value/.test(e)), fill.errors.join("\n"));
  assert.ok(!fill.errors.some((e) => /rs\.listen\("page_enter"\)/.test(e)), "page_enter is accepted as the page event");
  const dom = validateUxScript(`rs.listen("page", "self", (e) => { e.value = 19; });`, d);
  assert.ok(dom.errors.some((e) => /cannot fill in or change answers/.test(e)));
  const dispatch = validateUxScript(`rs.listen("page", "self", (e) => { e.target.dispatchEvent(1); });`, d);
  assert.ok(dispatch.errors.some((e) => /cannot fill in or change answers/.test(e)));
  const fine = validateUxScript(`rs.listen("page_enter", "self", () => { if (rs.getAnswer("Q2") === 19) rs.addClass("self", "defaulted"); });`, d);
  assert.deepEqual(fine.errors, []);
  const wrong = validateUxScript(`rs.listen("page_show", "self", () => rs.addClass("self", "x"));`, d);
  assert.match(wrong.errors.join(" "), /the events are .* \(“page” fires when the page opens\)/);
  // the refusal as the copilot's proposal reports it: the label once
  const r = applySurveyActions(d, coerceSurveyActions([{ op: "create_behavior", label: "Default 19", target: "Q2", script: `rs.listen("page", "self", () => rs.setAnswer("Q2", 19));` }]).actions, { uxOnly: true });
  assert.match(r.errors[0], /^Behaviour “Default 19”: scripts cannot fill in/);
});
