import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Condition, type Question } from "@rescript/schema";
import { DEFER_TO_GRAMMAR, INTENT_CATEGORIES, interpretRequest, splitCommands, type Interpretation, type InterpretContext } from "./nlIntent.js";
import { applySurveyActions, type SurveyAction } from "./surveyActions.js";
import { formatCondition } from "./logicExpression.js";
import { formatSetExpression } from "./setExpression.js";
import { listPages } from "./blocks.js";

/*
 * THE SENTENCE INTERPRETER (Intelligent Mode Phase 3), against a realistic
 * fifteen-question brand tracker: one test per recogniser family, the
 * brief's thirteen researcher sentences, and the refusals — an object that is
 * not there, a description that fits two questions, a skip backwards, an
 * operator that does not fit the question. Every edit is applied here a
 * second time and the resulting survey checked, so "actions" always means
 * "actions that apply".
 */

const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const rule = (ref: string, operator: string, value: unknown): Condition => ({ type: "rule", source: { kind: "question", ref }, operator, value } as Condition);
function survey(): SurveyDefinition {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "BT", title: "Brand tracker" },
    questions: [
      { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
      { id: "q2", code: "Q2", variableName: "REGION", type: "single_select", text: "Which region do you live in?", options: opts("North", "South", "East", "West") },
      { id: "q3", code: "Q3", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female", "Non-binary") },
      { id: "q4", code: "Q4", variableName: "CHANNEL", type: "single_select", text: "Where do you usually shop?", options: opts("Online", "In store", "Both") },
      { id: "q5", code: "Q5", variableName: "BRANDS", type: "multi_select", text: "Which of these brands have you bought in the past month?", options: [...opts("Brand A", "Brand B", "Brand C", "Brand D"), { code: 99, label: "None of these", flags: ["anchor_bottom"] }] },
      { id: "q6", code: "Q6", variableName: "REASON", type: "open_text", text: "Why did you choose {{Q5}}?" },
      { id: "q7", code: "Q7", variableName: "OWN_CAR", type: "single_select", text: "Do you own a car?", options: opts("Yes", "No") },
      { id: "q8", code: "Q8", variableName: "CAR_BRAND", type: "single_select", text: "Which brand is your car?", options: opts("Toyota", "Ford", "Honda"), displayLogic: rule("q7", "eq", 1) },
      { id: "q9", code: "Q9", variableName: "CAR_AGE", type: "numeric", text: "What is the age of your car, in years?", displayLogic: rule("q7", "eq", 1) },
      { id: "q10", code: "Q10", variableName: "FAV", type: "single_select", text: "Which of these brands is your favourite?", options: opts("Brand A", "Brand B", "Brand C", "Brand D") },
      { id: "q11", code: "Q11", variableName: "COUNTRY", type: "single_select", text: "In which country were you born?", options: [...opts("Canada", "US", "Mexico"), { code: 4, label: "Other (please specify)", flags: ["other_specify", "anchor_bottom"] }] },
      { id: "q12", code: "Q12", variableName: "SAT", type: "matrix_single", text: "How satisfied are you with each of these?", rows: [{ code: "r1", label: "Price" }, { code: "r2", label: "Quality" }, { code: "r3", label: "Service" }], options: opts("Very dissatisfied", "Dissatisfied", "Neutral", "Satisfied", "Very satisfied") },
      { id: "q13", code: "Q13", variableName: "INTENT", type: "single_select", text: "How likely are you to buy Brand A in the next 3 months?", options: opts("Very unlikely", "Unlikely", "Neutral", "Likely", "Very likely"), analysis: { construct: "Purchase intent", role: "dependent" } },
      { id: "q14", code: "Q14", variableName: "COLOURS", type: "multi_select", text: "Which colours do you like?", options: opts("Black", "White") },
      { id: "q15", code: "Q15", variableName: "COMMENTS", type: "open_text", text: "Any other comments?", validation: [{ id: "v1", kind: "max_length", value: 500 }] },
    ],
    flow: [
      { type: "block", id: "b_scr", title: "Screener", children: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "page", id: "p2", questionIds: ["q2"] }, { type: "page", id: "p3", questionIds: ["q3"] }] },
      { type: "block", id: "b_use", title: "Usage", children: [
        { type: "page", id: "p4", questionIds: ["q4"] }, { type: "page", id: "p5", questionIds: ["q5"] }, { type: "page", id: "p6", questionIds: ["q6"] },
        { type: "page", id: "p7", questionIds: ["q7"] }, { type: "page", id: "p8", questionIds: ["q8"] }, { type: "page", id: "p9", questionIds: ["q9"] }] },
      { type: "block", id: "b_brand", title: "Brands", children: [{ type: "page", id: "p10", questionIds: ["q10"] }, { type: "page", id: "p11", questionIds: ["q11"] }, { type: "page", id: "p12", questionIds: ["q12"] }, { type: "page", id: "p13", questionIds: ["q13"] }] },
      { type: "block", id: "b_end", title: "Wrap up", children: [{ type: "page", id: "p14", questionIds: ["q14", "q15"] }] },
      { type: "end", id: "e", status: "complete" },
    ],
    calculations: [{ id: "c1", targetVariable: "AGE_GAP", expression: "AGE - CAR_AGE" }],
    quotas: [{ id: "qt1", name: "Gender", cells: [{ id: "c1", label: "Male", when: rule("q3", "eq", 1), limit: 100 }, { id: "c2", label: "Female", when: rule("q3", "eq", 2), limit: 100 }] }],
    research: {
      hypotheses: ["Women have a higher purchase intent for Brand A than men"],
      constructs: [{ name: "Purchase intent", role: "dependent", definition: "How likely the respondent is to buy Brand A", questionIds: ["q13"] }, { name: "Brand usage", role: "independent", questionIds: ["q5"] }],
    },
    localization: { sourceLanguage: "en", languages: [{ code: "de", status: "draft" }], translations: { de: { "q:q7:text": { text: "Besitzen Sie ein Auto?", status: "ai" } } } },
    deployment: { clientSlug: "c", studySlug: "s" },
  });
}
/** the brief's own fixture for “Q7 is Male”: Q7 asks gender (codes unchanged, so Q8 and Q9 still read it) */
function genderAtQ7(): SurveyDefinition {
  const def = survey();
  const q7 = def.questions.find((q) => q.code === "Q7")!;
  q7.text = "What is your gender?";
  q7.options = opts("Male", "Female") as Question["options"];
  return def;
}

const say = (def: SurveyDefinition, text: string, ctx?: InterpretContext): Interpretation => interpretRequest(def, text, ctx);
const q = (def: SurveyDefinition, code: string) => def.questions.find((x) => x.code === code)!;
/** the interpretation is actions, they apply cleanly a second time, and here is the survey after them */
function applied(def: SurveyDefinition, i: Interpretation): SurveyDefinition {
  assert.equal(i.kind, "actions", JSON.stringify(i));
  const out = applySurveyActions(def, (i as Extract<Interpretation, { kind: "actions" }>).actions);
  assert.deepEqual(out.errors, []);
  return out.def;
}
function as<K extends Interpretation["kind"]>(i: Interpretation, kind: K): Extract<Interpretation, { kind: K }> {
  assert.equal(i.kind, kind, JSON.stringify(i));
  return i as Extract<Interpretation, { kind: K }>;
}
const detectedOf = (i: Interpretation, what: string) => i.detected.filter((d) => d.what === what).map((d) => d.value);
const items = (i: Interpretation, title: string) => (as(i, "answer").sections.find((s) => s.title === title)?.items ?? []);

/* ============================================================ the brief's thirteen sentences */

test("brief 1 — “Make Q7 required.”", () => {
  const def = survey();
  const i = as(say(def, "Make Q7 required."), "actions");
  assert.equal(i.category, "question_modification");
  assert.deepEqual(i.actions, [{ op: "update_question", target: "Q7", required: true }]);
  assert.deepEqual(i.targets, ["q7"]);
  assert.equal(q(applied(def, i), "Q7").required, true);
});

test("brief 2 — “If Q7 is no, skip the next five questions.”: a skip from Q7 over Q8–Q12 to Q13", () => {
  const def = survey();
  const i = as(say(def, "If Q7 is no, skip the next five questions."), "actions");
  assert.equal(i.category, "logic");
  assert.deepEqual(i.actions, [{ op: "add_skip", from: "Q7", when: "Q7 = no", to: "Q13" }]);
  assert.equal(i.understood, "Skip Q8–Q12 for respondents who answer No at Q7: after Q7, when Q7 = 2 (No), go to Q13.");
  assert.deepEqual(detectedOf(i, "condition"), ["Q7 = 2 (No)"]);
  assert.deepEqual(detectedOf(i, "skip range"), ["Q8–Q12 → Q13"]);
  const after = applied(def, i);
  const skip = q(after, "Q7").skipLogic[0];
  assert.deepEqual(skip.target, { kind: "question", ref: "q13" }, "the skip lands on the question after Q12");
  assert.equal(formatCondition(after, skip.when), "Q7 = 2", "“no” is read through the parser as option code 2");
});

test("brief 3 — “Randomize these options but keep None of these last.” (Q5 selected)", () => {
  const def = survey();
  const i = as(say(def, "Randomize these options but keep None of these last.", { selectedId: "q5" }), "actions");
  assert.equal(i.category, "randomization");
  assert.deepEqual(i.actions, [{ op: "set_option_randomization", target: "Q5", enabled: true, keepLast: [99] }]);
  const after = q(applied(def, i), "Q5");
  assert.equal(after.randomization?.enabled, true);
  assert.ok(after.options.at(-1)!.flags.includes("anchor_bottom") && after.options.at(-1)!.code === 99);
  // without a selection, “these options” means nothing — said, not guessed
  assert.match(as(say(def, "Randomize these options but keep None of these last."), "refused").reason, /nothing is selected/);
});

test("brief 4 — “Mask all brands selected in Q5 from Q10.”", () => {
  const def = survey();
  const i = as(say(def, "Mask all brands selected in Q5 from Q10."), "actions");
  assert.equal(i.category, "masking");
  assert.deepEqual(i.actions, [{ op: "set_mask", target: "Q10", expression: "Q5.Selected" }]);
  const mask = q(applied(def, i), "Q10").mask!;
  assert.equal(mask.action, "display");
  assert.equal(formatSetExpression(def, mask.expr), "Q5.Selected");
});

test("brief 5 — “Show Q12 only if Q7 is Male and Q9 is over 25.”", () => {
  const def = genderAtQ7();
  const i = as(say(def, "Show Q12 only if Q7 is Male and Q9 is over 25."), "actions");
  assert.equal(i.category, "logic");
  assert.deepEqual(i.actions, [{ op: "set_display_logic", target: "Q12", expression: "Q7 = Male AND Q9 > 25" }]);
  assert.deepEqual(detectedOf(i, "condition"), ["Q7 = 1 (Male) AND Q9 > 25"]);
  const after = applied(def, i);
  assert.equal(formatCondition(after, q(after, "Q12").displayLogic), "Q7 = 1 AND Q9 > 25");
});

test("brief 6 — “What questions depend on Q7?”: grouped by kind, direct first, then indirect", () => {
  const def = survey();
  const i = as(say(def, "What questions depend on Q7?"), "answer");
  assert.equal(i.category, "dependency_analysis");
  assert.equal(i.answer, "3 objects depend on Q7: 2 display conditions, 1 translation; 1 more is affected indirectly.");
  assert.deepEqual(i.sections.map((s) => s.title), ["Display logic", "Translations", "Indirectly affected"]);
  assert.deepEqual(items(i, "Display logic").map((x) => [x.label, x.key, x.detail]), [["Q8 — display logic", "question:q8", "Q7 = 1 (Yes)"], ["Q9 — display logic", "question:q9", "Q7 = 1 (Yes)"]]);
  assert.deepEqual(items(i, "Indirectly affected").map((x) => [x.label, x.key]), [["calculation AGE_GAP", "calculation:c1"]], "AGE_GAP reads Q9, which reads Q7");
});

test("brief 7 — “What will break if I delete Q15?”", () => {
  const def = survey();
  const i = as(say(def, "What will break if I delete Q15?"), "answer");
  assert.equal(i.category, "impact_analysis");
  assert.equal(i.answer, "Impact: nothing else depends on it");
  assert.deepEqual(i.sections, []);
});

test("brief 8 — “Translate this survey into French.”: the model writes it; French has to be added first", () => {
  const def = survey();
  const i = as(say(def, "Translate this survey into French."), "model");
  assert.equal(i.category, "translation");
  assert.deepEqual(detectedOf(i, "language"), ["French (fr)"]);
  assert.match(detectedOf(i, "prerequisite")[0], /^add_language fr/);
  const de = as(say(def, "Translate this survey into German"), "model");
  assert.deepEqual(detectedOf(de, "prerequisite"), [], "German is already a language: nothing to add first");
});

test("brief 9 — “Create an analysis framework for this research.”", () => {
  const def = survey();
  const i = as(say(def, "Create an analysis framework for this research."), "actions");
  assert.equal(i.category, "analysis");
  assert.deepEqual(i.actions, [{ op: "propose_analysis_plan" }]);
  const plan = applied(def, i).research!.analysisPlan!;
  assert.ok(plan.crosstabs.length > 0 && plan.tests.length > 0);
  assert.match(i.understood, /^Propose the analysis framework the design implies: \d+ crosstabs?, \d+ tests?/);
  // with a plan already saved, the proposal merges into it
  const saved = applied(def, i);
  assert.deepEqual(as(say(saved, "plan the analysis"), "actions").actions, [{ op: "propose_analysis_plan", merge: true }]);
});

test("brief 10 — “What are the key hypotheses we can test?”: recorded hypotheses with coverage; none recorded is said, not invented", () => {
  const def = survey();
  const i = as(say(def, "What are the key hypotheses we can test?"), "answer");
  assert.equal(i.category, "research_design");
  assert.equal(items(i, "Hypotheses")[0].label, "H1: Women have a higher purchase intent for Brand A than men");
  assert.match(items(i, "Hypotheses")[0].detail!, /measured, but no test is planned yet · constructs Purchase intent \(Q13\)/);
  const bare = survey();
  bare.research!.hypotheses = [];
  const none = as(say(bare, "What are the key hypotheses we can test?"), "answer");
  assert.match(none.answer, /^No hypotheses are recorded for this study yet\./);
  assert.match(none.answer, /The copilot can propose some/);
  assert.deepEqual(items(none, "Constructs the survey measures").map((x) => x.label), ["Purchase intent", "Brand usage"]);
});

test("brief 11 — “Which variables should be cross-tabbed?”", () => {
  const def = survey();
  const i = as(say(def, "Which variables should be cross-tabbed?"), "answer");
  assert.equal(i.category, "analysis");
  assert.ok(items(i, "Crosstabs, most important first").some((x) => x.label.startsWith("INTENT by")), "the outcome first");
  assert.deepEqual(items(i, "Banner (what to cut by)").map((x) => x.key), ["question:q2", "question:q3", "question:q11"]);
  assert.match(i.answer, /the banner is Q2, Q3, Q11/);
});

test("brief 12 — “Find the most important differences between Gen Z and older respondents.” → the model, findings", () => {
  const i = as(say(survey(), "Find the most important differences between Gen Z and older respondents."), "model");
  assert.equal(i.category, "findings");
});

test("brief 13 — “Create a report structure based on the research objectives.” → the model, reporting", () => {
  const i = as(say(survey(), "Create a report structure based on the research objectives."), "model");
  assert.equal(i.category, "reporting");
});

/* ============================================================ refusals */

test("refused: an object that is not there, with the did-you-mean as a ready suggestion", () => {
  const def = survey();
  const i = as(say(def, "make Q99 required"), "refused");
  assert.equal(i.reason, "There is no Q99 in this survey — did you mean Q9?");
  assert.deepEqual(i.suggestion, { text: "make Q9 required", actions: [{ op: "update_question", target: "Q9", required: true }] });
  const far = as(say(def, "make QX77 required"), "refused");
  assert.equal(far.suggestion, undefined, "nothing close: no suggestion");
});

test("clarify: a description two questions fit, one choice per candidate, each the sentence re-written", () => {
  const def = survey();
  const i = as(say(def, "make the age question required"), "clarify");
  assert.match(i.question, /2 questions match “the age question”: Q1 .*, Q9 /);
  assert.deepEqual(i.choices.map((c) => c.text), ["make Q1 required", "make Q9 required"]);
  assert.deepEqual(as(say(def, "make the age question a slider"), "clarify").choices.map((c) => c.text), ["make Q1 a slider", "make Q9 a slider"]);
});

test("refused: a skip backwards, with the reason", () => {
  const def = survey();
  const i = as(say(def, "if Q5 = 1, skip back to Q2"), "refused");
  assert.equal(i.category, "logic");
  assert.match(i.reason, /^Skips only move forward\. You asked to go to Q2 when Q5\.O1 \(Brand A\); the rule would live on Q5 \(the question the condition reads\), and Q2 is asked before it\./);
  assert.match(as(say(def, "after Q9, skip to Q4 when Q9 > 10"), "refused").reason, /Q4 is asked before it/);
});

test("refused: an operator that does not fit the question, with the engine's corrected action", () => {
  const def = survey();
  const i = as(say(def, "show Q12 if Q7 > 1"), "refused");
  assert.match(i.reason, /^Show Q12 only when Q7 > 1 — not applied: Q7 is a single-select question .* Suggested: Q7 = 1\.$/);
  assert.equal(i.suggestion?.text, "show Q12 only if Q7 = 1");
  const fixed = applySurveyActions(def, i.suggestion!.actions!);
  assert.deepEqual(fixed.errors, []);
  assert.equal(formatCondition(fixed.def, q(fixed.def, "Q12").displayLogic), "Q7 = 1");
});

test("refused: the skip's question is not before the range, or a question sits between them, or the range is not continuous", () => {
  const def = survey();
  assert.match(as(say(def, "if Q9 = 1, skip Q8 through Q12"), "refused").reason, /reads Q9, which is asked inside the questions to skip \(Q8–Q12\)/);
  const gap = as(say(def, "if Q7 is no, skip Q9 through Q12"), "refused");
  assert.match(gap.reason, /Q8 comes between Q7 and Q9 and would be skipped too/);
  assert.equal(gap.suggestion?.text, "hide Q9–Q12 when Q7 = no", "the safe alternative: display logic on each");
  const hidden = applySurveyActions(def, gap.suggestion!.actions!);
  assert.deepEqual(hidden.errors, []);
  assert.equal(formatCondition(hidden.def, q(hidden.def, "Q9").displayLogic), "Q7 = 1 AND NOT (Q7 = 2)", "Q9's own logic is kept, the new condition is an exception");
  assert.match(as(say(def, "if Q7 is no, skip Q8 and Q10"), "refused").reason, /not one — Q9 sits between them/);
  assert.match(as(say(def, "skip to Q9"), "refused").reason, /A skip needs a condition/);
});

test("refused: a skip whose questions share a page — the page break comes first, offered as the fix", () => {
  const def = survey();
  // Q14 and Q15 share a page: a skip from Q13 over Q14 lands on Q15's page, which shows Q14 again
  const i = as(say(def, "if Q13 = 1, skip Q14"), "refused");
  assert.match(i.reason, /Q15 shares a page with Q14/);
  const fix = applySurveyActions(def, i.suggestion!.actions!);
  assert.deepEqual(fix.errors, []);
  assert.deepEqual(q(fix.def, "Q13").skipLogic[0].target, { kind: "question", ref: "q15" });
  assert.ok(listPages(fix.def.flow as unknown[]).some((p) => p.node.questionIds.join() === "q15"), "Q15 is on its own page now");
});

/* ============================================================ the recogniser families */

test("required: optional, mandatory, the selection, a range, already set", () => {
  const def = survey();
  assert.deepEqual(as(say(def, "Q7 should be required"), "actions").actions, [{ op: "update_question", target: "Q7", required: true }]);
  assert.deepEqual(as(say(def, "make this question mandatory", { selectedId: "q4" }), "actions").actions, [{ op: "update_question", target: "Q4", required: true }]);
  assert.deepEqual(as(say(def, "make Q8 through Q10 required"), "actions").actions.map((a) => (a as { target: string }).target), ["Q8", "Q9", "Q10"]);
  assert.deepEqual(as(say(def, "make these questions required", { selectedIds: ["q2", "q3"] }), "actions").actions.length, 2);
  assert.match(as(say(def, "make Q7 optional"), "refused").reason, /already optional/);
});

test("skips: to a question, after a named question, to the end, screen-outs and terminations", () => {
  const def = survey();
  const a = as(say(def, "skip to Q9 when Q2 = North"), "actions");
  assert.deepEqual(a.actions, [{ op: "add_skip", from: "Q2", when: "Q2 = North", to: "Q9" }]);
  assert.deepEqual(q(applied(def, a), "Q2").skipLogic[0].target, { kind: "question", ref: "q9" });
  assert.deepEqual(as(say(def, "after Q2 skip to Q9 if Q2 is South"), "actions").actions, [{ op: "add_skip", from: "Q2", when: "Q2 = South", to: "Q9" }]);
  const end = as(say(def, "when Q3 = 1 go to the end"), "actions");
  assert.deepEqual(q(applied(def, end), "Q3").skipLogic[0].target, { kind: "end", status: "complete" });
  const screen = as(say(def, "screen out if Q1 < 18"), "actions");
  assert.deepEqual(screen.actions, [{ op: "add_skip", from: "Q1", when: "Q1 < 18", to: "screened" }]);
  assert.deepEqual(q(applied(def, screen), "Q1").skipLogic[0].target, { kind: "terminate", status: "screened" });
  assert.deepEqual(as(say(def, "terminate if Q1 is under 18"), "actions").actions, [{ op: "add_skip", from: "Q1", when: "Q1 < 18", to: "terminated" }]);
  assert.deepEqual(as(say(def, "if Q1 < 18, screen them out"), "actions").actions, [{ op: "add_skip", from: "Q1", when: "Q1 < 18", to: "screened" }]);
  const range = as(say(def, "If Q7 is No, skip Q8 through Q12"), "actions");
  assert.deepEqual(range.actions, [{ op: "add_skip", from: "Q7", when: "Q7 = No", to: "Q13" }]);
  assert.deepEqual(as(say(def, "skip Q8 through Q12 if Q7 = 2"), "actions").actions, [{ op: "add_skip", from: "Q7", when: "Q7 = 2", to: "Q13" }]);
  assert.deepEqual(as(say(def, "if Q7 = 2, skip Q8 to Q9 and go directly to Q10"), "actions").actions, [{ op: "add_skip", from: "Q7", when: "Q7 = 2", to: "Q10" }]);
  // a range that runs to the last question goes to the end
  const toEnd = as(say(def, "if Q13 = 1, skip Q14 and Q15"), "actions");
  assert.deepEqual(toEnd.actions, [{ op: "add_skip", from: "Q13", when: "Q13 = 1", to: "end" }]);
  assert.deepEqual(detectedOf(toEnd, "skip range"), ["Q14–Q15 → the end"]);
});

test("display: show / hide / also / unless / NOR / remove, on a question, a range or a block", () => {
  const def = survey();
  const hide = applied(def, say(def, "hide Q11 when Q3 = 2"));
  assert.equal(formatCondition(hide, q(hide, "Q11").displayLogic), "NOT (Q3 = 2)");
  const also = as(say(def, "also show Q8 when Q1 > 60"), "actions");
  assert.deepEqual(also.actions, [{ op: "set_display_logic", target: "Q8", expression: "Q7 = 1 OR Q1 > 60" }], "OR'd with the logic already there");
  const alsoDef = applied(def, also);
  assert.equal(formatCondition(alsoDef, q(alsoDef, "Q8").displayLogic), "Q7 = 1 OR Q1 > 60");
  const replace = as(say(def, "show Q8 only when Q1 > 60"), "actions");
  assert.match(replace.understood, /This replaces the current display logic \(Q8: Q7 = 1 \(Yes\)\) — say “also show …” to add to it instead\./);
  assert.deepEqual(as(say(def, "show Q11 only when Q7 is not Yes"), "actions").actions, [{ op: "set_display_logic", target: "Q11", expression: "Q7 != Yes" }]);
  assert.deepEqual(as(say(def, "remove the display logic from Q8"), "actions").actions, [{ op: "set_display_logic", target: "Q8", expression: null }]);
  assert.match(as(say(def, "remove the display logic from Q11"), "refused").reason, /Q11 has no display logic/);
  for (const s of ["show Q15 if neither Q3 = 1 nor Q4 = 1", "show Q15 when none of Q3 = 1, Q4 = 1"]) {
    const after = applied(def, say(def, s));
    assert.equal(formatCondition(after, q(after, "Q15").displayLogic), "NOT (Q3 = 1 OR Q4 = 1)", s);
  }
  const unless = applied(def, say(def, "show Q15 unless Q3 = 2"));
  assert.equal(formatCondition(unless, q(unless, "Q15").displayLogic), "NOT (Q3 = 2)");
  const exception = applied(def, say(def, "show Q15 when Q1 >= 18 unless Q3 = 2"));
  assert.equal(formatCondition(exception, q(exception, "Q15").displayLogic), "Q1 >= 18 AND NOT (Q3 = 2)");
  assert.deepEqual(as(say(def, "Q15 should only be shown when Q3 is Female"), "actions").actions, [{ op: "set_display_logic", target: "Q15", expression: "Q3 = Female" }]);
  assert.deepEqual(as(say(def, "if Q3 = 2 then hide Q15"), "actions").actions, [{ op: "set_display_logic", target: "Q15", expression: "NOT (Q3 = 2)" }]);
  // a block is named by id in the action: its title “Brands” is also the variable BRANDS (Q5)
  const block = as(say(def, "show block Brands only if Q7 = 1"), "actions");
  assert.deepEqual(block.actions, [{ op: "set_display_logic", target: "b_brand", expression: "Q7 = 1" }]);
  assert.equal(q(applied(def, block), "Q5").displayLogic, undefined);
  // a condition the parser cannot read is refused with the parser's own words and its correction
  const typo = as(say(def, "show Q15 only when Q3 is Femal"), "refused");
  assert.match(typo.reason, /I could not read the condition “Q3 is Femal”: .*did you mean Female/);
  assert.equal(typo.suggestion?.text, "show Q15 only when Q3 = Female");
});

test("randomization: options, keep first / last / Other, pick N, rows, stop, blocks", () => {
  const def = survey();
  assert.deepEqual(as(say(def, "randomize Q7 options"), "actions").actions, [{ op: "set_option_randomization", target: "Q7", enabled: true }]);
  assert.deepEqual(as(say(def, "randomize the options of Q11 keeping Other last"), "actions").actions, [{ op: "set_option_randomization", target: "Q11", enabled: true, keepLast: [4] }]);
  const first = as(say(def, "randomize Q5 and keep Brand A first"), "actions");
  assert.deepEqual(first.actions, [{ op: "set_option_randomization", target: "Q5", enabled: true, keepFirst: [1] }]);
  assert.ok(q(applied(def, first), "Q5").options[0].flags.includes("anchor_top"));
  const pick = as(say(def, "show 3 random options of Q5"), "actions");
  assert.deepEqual(pick.actions, [{ op: "set_option_randomization", target: "Q5", enabled: true, pick: 3 }]);
  assert.equal(q(applied(def, pick), "Q5").randomization?.pick, 3);
  assert.deepEqual(as(say(def, "randomize the rows of Q12"), "actions").actions, [{ op: "set_option_randomization", target: "Q12", enabled: true, scope: "rows" }]);
  assert.deepEqual(as(say(def, "stop randomizing Q7"), "actions").actions, [{ op: "set_option_randomization", target: "Q7", enabled: false }]);
  assert.deepEqual(as(say(def, "randomize blocks Usage and Brands"), "actions").actions, [{ op: "create_randomizer", blocks: ["Usage", "Brands"] }]);
  assert.match(as(say(def, "randomize Q5 and keep Brand Z last"), "refused").reason, /Q5 has no option “Brand Z”/);
});

test("masking: show only / hide what was chosen / carry forward / by / remove the mask — and the engine's order check", () => {
  const def = survey();
  const display = [{ op: "set_mask", target: "Q10", expression: "Q5.Selected" }];
  for (const s of ["at Q10 show only the options selected in Q5", "show only Q5's selected brands at Q10", "carry forward Q5's selected options to Q10", "carry forward the brands selected in Q5 to Q10", "mask Q10 by Q5"]) {
    assert.deepEqual(as(say(def, s), "actions").actions, display, s);
  }
  const remove = [{ op: "set_mask", target: "Q10", expression: "Q5.Selected", action: "remove" }];
  for (const s of ["hide at Q10 what was chosen in Q5", "remove from Q10 the options selected in Q5"]) assert.deepEqual(as(say(def, s), "actions").actions, remove, s);
  assert.equal(q(applied(def, say(def, "hide at Q10 what was chosen in Q5")), "Q10").mask?.action, "remove");
  assert.deepEqual(as(say(def, "at Q10 show only the brands not selected in Q5"), "actions").actions, [{ op: "set_mask", target: "Q10", expression: "Q5.Unselected" }]);
  // the mask's source must be asked first: the engine refuses, and says why
  assert.match(as(say(def, "at Q5 show only the options selected in Q10"), "refused").reason, /Q10 is asked after Q5/);
  // removing a mask
  const masked = applied(def, say(def, "mask Q10 by Q5"));
  assert.deepEqual(as(say(masked, "remove the mask from Q10"), "actions").actions, [{ op: "clear_mask", target: "Q10" }]);
  assert.match(as(say(def, "remove the mask from Q10"), "refused").reason, /Q10 has no mask to remove/);
});

test("options: add Other / None / several, remove, rename, exclusive, sort, move, recode, conditional", () => {
  const def = survey();
  const other = as(say(def, "add an Other option to Q4"), "actions");
  assert.deepEqual(other.actions, [{ op: "update_question", target: "Q4", addOptions: [{ label: "Other (please specify)", other: true }] }]);
  assert.ok(q(applied(def, other), "Q4").options.at(-1)!.flags.includes("other_specify"));
  const none = as(say(def, "add a None of these option to Q14"), "actions");
  assert.deepEqual(none.actions, [{ op: "update_question", target: "Q14", addOptions: [{ label: "None of these", exclusive: true }] }]);
  assert.ok(q(applied(def, none), "Q14").options.at(-1)!.flags.includes("exclusive"));
  assert.deepEqual(as(say(def, "add options Red, Green and Blue to Q14"), "actions").actions, [{ op: "update_question", target: "Q14", addOptions: ["Red", "Green", "Blue"] }]);
  assert.match(as(say(def, "add options Black to Q14"), "refused").reason, /already has “Black”/);
  assert.deepEqual(as(say(def, "remove option Canada from Q11"), "actions").actions, [{ op: "update_question", target: "Q11", removeOptions: [1] }]);
  assert.deepEqual(as(say(def, "delete the third option of Q11"), "actions").actions, [{ op: "update_question", target: "Q11", removeOptions: [3] }]);
  assert.deepEqual(as(say(def, "rename option 3 of Q11 to Mexico City"), "actions").actions, [{ op: "update_option", target: "Q11", option: 3, label: "Mexico City" }]);
  assert.deepEqual(as(say(def, "change option “US” in Q11 to “United States”"), "actions").actions, [{ op: "update_option", target: "Q11", option: 2, label: "United States" }]);
  const excl = [{ op: "update_option", target: "Q5", option: 99, exclusive: true }];
  for (const s of ["make None exclusive in Q5", "make Q5 options exclusive for None", "mark “None of these” as exclusive"]) assert.deepEqual(as(say(def, s), "actions").actions, excl, s);
  assert.ok(q(applied(def, say(def, "make None exclusive in Q5")), "Q5").options.at(-1)!.flags.includes("exclusive"));
  assert.match(as(say(applied(def, say(def, "make None exclusive in Q5")), "make None exclusive in Q5"), "refused").reason, /already exclusive/);
  assert.deepEqual(as(say(def, "reorder Q11 options alphabetically"), "actions").actions, [{ op: "reorder_options", target: "Q11", sort: "alphabetical" }]);
  assert.deepEqual(as(say(def, "sort Q11 Z to A"), "actions").actions, [{ op: "reorder_options", target: "Q11", sort: "alphabetical_desc" }]);
  assert.deepEqual(as(say(def, "reverse the options of Q11"), "actions").actions, [{ op: "reorder_options", target: "Q11", sort: "reverse" }]);
  const moved = as(say(def, "move Mexico to the top of Q11"), "actions");
  assert.deepEqual(moved.actions, [{ op: "update_option", target: "Q11", option: 3, position: 1 }]);
  assert.equal(q(applied(def, moved), "Q11").options[0].label, "Mexico");
  assert.deepEqual(as(say(def, "move Canada to the bottom of Q11"), "actions").actions, [{ op: "update_option", target: "Q11", option: 1, position: 4 }]);
  assert.match(as(say(def, "move Canada to the top of Q11"), "refused").reason, /already the first option/);
  const recoded = as(say(def, "recode option Male in Q3 as 5"), "actions");
  assert.deepEqual(recoded.actions, [{ op: "update_option", target: "Q3", option: 1, code: 5 }]);
  const after = applied(def, recoded);
  assert.equal(formatCondition(after, after.quotas[0].cells[0].when), "Q3 = 5", "the quota cell that compared with 1 follows the recode");
  const vis = as(say(def, "show option Canada in Q11 only when Q3 = 1"), "actions");
  assert.deepEqual(vis.actions, [{ op: "update_option", target: "Q11", option: 1, visibleIf: "Q3 = 1" }]);
  assert.equal(formatCondition(def, q(applied(def, vis), "Q11").options[0].visibleIf), "Q3 = 1");
  const ambiguous = as(say(def, "remove option Brand from Q10"), "clarify");
  assert.equal(ambiguous.choices.length, 4, "four options of Q10 contain “Brand”");
});

test("questions: delete, duplicate, move, change type, rename variable and code, explicit wording, create", () => {
  const def = survey();
  for (const s of ["delete Q15", "remove question 15"]) {
    const i = as(say(def, s), "actions");
    assert.deepEqual(i.actions, [{ op: "delete_question", target: "Q15" }], s);
    assert.match(i.understood, /Impact: nothing else depends on it/);
  }
  const del3 = as(say(def, "delete Q3"), "actions");
  assert.deepEqual(detectedOf(del3, "breaks"), ["quota “Gender”"], "what a deletion breaks travels in detected");
  assert.equal(applied(def, as(say(def, "duplicate Q7"), "actions")).questions.length, 16);
  assert.deepEqual(as(say(def, "copy Q7 after Q9"), "actions").actions, [{ op: "duplicate_question", target: "Q7", after: "Q9" }]);
  assert.deepEqual(as(say(def, "move Q4 after Q6"), "actions").actions, [{ op: "move_question", target: "Q4", after: "Q6" }]);
  assert.match(as(say(def, "move Q7 after Q9"), "refused").reason, /Q8, whose logic reads Q7's answer/, "the engine's move-order check");
  assert.deepEqual(as(say(def, "move Q4 to block Brands"), "actions").actions, [{ op: "move_question", target: "Q4", block: "Brands" }]);
  const dd = as(say(def, "change Q7 to a dropdown"), "actions");
  assert.deepEqual(dd.actions, [{ op: "update_question", target: "Q7", type: "dropdown" }]);
  assert.equal(q(applied(def, dd), "Q7").variant, "single_select.dropdown");
  assert.deepEqual(as(say(def, "make Q7 multi select"), "actions").actions, [{ op: "update_question", target: "Q7", type: "multi_select" }]);
  assert.deepEqual(as(say(def, "convert Q9 to a slider"), "actions").actions, [{ op: "update_question", target: "Q9", type: "slider" }]);
  const ren = as(say(def, "rename AGE to RESP_AGE"), "actions");
  assert.equal(ren.category, "variables");
  const renamed = applied(def, ren);
  assert.equal(q(renamed, "Q1").variableName, "RESP_AGE");
  assert.equal(renamed.calculations[0].expression, "RESP_AGE - CAR_AGE", "what read the old name follows it");
  assert.deepEqual(as(say(def, "rename Q11's variable to BIRTH_COUNTRY"), "actions").actions, [{ op: "update_question", target: "Q11", variable: "BIRTH_COUNTRY" }]);
  assert.deepEqual(as(say(def, "change Q7's code to S1"), "actions").actions, [{ op: "update_question", target: "Q7", code: "S1" }]);
  assert.deepEqual(as(say(def, "change the text of Q15 to “Anything else to add?”"), "actions").actions, [{ op: "update_question", target: "Q15", text: "Anything else to add?" }]);
  const created = as(say(def, "add a numeric question “How many cars do you own?” after Q7"), "actions");
  assert.equal(created.category, "question_creation");
  assert.deepEqual(created.actions, [{ op: "create_question", type: "numeric", text: "How many cars do you own?", after: "Q7" }]);
  assert.deepEqual(as(say(def, "add a single choice question “Do you rent?” with options Yes, No"), "actions").actions, [{ op: "create_question", type: "single_select", text: "Do you rent?", options: ["Yes", "No"] }]);
  assert.equal(as(say(def, "add a question about income"), "model").category, "question_creation", "wording to be written is the model's");
  assert.deepEqual(as(say(def, "rename block Usage to Behaviour"), "actions").actions, [{ op: "rename_block", target: "Usage", title: "Behaviour" }]);
});

test("validation: ranges, selections, exact, length, formats — merged with the rules already there", () => {
  const def = survey();
  assert.deepEqual(as(say(def, "Q1 must be between 18 and 99"), "actions").actions, [{ op: "set_validation", target: "Q1", rules: [{ kind: "min_value", value: 18 }, { kind: "max_value", value: 99 }] }]);
  assert.deepEqual(as(say(def, "Q5 needs at least 2 selections"), "actions").actions, [{ op: "set_validation", target: "Q5", rules: [{ kind: "min_selections", value: 2 }] }]);
  assert.deepEqual(as(say(def, "at most 3 selections on Q5"), "actions").actions, [{ op: "set_validation", target: "Q5", rules: [{ kind: "max_selections", value: 3 }] }]);
  const exact = applied(def, say(def, "exactly 2 selections on Q5"));
  assert.deepEqual(q(exact, "Q5").validation.map((v) => [v.kind, v.value]), [["min_selections", 2], ["max_selections", 2]]);
  assert.deepEqual(as(say(def, "limit Q6 to 120 characters"), "actions").actions, [{ op: "set_validation", target: "Q6", rules: [{ kind: "max_length", value: 120 }] }]);
  assert.deepEqual(as(say(def, "Q9 must be a whole number"), "actions").actions, [{ op: "set_validation", target: "Q9", rules: [{ kind: "integer" }] }]);
  // ADDING a rule keeps the others: Q15's max length 500 stays
  const merged = as(say(def, "Q15 must be at least 10 characters"), "actions");
  assert.deepEqual(merged.actions, [{ op: "set_validation", target: "Q15", rules: [{ kind: "max_length", value: 500 }, { kind: "min_length", value: 10 }] }]);
  assert.match(merged.understood, /its other rules stay \(maximum length 500\)/);
  // the same kind is replaced, and said
  assert.match(as(say(def, "limit Q15 to 200 characters"), "actions").understood, /replacing maximum length 500/);
  assert.deepEqual(as(say(def, "remove the validation from Q15"), "actions").actions, [{ op: "set_validation", target: "Q15", rules: [] }]);
  // a rule the question cannot take is the engine's refusal
  assert.match(as(say(def, "Q7 must be an email address"), "refused").reason, /Q7 is a single-select question, so an email format does not apply/);
});

test("validation: a rule asked for as it already stands keeps the stored one, and an inapplicable rule offers no empty fix", () => {
  const def = survey();
  const q15 = def.questions.find((x) => x.code === "Q15")!;
  q15.validation = [{ id: "v1", kind: "max_length", value: 500 }, { id: "v2", kind: "email", message: "Please enter a valid email address." } as never];
  // the same rule again: nothing to change — not a rewrite that drops its message
  const same = as(say(def, "Q15 must be an email address"), "refused");
  assert.equal(same.reason, "Q15 already has that rule (email) — nothing to change.");
  assert.equal(as(say(def, "limit Q15 to 500 characters"), "refused").reason, "Q15 already has that rule (maximum length 500) — nothing to change.");
  // one of two already there: only the new one is set, the stored one (with its message) is kept as it was
  const part = as(say(def, "Q15 must be between 10 and 500 characters"), "actions");
  assert.deepEqual(part.actions, [{ op: "set_validation", target: "Q15", rules: [{ kind: "max_length", value: 500 }, { kind: "email", message: "Please enter a valid email address." }, { kind: "min_length", value: 10 }] }]);
  assert.equal(q(applied(def, part), "Q15").validation.find((v) => v.kind === "email")?.message, "Please enter a valid email address.");
  // a value range on a text question is refused; the engine's fallback (its existing rules, unchanged) is not offered as a "fix"
  const bad = as(say(def, "Q15 must be between 1 and 5"), "refused");
  assert.match(bad.reason, /text question, so a minimum value does not apply/);
  assert.equal(bad.suggestion, undefined);
});

test("page breaks, embedded variables and calculations", () => {
  const def = survey();
  const pb = as(say(def, "page break after Q14"), "actions");
  assert.deepEqual(pb.actions, [{ op: "page_break", after: "Q14" }]);
  assert.ok(listPages(applied(def, pb).flow as unknown[]).some((p) => p.node.questionIds.join() === "q15"));
  assert.deepEqual(as(say(def, "put Q15 on a new page"), "actions").actions, [{ op: "page_break", after: "Q14" }], "the break before Q15 is the break after the question above it");
  assert.match(as(say(def, "put Q14 on a new page"), "refused").reason, /already starts its page/);
  assert.deepEqual(as(say(def, "remove the page break after Q4"), "actions").actions, [{ op: "page_break", after: "Q4", remove: true }]);
  assert.deepEqual(as(say(def, "create an embedded variable called source from the url"), "actions").actions, [{ op: "create_embedded", name: "source", source: "url" }]);
  assert.deepEqual(as(say(def, "create an embedded variable called country and set it to India"), "actions").actions, [{ op: "create_embedded", name: "country", source: "static", value: "India" }]);
  const calc = as(say(def, "add a calculated variable TOTAL = Q1 + Q9"), "actions");
  assert.equal(calc.category, "calculations");
  assert.deepEqual(calc.actions, [{ op: "create_calculation", name: "TOTAL", expression: "Q1 + Q9" }]);
  assert.match(as(say(def, "add a calculated variable TOTAL = Q1 + Q99"), "refused").reason, /Q99, which is not in the survey/);
});

test("survey settings, hypotheses, languages", () => {
  const def = survey();
  const title = as(say(def, "rename the survey to Brand Health 2026"), "actions");
  assert.deepEqual(title.actions, [{ op: "set_survey_settings", title: "Brand Health 2026" }]);
  assert.equal(applied(def, title).meta.title, "Brand Health 2026");
  assert.deepEqual(as(say(def, "set the survey title to “Wave 4”"), "actions").actions, [{ op: "set_survey_settings", title: "Wave 4" }]);
  const h = as(say(def, "add hypothesis: women are more satisfied than men"), "actions");
  assert.deepEqual(h.actions, [{ op: "add_hypothesis", text: "Women are more satisfied than men" }]);
  assert.match(h.understood, /^Record hypothesis H2/);
  assert.deepEqual(applied(def, as(say(def, "remove hypothesis H1"), "actions")).research!.hypotheses, []);
  assert.match(as(say(def, "remove hypothesis H5"), "refused").reason, /there is no hypothesis H5/);
  const fr = as(say(def, "add French as a language"), "actions");
  assert.deepEqual(fr.actions, [{ op: "add_language", code: "fr", name: "French" }]);
  assert.ok(applied(def, fr).localization!.languages.some((l) => l.code === "fr"));
  assert.deepEqual(as(say(def, "add Canadian French"), "actions").actions, [{ op: "add_language", code: "fr", locale: "fr-CA", name: "Canadian French" }]);
  assert.match(as(say(def, "add German as a language"), "refused").reason, /German is already a language of this survey/);
  assert.deepEqual(as(say(def, "remove German"), "actions").actions, [{ op: "remove_language", code: "de" }]);
});

test("dependencies: what reads Q7 in every spelling, what Q9 reads, a calculation by name", () => {
  const def = survey();
  for (const s of ["what uses Q7", "which logic references Q7", "show me everything that reads Q7", "What depends on Q7?", "what is affected by Q7"]) {
    const i = as(say(def, s), "answer");
    assert.equal(i.category, "dependency_analysis", s);
    assert.deepEqual(items(i, "Display logic").map((x) => x.key), ["question:q8", "question:q9"], s);
  }
  const reads = as(say(def, "What does Q9 depend on?"), "answer");
  assert.equal(reads.answer, "Q9 depends on 1 object: Q7.");
  assert.deepEqual(items(reads, "Display logic").map((x) => [x.label, x.key]), [["Q7 — display logic", "question:q7"]]);
  const calc = as(say(def, "what does AGE_GAP read"), "answer");
  assert.ok(items(calc, "Calculations").some((x) => x.key === "question:q9" && x.detail === "= AGE - CAR_AGE"));
  assert.deepEqual(items(calc, "Indirectly").map((x) => x.key), ["question:q7"]);
  assert.equal(as(say(def, "what uses Q15"), "answer").answer, "Nothing depends on Q15.");
  assert.equal(as(say(def, "what depends on Q3"), "answer").sections[0].title, "Quotas");
  assert.match(as(say(def, "what depends on Q77"), "refused").reason, /There is no Q77 in this survey — did you mean Q7\?/);
});

test("impact: delete a question or a block, remove an option, change a type", () => {
  const def = survey();
  for (const s of ["what happens if I remove Q7", "can I delete Q7", "what will break if I delete Q7", "is it safe to delete Q7"]) {
    const i = as(say(def, s), "answer");
    assert.equal(i.category, "impact_analysis", s);
    assert.deepEqual(items(i, "Breaks").map((x) => x.label), ["Q8 display logic", "Q9 display logic"], s);
    assert.ok(items(i, "Changes").some((x) => x.label === "calculation AGE_GAP" && /indirect/.test(x.detail!)), s);
    assert.ok(items(i, "To review").some((x) => /translations/.test(x.label)), s);
  }
  const opt = as(say(def, "what breaks if I remove option Male from Q3"), "answer");
  assert.deepEqual(items(opt, "Breaks").map((x) => [x.label, x.key]), [["quota “Gender”", "quota:qt1"]]);
  const block = as(say(def, "what breaks if I delete block Usage"), "answer");
  assert.ok(items(block, "Breaks").some((x) => x.label === "calculation AGE_GAP"));
  const retype = as(say(def, "if I change Q7 to a numeric question, what breaks"), "answer");
  assert.match(retype.understood, /changing Q7 from .* to Numeric/);
  assert.ok(retype.answer.startsWith("Impact: 4 dependent objects"));
  const text = as(say(def, "what breaks if I change Q3 to a text question"), "answer");
  assert.deepEqual(text.sections.map((s) => [s.title, s.items.map((x) => x.key)]), [["Changes", ["quota:qt1"]]], "the quota cell still reads Q3 = 1: a change, not a break");
  assert.deepEqual(detectedOf(text, "new type"), ["Single-Line Text"]);
});

test("translation status: per language, missing and outdated by question; no languages is said", () => {
  const def = survey();
  const i = as(say(def, "Which questions are untranslated?"), "answer");
  assert.equal(i.category, "translation");
  assert.match(i.answer, /^Deutsch: 15 questions and some survey texts with missing or outdated text \(\d+% complete\)\.$/);
  const q7 = i.sections[0].items.find((x) => x.label === "Q7")!;
  assert.equal(q7.key, "question:q7");
  assert.match(q7.detail!, /^2 missing \(Q7 · option 1, Q7 · option 2\)$/, "Q7's text is translated, its two options are not");
  assert.equal(as(say(def, "what is missing in German"), "answer").sections.length, 1);
  assert.match(as(say(def, "what is missing in French"), "answer").answer, /French is not a language of this survey/);
  const mono = survey();
  delete (mono as { localization?: unknown }).localization;
  assert.match(as(say(mono, "Which questions are untranslated?"), "answer").answer, /only its source language/);
});

test("what measures a concept: constructs, analysis tags and wording, each labelled with its evidence", () => {
  const def = survey();
  const i = as(say(def, "Which questions measure purchase intent?"), "answer");
  assert.equal(i.category, "research_design");
  assert.deepEqual(items(i, "Research constructs").map((x) => x.label), ["Q13"]);
  assert.deepEqual(items(i, "Tagged in the analysis").map((x) => x.label), ["Q13"]);
  assert.deepEqual(items(i, "By wording").map((x) => x.label), ["Q13"], "“buy” and “likely” are purchase and intent");
  assert.match(i.answer, /Q13 \(construct “Purchase intent”, analysis tag, wording\)/);
  const price = as(say(def, "which questions are about price"), "answer");
  assert.deepEqual(items(price, "By wording").map((x) => x.label), ["Q12"], "a grid's rows are what it measures");
  assert.match(as(say(def, "which questions measure loyalty"), "answer").answer, /No question measures “loyalty”/);
});

test("analysis queries: what can be run, segments", () => {
  const def = survey();
  const i = as(say(def, "What analysis can I run on this study?"), "answer");
  assert.equal(i.category, "analysis");
  assert.match(i.answer, /^From the survey's design \(no plan is saved yet/);
  assert.deepEqual(i.sections.map((s) => s.title), ["Crosstabs", "Tests", "Derived variables", "Segments"]);
  const saved = applied(def, say(def, "plan the analysis"));
  assert.match(as(say(saved, "What analysis can I run on this study?"), "answer").answer, /^The saved analysis plan has/);
  const seg = as(say(def, "which variables are used in segment What is your gender?"), "answer");
  assert.equal(seg.answer, "Segment “What is your gender?” is defined by GENDER.");
  assert.match(as(say(def, "which variables are used in segment Lifestyle"), "answer").answer, /There is no segment “Lifestyle” — the segments are/);
});

test("defer:grammar — explain, diagnose, screening, what can affect, loops, hidden variables are the Studio grammar's", () => {
  const def = survey();
  for (const [s, category] of [["explain Q7", "debugging"], ["why is Q8 not showing", "debugging"], ["Why is Q8 unreachable?", "debugging"], ["what can affect Q9", "dependency_analysis"], ["explain why respondents are screened out", "debugging"], ["create a loop around Q8 to Q9 for each brand", "survey_editing"], ["add a hidden variable for respondent type", "variables"], ["what is Q7", "debugging"]] as const) {
    const i = as(say(def, s), "model");
    assert.equal(i.reason, DEFER_TO_GRAMMAR, s);
    assert.equal(i.reason, "defer:grammar");
    assert.equal(i.category, category, s);
  }
  assert.deepEqual(detectedOf(say(def, "explain Q7"), "question"), ["Q7"]);
});

test("the model's sentences: generation, rewording, look and feel, briefs — with what they named detected", () => {
  const def = survey();
  assert.equal(as(say(def, "create a survey about coffee habits"), "model").category, "survey_creation");
  const reword = as(say(def, "reword Q7 to be clearer"), "model");
  assert.equal(reword.category, "question_modification");
  assert.deepEqual(detectedOf(reword, "question"), ["Q7"]);
  assert.equal(as(say(def, "make Q5 friendlier"), "model").category, "question_modification");
  assert.equal(as(say(def, "change the theme to dark blue"), "model").category, "survey_editing");
  const brief = "This is a brand awareness study for a soft drinks client: we want to understand which brands Gen Z respondents know, which they buy, and why they switch — create an analysis framework for it";
  assert.equal(as(say(def, brief), "model").category, "research_design", "a long research description is the model's, whatever verbs it contains");
  const named = as(say(def, "compare Q5 Brand A buyers with Q7 No respondents somehow"), "model");
  assert.deepEqual(detectedOf(named, "question"), ["Q5", "Q7"]);
  assert.deepEqual(detectedOf(named, "option"), ["Q5: Brand A", "Q7: No"]);
  assert.equal(as(say(def, "make me a sandwich"), "model").category, null);
});

test("the contract: never throws, empty asks, every category is listed, every edit is validated", () => {
  const def = survey();
  assert.equal(INTENT_CATEGORIES.length, 23);
  assert.equal(new Set(INTENT_CATEGORIES).size, 23);
  assert.equal(say(def, "").kind, "clarify");
  assert.equal(say(def, "   ").kind, "clarify");
  const broken = { ...def, questions: null } as unknown as SurveyDefinition;
  assert.doesNotThrow(() => say(broken, "make Q7 required"));
  assert.equal(say(broken, "make Q7 required").kind, "model");
  for (const s of ["Make Q7 required", "If Q7 is no, skip the next five questions", "mask Q10 by Q5", "Q1 must be between 18 and 99", "add an Other option to Q4", "randomize Q5", "page break after Q14"]) {
    const i = say(def, s);
    assert.ok(INTENT_CATEGORIES.includes(i.category!), s);
    applied(def, i);
  }
});

test("a quota is deleted by its name — never read as a question or a block; an unknown one is refused with the names there are", () => {
  const def = survey();
  def.quotas = [{ id: "qq", name: "Gender × Age", mode: "hard", onFull: { kind: "terminate" }, countStatus: ["complete"], cells: [{ id: "c1", label: "Men", when: { type: "rule", source: { kind: "question", ref: def.questions[0].id }, operator: "answered" }, limit: 10 }] }] as never;
  const it = interpretRequest(def, "Delete the gender x age quota");
  assert.equal(it.kind, "actions", JSON.stringify(it));
  if (it.kind === "actions") assert.deepEqual(it.actions, [{ op: "delete_quota", quota: "Gender × Age" }]);
  const no = interpretRequest(def, "Remove the region quota");
  assert.equal(no.kind, "refused");
  if (no.kind === "refused") assert.match(no.reason, /no quota “region” — the quotas are “Gender × Age”/);
});

test("several instructions in one sentence: each clause read in turn, the whole applied together — and a clause the engine hands on hands the whole sentence on", () => {
  assert.deepEqual(splitCommands("Remove the Wrap up block and make Q2 required"), ["Remove the Wrap up block", "make Q2 required"]);
  assert.deepEqual(splitCommands("Show Q8 when Q7 = 1 and Q1 > 18"), ["Show Q8 when Q7 = 1 and Q1 > 18"], "a condition's AND is not a new instruction");
  assert.deepEqual(splitCommands("If Q1 < 18, skip to the end, and make Q2 required"), ["If Q1 < 18, skip to the end", "make Q2 required"], "a leading condition belongs to the clause right after it");
  assert.deepEqual(splitCommands("if Q7 = 2, skip Q8 to Q9 and go directly to Q10"), ["if Q7 = 2, skip Q8 to Q9 and go directly to Q10"], "“and go to” continues the skip");
  assert.deepEqual(splitCommands("create an embedded variable called country and set it to India"), ["create an embedded variable called country and set it to India"], "a verb on “it” continues the clause");
  assert.deepEqual(splitCommands("Make Q2 required. Delete Q15; randomize Q5"), ["Make Q2 required", "Delete Q15", "randomize Q5"]);
  const def = survey();
  const both = as(say(def, "Remove the Wrap up block and make Q2 required"), "actions");
  assert.deepEqual(both.actions.map((a) => a.op), ["delete_block", "update_question"]);
  assert.match(both.understood, /; then Make Q2 required\.$/);
  const after = applySurveyActions(def, both.actions);
  assert.deepEqual(after.errors, []);
  assert.equal(after.def.questions.find((q) => q.id === "q2")!.required, true);
  assert.ok(!after.def.questions.some((q) => q.id === "q15"), "the block's questions went with it");
  /* each clause reads the survey the clauses before it leave: the second skip is from the question the first one names */
  const seq = as(say(def, "If Q1 < 18, terminate, then make Q2 required"), "actions");
  assert.deepEqual(seq.actions.map((a) => a.op), ["add_skip", "update_question"]);
  /* a clause for the model: the whole sentence goes to it */
  const handed = say(def, "Make Q2 required and reword Q3 to sound friendlier");
  assert.equal(handed.kind, "model");
  /* a refused clause refuses the whole, naming the clause, and nothing else is applied */
  const bad = as(say(def, "Make Q2 required and delete Q99"), "refused");
  assert.match(bad.understood, /^In “delete Q99”/);
  assert.match(bad.reason, /Nothing else in the request was applied\.$/);
  /* an ambiguous clause asks, and each choice is the whole sentence with the candidate in it */
  const amb = say(def, "Make Q2 required and make the brands question optional");
  if (amb.kind === "clarify") assert.ok(amb.choices.every((c) => c.text.startsWith("Make Q2 required and ")), JSON.stringify(amb.choices));
  /* a question and an edit in one sentence is the model's */
  assert.equal(say(def, "What depends on Q7 and make Q8 required").kind === "actions", false);
});

/* ============================================================ mutation-checked: the edges each recogniser turns on */

test("required by verb; skips at their edges: the range's own first question, back to itself, “back” to a question ahead, a mid-page target, quota full, unless, one page, a landing that disagrees", () => {
  const def = survey();
  assert.deepEqual(as(say(def, "require Q7"), "actions").actions, [{ op: "update_question", target: "Q7", required: true }]);
  assert.match(as(say(def, "if Q8 = 1, skip Q8 through Q12"), "refused").reason, /reads Q8, which is asked inside the questions to skip \(Q8–Q12\)/);
  assert.match(as(say(def, "if Q5 = 1, skip to Q5"), "refused").reason, /and Q5 is that question itself/);
  const back = as(say(def, "if Q2 = 1, jump back to Q9"), "refused");
  assert.match(back.reason, /^Skips only move forward, and Q9 is asked after Q2 \(the question the condition reads\), so there is nothing to go back to/, "“back” is refused, and the reason says where Q9 really is");
  assert.deepEqual(back.suggestion, { text: "if Q2 = 1, jump to Q9", actions: [{ op: "add_skip", from: "Q2", when: "Q2 = 1", to: "Q9" }] });
  const mid = as(say(def, "skip to Q15 when Q13 = 1"), "refused");
  assert.match(mid.reason, /Q15 shares a page with Q14, which is above it/);
  assert.deepEqual(mid.suggestion?.actions, [{ op: "page_break", after: "Q14" }, { op: "add_skip", from: "Q13", when: "Q13 = 1", to: "Q15" }]);
  const full = as(say(def, "if Q1 < 18, terminate as quota full"), "actions");
  assert.deepEqual(full.actions, [{ op: "add_skip", from: "Q1", when: "Q1 < 18", to: "quota_full" }]);
  assert.deepEqual(q(applied(def, full), "Q1").skipLogic[0].target, { kind: "terminate", status: "quota_full" });
  assert.deepEqual(as(say(def, "skip Q8 through Q12 unless Q7 = 1"), "actions").actions, [{ op: "add_skip", from: "Q7", when: "NOT (Q7 = 1)", to: "Q13" }]);
  const page = as(say(def, "if Q14 = 1, skip Q15"), "refused");
  assert.match(page.reason, /Q15 is on the same page as Q14, so it is already on screen/);
  assert.deepEqual(page.suggestion?.actions, [{ op: "page_break", after: "Q14" }, { op: "add_skip", from: "Q14", when: "Q14 = 1", to: "end" }]);
  assert.match(as(say(def, "if Q7 = 2, skip Q8 to Q9 and go to Q12"), "refused").reason, /^Skipping Q8–Q9 lands on Q10, but you asked to go to Q12 — that would skip more than you named/);
});

test("display, randomization, masking and options at their edges", () => {
  const def = survey();
  assert.deepEqual(as(say(def, "also hide Q8 when Q1 > 60"), "actions").actions, [{ op: "set_display_logic", target: "Q8", expression: "Q7 = 1 AND NOT (Q1 > 60)" }], "the old logic AND NOT the new condition");
  assert.deepEqual(as(say(def, "hide Q15 unless Q3 = 2"), "actions").actions, [{ op: "set_display_logic", target: "Q15", expression: "Q3 = 2" }], "hide unless = show when");
  assert.deepEqual(as(say(def, "remove the display logic from Q8 through Q11"), "actions").actions, [{ op: "set_display_logic", target: "Q8", expression: null }, { op: "set_display_logic", target: "Q9", expression: null }], "only the questions that have logic; the rest are no reason to refuse");
  assert.deepEqual(as(say(def, "randomize Q5 keeping None of these in place"), "actions").actions, [{ op: "set_option_randomization", target: "Q5", enabled: true, anchors: [99] }]);
  assert.deepEqual(as(say(def, "at Q10 show only the brands unselected in Q5"), "actions").actions, [{ op: "set_mask", target: "Q10", expression: "Q5.Unselected" }]);
  assert.deepEqual(as(say(def, "remove options Canada and US from Q11"), "actions").actions, [{ op: "update_question", target: "Q11", removeOptions: [1, 2] }]);
  assert.match(as(say(def, "make None not exclusive in Q5"), "refused").reason, /already not exclusive/);
  const excl = applied(def, say(def, "make None exclusive in Q5"));
  assert.deepEqual(as(say(excl, "make None not exclusive in Q5"), "actions").actions, [{ op: "update_option", target: "Q5", option: 99, exclusive: false }]);
  const za = applied(def, say(def, "sort Q11 Z to A"));
  assert.deepEqual(as(say(za, "sort Q11 by code"), "actions").actions, [{ op: "reorder_options", target: "Q11", sort: "numeric" }]);
  const mv = as(say(def, "move Mexico before US in Q11"), "actions");
  assert.deepEqual(mv.actions, [{ op: "update_option", target: "Q11", option: 3, position: { before: 2 } }]);
  assert.deepEqual(q(applied(def, mv), "Q11").options.map((o) => o.label), ["Canada", "Mexico", "US", "Other (please specify)"]);
  assert.deepEqual(as(say(def, "show option Canada in Q11 unless Q3 = 1"), "actions").actions, [{ op: "update_option", target: "Q11", option: 1, visibleIf: "NOT (Q3 = 1)" }]);
});

test("questions, validation, settings, languages and hypotheses at their edges", () => {
  const def = survey();
  assert.deepEqual(as(say(def, "move Q4 before Q2"), "actions").actions, [{ op: "move_question", target: "Q4", after: "Q1" }], "before Q2 is after the question above it");
  assert.deepEqual(as(say(def, "move Q2 through Q3 after Q4"), "actions").actions, [{ op: "move_question", target: "Q2", after: "Q4" }, { op: "move_question", target: "Q3", after: "Q2" }], "a run moves in order");
  assert.deepEqual(as(say(def, "remove the max length from Q15"), "actions").actions, [{ op: "set_validation", target: "Q15", rules: [] }]);
  assert.equal(as(say(def, "remove the validation from Q7"), "refused").reason, "Q7 has no validation rules to remove.");
  assert.deepEqual(as(say(def, "Q5 must be between 1 and 3 selections"), "actions").actions, [{ op: "set_validation", target: "Q5", rules: [{ kind: "min_selections", value: 1 }, { kind: "max_selections", value: 3 }] }]);
  const described = applied(def, say(def, "set the survey description to Wave 4 tracker"));
  assert.deepEqual(as(say(described, "clear the survey description"), "actions").actions, [{ op: "set_survey_settings", description: null }]);
  assert.match(as(say(def, "remove French"), "refused").reason, /^French is not a language of this survey/);
  assert.deepEqual(as(say(def, "remove the last hypothesis"), "actions").actions, [{ op: "remove_hypothesis", hypothesis: 1 }]);
  assert.equal(as(say(def, "delete QX77"), "refused").reason, "There is no QX77 in this survey.", "a code-shaped name that is not there is refused, not handed on");
});

test("queries at their edges: a question's own skip rules, a partial wording match, several did-you-means, an unknown language, a what-is that names nothing", () => {
  const def = survey();
  const skipped = applied(def, say(def, "after Q7, skip to Q10 when Q1 > 60"));
  const reads = as(say(skipped, "what does Q7 depend on"), "answer");
  assert.equal(reads.answer, "Q7 depends on 1 object: Q1.", "what its skip rule reads, Q7 reads");
  assert.deepEqual(items(reads, "Skip logic").map((x) => x.label), ["Q1 — skip logic"]);
  assert.deepEqual(as(say(def, "which questions measure price loyalty"), "answer").sections.map((s) => s.title), ["By wording (partial match)"]);
  const several = as(say(def, "make the car colour question required"), "refused");
  assert.equal(several.reason, "There is no question “the car colour question” in this survey — did you mean Q7, Q8, Q9, Q14?", "did-you-means are not a clarification: none of them fits every word");
  assert.equal(several.suggestion, undefined);
  assert.equal(as(say(def, "which questions are untranslated in Klingon"), "model").category, null, "not a language: handed on, not answered for every language");
  assert.notEqual(as(say(def, "what is the weather"), "model").reason, DEFER_TO_GRAMMAR, "“what is …” is the grammar's only when it names a question");
});

test("the long brief at its edges, and compound sentences: each clause reads the survey the clauses before it leave", () => {
  const def = survey();
  const brief25 = "We want to understand how younger respondents choose between brands of soft drinks, and what makes them switch from one brand to another over time";
  assert.equal(brief25.split(/\s+/).length, 25);
  assert.equal(as(say(def, brief25), "model").category, null, "25 words is not a brief");
  assert.equal(as(say(def, `${brief25} today`), "model").category, "research_design", "26 words with research words is a brief");
  const edit = as(say(def, "Hide Q15 when Q3 = 2 because we want to understand whether respondents who identify as women answer the closing comments question in this study differently from the rest"), "refused");
  assert.equal(edit.category, "logic", "a long sentence that starts with an edit verb is read as the edit");
  assert.equal(as(say(def, "Create a survey for this research: we want to understand how younger respondents choose between brands of soft drinks and what makes them switch from one brand to another"), "model").category, "survey_creation");
  assert.deepEqual(as(say(def, "rename AGE to RESP_AGE and make RESP_AGE required"), "actions").actions, [{ op: "update_question", target: "Q1", variable: "RESP_AGE" }, { op: "update_question", target: "Q1", required: true }], "the second clause reads the survey the first one leaves");
  assert.match(as(say(def, "What depends on Q7 and make Q8 required"), "model").reason, /^a question and an edit in one sentence/);
  assert.equal(as(say(def, "Make Q2 required and delete Q99"), "refused").suggestion?.text, "Make Q2 required and delete Q9", "the suggestion is the whole sentence with the clause corrected");
});

test("compound sentences: a clause the survey already satisfies is left out (and said), not a refusal of the rest; a clause for the model anywhere hands on the whole", () => {
  const def = survey();
  const q2 = def.questions.find((x) => x.code === "Q2")!;
  q2.required = false;
  // "make Q2 optional" alone is "nothing to change" …
  const alone = as(say(def, "make Q2 optional"), "refused");
  assert.equal(alone.noop, true);
  assert.match(alone.reason, /already optional — nothing to change/);
  // … but beside a real edit it does not stop it: the block goes, Q2 is left as it is, and that is said
  const both = as(say(def, "Remove the Wrap up block and make Q2 optional"), "actions");
  assert.deepEqual(both.actions.map((a) => a.op), ["delete_block"]);
  assert.match(both.understood, /Left as it is: Q2 is already optional — nothing to change\.$/);
  assert.deepEqual(both.warnings?.slice(0, 1), ["Q2 is already optional — nothing to change."]);
  assert.deepEqual(applySurveyActions(def, both.actions).errors, []);
  // every clause already so: one "nothing to change" with each reason — still not an edit
  const none = as(say(def, "make Q2 optional and make Q1 optional"), "refused");
  assert.equal(none.noop, true);
  // a real refusal still refuses the whole …
  assert.match(as(say(def, "delete Q99 and make Q2 required"), "refused").reason, /Nothing else in the request was applied\.$/);
  // … unless a LATER clause is the model's: then the model takes the whole sentence (and its actions meet the same gate), as an earlier one would
  const later = say(def, "Show Q99 only when Q1 > 20 and add a question about brand trust after Q2");
  assert.equal(later.kind, "model", JSON.stringify(later));
  assert.equal(say(def, "add a question about brand trust after Q2 and show Q99 only when Q1 > 20").kind, "model");
});

test("a block is named by its title when that names it alone — so an edit to a block the open proposal created survives the proposal's replay (fresh ids)", () => {
  const base = survey();
  const step1: SurveyAction[] = [{ op: "create_block", title: "Trust" }, { op: "create_question", type: "rating", text: "How much do you trust influencers?", scale: { points: 5, low: "Not at all", high: "Completely" } } as SurveyAction];
  const once = applySurveyActions(base, step1).def;
  const del = as(say(once, "Remove the trust block"), "actions");
  assert.deepEqual(del.actions, [{ op: "delete_block", target: "Trust" }]);
  // the Studio re-evaluates the proposal from its base: the created block gets a new id, the title still finds it
  const replay = applySurveyActions(applySurveyActions(base, step1).def, del.actions);
  assert.deepEqual(replay.errors, []);
  assert.ok(!replay.def.questions.some((q) => q.text === "How much do you trust influencers?"));
  // a block titled like a question variable (Trust / TRUST) is still named by title where only a block can be meant …
  const withVar = applySurveyActions(base, [...step1.slice(0, 1), { ...(step1[1] as object), ref: "TRUST" } as SurveyAction]).def;
  assert.deepEqual(as(say(withVar, "Remove the trust block"), "actions").actions, [{ op: "delete_block", target: "Trust" }]);
  // … but by id where the target may be a question too (display logic): "Brands" is also the BRANDS variable
  const shown = as(say(base, "Show the Brands block only when Q1 > 18"), "actions").actions[0] as { target: string };
  assert.equal(shown.target, "b_brand");
});


test("a clause for the model after one the engine refuses still hands the whole sentence on; a block whose title another block shares is named by id", () => {
  const def = survey();
  const it = say(def, "Delete Q99 and reword Q2 to sound friendlier");
  assert.equal(it.kind, "model", "the later clause is the model's, so the refusal of the first does not decide");
  // …even with an ordinary edit between the refused clause and the model's
  assert.equal(say(def, "Delete Q99, make Q2 required and reword Q3 to sound friendlier").kind, "model");
  /* two blocks share a title: the title would be ambiguous on replay, so the action names the block by id */
  // the twin sits inside a randomizer, so only the count of blocks with that title — not the top-level flow — sees it
  const twin = survey();
  const flow = twin.flow as { id: string; type: string; title?: string; children?: unknown[] }[];
  const end = flow.findIndex((n) => n.id === "b_end");
  flow[end].title = "Usage";
  flow.splice(end, 1, { type: "randomizer", id: "r_end", children: [flow[end]] } as never);
  const del = say(twin, "delete the Usage block");
  if (del.kind === "actions") {
    const target = (del.actions[0] as { target: string }).target;
    assert.ok(target === "b_use" || target === "b_end", `an id, not the shared title: ${target}`);
  } else assert.ok(del.kind === "clarify" || del.kind === "refused", JSON.stringify(del));
  /* a unique title is used as the title (it survives a replay) */
  const one = as(say(def, "delete the Wrap up block"), "actions");
  assert.equal((one.actions[0] as { target: string }).target, "Wrap up");
});
