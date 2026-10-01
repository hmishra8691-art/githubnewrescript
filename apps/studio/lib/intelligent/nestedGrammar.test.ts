import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond, type Question } from "@rescript/schema";
import { buildDependencyIndex, createResponseState, evaluateCondition, formatCondition } from "@rescript/engine";
import { parseIntent } from "./grammar.ts";
import { planProposal, normaliseExpression, planExpression, type PlannerDeps } from "./proposal.ts";

/*
 * Plain-language nested logic (nested-logic audit, 2026-10-01): the words
 * people use for AND / OR / NOT, "unless" as an exception, and "also" as an
 * additional way in — each read into the same condition tree the builder makes.
 */
const survey = () =>
  SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Grammar" },
    questions: [
      { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "Age" },
      { id: "q2", code: "Q2", variableName: "CAR", type: "single_select", text: "Car?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
      { id: "q3", code: "Q3", variableName: "BRANDS", type: "multi_select", text: "Brands", options: [1, 2, 3].map((c) => ({ code: c, label: `B${c}` })) },
      { id: "q4", code: "Q4", variableName: "X", type: "open_text", text: "Why?", displayLogic: cond.rule("q2", "eq", 1) },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4"] }, { type: "end", id: "e", status: "complete" }],
  });
let n = 0;
const deps = (def: SurveyDefinition): PlannerDeps => ({
  uid: (p) => `${p}_${++n}`,
  makeQuestion: () => ({}) as Question,
  index: buildDependencyIndex(def),
});
const holds = (text: string, answers: Record<string, unknown>) => {
  const def = survey();
  const ex = planExpression(def, text);
  assert.deepEqual(ex.errors, [], text);
  const state = createResponseState(def, { seed: 1 });
  Object.assign(state.answers, answers);
  return evaluateCondition(ex.condition, { def, state, loop: null });
};

test("neither / nor, either / or, both / and, but not, except", () => {
  assert.equal(normaliseExpression("neither Q3 = 1 nor Q3 = 2"), "NOT (Q3 = 1 OR Q3 = 2)");
  assert.equal(holds("neither Q3 = 1 nor Q3 = 2", { q3: [3] }), true);
  assert.equal(holds("neither Q3 = 1 nor Q3 = 2", { q3: [2] }), false);
  assert.equal(holds("either Q2 = 1 or Q1 > 60", { q2: 2, q1: 70 }), true);
  assert.equal(holds("both Q2 = 1 and Q1 > 60", { q2: 1, q1: 50 }), false);
  assert.equal(holds("Q3 = 1 but not Q3 = 2", { q3: [1, 2] }), false);
  assert.equal(holds("Q3 = 1 but not Q3 = 2", { q3: [1] }), true);
  assert.equal(holds("Q1 >= 18 except when Q2 = 2", { q1: 30, q2: 2 }), false);
});

test("“A unless B” is (A) AND NOT (B); a bare “unless” negates the whole condition", () => {
  const i = parseIntent("show Q4 when Q1 >= 18 unless Q2 = 2");
  assert.equal(i.kind, "display");
  assert.equal((i as { expression: string }).expression, "(Q1 >= 18) AND NOT (Q2 = 2)");
  const bare = parseIntent("show Q4 unless Q2 = 2");
  assert.match((bare as { expression: string }).expression, /^NOT \(/);
});

test("“also show” ORs the new way in with the logic already there; plain “show” replaces it and says so", () => {
  const def = survey();
  const also = planProposal(def, parseIntent("also show Q4 when Q1 > 60"), "grammar", deps(def));
  assert.deepEqual(also.errors ?? [], []);
  const set = also.changes.find((c) => c.kind === "set_display_logic") as unknown as { condition: Parameters<typeof formatCondition>[1] };
  assert.equal(formatCondition(def, set.condition), "Q2 = 1 OR Q1 > 60");
  const replace = planProposal(def, parseIntent("show Q4 when Q1 > 60"), "grammar", deps(def));
  assert.ok(replace.warnings.some((w) => /replaces it/.test(w) && /also show/.test(w)));
});
