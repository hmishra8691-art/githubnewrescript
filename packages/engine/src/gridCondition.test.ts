import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type Condition, type ConditionRule } from "@rescript/schema";
import {
  parseLogicExpression, formatCondition, evaluateCondition, createResponseState, setAnswer,
  canonicalizeCondition, canonicalizeSurveyConditions, normalizeGridRule, isCategoricalGrid,
  copyCondition, remapConditionReferences, duplicateQuestion, cloneQuestion, lintSurveyLogic,
  visibleQuestions, compileFlow, start, advance, conditionSummary,
} from "./index.js";

/**
 * MATRIX CONDITIONS AND EXPRESSION COPYING — the regression suite.
 *
 * The bugs this pins:
 *  · a matrix condition asked for the answer column AND a value, which are
 *    the same categorical answer; the evaluator read one of them and ignored
 *    the other;
 *  · text copied out of the expression editor and pasted back was not the
 *    same condition: zero-padded codes lost their zeros, quoted text could
 *    not be read back, "4" became 4, a column-only reference could not be
 *    written, `@option.code` printed as "[object Object]".
 */

const def = () => SurveyDefinition.parse({
  meta: { id: "g", code: "G", title: "Grid", version: "1.0" },
  questions: [
    {
      id: "q_sat", code: "Q1", variableName: "SAT", type: "matrix_single", text: "Rate each",
      options: [1, 2, 3, 4, 5].map((n) => ({ code: String(n), label: ["Poor", "Fair", "OK", "Good", "Great"][n - 1] })),
      rows: ["Service", "Price", "Quality"].map((label, i) => ({ code: String(i + 1), label, flags: [], validation: [], required: false })),
    },
    {
      id: "q_use", code: "Q2", variableName: "USE", type: "matrix_multi", text: "Which apply per channel",
      options: [{ code: "a", label: "Alpha" }, { code: "b", label: "Beta" }, { code: "c", label: "Gamma" }],
      rows: [{ code: "1", label: "Web", flags: [], validation: [], required: false }, { code: "2", label: "App", flags: [], validation: [], required: false }],
    },
    { id: "q_age", code: "Q3", variableName: "AGE", type: "numeric", text: "Age" },
    {
      id: "q_tab", code: "Q4", variableName: "TAB", type: "composite", text: "Per brand",
      rows: [{ code: "a", label: "Brand A", flags: [], validation: [], required: false }],
      columns: [
        { id: "spend", label: "Spend", responseType: "numeric", variableStem: "SPEND", options: [], validation: [], readOnly: false },
        { id: "note", label: "Note", responseType: "text", variableStem: "NOTE", options: [], validation: [], readOnly: false },
      ],
    },
    {
      id: "q_codes", code: "Q5", variableName: "CODES", type: "multi_select", text: "Zero padded",
      options: [{ code: "01", label: "One" }, { code: "02", label: "Two" }, { code: "10", label: "Ten" }],
    },
    { id: "q_open", code: "Q6", variableName: "OPEN", type: "text", text: "Why" },
    { id: "q_a", code: "A1", variableName: "A1", type: "text", text: "shown when Q1 row 1 is 4", displayLogic: { type: "group", op: "and", children: [] } },
    { id: "q_b", code: "B1", variableName: "B1", type: "text", text: "other" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q_sat", "q_use", "q_age", "q_tab", "q_codes", "q_open"] }, { type: "page", id: "p2", questionIds: ["q_a", "q_b"] }, { type: "end", id: "e", status: "complete" }],
});

const rule = (source: Record<string, unknown>, operator: string, value?: unknown, value2?: unknown): ConditionRule =>
  ({ type: "rule", source: { kind: "question", ...source }, operator, ...(value !== undefined ? { value } : {}), ...(value2 !== undefined ? { value2 } : {}) }) as ConditionRule;
const cell = (row: string | undefined, col: string, op: "selected" | "notSelected" = "selected", ref = "q_sat") =>
  rule({ ref, ...(row ? { rowCode: row } : {}), columnId: col }, op);

const holds = (d: SurveyDefinition, c: Condition, answers: Record<string, unknown>) => {
  const state = createResponseState(d);
  Object.assign(state.answers, answers);
  return evaluateCondition(c, { def: d, state, loop: null });
};

/* ====================== 1–2. single-select matrix: row + answer column, no value */

test("single-select matrix: row + answer column is a cell and carries no value", () => {
  const d = def();
  const c = cell("1", "4");
  assert.equal("value" in c, false, "no independent value");
  assert.equal(holds(d, c, { q_sat: { 1: "4", 2: "2" } }), true, "row 1 answered column 4");
  assert.equal(holds(d, c, { q_sat: { 1: "3", 2: "4" } }), false, "row 2 answered 4, row 1 did not");
  assert.equal(holds(d, c, { q_sat: { 2: "4" } }), false, "row 1 unanswered");
  assert.equal(holds(d, c, {}), false, "nothing answered");
});

test("row-level, column-level, cell-level and combined conditions are four different questions", () => {
  const d = def();
  const answers = { q_sat: { 1: "4", 2: "2", 3: "5" } };
  const rowAnswered = rule({ ref: "q_sat", rowCode: "2" }, "answered");
  const colAny = cell(undefined, "5");
  const colNone = cell(undefined, "1");
  assert.equal(holds(d, rowAnswered, answers), true, "row level");
  assert.equal(holds(d, colAny, answers), true, "column level: some row chose 5");
  assert.equal(holds(d, colNone, answers), false, "column level: nobody chose 1");
  assert.equal(holds(d, cell("3", "5"), answers), true, "cell level");
  assert.equal(holds(d, cell("3", "4"), answers), false, "cell level, other column");
  const both: Condition = { type: "group", op: "and", children: [cell("1", "4"), cell("2", "2")] };
  assert.equal(holds(d, both, answers), true, "combined");
  assert.equal(holds(d, both, { q_sat: { 1: "4", 2: "3" } }), false, "combined, one cell off");
});

test("not selected on a single-select cell, and on 'any row'", () => {
  const d = def();
  assert.equal(holds(d, cell("1", "4", "notSelected"), { q_sat: { 1: "3" } }), true);
  assert.equal(holds(d, cell("1", "4", "notSelected"), { q_sat: { 1: "4" } }), false);
  assert.equal(holds(d, cell("1", "4", "notSelected"), {}), true, "unanswered row is not that column");
  assert.equal(holds(d, cell(undefined, "4", "notSelected"), { q_sat: { 1: "3", 2: "3" } }), true, "no row chose 4");
  assert.equal(holds(d, cell(undefined, "4", "notSelected"), { q_sat: { 1: "3", 2: "4" } }), false);
});

/* ====================== 3. multi-select matrix: selected / not selected / answered */

test("multi-select matrix distinguishes selected, not selected and answered", () => {
  const d = def();
  const answers = { q_use: { 1: ["a", "c"], 2: [] } };
  assert.equal(holds(d, cell("1", "a", "selected", "q_use"), answers), true);
  assert.equal(holds(d, cell("1", "b", "selected", "q_use"), answers), false);
  assert.equal(holds(d, cell("1", "b", "notSelected", "q_use"), answers), true);
  assert.equal(holds(d, cell("1", "a", "notSelected", "q_use"), answers), false);
  assert.equal(holds(d, cell("2", "a", "notSelected", "q_use"), answers), true, "row 2 selected nothing");
  assert.equal(holds(d, rule({ ref: "q_use", rowCode: "1" }, "answered"), answers), true);
  assert.equal(holds(d, rule({ ref: "q_use", rowCode: "2" }, "answered"), answers), false, "an empty list is not an answer");
  assert.equal(holds(d, cell(undefined, "c", "selected", "q_use"), answers), true, "any row selected c");
});

/* ====================== 4–5. numeric and text matrices use their own inputs */

test("numeric: thresholds and the boundary", () => {
  const d = def();
  const over = rule({ ref: "q_age" }, "gt", 18);
  assert.equal(holds(d, over, { q_age: 18 }), false, "boundary excluded");
  assert.equal(holds(d, over, { q_age: 19 }), true);
  assert.equal(holds(d, rule({ ref: "q_age" }, "gte", 18), { q_age: 18 }), true, "boundary included");
  assert.equal(holds(d, rule({ ref: "q_age" }, "between", 18, 30), { q_age: 30 }), true);
  assert.equal(holds(d, rule({ ref: "q_age" }, "between", 18, 30), { q_age: 31 }), false);
  assert.equal(holds(d, over, { q_age: null }), false, "null");
  assert.equal(holds(d, over, { q_age: "abc" }), false, "invalid");
});

test("numeric and text matrix cells compare their own column with a number or text", () => {
  const d = def();
  const spend = rule({ ref: "q_tab", rowCode: "a", columnId: "spend" }, "gt", 10);
  const note = rule({ ref: "q_tab", rowCode: "a", columnId: "note" }, "contains", "late");
  const answers = { q_tab: { a: { spend: 12, note: "arrived late" } } };
  assert.equal(holds(d, spend, answers), true);
  assert.equal(holds(d, note, answers), true);
  assert.equal(holds(d, spend, { q_tab: { a: { spend: 10 } } }), false);
  assert.equal(holds(d, note, { q_tab: { a: { note: "on time" } } }), false);
  /* a cells-model column is NOT an option code: it is untouched by the grid normaliser */
  assert.equal(normalizeGridRule(d.questions.find((q) => q.id === "q_tab"), spend).changed, false);
});

test("ordinal comparison of a single-select row uses row + operator + value, with no column", () => {
  const d = def();
  const atLeast4 = rule({ ref: "q_sat", rowCode: "1" }, "gte", "4");
  assert.equal(holds(d, atLeast4, { q_sat: { 1: "5" } }), true);
  assert.equal(holds(d, atLeast4, { q_sat: { 1: "4" } }), true, "boundary");
  assert.equal(holds(d, atLeast4, { q_sat: { 1: "3" } }), false);
  assert.equal(holds(d, rule({ ref: "q_sat", rowCode: "1" }, "in", ["4", "5"]), { q_sat: { 1: "5" } }), true);
});

/* ====================== legacy conditions stay valid, or migrate without changing meaning */

test("legacy rule {row, selected, value} still evaluates, and migrates to the single form", () => {
  const d = def();
  const legacy = rule({ ref: "q_sat", rowCode: "1" }, "selected", "4");
  assert.equal(holds(d, legacy, { q_sat: { 1: "4" } }), true, "evaluates exactly as before");
  assert.equal(holds(d, legacy, { q_sat: { 1: "3" } }), false);
  const migrated = canonicalizeCondition(d, legacy).condition as ConditionRule;
  assert.deepEqual(migrated.source, { kind: "question", ref: "q_sat", rowCode: "1", columnId: "4" });
  assert.equal("value" in migrated, false);
  for (const a of [{ q_sat: { 1: "4" } }, { q_sat: { 1: "3" } }, {}]) {
    assert.equal(holds(d, migrated, a), holds(d, legacy, a), "same answer before and after migration");
  }
  assert.deepEqual(canonicalizeCondition(d, migrated).condition, migrated, "canonical form is a fixed point");
});

test("what the old builder wrote — column AND value — migrates to one reference; a disagreement keeps what was evaluated", () => {
  const d = def();
  const same = rule({ ref: "q_sat", rowCode: "2", columnId: "3" }, "selected", "3");
  assert.equal(normalizeGridRule(d.questions[0], same).conflict, undefined);
  assert.deepEqual((canonicalizeCondition(d, same).condition as ConditionRule).source.columnId, "3");

  const clash = rule({ ref: "q_sat", rowCode: "2", columnId: "1" }, "selected", "3");
  const r = canonicalizeCondition(d, clash);
  assert.equal((r.condition as ConditionRule).source.columnId, "3", "the value is what the evaluator compared, so it wins");
  assert.ok(r.changes.some((x) => /disagreed/.test(x)), "and the disagreement is reported");
  for (const a of [{ q_sat: { 2: "3" } }, { q_sat: { 2: "1" } }]) {
    assert.equal(holds(d, r.condition, a), holds(d, clash, a));
  }

  /* an ordinal comparison with a redundant column loses the column, not its meaning */
  const ord = rule({ ref: "q_sat", rowCode: "1", columnId: "4" }, "gte", "4");
  const o = canonicalizeCondition(d, ord).condition as ConditionRule;
  assert.equal(o.source.columnId, undefined);
  assert.equal(o.value, "4");
});

test("rules that are not a categorical grid cell pass through untouched", () => {
  const d = def();
  for (const [q, r] of [
    [d.questions[2], rule({ ref: "q_age" }, "gt", 3)],
    [d.questions[3], rule({ ref: "q_tab", rowCode: "a", columnId: "spend" }, "gt", 3)],
    [d.questions[4], rule({ ref: "q_codes" }, "selected", "01")],
    [d.questions[0], rule({ ref: "q_sat", count: { of: "selected", scope: "options" } }, "gte", 1)],
  ] as const) {
    const n = normalizeGridRule(q, r as ConditionRule);
    assert.equal(n.changed, false);
    assert.equal(n.rule, r, "the very same object");
  }
  assert.equal(isCategoricalGrid(d.questions[0]), true);
  assert.equal(isCategoricalGrid(d.questions[3]), false);
});

/* ====================== 6–9. copy: structure, references, codes — exact */

const SHAPES: Record<string, Condition> = {
  "multi option with leading zero": rule({ ref: "q_codes" }, "selected", "01"),
  "not selected with leading zero": rule({ ref: "q_codes" }, "notSelected", "02"),
  "matrix cell": cell("1", "4"),
  "matrix cell not selected": cell("2", "5", "notSelected"),
  "matrix column only": cell(undefined, "5"),
  "multi matrix cell": cell("1", "c", "selected", "q_use"),
  "matrix row answered": rule({ ref: "q_sat", rowCode: "3" }, "answered"),
  "matrix ordinal": rule({ ref: "q_sat", rowCode: "1" }, "gte", "4"),
  "numeric between": rule({ ref: "q_age" }, "between", 18, 30),
  "numeric text cell": rule({ ref: "q_tab", rowCode: "a", columnId: "spend" }, "gt", 10),
  "text with quotes": rule({ ref: "q_open" }, "eq", 'it\'s "x" \\ y'),
  "text that looks numeric": rule({ ref: "q_open" }, "eq", "4"),
  "list with leading zeros": rule({ ref: "q_codes" }, "containsAny", ["01", "10"]),
  "against another question": { type: "rule", source: { kind: "question", ref: "q_age" }, operator: "gt", value: { $question: "q_open" } } as ConditionRule,
  "nested": {
    type: "group", op: "and", children: [
      rule({ ref: "q_codes" }, "selected", "01"),
      { type: "group", op: "or", children: [cell("1", "5"), { type: "group", op: "not", children: [rule({ ref: "q_age" }, "gt", 3)] }] },
    ],
  },
};

test("copying an expression through text gives back the same condition — every shape", () => {
  const d = def();
  for (const [name, c] of Object.entries(SHAPES)) {
    const canon = canonicalizeCondition(d, c).condition;
    const text = formatCondition(d, canon);
    const back = parseLogicExpression(d, text);
    assert.deepEqual(back.errors, [], `${name}: “${text}” parses`);
    assert.deepEqual(back.condition, canon, `${name}: “${text}” is the same condition`);
    /* and copying the copy changes nothing further */
    assert.equal(formatCondition(d, back.condition), text, `${name}: stable text`);
  }
});

test("the same expression pasted into several questions is the same everywhere, and the source is untouched", () => {
  const d = def();
  const before = structuredClone(d);
  const text = formatCondition(d, canonicalizeCondition(d, SHAPES["nested"]).condition);
  const targets = ["q_a", "q_b", "q_open"];
  const pasted = targets.map((id) => {
    const parsed = parseLogicExpression(d, text).condition!;
    const q = d.questions.find((x) => x.id === id)!;
    q.displayLogic = parsed;
    return parsed;
  });
  assert.deepEqual(pasted[1], pasted[0]);
  assert.deepEqual(pasted[2], pasted[0]);
  /* what it refers to is still what it referred to — never the question it was pasted onto */
  const refs = JSON.stringify(pasted[0]);
  for (const id of ["q_codes", "q_sat", "q_age"]) assert.ok(refs.includes(id), `still reads ${id}`);
  for (const id of targets) assert.equal(refs.includes(`"${id}"`), false, `does not read ${id}`);
  for (const id of ["q_sat", "q_codes", "q_age"]) {
    assert.deepEqual(d.questions.find((x) => x.id === id), before.questions.find((x) => x.id === id), "source questions unchanged");
  }
});

test("copyCondition is exact and independent of its source", () => {
  const c = SHAPES["nested"];
  const copy = copyCondition(c);
  assert.deepEqual(copy, c);
  assert.notEqual(copy, c);
  (copy as any).children[0].value = "changed";
  assert.equal((c as any).children[0].value, "01", "editing the copy leaves the source alone");
});

test("matrix row / column references keep their identity through save and reload", () => {
  const d = def();
  const stored = canonicalizeCondition(d, { type: "group", op: "and", children: [cell("2", "4"), cell(undefined, "1", "notSelected")] }).condition;
  const reloaded = JSON.parse(JSON.stringify(stored)) as Condition;
  assert.deepEqual(reloaded, stored);
  assert.equal(formatCondition(d, reloaded), formatCondition(d, stored));
  /* a whole definition survives the same trip with its conditions intact */
  const withLogic = def();
  withLogic.questions.find((q) => q.id === "q_a")!.displayLogic = stored;
  const again = SurveyDefinition.parse(JSON.parse(JSON.stringify(withLogic)));
  assert.deepEqual(again.questions.find((q) => q.id === "q_a")!.displayLogic, stored);
});

test("renaming labels, retitling and reordering rows and columns keeps every reference", () => {
  const d = def();
  const c = canonicalizeCondition(d, { type: "group", op: "and", children: [cell("1", "4"), cell("3", "2", "notSelected"), rule({ ref: "q_codes" }, "selected", "02")] }).condition;
  const answers = { q_sat: { 1: "4", 3: "5" }, q_codes: ["02"] };
  assert.equal(holds(d, c, answers), true);
  const q = d.questions[0];
  q.rows.reverse();
  q.options.reverse();
  q.rows.forEach((r) => { r.label = `renamed ${r.label}`; });
  q.options.forEach((o) => { o.label = `new ${o.label}`; });
  q.code = "Q1_renamed";
  d.questions[4].options.reverse();
  assert.equal(holds(d, c, answers), true, "same answers, same result — references are ids and codes, not labels or positions");
  assert.equal(holds(d, c, { q_sat: { 1: "3", 3: "5" }, q_codes: ["02"] }), false);
  /* and the text view follows the new names without changing the stored condition */
  const text = formatCondition(d, c);
  assert.match(text, /Q1_renamed/);
  assert.deepEqual(parseLogicExpression(d, text).condition, c);
});

/* ====================== explicit remap vs duplication */

test("'remap references' is explicit, reports what it did, and never touches the input", () => {
  const d = def();
  const c = canonicalizeCondition(d, { type: "group", op: "and", children: [cell("1", "4"), rule({ ref: "q_age" }, "gt", 3)] }).condition;
  const before = structuredClone(c);
  const r = remapConditionReferences(c, { questions: { q_sat: "q_use" } }, d);
  assert.deepEqual(c, before, "input unchanged");
  assert.deepEqual(r.changes, ["Q1 → Q2"]);
  assert.equal((r.value as any).children[0].source.ref, "q_use");
  assert.equal((r.value as any).children[1].source.ref, "q_age", "other questions are not remapped");
  assert.equal(remapConditionReferences(c, {}, d).value, c, "an empty map returns the same tree");
});

test("duplicating a question points the copy's own rules at the copy, and nothing else moves", () => {
  const d = def();
  const self = d.questions.find((q) => q.id === "q_tab")!;
  self.skipLogic = [{ id: "sk", when: rule({ ref: "q_tab", rowCode: "a", columnId: "spend" }, "gt", 100), target: { kind: "end", status: "screened" } } as any];
  self.displayLogic = rule({ ref: "q_age" }, "gt", 17);
  const originalSnapshot = structuredClone(self);
  const copy = duplicateQuestion(d, "q_tab")!;
  assert.deepEqual(d.questions.find((q) => q.id === "q_tab"), originalSnapshot, "the original is untouched");
  const copied = (copy.skipLogic[0].when as ConditionRule);
  assert.equal(copied.source.ref, copy.id, "the copy's own rule reads the copy");
  assert.ok(copy.columns.some((c) => c.id === copied.source.columnId), "and the copy's own column");
  assert.equal((copy.displayLogic as ConditionRule).source.ref, "q_age", "a rule about another question still reads that question");
  const twice = duplicateQuestion(d, "q_tab")!;
  assert.deepEqual((twice.skipLogic[0].when as ConditionRule).source.ref, twice.id, "a second copy is equivalent");
});

/* ====================== display and skip logic at runtime, and re-evaluation upstream */

test("display logic reads the cell; changing an upstream answer re-evaluates the dependent", () => {
  const d = def();
  d.questions.find((q) => q.id === "q_a")!.displayLogic = cell("1", "4");
  d.questions.find((q) => q.id === "q_b")!.displayLogic = { type: "group", op: "not", children: [cell("1", "4")] };
  const state = createResponseState(d);
  const page = { kind: "page" as const, pageId: "p2", showTitle: false, questionIds: ["q_a", "q_b"], loop: null, sectionPath: [], nodePath: [] };
  const shown = () => visibleQuestions(d, page as any, state).map((q) => q.id);
  assert.deepEqual(shown(), ["q_b"], "nothing answered: the NOT shows, the cell does not");
  setAnswer(d, state, "q_sat", { 1: "4" });
  assert.deepEqual(shown(), ["q_a"], "answered 4: flips");
  setAnswer(d, state, "q_sat", { 1: "2" });
  assert.deepEqual(shown(), ["q_b"], "changed upstream: no stale visibility");
  setAnswer(d, state, "q_sat", { 1: "4", 2: "4" });
  assert.deepEqual(shown(), ["q_a"]);
});

test("skip logic on a row + column routes the respondent, and not when the cell differs", () => {
  const route = (answer: Record<string, string>) => {
    const d = def();
    d.questions.find((q) => q.id === "q_sat")!.skipLogic = [{ id: "sk1", when: cell("1", "5"), target: { kind: "end", status: "screened" } } as any];
    const state = createResponseState(d);
    start(d, state);
    setAnswer(d, state, "q_sat", answer);
    const nav = advance(d, state);
    return nav;
  };
  const hit = route({ 1: "5" });
  assert.equal(hit.done, true);
  assert.equal(hit.endStatus, "screened");
  assert.equal(hit.triggeredSkips.length, 1);
  const miss = route({ 1: "4" });
  assert.equal(miss.triggeredSkips.length, 0);
  assert.equal(route({ 2: "5" }).triggeredSkips.length, 0, "another row chose 5");
});

/* ====================== linting: stale and conflicting references are reported, not silently false */

test("a reference to a row or answer that no longer exists is reported and evaluates false", () => {
  const d = def();
  const c = cell("9", "4");
  assert.equal(holds(d, c, { q_sat: { 1: "4" } }), false);
  d.questions.find((q) => q.id === "q_a")!.displayLogic = c;
  const issues = lintSurveyLogic(d);
  assert.ok(issues.some((i: any) => /row/i.test(String(i.message ?? i.text ?? ""))), JSON.stringify(issues).slice(0, 400));
});

test("repairing a whole survey migrates every grid rule once, and unrelated rules stay as they were", () => {
  const d = def();
  d.questions.find((q) => q.id === "q_a")!.displayLogic = rule({ ref: "q_sat", rowCode: "1" }, "selected", "4");
  d.questions.find((q) => q.id === "q_b")!.displayLogic = rule({ ref: "q_age" }, "gt", 3);
  const out = canonicalizeSurveyConditions(d);
  const a = out.def.questions.find((q) => q.id === "q_a")!.displayLogic as ConditionRule;
  assert.equal(a.source.columnId, "4");
  assert.deepEqual(out.def.questions.find((q) => q.id === "q_b")!.displayLogic, d.questions.find((q) => q.id === "q_b")!.displayLogic);
  const again = canonicalizeSurveyConditions(out.def);
  assert.deepEqual(again.changes, [], "running it twice changes nothing");
});

test("a canonical cell has no 'no value set' warning, a spelled-twice rule is flagged, and the summary reads as a sentence", () => {
  const d = def();
  d.questions.find((q) => q.id === "q_a")!.displayLogic = cell("1", "4");
  const clean = lintSurveyLogic(d).map((i: any) => i.message);
  assert.equal(clean.some((m: string) => /has no value set/.test(m)), false, clean.join(" | "));
  assert.equal(conditionSummary(d, cell("1", "4")), "Q1 row “Service” is “Good”");
  assert.equal(conditionSummary(d, cell("1", "4", "notSelected")), "Q1 row “Service” is not “Good”");

  d.questions.find((q) => q.id === "q_a")!.displayLogic = rule({ ref: "q_sat", rowCode: "1", columnId: "2" }, "selected", "4");
  const flagged = lintSurveyLogic(d).map((i: any) => i.message);
  assert.ok(flagged.some((m: string) => /disagreed/.test(m)), flagged.join(" | "));

  d.questions.find((q) => q.id === "q_a")!.displayLogic = rule({ ref: "q_sat", rowCode: "1", columnId: "2" }, "answered");
  assert.ok(lintSurveyLogic(d).some((i: any) => /ignores the column/.test(i.message)));
});

test("save → reload → export/import → duplicate: canonical grid and displayed conditions come back identical", () => {
  const d = def();
  const conditions: Condition[] = [
    cell("1", "4"),
    rule({ ref: "q_sat", rowCode: "2" }, "gte", "3"),
    cell("2", "b", "notSelected", "q_use"),
    rule({ ref: "q_codes" }, "contains", "01"),
    rule({ ref: "q_use" }, "displayed", "1"),
    rule({ ref: "q_codes" }, "notDisplayed", "02"),
  ];
  const withLogic = SurveyDefinition.parse({
    ...d,
    questions: d.questions.map((q) => q.id === "q_a" ? { ...q, displayLogic: { type: "group", op: "and", children: conditions } } : q),
  });
  const first = canonicalizeSurveyConditions(withLogic).def;
  const logicOf = (x: SurveyDefinition) => JSON.stringify(x.questions.find((q) => q.id === "q_a")!.displayLogic);
  const before = logicOf(first);
  /* save + reload (JSON text and back) */
  const reloaded = canonicalizeSurveyConditions(SurveyDefinition.parse(JSON.parse(JSON.stringify(first)))).def;
  assert.equal(logicOf(reloaded), before);
  /* export + import: through the expression text and back */
  const text = formatCondition(first, first.questions.find((q) => q.id === "q_a")!.displayLogic as Condition);
  const back = parseLogicExpression(first, text);
  assert.deepEqual(back.errors, []);
  assert.equal(JSON.stringify(back.condition), JSON.stringify(first.questions.find((q) => q.id === "q_a")!.displayLogic));
  /* project duplication: a structural clone is the same survey, and canonicalising it again changes nothing */
  const cloned = canonicalizeSurveyConditions(SurveyDefinition.parse(structuredClone(first))).def;
  assert.equal(logicOf(cloned), before);
});
