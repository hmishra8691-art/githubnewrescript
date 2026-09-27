import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond, type Question } from "@rescript/schema";
import { buildDependencyIndex, applyLogicProposal } from "@rescript/engine";
import { parseIntent, EXAMPLES } from "./grammar.ts";
import { planProposal, normaliseExpression, normaliseSetExpression, resolveTarget, variantForWords, type PlannerDeps } from "./proposal.ts";
import { surveyContext } from "./context.ts";

const survey = () =>
  SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Intelligent" },
    questions: [
      { id: "q_age", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
      { id: "q_type", code: "Q2", variableName: "TYPE", type: "single_select", text: "Type", options: [{ code: "A", label: "Consumer" }, { code: "B", label: "Business" }] },
      { id: "q_car", code: "Q3", variableName: "CAR", type: "single_select", text: "Do you own a car?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
      { id: "q_income", code: "Q4", variableName: "INCOME", type: "numeric", text: "Household income", displayLogic: cond.rule("q_car", "eq", 1) },
      { id: "q_end", code: "Q5", variableName: "E", type: "text", text: "Anything else?" },
    ],
    flow: [
      { type: "page", id: "p1", title: "Screener", questionIds: ["q_age", "q_type"] },
      { type: "block", id: "b_main", title: "Main", children: [
        { type: "page", id: "p2", questionIds: ["q_car", "q_income"] },
      ] },
      { type: "page", id: "p3", title: "Wrap up", questionIds: ["q_end"] },
      { type: "end", id: "e_ok", status: "complete" },
    ],
    deployment: { clientSlug: "c", studySlug: "s" },
  });

let n = 0;
const deps = (def: SurveyDefinition): PlannerDeps => ({
  uid: (p) => `${p}_${++n}`,
  makeQuestion: (d, variant) => ({
    id: `q_new_${++n}`, code: `Q${d.questions.length + 1}`, variableName: `Q${d.questions.length + 1}`,
    type: variant.startsWith("multi") ? "multi_select" : variant.startsWith("numeric") ? "numeric" : variant.startsWith("text") ? "open_text" : "single_select",
    variant, text: "", options: [], rows: [], columns: [], validation: [], required: false, settings: {}, skipLogic: [], listLogic: [],
  } as unknown as Question),
  index: buildDependencyIndex(def),
});

/* ---------------------------------------------------------------- grammar */

test("grammar: display logic in its everyday spellings", () => {
  assert.deepEqual(parseIntent("Show Q5 only when Q3 = Yes and Q4 > 2"), { kind: "display", target: "Q5", action: "show", expression: "Q3 = Yes and Q4 > 2" });
  assert.deepEqual(parseIntent("hide page 3 if Q2 is Business."), { kind: "display", target: "page 3", action: "hide", expression: "Q2 is Business" });
  assert.deepEqual(parseIntent("Don't show Q4 unless Q3 = Yes"), { kind: "display", target: "Q4", action: "hide", expression: "NOT (Q3 = Yes)" });
  assert.deepEqual(parseIntent("Q4 should only be shown when Q3 = 1"), { kind: "display", target: "Q4", action: "show", expression: "Q3 = 1" });
  assert.deepEqual(parseIntent("if Q3 = No then hide Q4"), { kind: "display", target: "Q4", action: "hide", expression: "Q3 = No" });
  assert.deepEqual(parseIntent("ask the income question only if Q3 = Yes"), { kind: "display", target: "the income question", action: "show", expression: "Q3 = Yes" });
});

test("grammar: skips, terminations, required, rename", () => {
  assert.deepEqual(parseIntent("After Q2, skip to Q5 when Q2 = B"), { kind: "skip", from: "Q2", to: "Q5", expression: "Q2 = B" });
  assert.deepEqual(parseIntent("skip to the end if Q1 > 99"), { kind: "skip", from: undefined, to: "the end", expression: "Q1 > 99" });
  assert.deepEqual(parseIntent("Screen out when Q1 < 18"), { kind: "skip", from: undefined, to: "screened", expression: "Q1 < 18" });
  assert.deepEqual(parseIntent("terminate the survey if Q2 is not answered"), { kind: "skip", from: undefined, to: "terminated", expression: "Q2 is not answered" });
  assert.deepEqual(parseIntent("if Q1 < 18, screen them out"), { kind: "skip", to: "screened", expression: "Q1 < 18" });
  assert.equal(parseIntent("skip to Q5").kind, "unknown", "a skip without a condition is refused, not guessed");
  assert.deepEqual(parseIntent("make Q4 required"), { kind: "required", target: "Q4", required: true });
  assert.deepEqual(parseIntent("Q4 is optional"), { kind: "required", target: "Q4", required: false });
  assert.deepEqual(parseIntent("set Q1 as not required"), { kind: "required", target: "Q1", required: false });
  assert.deepEqual(parseIntent("rename AGE to RESP_AGE"), { kind: "rename", target: "AGE", newName: "RESP_AGE" });
  assert.deepEqual(parseIntent("change Q1's variable name to AGE2"), { kind: "rename", target: "Q1", newName: "AGE2" });
});

test("grammar: adding a question, with type, text, options, position", () => {
  assert.deepEqual(parseIntent("Add a numeric question “How old are you?” after Q1"), { kind: "add_question", type: "numeric", text: "How old are you?", options: undefined, after: "Q1", required: undefined });
  assert.deepEqual(parseIntent("add a single choice question \"Do you own a car?\" with options Yes, No"), { kind: "add_question", type: "single choice", text: "Do you own a car?", options: ["Yes", "No"], after: undefined, required: undefined });
  assert.deepEqual(parseIntent("add a question after Q3: Which brands do you buy?"), { kind: "add_question", type: undefined, text: "Which brands do you buy?", options: undefined, after: "Q3", required: undefined });
  assert.deepEqual(parseIntent("Add a required multi-select question 'Which brands?' with options Coke, Pepsi and Fanta"), { kind: "add_question", type: "required multi-select", text: "'Which brands?'", options: ["Coke", "Pepsi", "Fanta"], after: undefined, required: undefined });
  assert.deepEqual(parseIntent("add a numeric question “Age?” after Q1, required"), { kind: "add_question", type: "numeric", text: "Age?", options: undefined, after: "Q1", required: true });
  assert.deepEqual(parseIntent("insert an email question"), { kind: "add_question", type: "email", text: "", options: undefined, after: undefined, required: undefined });
});

test("grammar: find and explain", () => {
  assert.deepEqual(parseIntent("What depends on Q3?"), { kind: "find", target: "Q3", relation: "usedBy" });
  assert.deepEqual(parseIntent("which questions use Q3"), { kind: "find", target: "Q3", relation: "usedBy" });
  assert.deepEqual(parseIntent("find everything that references AGE"), { kind: "find", target: "AGE", relation: "usedBy" });
  assert.deepEqual(parseIntent("what does Q4 depend on?"), { kind: "find", target: "Q4", relation: "dependsOn" });
  assert.deepEqual(parseIntent("what does Q3 affect"), { kind: "find", target: "Q3", relation: "affects" });
  assert.deepEqual(parseIntent("what can affect Q4?"), { kind: "find", target: "Q4", relation: "reach" });
  assert.deepEqual(parseIntent("explain Q4"), { kind: "explain", target: "Q4" });
  assert.deepEqual(parseIntent("why is Q4 shown?"), { kind: "explain", target: "Q4" });
  assert.equal(parseIntent("make me a sandwich").kind, "unknown");
  assert.equal(parseIntent("").kind, "unknown");
  for (const e of EXAMPLES) assert.notEqual(parseIntent(e.text).kind, "unknown", `example “${e.text}” must parse`);
});

/* ---------------------------------------------------------------- planner */

test("normaliseExpression bridges everyday operators to the parser's", () => {
  assert.equal(normaliseExpression("Q1 is at least 18 and Q3 was selected"), "Q1 >= 18 and Q3 selected");
  assert.equal(normaliseExpression("Q1 is greater than 2 or Q2 isn't Business."), "Q1 > 2 or Q2 is not Business");
  assert.equal(normaliseExpression("the answer to Q3 equals Yes"), "Q3 = Yes");
  assert.equal(normaliseExpression("Q2 = A"), "Q2 = A", "already-canonical text is untouched");
  assert.equal(normaliseExpression("Q4 = United States and Q3 >= 18"), 'Q4 = "United States" and Q3 >= 18', "a multi-word operand is quoted");
  assert.equal(normaliseExpression("Q2 is not Small business or Q1 > 2"), 'Q2 is not "Small business" or Q1 > 2');
  assert.equal(normaliseExpression('Q4 = "United States"'), 'Q4 = "United States"', "already quoted stays as it is");
});

test("resolveTarget finds questions by code, variable, text; pages and blocks by title and number", () => {
  const def = survey();
  assert.equal(resolveTarget(def, "Q3")?.id, "q_car");
  assert.equal(resolveTarget(def, "income")?.id, "q_income");
  assert.equal(resolveTarget(def, "the income question")?.id, "q_income");
  assert.equal(resolveTarget(def, "how old")?.id, "q_age");
  assert.deepEqual(resolveTarget(def, "page 3"), { kind: "page", id: "p3", label: "Wrap up" });
  assert.deepEqual(resolveTarget(def, "page Screener"), { kind: "page", id: "p1", label: "Screener" });
  assert.deepEqual(resolveTarget(def, "block Main"), { kind: "block", id: "b_main", label: "Main" });
  assert.equal(resolveTarget(def, "Q99"), null);
  assert.equal(variantForWords("multiple choice"), "multi_select.checkbox");
  assert.equal(variantForWords("numeric"), "numeric.open");
  assert.equal(variantForWords(undefined), "single_select.radio");
});

test("a display proposal carries the parsed condition three ways and validates before Apply is offered", () => {
  const def = survey();
  const p = planProposal(def, parseIntent("show Q5 only when Q3 is Yes and Q1 is at least 18"), "grammar", deps(def));
  assert.deepEqual(p.errors, []);
  assert.equal(p.summary, "Show Q5 only when (Q3 is “Yes” AND Q1 is at least “18”).");
  assert.equal(p.expression?.canonical, "Q3 = Yes AND Q1 >= 18");
  assert.equal(p.changes.length, 1);
  assert.equal(p.descriptions[0], "Show Q5 only when (Q3 is “Yes” AND Q1 is at least “18”).");
  assert.equal(p.targetKey, "question:q_end");
  assert.equal(p.readOnly, false);
  // nothing was written
  assert.equal(def.questions.find((q) => q.id === "q_end")!.displayLogic, undefined);
  // and applying is the engine's job
  const r = applyLogicProposal(def, p.changes);
  assert.equal(r.applied, 1);
  assert.ok(def.questions.find((q) => q.id === "q_end")!.displayLogic);
});

test("hide → NOT; a page target → display rule; a bad expression → errors, no changes", () => {
  const def = survey();
  const hide = planProposal(def, parseIntent("hide Q5 when Q2 = B"), "grammar", deps(def));
  assert.equal(hide.changes[0].kind, "set_display_logic");
  assert.equal(hide.expression?.canonical, "Q2 = B");
  assert.equal(hide.descriptions[0], "Show Q5 only when not Q2 is “Business”.");
  const page = planProposal(def, parseIntent("hide page 3 if Q2 is Business"), "grammar", deps(def));
  assert.equal(page.changes[0].kind, "add_display_rule");
  assert.match(page.descriptions[0], /^Hide page Wrap up when /);
  const bad = planProposal(def, parseIntent("show Q5 when Q77 = 1"), "grammar", deps(def));
  assert.ok(bad.errors.length >= 1);
  assert.equal(bad.changes.length, 0);
  const future = planProposal(def, parseIntent("show Q1 when Q5 answered"), "grammar", deps(def));
  assert.match(future.errors[0], /asked after/);
  assert.equal(future.changes.length, 1, "the change is built but blocked");
  const replace = planProposal(def, parseIntent("show Q4 when Q2 = A"), "grammar", deps(def));
  assert.match(replace.warnings[0], /already has display logic/);
  const unknown = planProposal(def, parseIntent("show Q9 when Q1 > 1"), "grammar", deps(def));
  assert.match(unknown.errors[0], /could not find “Q9”/);
});

test("a skip proposal lands on the triggering question and understands end / screen out", () => {
  const def = survey();
  const p = planProposal(def, parseIntent("skip to Q5 when Q3 = No"), "grammar", deps(def));
  assert.deepEqual(p.errors, []);
  assert.equal(p.changes[0].kind, "add_skip_rule");
  assert.equal((p.changes[0] as { questionId: string }).questionId, "q_car", "the rule sits on the last question the condition reads");
  assert.equal(p.summary, "After Q3, skip to Q5 when Q3 is “No”.");
  const two = planProposal(def, parseIntent("skip to Q5 when Q1 > 18 and Q3 = No"), "grammar", deps(def));
  assert.equal((two.changes[0] as { questionId: string }).questionId, "q_car", "the LAST question read, in flow order — by then every answer is known");
  const out = planProposal(def, parseIntent("screen out when Q1 < 18"), "grammar", deps(def));
  assert.deepEqual(out.errors, []);
  assert.match(out.descriptions[0], /skip out of the survey as screened when Q1 is less than “18”/);
  const end = planProposal(def, parseIntent("after Q2, go to the end if Q2 = B"), "grammar", deps(def));
  assert.deepEqual(end.errors, []);
  assert.match(end.descriptions[0], /^After Q2, skip to the end \(complete\)/);
  const back = planProposal(def, parseIntent("after Q3, skip to Q1 when Q3 = No"), "grammar", deps(def));
  assert.match(back.errors[0], /jump forward/);
});

test("required, rename and add-question proposals", () => {
  const def = survey();
  const req = planProposal(def, parseIntent("make Q4 required"), "grammar", deps(def));
  assert.deepEqual(req.descriptions, ["Make Q4 required."]);
  const again = planProposal(def, parseIntent("Q1 is optional"), "grammar", deps(def));
  assert.match(again.warnings[0], /already optional/);
  const ren = planProposal(def, parseIntent("rename AGE to RESP_AGE"), "grammar", deps(def));
  assert.deepEqual(ren.errors, []);
  assert.equal(ren.summary, "Rename AGE to RESP_AGE.");
  const badRen = planProposal(def, parseIntent("rename Q1 to TYPE"), "grammar", deps(def));
  assert.ok(badRen.errors.length >= 1, "renaming onto a taken name is refused by the engine's rename");

  const add = planProposal(def, parseIntent("add a single choice question “Do you rent?” after Q3 with options Yes, No"), "grammar", deps(def));
  assert.deepEqual(add.errors, []);
  const ch = add.changes[0];
  assert.equal(ch.kind, "add_question");
  if (ch.kind !== "add_question") return;
  assert.equal(ch.question.text, "Do you rent?");
  assert.deepEqual(ch.question.options.map((o) => o.label), ["Yes", "No"]);
  assert.deepEqual(ch.at, { pageId: "p2", index: 1 });
  assert.match(add.summary, /^Add Q6 after Q3: “Do you rent\?”/);
  const bare = planProposal(def, parseIntent("add a single select question"), "grammar", deps(def));
  assert.ok(bare.warnings.some((w) => /no text/.test(w)) && bare.warnings.some((w) => /No options/.test(w)));
});

test("find and explain answer from the dependency index and never propose changes", () => {
  const def = survey();
  const f = planProposal(def, parseIntent("what depends on Q3?"), "grammar", deps(def));
  assert.equal(f.readOnly, true);
  assert.deepEqual(f.changes, []);
  assert.deepEqual(f.answer?.map((a) => a.key), ["question:q_income"]);
  assert.equal(f.summary, "1 object depend on Q3.".replace("depend", "depend"));
  const d = planProposal(def, parseIntent("what does Q4 depend on"), "grammar", deps(def));
  assert.deepEqual(d.answer?.map((a) => a.text), ["Q3"]);
  const none = planProposal(def, parseIntent("what depends on Q5"), "grammar", deps(def));
  assert.equal(none.summary, "Nothing depends on Q5.");
  const e = planProposal(def, parseIntent("explain Q4"), "grammar", deps(def));
  assert.equal(e.readOnly, true);
  assert.ok(e.answer!.some((l) => /Shown when Q3 is “Yes”/.test(l.text)));
  assert.ok(e.answer!.some((l) => /It reads: Q3/.test(l.text)));
  const u = planProposal(def, parseIntent("make me a sandwich"), "grammar", deps(def));
  assert.equal(u.errors.length, 1);
});

/* ---------------------------------------------------------------- context */

test("surveyContext lists questions in flow order with options and logic, bounded", () => {
  const def = survey();
  const c = surveyContext(def, { selectedId: "q_car" });
  assert.match(c, /^Survey: Intelligent \(5 questions\)/);
  assert.match(c, /## Page 1: Screener \[p1\]/);
  assert.match(c, /Q3 \(CAR\) · single select · "Do you own a car\?" · options: 1=Yes, 2=No · ← selected/);
  assert.match(c, /Q4 \(INCOME\) · numeric · "Household income" · shown when Q3 is “Yes”/);
  assert.ok(c.indexOf("Q1 (AGE)") < c.indexOf("Q3 (CAR)") && c.indexOf("Q3 (CAR)") < c.indexOf("Q5 (E)"));
  const big = SurveyDefinition.parse({
    meta: { id: "b", code: "B", title: "Big" },
    questions: Array.from({ length: 30 }, (_, i) => ({ id: `q${i + 1}`, code: `Q${i + 1}`, variableName: `V${i + 1}`, type: "numeric", text: `Question ${i + 1}` })),
    flow: [{ type: "page", id: "p", questionIds: Array.from({ length: 30 }, (_, i) => `q${i + 1}`) }],
    deployment: { clientSlug: "c", studySlug: "s" },
  });
  const tight = surveyContext(big, { limit: 3, selectedId: "q20" });
  assert.match(tight, /Q3 \(V3\)/, "the first `limit` in full");
  assert.doesNotMatch(tight, /Q10 \(V10\)/, "beyond it, code only");
  assert.match(tight, /Q20 \(V20\) · numeric · "Question 20" · ← selected/, "the selected question is always in full");
  assert.match(tight, /Q15 \(V15\)/, "and its neighbours");
  assert.match(tight, /Other questions \(by code\): Q4, Q5, .*Q14, Q26, .*Q30/);
});

/* --------------------------------------------------------------- the model */

test("coerceIntent admits only the shapes the planner knows", async () => {
  const { coerceIntent, logicUserPrompt, LOGIC_SYSTEM_PROMPT } = await import("./ai.ts");
  assert.deepEqual(coerceIntent({ kind: "display", target: "Q5", action: "hide", expression: "Q3 = No" }), { kind: "display", target: "Q5", action: "hide", expression: "Q3 = No" });
  assert.deepEqual(coerceIntent({ kind: "display", target: "Q5", action: "nonsense", expression: "Q3 = No" })?.kind === "display" && (coerceIntent({ kind: "display", target: "Q5", action: "nonsense", expression: "Q3 = No" }) as { action: string }).action, "show", "an unknown action falls back to show, never to a write");
  assert.equal(coerceIntent({ kind: "display", target: "Q5" }), null, "no expression, no intent");
  assert.equal(coerceIntent({}), null, "the fake provider's empty object is not an intent");
  assert.equal(coerceIntent({ kind: "delete_everything" }), null);
  assert.equal(coerceIntent({ kind: "rename", target: "Q1", newName: "1bad" }), null, "an unusable name is refused before the engine sees it");
  assert.deepEqual(coerceIntent({ kind: "find", target: "Q3", relation: "affects" }), { kind: "find", target: "Q3", relation: "affects" });
  assert.equal(coerceIntent({ kind: "find", target: "Q3", relation: "everything" }), null);
  assert.deepEqual(coerceIntent({ kind: "add_question", type: "numeric", text: " Age? ", options: ["", "A", 3], required: "yes" }), { kind: "add_question", type: "numeric", text: "Age?", options: ["A"], after: undefined, required: undefined });
  assert.deepEqual(coerceIntent({ kind: "unknown" }), { kind: "unknown", reason: "I did not understand that." });
  assert.match(logicUserPrompt("CTX", " show Q5 ", "Q3"), /^CTX\n\nSelected: Q3\nSentence: show Q5$/);
  assert.match(LOGIC_SYSTEM_PROMPT, /Never invent codes/);
  // every shape the prompt promises, the coercer accepts
  for (const k of ["display", "skip", "required", "add_question", "rename", "find", "explain", "unknown"]) assert.match(LOGIC_SYSTEM_PROMPT, new RegExp(`"kind":"${k}"`));
});

/* ------------------------------------------------- validation + masking (round 2) */

const survey2 = () =>
  SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Round 2" },
    questions: [
      { id: "q_age", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
      { id: "q_email", code: "Q2", variableName: "EMAIL", type: "open_text", text: "Your email" },
      { id: "q_brands", code: "Q3", variableName: "BRANDS", type: "multi_select", text: "Which brands?", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }, { code: 3, label: "C" }, { code: 4, label: "D" }] },
      { id: "q_used", code: "Q4", variableName: "USED", type: "multi_select", text: "Used?", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }, { code: 3, label: "C" }, { code: 4, label: "D" }] },
      { id: "q_best", code: "Q5", variableName: "BEST", type: "single_select", text: "Best brand", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }, { code: 3, label: "C" }, { code: 4, label: "D" }] },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q_age", "q_email", "q_brands", "q_used", "q_best"] }, { type: "end", id: "e", status: "complete" }],
    deployment: { clientSlug: "c", studySlug: "s" },
  });

test("grammar: validation in its everyday spellings maps onto the engine's rule kinds", () => {
  assert.deepEqual(parseIntent("Q1 must be between 18 and 99"), { kind: "validation", target: "Q1", rules: [{ kind: "min_value", value: 18 }, { kind: "max_value", value: 99 }] });
  assert.deepEqual(parseIntent("make Q1 between 18 and 99"), { kind: "validation", target: "Q1", rules: [{ kind: "min_value", value: 18 }, { kind: "max_value", value: 99 }] });
  assert.deepEqual(parseIntent("Q1 is at least 18"), { kind: "validation", target: "Q1", rules: [{ kind: "min_value", value: 18 }] });
  assert.deepEqual(parseIntent("Q1 must be at most 120"), { kind: "validation", target: "Q1", rules: [{ kind: "max_value", value: 120 }] });
  assert.deepEqual(parseIntent("set the maximum for Q1 to 99"), { kind: "validation", target: "Q1", rules: [{ kind: "max_value", value: 99 }] });
  assert.deepEqual(parseIntent("limit Q2 to 120 characters"), { kind: "validation", target: "Q2", rules: [{ kind: "max_length", value: 120 }] });
  assert.deepEqual(parseIntent("Q2 must be at least 10 characters long"), { kind: "validation", target: "Q2", rules: [{ kind: "min_length", value: 10 }] });
  assert.deepEqual(parseIntent("Q2 between 5 and 50 characters"), { kind: "validation", target: "Q2", rules: [{ kind: "min_length", value: 5 }, { kind: "max_length", value: 50 }] });
  assert.deepEqual(parseIntent("Q2 must be an email address"), { kind: "validation", target: "Q2", rules: [{ kind: "email" }] });
  assert.deepEqual(parseIntent("validate Q2 as a phone number"), { kind: "validation", target: "Q2", rules: [{ kind: "phone" }] });
  assert.deepEqual(parseIntent("Q1 must be a whole number"), { kind: "validation", target: "Q1", rules: [{ kind: "integer" }] });
  assert.deepEqual(parseIntent("require at least 2 selections on Q3"), { kind: "validation", target: "Q3", rules: [{ kind: "min_selections", value: 2 }] });
  assert.deepEqual(parseIntent("allow at most 3 options for Q3"), { kind: "validation", target: "Q3", rules: [{ kind: "max_selections", value: 3 }] });
  assert.deepEqual(parseIntent("Q3 allows at most 3 selections"), { kind: "validation", target: "Q3", rules: [{ kind: "max_selections", value: 3 }] });
  assert.deepEqual(parseIntent("Q3 must have at least 2 options selected"), { kind: "validation", target: "Q3", rules: [{ kind: "min_selections", value: 2 }] });
  assert.deepEqual(parseIntent("Q3 between 1 and 3 selections"), { kind: "validation", target: "Q3", rules: [{ kind: "min_selections", value: 1 }, { kind: "max_selections", value: 3 }] });
  assert.deepEqual(parseIntent("Q2 must match the pattern ^[A-Z]{3}\\d+$"), { kind: "validation", target: "Q2", rules: [{ kind: "pattern", value: "^[A-Z]{3}\\d+$" }] });
  assert.deepEqual(parseIntent("clear validation on Q1"), { kind: "clear_validation", target: "Q1" });
  assert.deepEqual(parseIntent("remove the maximum rule from Q1"), { kind: "clear_validation", target: "Q1", kinds: ["max_value", "max_length", "max_selections"] });
  // a validation sentence never steals a logic sentence
  assert.equal(parseIntent("show Q5 only when Q3 is Yes and Q1 is at least 18").kind, "display");
  assert.equal(parseIntent("skip to Q5 when Q1 is at least 18").kind, "skip");
});

test("grammar: masking sentences become set expressions", () => {
  assert.deepEqual(parseIntent("At Q5 show only the options selected in Q3"), { kind: "mask", target: "Q5", expression: "selected in Q3", action: "display" });
  assert.deepEqual(parseIntent("show only the options selected in Q3 at Q5"), { kind: "mask", target: "Q5", expression: "selected in Q3", action: "display" });
  assert.deepEqual(parseIntent("mask Q5 by Q3.Selected AND Q4.Selected"), { kind: "mask", target: "Q5", expression: "Q3.Selected AND Q4.Selected", action: "display" });
  assert.deepEqual(parseIntent("hide the options selected in Q3 from Q5"), { kind: "mask", target: "Q5", expression: "selected in Q3", action: "remove" });
  assert.deepEqual(parseIntent("carry forward the selected options from Q3 to Q5"), { kind: "mask", target: "Q5", expression: "Q3.Selected", action: "display" });
  assert.deepEqual(parseIntent("carry Q3 to Q5"), { kind: "mask", target: "Q5", expression: "Q3.Selected", action: "display" });
  assert.deepEqual(parseIntent("remove the mask from Q5"), { kind: "clear_mask", target: "Q5" });
  assert.equal(parseIntent("limit Q2 to 120 characters").kind, "validation", "‘limit … to N characters’ is validation, not a mask");
  for (const e of EXAMPLES) assert.notEqual(parseIntent(e.text).kind, "unknown", `example “${e.text}” must parse`);
});

test("normaliseSetExpression turns words into the mask language", () => {
  const def = survey2();
  assert.equal(normaliseSetExpression(def, "selected in Q3"), "Q3.Selected");
  assert.equal(normaliseSetExpression(def, "the options selected in Q3 and Q4"), "Q3.Selected AND Q4.Selected");
  assert.equal(normaliseSetExpression(def, "options not selected in Q3"), "Q3.Unselected");
  assert.equal(normaliseSetExpression(def, "Q3 but not Q4"), "Q3.Selected MINUS Q4.Selected");
  assert.equal(normaliseSetExpression(def, "BRANDS or USED"), "Q3.Selected OR Q4.Selected", "variable names resolve to codes");
  assert.equal(normaliseSetExpression(def, "Q3.Selected AND Q4.Selected"), "Q3.Selected AND Q4.Selected", "the language passes through");
  assert.equal(normaliseSetExpression(def, "NOT Q3.Selected"), "NOT Q3.Selected");
});

test("validation and mask proposals go through the engine's validation before Apply", () => {
  const def = survey2();
  const v = planProposal(def, parseIntent("Q1 must be between 18 and 99"), "grammar", deps(def));
  assert.deepEqual(v.errors, []);
  assert.equal(v.summary, "Validate Q1: at least 18, at most 99.");
  assert.equal(v.changes[0].kind, "set_validation");
  assert.equal(v.targetKey, "question:q_age");
  const bad = planProposal(def, parseIntent("Q2 must be between 18 and 99"), "grammar", deps(def));
  assert.match(bad.errors[0], /not numeric/);
  applyLogicProposal(def, v.changes);
  const again = planProposal(def, parseIntent("Q1 is at least 21"), "grammar", deps(def));
  assert.match(again.warnings[0], /already has a minimum value rule \(18\); this replaces it/);
  const sel = planProposal(def, parseIntent("allow at most 9 options for Q3"), "grammar", deps(def));
  assert.match(sel.errors[0], /only 4 options/);
  const clear = planProposal(def, parseIntent("clear validation on Q1"), "grammar", deps(def));
  assert.equal(clear.summary, "Remove every validation rule from Q1.");

  const m = planProposal(def, parseIntent("At Q5 show only the options selected in Q3"), "grammar", deps(def));
  assert.deepEqual(m.errors, []);
  assert.equal(m.summary, "Show at Q5 only the options Q3.Selected.");
  assert.equal(m.expression?.canonical, "Q3.Selected");
  assert.equal(m.changes[0].kind, "set_mask");
  const both = planProposal(def, parseIntent("show only the options selected in Q3 and Q4 at Q5"), "grammar", deps(def));
  assert.deepEqual(both.errors, []);
  assert.equal(both.expression?.canonical, "Q3.Selected INTERSECTION Q4.Selected");
  const future = planProposal(def, parseIntent("at Q3 show only the options selected in Q5"), "grammar", deps(def));
  assert.match(future.errors[0], /asked after/);
  const junk = planProposal(def, parseIntent("mask Q5 by Q3 selected wrongly"), "grammar", deps(def));
  assert.ok(junk.errors.length >= 1 && junk.changes.length === 0, "a set expression the parser refuses proposes nothing");
  applyLogicProposal(def, m.changes);
  assert.equal(def.questions.find((q) => q.id === "q_best")!.mask?.action, "display");
  const rep = planProposal(def, parseIntent("mask Q5 by Q4"), "grammar", deps(def));
  assert.match(rep.warnings[0], /already has a mask \(Q3\.Selected\); this replaces it/);
  const hide = planProposal(def, parseIntent("hide the options selected in Q3 from Q5"), "grammar", deps(def));
  assert.equal(hide.summary, "Remove from Q5 the options Q3.Selected.", "hide is the remove action, not display");
  const cm = planProposal(def, parseIntent("remove the mask from Q5"), "grammar", deps(def));
  assert.equal(cm.summary, "Remove the option mask from Q5.");
  // the context serializer says what is there, so the model can see it
  const ctx = surveyContext(def, {});
  assert.match(ctx, /Q1 \(AGE\) · numeric · "How old are you\?" · validation: min value 18, max value 99/);
  assert.match(ctx, /Q5 \(BEST\) .* · mask: display Q3\.Selected/);
});

test("coerceIntent admits the new shapes and drops what it does not know", async () => {
  const { coerceIntent } = await import("./ai.ts");
  assert.deepEqual(coerceIntent({ kind: "validation", target: "Q1", rules: [{ kind: "min_value", value: "18" }, { kind: "email" }, { kind: "bogus", value: 1 }, "x"] }), { kind: "validation", target: "Q1", rules: [{ kind: "min_value", value: 18 }, { kind: "email" }] });
  assert.equal(coerceIntent({ kind: "validation", target: "Q1", rules: [{ kind: "bogus" }] }), null, "no usable rule, no intent");
  assert.deepEqual(coerceIntent({ kind: "validation", target: "Q2", rules: [{ kind: "pattern", value: "123" }] }), { kind: "validation", target: "Q2", rules: [{ kind: "pattern", value: "123" }] }, "a pattern stays text even when it looks numeric");
  assert.deepEqual(coerceIntent({ kind: "clear_validation", target: "Q1", kinds: ["max_value", "nope"] }), { kind: "clear_validation", target: "Q1", kinds: ["max_value"] });
  assert.deepEqual(coerceIntent({ kind: "mask", target: "Q5", expression: "Q3.Selected", action: "nonsense" }), { kind: "mask", target: "Q5", expression: "Q3.Selected", action: "display" });
  assert.equal(coerceIntent({ kind: "mask", target: "Q5" }), null);
  assert.deepEqual(coerceIntent({ kind: "clear_mask", target: "Q5" }), { kind: "clear_mask", target: "Q5" });
});

/* ------------------------------------------------ UI upgrade: structure, context, screening (§17, §22–§24) */

test("grammar: page breaks, embedded variables, hidden variables, loops, screening", () => {
  assert.deepEqual(parseIntent("Add a page break after Q10"), { kind: "page_break", target: "Q10", action: "add" });
  assert.deepEqual(parseIntent("add a page break after this question"), { kind: "page_break", target: "this question", action: "add" });
  assert.deepEqual(parseIntent("Remove the page break after Q10"), { kind: "page_break", target: "Q10", action: "remove" });
  assert.deepEqual(parseIntent("Put Q11 on a new page"), { kind: "page_break", target: "Q11", action: "add", before: true });
  assert.deepEqual(parseIntent("Create an embedded variable called country and set it to India"), { kind: "embedded", name: "country", source: "static", value: "India" });
  assert.deepEqual(parseIntent("add embedded data WAVE from the url"), { kind: "embedded", name: "WAVE", source: "url" });
  assert.deepEqual(parseIntent("Add a hidden variable for respondent type"), { kind: "add_question", type: "hidden", text: "respondent type", after: undefined });
  assert.deepEqual(parseIntent("Create a loop around Q5 to Q8 for each brand"), { kind: "loop", from: "Q5", to: "Q8", loopVar: "brand" });
  assert.deepEqual(parseIntent("loop Q3 through Q4"), { kind: "loop", from: "Q3", to: "Q4" });
  assert.deepEqual(parseIntent("Explain why respondents are screened out"), { kind: "screening" });
  assert.deepEqual(parseIntent("why is this respondent being screened out?"), { kind: "screening" });
  // the sentences the brief spells out
  assert.deepEqual(parseIntent("Show Q10 only when Q5 option 3 is selected."), { kind: "display", target: "Q10", action: "show", expression: "Q5 option 3 is selected" });
  assert.equal(normaliseExpression("Q5 option 3 is selected"), "Q5 = 3");
  assert.equal(normaliseExpression("Q4 is option 2"), "Q4 = 2");
  assert.deepEqual(parseIntent("Make this question mandatory"), { kind: "required", target: "this question", required: true });
  assert.deepEqual(parseIntent("If Q5 is option 2, skip Q6 and Q7 and go directly to Q8"), { kind: "skip", to: "Q6 and Q7 and go directly to Q8", expression: "Q5 is option 2" });
  assert.deepEqual(parseIntent("Show this block only for respondents who selected option 3"), { kind: "display", target: "this block", action: "show", expression: "selected option 3" });
  assert.ok(EXAMPLES.some((e) => /page break/.test(e.text)) && EXAMPLES.some((e) => /embedded/.test(e.text)) && EXAMPLES.some((e) => /loop/.test(e.text)));
});

test("the selection is the context: “this question”, “it”, “this block” resolve against the selected question (§17)", () => {
  const def = survey();
  assert.equal(resolveTarget(def, "this question", "q_income")?.id, "q_income");
  assert.equal(resolveTarget(def, "it", "q_income")?.id, "q_income");
  assert.equal(resolveTarget(def, "the selected question", "q_income")?.id, "q_income");
  assert.equal(resolveTarget(def, "this question", null), null, "nothing selected → nothing meant");
  const blk = resolveTarget(def, "this block", "q_income");
  assert.deepEqual(blk && [blk.kind, blk.id], ["block", "b_main"]);
  const pg = resolveTarget(def, "this page", "q_age");
  assert.deepEqual(pg && [pg.kind, pg.id], ["page", "p1"]);
  const d = { ...deps(def), selectedId: "q_income" };
  const p = planProposal(def, parseIntent("Make this question mandatory"), "grammar", d);
  assert.deepEqual(p.changes, [{ kind: "set_required", questionId: "q_income", required: true }]);
  const p2 = planProposal(def, parseIntent("Show this block only when Q3 = Yes"), "grammar", d);
  assert.equal(p2.changes[0].kind, "add_display_rule");
  assert.deepEqual((p2.changes[0] as { rule: { target: unknown } }).rule.target, { kind: "block", ref: "b_main" });
  assert.deepEqual(p2.errors, []);
});

test("a skip past several questions lands on the destination after “go to”", () => {
  const def = survey();
  const p = planProposal(def, parseIntent("If Q2 is option A, skip Q3 and Q4 and go directly to Q5"), "grammar", deps(def));
  assert.deepEqual(p.errors, []);
  const c = p.changes[0] as { kind: string; questionId: string; rule: { target: { kind: string; ref?: string } } };
  assert.equal(c.kind, "add_skip_rule"); assert.equal(c.questionId, "q_type");
  assert.deepEqual(c.rule.target, { kind: "question", ref: "q_end" });
  assert.match(p.summary, /After Q2, skip to Q5 when Q2 is “Consumer”/);
});

test("structure proposals: page break, embedded variable, hidden variable, loop — validated, described, applied through the engine", () => {
  const def = survey();
  const d = deps(def);
  const brk = planProposal(def, parseIntent("Add a page break after Q1"), "grammar", d);
  assert.deepEqual(brk.errors, []);
  assert.equal(brk.changes[0].kind, "add_page_break");
  assert.match(brk.summary, /after Q1 in Block 1 · Screener — Q2 move to a new page/);
  const before = planProposal(def, parseIntent("Put Q2 on a new page"), "grammar", d);
  assert.deepEqual(before.changes, brk.changes.map((c) => ({ ...c, pageId: (before.changes[0] as { pageId: string }).pageId })), "a break before Q2 is the break after Q1");
  assert.deepEqual(planProposal(def, parseIntent("Put Q1 on a new page"), "grammar", d).errors, ["Q1 already starts its page."]);
  assert.deepEqual(planProposal(def, parseIntent("Add a page break after Q2"), "grammar", d).errors, ["Q2 is the last question of its block — the block ends there."]);
  const rm = planProposal(def, parseIntent("Remove the page break after Q1"), "grammar", d);
  assert.deepEqual(rm.errors, ["There is no page break after Q1."]);
  const r = applyLogicProposal(def, brk.changes);
  assert.deepEqual(r.errors, []);
  assert.equal(def.flow[0].type, "block");
  assert.deepEqual(planProposal(def, parseIntent("Remove the page break after Q1"), "grammar", d).errors, []);

  const emb = planProposal(def, parseIntent("Create an embedded variable called country and set it to India"), "grammar", d);
  assert.deepEqual(emb.errors, []);
  assert.equal(emb.summary, "Create the embedded variable country, set to “India”.");
  assert.deepEqual(applyLogicProposal(def, emb.changes).errors, []);
  assert.equal((def.flow[0] as { type: string }).type, "embedded_data");
  assert.deepEqual(planProposal(def, parseIntent("add embedded data country"), "grammar", d).errors, ["An embedded variable country already exists."]);
  const url = planProposal(def, parseIntent("add embedded data WAVE from the url"), "grammar", d);
  assert.deepEqual(url.errors, []); assert.match(url.warnings[0] ?? "", /read from the survey URL/);

  const hid = planProposal(def, parseIntent("Add a hidden variable for respondent type"), "grammar", d);
  assert.deepEqual(hid.errors, []);
  const hq = (hid.changes[0] as { question: Question }).question;
  assert.equal(hq.variant, "calculated.hidden");
  assert.equal(hq.variableName, "RESPONDENT_TYPE", "named by what it is for");
  assert.equal(hq.text, "");
  assert.match(hid.summary, /Add the hidden variable RESPONDENT_TYPE/);
  assert.ok(!hid.warnings.some((w) => /no text/.test(w)), "a hidden variable has no text to complain about");
  assert.equal(variantForWords("hidden"), "calculated.hidden");

  const loop = planProposal(def, parseIntent("Create a loop around Q3 to Q4 for each brand"), "grammar", d);
  assert.deepEqual(loop.errors, []);
  assert.equal(loop.summary, "Repeat Q3 to Q4 (2 questions) in a loop — once per brand; choose the items in Studio.");
  assert.match(loop.warnings[0], /no items/);
  assert.deepEqual(planProposal(def, parseIntent("loop Q2 through Q3"), "grammar", d).errors, ["Q2 and Q3 are on different pages — a loop wraps questions on one page."]);
  assert.deepEqual(applyLogicProposal(def, loop.changes).errors, []);
  assert.ok(def.flow.some((n) => n.type === "loop" && (n as { loopVar: string }).loopVar === "brand"));
});

test("screening is answered from every skip that terminates and every non-complete end, read-only", () => {
  const def = survey();
  def.questions[0].skipLogic = [{ id: "s1", label: "under 18", when: cond.rule("q_age", "lt", 18), target: { kind: "terminate", status: "screened" } }];
  def.flow.push({ type: "end", id: "e_q", status: "quota_full" } as never);
  const p = planProposal(def, parseIntent("Explain why respondents are screened out"), "grammar", deps(def));
  assert.equal(p.readOnly, true);
  assert.equal(p.changes.length, 0);
  assert.match(p.summary, /2 ways/);
  assert.match(p.answer![0].text, /^Q1: when Q1 is less than .*→ terminated as screened \(under 18\)/);
  assert.equal(p.answer![0].key, "question:q_age");
  assert.match(p.answer![1].text, /ends as quota full/);
  const none = planProposal(survey(), parseIntent("Explain why respondents are screened out"), "grammar", deps(survey()));
  assert.match(none.summary, /Nothing screens anyone out/);
});

test("the context lists blocks, embedded variables, hidden variables, loops and quotas by id and name (§23)", () => {
  const def = survey();
  (def.flow as unknown[]).unshift({ type: "embedded_data", id: "ed", fields: [{ name: "PANEL_ID", source: "url" }] });
  def.questions.push({ id: "h1", code: "H1", variableName: "SEGMENT", type: "hidden", text: "", options: [] } as never);
  const ctx = surveyContext(def);
  assert.match(ctx, /Blocks: Block 1 “Screener” \[p1\] 1 page; Block 2 “Main” \[b_main\] 1 page/);
  assert.match(ctx, /Embedded variables: PANEL_ID/);
  assert.match(ctx, /Hidden \/ calculated variables: H1 \(SEGMENT\)/);
});

test("coerceIntent admits the structure shapes and normalises their fields", async () => {
  const { coerceIntent } = await import("./ai.ts");
  assert.deepEqual(coerceIntent({ kind: "page_break", target: "Q10", action: "add" }), { kind: "page_break", target: "Q10", action: "add" });
  assert.deepEqual(coerceIntent({ kind: "page_break", target: "Q11", action: "nonsense", before: true }), { kind: "page_break", target: "Q11", action: "add", before: true });
  assert.equal(coerceIntent({ kind: "page_break" }), null);
  assert.deepEqual(coerceIntent({ kind: "embedded", name: "country", source: "static", value: "India", dataType: "bogus" }), { kind: "embedded", name: "country", source: "static", value: "India" });
  assert.deepEqual(coerceIntent({ kind: "loop", from: "Q5", to: "Q8", loopVar: "brand" }), { kind: "loop", from: "Q5", to: "Q8", loopVar: "brand" });
  assert.equal(coerceIntent({ kind: "loop", from: "Q5" }), null);
  assert.deepEqual(coerceIntent({ kind: "screening" }), { kind: "screening" });
});

/* ------------------------------------------------ diagnose: "why is Q25 not showing?" (import brief §31) */

test("grammar: why is it not showing / unreachable / can't respondents see it → diagnose; why is it shown stays explain", () => {
  const D = (target: string) => ({ kind: "diagnose", target });
  assert.deepEqual(parseIntent("Why is Q25 not showing?"), D("Q25"));
  assert.deepEqual(parseIntent("why isn't Q25 showing up"), D("Q25"));
  assert.deepEqual(parseIntent("Why does Q12 never appear to respondents?"), D("Q12"));
  assert.deepEqual(parseIntent("Why is Q20 unreachable?"), D("Q20"));
  assert.deepEqual(parseIntent("why is the income question always skipped"), D("the income question"));
  assert.deepEqual(parseIntent("Why can't respondents see Q4?"), D("Q4"));
  assert.deepEqual(parseIntent("Is Q4 reachable?"), D("Q4"));
  assert.deepEqual(parseIntent("debug this question"), D("this question"));
  assert.deepEqual(parseIntent("why is Q4 shown?"), { kind: "explain", target: "Q4" }, "the positive question is still an explanation");
});

test("diagnose: the answer names every reason, certain ones first-class, and never offers Apply", () => {
  const def = survey();
  let p = planProposal(def, parseIntent("Why is Q4 not showing?"), "grammar", deps(def));
  assert.equal(p.readOnly, true);
  assert.equal(p.changes.length, 0);
  assert.match(p.summary, /Q4 is shown only to some respondents/);
  assert.ok(p.answer!.some((l) => /^Only when: It is shown only when Q3/.test(l.text)), JSON.stringify(p.answer));
  // make it impossible: it reads Q5, which comes after it
  def.questions[3].displayLogic = cond.rule("q_end", "answered");
  p = planProposal(def, parseIntent("Why is Q4 unreachable?"), "grammar", deps(def));
  assert.match(p.summary, /Q4 can never be shown: its display logic .* reads Q5, which comes after it/);
  assert.ok(p.answer!.some((l) => l.text.startsWith("Never:")));
  // an earlier unconditional skip to the end
  const d2 = survey();
  d2.questions[2].skipLogic = [{ id: "s", when: { type: "group", op: "and", children: [] }, target: { kind: "end", status: "complete" } }] as never;
  p = planProposal(d2, parseIntent("why can't respondents see Q5"), "grammar", deps(d2));
  assert.match(p.summary, /Q5 can never be shown/);
  assert.ok(p.answer!.some((l) => /Q3 always skips to the end, past Q5/.test(l.text) && l.key === "question:q_car"), "the line links to the question that does it");
  assert.equal(planProposal(def, parseIntent("why is Q99 not showing"), "grammar", deps(def)).errors.length, 1);
});
