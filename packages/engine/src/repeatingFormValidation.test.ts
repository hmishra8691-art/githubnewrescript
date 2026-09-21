import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { validateQuestion } from "./validate.js";
import { createResponseState } from "./state.js";
import { start } from "./flow.js";

/*
 * FIELD-LEVEL VALIDATION INSIDE A REPEATING / NESTED FORM.
 *
 * The September review, verbatim:
 *
 *   "In the Custom Form family – Repeating/Nested Form question type, I
 *    created a form with fields such as Name, Email, and Relationship. I
 *    applied Short Text validation to the Name field and Email validation to
 *    the Email field. However, even when I enter an invalid value in the Name
 *    field (for example, numbers instead of a name) and enter an invalid or
 *    incomplete email address, the form still allows submission without
 *    showing any validation error. This is a validation bug."
 *
 * It was: the repeating-group branch of `validateQuestion` tested `required`
 * and nothing else — never the row's declared `fieldType`, never the rules on
 * `row.validation`. Both are checked now, by the same helpers every other
 * question shape uses, so a rule means the same thing in a repeating form as
 * it does in a flat one.
 */

const survey = (): SurveyDefinition =>
  SurveyDefinition.parse({
    meta: { id: "00000000-0000-4000-8000-0000000rf001", code: "RF", title: "Repeating form validation" },
    questions: [
      {
        id: "q1", code: "Q1", variableName: "HOUSEHOLD", type: "repeating_group",
        variant: "form.repeating",
        text: "Tell us about the people in your household",
        settings: { minRepeats: 1, maxRepeats: 5 },
        rows: [
          {
            code: "name", label: "Name", fieldType: "text", required: true,
            // "Short Text validation" — a length ceiling on the name field
            validation: [{ kind: "max_length", value: 40 }],
          },
          { code: "email", label: "Email", fieldType: "email" },
          { code: "relationship", label: "Relationship", fieldType: "text" },
        ],
      },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e1", status: "complete" }],
  });

const check = (value: unknown) => {
  const def = survey();
  const state = createResponseState(def);
  start(def, state);
  return validateQuestion(def, def.questions[0], value, { def, state })
    .map((e) => (typeof e === "string" ? e : (e as { message?: string }).message ?? String(e)));
};

test("an invalid email inside a repeating entry is refused — the reported bug", () => {
  const errs = check([{ name: "Ana", email: "not-an-email", relationship: "sister" }]);
  assert.ok(errs.length > 0, "an incomplete email must not pass");
  assert.ok(
    errs.some((m) => /email/i.test(m)),
    `expected an email complaint, got: ${JSON.stringify(errs)}`,
  );
});

test("a field's own rule is enforced per entry, not just `required`", () => {
  const errs = check([{ name: "x".repeat(60), email: "ana@example.com", relationship: "sister" }]);
  assert.ok(
    errs.some((m) => /at most 40/.test(m)),
    `expected the max_length rule to fire, got: ${JSON.stringify(errs)}`,
  );
});

test("the entry number is named, so a respondent knows which row to fix", () => {
  const errs = check([
    { name: "Ana", email: "ana@example.com", relationship: "sister" },
    { name: "Bo", email: "broken@", relationship: "brother" },
  ]);
  assert.ok(errs.some((m) => /Entry 2/.test(m)), `expected "Entry 2" in: ${JSON.stringify(errs)}`);
  assert.ok(!errs.some((m) => /Entry 1/.test(m)), `entry 1 is valid and must not be flagged: ${JSON.stringify(errs)}`);
});

test("a valid form still passes — the fix refuses bad input, not all input", () => {
  assert.deepEqual(check([{ name: "Ana", email: "ana@example.com", relationship: "sister" }]), []);
});

test("required is still enforced, and an empty optional field is still fine", () => {
  assert.ok(check([{ name: "", email: "", relationship: "" }]).length > 0, "a wholly empty entry cannot satisfy minRepeats");
  assert.deepEqual(check([{ name: "Ana", email: "", relationship: "" }]), [],
    "email and relationship are optional — leaving them blank is not an error");
});
