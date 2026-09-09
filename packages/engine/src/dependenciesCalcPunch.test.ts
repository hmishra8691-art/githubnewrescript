import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { questionDependencies } from "./dependencies.js";

/**
 * Gap #4: a punch (or any rule) gated on a CALCULATED variable must be
 * discovered as depending on the question(s) that feed that calculation —
 * otherwise the same-page dependency graph (`Runner.tsx`'s live re-punch on
 * answer change) never re-fires it when the underlying question changes.
 * Next-page arrival was never affected (`runCalculations` always runs
 * before punches there); this is specifically the same-page case.
 */

const def = () =>
  SurveyDefinition.parse({
    meta: { id: "cg", code: "CG", title: "Calc-gated punch", version: "1.0" },
    questions: [
      { id: "q1", code: "Q1", variableName: "Q1", type: "numeric", text: "A number" },
      { id: "q2", code: "Q2", variableName: "Q2", type: "numeric", text: "Another number" },
      {
        id: "q3", code: "Q3", variableName: "Q3", type: "single_select", text: "Derived",
        options: [{ code: "hi", label: "High" }, { code: "lo", label: "Low" }],
        punches: [
          {
            id: "p1",
            source: { kind: "codes", codes: ["hi"] },
            action: "select",
            recompute: "always",
            mapping: [],
            ignoreUnmatched: true,
            // gated on a CALCULATED variable, not a question directly
            when: {
              type: "rule",
              source: { kind: "calculation", ref: "SCORE" },
              operator: "gte",
              value: 5,
            },
          },
        ],
      },
    ],
    calculations: [
      { id: "c1", targetVariable: "SCORE", expression: "Q1 + Q2" },
    ],
    flow: [
      { type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] },
      { type: "end", id: "e1", status: "complete" },
    ],
  });

test("a punch's `when` gated on a calculated variable resolves to the questions feeding that calculation", () => {
  const d = def();
  const q3 = d.questions.find((q) => q.id === "q3")!;
  const deps = questionDependencies(d, q3);
  assert.ok(deps.has("q1"), "Q1 feeds SCORE, which gates the punch");
  assert.ok(deps.has("q2"), "Q2 feeds SCORE too");
});

test("a calc-gated punch sees through a CHAIN of calculations (TOTAL reads SUBTOTAL reads Q1/Q2)", () => {
  const d = def();
  d.calculations = [
    { id: "c1", targetVariable: "SUBTOTAL", expression: "Q1 + Q2" },
    { id: "c2", targetVariable: "SCORE", expression: "SUBTOTAL * 1.2" },
  ] as any;
  const q3 = d.questions.find((q) => q.id === "q3")!;
  const deps = questionDependencies(d, q3);
  assert.ok(deps.has("q1") && deps.has("q2"), "transitively discovered through SUBTOTAL");
});

test("a self-referential calculation chain does not hang dependency resolution", () => {
  const d = def();
  d.calculations = [
    { id: "c1", targetVariable: "SCORE", expression: "OTHER" },
    { id: "c2", targetVariable: "OTHER", expression: "SCORE" },
  ] as any;
  const q3 = d.questions.find((q) => q.id === "q3")!;
  // must return, not loop forever — the cycle itself is reported elsewhere
  // (`calculationCycles`), this just must not hang
  const deps = questionDependencies(d, q3);
  assert.ok(deps instanceof Set);
});
