import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { checkScripts } from "@rescript/templates";
import { scriptStatusAnswer, scriptStatusQuestion } from "./scriptCheck.ts";

test("reads script-status questions, not script edits", () => {
  for (const t of ["Did the AI's script run?", "check the scripts", "which scripts are validated?", "is my JavaScript code working?", "validate all scripts"]) assert.ok(scriptStatusQuestion(t), t);
  for (const t of ["write a script that totals Q1 and Q2", "delete the script Total", "make Q3 required"]) assert.ok(!scriptStatusQuestion(t), t);
});

test("the answer separates generated, executed and validated", () => {
  const def = SurveyDefinition.parse({
    meta: { id: "x", code: "X", title: "X", version: "1.0" },
    questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "numeric", text: "N?", required: true, settings: { minValue: 0, maxValue: 3 } }],
    flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }],
    scripts: [
      { id: "a", name: "Logs", scope: "page", ref: "p1", event: "on_submit", code: "log(get('Q1'))", origin: "ai" },
      { id: "b", name: "Never", scope: "page", ref: "nowhere", event: "on_submit", code: "log(1)" },
    ],
  });
  const a = scriptStatusAnswer({ check: checkScripts(def, { count: 20 }), defKey: "", at: 0, casesNote: "The sandbox has no test cases." });
  assert.match(a.answer, /2 logic scripts, checked against 20 simulated respondents: 1 never ran, 1 executed/);
  assert.match(a.answer, /sandbox has no test cases/);
  assert.deepEqual(a.sections.map((s) => s.title), ["Never ran", "Executed"]);
});
