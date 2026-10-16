import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, BUILTIN_QUESTION_TYPES, responseModelOf, type ConditionRule } from "@rescript/schema";
import {
  parseLogicExpression, formatCondition, evaluateCondition, createResponseState, setAnswer,
  conditionSummary, lintSurveyLogic, displayRuleTargets, DESIGN_TASK_TYPES, QUESTION_NODE_TAGS,
} from "./index.js";

/**
 * P3 batch (2026-10-16, engineer L): LOGIC-05/07/08/09/15/16, AI-10 and the
 * engine half of METHOD-13. Each test names the register row it holds.
 */

const row = (code: string, label: string) => ({ code, label, flags: [], validation: [], required: false });
const col = (id: string, label: string, responseType: string, options: { code: string; label: string }[] = []) =>
  ({ id, label, responseType, variableStem: id.toUpperCase(), options, validation: [], readOnly: false });
const scale = [{ code: "1", label: "Poor" }, { code: "2", label: "OK" }, { code: "3", label: "Great" }];

const gridDef = () => SurveyDefinition.parse({
  meta: { id: "g", code: "G", title: "Grid", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "SAT", type: "matrix_single", text: "Rate", options: scale, rows: [row("1", "Service"), row("2", "Price")] },
    { id: "q2", code: "Q2", variableName: "USE", type: "matrix_multi", text: "Which",
      options: [{ code: "a", label: "Alpha" }, { code: "b", label: "Beta" }], rows: [row("1", "Web"), row("2", "App")] },
    { id: "q5", code: "Q5", variableName: "TAB", type: "composite", text: "Per brand", rows: [row("a", "Brand A"), row("b", "Brand B")],
      columns: [col("spend", "Spend", "numeric"), col("note", "Note", "text")] },
    /* a composite whose column id is also a row code: the short form would read as the row */
    { id: "q6", code: "Q6", variableName: "CLASH", type: "composite", text: "Clash", rows: [row("x", "Row X"), row("total", "Total row")],
      columns: [col("total", "Total", "numeric")] },
    /* a per-row grid that also carries a `columns` array (a scale holder) */
    { id: "q7", code: "Q7", variableName: "SAT7", type: "matrix_single", text: "Rate w/ columns", options: scale,
      columns: [col("c1", "Answer", "single", scale)], rows: [row("1", "Service"), row("2", "Price")] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q5", "q6", "q7"] }, { type: "end", id: "e", status: "complete" }],
});

const answered = () => {
  const def = gridDef();
  const state = createResponseState(def);
  setAnswer(def, state, "q1", { "1": "3", "2": "1" }, null);
  setAnswer(def, state, "q2", { "1": ["a", "b"], "2": ["b"] }, null);
  setAnswer(def, state, "q5", { a: { spend: 120, note: "ok" }, b: { spend: 20 } }, null);
  setAnswer(def, state, "q6", { x: { total: 5 }, total: { total: 50 } }, null);
  setAnswer(def, state, "q7", { "1": "3", "2": "1" }, null);
  return { def, ctx: { def, state, loop: null } };
};

const roundTrip = (def: SurveyDefinition, rule: ConditionRule) => {
  const printed = formatCondition(def, rule);
  const back = parseLogicExpression(def, printed);
  assert.deepEqual(back.errors, [], `${printed} re-parses`);
  return { printed, back: back.condition as ConditionRule };
};

test("LOGIC-07: a column-only composite reference can be typed, and round-trips through the expression editor", () => {
  const { def, ctx } = answered();
  const typed = parseLogicExpression(def, "Q5.spend > 100");
  assert.deepEqual(typed.errors, []);
  assert.deepEqual((typed.condition as ConditionRule).source, { kind: "question", ref: "q5", columnId: "spend" });
  assert.equal(evaluateCondition(typed.condition!, ctx), true, "a row with spend 120 matches");
  assert.equal(evaluateCondition(parseLogicExpression(def, "Q5.Spend > 500").condition!, ctx), false, "by label, and no row spends 500");

  for (const rule of [
    { type: "rule", source: { kind: "question", ref: "q5", columnId: "spend" }, operator: "gt", value: 100 },
    { type: "rule", source: { kind: "question", ref: "q5", columnId: "note" }, operator: "contains", value: "ok" },
  ] as ConditionRule[]) {
    const { back } = roundTrip(def, rule);
    assert.deepEqual(back.source, rule.source, "the builder's rule comes back as itself");
    assert.equal(back.operator, rule.operator);
  }
  // a column whose id is also a row's code prints with the explicit `$any`, so it does not come back as the row
  const clash = { type: "rule", source: { kind: "question", ref: "q6", columnId: "total" }, operator: "gte", value: 10 } as ConditionRule;
  const { printed, back } = roundTrip(def, clash);
  assert.equal(printed, "Q6.$any.total >= 10");
  assert.deepEqual(back.source, clash.source);
  assert.equal(evaluateCondition(back, ctx), true);
  assert.match(parseLogicExpression(def, "Q5.$any").errors[0].message, /needs a column after \$any/);
  // the short form still names the ROW when it is one
  assert.deepEqual((parseLogicExpression(def, "Q6.total").condition as ConditionRule).source, { kind: "question", ref: "q6", rowCode: "total" });
});

test("LOGIC-08: a third segment resolves by label, and `C` takes a non-numeric code", () => {
  const { def, ctx } = answered();
  const cases: [string, Partial<ConditionRule["source"]>, boolean][] = [
    ["Q1.R1.Great", { rowCode: "1", columnId: "3" }, true],
    ["Q1.Service.Great", { rowCode: "1", columnId: "3" }, true],
    ["Q1.Price.great", { rowCode: "2", columnId: "3" }, false],
    ["Q2.R1.Alpha", { rowCode: "1", columnId: "a" }, true],
    ["Q2.R1.Ca", { rowCode: "1", columnId: "a" }, true],
    ["Q2.R2.Ca", { rowCode: "2", columnId: "a" }, false],
    ["Q5.R1.Spend > 100", { rowCode: "a", columnId: "spend" }, true],
  ];
  for (const [text, source, truth] of cases) {
    const r = parseLogicExpression(def, text);
    assert.deepEqual(r.errors, [], text);
    const c = r.condition as ConditionRule;
    assert.deepEqual({ rowCode: c.source.rowCode, columnId: c.source.columnId }, source, text);
    assert.equal(evaluateCondition(c, ctx), truth, `${text} evaluates`);
    roundTrip(def, c);
  }
  assert.match(parseLogicExpression(def, "Q1.R1.Superb").errors[0].message, /Q1\.R1 has no “Superb”/, "an unknown label is still refused");
});

test("LOGIC-09: a per-row grid carrying a `columns` array resolves C<n> against its scale, not the column", () => {
  const { def, ctx } = answered();
  const c1 = parseLogicExpression(def, "Q7.R1.C1").condition as ConditionRule;
  assert.equal(c1.source.columnId, "1", "C1 is scale point 1, not column `c1`");
  assert.equal(evaluateCondition(c1, ctx), false, "row 1 answered 3, not 1");
  const c3 = parseLogicExpression(def, "Q7.R1.C3").condition as ConditionRule;
  assert.equal(c3.source.columnId, "3");
  assert.equal(evaluateCondition(c3, ctx), true);
  assert.equal(formatCondition(def, c3), "Q7.R1.C3");
  assert.deepEqual(roundTrip(def, c3).back, c3);
  assert.equal((parseLogicExpression(def, "Q7.R1.Great").condition as ConditionRule).source.columnId, "3");
  assert.equal(conditionSummary(def, c3), "Q7 row “Service” is “Great”", "the summary reads the scale too");
});

test("LOGIC-16: conditionSummary narrates a legacy double-spelled grid rule as the one cell it means", () => {
  const { def } = answered();
  const legacy = [
    { type: "rule", source: { kind: "question", ref: "q1", rowCode: "1", columnId: "2" }, operator: "selected", value: "3" },
    { type: "rule", source: { kind: "question", ref: "q1", rowCode: "1", columnId: "2" }, operator: "eq", value: "3" },
  ] as ConditionRule[];
  for (const r of legacy) {
    const s = conditionSummary(def, r);
    assert.equal(s, "Q1 row “Service” is “Great”", JSON.stringify(r));
    assert.doesNotMatch(s, /OK/, "the stale column is not narrated");
  }
});

test("LOGIC-15: a per-row grid's options are offered as scale points (columns) in display-rule targets", () => {
  const def = gridDef();
  const t = displayRuleTargets(def);
  const q1 = t.find((x) => x.kind === "option" && x.ref === "q1")!;
  assert.match(q1.label, /scale point \(column\)/);
  assert.equal(q1.itemsLabel, "scale point (column)");
  assert.equal(q1.items![0].label, "scale point 1 — Poor");
  const flat = SurveyDefinition.parse({
    meta: { id: "f", code: "F", title: "F", version: "1" },
    questions: [{ id: "a", code: "A", variableName: "A", type: "single_select", text: "Pick", options: [{ code: "1", label: "Yes" }] }],
    flow: [{ type: "page", id: "p", questionIds: ["a"] }],
  });
  const opt = displayRuleTargets(flat).find((x) => x.kind === "option")!;
  assert.equal(opt.itemsLabel, undefined, "an ordinary question's options stay options");
  assert.equal(opt.items![0].label, "1 — Yes");
});

const skipDef = (targets: { kind: string; ref?: string }[], extraFlow: unknown[] = []) => SurveyDefinition.parse({
  meta: { id: "f", code: "F", title: "Flow", version: "1" },
  questions: [
    { id: "q0", code: "Q0", variableName: "Q0", type: "open_text", text: "intro" },
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "x", options: [{ code: "1", label: "Yes" }],
      skipLogic: targets.map((target, i) => ({ id: `sk${i}`, when: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: "1" }, target })) },
    { id: "q2", code: "Q2", variableName: "Q2", type: "open_text", text: "same page" },
    { id: "q3", code: "Q3", variableName: "Q3", type: "open_text", text: "later" },
  ],
  flow: [
    { type: "page", id: "p0", questionIds: ["q0"] },
    { type: "page", id: "p1", questionIds: ["q1", "q2"] },
    { type: "block", id: "b2", title: "Later", children: [{ type: "page", id: "p2", questionIds: ["q3"] }] },
    ...extraFlow,
    { type: "end", id: "e", status: "complete" },
  ],
});
const skipErrors = (def: SurveyDefinition) => lintSurveyLogic(def).filter((i) => i.path.endsWith(".target"));

test("LOGIC-05: a backward, same-page or missing skip target is an error; a forward one is not", () => {
  const bad = skipErrors(skipDef([
    { kind: "question", ref: "q0" }, { kind: "question", ref: "qZZ" }, { kind: "question", ref: "q2" },
    { kind: "page", ref: "p0" }, { kind: "page", ref: "nope" }, { kind: "block", ref: "missing" }, { kind: "question" },
  ]));
  const msgs = bad.map((i) => i.message);
  assert.ok(bad.every((i) => i.level === "error" && i.questionCode === "Q1"));
  assert.match(msgs[0], /^Skip from Q1 goes back to Q0 — skips can only move forward/);
  assert.match(msgs[1], /^Skip target qZZ does not exist — skip rule 2 on Q1 falls through/);
  assert.match(msgs[2], /^Skip from Q1 goes to Q2 on its own page — skips can only move forward to a later page/);
  assert.match(msgs[3], /^Skip from Q1 goes back to p0/);
  assert.match(msgs[4], /^Skip target page nope does not exist/);
  assert.match(msgs[5], /^Skip target block missing does not exist/);
  assert.match(msgs[6], /^Skip rule 7 on Q1 has no target question/);
  assert.equal(bad.length, 7);

  // forward targets, end/terminate: no error
  assert.deepEqual(skipErrors(skipDef([
    { kind: "question", ref: "q3" }, { kind: "page", ref: "p2" }, { kind: "block", ref: "b2" }, { kind: "block", ref: "Later" }, { kind: "end" }, { kind: "terminate" },
  ])), []);
});

test("LOGIC-05: inside a loop the order is decided at run time, so a backward target there is not flagged", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "l", code: "L", title: "Loop", version: "1" },
    questions: [
      { id: "a", code: "A", variableName: "A", type: "open_text", text: "a" },
      { id: "b", code: "B", variableName: "B", type: "single_select", text: "b", options: [{ code: "1", label: "Again" }],
        skipLogic: [{ id: "s", when: { type: "rule", source: { kind: "question", ref: "b" }, operator: "eq", value: "1" }, target: { kind: "question", ref: "a" } }] },
    ],
    flow: [{ type: "loop", id: "L1", loopVar: "item", source: { kind: "static", items: [{ code: "1", label: "One" }, { code: "2", label: "Two" }] },
      children: [{ type: "page", id: "pa", questionIds: ["a"] }, { type: "page", id: "pb", questionIds: ["b"] }] }],
  });
  assert.deepEqual(skipErrors(def), []);
});

test("AI-10: an unquoted option label names the option and shows both ways to write it", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "g", code: "G", title: "x", version: "1" },
    questions: [{ id: "q1", code: "PREF", variableName: "PREF", type: "single_select", text: "Pref",
      options: [{ code: "1", label: "Brand A" }, { code: "2", label: "Brand B" }] }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }],
  });
  const r = parseLogicExpression(def, "PREF = Brand A");
  assert.equal(r.errors[0].message, "“Brand A” is the option \"Brand A\" of PREF, written without quotes — a label with spaces must be quoted (PREF = \"Brand A\") or replaced by its code (PREF = 1).");
  assert.equal(r.errors[0].suggestion, "PREF = 1");
  const fixed = parseLogicExpression(def, r.errors[0].suggestion!);
  assert.deepEqual(fixed.errors, [], "the suggestion parses");
  assert.deepEqual(parseLogicExpression(def, "PREF = \"Brand A\"").errors, [], "the quoted form parses");
  assert.match(parseLogicExpression(def, "PREF != Brand B").errors[0].message, /\(PREF != "Brand B"\) or replaced by its code \(PREF != 2\)/);
  assert.match(parseLogicExpression(def, "PREF = BrandA").errors[0].message, /did you mean Brand A\? Write an option label in quotes \(PREF = "Brand A"\) or use its code \(PREF = 1\)/);
});

test("METHOD-13: every design-rendered (tasks) question type is in the design lint and the logic graph", () => {
  const tasks = BUILTIN_QUESTION_TYPES.filter((t) => responseModelOf(t) === "tasks");
  assert.ok(tasks.includes("acbc_task"));
  for (const t of BUILTIN_QUESTION_TYPES) {
    const isTask = tasks.includes(t);
    assert.equal((DESIGN_TASK_TYPES as readonly string[]).includes(t), isTask, `design-ref lint knows ${t} (renders from a design: ${isTask})`);
    if (isTask) assert.ok(QUESTION_NODE_TAGS[t], `logic graph tags ${t}`);
  }
  const def = (designs: unknown[], designRef?: string) => SurveyDefinition.parse({
    meta: { id: "a", code: "A", title: "ACBC", version: "1" },
    questions: [{ id: "q", code: "Q9", variableName: "Q9", type: "acbc_task", text: "Build", settings: designRef ? { designRef } : {} }],
    flow: [{ type: "page", id: "p", questionIds: ["q"] }],
    designs,
  });
  const designErrors = (d: SurveyDefinition) => lintSurveyLogic(d).filter((i) => i.path.startsWith("settings.design")).map((i) => i.message);
  assert.match(designErrors(def([]))[0], /Q9 renders tasks from a design file, but no design is selected/);
  assert.match(designErrors(def([], "d1"))[0], /refers to design “d1”, which is not in this survey/);
  const md = { id: "d1", name: "MD", kind: "maxdiff", config: {} };
  assert.match(designErrors(def([md], "d1"))[0], /Q9 is an adaptive conjoint \(ACBC\) question but design “d1” is a maxdiff design/);
  assert.deepEqual(designErrors(def([{ ...md, kind: "acbc" }], "d1")), []);
});
