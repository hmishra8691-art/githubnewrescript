import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, type SurveyAction } from "./surveyActions.js";
import { applySemantic, inferSemantic, SEMANTIC_SPECS, semanticOf } from "./semanticValidation.js";
import { createResponseState } from "./state.js";
import { blockingErrors, validateQuestion } from "./validate.js";

/**
 * QT-02 (audit 2026-10-16): the meaning of a question decides its rules —
 * without hard-coding bounds, without a second validation engine.
 */
let n = 0;
const ids = (p: string) => `${p}_${++n}`;
const empty = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Semantics" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
const build = (actions: unknown[]) => {
  const c = coerceSurveyActions([{ op: "create_block", ref: "B", title: "Screening" }, ...actions]);
  assert.deepEqual(c.rejected, [], JSON.stringify(c.rejected));
  const r = applySurveyActions(empty(), c.actions as SurveyAction[], { ids, now: "2026-10-16T00:00:00Z" });
  assert.deepEqual(r.errors, [], r.errors.join("\n"));
  return r.def;
};
const verdict = (def: SurveyDefinition, variable: string, v: unknown) => {
  const q = def.questions.find((x) => x.variableName === variable)!;
  const st = createResponseState(def, { sessionId: "s", seed: 1 });
  const e = blockingErrors(validateQuestion(def, q, v as never, { def, state: st }));
  return e.length ? `REJECT:${e[0].message}` : "ACCEPT";
};

test("the brief's age table: integer, author's bounds, whole and non-negative — from the wording alone, from the tag, and from the integer type", () => {
  const def = build([
    { op: "create_question", ref: "AGE_TEXT", type: "numeric", text: "What is your age?", required: true, validation: [{ kind: "min_value", value: 1 }, { kind: "max_value", value: 100 }] },
    { op: "create_question", ref: "AGE_TAG", type: "numeric", text: "Please tell us", required: true, semantic: "age", validation: [{ kind: "min_value", value: 1 }, { kind: "max_value", value: 100 }] },
    { op: "create_question", ref: "AGE_INT", type: "integer", text: "Years", required: true, validation: [{ kind: "min_value", value: 1 }, { kind: "max_value", value: 100 }] },
  ]);
  for (const v of ["AGE_TEXT", "AGE_TAG"]) {
    const q = def.questions.find((x) => x.variableName === v)!;
    assert.equal(q.settings.semantic, "age", v);
    assert.equal(q.settings.decimalPlaces, 0); assert.equal(q.settings.numberSign, "positive");
    assert.equal(q.settings.minValue, 1); assert.equal(q.settings.maxValue, 100);
  }
  const expected: [unknown, string][] = [[1, "ACCEPT"], [100, "ACCEPT"], [0, "REJECT"], [-1, "REJECT"], [25.5, "REJECT"], [101, "REJECT"], ["", "REJECT"], ["abc", "REJECT"], [" 42 ", "ACCEPT"], ["1e2", "REJECT"]];
  for (const variable of ["AGE_TEXT", "AGE_TAG", "AGE_INT"]) {
    for (const [v, exp] of expected) {
      const got = verdict(def, variable, v);
      assert.equal(got.split(":")[0], exp, `${variable} ${JSON.stringify(v)} → ${got}`);
    }
  }
  assert.match(verdict(def, "AGE_TEXT", 25.5), /whole number/);
  assert.match(verdict(def, "AGE_TEXT", "abc"), /enter a number/);
});

test("bounds are the author's: no default range is invented for an age, and a study's 18–65 stays 18–65", () => {
  const def = build([
    { op: "create_question", ref: "A1", type: "numeric", text: "How old are you?" },
    { op: "create_question", ref: "A2", type: "numeric", text: "How old are you?", validation: [{ kind: "min_value", value: 18 }, { kind: "max_value", value: 65 }] },
  ]);
  const a1 = def.questions.find((x) => x.variableName === "A1")!;
  assert.deepEqual(a1.validation.map((r) => r.kind), ["integer"], "only the meaning's rule, no range");
  assert.equal(verdict(def, "A1", 130), "ACCEPT", "no invented maximum");
  assert.equal(verdict(def, "A1", -3), "REJECT:" + verdict(def, "A1", -3).split(":")[1], "but never negative");
  assert.equal(verdict(def, "A2", 66), "REJECT:Value must be at most 65.");
  assert.equal(verdict(def, "A2", 18), "ACCEPT");
});

test("email, phone, postal, url, percent, currency, year, count — each tag adds its own rules; 'none' keeps the registry out", () => {
  const def = build([
    { op: "create_question", ref: "EMAIL", type: "text", text: "What is your e-mail address?", validation: [{ kind: "required" }] },
    { op: "create_question", ref: "PHONE", type: "text", text: "Best phone number to reach you" },
    { op: "create_question", ref: "POSTAL", type: "text", text: "Your postcode" },
    { op: "create_question", ref: "URL", type: "text", text: "Company website" },
    { op: "create_question", ref: "PCT", type: "numeric", text: "What percent of your budget goes to media?" },
    { op: "create_question", ref: "SPEND", type: "currency", text: "Monthly spend" },
    { op: "create_question", ref: "YOB", type: "numeric", text: "What year were you born?" },
    { op: "create_question", ref: "KIDS", type: "numeric", text: "How many children live in your household?" },
    { op: "create_question", ref: "HOURS", type: "numeric", text: "How many hours per week?", semantic: "none" },
  ]);
  const kinds = (v: string) => def.questions.find((x) => x.variableName === v)!.validation.map((r) => r.kind);
  assert.ok(kinds("EMAIL").includes("email") && kinds("EMAIL").includes("required"));
  assert.ok(kinds("PHONE").includes("phone")); assert.ok(kinds("POSTAL").includes("zip")); assert.ok(kinds("URL").includes("url"));
  assert.deepEqual(kinds("PCT").sort(), ["max_value", "min_value"], "percent gets 0–100 only because no bound was given");
  assert.equal(verdict(def, "PCT", 101), "REJECT:Value must be at most 100.");
  assert.equal(def.questions.find((x) => x.variableName === "SPEND")!.settings.decimalPlaces, 2);
  assert.equal(verdict(def, "SPEND", "12.345"), "REJECT:Please use at most 2 decimal places.");
  assert.ok(kinds("YOB").includes("integer")); assert.equal(verdict(def, "YOB", 1985), "ACCEPT"); assert.equal(verdict(def, "YOB", 85), "REJECT:Value must be at least 1900.");
  assert.ok(kinds("KIDS").includes("integer")); assert.equal(verdict(def, "KIDS", 2.5).split(":")[0], "REJECT");
  assert.deepEqual(kinds("HOURS"), [], "'none' — hours may be fractional");
  assert.equal(def.questions.find((x) => x.variableName === "HOURS")!.settings.semantic, "none");
  // the email check is the engine's existing validator
  assert.equal(verdict(def, "EMAIL", "first.last+tag@sub.example.museum"), "ACCEPT");
  assert.equal(verdict(def, "EMAIL", "no-at").split(":")[0], "REJECT");
});

test("inference is conservative and idempotent; applySemantic refuses a tag that does not fit the type", () => {
  const q = (type: string, text: string, variant?: string) => ({ type, text, variant, variableName: "X", code: "Q1" }) as never;
  assert.equal(inferSemantic(q("numeric", "How old is your eldest child?")), "age");
  assert.equal(inferSemantic(q("numeric", "How many hours do you work?")), null, "hours are not a count");
  assert.equal(inferSemantic(q("numeric", "In what percentile would you place yourself?")), null);
  assert.equal(inferSemantic(q("open_text", "Anything else?")), null);
  assert.equal(inferSemantic(q("open_text", "x", "text.email")), "email");
  const def = build([{ op: "create_question", ref: "AGE", type: "numeric", text: "How old are you?", validation: [{ kind: "min_value", value: 18 }] }]);
  const age = def.questions[0];
  const before = JSON.stringify(age);
  const again = applySemantic(age, "age");
  assert.equal(again.applied, true); assert.deepEqual(again.added, [], "nothing to add the second time");
  assert.equal(JSON.stringify(age), before);
  assert.equal(semanticOf(age), "age");
  const bad = applySemantic(age, "email");
  assert.equal(bad.applied, false); assert.match(bad.reason ?? "", /applies to open_text/);
  for (const s of Object.keys(SEMANTIC_SPECS)) assert.ok(SEMANTIC_SPECS[s as keyof typeof SEMANTIC_SPECS].hint);
});
