import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Condition } from "@rescript/schema";
import { applySurveyActions, type SurveyAction } from "./surveyActions.js";
import { parseLogicExpression } from "./logicExpression.js";
import { validateActionOutcome, questionConditions, validationRuleMisfit, kindWords, forEachRuleIn, type ActionIssue } from "./actionValidation.js";
import { listPages } from "./blocks.js";

/**
 * WHAT AN ACTION LEFT BEHIND. `validateActionOutcome` reads the survey before
 * and after one action and says what the action broke — forward references,
 * operators and literals that do not fit their source, codes removed from
 * under their logic, cycles, validation that does not fit the question, a
 * move that breaks an order, pipes that name nothing, contradictions.
 *
 * The `after` surveys here are built BY HAND on a clone, not through
 * `applySurveyActions`: once the action layer runs these checks itself, an
 * action that trips one is rolled back, and the test would be looking at the
 * survey before it.
 */
let n = 0;
const ids = (p: string) => `${p}_${++n}`;
const base = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Validation" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });

const fixture = (): SurveyDefinition => {
  const r = applySurveyActions(base(), [
    { op: "create_block", ref: "SCR", title: "Screening" },
    { op: "create_question", ref: "AGE", type: "numeric", text: "How old are you?" },
    { op: "create_question", ref: "GENDER", type: "single", text: "Gender?", options: ["Male", "Female", "Other"] },
    { op: "create_question", ref: "COUNTRY", type: "single", text: "Country?", options: ["USA", "Canada", "Mexico"] },
    { op: "create_question", ref: "BRANDS", type: "multi", text: "Brands?", options: ["Coke", "Pepsi", "Fanta"] },
    { op: "create_question", ref: "BUY", type: "yes_no", text: "Bought recently?" },
    { op: "create_block", ref: "MAIN", title: "Main" },
    { op: "create_question", ref: "SAT", type: "rating", text: "Satisfaction?", scale: { points: 5 } },
    { op: "create_question", ref: "COMMENT", type: "text", text: "Any comment?" },
    { op: "create_question", ref: "WHEN", type: "date", text: "When?" },
    { op: "create_question", ref: "SPEND", type: "numeric", text: "Monthly spend?" },
    { op: "create_question", ref: "FOLLOW", type: "text", text: "You said {{COMMENT}} — why?" },
    { op: "create_quota", name: "Region", cells: [{ label: "Canada", when: "COUNTRY = Canada", limit: 100 }, { label: "USA", when: "COUNTRY = USA", limit: 100 }] },
  ] as SurveyAction[], { ids });
  assert.deepEqual(r.errors, [], r.errors.join("\n"));
  return r.def;
};
const byVar = (d: SurveyDefinition, v: string) => d.questions.find((q) => q.variableName === v)!;
const cond = (d: SurveyDefinition, s: string): Condition => { const r = parseLogicExpression(d, s); assert.deepEqual(r.errors, [], `${s}: ${JSON.stringify(r.errors)}`); return r.condition!; };
const clone = (d: SurveyDefinition) => structuredClone(d) as SurveyDefinition;
const codes = (issues: ActionIssue[]) => issues.map((i) => i.code);
const display = (target: string, expression: Condition | string): SurveyAction => ({ op: "set_display_logic", target, expression });

/* ------------------------------------------------------------ nothing wrong */

test("a sound action leaves no issues — display logic reading an earlier question, a skip reading its own answer", () => {
  const before = fixture(), after = clone(before);
  const follow = byVar(after, "FOLLOW"), age = byVar(after, "AGE");
  follow.displayLogic = cond(after, "AGE >= 18 AND GENDER = Female");
  assert.deepEqual(validateActionOutcome(before, after, display("FOLLOW", "AGE >= 18 AND GENDER = Female"), [follow.id]), []);
  age.skipLogic = [{ id: "s1", when: cond(after, "AGE < 18"), target: { kind: "terminate", status: "screened" } }] as never;
  assert.deepEqual(validateActionOutcome(before, after, { op: "add_skip", from: "AGE", when: "AGE < 18", to: "screen_out" }, [age.id]), [], "a skip reads the question it skips from");
});

/* ------------------------------------------------------------ 1. forward references */

test("forward_reference: display logic reading a question asked later is refused, in the brief's words", () => {
  const before = fixture(), after = clone(before);
  const gender = byVar(after, "GENDER");
  gender.displayLogic = cond(after, "SPEND > 100");
  const issues = validateActionOutcome(before, after, display("GENDER", "SPEND > 100"), [gender.id]);
  assert.deepEqual(codes(issues), ["forward_reference"]);
  assert.equal(issues[0].level, "error");
  assert.equal(issues[0].message, "Q9 is asked after Q2, so Q2 cannot be shown on Q9's answer — move Q9 before Q2, or put the condition on Q9 instead.");
  assert.deepEqual(issues[0].objects, [gender.id, byVar(after, "SPEND").id]);
});

test("forward_reference: a skip, a validation gate, an option's visibility and a punch may not read later questions either — but may read their own", () => {
  const before = fixture(), after = clone(before);
  const age = byVar(after, "AGE"), spend = byVar(after, "SPEND"), country = byVar(after, "COUNTRY");
  age.skipLogic = [{ id: "s1", when: cond(after, "SPEND > 100"), target: { kind: "end" } }] as never;
  let issues = validateActionOutcome(before, after, { op: "add_skip", from: "AGE", when: "SPEND > 100", to: "end" }, [age.id]);
  assert.deepEqual(codes(issues), ["forward_reference"]);
  assert.match(issues[0].message, /Q9 is asked after Q1, so Q1's skip rule cannot read Q9's answer/);
  // validation reading its own question, and an option shown on its own question's other option: fine
  age.skipLogic = [];
  age.validation = [{ id: "v1", kind: "condition", check: cond(after, "AGE > 0") }] as never;
  country.options[2].visibleIf = cond(after, "COUNTRY.1");
  assert.deepEqual(validateActionOutcome(before, after, { op: "set_validation", target: "AGE", rules: [] }, [age.id, country.id]), []);
  // a punch whose criteria read a later question
  country.punches = [{ id: "p1", source: { kind: "codes", codes: [1] }, action: "select", mapping: [], ignoreUnmatched: true, recompute: "always", when: cond(after, "SPEND > 10") }] as never;
  issues = validateActionOutcome(before, after, { op: "add_punch", target: "COUNTRY", when: "SPEND > 10", codes: [1] }, [country.id]);
  assert.deepEqual(codes(issues), ["forward_reference"]);
  assert.match(issues[0].message, /Q3's punch rule cannot read Q9's answer/);
  void spend;
});

test("forward_reference: a block's display condition may not read a question inside or after the block", () => {
  const before = fixture(), after = clone(before);
  const main = (after.flow as { type: string; id: string; title?: string; visibleIf?: Condition }[]).find((x) => x.type === "block" && x.title === "Main")!;
  main.visibleIf = cond(after, "SAT >= 4");
  const issues = validateActionOutcome(before, after, display("Main", "SAT >= 4"), [main.id]);
  assert.deepEqual(codes(issues), ["forward_reference"]);
  assert.match(issues[0].message, /Q6 is inside block “Main”, so the block cannot be shown on Q6's answer/);
  main.visibleIf = cond(after, "BUY = Yes");
  assert.deepEqual(validateActionOutcome(before, after, display("Main", "BUY = Yes"), [main.id]), [], "a question before the block is fine");
});

/* ------------------------------------------------------------ 2. self references */

test("self_reference: display logic and a mask built from the question's own answer are refused; a skip or an option rule reading it is not", () => {
  const before = fixture(), after = clone(before);
  const gender = byVar(after, "GENDER");
  gender.displayLogic = { type: "rule", source: { kind: "variable", ref: "GENDER" }, operator: "eq", value: 1 } as Condition;
  let issues = validateActionOutcome(before, after, display("GENDER", gender.displayLogic), [gender.id]);
  assert.deepEqual(codes(issues), ["self_reference"]);
  assert.match(issues[0].message, /Q2's display logic reads Q2 itself — the answer is empty until the question is shown/);
  delete (gender as { displayLogic?: Condition }).displayLogic;
  gender.mask = { expr: { kind: "ref", questionId: gender.id }, action: "display" } as never;
  issues = validateActionOutcome(before, after, display("GENDER", "GENDER = 1"), [gender.id]);
  assert.deepEqual(codes(issues), ["self_reference"]);
  assert.match(issues[0].message, /Q2's mask reads Q2's own answer/);
});

/* ------------------------------------------------------------ 3. operator fits the source */

test("operator_mismatch: > on a Yes/No, > on a multi-select, > on a text — each refused with what the question is and what the operator reads; = is suggested for a choice", () => {
  const before = fixture(), after = clone(before);
  const buy = byVar(after, "BUY"), follow = byVar(after, "FOLLOW");
  follow.displayLogic = { type: "rule", source: { kind: "question", ref: buy.id }, operator: "gt", value: 1 } as Condition;
  const action = display("FOLLOW", follow.displayLogic);
  let issues = validateActionOutcome(before, after, action, [follow.id]);
  assert.deepEqual(codes(issues), ["operator_mismatch"]);
  assert.equal(issues[0].message, "Q5 is a single-select question whose options are 1 = Yes, 2 = No, so a condition on it must compare one option value; the requested condition reads Q5 as a number (>). Suggested: Q5 = 1.");
  assert.ok(issues[0].suggestion, "a corrected action is attached");
  assert.equal(issues[0].suggestion!.op, "set_display_logic");
  assert.deepEqual((issues[0].suggestion as { expression: Condition }).expression, { type: "rule", source: { kind: "question", ref: buy.id }, operator: "eq", value: 1 });
  // the suggestion applies cleanly
  const fixed = applySurveyActions(before, [issues[0].suggestion!], { ids });
  assert.deepEqual(fixed.errors, []);
  assert.equal((byVar(fixed.def, "FOLLOW").displayLogic as { operator: string }).operator, "eq");
  // a 5-point scale IS ordered: >= 4 on it is not a mismatch
  follow.displayLogic = cond(after, "SAT >= 4");
  assert.deepEqual(validateActionOutcome(before, after, display("FOLLOW", "SAT >= 4"), [follow.id]), []);
  // a multi-select compared as a number
  follow.displayLogic = { type: "rule", source: { kind: "question", ref: byVar(after, "BRANDS").id }, operator: "gt", value: 2 } as Condition;
  issues = validateActionOutcome(before, after, display("FOLLOW", follow.displayLogic), [follow.id]);
  assert.deepEqual(codes(issues), ["operator_mismatch"]);
  assert.match(issues[0].message, /Q4 is a multi-select question, so a condition on it must test which options are selected .*; the requested condition reads Q4 as a number \(>\)\. Suggested: Q4 = 2\./);
  // text compared as a number: no option to suggest
  follow.displayLogic = { type: "rule", source: { kind: "question", ref: byVar(after, "COMMENT").id }, operator: "gt", value: 3 } as Condition;
  issues = validateActionOutcome(before, after, display("FOLLOW", follow.displayLogic), [follow.id]);
  assert.deepEqual(codes(issues), ["operator_mismatch"]);
  assert.match(issues[0].message, /Q7 is a text question, so a condition on it must compare text .*; the requested condition reads Q7 as a number \(>\)\.$/);
  assert.equal(issues[0].suggestion, undefined);
  // a skip gets the same suggestion, on its `when`
  const sat = byVar(after, "SAT");
  delete (follow as { displayLogic?: Condition }).displayLogic;
  sat.skipLogic = [{ id: "s1", when: { type: "rule", source: { kind: "question", ref: buy.id }, operator: "lt", value: 2 }, target: { kind: "end" } }] as never;
  issues = validateActionOutcome(before, after, { op: "add_skip", from: "SAT", when: sat.skipLogic![0].when, to: "end" }, [sat.id]);
  assert.deepEqual(codes(issues), ["operator_mismatch"]);
  assert.equal((issues[0].suggestion as { when: Condition }).when.type, "rule");
  assert.equal(((issues[0].suggestion as { when: Condition }).when as { operator: string }).operator, "eq");
});

/* ------------------------------------------------------------ 4. the literal fits the source */

test("literal_type: a numeric question compared with text, a choice question compared with a code it does not have", () => {
  const before = fixture(), after = clone(before);
  const follow = byVar(after, "FOLLOW");
  follow.displayLogic = { type: "rule", source: { kind: "question", ref: byVar(after, "AGE").id }, operator: "eq", value: "abc" } as Condition;
  let issues = validateActionOutcome(before, after, display("FOLLOW", follow.displayLogic), [follow.id]);
  assert.deepEqual(codes(issues), ["literal_type"]);
  assert.match(issues[0].message, /Q1 is a numeric question, so it is compared with a number — “abc” is not one/);
  follow.displayLogic = { type: "rule", source: { kind: "question", ref: byVar(after, "COUNTRY").id }, operator: "eq", value: 7 } as Condition;
  issues = validateActionOutcome(before, after, display("FOLLOW", follow.displayLogic), [follow.id]);
  assert.deepEqual(codes(issues), ["literal_type"]);
  assert.equal(issues[0].message, "Q3 is a single-select question whose options are 1 = USA, 2 = Canada, 3 = Mexico — “7” is none of them, so the condition could never be true. Compare one of those codes.");
  // a numeric string is a number; a list of codes the question has is fine
  follow.displayLogic = { type: "group", op: "and", children: [
    { type: "rule", source: { kind: "question", ref: byVar(after, "AGE").id }, operator: "gte", value: "18" },
    { type: "rule", source: { kind: "question", ref: byVar(after, "COUNTRY").id }, operator: "in", value: [1, "2"] },
  ] } as Condition;
  assert.deepEqual(validateActionOutcome(before, after, display("FOLLOW", follow.displayLogic), [follow.id]), []);
});

/* ------------------------------------------------------------ 5. stale option codes */

test("stale_option: removing an option that display logic and a quota cell still compare against is refused, naming the dependents", () => {
  const before = fixture();
  byVar(before, "FOLLOW").displayLogic = cond(before, "COUNTRY = Canada");
  const after = clone(before);
  const country = byVar(after, "COUNTRY");
  country.options = country.options.filter((o) => o.code !== 2);
  const action: SurveyAction = { op: "update_question", target: "COUNTRY", removeOptions: ["Canada"] };
  const issues = validateActionOutcome(before, after, action, [country.id]);
  assert.deepEqual(codes(issues), ["stale_option"]);
  assert.equal(issues[0].level, "error");
  assert.equal(issues[0].message, "Removing option 2 “Canada” from Q3 leaves Q10 display logic and quota “Region” cell “Canada” comparing Q3 with a value that no longer exists — change that logic first, or remove the option with its logic.");
  assert.ok(issues[0].objects.includes(byVar(after, "FOLLOW").id) && issues[0].objects.includes(after.quotas[0].id), "the dependents are the objects");
  // removing an option nothing reads is fine
  const after2 = clone(before);
  byVar(after2, "COUNTRY").options = byVar(after2, "COUNTRY").options.filter((o) => o.code !== 3);
  assert.deepEqual(validateActionOutcome(before, after2, { op: "update_question", target: "COUNTRY", removeOptions: ["Mexico"] }, [country.id]), []);
  // recoding (replacing the whole list) that drops a compared code says so too
  const after3 = clone(before);
  byVar(after3, "COUNTRY").options = [{ code: "us", label: "USA", flags: [] }, { code: "ca", label: "Canada", flags: [] }, { code: "mx", label: "Mexico", flags: [] }] as never;
  const recoded = validateActionOutcome(before, after3, { op: "update_question", target: "COUNTRY", options: ["USA", "Canada", "Mexico"] }, [country.id]);
  assert.deepEqual(codes(recoded), ["stale_option"]);
  assert.match(recoded[0].message, /^Recoding option 1 “USA” and option 2 “Canada” from Q3 leaves/);
});

/* ------------------------------------------------------------ 6. cycles */

test("cycle: a condition that closes a loop of dependencies is refused; a cycle that was already there is not this action's", () => {
  const before = fixture();
  const sat = byVar(before, "SAT"), comment = byVar(before, "COMMENT");
  comment.displayLogic = cond(before, "SAT >= 4");
  const after = clone(before);
  byVar(after, "SAT").displayLogic = cond(after, "COMMENT answered");
  const issues = validateActionOutcome(before, after, display("SAT", "COMMENT answered"), [sat.id]);
  assert.ok(codes(issues).includes("cycle"), codes(issues).join());
  const cycle = issues.find((i) => i.code === "cycle")!;
  assert.match(cycle.message, /^Circular dependency detected between Q6 → Q7 → Q6\./);
  assert.deepEqual(new Set(cycle.objects), new Set([sat.id, comment.id]));
  // the same survey, with the cycle already in place before an unrelated action: not reported
  const again = clone(after);
  byVar(again, "FOLLOW").text = "Changed";
  assert.deepEqual(validateActionOutcome(after, again, { op: "update_question", target: "FOLLOW", text: "Changed" }, [byVar(again, "FOLLOW").id]).filter((i) => i.code === "cycle"), []);
});

/* ------------------------------------------------------------ 7. validation fit */

test("validation_fit: a rule kind that does not fit the question's type is refused, with what applies instead and the same action without it", () => {
  const before = fixture(), after = clone(before);
  const comment = byVar(after, "COMMENT");
  comment.validation = [{ id: "v1", kind: "min_value", value: 18 }, { id: "v2", kind: "max_length", value: 200 }] as never;
  const action: SurveyAction = { op: "set_validation", target: "COMMENT", rules: [{ kind: "min_value", value: 18 }, { kind: "max_length", value: 200 }] };
  const issues = validateActionOutcome(before, after, action, [comment.id]);
  assert.deepEqual(codes(issues), ["validation_fit"]);
  assert.equal(issues[0].message, "Q7 is a text question, so a minimum value does not apply — a minimum or maximum length, a pattern, or an email / phone / web-address / postal-code format applies to a text question.");
  assert.deepEqual(issues[0].suggestion, { op: "set_validation", target: "COMMENT", rules: [{ kind: "max_length", value: 200 }] });
  // every rule unfit: nothing left to suggest
  comment.validation = [{ id: "v1", kind: "min_value", value: 18 }] as never;
  const none = validateActionOutcome(before, after, { op: "set_validation", target: "COMMENT", rules: [{ kind: "min_value", value: 18 }] }, [comment.id]);
  assert.equal(none[0].suggestion, undefined);
  // selections on a multi-select: a maximum above the option count, a minimum above the maximum
  const brands = byVar(after, "BRANDS");
  brands.validation = [{ id: "v1", kind: "min_selections", value: 3 }, { id: "v2", kind: "max_selections", value: 5 }] as never;
  const sel = validateActionOutcome(before, after, { op: "set_validation", target: "BRANDS", rules: [{ kind: "min_selections", value: 3 }, { kind: "max_selections", value: 5 }] }, [brands.id]);
  assert.deepEqual(codes(sel), ["validation_fit"]);
  assert.match(sel[0].message, /Q4 has only 3 options, so at most 5 cannot be selected/);
  brands.validation = [{ id: "v1", kind: "min_selections", value: 3 }, { id: "v2", kind: "max_selections", value: 2 }] as never;
  assert.match(validateActionOutcome(before, after, { op: "set_validation", target: "BRANDS", rules: [{ kind: "min_selections", value: 3 }, { kind: "max_selections", value: 2 }] }, [brands.id])[0].message, /minimum number of selections \(3\) is above its maximum \(2\)/);
  // the fit table, read from the response model
  assert.equal(validationRuleMisfit(byVar(after, "AGE"), "min_value"), null);
  assert.match(validationRuleMisfit(byVar(after, "SAT"), "min_value")!, /Q6 is a single-select question/, "a rating scale is a single-select, as the grammar path reads it");
  assert.match(validationRuleMisfit(byVar(after, "AGE"), "email")!, /Q1 is a numeric question, so an email format does not apply/);
  assert.match(validationRuleMisfit(byVar(after, "GENDER"), "min_selections")!, /Q2 is a single-select question, so a minimum number of selections does not apply — a single-select takes only “required” and a condition rule/);
  assert.match(validationRuleMisfit(byVar(after, "COMMENT"), "date_min")!, /Q7 is a text question, so an earliest date does not apply/);
  assert.equal(validationRuleMisfit(byVar(after, "WHEN"), "date_min"), null);
  assert.match(validationRuleMisfit(byVar(after, "AGE"), "sum_equals")!, /a required total does not apply/);
  // numeric rules need numbers; create_question validation is checked the same way
  const age = byVar(after, "AGE");
  age.validation = [{ id: "v1", kind: "min_value", value: "eighteen" }] as never;
  const num = validateActionOutcome(before, after, { op: "create_question", type: "numeric", text: "Age", validation: [{ kind: "min_value", value: "eighteen" }] }, [age.id]);
  assert.deepEqual(codes(num), ["validation_fit"]);
  assert.match(num[0].message, /Q1's minimum value needs a number — “eighteen” is not one/);
});

/* ------------------------------------------------------------ 8. move order */

test("move_order: moving a question before the one its logic reads, or after one that reads it, is refused naming both", () => {
  const before = fixture();
  byVar(before, "FOLLOW").displayLogic = cond(before, "COMMENT answered");
  const after = clone(before);
  const follow = byVar(after, "FOLLOW"), comment = byVar(after, "COMMENT");
  // move FOLLOW to the top of its page (before COMMENT)
  const page = listPages(after.flow as unknown[]).find((p) => p.node.questionIds.includes(follow.id))!.node as { questionIds: string[] };
  page.questionIds = [follow.id, ...page.questionIds.filter((x) => x !== follow.id)];
  let issues = validateActionOutcome(before, after, { op: "move_question", target: "FOLLOW", block: "Main" }, [follow.id]);
  assert.deepEqual(codes(issues), ["move_order"]);
  assert.match(issues[0].message, /Moving Q10 here puts it before Q7, whose answer Q10's logic reads/);
  assert.deepEqual(issues[0].objects, [follow.id, comment.id]);
  // the other way round: move COMMENT to the end, after FOLLOW
  const after2 = clone(before);
  const page2 = listPages(after2.flow as unknown[]).find((p) => p.node.questionIds.includes(comment.id))!.node as { questionIds: string[] };
  page2.questionIds = [...page2.questionIds.filter((x) => x !== comment.id), comment.id];
  issues = validateActionOutcome(before, after2, { op: "move_question", target: "COMMENT", after: "FOLLOW" }, [comment.id]);
  assert.deepEqual(codes(issues), ["move_order"]);
  assert.match(issues[0].message, /Moving Q7 here puts it after Q10, whose logic reads Q7's answer/);
  // a move that keeps every order: nothing
  const after3 = clone(before);
  const sat = byVar(after3, "SAT");
  const page3 = listPages(after3.flow as unknown[]).find((p) => p.node.questionIds.includes(sat.id))!.node as { questionIds: string[] };
  page3.questionIds = [...page3.questionIds.filter((x) => x !== sat.id), sat.id];
  assert.deepEqual(validateActionOutcome(before, after3, { op: "move_question", target: "SAT", after: "FOLLOW" }, [sat.id]), []);
});

/* ------------------------------------------------------------ 9. dangling pipes */

test("dangling_reference: a variable rename that leaves {{OLD}} in another question's text is a warning naming the carriers", () => {
  const before = fixture(), after = clone(before);
  const comment = byVar(after, "COMMENT");
  comment.variableName = "REMARK";
  const issues = validateActionOutcome(before, after, { op: "update_question", target: "COMMENT", variable: "REMARK" }, [comment.id]);
  assert.deepEqual(codes(issues), ["dangling_reference"]);
  assert.equal(issues[0].level, "warning");
  assert.equal(issues[0].message, "{{COMMENT}} in Q10 no longer names anything in this survey, so it would show as blank. Q7's variable is now REMARK; write {{REMARK}}, or keep the old name.");
  assert.deepEqual(issues[0].objects, [byVar(after, "FOLLOW").id]);
  // a pipe that never resolved, in a question this action did not touch: not this action's
  const b2 = fixture(); byVar(b2, "FOLLOW").text = "{{NOPE}} why?";
  const a2 = clone(b2); byVar(a2, "AGE").text = "Age?";
  assert.deepEqual(validateActionOutcome(b2, a2, { op: "update_question", target: "AGE", text: "Age?" }, [byVar(a2, "AGE").id]), []);
  // …but a pipe the action itself wrote to nothing is
  const a3 = clone(b2); byVar(a3, "AGE").text = "Age of {{NOBODY}}?";
  assert.match(validateActionOutcome(b2, a3, { op: "update_question", target: "AGE", text: "Age of {{NOBODY}}?" }, [byVar(a3, "AGE").id])[0].message, /\{\{NOBODY\}\} in Q1 no longer names anything/);
});

/* ------------------------------------------------------------ 10. type change under logic */

test("type_change_breaks: changing a multi-select to numeric breaks the rules elsewhere that select its options", () => {
  const before = fixture();
  byVar(before, "FOLLOW").displayLogic = cond(before, "BRANDS = Coke");
  assert.equal((byVar(before, "FOLLOW").displayLogic as { operator: string }).operator, "selected", "the fixture: a multi-select's = is selected");
  const after = clone(before);
  const brands = byVar(after, "BRANDS");
  brands.type = "numeric"; brands.variant = "numeric.open"; brands.options = [];
  const issues = validateActionOutcome(before, after, { op: "update_question", target: "BRANDS", type: "numeric" }, [brands.id]);
  assert.deepEqual(codes(issues), ["type_change_breaks"]);
  assert.match(issues[0].message, /^Changing Q4 from multi-select to numeric breaks Q10 display logic \(Q4 selected 1\): .*compare a number.*Rewrite that logic for the new type first, or keep the type\.$/);
  assert.deepEqual(issues[0].objects, [brands.id, byVar(after, "FOLLOW").id]);
  // a change that keeps the rules meaningful — single to dropdown — breaks nothing
  const after2 = clone(before);
  byVar(after2, "COUNTRY").variant = "single_select.dropdown";
  assert.deepEqual(validateActionOutcome(before, after2, { op: "update_question", target: "COUNTRY", type: "dropdown" }, [byVar(after2, "COUNTRY").id]), []);
});

/* ------------------------------------------------------------ 11. contradictions */

test("contradiction: an AND of bounds no number satisfies, or of two equalities on one single-select, is a warning that says it can never be true", () => {
  const before = fixture(), after = clone(before);
  const follow = byVar(after, "FOLLOW");
  follow.displayLogic = cond(after, "AGE > 65 AND AGE < 18");
  let issues = validateActionOutcome(before, after, display("FOLLOW", "AGE > 65 AND AGE < 18"), [follow.id]);
  assert.deepEqual(codes(issues), ["contradiction"]);
  assert.equal(issues[0].level, "warning");
  assert.equal(issues[0].message, "Q10's display logic can never be true: Q1 > 65 AND Q1 < 18 — no number satisfies both. Q10 would never be shown; check whether OR was meant, or the bounds.");
  follow.displayLogic = cond(after, "GENDER = 1 AND GENDER = 2");
  issues = validateActionOutcome(before, after, display("FOLLOW", "GENDER = 1 AND GENDER = 2"), [follow.id]);
  assert.deepEqual(codes(issues), ["contradiction"]);
  assert.match(issues[0].message, /Q2 = 1 AND Q2 = 2 — one answer cannot equal two different values/);
  // the edges: >= 18 AND <= 18 holds for 18; > 18 AND < 18 does not; an OR is not an AND; a multi-select may have two options selected
  for (const ok of ["AGE >= 18 AND AGE <= 65", "AGE >= 18 AND AGE <= 18", "AGE > 65 OR AGE < 18", "BRANDS = Coke AND BRANDS = Pepsi", "AGE between 18 and 30 AND AGE >= 20"]) {
    follow.displayLogic = cond(after, ok);
    assert.deepEqual(validateActionOutcome(before, after, display("FOLLOW", ok), [follow.id]), [], ok);
  }
  for (const never of ["AGE > 18 AND AGE < 18", "AGE between 18 and 30 AND AGE >= 40", "SPEND = 10 AND SPEND > 20"]) {
    follow.displayLogic = cond(after, never);
    assert.deepEqual(codes(validateActionOutcome(before, after, display("FOLLOW", never), [follow.id])), ["contradiction"], never);
  }
  // a skip's contradiction says the skip never fires
  const age = byVar(after, "AGE");
  delete (follow as { displayLogic?: Condition }).displayLogic;
  age.skipLogic = [{ id: "s1", when: cond(after, "AGE < 10 AND AGE > 90"), target: { kind: "end" } }] as never;
  assert.match(validateActionOutcome(before, after, { op: "add_skip", from: "AGE", when: "AGE < 10 AND AGE > 90", to: "end" }, [age.id])[0].message, /The skip would never fire/);
});

/* ------------------------------------------------------------ the frame */

test("issues are deduplicated by code and message, nothing throws on a half-formed survey, and the walkers see every rule", () => {
  const before = fixture(), after = clone(before);
  const follow = byVar(after, "FOLLOW"), gender = byVar(after, "GENDER");
  // the same forward reference twice in one tree reports once
  gender.displayLogic = cond(after, "SPEND > 100 OR SPEND > 200");
  const issues = validateActionOutcome(before, after, display("GENDER", "SPEND > 100 OR SPEND > 200"), [gender.id]);
  assert.deepEqual(codes(issues), ["forward_reference"]);
  follow.displayLogic = cond(after, "AGE > 18 OR AGE < 10");
  // garbage in: nothing out, no throw
  assert.deepEqual(validateActionOutcome(before, { ...after, questions: undefined } as unknown as SurveyDefinition, display("FOLLOW", "x"), [follow.id]), []);
  assert.deepEqual(validateActionOutcome(before, after, display("FOLLOW", "x"), ["nobody"]), []);
  // the helpers other modules reuse
  assert.deepEqual(questionConditions(after, follow).map((c) => c.where), ["display logic"]);
  let rules = 0; forEachRuleIn(after, () => rules++);
  assert.equal(rules, 2 + 2 + 2, "GENDER's two rules, FOLLOW's two rules and the quota's two cells");
  assert.equal(kindWords(byVar(after, "BRANDS")), "multi-select");
  assert.equal(kindWords(byVar(after, "WHEN")), "date");
});

/* ------------------------------------------------------------ mutation-checked edges (Phase 2) */

/** the fixture plus a 5-point grid, a ranking, a multi-response grid, a numeric grid and a text question after them all */
const extended = (): SurveyDefinition => {
  const r = applySurveyActions(fixture(), [
    { op: "create_question", ref: "GRID", type: "matrix", text: "Rate each", rows: ["Taste", "Price"], scale: { points: 5 } },
    { op: "create_question", ref: "RANK", type: "ranking", text: "Rank these", options: ["Coke", "Pepsi", "Fanta"] },
    { op: "create_question", ref: "MGRID", type: "matrix_multi", text: "Which apply?", rows: ["Taste", "Price"], options: ["Good", "Bad", "Fair"] },
    { op: "create_question", ref: "NGRID", type: "matrix_numeric", text: "How many?", rows: ["Taste", "Price"], options: ["Count"] },
    { op: "create_question", ref: "LATE", type: "text", text: "Last?" },
  ] as SurveyAction[], { ids });
  assert.deepEqual(r.errors, [], r.errors.join("\n"));
  return r.def;
};
const rule = (d: SurveyDefinition, v: string, operator: string, value?: unknown, extra: Record<string, unknown> = {}): Condition =>
  ({ type: "rule", source: { kind: "question", ref: byVar(d, v).id, ...extra }, operator, ...(value !== undefined ? { value } : {}) }) as Condition;
const and = (...children: Condition[]): Condition => ({ type: "group", op: "and", children }) as Condition;

test("the frame: the same diagnosis reached twice — by display logic and by a display rule reading the same later question — is one issue", () => {
  const before = fixture(), after = clone(before);
  const gender = byVar(after, "GENDER");
  gender.displayLogic = cond(after, "SPEND > 100");
  after.displayRules = [{ id: "dr1", target: { kind: "question", ref: gender.id }, action: "show", when: cond(after, "SPEND > 5") }] as never;
  const issues = validateActionOutcome(before, after, display("GENDER", "SPEND > 100"), [gender.id]);
  assert.deepEqual(codes(issues), ["forward_reference"], JSON.stringify(issues));
});

test("self_reference: a display rule that targets the question, and a mask's guard, reading the question itself are refused", () => {
  const before = fixture(), after = clone(before);
  const gender = byVar(after, "GENDER");
  after.displayRules = [{ id: "dr1", target: { kind: "question", ref: gender.id }, action: "show", when: cond(after, "GENDER = 1") }] as never;
  let issues = validateActionOutcome(before, after, display("GENDER", "GENDER = 1"), [gender.id]);
  assert.deepEqual(codes(issues), ["self_reference"]);
  assert.match(issues[0].message, /^Q2's display rule reads Q2 itself/);
  assert.deepEqual(issues[0].objects, [gender.id, "dr1"]);
  after.displayRules = [];
  gender.mask = { expr: { kind: "codes", codes: [1, 2] }, action: "display", when: cond(after, "GENDER = 1") } as never;
  issues = validateActionOutcome(before, after, display("GENDER", "GENDER = 1"), [gender.id]);
  assert.deepEqual(codes(issues), ["self_reference"]);
  assert.match(issues[0].message, /^Q2's mask guard reads Q2 itself/);
});

test("forward_reference: a mask whose set expression reads a later question is refused", () => {
  const before = fixture(), after = clone(before);
  const gender = byVar(after, "GENDER");
  gender.mask = { expr: { kind: "ref", questionId: byVar(after, "BRANDS").id }, action: "display" } as never;
  const issues = validateActionOutcome(before, after, display("GENDER", "BRANDS answered"), [gender.id]);
  assert.deepEqual(codes(issues), ["forward_reference"]);
  assert.match(issues[0].message, /^Q4 is asked after Q2, so Q2's mask cannot read Q4's answer/);
});

test("literal_type: a grid read without its row is any row's answer — a value off its scale could never be true; a scale point is fine", () => {
  const before = extended(), after = clone(before);
  const late = byVar(after, "LATE");
  late.displayLogic = rule(after, "GRID", "eq", 7);
  const issues = validateActionOutcome(before, after, display("LATE", late.displayLogic), [late.id]);
  assert.deepEqual(codes(issues), ["literal_type"]);
  assert.match(issues[0].message, /Q11 is a grid question whose options are 1 = 1, .* — “7” is none of them/);
  late.displayLogic = rule(after, "GRID", "eq", 5);
  assert.deepEqual(validateActionOutcome(before, after, display("LATE", late.displayLogic), [late.id]), []);
});

test("operator_mismatch: the suggested fix rides only on the rule it rewrites — a second misfit in the same condition gets no “Suggested:” and no action", () => {
  const before = fixture(), after = clone(before);
  const follow = byVar(after, "FOLLOW");
  follow.displayLogic = and(rule(after, "BUY", "gt", 1), rule(after, "COMMENT", "gt", 3));
  const issues = validateActionOutcome(before, after, display("FOLLOW", follow.displayLogic), [follow.id]);
  assert.deepEqual(codes(issues), ["operator_mismatch", "operator_mismatch"]);
  assert.match(issues[0].message, /Suggested: Q5 = 1\.$/);
  assert.ok(issues[0].suggestion, "the Yes/No rule's issue carries the corrected action");
  assert.doesNotMatch(issues[1].message, /Suggested/, "the text rule is not what the suggestion fixes");
  assert.equal(issues[1].suggestion, undefined);
});

test("literal_type on a ranking: the rank (value2) is a position, not an option — only the code is checked", () => {
  const before = extended(), after = clone(before);
  const late = byVar(after, "LATE");
  late.displayLogic = { ...rule(after, "RANK", "rankEquals", 1), value2: 5 } as Condition;
  assert.deepEqual(validateActionOutcome(before, after, display("LATE", late.displayLogic), [late.id]), [], "rank 5 of a 3-option ranking is not a code");
  late.displayLogic = { ...rule(after, "RANK", "rankEquals", 9), value2: 1 } as Condition;
  assert.deepEqual(codes(validateActionOutcome(before, after, display("LATE", late.displayLogic), [late.id])), ["literal_type"]);
});

test("stale_option: a ranking's rank is not a code that can go stale; a count's `only` list is", () => {
  const before = extended();
  const late = byVar(before, "LATE");
  late.displayLogic = { ...rule(before, "RANK", "rankEquals", 1), value2: 3 } as Condition;
  let after = clone(before);
  byVar(after, "RANK").options = byVar(after, "RANK").options.filter((o) => o.code !== 3);
  assert.deepEqual(validateActionOutcome(before, after, { op: "update_question", target: "RANK", removeOptions: ["Fanta"] }, [byVar(after, "RANK").id]), [], "rank 3 is not option 3");
  late.displayLogic = rule(before, "BRANDS", "gte", 1, { count: { of: "selected", scope: "options", only: [2] } });
  after = clone(before);
  byVar(after, "BRANDS").options = byVar(after, "BRANDS").options.filter((o) => o.code !== 2);
  const issues = validateActionOutcome(before, after, { op: "update_question", target: "BRANDS", removeOptions: ["Pepsi"] }, [byVar(after, "BRANDS").id]);
  assert.deepEqual(codes(issues), ["stale_option"]);
  assert.match(issues[0].message, /^Removing option 2 “Pepsi” from Q4 leaves Q15 display logic comparing/);
});

test("validation_fit: totals apply to a numeric grid and a numeric list; a minimum above the option count is refused on its own", () => {
  const d = extended();
  // the stored types the table names (the action layer's matrix.numeric variant is a composite of cells)
  assert.equal(validationRuleMisfit({ ...byVar(d, "NGRID"), type: "matrix_numeric", variant: undefined } as never, "sum_equals"), null);
  assert.equal(validationRuleMisfit({ ...byVar(d, "NGRID"), type: "numeric_list", variant: undefined } as never, "sum_max"), null);
  const before = fixture(), after = clone(before);
  const brands = byVar(after, "BRANDS");
  brands.validation = [{ id: "v1", kind: "min_selections", value: 4 }] as never;
  const issues = validateActionOutcome(before, after, { op: "set_validation", target: "BRANDS", rules: [{ kind: "min_selections", value: 4 }] }, [brands.id]);
  assert.deepEqual(codes(issues), ["validation_fit"]);
  assert.equal(issues[0].message, "Q4 has only 3 options, so at least 4 can never be selected — a minimum of 3 or fewer is the most it can require.");
});

test("move_order: only orders the move broke — a forward reference already there, on either side, is not reported, nor is a reader that stays after", () => {
  const before = fixture();
  byVar(before, "GENDER").displayLogic = cond(before, "SPEND > 100");     // already a forward reference
  byVar(before, "FOLLOW").displayLogic = cond(before, "COMMENT answered"); // in order
  const page = (d: SurveyDefinition, v: string) => listPages(d.flow as unknown[]).find((p) => p.node.questionIds.includes(byVar(d, v).id))!.node as { questionIds: string[] };
  const ord = (d: SurveyDefinition, ...vs: string[]) => { page(d, vs[0]).questionIds = vs.map((v) => byVar(d, v).id); };
  // GENDER moves down its page, still before SPEND, which it already read too early
  let after = clone(before);
  ord(after, "AGE", "COUNTRY", "GENDER", "BRANDS", "BUY");
  assert.deepEqual(validateActionOutcome(before, after, { op: "move_question", target: "GENDER", after: "COUNTRY" }, [byVar(after, "GENDER").id]), []);
  // SPEND moves to the end: GENDER read it too early before the move as well
  after = clone(before);
  ord(after, "SAT", "COMMENT", "WHEN", "FOLLOW", "SPEND");
  assert.deepEqual(validateActionOutcome(before, after, { op: "move_question", target: "SPEND", after: "FOLLOW" }, [byVar(after, "SPEND").id]), []);
  // COMMENT moves up: FOLLOW, which reads it, is still after it
  after = clone(before);
  ord(after, "COMMENT", "SAT", "WHEN", "SPEND", "FOLLOW");
  assert.deepEqual(validateActionOutcome(before, after, { op: "move_question", target: "COMMENT", block: "Main" }, [byVar(after, "COMMENT").id]), []);
});

test("type_change_breaks: an update that names a type but leaves it as it was re-checks nothing", () => {
  const before = fixture();
  byVar(before, "FOLLOW").displayLogic = rule(before, "COUNTRY", "eq", 7);  // an old misfit, not this action's
  const after = clone(before);
  assert.deepEqual(validateActionOutcome(before, after, { op: "update_question", target: "COUNTRY", type: "single" }, [byVar(after, "COUNTRY").id]), []);
});

test("contradiction: only rules ANDed directly; a grid read without its row may hold two values; validation is not display; a count's `where` is looked into", () => {
  const before = extended(), after = clone(before);
  const late = byVar(after, "LATE");
  const warn = (c: Condition) => { late.displayLogic = c; return codes(validateActionOutcome(before, after, display("LATE", c), [late.id])); };
  assert.deepEqual(warn(cond(after, "AGE > 65 AND (AGE < 18 OR GENDER = 1)")), [], "the < 18 is under an OR");
  assert.deepEqual(warn(and(rule(after, "MGRID", "eq", 1), rule(after, "MGRID", "eq", 2))), [], "one row Good and another Bad");
  assert.deepEqual(warn(rule(after, "BRANDS", "gte", 1, { count: { of: "matching", scope: "options", where: cond(after, "AGE > 65 AND AGE < 18") } })), ["contradiction"]);
  delete (late as { displayLogic?: Condition }).displayLogic;
  late.validation = [{ id: "v1", kind: "condition", check: cond(after, "AGE > 65 AND AGE < 18") }] as never;
  assert.deepEqual(validateActionOutcome(before, after, { op: "set_validation", target: "LATE", rules: [] }, [late.id]), [], "a validation check is not display or skip logic");
});

test("contradiction: two counts of different things on one question are two numbers, not one", () => {
  const before = fixture(), after = clone(before);
  const follow = byVar(after, "FOLLOW");
  follow.displayLogic = and(
    rule(after, "BRANDS", "gte", 2, { count: { of: "selected", scope: "options" } }),
    rule(after, "BRANDS", "lte", 1, { count: { of: "notSelected", scope: "options" } }),
  );
  assert.deepEqual(validateActionOutcome(before, after, display("FOLLOW", follow.displayLogic), [follow.id]), [], "2+ selected and at most 1 not selected is one answer");
  follow.displayLogic = and(
    rule(after, "BRANDS", "gte", 2, { count: { of: "selected", scope: "options" } }),
    rule(after, "BRANDS", "lte", 1, { count: { of: "selected", scope: "options" } }),
  );
  assert.deepEqual(codes(validateActionOutcome(before, after, display("FOLLOW", follow.displayLogic), [follow.id])), ["contradiction"], "the same count cannot be both");
});

test("a count is a number whatever it counts: a count rule on a multi-select is not read as the multi-select itself", () => {
  const before = fixture(), after = clone(before);
  const follow = byVar(after, "FOLLOW");
  follow.displayLogic = rule(after, "BRANDS", "gte", 2, { count: { of: "selected", scope: "options" } });
  assert.deepEqual(validateActionOutcome(before, after, display("FOLLOW", follow.displayLogic), [follow.id]), []);
});
