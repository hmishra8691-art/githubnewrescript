import { test } from "node:test";
import assert from "node:assert/strict";
import { findSurveyTemplate } from "./index.js";
import { simulateRespondent } from "./simulate.js";

/* S5c: the method starters carry their analysis-plan items and walk end to end (the generic checks are in starters.test.ts) */

test("pricing_psm starter: VW + NMS questions, NMS texts piped, the pricing plan item names them", () => {
  const def = findSurveyTemplate("pricing_psm")!.build("x");
  assert.deepEqual(def.questions.map((q) => q.variableName), ["PSM_TOO_CHEAP", "PSM_CHEAP", "PSM_EXPENSIVE", "PSM_TOO_EXPENSIVE", "NMS_CHEAP", "NMS_EXPENSIVE"]);
  const t = def.research!.analysisPlan!.tests[0];
  assert.equal(t.method, "pricing");
  assert.equal(t.options!.nmsExpensive, "NMS_EXPENSIVE");
  const run = simulateRespondent(def, { seed: 3, answers: {} });
  assert.equal(run.endStatus, "complete");
});

test("price_ladder starter: one ladder question, the gabor_granger ladder plan item, a respondent completes it", () => {
  const def = findSurveyTemplate("price_ladder")!.build("x");
  assert.equal(def.questions[0].variant, "numeric.price_ladder");
  assert.deepEqual(def.research!.analysisPlan!.tests[0].options, { method: "gabor_granger", ladder: true, prices: [5, 10, 15, 20, 25] });
  const run = simulateRespondent(def, { seed: 3, answers: {} });
  assert.equal(run.endStatus, "complete");
  assert.equal(run.state.answers[def.questions[0].id], 15, "the simulated respondent answers a ladder price (the middle one)");
});

test("sequential_monadic starter: three concept blocks rotated, the plan item reads the ratings and the stored order", () => {
  const def = findSurveyTemplate("sequential_monadic")!.build("x");
  const t = def.research!.analysisPlan!.tests[0];
  assert.equal(t.method, "sequential_monadic");
  assert.match(String(t.options!.order), /^ORDER_/);
  const run = simulateRespondent(def, { seed: 5, answers: {} });
  assert.equal(run.endStatus, "complete");
  assert.equal(run.pages.length, 3, "one page per concept");
});

test("brand_funnel starter: unaided coded by ai_classify, the aided funnel carried forward, the brand_funnel plan item over the four stages", () => {
  const def = findSurveyTemplate("brand_funnel")!.build("x");
  const coded = def.questions.find((q) => q.variableName === "UNAIDED_CODED")!;
  assert.match(String(coded.settings.expression), /^ai_classify\(UNAIDED, "Alpha\|Beta\|Gamma\|Delta\|Other\|None"\)$/);
  assert.equal(def.questions.find((q) => q.variableName === "CONSIDER")!.carryForward?.sourceQuestionId, def.questions.find((q) => q.variableName === "AWARE")!.id);
  const t = def.research!.analysisPlan!.tests;
  assert.deepEqual(t[0].variables, ["AWARE", "CONSIDER", "PURCHASED", "PREFER"]);
  assert.equal(t[0].method, "brand_funnel");
  const run = simulateRespondent(def, { seed: 2, answers: {} });
  assert.equal(run.endStatus, "complete");
});

test("ad_test starter: forced exposure (video_rating, requireComplete), recall coded and aided, diagnostics, intent — and the planned analyses", () => {
  const def = findSurveyTemplate("ad_test")!.build("x");
  const ad = def.questions.find((q) => q.variableName === "AD_LIKE")!;
  assert.equal(ad.variant, "media.video_rating");
  assert.equal(ad.settings.requireComplete, true);
  assert.deepEqual(def.research!.analysisPlan!.tests.map((t) => t.method), ["frequencies", "mean", "top_box"]);
  assert.equal(def.questions.find((q) => q.variableName === "AD_DIAG")!.rows.length, 5);
});
