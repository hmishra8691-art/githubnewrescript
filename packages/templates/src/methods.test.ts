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
