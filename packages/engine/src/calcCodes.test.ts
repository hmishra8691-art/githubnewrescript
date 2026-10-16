import test from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  createResponseState, setAnswer, runCalculations, safeExpression, lintCalculations, lintSurveyLogic,
  unknownCalculationNames, questionCodeAlias, flattenVariables,
} from "./index.js";

/**
 * LOGIC-03 — A CALCULATION RESOLVES A QUESTION CODE, NOT ONLY A VARIABLE NAME.
 *
 * `code: "Q7", variableName: "N"`, answer 5: `Q7 > 3` was false and `Q7 + 1`
 * was 1, with no calc error and no lint — the resolver read the flat map,
 * keyed by variable name, and returned null for anything else. The repro is
 * `docs/audit-2026-10-16/repro/logic/calc-eq.mjs` / `calc-eq2.mjs`.
 */

const mk = (expressions: Record<string, string>) => SurveyDefinition.parse({
  meta: { id: "r", code: "R", title: "t", version: "1" },
  questions: [
    { id: "q1", code: "Q1", variableName: "COLOR", type: "single_select", text: "c", options: [{ code: "1", label: "Red" }, { code: "2", label: "Blue" }] },
    { id: "q7", code: "Q7", variableName: "N", type: "numeric", text: "n" },
    { id: "q8", code: "Q8", variableName: "MANY", type: "multi_select", text: "m", options: [{ code: "1", label: "A" }, { code: "2", label: "B" }] },
    { id: "qm", code: "QM", variableName: "SAT", type: "matrix_single", text: "Rate",
      options: [{ code: "1", label: "Poor" }, { code: "2", label: "Great" }],
      rows: [{ code: "svc", label: "Service", flags: [], validation: [], required: false }] },
  ],
  calculations: Object.entries(expressions).map(([targetVariable, expression], i) => ({ id: `c${i}`, targetVariable, expression, trigger: "on_page_submit" })),
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q7", "q8", "qm"] }, { type: "end", id: "e", status: "complete" }],
});

const answered = (def: SurveyDefinition) => {
  const st = createResponseState(def);
  setAnswer(def, st, "q1", "2", null);
  setAnswer(def, st, "q7", 5, null);
  setAnswer(def, st, "q8", ["2"], null);
  setAnswer(def, st, "qm", { svc: "2" }, null);
  return st;
};

test("a calculation written with question codes reads the answers (code ≠ variable name)", () => {
  const def = mk({ OUT: "Q7 > 3", OUT2: "N > 3", OUT3: "Q7 + 1", OUT4: "Q1 == 2", OUT5: "if(Q1 == 2, 1, 0)" });
  const st = answered(def);
  runCalculations(def, st, "on_page_submit");
  assert.deepEqual(st.calculated, { OUT: true, OUT2: true, OUT3: 6, OUT4: true, OUT5: 1 });
  assert.equal(st.calcErrors, undefined);
});

test("a code-spelled suffix reads the same column the variable name would: Q8_2 is MANY_2, QM_svc is SAT_svc", () => {
  const def = mk({});
  const st = answered(def);
  assert.equal(safeExpression("Q8_2", def, st, null), flattenVariables(def, st).MANY_2);
  assert.equal(safeExpression("Q8_2", def, st, null), 1);
  assert.equal(safeExpression("Q8_1", def, st, null), 0);
  assert.equal(safeExpression("QM_svc", def, st, null), "2");
  /* the variable name still wins when both spellings exist */
  assert.equal(safeExpression("N + 1", def, st, null), 6);
  assert.equal(safeExpression("Q7 + 1", def, st, null), 6);
});

test("questionCodeAlias names the flat variable a code stands for, and nothing for a stranger", () => {
  const def = mk({});
  const flat = new Set(["COLOR", "N", "MANY", "MANY_1", "MANY_2", "SAT_svc"]);
  const has = (k: string) => flat.has(k);
  assert.equal(questionCodeAlias(def, "Q7", has), "N");
  assert.equal(questionCodeAlias(def, "Q8_2", has), "MANY_2");
  assert.equal(questionCodeAlias(def, "QM_svc", has), "SAT_svc");
  assert.equal(questionCodeAlias(def, "QM", has), undefined, "a grid has no single-column variable");
  assert.equal(questionCodeAlias(def, "NOPE", has), undefined);
  assert.equal(questionCodeAlias(def, "NOPE_1", has), undefined);
});

test("lintCalculations: a name that is nothing in the survey is reported, as an error in the survey lint", () => {
  const def = mk({ OUT: "Q7 > 3", BAD: "Q9 + AGE_X", OK2: "COLOR == 2 and MANY_2 == 1 and QM_svc == 2 and OUT > 0 and SUM(MANY_*) > 0", LOOPY: "LOOP_INDEX + loop.index" });
  const unknown = unknownCalculationNames(def);
  assert.deepEqual(unknown.map((u) => [u.targetVariable, u.name]), [["BAD", "Q9"], ["BAD", "AGE_X"]]);
  const messages = lintCalculations(def);
  assert.ok(messages.some((m) => m === "Calculation BAD reads “Q9”, which is not a variable, question code or embedded field of this survey — it is empty for every respondent."), messages.join(" | "));
  assert.ok(!messages.some((m) => /Calculation (OUT|OK2|LOOPY) reads/.test(m)), messages.join(" | "));
  const issues = lintSurveyLogic(def).filter((i) => /is not a variable, question code or embedded field/.test(i.message));
  assert.equal(issues.length, 2);
  assert.ok(issues.every((i) => i.level === "error" && i.path.startsWith("calculations[1]")));
});

test("lintCalculations: a variable renamed after the calculation was written is caught", () => {
  const def = mk({ OUT: "N > 3" });
  def.questions[1].variableName = "COUNT_N";
  assert.ok(lintCalculations(def).some((m) => /reads “N”/.test(m)));
  const fine = mk({ OUT: "Q7 > 3" });
  fine.questions[1].variableName = "COUNT_N";
  assert.ok(!lintCalculations(fine).some((m) => /reads “Q7”/.test(m)), "the code still resolves after a variable rename");
});
