import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions } from "./surveyActions.js";

/**
 * EXISTING-COMPONENT AWARENESS (2026-11-07). The partial apply of a 100-question exam refused 16 changes — "An
 * embedded variable ANS_Q90 already exists", "SCORE_Q90 is already a variable" — because a repair re-created the
 * answer key's variables. Creating what exists is now an update (or nothing, when identical), never a refusal and
 * never a duplicate; running the same repair twice changes nothing the second time.
 */
const base = () => SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "S", version: "1" }, questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "2+2?", options: [{ code: 1, label: "3" }, { code: 2, label: "4" }] }], flow: [{ id: "b1", type: "block", title: "Main", children: [{ id: "p1", type: "page", questionIds: ["q1"] }] }] });

test("create_embedded / create_calculation are idempotent: same → kept, different → updated in place, never doubled", () => {
  const first = applySurveyActions(base(), [
    { op: "create_embedded", name: "ANS_Q1", source: "static", value: "2" } as never,
    { op: "create_calculation", name: "SCORE_Q1", expression: "IF(Q1 = 2, 1, 0)" } as never,
  ]);
  assert.deepEqual(first.errors, []);
  const again = applySurveyActions(first.def, [
    { op: "create_embedded", name: "ANS_Q1", source: "static", value: "2" } as never,
    { op: "create_calculation", name: "SCORE_Q1", expression: "IF(Q1 = 2, 1, 0)" } as never,
  ]);
  assert.deepEqual(again.errors, [], "the same repair applied twice is not refused");
  assert.match(again.results[0].description, /already there as asked — kept/);
  assert.equal(JSON.stringify(again.def.calculations), JSON.stringify(first.def.calculations), "and changes nothing");
  const changed = applySurveyActions(first.def, [
    { op: "create_embedded", name: "ANS_Q1", source: "static", value: "1" } as never,
    { op: "create_calculation", name: "SCORE_Q1", expression: "IF(Q1 = 1, 1, 0)" } as never,
  ]);
  assert.deepEqual(changed.errors, []);
  assert.equal(changed.def.calculations!.filter((c) => c.targetVariable === "SCORE_Q1").length, 1, "updated, not doubled");
  assert.match(changed.results[1].description, /updated: .* → /);
  const flowText = JSON.stringify(changed.def.flow);
  assert.equal((flowText.match(/"ANS_Q1"/g) ?? []).length, 1, "one embedded variable");
  assert.match(flowText, /"value":"1"/);
  /* a question's own variable is still protected */
  assert.equal(applySurveyActions(first.def, [{ op: "create_calculation", name: "Q1", expression: "1" } as never]).errors.length, 1);
});
