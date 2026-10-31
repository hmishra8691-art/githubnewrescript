import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, type SurveyAction } from "./surveyActions.js";

/* S2a D16 / IM-22 (2026-10-30): the native settings IM could not reach — coercion dropped them */
const def = (() => {
  const empty = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  const r = applySurveyActions(empty, [
    { op: "create_block", title: "Main" },
    { op: "create_question", ref: "A", type: "single", text: "Pick", options: ["a", "b", "c", "d"] },
    { op: "create_question", ref: "B", type: "constant_sum", text: "Split 100", options: ["w", "x", "y", "z"] },
    { op: "create_question", ref: "C", type: "multi", text: "Which?", options: ["a", "b", "c"] },
  ] as SurveyAction[]);
  assert.ok(r.valid, r.errors.join("; "));
  return r.def;
})();
const run = (raw: unknown[]) => { const c = coerceSurveyActions(raw); assert.deepEqual(c.rejected, []); return applySurveyActions(def, c.actions); };
const q = (d: SurveyDefinition, code: string) => d.questions.find((x) => x.code === code)! as unknown as { variant?: string; settings: Record<string, unknown>; validation: { severity?: string }[]; randomization?: { method?: string } };

test("set_validation carries severity “warning” (a soft check the respondent may continue past); absent = blocking", () => {
  const r = run([{ op: "set_validation", target: "Q2", rules: [{ kind: "condition", check: "Q2.O1 + Q2.O2 + Q2.O3 + Q2.O4 <= 100", message: "Above 100%", severity: "warning" }] }]);
  assert.ok(r.valid, r.errors.join("; "));
  assert.equal(q(r.def, "Q2").validation[0].severity, "warning");
  const hard = run([{ op: "set_validation", target: "Q2", rules: [{ kind: "condition", check: "Q2.O1 <= 100", severity: "fatal" }] }]);
  assert.equal(q(hard.def, "Q2").validation[0].severity, undefined, "only warning is carried");
});

test("set_option_randomization carries method: rotate / reverse_half (balanced, latin square → rotate); an unknown method is refused", () => {
  assert.equal(q(run([{ op: "set_option_randomization", target: "Q1", enabled: true, method: "rotate" }]).def, "Q1").randomization?.method, "rotate");
  assert.equal(q(run([{ op: "set_option_randomization", target: "Q1", enabled: true, method: "balanced" }]).def, "Q1").randomization?.method, "rotate");
  assert.equal(q(run([{ op: "set_option_randomization", target: "Q1", enabled: true, method: "reverse" }]).def, "Q1").randomization?.method, "reverse_half");
  assert.equal(q(run([{ op: "set_option_randomization", target: "Q1", enabled: true }]).def, "Q1").randomization?.method, "shuffle");
  assert.match(String(coerceSurveyActions([{ op: "set_option_randomization", target: "Q1", method: "zigzag" }]).rejected[0]?.reason), /shuffle, rotate or reverse_half/);
});

test("update_question settings: only the keys the variant declares, each checked against the question schema", () => {
  const ok = run([{ op: "update_question", target: "Q1", type: "gamified.timed", settings: { timeLimitSeconds: 30, onTimeout: "advance" } }]);
  assert.ok(ok.valid, ok.errors.join("; "));
  assert.equal(q(ok.def, "Q1").variant, "gamified.timed");
  assert.deepEqual([q(ok.def, "Q1").settings.timeLimitSeconds, q(ok.def, "Q1").settings.onTimeout], [30, "advance"]);
  const badEnum = run([{ op: "update_question", target: "Q1", type: "gamified.timed", settings: { onTimeout: "explode" } }]);
  assert.match(badEnum.results[0].error ?? "", /not a valid onTimeout/);
  const badKey = run([{ op: "update_question", target: "Q1", type: "gamified.timed", settings: { pointsPerAnswer: 3 } }]);
  assert.match(badKey.results[0].error ?? "", /has no setting pointsPerAnswer an action can set — its settings are timeLimitSeconds, onTimeout, /);
  const bounds = run([{ op: "update_question", target: "Q1", type: "gamified.timed", settings: { timeLimitSeconds: 0 } }]);
  assert.match(bounds.results[0].error ?? "", /between 1 and 3600/);
  const plain = run([{ op: "update_question", target: "Q3", settings: { timeLimitSeconds: 30 } }]);
  assert.match(plain.results[0].error ?? "", /has no settings? .*an action can set/);
  // objects and functions never get through coercion
  const c = coerceSurveyActions([{ op: "update_question", target: "Q1", settings: { nested: { a: 1 }, fn: "x".repeat(500) } }]);
  assert.match(String(c.rejected[0]?.reason ?? ""), /changes nothing/);
});
