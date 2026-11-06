import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { plannedAnalyses } from "./planBridge.js";

/* IM9 — the plan's weighting runs with every planned analysis */
test("every planned analysis carries the plan's rim weighting", () => {
  const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "x" },
    research: { hypotheses: [], constructs: [], analysis: [], assumptions: [], sources: [], analysisPlan: { weightingScheme: { rim: [{ variable: "GENDER", targets: { "1": 48, "2": 52 } }], cap: [0.3, 3] }, crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: [] }], tests: [], derived: [], segments: [] } },
    questions: [
      { id: "q1", code: "Q1", variableName: "GENDER", type: "single_select", text: "Gender", options: opts("Male", "Female") },
      { id: "q2", code: "Q2", variableName: "SAT", type: "single_select", text: "Sat", options: opts("1", "2", "3") },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }],
  });
  const p = plannedAnalyses(def, { environment: "LIVE" } as never);
  assert.ok(p.length >= 1);
  for (const a of p) assert.deepEqual(a.definition.weighting, { rim: [{ variable: "GENDER", targets: { "1": 48, "2": 52 } }], cap: [0.3, 3] });
});
