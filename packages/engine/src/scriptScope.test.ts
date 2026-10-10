import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState, runScripts } from "./index.js";

/**
 * SCRIPT SCOPE (consolidation, Phase 7). A page's submit belongs to the page
 * and to every question on it; a change belongs to the question and to its
 * page. `runScripts` therefore takes the SET of ids an event belongs to.
 * Before this, a question-scoped on_validate / on_submit and a page-scoped
 * on_change — all four offered by the editor — silently never ran.
 */
function survey() {
  return SurveyDefinition.parse({
    meta: { id: "s1", code: "S1", title: "Scope", version: "1.0" },
    questions: [
      { id: "q1", code: "Q1", variableName: "A", type: "numeric", text: "A?" },
      { id: "q2", code: "Q2", variableName: "B", type: "numeric", text: "B?" },
    ],
    flow: [{ id: "p1", type: "page", questionIds: ["q1", "q2"] }],
    scripts: [
      { id: "s_q", name: "q1 submit", scope: "question", ref: "q1", event: "on_submit", enabled: true, code: 'setCalc("Q_SUBMIT", 1);' },
      { id: "s_v", name: "q2 validate", scope: "question", ref: "q2", event: "on_validate", enabled: true, code: 'error("q2 is wrong", "q2");' },
      { id: "s_p", name: "page submit", scope: "page", ref: "p1", event: "on_submit", enabled: true, code: 'setCalc("P_SUBMIT", 1);' },
      { id: "s_pc", name: "page change", scope: "page", ref: "p1", event: "on_change", enabled: true, code: 'setCalc("P_CHANGE", 1);' },
      { id: "s_other", name: "other question", scope: "question", ref: "q9", event: "on_submit", enabled: true, code: 'setCalc("OTHER", 1);' },
      { id: "s_s", name: "survey submit", scope: "survey", event: "on_submit", enabled: true, code: 'setCalc("S_SUBMIT", 1);' },
    ],
  });
}

test("a page's submit runs the page's scripts AND its questions' scripts, not another question's", () => {
  const def = survey();
  const state = createResponseState(def, { sessionId: "t", seed: 1 });
  const scope = ["p1", "q1", "q2"];
  const v = runScripts(def, state, "on_validate", { scopeRef: scope });
  assert.deepEqual(v.errors, [{ message: "q2 is wrong", questionRef: "q2" }], "the question-scoped on_validate fires on its page's submit");
  const r = runScripts(def, state, "on_submit", { scopeRef: scope });
  assert.equal(r.ran, 3, `page + q1 + survey, got ${r.ran}`);
  assert.equal(state.calculated.Q_SUBMIT, 1);
  assert.equal(state.calculated.P_SUBMIT, 1);
  assert.equal(state.calculated.S_SUBMIT, 1);
  assert.equal(state.calculated.OTHER, undefined, "a script scoped to a question not on the page stays silent");
});

test("a change on a question runs the page-scoped on_change; a single id still works as before", () => {
  const def = survey();
  const state = createResponseState(def, { sessionId: "t", seed: 1 });
  const r = runScripts(def, state, "on_change", { scopeRef: ["q1", "p1"] });
  assert.equal(r.ran, 1);
  assert.equal(state.calculated.P_CHANGE, 1);
  const state2 = createResponseState(def, { sessionId: "t", seed: 1 });
  const single = runScripts(def, state2, "on_submit", { scopeRef: "p1" });
  assert.equal(single.ran, 2, "a plain string scopeRef: the page's script and the survey-wide one");
  assert.equal(state2.calculated.Q_SUBMIT, undefined);
  const none = runScripts(def, state2, "on_submit", { scopeRef: [] });
  assert.equal(none.ran, 1, "an empty set runs only the survey-wide script");
});
