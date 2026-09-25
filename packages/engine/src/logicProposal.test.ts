import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond, type Question } from "@rescript/schema";
import { applyLogicProposal, validateProposal, describeChange, proposalTargets, setExprRefs, type ProposalChange } from "./logicProposal.js";
import { evaluateCondition } from "./evaluate.js";
import { createResponseState } from "./state.js";

const evalWith = (def: SurveyDefinition, c: NonNullable<Question["displayLogic"]>, answers: Record<string, unknown>) => {
  const state = createResponseState(def, { seed: 1 });
  Object.assign(state.answers, answers);
  return evaluateCondition(c, { def, state, loop: null });
};

const survey = () =>
  SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Proposals" },
    questions: [
      { id: "q_age", code: "Q1", variableName: "AGE", type: "numeric", text: "Age" },
      { id: "q_type", code: "Q2", variableName: "TYPE", type: "single_select", text: "Type", options: [{ code: "A", label: "Consumer" }, { code: "B", label: "Business" }] },
      { id: "q_c", code: "Q3", variableName: "C", type: "text", text: "Consumer only" },
      { id: "q_end", code: "Q5", variableName: "E", type: "text", text: "Everyone" },
    ],
    flow: [
      { type: "page", id: "p1", title: "Intro", questionIds: ["q_age", "q_type"] },
      { type: "page", id: "p2", questionIds: ["q_c"] },
      { type: "page", id: "p5", questionIds: ["q_end"] },
      { type: "end", id: "e_ok", status: "complete" },
    ],
    deployment: { clientSlug: "c", studySlug: "s" },
  });

const show: ProposalChange = { kind: "set_display_logic", questionId: "q_c", condition: cond.rule("q_type", "eq", "A") };

test("display logic lands on the question and evaluates through the one evaluator", () => {
  const def = survey();
  const r = applyLogicProposal(def, [show]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.applied, 1);
  assert.equal(r.def, def, "mutates in place — the store's clone is what comes back");
  const q = def.questions.find((x) => x.id === "q_c")!;
  assert.ok(q.displayLogic);
  assert.equal(evalWith(def, q.displayLogic!, { q_type: "A" }), true);
  assert.equal(evalWith(def, q.displayLogic!, { q_type: "B" }), false);
  // and null clears it
  applyLogicProposal(def, [{ kind: "set_display_logic", questionId: "q_c", condition: null }]);
  assert.equal(q.displayLogic, undefined);
});

test("apply is all-or-nothing: one bad change and nothing is touched", () => {
  const def = survey();
  const r = applyLogicProposal(def, [
    { kind: "set_required", questionId: "q_c", required: true },
    { kind: "set_required", questionId: "q_missing", required: true },
  ]);
  assert.equal(r.applied, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /q_missing/);
  assert.equal(def.questions.find((x) => x.id === "q_c")!.required, false, "the valid change was NOT applied");
});

test("validation refuses logic that reads the future or itself", () => {
  const def = survey();
  const later = validateProposal(def, [{ kind: "set_display_logic", questionId: "q_c", condition: cond.rule("q_end", "answered") }]);
  assert.equal(later.length, 1);
  assert.match(later[0], /asked after/);
  const self = validateProposal(def, [{ kind: "set_display_logic", questionId: "q_c", condition: cond.rule("q_c", "answered") }]);
  assert.equal(self.length, 1, "one error, not the same fault said twice");
  assert.match(self[0], /its own answer/);
  assert.deepEqual(validateProposal(def, [show]), []);
});

test("a skip rule must jump forward, to something that exists", () => {
  const def = survey();
  const rule = (target: ProposalChange & { kind: "add_skip_rule" } extends { rule: { target: infer T } } ? T : never) => ({
    kind: "add_skip_rule" as const, questionId: "q_type",
    rule: { id: "sk1", when: cond.rule("q_type", "eq", "B"), target },
  });
  assert.match(validateProposal(def, [rule({ kind: "question", ref: "q_age" })])[0], /jump forward/);
  assert.match(validateProposal(def, [rule({ kind: "question", ref: "q_type" })])[0], /jump forward/, "a skip to itself is not forward");
  assert.match(validateProposal(def, [rule({ kind: "question", ref: "q_nope" })])[0], /does not exist/);
  assert.match(validateProposal(def, [rule({ kind: "page", ref: "p_nope" })])[0], /does not exist/);
  assert.deepEqual(validateProposal(def, [rule({ kind: "question", ref: "q_end" })]), []);
  assert.deepEqual(validateProposal(def, [rule({ kind: "terminate", status: "screened" })]), []);
  const r = applyLogicProposal(def, [rule({ kind: "question", ref: "q_end" })]);
  assert.equal(r.applied, 1);
  assert.equal(def.questions.find((x) => x.id === "q_type")!.skipLogic.length, 1);
  const r2 = applyLogicProposal(def, [{ ...rule({ kind: "terminate", status: "screened" }), rule: { id: "sk2", when: cond.rule("q_age", "lt", 18), target: { kind: "terminate", status: "screened" } } }]);
  assert.equal(r2.applied, 1);
  assert.equal(def.questions.find((x) => x.id === "q_type")!.skipLogic.length, 2, "a second rule is appended, not a replacement");
  // the same rule id twice is refused
  assert.match(validateProposal(def, [rule({ kind: "question", ref: "q_end" })])[0], /already exists/);
});

test("a display rule on a page or an option is checked against the flow and the options", () => {
  const def = survey();
  const when = cond.rule("q_type", "eq", "A");
  assert.deepEqual(validateProposal(def, [{ kind: "add_display_rule", rule: { id: "dr1", target: { kind: "page", ref: "p2" }, action: "hide", when } }]), []);
  assert.match(validateProposal(def, [{ kind: "add_display_rule", rule: { id: "dr1", target: { kind: "page", ref: "p9" }, action: "show", when } }])[0], /No page p9/);
  assert.match(validateProposal(def, [{ kind: "add_display_rule", rule: { id: "dr1", target: { kind: "option", ref: "q_type", subRef: "Z" }, action: "show", when } }])[0], /no option Z/);
  const r = applyLogicProposal(def, [{ kind: "add_display_rule", rule: { id: "dr1", target: { kind: "option", ref: "q_type", subRef: "B" }, action: "hide", when } }]);
  assert.equal(r.applied, 1);
  assert.equal(def.displayRules.length, 1);
});

test("adding a question places it and refuses a taken name; rename goes through the engine's rename", () => {
  const def = survey();
  const q = { id: "q_new", code: "Q4", variableName: "NEW", type: "single_select", text: "New?", options: [{ code: "1", label: "Yes" }], rows: [], columns: [], validation: [], required: false, settings: {}, skipLogic: [], listLogic: [] } as unknown as Question;
  assert.match(validateProposal(def, [{ kind: "add_question", question: { ...q, code: "Q1" } }])[0], /Q1 is already in use/);
  assert.match(validateProposal(def, [{ kind: "add_question", question: { ...q, variableName: "AGE" } }])[0], /AGE is already in use/);
  const r = applyLogicProposal(def, [{ kind: "add_question", question: q, at: { pageId: "p2", index: 0 } }]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual((def.flow[1] as { questionIds: string[] }).questionIds, ["q_new", "q_c"]);
  assert.equal(def.questions.length, 5);

  const bad = validateProposal(def, [{ kind: "rename_variable", oldName: "AGE", newName: "1BAD" }]);
  assert.ok(bad.length >= 1 && /not a usable variable name/.test(bad[0]));
  const ok = applyLogicProposal(def, [{ kind: "rename_variable", oldName: "AGE", newName: "RESP_AGE" }]);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.def.questions.find((x) => x.id === "q_age")!.variableName, "RESP_AGE");
});

test("describeChange says what will happen in the Logic panel's words; targets are what to select after", () => {
  const def = survey();
  assert.equal(describeChange(def, show), "Show Q3 only when Q2 is “Consumer”.");
  assert.equal(describeChange(def, { kind: "set_required", questionId: "q_end", required: false }), "Make Q5 optional.");
  assert.match(describeChange(def, { kind: "add_skip_rule", questionId: "q_type", rule: { id: "s", when: cond.rule("q_age", "lt", 18), target: { kind: "terminate", status: "screened" } } }), /^After Q2, skip out of the survey as screened when /);
  assert.match(describeChange(def, { kind: "add_display_rule", rule: { id: "d", target: { kind: "page", ref: "p1" }, action: "hide", when: show.condition! } }), /^Hide page Intro when /);
  assert.equal(describeChange(def, { kind: "rename_variable", oldName: "AGE", newName: "A2" }), "Rename AGE to A2 everywhere it is used.");
  assert.deepEqual(proposalTargets([show, { kind: "set_required", questionId: "q_c", required: true }, { kind: "rename_variable", oldName: "A", newName: "B" }]), ["q_c"]);
});

/* -------------------------------------------------- validation and masks (round 2) */

const survey2 = () =>
  SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Validation" },
    questions: [
      { id: "q_age", code: "Q1", variableName: "AGE", type: "numeric", text: "Age", validation: [{ id: "v1", kind: "min_value", value: 10 }] },
      { id: "q_email", code: "Q2", variableName: "EMAIL", type: "open_text", text: "Email" },
      { id: "q_brands", code: "Q3", variableName: "BRANDS", type: "multi_select", text: "Brands", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }, { code: 3, label: "C" }] },
      { id: "q_best", code: "Q4", variableName: "BEST", type: "single_select", text: "Best", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }, { code: 3, label: "C" }] },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q_age", "q_email", "q_brands", "q_best"] }, { type: "end", id: "e", status: "complete" }],
    deployment: { clientSlug: "c", studySlug: "s" },
  });

test("set_validation merges by kind, keeps other rules, refuses rules that do not fit the type", () => {
  const def = survey2();
  const r = applyLogicProposal(def, [{ kind: "set_validation", questionId: "q_age", rules: [{ kind: "min_value", value: 18 }, { kind: "max_value", value: 99 }] }]);
  assert.deepEqual(r.errors, []);
  const v = def.questions.find((x) => x.id === "q_age")!.validation;
  assert.deepEqual(v.map((x) => [x.kind, x.value]), [["min_value", 18], ["max_value", 99]], "the existing min rule was REPLACED, its id kept, and max appended");
  assert.equal(v[0].id, "v1");
  assert.match(validateProposal(def, [{ kind: "set_validation", questionId: "q_age", rules: [{ kind: "max_value", value: 5 }] }])[0], /minimum \(18\) is above the maximum \(5\)/);
  assert.match(validateProposal(def, [{ kind: "set_validation", questionId: "q_email", rules: [{ kind: "min_value", value: 1 }] }])[0], /not numeric/);
  assert.match(validateProposal(def, [{ kind: "set_validation", questionId: "q_age", rules: [{ kind: "email" }] }])[0], /not a text question/);
  assert.match(validateProposal(def, [{ kind: "set_validation", questionId: "q_best", rules: [{ kind: "min_selections", value: 2 }] }])[0], /not a multi-select/);
  assert.match(validateProposal(def, [{ kind: "set_validation", questionId: "q_brands", rules: [{ kind: "max_selections", value: 9 }] }])[0], /only 3 options/);
  assert.match(validateProposal(def, [{ kind: "set_validation", questionId: "q_age", rules: [{ kind: "max_value", value: "lots" as never }] }])[0], /needs a number/);
  assert.deepEqual(validateProposal(def, [{ kind: "set_validation", questionId: "q_email", rules: [{ kind: "email" }, { kind: "max_length", value: 120 }] }]), []);
  assert.equal(describeChange(def, { kind: "set_validation", questionId: "q_email", rules: [{ kind: "email" }, { kind: "max_length", value: 120 }] }), "Validate Q2: an email address, at most 120 characters.");
});

test("clear_validation drops the named kinds, or everything; refuses when there is nothing to drop", () => {
  const def = survey2();
  applyLogicProposal(def, [{ kind: "set_validation", questionId: "q_age", rules: [{ kind: "max_value", value: 99 }, { kind: "integer" }] }]);
  const r = applyLogicProposal(def, [{ kind: "clear_validation", questionId: "q_age", kinds: ["max_value"] }]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(def.questions[0].validation.map((v) => v.kind), ["min_value", "integer"]);
  assert.match(validateProposal(def, [{ kind: "clear_validation", questionId: "q_age", kinds: ["max_value"] }])[0], /no maximum value rule/);
  applyLogicProposal(def, [{ kind: "clear_validation", questionId: "q_age" }]);
  assert.deepEqual(def.questions[0].validation, []);
  assert.match(validateProposal(def, [{ kind: "clear_validation", questionId: "q_age" }])[0], /no validation rules/);
  assert.equal(describeChange(def, { kind: "clear_validation", questionId: "q_age", kinds: ["min_value", "max_value"] }), "Remove the minimum value and maximum value rules from Q1.");
});

test("set_mask writes the universal mask; the source must exist, differ from the target and come first", () => {
  const def = survey2();
  const mask = { expr: { kind: "ref", questionId: "q_brands", selection: "selected" }, action: "display", keepAlwaysShow: true } as const;
  assert.deepEqual(validateProposal(def, [{ kind: "set_mask", questionId: "q_best", mask }]), []);
  assert.equal(describeChange(def, { kind: "set_mask", questionId: "q_best", mask }), "Show at Q4 only the options Q3.Selected.");
  const r = applyLogicProposal(def, [{ kind: "set_mask", questionId: "q_best", mask }]);
  assert.equal(r.applied, 1);
  assert.deepEqual(def.questions.find((x) => x.id === "q_best")!.mask, mask);
  assert.match(validateProposal(def, [{ kind: "set_mask", questionId: "q_brands", mask: { ...mask, expr: { kind: "ref", questionId: "q_best", selection: "selected" } } }])[0], /asked after/);
  assert.match(validateProposal(def, [{ kind: "set_mask", questionId: "q_best", mask: { ...mask, expr: { kind: "ref", questionId: "q_best", selection: "selected" } } }])[0], /its own answer/);
  assert.match(validateProposal(def, [{ kind: "set_mask", questionId: "q_best", mask: { ...mask, expr: { kind: "ref", questionId: "q_zzz", selection: "selected" } } }])[0], /does not exist/);
  assert.match(validateProposal(def, [{ kind: "set_mask", questionId: "q_age", mask }])[0], /no options to mask/);
  const op = { ...mask, expr: { kind: "op", operator: "intersection", left: { kind: "ref", questionId: "q_brands", selection: "selected" }, right: { kind: "ref", questionId: "q_age", selection: "selected" } } } as const;
  assert.deepEqual([...setExprRefs(op.expr)], ["q_brands", "q_age"], "both sides of an operation are read");
  applyLogicProposal(def, [{ kind: "set_mask", questionId: "q_best", mask: null }]);
  assert.equal(def.questions.find((x) => x.id === "q_best")!.mask, undefined);
  assert.match(validateProposal(def, [{ kind: "set_mask", questionId: "q_best", mask: null }])[0], /no mask to remove/);
  assert.deepEqual(proposalTargets([{ kind: "set_mask", questionId: "q_best", mask }, { kind: "set_validation", questionId: "q_age", rules: [] }]), ["q_best", "q_age"]);
});
