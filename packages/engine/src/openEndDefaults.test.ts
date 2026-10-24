import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState } from "./state.js";
import { start, advance, goBack, setAnswer } from "./flow.js";
import { fieldDefaultsFor, questionHasDefaults, applyDefaultValues } from "./defaultValue.js";
import { otherKeyFor, rowOtherCode } from "./otherSpecify.js";

/**
 * A DEFAULT / PIPED VALUE ON EVERY OPEN-ENDED FIELD (2026-10-24, client item
 * A63): Text / Numeric List fields, Text / Numeric Matrix cells, Constant Sum
 * amounts, composite grid cells and "Other — specify" boxes each take their
 * own default — static or `{{piped}}` — resolved when the question is first
 * shown, written only into empty fields, never over what the respondent typed,
 * and never as raw `{{…}}` syntax. No default = nothing changes.
 */
const survey = (mutate: (d: Record<string, any>) => void = () => {}) => {
  const d: Record<string, any> = {
    meta: { id: "oed", code: "OED", title: "Open-end defaults" },
    questions: [
      { id: "q1", code: "Q1", variableName: "NAME", type: "open_text", text: "Name?" },
      { id: "q_age", code: "QAGE", variableName: "AGE", type: "numeric", text: "Age?" },
      { id: "q_fields", code: "Q2", variableName: "CONTACT", type: "text_list", text: "Contact", rows: [
        { code: "first", label: "First", fieldType: "text" },
        { code: "city", label: "City", fieldType: "text" },
        { code: "age", label: "Age", fieldType: "number" },
      ] },
      { id: "q_tgrid", code: "Q3", variableName: "WHY", type: "matrix_text", text: "Why", rows: [{ code: "r1", label: "Brand" }, { code: "r2", label: "Price" }] },
      { id: "q_ngrid", code: "Q4", variableName: "HOW", type: "matrix_numeric", text: "How many", rows: [{ code: "r1", label: "Adults" }, { code: "r2", label: "Kids" }] },
      { id: "q_sum", code: "Q5", variableName: "SPEND", type: "allocation", text: "Split 100", options: [{ code: "1", label: "Rent" }, { code: "2", label: "Food" }, { code: "3", label: "Fun" }], settings: { sumTarget: 100 } },
      { id: "q_comp", code: "Q6", variableName: "TABLE", type: "composite", text: "Table", rows: [{ code: "r1", label: "Row 1" }, { code: "r2", label: "Row 2" }], columns: [
        { id: "c_note", label: "Note", responseType: "text", variableStem: "NOTE" },
        { id: "c_qty", label: "Qty", responseType: "numeric", variableStem: "QTY" },
        { id: "c_pick", label: "Pick", responseType: "single", variableStem: "PICK", options: [{ code: "1", label: "A" }] },
      ] },
      { id: "q_other", code: "Q7", variableName: "DRINK", type: "single_select", text: "Drink", options: [{ code: "1", label: "Tea" }, { code: "97", label: "Other", flags: ["other_specify"] }] },
      { id: "q_rows_other", code: "Q8", variableName: "RATE", type: "matrix_single", text: "Rate", options: [{ code: "1", label: "Bad" }, { code: "2", label: "Good" }], rows: [{ code: "a", label: "Service" }, { code: "oth", label: "Other", flags: ["other_specify"] }] },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1", "q_age"] },
      { type: "page", id: "p2", questionIds: ["q_fields", "q_tgrid", "q_ngrid", "q_sum", "q_comp", "q_other", "q_rows_other"] },
      { type: "end", id: "e", status: "complete" },
    ],
    deployment: { clientSlug: "c", studySlug: "s" },
  };
  mutate(d);
  return SurveyDefinition.parse(d);
};
const Q = (d: Record<string, any>, id: string) => d.questions.find((x: { id: string }) => x.id === id);

/** answer page 1 and open page 2 */
function toPage2(def: SurveyDefinition, name = "Ann", age: number | null = 34) {
  const st = createResponseState(def);
  start(def, st);
  setAnswer(def, st, "q1", name);
  if (age !== null) setAnswer(def, st, "q_age", age);
  advance(def, st);
  return st;
}

test("no default anywhere: nothing is written — the response is exactly what it was", () => {
  const def = survey();
  assert.ok(def.questions.every((q) => !questionHasDefaults(q)));
  const st = toPage2(def);
  assert.deepEqual(Object.keys(st.answers).sort(), ["q1", "q_age"]);
  assert.equal(st.meta?.defaultsApplied, undefined);
});

test("per-field defaults, static and piped, written as each field reads its value", () => {
  const def = survey((d) => {
    Q(d, "q_fields").rows[0].defaultValue = "{{Q1}}";          // text field, piped
    Q(d, "q_fields").rows[1].defaultValue = "London";          // text field, static
    Q(d, "q_fields").rows[2].defaultValue = "{{QAGE}}";        // numeric field, piped → a number
    Q(d, "q_tgrid").rows[0].defaultValue = "Because {{Q1}} says so";
    Q(d, "q_ngrid").rows[1].defaultValue = "{{QAGE}}";
    Q(d, "q_ngrid").rows[0].defaultValue = "2";
    Q(d, "q_sum").options[0].defaultValue = "40";
    Q(d, "q_sum").options[1].defaultValue = "{{QAGE}}";
    Q(d, "q_comp").rows[0].cellDefaults = { c_note: "{{Q1}}'s row", c_qty: "3" };
    Q(d, "q_comp").columns[1].defaultValue = "1";              // every Qty cell starts at 1 unless the row says otherwise
    Q(d, "q_comp").columns[2].defaultValue = "1";              // a selection column: no box, ignored
    Q(d, "q_other").options[1].otherDefault = "{{Q1}}";
    Q(d, "q_rows_other").rows[1].otherDefault = "Something else";
  });
  assert.ok(["q_fields", "q_tgrid", "q_ngrid", "q_sum", "q_comp", "q_other", "q_rows_other"].every((id) => questionHasDefaults(def.questions.find((q) => q.id === id)!)));
  const st = toPage2(def);
  assert.deepEqual(st.answers.q_fields, { first: "Ann", city: "London", age: 34 });
  assert.deepEqual(st.answers.q_tgrid, { r1: "Because Ann says so" }, "only the row with a default");
  assert.deepEqual(st.answers.q_ngrid, { r1: 2, r2: 34 }, "numbers for a numeric grid");
  assert.deepEqual(st.answers.q_sum, { "1": 40, "2": 34 }, "amounts; the third row is left for the respondent");
  assert.deepEqual(st.answers.q_comp, { r1: { c_note: "Ann's row", c_qty: 3 }, r2: { c_qty: 1 } }, "a cell's own default wins over its column's; the selection column has none");
  assert.equal(st.answers[otherKeyFor("q_other", "97")], "Ann", "the Other box of an option");
  assert.equal(st.answers[otherKeyFor("q_rows_other", rowOtherCode("oth"))], "Something else", "the Other box of a grid row");
  assert.equal(st.answers.q_other, undefined, "the choice itself is not made for the respondent");
  const raw = JSON.stringify(st.answers);
  assert.ok(!raw.includes("{{"), `no piping syntax reaches the response: ${raw}`);
});

test("an unresolved or empty pipe writes nothing — the field stays empty, never “{{…}}”", () => {
  const def = survey((d) => {
    Q(d, "q_fields").rows[0].defaultValue = "{{NOPE_NOT_HERE}}";
    Q(d, "q_fields").rows[2].defaultValue = "{{QAGE}}";
    Q(d, "q_tgrid").rows[0].defaultValue = "{{Q1}}";
    Q(d, "q_ngrid").rows[0].defaultValue = "{{Q1}}";   // a name is not a number
    Q(d, "q_sum").options[0].defaultValue = "abc";     // not a number either
  });
  const st = toPage2(def, "", null);                   // Q1 and QAGE left unanswered
  assert.equal(st.answers.q_fields, undefined, "nothing resolved: nothing written");
  assert.equal(st.answers.q_tgrid, undefined);
  assert.equal(st.answers.q_ngrid, undefined, "a non-numeric default is not stored in a numeric cell");
  assert.equal(st.answers.q_sum, undefined);
  assert.ok(!JSON.stringify(st.answers).includes("{{"));
  /* a default that could not resolve is tried again on the next visit — and resolves once the pipe has a value */
  goBack(def, st);
  setAnswer(def, st, "q1", "Bo");
  setAnswer(def, st, "q_age", 40);
  advance(def, st);
  assert.deepEqual(st.answers.q_fields, { age: 40 });
  assert.deepEqual(st.answers.q_tgrid, { r1: "Bo" });
});

test("filled once, into empty fields only — the respondent's own values stand", () => {
  const def = survey((d) => {
    Q(d, "q_fields").rows[0].defaultValue = "{{Q1}}";
    Q(d, "q_fields").rows[1].defaultValue = "London";
    Q(d, "q_sum").options[0].defaultValue = "40";
    Q(d, "q_sum").options[1].defaultValue = "60";
  });
  const st = toPage2(def);
  assert.deepEqual(st.answers.q_fields, { first: "Ann", city: "London" });
  /* the respondent edits one field, clears another, and overwrites an amount */
  setAnswer(def, st, "q_fields", { first: "Annie", city: null } as never);
  setAnswer(def, st, "q_sum", { "1": 10, "2": 60 } as never);
  goBack(def, st);
  setAnswer(def, st, "q1", "Changed");
  advance(def, st);
  assert.deepEqual(st.answers.q_fields, { first: "Annie", city: null }, "edited and cleared fields are left alone on the second visit");
  assert.deepEqual(st.answers.q_sum, { "1": 10, "2": 60 });
  /* a partly answered question when first shown: only its empty fields are filled */
  const def2 = survey((d) => { Q(d, "q_fields").rows[0].defaultValue = "A"; Q(d, "q_fields").rows[1].defaultValue = "B"; });
  const st2 = createResponseState(def2);
  start(def2, st2);
  st2.answers.q_fields = { first: "Typed" };
  setAnswer(def2, st2, "q1", "x");
  advance(def2, st2);
  assert.deepEqual(st2.answers.q_fields, { first: "Typed", city: "B" });
});

test("fieldDefaultsFor resolves against the answers so far; applyDefaultValues reports what it wrote", () => {
  const def = survey((d) => {
    Q(d, "q_tgrid").rows[1].defaultValue = "{{Q1}} / {{QAGE}}";
    Q(d, "q_other").options[1].otherDefault = "x";
  });
  const st = createResponseState(def);
  st.answers.q1 = "Ann"; st.answers.q_age = 34;
  const ctx = { def, state: st, loop: null };
  assert.deepEqual(fieldDefaultsFor(def.questions.find((q) => q.id === "q_tgrid")!, ctx), { answer: { r2: "Ann / 34" }, others: {} });
  assert.deepEqual(fieldDefaultsFor(def.questions.find((q) => q.id === "q_other")!, ctx), { answer: {}, others: { "97": "x" } });
  const wrote = applyDefaultValues(def.questions, ctx, (q) => q.id);
  assert.deepEqual(wrote.sort(), ["q_other", "q_tgrid"]);
  assert.deepEqual(applyDefaultValues(def.questions, ctx, (q) => q.id), [], "once");
});

test("the question-level default still works, and its piping resolves to plain text", () => {
  const def = survey((d) => { Q(d, "q_tgrid").settings = { defaultValue: "{{Q1}}" }; Q(d, "q_fields").settings = { defaultValue: "{{Q1}}" }; });
  /* a grid has no whole-answer default (it is a map), the per-field ones are the way; a text question's own default resolves as before */
  const d2 = survey((d) => { Q(d, "q1").settings = { defaultValue: "<b>Static</b>" }; });
  const st = createResponseState(d2);
  start(d2, st);
  assert.equal(st.answers.q1, "<b>Static</b>", "a static default is stored as typed");
  const st3 = toPage2(def);
  assert.equal(st3.answers.q_tgrid, undefined);
});

test("Intelligent Mode: set_default_value with a field writes the same per-field setting the builder box writes", async () => {
  const { applySurveyActions, coerceSurveyActions, diffSurveys } = await import("./surveyActions.js");
  const d = survey();
  const c = coerceSurveyActions([
    { op: "set_default_value", target: "Q3", field: "r1", value: "{{Q1}}" },          // text matrix row
    { op: "set_default_value", target: "Q5", field: "Rent", value: 40 },              // constant sum row, by label
    { op: "set_default_value", target: "Q6", field: "r1/Note", value: "{{Q1}}" },     // composite cell, column by label
    { op: "set_default_value", target: "Q6", field: "column:c_qty", value: "1" },     // a whole column
    { op: "set_default_value", target: "Q2", field: "age", value: "{{QAGE}}" },       // numeric list field, piped
    { op: "set_default_value", target: "Q7", field: "97.other", value: "{{Q1}}" },    // an Other box
  ]);
  assert.deepEqual(c.rejected, []);
  const r = applySurveyActions(d, c.actions, { uxOnly: true });
  assert.deepEqual(r.errors, []);
  assert.equal(r.structureUnchanged, true, "a default changes no question, code or logic");
  const Qn = (id: string) => r.def.questions.find((x) => x.id === id)!;
  assert.equal(Qn("q_tgrid").rows[0].defaultValue, "{{Q1}}");
  assert.equal(Qn("q_sum").options[0].defaultValue, "40");
  assert.deepEqual(Qn("q_comp").rows[0].cellDefaults, { c_note: "{{Q1}}" });
  assert.equal(Qn("q_comp").columns[1].defaultValue, "1");
  assert.equal(Qn("q_fields").rows[2].defaultValue, "{{QAGE}}");
  assert.equal(Qn("q_other").options[1].otherDefault, "{{Q1}}");
  assert.match(r.results[0].description, /Set the default of Q3 “Brand” to \{\{Q1\}\} \(piped — resolved for each respondent\)/);
  assert.equal(diffSurveys(d, r.def).empty, false, "Apply has something to do");
  /* the runtime fills them */
  const st = toPage2(r.def);
  assert.deepEqual(st.answers.q_tgrid, { r1: "Ann" });
  assert.deepEqual(st.answers.q_sum, { "1": 40 });
  assert.deepEqual(st.answers.q_comp, { r1: { c_note: "Ann", c_qty: 1 }, r2: { c_qty: 1 } });
  /* refused with the reason */
  const bad = applySurveyActions(d, coerceSurveyActions([
    { op: "set_default_value", target: "Q4", field: "r1", value: "lots" },
    { op: "set_default_value", target: "Q3", field: "nope", value: "x" },
    { op: "set_default_value", target: "Q6", field: "column:c_pick", value: "1" },
    { op: "set_default_value", target: "QAGE", field: "x", value: "1" },
  ]).actions, { uxOnly: true });
  assert.match(bad.errors[0], /takes a number, not “lots”/);
  assert.match(bad.errors[1], /has no field or row “nope”/);
  assert.match(bad.errors[2], /not typed into/);
  assert.match(bad.errors[3], /has no open field/);
  /* an unresolvable pipe: applied, with a warning */
  const warn = applySurveyActions(d, coerceSurveyActions([{ op: "set_default_value", target: "Q3", field: "r2", value: "{{NOPE_X}}" }]).actions, { uxOnly: true });
  assert.match(warn.warnings.join(" "), /NOPE_X.*start empty/);
  /* removing one */
  const rm = applySurveyActions(r.def, coerceSurveyActions([{ op: "set_default_value", target: "Q3", field: "r1", value: null }]).actions, { uxOnly: true });
  assert.equal(rm.def.questions.find((x) => x.id === "q_tgrid")!.rows[0].defaultValue, undefined);
});

test("preview / test note: the defaults that resolve to nothing right now", async () => {
  const { unresolvedDefaultsFor } = await import("./defaultValue.js");
  const def = survey((d) => {
    Q(d, "q_tgrid").rows[0].defaultValue = "{{Q1}}";
    Q(d, "q_tgrid").rows[1].defaultValue = "static";
    Q(d, "q_ngrid").rows[0].defaultValue = "{{Q1}}";
  });
  const st = createResponseState(def);
  const ctx = { def, state: st, loop: null };
  const tg = def.questions.find((x) => x.id === "q_tgrid")!;
  const ng = def.questions.find((x) => x.id === "q_ngrid")!;
  assert.deepEqual(unresolvedDefaultsFor(tg, ctx), [{ field: "Brand", configured: "{{Q1}}" }]);
  st.answers.q1 = "Ann";
  assert.deepEqual(unresolvedDefaultsFor(tg, ctx), [], "resolved once Q1 is answered");
  assert.deepEqual(unresolvedDefaultsFor(ng, ctx), [{ field: "Adults", configured: "{{Q1}}" }], "a name in a numeric cell does not resolve to a number");
  assert.deepEqual(unresolvedDefaultsFor(def.questions[0], ctx), []);
});
