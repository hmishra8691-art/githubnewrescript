import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  createResponseState, runCalculations, evaluateExpression, calcOptionsFor, EmbeddedDataError,
  applyEmbeddedField, checkEmbeddedExpression, validateExpression, safeExpression,
} from "./index.js";

/**
 * EMBEDDED DATA IN CALCULATIONS — `{{ed.FieldName}}` in the Calculations list,
 * in Embedded Data calculations and in Calc DSL expressions.
 *
 * It used to fail with "Unexpected character '{' in expression at 0".
 */

const def = (extra: Record<string, unknown> = {}) => SurveyDefinition.parse({
  meta: { id: "c", code: "C", title: "Calc", version: "1.0" },
  questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "numeric", text: "n" }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }],
  embeddedData: Array.from({ length: 14 }, (_, i) => ({ name: `LOWCAL_${i + 1}` })).concat([{ name: "ID" }, { name: "A" }, { name: "B" }, { name: "C" }] as never),
  ...extra,
});
const st = (d: SurveyDefinition, embedded: Record<string, unknown>) => createResponseState(d, { embedded: embedded as never });
const run = (d: SurveyDefinition, s: ReturnType<typeof st>, expression: string, target = "TOTAL") => {
  const dd = SurveyDefinition.parse({ ...d, calculations: [{ id: "k", targetVariable: target, expression, trigger: "on_page_submit" }] });
  runCalculations(dd, s, "on_page_submit");
  return { value: s.calculated[target], error: s.calcErrors?.[target] };
};

test("the 14-field example from the brief totals 14", () => {
  const d = def();
  const embedded = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`LOWCAL_${i + 1}`, 1]));
  const expr = Array.from({ length: 14 }, (_, i) => `{{ed.LOWCAL_${i + 1}}}`).join(" +\n");
  assert.deepEqual(run(d, st(d, embedded), expr), { value: 14, error: undefined });
});

test("two and three fields, with every operator, decimals, negatives and parentheses", () => {
  const d = def();
  const s = st(d, { A: 6, B: 4, C: -2.5 });
  const v = (e: string) => evaluateExpression(e, calcOptionsFor(d, s));
  assert.equal(v("{{ed.A}} + {{ed.B}}"), 10);
  assert.equal(v("{{ed.A}} - {{ed.B}}"), 2);
  assert.equal(v("{{ed.A}} * {{ed.B}}"), 24);
  assert.equal(v("{{ed.A}} / {{ed.B}}"), 1.5);
  assert.equal(v("({{ed.A}} + {{ed.B}}) * 2"), 20);
  assert.equal(v("{{ed.C}} * 2"), -5);
  assert.equal(v("-{{ed.A}}"), -6);
  assert.equal(v("{{ ed.A }} + 1"), 7, "spaces inside the braces are fine");
  assert.equal(v("{{ed.a}} + 1"), 7, "field names match case-insensitively");
  assert.equal(v("embedded.A + ed.B"), 10, "the bare prefix works too");
  assert.equal(v("sum({{ed.A}}, {{ed.B}}, {{ed.C}})"), 7.5);
});

test('numeric strings are numbers in arithmetic: "1" + "1" is 2, never "11"', () => {
  const d = def();
  const s = st(d, { A: "1", B: "1", C: " 2.5 " });
  assert.equal(evaluateExpression("{{ed.A}} + {{ed.B}}", calcOptionsFor(d, s)), 2);
  assert.equal(evaluateExpression("{{ed.A}} + {{ed.B}} + {{ed.C}}", calcOptionsFor(d, s)), 4.5);
  assert.equal(evaluateExpression("{{ed.C}} > 2", calcOptionsFor(d, s)), true);
});

test("text stays text: an ID with leading zeros is not turned into a number", () => {
  const d = def();
  const s = st(d, { ID: "007" });
  assert.equal(evaluateExpression('{{ed.ID}} + "-x"', calcOptionsFor(d, s)), "007-x");
  assert.equal(evaluateExpression('concat({{ed.ID}}, "!")', calcOptionsFor(d, s)), "007!");
});

test("a non-numeric value is an error that names the field", () => {
  const d = def();
  const s = st(d, { A: 1, B: "abc" });
  assert.throws(() => evaluateExpression("{{ed.A}} + {{ed.B}}", calcOptionsFor(d, s)), (e: unknown) => {
    assert.ok(e instanceof EmbeddedDataError);
    assert.equal((e as EmbeddedDataError).field, "B");
    assert.match((e as Error).message, /"B".*non-numeric.*"abc"/);
    return true;
  });
  const r = run(d, s, "{{ed.A}} + {{ed.B}}");
  assert.equal(r.value, null);
  assert.match(r.error ?? "", /"B".*non-numeric/);
  /* and a later good run clears it */
  s.embedded.B = 2;
  assert.deepEqual(run(d, s, "{{ed.A}} + {{ed.B}}"), { value: 3, error: undefined });
});

test("Empty Embedded Data Handling: zero, error, skip", () => {
  const embedded = { A: 1, B: "", C: 1 };
  /* zero (the default) */
  let d = def();
  assert.deepEqual(run(d, st(d, embedded), "{{ed.A}} + {{ed.B}} + {{ed.C}}"), { value: 2, error: undefined });
  /* a field that was never set at all counts the same way */
  assert.deepEqual(run(d, st(d, { A: 1, C: 1 }), "{{ed.A}} + {{ed.B}} + {{ed.C}}"), { value: 2, error: undefined });
  /* error */
  d = def({ calculationSettings: { emptyEmbedded: "error" } });
  const r = run(d, st(d, embedded), "{{ed.A}} + {{ed.B}} + {{ed.C}}");
  assert.equal(r.value, null);
  assert.match(r.error ?? "", /"B" is empty/);
  /* skip: left out of the aggregates; in plain arithmetic there is nothing to leave out */
  d = def({ calculationSettings: { emptyEmbedded: "skip" } });
  assert.deepEqual(run(d, st(d, embedded), "sum({{ed.A}}, {{ed.B}}, {{ed.C}})"), { value: 2, error: undefined });
  assert.deepEqual(run(d, st(d, embedded), "avg({{ed.A}}, {{ed.B}}, {{ed.C}})"), { value: 1, error: undefined });
  assert.deepEqual(run(d, st(d, embedded), "count({{ed.A}}, {{ed.B}}, {{ed.C}})"), { value: 2, error: undefined });
  assert.deepEqual(run(d, st(d, embedded), "{{ed.A}} + {{ed.B}} + {{ed.C}}"), { value: 2, error: undefined });
});

test("the calculation uses the LATEST values each time it runs", () => {
  const d = def();
  const s = st(d, { LOWCAL_1: 1, LOWCAL_2: 1 });
  assert.equal(run(d, s, "{{ed.LOWCAL_1}} + {{ed.LOWCAL_2}}").value, 2);
  s.embedded.LOWCAL_2 = 5;
  assert.equal(run(d, s, "{{ed.LOWCAL_1}} + {{ed.LOWCAL_2}}").value, 6);
  s.embedded.LOWCAL_2 = "7";
  assert.equal(run(d, s, "{{ed.LOWCAL_1}} + {{ed.LOWCAL_2}}").value, 8);
});

test("embedded data mixes with answers and other calculations", () => {
  const d = SurveyDefinition.parse({ ...def(), calculations: [
    { id: "k1", targetVariable: "BASE", expression: "{{ed.A}} * 2", trigger: "on_page_submit" },
    { id: "k2", targetVariable: "TOTAL", expression: "BASE + Q1 + {{ed.B}}", trigger: "on_page_submit" },
  ] });
  const s = st(d, { A: 5, B: "3" });
  s.answers.q1 = 4;
  runCalculations(d, s, "on_page_submit");
  assert.equal(s.calculated.BASE, 10);
  assert.equal(s.calculated.TOTAL, 17);
});

test("syntax: braces are accepted where they wrap a reference, and refused otherwise", () => {
  assert.equal(validateExpression("{{ed.A}} + {{ed.B}}"), null);
  assert.match(validateExpression("{{ed.A + 1") ?? "", /Unclosed/);
  assert.match(validateExpression("{{}} + 1") ?? "", /Empty reference/);
  assert.match(validateExpression("{ed.A} + 1") ?? "", /Unexpected character '\{'/);
});

test("Embedded Data calculation: an embedded field computed from other embedded fields", () => {
  const d = def();
  const s = st(d, { A: "2", B: "3" });
  const r = applyEmbeddedField(d, s, { name: "PRODUCT", source: "expression", value: "{{ed.A}} * {{ed.B}}" } as never);
  assert.equal(r.error, undefined);
  assert.equal(Number(r.value), 6);
  s.embedded.B = "x";
  const bad = applyEmbeddedField(d, s, { name: "PRODUCT", source: "expression", value: "{{ed.A}} * {{ed.B}}" } as never);
  assert.match(bad.error ?? "", /"B".*non-numeric/);
});

test("validation of an embedded-data expression knows ed.* references", () => {
  const d = def();
  assert.equal(checkEmbeddedExpression(d, "{{ed.A}} + {{ed.LOWCAL_3}}").ok, true);
  const c = checkEmbeddedExpression(d, "{{ed.A}} + {{ed.NOPE}}");
  assert.equal(c.ok, false);
  assert.deepEqual(c.unknownRefs, ["ed.NOPE"]);
});

test("safeExpression (the condition `expr` source) reads embedded references too", () => {
  const d = def();
  const s = st(d, { A: "4" });
  assert.equal(safeExpression("{{ed.A}} * 2", d, s), 8);
  assert.equal(safeExpression("{{ed.A}} * 2 > 7", d, s), true);
});

/* ------------------------------------------------ piped expressions in text */
import { resolvePiping } from "./index.js";
test("{{expr: …}} in question text with embedded references renders as one value, no stray fragments", () => {
  const d = def();
  const s = st(d, { A: "5", B: 3 });
  const ctx = { def: d, state: s, loop: null };
  assert.equal(resolvePiping("Total: {{expr: {{ed.A}} + {{ed.B}} * 2}} points", ctx), "Total: 11 points");
  assert.equal(resolvePiping("Plain {{ed.A}} and {{expr: Q1 + 1}}", ctx), "Plain 5 and 1");
  /* a bad field reads as empty text — never a throw, never half a token */
  s.embedded.B = "oops";
  assert.equal(resolvePiping("Total: {{expr: {{ed.A}} + {{ed.B}}}}!", ctx), "Total: !");
  assert.match(s.calcErrors?.["{{expr:{{ed.A}} + {{ed.B}}}}"] ?? "", /"B".*non-numeric/);
});

import { lintCalculations } from "./index.js";
test("lint: an undeclared or non-numeric embedded field in a calculation is named", () => {
  const d = SurveyDefinition.parse({ ...def({ embeddedData: [{ name: "A" }, { name: "WHEN", dataType: "date" }] }), calculations: [
    { id: "k1", targetVariable: "T1", expression: "{{ed.A}} + {{ed.GHOST}}", trigger: "on_page_submit" },
    { id: "k2", targetVariable: "T2", expression: "{{ed.WHEN}} + 1", trigger: "on_page_submit" },
    { id: "k3", targetVariable: "T3", expression: "{{ed.a}} + 1", trigger: "on_page_submit" },
  ] });
  const p = lintCalculations(d);
  assert.equal(p.length, 2, p.join(" | "));
  assert.match(p[0], /T1.*"GHOST".*no embedded data declares/);
  assert.match(p[1], /T2.*"WHEN".*date/);
});
