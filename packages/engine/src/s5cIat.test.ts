import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { iatDScore, iatVariables, type IatTrial } from "./iatScore.js";
import { buildVariableDictionary } from "./variables.js";
import { createResponseState } from "./state.js";
import { runCalculations } from "./flow.js";

/*
 * S5c item 4 (SM-18): Greenwald, Nosek & Banaji (2003) improved D, D600 — a hand-computed example.
 *   B3 compatible practice    600 700 800 900✗    correct mean 700 → 900✗ becomes 1300; block mean 850
 *   B6 incompatible practice  900 1000 1100✗ 1200 correct mean 1033.33 → 1100✗ becomes 1633.33; block mean 1183.33
 *   SD(B3+B6, the original 8 latencies) = 200 → D practice = (1183.33 − 850) / 200 = 1.6667
 *   B4 compatible test        500 600 700 650      block mean 612.5
 *   B7 incompatible test      800 900 12000 1000✗  12000 > 10,000 dropped; correct mean 850 → 1000✗ becomes 1450; block mean 1050
 *   SD(B4+B7, 7 latencies) = 174.9149 → D test = 437.5 / 174.9149 = 2.5012
 *   D = (1.6667 + 2.5012) / 2 = 2.0839
 */
const T = (xs: [number, boolean][]): IatTrial[] => xs.map(([rt, correct]) => ({ rt, correct }));
const BLOCKS = {
  compatible_practice: T([[600, true], [700, true], [800, true], [900, false]]),
  incompatible_practice: T([[900, true], [1000, true], [1100, false], [1200, true]]),
  compatible_test: T([[500, true], [600, true], [700, true], [650, true]]),
  incompatible_test: T([[800, true], [900, true], [12000, true], [1000, false]]),
};
const near = (a: number | null, b: number, tol = 1e-4) => assert.ok(a != null && Math.abs(a - b) < tol, `${a} ≈ ${b}`);

test("D600: the hand-computed practice, test and overall D; slow trials dropped", () => {
  const r = iatDScore(BLOCKS);
  near(r.dPractice, 1.666667);
  near(r.dTest, 2.501216);
  near(r.d, 2.083941);
  assert.equal(r.slowDropped, 1);
  assert.equal(r.trials, 15);
  assert.equal(r.excluded, false);
});

test("D600: more than 10 % of trials under 300 ms excludes the respondent; one pair alone scores; a block with no correct trial is unscored", () => {
  const fast = { ...BLOCKS, compatible_test: T([[200, true], [250, true], [700, true], [650, true]]) };   // 2 of 15 = 13 % fast
  const r = iatDScore(fast);
  assert.equal(r.excluded, true);
  assert.equal(r.d, null);
  near(iatDScore({ compatible_test: BLOCKS.compatible_test, incompatible_test: BLOCKS.incompatible_test }).d, 2.501216);
  assert.equal(iatDScore({ compatible_test: T([[500, false], [600, false]]), incompatible_test: BLOCKS.incompatible_test }).d, null);
});

const ROWS = ["s1", "s2", "s3", "s4"].map((code) => ({ code, label: code }));
const OPTS = [{ code: 1, label: "Left" }, { code: 2, label: "Right" }];
const KEY = { s1: 1, s2: 1, s3: 2, s4: 2 };
const roles = ["compatible_practice", "incompatible_practice", "compatible_test", "incompatible_test"] as const;
const def = SurveyDefinition.parse({
  meta: { id: "i", code: "I", title: "IAT" },
  questions: roles.map((role, i) => ({ id: `q${i}`, code: `B${i}`, variableName: `B${i}`, type: "matrix_single", variant: "experimental.reaction_time", text: role, rows: ROWS, options: OPTS, settings: { iatBlock: { role, key: KEY } } })),
  flow: [{ type: "page", id: "p", questionIds: ["q0", "q1", "q2", "q3"] }, { type: "end", id: "e", status: "complete" }],
});
/* the answers that make the BLOCKS above: an ✗ answers the wrong side for that row */
const answersFor = (trials: IatTrial[]) => Object.fromEntries(ROWS.map((r, k) => [r.code, trials[k].correct ? KEY[r.code as keyof typeof KEY] : 3 - KEY[r.code as keyof typeof KEY]]));
const rtsFor = (trials: IatTrial[]) => Object.fromEntries(ROWS.map((r, k) => [r.code, trials[k].rt]));

test("the engine writes IAT_D from the stored answers and __rt maps, in the calculation pass; the dictionary declares it", () => {
  const state = createResponseState(def, { seed: 1 } as never);
  roles.forEach((role, i) => { state.answers[`q${i}`] = answersFor(BLOCKS[role]) as never; state.answers[`q${i}__rt`] = rtsFor(BLOCKS[role]) as never; });
  const v = iatVariables(def, state);
  near(v.IAT_D as number, 2.0839);
  assert.equal(v.IAT_EXCLUDED, 0);
  runCalculations(def, state, "on_page_submit");
  near(state.calculated.IAT_D as number, 2.0839);
  const names = buildVariableDictionary(def).map((x) => x.name);
  for (const n of ["IAT_D", "IAT_TRIALS", "IAT_FAST_SHARE", "IAT_EXCLUDED"]) assert.ok(names.includes(n), n);
});

import { applySurveyActions, coerceSurveyActions } from "./surveyActions.js";
test("add_method_template iat: four tagged combined blocks with mirrored keys; a perfect fast-compatible respondent gets a positive D", () => {
  const base = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  const c = coerceSurveyActions([{ op: "add_method_template", template: "iat", targets: ["Coffee", "Tea"], attributes: ["Good", "Bad"] }]);
  assert.deepEqual(c.rejected, []);
  const r = applySurveyActions(base, c.actions);
  assert.ok(r.results.every((x) => x.ok), JSON.stringify(r.results));
  const qs = r.def.questions;
  assert.deepEqual(qs.map((q) => (q.settings as { iatBlock?: { role: string } }).iatBlock!.role), ["compatible_practice", "compatible_test", "incompatible_practice", "incompatible_test"]);
  assert.equal(qs[0].options[0].label, "Coffee or Good");
  assert.equal(qs[2].options[0].label, "Tea or Good");
  const k3 = (qs[0].settings as { iatBlock: { key: Record<string, number> } }).iatBlock.key, k6 = (qs[2].settings as { iatBlock: { key: Record<string, number> } }).iatBlock.key;
  assert.equal(k3.a1, 1); assert.equal(k6.a1, 2); assert.equal(k3.g1, 1); assert.equal(k6.g1, 1);
  /* all correct; compatible 600 ms per trial, incompatible 900 ms — D > 0 */
  const state = createResponseState(r.def, { seed: 1 } as never);
  qs.forEach((q, i) => {
    const key = (q.settings as { iatBlock: { key: Record<string, number> } }).iatBlock.key;
    state.answers[q.id] = { ...key } as never;
    state.answers[`${q.id}__rt`] = Object.fromEntries(Object.keys(key).map((k, j) => [k, (i < 2 ? 600 : 900) + j * 10])) as never;
  });
  runCalculations(r.def, state, "on_page_submit");
  assert.ok((state.calculated.IAT_D as number) > 1, String(state.calculated.IAT_D));
  assert.equal(r.def.research!.analysisPlan!.tests[0].method, "iat_dscore");
  assert.match(JSON.stringify(coerceSurveyActions([{ op: "add_method_template", template: "iat", targets: ["A"] }]).rejected), /two different names/);
});
