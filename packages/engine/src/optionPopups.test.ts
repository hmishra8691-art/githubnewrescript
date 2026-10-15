import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, type ConditionRule } from "@rescript/schema";
import {
  createResponseState, setAnswer, evaluateCondition, canonicalizeSurveyConditions, effectiveQuestion,
  popupsOnChange, popupsOnNext, markPopupSeen, unmarkPopupSeen, resetPopupsSeen, parseLogicExpression, formatCondition,
  gridCellOperators, withGridOperator,
} from "./index.js";

/**
 * Per-option popup messages, the Display operator, and the retirement of
 * "Show when…" / "Hide when…" — the engine half. (The dialog itself and the
 * Next gate are covered by the browser suite.)
 */

const popup = (over: Record<string, unknown> = {}) => ({ enabled: true, message: "Heads up", type: "information", trigger: "immediate", frequency: "every", ...over });

const def = (opts: Record<string, unknown>[] = []) => SurveyDefinition.parse({
  meta: { id: "p", code: "P", title: "Popups", version: "1.0" },
  questions: [
    { id: "q_gate", code: "G", variableName: "GATE", type: "single_select", text: "Gate", options: [{ code: "1", label: "Yes" }, { code: "2", label: "No" }] },
    {
      id: "q_m", code: "M", variableName: "M", type: "multi_select", text: "Pick",
      options: opts.length ? opts : [
        { code: "a", label: "A", logic: { popup: popup({ message: "A chosen" }) } },
        { code: "b", label: "B", logic: { popup: popup({ type: "confirmation", trigger: "on_next", frequency: "once", message: "Sure?" }) } },
        { code: "c", label: "C" },
        { code: "d", label: "D", logic: { popup: popup({ enabled: false }) } },
        { code: "e", label: "E", logic: { popup: popup({ message: "   " }) } },
      ],
    },
    {
      id: "q_grid", code: "X", variableName: "X", type: "matrix_single", text: "Grid", options: [{ code: "1", label: "Lo" }, { code: "2", label: "Hi" }],
      rows: ["r1", "r2"].map((c) => ({ code: c, label: c, flags: [], validation: [], required: false })),
    },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q_gate", "q_m", "q_grid"] }, { type: "end", id: "e", status: "complete" }],
});

const q = (d: ReturnType<typeof def>, id: string) => d.questions.find((x) => x.id === id)!;

test("popup: selecting an option with a popup asks for exactly that message", () => {
  const d = def(), st = createResponseState(d);
  const r = popupsOnChange(d, q(d, "q_m"), st, null, [], ["a"]);
  assert.equal(r.length, 1);
  assert.equal(r[0].code, "a");
  assert.equal(r[0].message, "A chosen");
  assert.equal(r[0].buttonText, "OK");
});

test("popup: deselecting never shows a message, and only ADDED options count", () => {
  const d = def(), st = createResponseState(d);
  assert.equal(popupsOnChange(d, q(d, "q_m"), st, null, ["a"], []).length, 0);
  assert.equal(popupsOnChange(d, q(d, "q_m"), st, null, ["a"], ["a", "c"]).length, 0, "a was already selected");
  assert.equal(popupsOnChange(d, q(d, "q_m"), st, null, ["a"], ["c"]).length, 0);
});

test("popup: disabled, empty and message-less popups are never shown", () => {
  const d = def(), st = createResponseState(d);
  for (const code of ["c", "d", "e"]) assert.equal(popupsOnChange(d, q(d, "q_m"), st, null, [], [code]).length, 0, code);
});

test("popup: the trigger decides WHEN — immediate fires on change, on_next fires on Next", () => {
  const d = def(), st = createResponseState(d);
  assert.equal(popupsOnChange(d, q(d, "q_m"), st, null, [], ["b"]).length, 0, "b waits for Next");
  const next = popupsOnNext(d, q(d, "q_m"), st, null, ["a", "b"]);
  assert.deepEqual(next.map((x) => x.code), ["b"], "a is immediate, so it is not repeated on Next");
  assert.equal(next[0].type, "confirmation");
  assert.equal(next[0].buttonText, "Continue");
});

test("popup: 'only once' is remembered per respondent and per question, and a cancel can take it back", () => {
  const d = def(), st = createResponseState(d);
  resetPopupsSeen();
  assert.equal(popupsOnNext(d, q(d, "q_m"), st, null, ["b"]).length, 1);
  markPopupSeen(st, "q_m", null, "b");
  assert.equal(popupsOnNext(d, q(d, "q_m"), st, null, ["b"]).length, 0, "already shown");
  unmarkPopupSeen(st, "q_m", null, "b");
  assert.equal(popupsOnNext(d, q(d, "q_m"), st, null, ["b"]).length, 1, "cancelled, so it asks again");
  const other = createResponseState(d);
  markPopupSeen(st, "q_m", null, "b");
  assert.equal(popupsOnNext(d, q(d, "q_m"), other, null, ["b"]).length, 1, "another respondent is unaffected");
});

test("popup: 'every selection' repeats after deselect and reselect", () => {
  const d = def(), st = createResponseState(d);
  assert.equal(popupsOnChange(d, q(d, "q_m"), st, null, [], ["a"]).length, 1);
  assert.equal(popupsOnChange(d, q(d, "q_m"), st, null, ["a"], []).length, 0);
  assert.equal(popupsOnChange(d, q(d, "q_m"), st, null, [], ["a"]).length, 1);
});

test("popup: single-select scalars work, and an option the respondent cannot see has no popup", () => {
  const d = def([
    { code: "a", label: "A", logic: { popup: popup() } },
    { code: "b", label: "B", logic: { popup: popup(), excludeWhen: { type: "rule", source: { kind: "question", ref: "q_gate" }, operator: "selected", value: "1" } } },
  ]);
  const st = createResponseState(d);
  assert.equal(popupsOnChange(d, q(d, "q_m"), st, null, undefined, "a").length, 1);
  assert.equal(popupsOnChange(d, q(d, "q_m"), st, null, undefined, "b").length, 1, "b is visible while the gate is open");
  setAnswer(d, st, "q_gate", "1");
  assert.equal(popupsOnChange(d, q(d, "q_m"), st, null, undefined, "b").length, 0, "b is excluded now");
});

test("popup: it is independent of other rules — an option with eligibility AND a popup keeps both", () => {
  const d = def([{ code: "a", label: "A", logic: { popup: popup(), eligibleWhen: { type: "rule", source: { kind: "question", ref: "q_gate" }, operator: "selected", value: "2" } } }]);
  const st = createResponseState(d);
  assert.equal((effectiveQuestion(q(d, "q_m"), { def: d, state: st, loop: null }).options ?? []).length, 0, "ineligible");
  setAnswer(d, st, "q_gate", "2");
  assert.equal((effectiveQuestion(q(d, "q_m"), { def: d, state: st, loop: null }).options ?? []).length, 1);
  assert.equal(popupsOnChange(d, q(d, "q_m"), st, null, [], ["a"]).length, 1);
});

/* ------------------------------------------------------------- Display operator */

const display = (ref: string, op: "displayed" | "notDisplayed", value?: string): ConditionRule =>
  ({ type: "rule", source: { kind: "question", ref }, operator: op, ...(value !== undefined ? { value } : {}) }) as ConditionRule;

test("display: an option is displayed after its own logic, whether or not it is selected", () => {
  const d = def([
    { code: "a", label: "A" },
    { code: "b", label: "B", logic: { excludeWhen: { type: "rule", source: { kind: "question", ref: "q_gate" }, operator: "selected", value: "1" } } },
  ]);
  const st = createResponseState(d);
  const ctx = { def: d, state: st, loop: null };
  assert.equal(evaluateCondition(display("q_m", "displayed", "a"), ctx), true, "shown, never selected");
  assert.equal(evaluateCondition(display("q_m", "displayed", "b"), ctx), true);
  setAnswer(d, st, "q_gate", "1");
  assert.equal(evaluateCondition(display("q_m", "displayed", "b"), ctx), false, "now excluded");
  assert.equal(evaluateCondition(display("q_m", "notDisplayed", "b"), ctx), true);
  assert.equal(evaluateCondition(display("q_m", "displayed", "a"), ctx), true);
});

test("display: with no option named it asks about the question; an unknown question is 'not displayed'", () => {
  const d = SurveyDefinition.parse({ ...def(), questions: def().questions.map((x) => x.id === "q_m" ? { ...x, displayLogic: { type: "rule", source: { kind: "question", ref: "q_gate" }, operator: "selected", value: "1" } } : x) });
  const st = createResponseState(d);
  const ctx = { def: d, state: st, loop: null };
  assert.equal(evaluateCondition(display("q_m", "displayed"), ctx), false);
  setAnswer(d, st, "q_gate", "1");
  assert.equal(evaluateCondition(display("q_m", "displayed"), ctx), true);
  assert.equal(evaluateCondition(display("nope", "displayed", "a"), ctx), false);
  assert.equal(evaluateCondition(display("nope", "notDisplayed", "a"), ctx), true);
});

test("display: on a grid it names a ROW, never an answer column, and moving to or from it clears the old shape", () => {
  const d = def(), st = createResponseState(d);
  const g = q(d, "q_grid");
  assert.ok(gridCellOperators(g).includes("displayed") && gridCellOperators(g).includes("notDisplayed"));
  assert.equal(evaluateCondition(display("q_grid", "displayed", "r1"), { def: d, state: st, loop: null }), true);
  const cell = { type: "rule", source: { kind: "question", ref: "q_grid", rowCode: "r1", columnId: "2" }, operator: "selected" } as ConditionRule;
  const toDisplay = withGridOperator(cell, "displayed");
  assert.equal(toDisplay.source.columnId, undefined);
  assert.equal(toDisplay.source.rowCode, undefined);
  assert.equal(toDisplay.value, undefined);
  const back = withGridOperator({ ...toDisplay, value: "r1" } as ConditionRule, "selected");
  assert.equal(back.value, undefined, "a row code is not an answer column");
});

test("display: written in the expression language and read back unchanged", () => {
  const d = def();
  for (const op of ["displayed", "notDisplayed"] as const) {
    const c = display("q_m", op, "a");
    const text = formatCondition(d, c);
    const back = parseLogicExpression(d, text);
    assert.deepEqual((back as { condition?: unknown }).condition, c, text);
  }
});

/* ------------------------------------------- "Show when" / "Hide when" retirement */

test("migration: Show when becomes Eligible when and Hide when becomes Exclude when, behaviour unchanged", () => {
  const gate = (v: string) => ({ type: "rule", source: { kind: "question", ref: "q_gate" }, operator: "selected", value: v });
  const raw = def([
    { code: "a", label: "A", logic: { visibility: "show_when", when: gate("1") } },
    { code: "b", label: "B", logic: { visibility: "hide_when", when: gate("1") } },
    { code: "c", label: "C", logic: { visibility: "show_when", when: gate("1"), eligibleWhen: gate("2") } },
  ]);
  const before = (d: SurveyDefinition, gateValue: string) => {
    const st = createResponseState(d); setAnswer(d, st, "q_gate", gateValue);
    return (effectiveQuestion(q(d, "q_m"), { def: d, state: st, loop: null }).options ?? []).map((o) => o.code).join(",");
  };
  const { def: migrated, changes } = canonicalizeSurveyConditions(raw);
  assert.ok(changes.length > 0, "the migration is reported");
  const opts = q(migrated, "q_m").options!;
  assert.equal(opts[0].logic?.visibility ?? "default", "default");
  assert.ok(opts[0].logic?.eligibleWhen && !opts[0].logic?.when);
  assert.ok(opts[1].logic?.excludeWhen && !opts[1].logic?.when);
  assert.equal(before(migrated, "1"), before(raw, "1"));
  assert.equal(before(migrated, "2"), before(raw, "2"));
  /* a fixed point: migrating again changes nothing */
  const again = canonicalizeSurveyConditions(migrated);
  assert.equal(JSON.stringify(again.def.questions), JSON.stringify(migrated.questions));
});
