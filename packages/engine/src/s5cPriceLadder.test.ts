import { test } from "node:test";
import assert from "node:assert/strict";
import { Question, SurveyDefinition } from "@rescript/schema";
import { ladderInit, ladderRun, ladderStartIndex, ladderStep, ladderAnswerValid, ladderParadataKeys, ladderPathText, lintPriceLadder } from "./priceLadder.js";
import { applySurveyActions, coerceSurveyActions } from "./surveyActions.js";
import { buildVariableDictionary } from "./variables.js";
import { advancedSuitability } from "./advancedMethods.js";
import { validateQuestion } from "./validate.js";

/* S5c item 2 (SM-07): the adaptive Gabor–Granger ladder — step rule, answer, paradata, template, plan check */

const P = [10, 15, 20, 25, 30];

test("start index: middle (lower middle when even), ends, random seeded", () => {
  assert.equal(ladderStartIndex(5), 2);
  assert.equal(ladderStartIndex(4), 1);
  assert.equal(ladderStartIndex(5, "lowest"), 0);
  assert.equal(ladderStartIndex(5, "highest"), 4);
  assert.equal(ladderStartIndex(5, "random", 0.99), 4);
  assert.equal(ladderStartIndex(5, "random", 0), 0);
});

test("step rule: up after yes, down after no, stop at the first boundary or an end — every path checked", () => {
  /* WTP 22 from the middle (20): yes → 25: no → 20 already asked → stop; highest 20 */
  let s = ladderRun(P, 22);
  assert.deepEqual(s.answers, [{ price: 20, accepted: true }, { price: 25, accepted: false }]);
  assert.equal(s.highest, 20);
  /* WTP 12: 20 no → 15 no → 10 yes → 15 asked → stop; highest 10 */
  s = ladderRun(P, 12);
  assert.equal(ladderPathText(s.answers), "20:0,15:0,10:1");
  assert.equal(s.highest, 10);
  /* WTP 5: 20 no, 15 no, 10 no → bottom → stop; none (0) */
  s = ladderRun(P, 5);
  assert.equal(ladderPathText(s.answers), "20:0,15:0,10:0");
  assert.equal(s.highest, 0);
  /* WTP 100: 20, 25, 30 yes → top → stop */
  s = ladderRun(P, 100);
  assert.equal(ladderPathText(s.answers), "20:1,25:1,30:1");
  assert.equal(s.highest, 30);
  /* from the lowest: WTP 17 → 10 yes, 15 yes, 20 no → stop at 15 */
  s = ladderRun(P, 17, "lowest");
  assert.equal(ladderPathText(s.answers), "10:1,15:1,20:0");
  assert.equal(s.highest, 15);
  /* the answer always equals the highest ladder price ≤ WTP (the monotone respondent), from every start */
  for (const start of ["middle", "lowest", "highest"] as const) for (const wtp of [0, 9, 10, 14, 15, 21, 30, 31]) {
    const exp = Math.max(0, ...P.filter((p) => p <= wtp));
    assert.equal(ladderRun(P, wtp, start).highest, exp, `${start} wtp ${wtp}`);
  }
  /* a finished ladder does not move */
  const done = ladderRun(P, 22);
  assert.equal(ladderStep(done, true), done);
  assert.equal(ladderInit([], "middle").done, true);
});

const q = Question.parse({ id: "q1", code: "GG", variableName: "GG", type: "numeric", variant: "numeric.price_ladder", text: "x", settings: { minValue: 0, maxValue: 30, priceLadder: { prices: P } } });

test("answer validity, paradata keys, lint, and the server check", () => {
  assert.equal(ladderAnswerValid(q, 20), true);
  assert.equal(ladderAnswerValid(q, 0), true);
  assert.equal(ladderAnswerValid(q, 21), false);
  assert.deepEqual(ladderParadataKeys("GG"), { start: "GG_GG_START", path: "GG_GG_PATH" });
  assert.deepEqual(lintPriceLadder(q), []);
  const bad = Question.parse({ ...q, settings: { minValue: 5, maxValue: 20, priceLadder: { prices: [10, 10, 30] } } });
  const lint = lintPriceLadder(bad).join(" | ");
  assert.match(lint, /at least three prices/);
  assert.match(lint, /same/);
  assert.match(lint, /minValue must be 0/);
  assert.match(lint, /below the top ladder price 30/);
  const def = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [q], flow: [] });
  const ctx = { def, state: { answers: {}, embedded: {} } } as never;
  assert.ok(validateQuestion(def, q, 21, ctx).length > 0, "a price not on the ladder is refused by the engine");
  assert.deepEqual(validateQuestion(def, q, 20, ctx), []);
  assert.deepEqual(validateQuestion(def, q, 0, ctx), []);
});

test("price_ladder template: the variant question, its paradata variables, the gabor_granger ladder plan item that passes suitability", () => {
  const base = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  const c = coerceSurveyActions([{ op: "add_method_template", template: "price_ladder", product: "the plan", currency: "€", prices: [30, 10, 20, 40], start: "random" }]);
  assert.deepEqual(c.rejected, []);
  const r = applySurveyActions(base, c.actions);
  assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results));
  const lq = r.def.questions[0];
  assert.equal(lq.variant, "numeric.price_ladder");
  assert.deepEqual(lq.settings.priceLadder!.prices, [10, 20, 30, 40]);
  assert.equal(lq.settings.maxValue, 40);
  const names = buildVariableDictionary(r.def).map((v) => v.name);
  assert.ok(names.includes("PRICE_LADDER") && names.includes("GG_PRICE_LADDER_PATH") && names.includes("GG_PRICE_LADDER_START"));
  const t = r.def.research!.analysisPlan!.tests[0];
  assert.deepEqual(t.options, { method: "gabor_granger", ladder: true, prices: [10, 20, 30, 40] });
  assert.deepEqual(advancedSuitability(r.def, t).blocking, []);
  assert.match(advancedSuitability(r.def, { ...t, options: { ...t.options, prices: [10] } }).blocking.join(" "), /three or more/);
  const bad = coerceSurveyActions([{ op: "add_method_template", template: "price_ladder", prices: [10, 10, 20] }]);
  assert.match(JSON.stringify(bad.rejected), /3–20 different positive numbers/);
});
