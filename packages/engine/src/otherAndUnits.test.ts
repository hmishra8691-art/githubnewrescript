/**
 * THE THREE REQUESTS THE FIRST PASS LEFT OPEN in the "it does not exist"
 * category: a format on the Other (Specify) box, a quantity that looks like a
 * quantity, and hours as a thing a field can hold.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { checkOtherText } from "./otherSpecify.js";
import { parseHours, validateFieldValue, fieldInputProps, FIELD_TYPES } from "./fields.js";
import { createResponseState } from "./state.js";
import { validateQuestion } from "./validate.js";

test("the Other box accepts what the author said it would", () => {
  assert.equal(checkOtherText("text", "Acme Coffee Roasters"), null);
  assert.ok(checkOtherText("text", "+44 7700 900123"), "a phone number is not a brand name");
  assert.equal(checkOtherText("numeric", "42"), null);
  assert.equal(checkOtherText("numeric", "4.5"), null);
  assert.ok(checkOtherText("numeric", "about four"));
  assert.equal(checkOtherText("alphanumeric", "Route 66"), null);
  assert.ok(checkOtherText("alphanumeric", "50% + VAT"));
  /* accented and non-Latin names are text, which a naive [A-Za-z] would refuse */
  assert.equal(checkOtherText("text", "Nestlé"), null);
  assert.equal(checkOtherText("text", "Café O'Brien & Sons"), null);
});

test("naming no format keeps the box accepting anything, as it always did", () => {
  assert.equal(checkOtherText(undefined, "literally anything ✳ 42"), null);
  assert.equal(checkOtherText("text", ""), null, "an empty box is the required rule's business, not this one");
});

test("the format is enforced where it cannot be bypassed", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "Other", version: "1.0" },
    questions: [{
      id: "q1", code: "Q1", variableName: "Q1", type: "multi_select", text: "Which brands?",
      settings: { otherSpecifyFormat: "text" },
      options: [{ code: 1, label: "Acme" }, { code: 98, label: "Other", flags: ["other_specify"] }],
    }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }],
  });
  const q = def.questions[0];
  const state = createResponseState(def, { sessionId: "t", seed: 1 });
  state.answers["q1__other__98"] = "0123456789";
  const errs = validateQuestion(def, q, [98], { def, state, loop: null } as never);
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /letters only/i);

  state.answers["q1__other__98"] = "Blue Bottle";
  assert.deepEqual(validateQuestion(def, q, [98], { def, state, loop: null } as never), []);
});

test("hours are read however a respondent writes them", () => {
  assert.equal(parseHours("7"), 7);
  assert.equal(parseHours("7.5"), 7.5);
  assert.equal(parseHours("7:30"), 7.5);
  assert.equal(parseHours("0:45"), 0.75);
  assert.equal(parseHours("7:75"), null, "a 75-minute hour is a typo, not an hour and a quarter");
  assert.equal(parseHours("-3"), null);
  assert.equal(parseHours("half past seven"), null);
});

test("hours is a field type a range can use, and it stores as a number", () => {
  assert.ok(FIELD_TYPES.some((t) => t.value === "hours"), "offered in the field-type list");
  assert.equal(validateFieldValue("hours", "7:30"), null);
  assert.ok(validateFieldValue("hours", "lunchtime"));
  assert.equal(fieldInputProps("hours").suffix, "hrs");
});
