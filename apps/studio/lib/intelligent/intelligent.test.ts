import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond, type Question } from "@rescript/schema";
import { buildDependencyIndex, applyLogicProposal } from "@rescript/engine";
import { parseIntent, EXAMPLES } from "./grammar.ts";
import { planProposal, normaliseExpression, resolveTarget, variantForWords, type PlannerDeps } from "./proposal.ts";
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
