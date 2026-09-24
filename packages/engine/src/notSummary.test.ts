import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, cond } from "@rescript/schema";
import {
  conditionSummary, formatCondition, evaluateCondition, createResponseState, setAnswer,
} from "./index.js";

/**
 * THE ENGLISH FOR A MULTI-CHILD NOT MUST SAY WHAT THE RUNTIME DOES.
 *
 * `evaluateCondition` treats `not(a, b)` as "none of these" — NOT(a OR b).
 * `formatCondition` prints it that way. `conditionSummary` printed
 * `not (a and b)`, which is NAND: true whenever either child is false. The
 * Logic panel and every Flow edge label read that summary, so a programmer
 * checking their routing was told the opposite of what respondents get.
 *
 * These tests pin the summary to the evaluator, not to a fixed string, so a
 * future rewording cannot quietly reintroduce the disagreement.
 */

const def = SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "T" },
  questions: [
    { id: "qa", code: "QA", variableName: "QA", type: "numeric", text: "A" },
    { id: "qb", code: "QB", variableName: "QB", type: "numeric", text: "B" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["qa", "qb"] }, { type: "end", id: "e", status: "complete" }],
  deployment: { clientSlug: "c", studySlug: "s" },
});

const none = cond.not(cond.rule("qa", "eq", 1), cond.rule("qb", "eq", 1));

function truth(a: number, b: number): boolean {
  const state = createResponseState(def, { seed: 1 });
  setAnswer(def, state, "qa", a);
  setAnswer(def, state, "qb", b);
  return evaluateCondition(none, { def, state, loop: null } as never);
}

test("the evaluator treats a multi-child NOT as NOR (none of these)", () => {
  assert.equal(truth(0, 0), true, "neither true → the NOT holds");
  assert.equal(truth(1, 0), false, "one true → the NOT fails (NAND would say true here)");
  assert.equal(truth(0, 1), false);
  assert.equal(truth(1, 1), false);
});

test("the summary describes NOR, in the same terms as the formatter", () => {
  const s = conditionSummary(def, none);
  assert.match(s, /none of|not .* or /i, `summary does not read as "none of these": ${s}`);
  assert.doesNotMatch(s, /not \(.* and .*\)/i,
    `summary reads as NAND — the opposite of what the runtime computes: ${s}`);
  // the formatter is the reference rendering; the two must agree on the connective
  const f = formatCondition(def, none);
  assert.match(f, /NOT \(.* OR .*\)/, `formatter changed shape: ${f}`);
});

test("a single-child NOT still reads as a plain negation", () => {
  const s = conditionSummary(def, cond.not(cond.rule("qa", "eq", 1)));
  assert.match(s, /^not /i, s);
  assert.doesNotMatch(s, /none of/i, "one child is not a set — 'none of' would be odd here");
});

test("AND and OR summaries are unchanged", () => {
  assert.match(conditionSummary(def, cond.and(cond.rule("qa", "eq", 1), cond.rule("qb", "eq", 1))), / AND /);
  assert.match(conditionSummary(def, cond.or(cond.rule("qa", "eq", 1), cond.rule("qb", "eq", 1))), / OR /);
});
