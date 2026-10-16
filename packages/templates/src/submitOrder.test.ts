import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { simulateRespondent } from "./index.js";

/** LOGIC-11: on_submit is the work a page does on the way OUT — it must not fire on a rejected submit. */
const survey = () => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Submit order", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "Age?", validation: [{ id: "v1", kind: "min_value", value: 18, message: "too young" }] },
    { id: "q2", code: "Q2", variableName: "X", type: "open_text", text: "Anything" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "end", id: "e", status: "complete" }],
  scripts: [
    { id: "s1", name: "submit side effect", scope: "page", ref: "p1", event: "on_submit", code: "log('SUBMIT-RAN');" },
    { id: "s2", name: "veto", scope: "page", ref: "p1", event: "on_validate", enabled: false, code: "error('no', 'q2');" },
  ],
});

test("on_submit does not run when built-in validation blocks the page", () => {
  const def = survey();
  const r = simulateRespondent(def, { answers: { q1: 5, q2: "x" } });
  assert.ok(r.blocked, "page is blocked");
  assert.ok(!r.logs.some((l) => l.includes("SUBMIT-RAN")), "on_submit side effect must not run on a rejected submit");
});

test("on_submit does not run when an on_validate script blocks the page", () => {
  const def = survey();
  def.scripts[1].enabled = true;
  const r = simulateRespondent(def, { answers: { q1: 30, q2: "x" } });
  assert.ok(r.blocked);
  assert.ok(!r.logs.some((l) => l.includes("SUBMIT-RAN")));
});

test("on_submit still runs on a valid submit", () => {
  const r = simulateRespondent(survey(), { answers: { q1: 30, q2: "x" } });
  assert.ok(!r.blocked);
  assert.ok(r.logs.some((l) => l.includes("SUBMIT-RAN")));
});
