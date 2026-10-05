import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, type SurveyAction } from "./surveyActions.js";
import { parseLogicExpression, formatCondition, referenceTree } from "./logicExpression.js";
import { evaluateCondition } from "./evaluate.js";
import { canonicalizeCondition, canonicalizeSurveyConditions, normalizeOptionText, resolveOptionValue } from "./optionCodes.js";
import { parsePunchExpression, formatPunchExpression } from "./autoPunch.js";
import { createResponseState } from "./state.js";
import { start, advance as next, setAnswer } from "./flow.js";

/**
 * CONDITIONS COMPARE OPTION CODES. "Q3 = Option 1" is `Q3 = 1` everywhere —
 * typed, picked, written by a model, stored, printed, evaluated — never the
 * option's text, never a placeholder like "__Yes__".
 */
let n = 0;
const ids = (p: string) => `${p}_${++n}`;
const survey = () => {
  const r = applySurveyActions(SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Codes" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }] }), [
    { op: "create_block", title: "One" },
    { op: "create_question", ref: "AGE", type: "numeric", text: "Age?" },
    { op: "create_question", ref: "Q3V", type: "single", text: "Do you agree?", options: ["Yes", "No", "Maybe"] },
    { op: "create_question", ref: "BRANDS", type: "multi", text: "Which brands?", options: ["Coke", "Pepsi", { label: "Other", other: true }] },
    { op: "create_question", ref: "CITY", type: "text", text: "Your city?" },
    { op: "create_block", title: "Two", },
    { op: "create_question", ref: "FOLLOW", type: "text", text: "Why do you agree?", newPage: true },
    { op: "create_question", ref: "SEG", type: "single", text: "Segment (hidden)", options: ["Fans", "Others"] },
    { op: "create_question", ref: "SCORE", type: "numeric", text: "Score (hidden)" },
  ] as SurveyAction[], { ids });
  assert.deepEqual(r.errors, []);
  const d = r.def;
  for (const q of d.questions) if (q.variableName === "SEG" || q.variableName === "SCORE") q.settings.hidden = true;
  return d;
};
const byVar = (d: SurveyDefinition, v: string) => d.questions.find((q) => q.variableName === v)!;
const parse = (d: SurveyDefinition, s: string) => parseLogicExpression(d, s);
const rule = (d: SurveyDefinition, s: string) => { const r = parse(d, s); assert.deepEqual(r.errors, [], s); return r.condition as { type: string; operator: string; value: unknown; children?: unknown[] }; };

test("Q3 = Option 1 is stored, printed and evaluated as Q3 = 1 — however it was written", () => {
  const d = survey();
  const q3 = byVar(d, "Q3V");
  assert.deepEqual(q3.options.map((o) => [o.code, o.label]), [[1, "Yes"], [2, "No"], [3, "Maybe"]], "the fixture: codes 1, 2, 3");
  for (const written of ["Q2 = 1", "Q2 == 1", 'Q2 = "1"', "Q2 = Yes", 'Q2 == "Yes"', 'Q2 == "__Yes__"', "Q2 = __Yes__", "Q2 = \"**Yes**\"", 'Q2 = "<b>Yes</b>"', 'Q2 = "Option 1"', "Q2 = O1", "Q2 is yes", "Q3V = Yes", "Q2.Yes", "Q2.O1", "Q2.1"]) {
    const c = rule(d, written);
    assert.equal(String(c.value), "1", `${written} → option 1`);
    const printed = formatCondition(d, c as never);
    assert.match(printed, /^Q2 = 1$|^Q2\.1$|^Q2\.O1$/, `${written} prints as ${printed}`);
    const st = createResponseState(d);
    setAnswer(d, st, q3.id, 1);
    assert.equal(evaluateCondition(c as never, { def: d, state: st }), true, `${written}: answered Yes`);
    setAnswer(d, st, q3.id, 2);
    assert.equal(evaluateCondition(c as never, { def: d, state: st }), false, `${written}: answered No`);
  }
  // what names no option is an error, not a rule that is never true
  const bad = parse(d, 'Q2 == "Definitely"');
  assert.equal(bad.condition, undefined);
  assert.match(bad.errors[0].message, /Q2 has no option “Definitely” — conditions compare option CODES \(1 = Yes, 2 = No, 3 = Maybe\)/);
  assert.match(parse(d, "Q2 = 4").errors[0].message, /no option “4”/, "a code the question does not have");
  // a label read as its code says so
  assert.match(parse(d, "Q2 = Yes").warnings.map((w) => w.message).join(" "), /“Yes” is option 1/);
  // text and numeric questions keep their literals
  assert.equal(rule(d, "Q4 = Paris").value, "Paris");
  assert.equal(rule(d, "Q1 >= 18").value, 18);
});

test("a multi-select's answer is a list: = means selected, in means any of — by code", () => {
  const d = survey();
  const eq = rule(d, "Q3 = Pepsi");
  assert.equal(eq.operator, "selected"); assert.equal(eq.value, 2);
  assert.equal(rule(d, "Q3 != Coke").operator, "notSelected");
  const otherCode = byVar(d, "BRANDS").options.find((o) => o.label === "Other")!.code;
  const anyOf = rule(d, "Q3 in [Coke, Other]");
  assert.equal(anyOf.operator, "containsAny"); assert.deepEqual(anyOf.value, [1, otherCode]);
  const st = createResponseState(d);
  setAnswer(d, st, byVar(d, "BRANDS").id, [1, 2]);
  assert.equal(evaluateCondition(eq as never, { def: d, state: st }), true, "Pepsi among two selected");
  assert.equal(evaluateCondition(anyOf as never, { def: d, state: st }), true);
});

test("nested AND / OR / NOT: every option value inside is a code", () => {
  const d = survey();
  const c = rule(d, '(Q2 = Yes OR Q2 == "Maybe") AND NOT (Q3 = "Other") AND Q1 >= 18');
  const json = JSON.stringify(c);
  assert.ok(!/Yes|Maybe|Other/.test(json), json);
  assert.match(formatCondition(d, c as never), /^\(Q2 = 1 OR Q2 = 3\) AND NOT .*Q3.* AND Q1 >= 18$/);
  const st = createResponseState(d);
  setAnswer(d, st, byVar(d, "Q3V").id, 3); setAnswer(d, st, byVar(d, "BRANDS").id, [1]); setAnswer(d, st, byVar(d, "AGE").id, 30);
  assert.equal(evaluateCondition(c as never, { def: d, state: st }), true);
  setAnswer(d, st, byVar(d, "BRANDS").id, [1, byVar(d, "BRANDS").options.find((o) => o.label === "Other")!.code]);
  assert.equal(evaluateCondition(c as never, { def: d, state: st }), false);
});

test("display logic and skip logic from the copilot's actions: codes, and they work", () => {
  const d0 = survey();
  const r = applySurveyActions(d0, [
    { op: "set_display_logic", target: "FOLLOW", expression: 'Q2 == "Yes"' },
    { op: "add_skip", from: "Q3V", when: "Q3V = No", to: "end" },
  ], { ids });
  assert.deepEqual(r.errors, []);
  const follow = byVar(r.def, "FOLLOW"), q3 = byVar(r.def, "Q3V");
  assert.deepEqual((follow.displayLogic as { value: unknown }).value, 1);
  assert.deepEqual((q3.skipLogic[0].when as { value: unknown }).value, 2);
  assert.equal(formatCondition(r.def, follow.displayLogic!), "Q2 = 1");
  const refused = applySurveyActions(d0, [{ op: "set_display_logic", target: "FOLLOW", expression: 'Q2 == "__Agree__"' }], { ids });
  assert.match(refused.errors.join(" "), /Q2 has no option “__Agree__”/);
});

test("the picker inserts references the parser reads (O, not C)", () => {
  const d = survey();
  const q2 = referenceTree(d).find((x) => x.token === "Q2")!;
  assert.deepEqual(q2.children!.map((c) => c.token), ["Q2.O1", "Q2.O2", "Q2.O3"]);
  for (const c of q2.children!) assert.deepEqual(parse(d, c.token).errors, [], c.token);
});

test("punching on the same option codes: IF Q2 = Yes THEN SET SEG = Fans — and hidden variables are coded", () => {
  const d0 = survey();
  const r = applySurveyActions(d0, [
    { op: "add_punch", target: "SEG", when: 'Q2 == "Yes" AND Q3 = Coke', codes: ["Fans"] },
    { op: "add_punch", target: "SCORE", when: "Q2 = 2", value: 10 },
    { op: "add_punch", target: "", expression: "IF Q2 = Maybe THEN SET SEG = 2" },
  ] as SurveyAction[], { ids });
  assert.deepEqual(r.errors, []);
  const d = r.def;
  const seg = byVar(d, "SEG"), score = byVar(d, "SCORE");
  assert.equal(seg.punches.length, 2); assert.equal(score.punches.length, 1);
  assert.equal(formatPunchExpression(d, seg, seg.punches[0] as never), "IF Q2 = 1 AND Q3.O1 THEN SELECT Q6.1");
  assert.equal(formatPunchExpression(d, score, score.punches[0] as never), "IF Q2 = 2 THEN SET Q7 = 10");
  assert.match(r.results[0].description, /Punch Q6: IF Q2 = 1 AND Q3\.O1 THEN SELECT Q6\.1/);
  assert.equal(r.structureUnchanged, false, "punching is structure, not look");
  // the runtime: answering page 1 and moving on codes the hidden variables
  const st = createResponseState(d);
  start(d, st);
  setAnswer(d, st, byVar(d, "Q3V").id, 1); setAnswer(d, st, byVar(d, "BRANDS").id, [1]);
  next(d, st);
  assert.equal(st.answers[seg.id], 1, "SEG coded Fans (1) although it is never on a page");
  const st2 = createResponseState(d);
  start(d, st2);
  setAnswer(d, st2, byVar(d, "Q3V").id, 2);
  next(d, st2);
  assert.equal(st2.answers[score.id], 10, "a numeric hidden variable takes its value");
  assert.equal(st2.answers[seg.id], undefined);
  const st3 = createResponseState(d);
  start(d, st3);
  setAnswer(d, st3, byVar(d, "Q3V").id, 3);
  next(d, st3);
  assert.equal(st3.answers[seg.id], 2, "the expression form: SET a choice target to an option code");
  // refusals name the options
  const bad = applySurveyActions(d0, [{ op: "add_punch", target: "SEG", when: "Q2 = 1", codes: ["Heavy"] }], { ids });
  assert.match(bad.errors.join(" "), /Q6 has no option “Heavy” to code the response as — its options are 1 = Fans, 2 = Others/);
  // SET a choice target by its label: stored as the label's code
  const byLabel = parsePunchExpression(d0, "IF Q2 = 1 THEN SET SEG = Others");
  assert.deepEqual(byLabel.errors, []);
  assert.equal(formatPunchExpression(d0, byVar(d0, "SEG"), byLabel.rules[0].rule as never), "IF Q2 = 1 THEN SELECT Q6.2");
  const bad2 = parsePunchExpression(d0, "IF Q2 = Absolutely THEN SET SEG = 1");
  assert.match(bad2.errors[0].message, /Q2 has no option “Absolutely”/);
});

test("repairing a stored survey: label-valued conditions everywhere become codes; the unresolvable are reported, not guessed", () => {
  const d = survey();
  const follow = byVar(d, "FOLLOW"), q3 = byVar(d, "Q3V"), brands = byVar(d, "BRANDS");
  follow.displayLogic = { type: "group", op: "or", children: [{ type: "rule", source: { kind: "question", ref: q3.id }, operator: "eq", value: "Yes" }, { type: "rule", source: { kind: "question", ref: brands.id }, operator: "eq", value: "__Pepsi__" }] } as never;
  q3.skipLogic = [{ id: "s1", when: { type: "rule", source: { kind: "question", ref: q3.id }, operator: "eq", value: "Nope" }, target: { kind: "end" } }] as never;
  const r = canonicalizeSurveyConditions(d);
  const f = byVar(r.def, "FOLLOW").displayLogic as { children: { operator: string; value: unknown }[] };
  assert.deepEqual(f.children.map((c) => [c.operator, c.value]), [["eq", 1], ["selected", 2]]);
  assert.ok(r.changes.some((c) => /“Yes” is option 1/.test(c)));
  assert.deepEqual(r.unresolved, ["Q2 has no option “Nope” — conditions compare option CODES (1 = Yes, 2 = No, 3 = Maybe)"]);
  assert.equal(JSON.stringify(byVar(d, "FOLLOW").displayLogic).includes("Yes"), true, "the input is not mutated");
  // a survey already on codes is left exactly as it is
  const clean = survey();
  byVar(clean, "FOLLOW").displayLogic = { type: "rule", source: { kind: "question", ref: byVar(clean, "Q3V").id }, operator: "eq", value: "1" } as never;
  const again = canonicalizeSurveyConditions(clean);
  assert.deepEqual(again.changes, []); assert.deepEqual(again.def, clean, "\"1\" for the code 1 is already right");
});

test("the resolution rules", () => {
  assert.equal(normalizeOptionText("<b>__Yes__</b>&nbsp;"), "yes");
  assert.equal(normalizeOptionText("“Strongly  agree”"), "strongly agree");
  const opts = [{ code: 1, label: "Yes" }, { code: 2, label: "No" }, { code: 99, label: "Other (please specify)", flags: ["other_specify"] }];
  assert.deepEqual(resolveOptionValue(opts, "Option 2"), { kind: "code", code: 2, via: "code" });
  assert.deepEqual(resolveOptionValue(opts, "Option 3"), { kind: "code", code: 99, via: "position" });
  assert.deepEqual(resolveOptionValue(opts, "other"), { kind: "code", code: 99, via: "label" });
  assert.deepEqual(resolveOptionValue([{ code: 1, label: "Yes" }, { code: 2, label: "yes" }], "YES"), { kind: "none" }, "two options say it: not guessed");
  const d = survey();
  const r = canonicalizeCondition(d, { type: "rule", source: { kind: "question", ref: byVar(d, "Q3V").id }, operator: "in", value: ["Yes", "Maybe"] } as never);
  assert.deepEqual((r.condition as { value: unknown }).value, [1, 3]);
});

test("what is not an option value is left alone: a grid read without a row, and the look of the survey", () => {
  const d = SurveyDefinition.parse({
    meta: { id: "g", code: "G", title: "Grid" },
    questions: [
      { id: "qg", code: "Q1", variableName: "GRID", type: "matrix_single", text: "Rate", rows: [{ code: "r1", label: "Taste" }, { code: "r2", label: "Price" }], options: [{ code: 1, label: "Bad" }, { code: 2, label: "Good" }] },
      { id: "qs", code: "Q2", variableName: "S", type: "single_select", text: "Pick", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
      { id: "qt", code: "Q3", variableName: "T", type: "text", text: "Why?" },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["qg", "qs", "qt"] }, { type: "end", id: "e", status: "complete" }],
    deployment: { clientSlug: "c", studySlug: "s" },
  });
  // the whole grid answer (row → code) compared with something: not one option code
  const whole = { type: "rule", source: { kind: "question", ref: "qg" }, operator: "eq", value: "Good" } as never;
  const r = canonicalizeCondition(d, whole);
  assert.deepEqual(r.errors, []); assert.deepEqual(r.condition, whole);
  // one row of it is: "Good" is 2
  const row = canonicalizeCondition(d, { type: "rule", source: { kind: "question", ref: "qg", rowCode: "r1" }, operator: "eq", value: "Good" } as never);
  assert.equal((row.condition as { value: unknown }).value, 2);
  // a rule-shaped object inside the look of the survey (branding / meta) is not survey logic…
  const lookalike = { type: "rule", source: { kind: "question", ref: "qs" }, operator: "eq", value: "Yes" };
  const withLook = { ...structuredClone(d), meta: { ...d.meta, note: lookalike }, branding: { ...(d.branding ?? {}), note: lookalike } } as unknown as SurveyDefinition;
  const rep = canonicalizeSurveyConditions(withLook);
  assert.deepEqual(rep.changes, []);
  assert.deepEqual(rep.def, withLook);
  // …but a UX behaviour's `when` IS: it decides when the behaviour fires, against answers, so it holds codes
  const withGuard = { ...structuredClone(d), ux: { styles: [], animations: [], behaviors: [{ id: "b", label: "b", target: { kind: "question", questionId: "qs" }, effects: [], when: lookalike }] } } as unknown as SurveyDefinition;
  const g = canonicalizeSurveyConditions(withGuard);
  assert.equal((g.def.ux!.behaviors[0].when as { value: unknown }).value, 1);
});

test("a structured condition keyed by code or variable name is canonicalised too, not only one keyed by id", () => {
  const d = survey();
  const byCode = canonicalizeCondition(d, { type: "rule", source: { kind: "question", ref: "Q2" }, operator: "eq", value: "Yes" } as never);
  assert.deepEqual(byCode.errors, []);
  assert.equal((byCode.condition as { value: unknown }).value, 1);
  assert.deepEqual(byCode.changes, ["Q2: “Yes” is option 1"]);
  const byVariable = canonicalizeCondition(d, { type: "rule", source: { kind: "variable", ref: "Q3V" }, operator: "eq", value: "Maybe" } as never);
  assert.equal((byVariable.condition as { value: unknown }).value, 3);
  const multi = canonicalizeCondition(d, { type: "rule", source: { kind: "question", ref: "BRANDS" }, operator: "eq", value: "Pepsi" } as never);
  assert.deepEqual([(multi.condition as { operator: string }).operator, (multi.condition as { value: unknown }).value], ["selected", 2], "a multi-select keyed by variable: = reads as selected, by code");
  // a value naming no option is an error whichever way the question is named
  assert.match(canonicalizeCondition(d, { type: "rule", source: { kind: "question", ref: "Q2" }, operator: "eq", value: "Nope" } as never).errors[0], /Q2 has no option “Nope”/);
  // a numeric or text question has no codes: left exactly as written
  const num = { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "eq", value: "abc" } as never;
  assert.deepEqual(canonicalizeCondition(d, num), { condition: num, errors: [], changes: [] });
  // a calculated variable is not a question: left alone
  const calc = { type: "rule", source: { kind: "variable", ref: "NOT_A_QUESTION" }, operator: "eq", value: "x" } as never;
  assert.deepEqual(canonicalizeCondition(d, calc).condition, calc);
});

/* ------------------------------------------------------------ mutation-checked edges (Phase 2) */

test("a number is not an option code: a numeric question with a “Don't know” option, and a COUNT, compare numbers", () => {
  const d = survey();
  const age = byVar(d, "AGE");
  age.options = [{ code: 99, label: "Don't know", flags: [] }] as never;
  const ageRule = { type: "rule", source: { kind: "question", ref: age.id }, operator: "eq", value: 30 } as const;
  assert.deepEqual(canonicalizeCondition(d, ageRule as never), { condition: ageRule, errors: [], changes: [] });
  const count = { type: "rule", source: { kind: "question", ref: byVar(d, "BRANDS").id, count: { of: "selected", scope: "options" } }, operator: "eq", value: 5 } as const;
  assert.deepEqual(canonicalizeCondition(d, count as never), { condition: count, errors: [], changes: [] }, "5 brands, not brand 5 — and not rewritten to `selected`");
});
