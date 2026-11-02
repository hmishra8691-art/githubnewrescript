import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { looksLikeOtherSpecify, selectedOtherCodes, otherTextFor } from "./otherSpecify.js";
import { applySurveyActions, type SurveyAction } from "./surveyActions.js";
import { reviewSurvey } from "./surveyReview.js";
import { createResponseState } from "./state.js";
import { setAnswer } from "./flow.js";
import { validateQuestion } from "./validate.js";
import { setOtherTextFor } from "./otherSpecify.js";

/**
 * 2026-11-02 — "Other — specify" by its words. The root cause of "the specify box does not appear": the box is
 * drawn for an option FLAGGED other_specify, and an option merely labelled "Please specify" or "Something else" was
 * never flagged, so it was a plain choice with nowhere to type.
 */
test("the labels that ask the respondent to say what it is — and the ones that do not", () => {
  for (const l of ["Other (please specify)", "Other – Specify", "Other - specify", "Other, specify", "Please specify", "Something else", "Something else (please specify)", "Other:", "Other (write in)", "<b>Other</b> (please specify)", "Anything else"]) assert.equal(looksLikeOtherSpecify(l), true, l);
  for (const l of ["Other", "Others", "Other brands", "Another brand", "None of these", "Don't know", "Specific brands", "", null]) assert.equal(looksLikeOtherSpecify(l as string), false, String(l));
});

const survey = () => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "S" },
  questions: [
    { id: "q1", code: "Q1", variableName: "BRAND", type: "single_select", text: "Brand", options: [{ code: 1, label: "Acme" }, { code: 2, label: "Something else" }], required: true },
    { id: "q2", code: "Q2", variableName: "USE", type: "multi_select", text: "Uses", options: [{ code: 1, label: "Work" }, { code: 2, label: "Home" }] },
  ],
  flow: [{ type: "block", id: "b", children: [{ type: "page", id: "p", questionIds: ["q1", "q2"] }] }, { type: "end", id: "e", status: "complete" }],
});

test("actions: an option created, added or relabelled with such words gets its box; an explicit other:false wins", () => {
  const out = applySurveyActions(survey(), [
    { op: "create_question", ref: "Q3", type: "single", text: "Where?", options: ["Home", "Please specify"] },
    { op: "update_question", target: "Q2", addOptions: ["Other – Specify"] },
    { op: "update_option", target: "Q1", option: 1, label: "Other (please specify)" },
    { op: "create_question", ref: "Q4", type: "multi", text: "Also", options: ["X", { label: "Something else", other: false }] },
  ] as SurveyAction[]);
  assert.ok(out.valid && out.results.every((r) => r.ok), JSON.stringify(out.results.filter((r) => !r.ok)));
  const d = out.def;
  const flagged = (code: string) => d.questions.find((q) => q.code === code)!.options.filter((o) => o.flags?.includes("other_specify")).map((o) => o.label);
  assert.deepEqual(flagged("Q3"), ["Please specify"]);
  assert.deepEqual(flagged("Q2"), ["Other – Specify"]);
  assert.deepEqual(flagged("Q1"), ["Other (please specify)"], "relabelled into one: the box comes with the words");
  assert.deepEqual(flagged("Q4"), [], "the action said no box");
  assert.match(out.results[2].description, /with a specify box/);
});

test("a saved survey is never re-flagged on its own — the review says so, and its fix gives the box", () => {
  const d = survey();
  const finding = reviewSurvey(d).findings.find((f) => /asks the respondent to specify, but has no text box/.test(f.message));
  assert.ok(finding, "the review names it");
  assert.equal(d.questions[0].options[1].flags?.includes("other_specify") ?? false, false, "nothing changed by reviewing");
  const fixed = applySurveyActions(d, finding!.fix as SurveyAction[]).def;
  assert.deepEqual(fixed.questions[0].options[1].flags, ["other_specify"]);
  assert.equal(reviewSurvey(fixed).findings.some((f) => /asks the respondent to specify/.test(f.message)), false);
});

test("single and multi: the box is required while its option is selected, its text is stored against that option, and deselecting drops it", () => {
  const d = applySurveyActions(survey(), [{ op: "update_option", target: "Q1", option: 2, other: true }, { op: "update_question", target: "Q2", addOptions: ["Other (please specify)"] }] as SurveyAction[]).def;
  const q1 = d.questions[0], q2 = d.questions[1];
  const st = createResponseState(d, { seed: 1 });
  const errs = (q: typeof q1) => validateQuestion(d, q, st.answers[q.id], { def: d, state: st, loop: null }).map((e) => e.message);
  setAnswer(d, st, "q1", 2);
  assert.deepEqual(selectedOtherCodes(q1, st.answers.q1), ["2"]);
  assert.match(errs(q1).join(" "), /Please say what “Other” is/);
  setOtherTextFor(st, q1, 2, "Globex", null);
  assert.deepEqual(errs(q1), []);
  assert.equal((st.answers as Record<string, unknown>)["q1__other__2"], "Globex", "stored against the question and the option");
  setAnswer(d, st, "q1", 1);
  assert.equal(otherTextFor(st, q1, 2, null), "", "deselected: the text goes with it");
  assert.equal("q1__other__2" in st.answers, false, "and its key is removed from the response");
  // multi: tick, type, untick, tick again
  const other = q2.options.find((o) => o.flags?.includes("other_specify"))!;
  setAnswer(d, st, "q2", [1, other.code]);
  assert.match(errs(q2).join(" "), /Please say what “Other” is/);
  setOtherTextFor(st, q2, other.code, "Garden", null);
  assert.deepEqual(errs(q2), []);
  setAnswer(d, st, "q2", [1]);
  assert.equal(otherTextFor(st, q2, other.code, null), "");
  setAnswer(d, st, "q2", [1, other.code]);
  assert.match(errs(q2).join(" "), /Please say what “Other” is/, "ticked again: the box is back, and empty");
});
