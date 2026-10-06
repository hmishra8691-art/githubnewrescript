import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { validateQuestion } from "./validate.js";
import { validateFieldValue, rangeEndKey } from "./fields.js";
import { phoneCountryFor } from "./formats.js";

/*
 * OCTOBER 2026 REVIEW — the validation the builders' new settings promise:
 * decimal places and sign on Numeric Open End (Q10), a date or time range in
 * order (Q13 / P26), and the phone code list (P32). Each case states the
 * respondent's input and the message the review asked for.
 */
function errsFor(q: Record<string, unknown>) {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T" },
    questions: [{ id: "q", code: "Q1", variableName: "Q1", text: "Q", ...q }],
    flow: [{ type: "page", id: "p", questionIds: ["q"] }, { type: "end", id: "e", status: "complete" }],
  });
  return (v: unknown) => validateQuestion(def, def.questions[0], v, { def, state: { answers: {}, embedded: {} } } as never).map((e) => e.message);
}

test("Numeric Open End — decimal places and whole numbers", () => {
  const two = errsFor({ type: "numeric", variant: "numeric.open", settings: { decimalPlaces: 2 } });
  assert.deepEqual(two("2.50"), [], "two places allowed: 2.50 passes");
  assert.equal(two("2.505").length, 1, "three places is refused");
  assert.match(two("2.505")[0], /2/, "the message names the allowed places");
  const whole = errsFor({ type: "numeric", variant: "numeric.open", settings: { decimalPlaces: 0 } });
  assert.deepEqual(whole("12"), []);
  assert.equal(whole("12.5").length, 1, "a decimal in a whole-number field");
  assert.notDeepEqual(whole("12.5"), two("2.505"), "whole numbers say so, not 'up to 0 decimal places'");
  const free = errsFor({ type: "numeric", variant: "numeric.open", settings: {} });
  assert.deepEqual(free("2.123456"), [], "unset keeps the old behaviour");
});

test("Numeric Open End — positive / negative only", () => {
  const pos = errsFor({ type: "numeric", variant: "numeric.open", settings: { numberSign: "positive" } });
  assert.deepEqual(pos("5"), []);
  assert.deepEqual(pos("0"), [], "zero is neither");
  assert.equal(pos("-5").length, 1, "a negative number when only positive is allowed");
  const neg = errsFor({ type: "numeric", variant: "numeric.open", settings: { numberSign: "negative" } });
  assert.deepEqual(neg("-5"), []);
  assert.equal(neg("5").length, 1);
  assert.notDeepEqual(pos("-5"), neg("5"), "each says which sign it wants");
});

test("Date Range — To before From is refused, compared as dates", () => {
  const rows = [
    { code: "from", label: "From", fieldType: "date" },
    { code: "to", label: "To", fieldType: "date" },
  ];
  const errs = errsFor({ type: "numeric_list", variant: "datetime.date_range", rows, settings: {} });
  assert.deepEqual(errs({ from: "2026-01-05", to: "2026-02-01" }), []);
  assert.equal(errs({ from: "2026-02-01", to: "2026-01-05" }).length, 1, "the end before the start");
  assert.deepEqual(errs({ from: "2026-01-05", to: "2026-01-05" }), [], "a one-day range");
});

test("rangeEndKey — dates, times and durations order as what they are", () => {
  assert.ok((rangeEndKey("date", "2026-12-01") as string) > (rangeEndKey("date", "2026-02-01") as string));
  assert.ok((rangeEndKey("time", "09:30") as number) < (rangeEndKey("time", "13:05") as number), "09:30 before 13:05");
  assert.ok((rangeEndKey("time", "9:30") as number) < (rangeEndKey("time", "10:00") as number), "not compared as text");
  assert.ok((rangeEndKey("number", "9") as number) < (rangeEndKey("number", "10") as number), "numbers as numbers, not text");
});

test("phone code list — the code the respondent picked decides the check", () => {
  assert.equal(phoneCountryFor("pick", "+91 98765 43210"), "IN");
  assert.equal(phoneCountryFor("pick", "98765 43210"), undefined, "no code chosen yet: the loose check");
  assert.equal(phoneCountryFor("GB", "+91 98765 43210"), "GB", "a fixed country stays fixed");
  assert.equal(phoneCountryFor(undefined, "+91 98765 43210"), undefined, "unset: as before");
  assert.equal(validateFieldValue("phone", "+91 98765 43210", { phoneCountry: "pick" }), null, "a real Indian mobile");
  assert.match(String(validateFieldValue("phone", "+91 12345", { phoneCountry: "pick" })), /India/, "too short for India, said as India");
});
