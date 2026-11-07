import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type FlowNode } from "@rescript/schema";
import {
  createResponseState, evaluateExpression, calcOptionsFor, validateExpression, questionTextTemplate, effectiveQuestion,
  lintDynamicLogic, dynamicOutcomes, buildTernary, resolvePiping, questionDependencies,
  nextBranchTitle, nameBranch, splitBranchByQuestion, branchBlockChoices, moveBlockIntoBranch, insertFlowNode, ensureBranchNames,
} from "./index.js";

/** Ternary logic for dynamic question text and options, and branches that name themselves (2026-11-07). */

const TEXT = 'Q1 == "A" ? "What is your experience with Product A?" : Q1 == "B" ? "What is your experience with Product B?" : Q1 == "C" ? "What is your experience with Product C?" : "Please select an option."';
const def = (q2: Record<string, unknown> = {}) => SurveyDefinition.parse({
  meta: { id: "d", code: "D", title: "Dyn", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_choice", text: "Which product?", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }, { code: 3, label: "C" }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_choice", text: "Static text", options: [{ code: 1, label: "Great" }, { code: 2, label: "Fine" }, { code: 3, label: "Poor" }, { code: 4, label: "Never used" }], ...q2 },
    { id: "q3", code: "Q3", variableName: "Q3", type: "multi_select", text: "Which?", options: [{ code: "x", label: "X" }, { code: "y", label: "Y" }] },
  ],
  flow: [{ type: "page", id: "p1", title: "Intro", questionIds: ["q1"] }, { type: "page", id: "p2", title: "Experience", questionIds: ["q2"] }, { type: "page", id: "p3", title: "More", questionIds: ["q3"] }, { type: "end", id: "e", status: "complete" }],
});
const ctxFor = (d: SurveyDefinition, answers: Record<string, unknown>) => { const state = createResponseState(d, { seed: 1 }); Object.assign(state.answers, answers); return { def: d, state, loop: null }; };

test("calc: nested ternaries parse, right-associate and evaluate", () => {
  assert.equal(validateExpression(TEXT), null);
  const d = def();
  for (const [code, want] of [[1, "Product A"], [2, "Product B"], [3, "Product C"]] as const) {
    const v = evaluateExpression(TEXT, calcOptionsFor(d, ctxFor(d, { q1: code }).state));
    assert.match(String(v), new RegExp(want));
  }
  assert.equal(evaluateExpression(TEXT, calcOptionsFor(d, ctxFor(d, {}).state)), "Please select an option.");
  assert.equal(evaluateExpression("1 ? 2 : 3 ? 4 : 5", { resolver: () => undefined }), 2);
  assert.equal(evaluateExpression("0 ? 2 : 0 ? 4 : 5", { resolver: () => undefined }), 5);
  assert.equal(evaluateExpression("if(1 > 0, 1 ? \"a\" : \"b\", \"c\")", { resolver: () => undefined }), "a");
});

test("calc: a ? without : and a stray : are meaningful errors", () => {
  assert.match(validateExpression('Q1 == 1 ? "a"') ?? "", /needs its ":"/);
  assert.match(validateExpression('Q1 : "a"') ?? "", /needs a "\?"/);
});

test("calc: Q1 == \"A\" matches by label and by code; a multi-select matches any of its codes; equality that held still holds", () => {
  const d = def();
  const o = calcOptionsFor(d, ctxFor(d, { q1: 1, q3: ["x", "y"] }).state);
  assert.equal(evaluateExpression('Q1 == "A"', o), true);
  assert.equal(evaluateExpression('Q1 == "a "', o), true);
  assert.equal(evaluateExpression("Q1 == 1", o), true);
  assert.equal(evaluateExpression('Q1 == "B"', o), false);
  assert.equal(evaluateExpression('Q1 != "B"', o), true);
  assert.equal(evaluateExpression('Q3 == "y"', o), true);
  assert.equal(evaluateExpression('Q3 == "Y"', o), true);
  assert.equal(evaluateExpression('"a" == "a"', o), true);
});

test("dynamic text: the runtime template follows Q1, pipes inside the result, falls back to the static text", () => {
  const d = def({ dynamicText: { expression: 'Q1 == "A" ? "About {{Q1}} — tell us more" : ""' } });
  const q2 = d.questions[1];
  assert.equal(questionTextTemplate(q2, ctxFor(d, { q1: 1 })), "About {{Q1}} — tell us more");
  assert.equal(resolvePiping(questionTextTemplate(q2, ctxFor(d, { q1: 1 })), ctxFor(d, { q1: 1 })), "About A — tell us more");
  assert.equal(questionTextTemplate(q2, ctxFor(d, { q1: 2 })), "Static text");
  const broken = def({ dynamicText: { expression: "Q1 == ? :" } });
  assert.equal(questionTextTemplate(broken.questions[1], ctxFor(broken, { q1: 1 })), "Static text");
});

test("dynamic options: the set follows Q1, codes never change, an unknown set fails open, labels are dynamic", () => {
  const d = def({
    dynamicOptions: { expression: 'Q1 == "A" ? "1,2,3" : Q1 == "B" ? "1,4" : ""' },
    options: [{ code: 1, label: "Great", labelExpression: 'Q1 == "A" ? "Great for A" : ""' }, { code: 2, label: "Fine" }, { code: 3, label: "Poor" }, { code: 4, label: "Never used" }],
  });
  const q2 = d.questions[1];
  const a = effectiveQuestion(q2, ctxFor(d, { q1: 1 })).options;
  assert.deepEqual(a.map((o) => o.code), [1, 2, 3]);
  assert.equal(a[0].label, "Great for A");
  const b = effectiveQuestion(q2, ctxFor(d, { q1: 2 })).options;
  assert.deepEqual(b.map((o) => o.code), [1, 4]);
  assert.equal(b[0].label, "Great");
  const none = effectiveQuestion(q2, ctxFor(d, {})).options;
  assert.deepEqual(none.map((o) => o.code), [1, 2, 3, 4]);
});

test("lint: syntax, unknown names, later questions, self and unknown codes are reported", () => {
  const d = SurveyDefinition.parse({ ...def(), questions: def().questions.map((q) => q.id === "q2" ? { ...q, dynamicText: { expression: 'Q9 == 1 ? "x" : Q3 == "x" ? "y" : "z"' }, dynamicOptions: { expression: 'Q1 == "A" ? "1,7" : "1"' } } : q) });
  const p = lintDynamicLogic(d, d.questions[1]);
  assert.ok(p.some((x) => x.severity === "error" && /Q9/.test(x.message)));
  assert.ok(p.some((x) => x.severity === "warning" && /Q3 is asked after/.test(x.message)));
  assert.ok(p.some((x) => x.field === "options" && /code 7/.test(x.message)));
  const syn = def({ dynamicText: { expression: 'Q1 == "A" ? "x"' } });
  assert.ok(lintDynamicLogic(syn, syn.questions[1]).some((x) => /Syntax/.test(x.message)));
  assert.deepEqual(lintDynamicLogic(def({ dynamicText: { expression: TEXT } }), def({ dynamicText: { expression: TEXT } }).questions[1]), []);
});

test("outcomes: one row per answer of the source question, and the unanswered case", () => {
  const d = def({ dynamicText: { expression: TEXT }, dynamicOptions: { expression: buildTernary("Q1", [{ equals: "A", result: "1,2" }, { equals: "B", result: "3,4" }], "1,2,3,4") } });
  const o = dynamicOutcomes(d, d.questions[1]);
  assert.equal(o.source, "Q1");
  assert.equal(o.outcomes.length, 4);
  assert.match(o.outcomes[0].text!, /Product A/);
  assert.deepEqual(o.outcomes[1].optionCodes, ["3", "4"]);
  assert.equal(o.outcomes[3].when, "Q1 not answered");
});

test("dependencies: dynamic expressions and {{expr:}} pipes are edges", () => {
  const d = def({ dynamicText: { expression: TEXT } });
  assert.ok(questionDependencies(d, d.questions[1]).has("q1"));
  const e = def({ text: "Total {{expr: Q1 + 1}}" });
  assert.ok(questionDependencies(e, e.questions[1]).has("q1"));
});

test("branches: named at birth (unique), paths named from their conditions, a typed name is kept", () => {
  const d = def();
  const flow = d.flow as FlowNode[];
  const blank = { type: "branch", id: "b1", branches: [{ id: "x1", label: "Path 1", when: { type: "group", op: "and", children: [] }, children: [] }], otherwise: [] } as FlowNode;
  const r1 = insertFlowNode(flow, blank, { kind: "inside", ownerId: null, slot: "children", index: 1 });
  const r2 = insertFlowNode(r1.flow, { ...blank, id: "b2" } as FlowNode, { kind: "inside", ownerId: null, slot: "children", index: 1 });
  const titles = r2.flow.filter((n) => n.type === "branch").map((n) => (n as { title?: string }).title);
  assert.equal(new Set(titles).size, 2);
  assert.ok(titles.every((t) => /^Branch \d+$/.test(t!)));
  assert.equal(nextBranchTitle(r2.flow), "Branch 3");
  const b = r2.flow.find((n) => n.id === "b1") as Extract<FlowNode, { type: "branch" }>;
  const prev = structuredClone(b);
  b.branches[0].when = { type: "rule", source: { kind: "question", ref: "q1" }, operator: "selected", value: 1 } as never;
  nameBranch(d, b, { previous: prev, flow: r2.flow });
  assert.match(b.branches[0].label!, /Q1/);
  const prev2 = structuredClone(b);
  b.branches[0].label = "Product A buyers";
  b.branches[0].when = { type: "rule", source: { kind: "question", ref: "q1" }, operator: "selected", value: 2 } as never;
  nameBranch(d, b, { previous: prev2, flow: r2.flow });
  assert.equal(b.branches[0].label, "Product A buyers");
});

test("split by question: one uniquely named path per option, the branch named after the question", () => {
  const d = def();
  let n = 0;
  const b = splitBranchByQuestion(d, d.questions[0], (p) => `${p}_${++n}`);
  assert.ok(typeof b !== "string");
  if (typeof b === "string") return;
  assert.equal(b.title, "By Q1");
  assert.deepEqual(b.branches.map((x) => x.label), ["Q1 = A", "Q1 = B", "Q1 = C"]);
  assert.equal(typeof splitBranchByQuestion(d, { ...d.questions[0], options: [] }, (p) => p), "string");
});

test("existing blocks: blocks are selectable, questions never on their own, a block the branch reads stays out", () => {
  const d = def();
  const branch = { type: "branch", id: "bb", title: "Branch 1", branches: [{ id: "pA", label: "Q1 = A", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "selected", value: 1 }, children: [] }], otherwise: [] } as unknown as FlowNode;
  (d.flow as FlowNode[]).splice(1, 0, branch);
  const c = branchBlockChoices(d, "bb", "branch:pA");
  const intro = c.blocks.find((b) => b.id === "p1")!, exp = c.blocks.find((b) => b.id === "p2")!;
  assert.equal(intro.selectable, false);
  assert.match(intro.reason!, /read Q1/);
  assert.equal(exp.selectable, true);
  assert.ok(c.questions.every((q) => q.selectable === false && /select the whole block/.test(q.reason)));
  const bad = moveBlockIntoBranch(d, "Q2", "bb", "branch:pA");
  assert.equal(bad.moved, false);
  assert.match(bad.reason!, /is a question/);
  const ok = moveBlockIntoBranch(d, "p2", "bb", "branch:pA");
  assert.equal(ok.moved, true);
  const moved = ok.flow.find((n) => n.id === "bb") as Extract<FlowNode, { type: "branch" }>;
  assert.equal(moved.branches[0].children[0].id, "p2");
  assert.equal(ok.flow.some((n) => n.id === "p2"), false);
});

test("ensureBranchNames names an imported branch and its unlabelled paths", () => {
  const d = def();
  (d.flow as FlowNode[]).splice(1, 0, { type: "branch", id: "imp", branches: [{ id: "a", when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "selected", value: 1 }, children: [] }, { id: "b", when: { type: "group", op: "and", children: [] }, children: [] }] } as unknown as FlowNode);
  assert.equal(ensureBranchNames(d), 1);
  const b = (d.flow as FlowNode[])[1] as Extract<FlowNode, { type: "branch" }>;
  assert.equal(b.title, "Branch 1");
  assert.match(b.branches[0].label!, /Q1/);
  assert.equal(b.branches[1].label, "Path 2");
});

test("grid piping: a row's label, row – answer, one cell, unanswered rows are empty", () => {
  const d = SurveyDefinition.parse({
    meta: { id: "g", code: "G", title: "Grid", version: "1.0" },
    questions: [
      { id: "fam", code: "FAM", variableName: "FAM", type: "matrix_single", text: "Familiarity", rows: [{ code: "a", label: "Brand A" }, { code: "b", label: "Brand B" }, { code: "c", label: "Brand C" }], options: [{ code: 1, label: "Not at all Familiar" }, { code: 2, label: "Somewhat Familiar" }, { code: 3, label: "Most Familiar" }] },
      { id: "mm", code: "MM", variableName: "MM", type: "matrix_multi", text: "Used", rows: [{ code: "a", label: "Brand A" }], options: [{ code: 1, label: "Home" }, { code: 2, label: "Work" }] },
      { id: "why", code: "WHY", variableName: "WHY", type: "open_text", text: "You have chosen {{FAM[c].pair}}. Why?" },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["fam", "mm"] }, { type: "page", id: "p2", questionIds: ["why"] }],
  });
  const ctx = ctxFor(d, { fam: { a: 1, b: 3, c: 2 }, mm: { a: [1, 2] } });
  assert.equal(resolvePiping(d.questions[2].text, ctx), "You have chosen Brand C – Somewhat Familiar. Why?");
  assert.equal(resolvePiping("{{FAM[a].row}} – {{FAM[a]}}", ctx), "Brand A – Not at all Familiar");
  assert.equal(resolvePiping("[{{FAM[b:3]}}] [{{FAM[b:1]}}]", ctx), "[Most Familiar] []");
  assert.equal(resolvePiping("{{MM[a:2]}}", ctx), "Work");
  const empty = ctxFor(d, { fam: { a: 1 } });
  assert.equal(resolvePiping("[{{FAM[c].pair}}] [{{FAM[c].row}}]", empty), "[] [Brand C]");
});

import { applySurveyActions, coerceSurveyActions } from "./index.js";

test("Intelligent Mode: split_branch names paths by answer and moves whole existing blocks; a question is refused", () => {
  const d = def();
  let n = 0; const ids = (p: string) => `${p}_${++n}`;
  const c = coerceSurveyActions([{ op: "split_branch", question: "Q1", blocks: { A: ["Experience"] }, otherwise: ["More"] }]);
  assert.deepEqual(c.rejected, []);
  const r = applySurveyActions(d, c.actions, { ids });
  assert.deepEqual(r.errors, []);
  const b = (r.def.flow as FlowNode[]).find((x) => x.type === "branch") as Extract<FlowNode, { type: "branch" }>;
  assert.equal(b.title, "By Q1");
  assert.deepEqual(b.branches.map((p) => p.label), ["Q1 = A", "Q1 = B", "Q1 = C"]);
  assert.equal(b.branches[0].children[0].id, "p2");
  assert.equal(b.otherwise?.[0].id, "p3");
  const bad = applySurveyActions(r.def, coerceSurveyActions([{ op: "add_block_to_branch", branch: "By Q1", path: "Q1 = B", block: "Q2" }]).actions, { ids });
  assert.match(bad.errors.join(" "), /is a question/);
  const intro = applySurveyActions(r.def, coerceSurveyActions([{ op: "add_block_to_branch", branch: "By Q1", path: "2", block: "Intro" }]).actions, { ids });
  assert.match(intro.errors.join(" "), /read Q1/);
  const ren = applySurveyActions(r.def, coerceSurveyActions([{ op: "rename_branch", branch: "By Q1", title: "Product routing", paths: { "Q1 = A": "Product A" } }]).actions, { ids });
  const rb = (ren.def.flow as FlowNode[]).find((x) => x.type === "branch") as Extract<FlowNode, { type: "branch" }>;
  assert.equal(rb.title, "Product routing");
  assert.equal(rb.branches[0].label, "Product A");
});

test("Intelligent Mode: set_dynamic_text / set_dynamic_options build checked ternaries; bad references are refused", () => {
  const d = def();
  const r = applySurveyActions(d, coerceSurveyActions([
    { op: "set_dynamic_text", target: "Q2", by: "Q1", cases: { A: "About Product A?", "2": "About Product B?" }, otherwise: "Please select an option." },
    { op: "set_dynamic_options", target: "Q2", by: "Q1", cases: { A: [1, 2], B: [3, 4] } },
  ]).actions);
  assert.deepEqual(r.errors, []);
  const q2 = r.def.questions[1];
  assert.match(q2.dynamicText!.expression, /Q1 == "A" \? "About Product A\?"/);
  assert.equal(questionTextTemplate(q2, ctxFor(r.def, { q1: 2 })), "About Product B?");
  assert.deepEqual(effectiveQuestion(q2, ctxFor(r.def, { q1: 2 })).options.map((o) => o.code), [3, 4]);
  const bad = applySurveyActions(d, coerceSurveyActions([{ op: "set_dynamic_text", target: "Q2", expression: 'Q9 == 1 ? "x" : "y"' }]).actions);
  assert.match(bad.errors.join(" "), /Q9/);
  const badCode = applySurveyActions(d, coerceSurveyActions([{ op: "set_dynamic_options", target: "Q2", by: "Q1", cases: { A: [9] } }]).actions);
  assert.match(badCode.errors.join(" "), /no option 9/);
  assert.equal(badCode.def.questions[1].dynamicOptions, undefined);
});

test("create_branch from the copilot is named like a hand-made one", () => {
  const d = def();
  const r = applySurveyActions(d, coerceSurveyActions([{ op: "create_branch", blocks: ["Experience"], when: "Q1 = 1" }]).actions);
  assert.deepEqual(r.errors, []);
  const b = (r.def.flow as FlowNode[]).find((x) => x.type === "branch") as Extract<FlowNode, { type: "branch" }>;
  assert.equal(b.title, "Branch 1");
  assert.match(b.branches[0].label!, /Q1/);
});

import { selectedOtherCodes, validateQuestion, isUsState, matchesDateFormat } from "./index.js";

test("Excel 1: a constant-sum option flagged Other is selected once it holds an amount; its text never enters the total", () => {
  const d = SurveyDefinition.parse({
    meta: { id: "cs", code: "CS", title: "CS", version: "1.0" },
    questions: [{ id: "cs", code: "CS", variableName: "CS", type: "allocation", text: "Split 100", settings: { sumTarget: 100 }, options: [{ code: "a", label: "Apple" }, { code: "o", label: "Other", flags: ["other_specify"] }], validation: [{ kind: "sum_equals", value: 100 }] }],
    flow: [{ type: "page", id: "p", questionIds: ["cs"] }],
  });
  const q = d.questions[0];
  assert.deepEqual(selectedOtherCodes(q, { a: 100, o: 0 }), []);
  assert.deepEqual(selectedOtherCodes(q, { a: 60, o: 40 }), ["o"]);
});

test("Excel 2: matrix column logic — always hide and show-when columns follow the respondent", () => {
  const d = SurveyDefinition.parse({
    meta: { id: "m", code: "M", title: "M", version: "1.0" },
    questions: [
      { id: "own", code: "OWN", variableName: "OWN", type: "single_select", text: "Own?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
      { id: "mx", code: "MX", variableName: "MX", type: "composite", text: "Matrix", rows: [{ code: "r1", label: "Row" }], columns: [
        { id: "c1", label: "Price", responseType: "numeric", variableStem: "PRICE" },
        { id: "c2", label: "Hidden", responseType: "text", variableStem: "HID", logic: { visibility: "always_hide" } },
        { id: "c3", label: "Owners", responseType: "text", variableStem: "OWNC", logic: { visibility: "show_when", when: { type: "rule", source: { kind: "question", ref: "own" }, operator: "selected", value: 1 } } },
      ] },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["own"] }, { type: "page", id: "p2", questionIds: ["mx"] }],
  });
  const mx = d.questions[1];
  assert.deepEqual(effectiveQuestion(mx, ctxFor(d, { own: 1 })).columns.map((c) => c.id), ["c1", "c3"]);
  assert.deepEqual(effectiveQuestion(mx, ctxFor(d, { own: 2 })).columns.map((c) => c.id), ["c1"]);
});

test("Excel 3: open-end content types and the character range", () => {
  assert.ok(isUsState("CA") && isUsState("new york") && isUsState("District of Columbia") && !isUsState("Narnia"));
  assert.ok(matchesDateFormat("02/29/2024", "MM/DD/YYYY") && !matchesDateFormat("02/30/2024", "MM/DD/YYYY") && matchesDateFormat("2026-11-07", "YYYY-MM-DD") && !matchesDateFormat("07/11/2026x", "DD/MM/YYYY"));
  const mk = (validation: unknown[]) => SurveyDefinition.parse({ meta: { id: "t", code: "T", title: "T", version: "1.0" }, questions: [{ id: "t", code: "T", variableName: "T", type: "open_text", text: "?", validation }], flow: [{ type: "page", id: "p", questionIds: ["t"] }] });
  const errs = (validation: unknown[], v: unknown) => { const d = mk(validation); return validateQuestion(d, d.questions[0], v, { def: d, state: createResponseState(d), loop: null } as never).length; };
  assert.equal(errs([{ kind: "number_only" }], "12.5"), 0);
  assert.ok(errs([{ kind: "number_only" }], "12a") > 0);
  assert.equal(errs([{ kind: "text_only" }], "Mary-Jane O'Neil"), 0);
  assert.ok(errs([{ kind: "text_only" }], "R2D2") > 0);
  assert.equal(errs([{ kind: "length_range", value: { min: 2, max: 5 } }], "abc"), 0);
  assert.ok(errs([{ kind: "length_range", value: { min: 2, max: 5 } }], "abcdef") > 0);
  assert.ok(errs([{ kind: "us_state" }], "Atlantis") > 0);
  assert.ok(errs([{ kind: "date_format", value: "DD/MM/YYYY" }], "31/02/2026") > 0);
});

import { compileDynamicGrid } from "./index.js";

test("answer × option grid: per-answer option texts and hidden options compile to expressions the runtime runs", () => {
  const d = SurveyDefinition.parse({ meta: { id: "gr", code: "GR", title: "g", version: "1" }, questions: [
    { id: "yn", code: "YN", variableName: "YN", type: "single_select", text: "Own one?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    { id: "f", code: "F", variableName: "F", type: "single_select", text: "Follow-up", options: [{ code: 1, label: "Love it" }, { code: 2, label: "It's fine" }, { code: 3, label: "Would buy" }] },
  ], flow: [{ type: "page", id: "p1", questionIds: ["yn"] }, { type: "page", id: "p2", questionIds: ["f"] }] });
  const f = d.questions[1];
  const r = compileDynamicGrid(d, f, { source: "YN", cells: { "1": { "1": { text: "Love my one" }, "2": { text: "I'd love one" } }, "3": { "1": { hide: true } } } });
  assert.deepEqual(r.problems, []);
  f.options.forEach((o) => { const e = r.labels[String(o.code)]; if (e) o.labelExpression = e; });
  if (r.dynamicOptions) f.dynamicOptions = r.dynamicOptions;
  const yes = effectiveQuestion(f, ctxFor(d, { yn: 1 })).options, no = effectiveQuestion(f, ctxFor(d, { yn: 2 })).options;
  assert.deepEqual(yes.map((o) => o.label), ["Love my one", "It's fine"]);
  assert.deepEqual(no.map((o) => o.label), ["I'd love one", "It's fine", "Would buy"]);
  assert.deepEqual(lintDynamicLogic(d, f), []);
  const bad = compileDynamicGrid(d, f, { source: "YN", cells: { "1": { "1": { hide: true } }, "2": { "1": { hide: true } }, "3": { "1": { hide: true } } } });
  assert.match(bad.problems.join(), /every option is hidden/);
});
