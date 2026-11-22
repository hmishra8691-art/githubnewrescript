import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions } from "./surveyActions.js";

test("a popup 'on option 0' of a 0–10 question is refused with how to trigger on the value instead", () => {
  const def = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "S", version: "1.0" }, questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "nps", text: "How likely…" }], flow: [{ type: "page", id: "p1", questionIds: ["q1"] }] });
  const r = applySurveyActions(def, coerceSurveyActions([{ op: "create_behavior", label: "detractor popup", target: "Q1", on: "select_option", options: ["0"], effects: [{ do: "popup", text: "Sorry to hear that" }] }]).actions, { uxOnly: true });
  const msg = String(r.results[0]?.error ?? "");
  assert.equal(r.results[0]?.ok, false);
  assert.match(msg, /Q1 has no option “0”: it is a nps question with values, not options/);
  assert.ok(msg.includes('"when": "Q1 <= 6"'), msg);
});
