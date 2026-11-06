import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { interpretRequest } from "./nlIntent.js";

/* INTELLIGENT MODE IM1 — the two misreads of the 2026-11-06 audit */
const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
const def = SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Pricing" },
  questions: [
    { id: "q1", code: "Q1", variableName: "EMAIL", type: "open_text", text: "What is your email address?" },
    { id: "q2", code: "Q2", variableName: "GENDER", type: "single_select", text: "Gender", options: opts("Male", "Female") },
    { id: "q6", code: "Q6", variableName: "PRICE", type: "numeric", text: "What would you pay?" },
  ],
  flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", title: "Main", questionIds: ["q1", "q2", "q6"] }] }, { type: "end", id: "e", status: "complete" }],
});

for (const s of ["Require a number between 1 and 100 in Q6", "Only accept values from 1 to 100 on Q6", "Q6 must be between 1 and 100"]) {
  test(`range validation: ${s}`, () => {
    const out = interpretRequest(def, s);
    assert.equal(out.kind, "actions", JSON.stringify(out).slice(0, 400));
    const a = (out as { actions: { op: string; target: string; rules: { kind: string; value: number }[] }[] }).actions[0];
    assert.equal(a.op, "set_validation"); assert.equal(a.target, "Q6");
    assert.deepEqual(a.rules.map((r) => [r.kind, r.value]), [["min_value", 1], ["max_value", 100]]);
  });
}

test("Require Q2 still makes Q2 required", () => {
  const out = interpretRequest(def, "Require Q2");
  assert.equal(out.kind, "actions");
});

test("a conflicting request is asked about, naming both halves", () => {
  for (const s of ["Make the survey anonymous but record every respondent's email", "Keep responses anonymous and collect their phone number"]) {
    const out = interpretRequest(def, s);
    assert.equal(out.kind, "clarify", s);
    const c = out as { understood: string; choices: { text: string }[] };
    assert.match(c.understood, /anonymous/); assert.match(c.understood, /email|phone/);
    assert.equal(c.choices.length, 3);
  }
  const back = interpretRequest(def, "Remove the back button but let respondents go back and change their answers");
  assert.equal(back.kind, "clarify");
  const [hide, show] = (back as { choices: { text: string }[] }).choices;
  assert.equal(interpretRequest(def, hide.text).kind, "actions", hide.text);
  const again = interpretRequest(def, show.text) as { kind: string; noop?: boolean };
  assert.ok(again.kind === "refused" && again.noop, "the back button is shown by default — nothing to change");
});

test("non-conflicts are untouched", () => {
  for (const s of ["Make the survey anonymous", "Add a question asking for the respondent's email", "Hide the back button"]) assert.notEqual(interpretRequest(def, s).kind, "clarify", s);
});
