import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions } from "./surveyActions.js";
import { evaluateUxTriggers, reviewUx, uxBehaviorWords } from "./ux.js";
import { diffScriptItems, scriptItems } from "./scriptAudit.js";
import { proposalCodeItems } from "./scriptVerify.js";
import { createResponseState } from "./state.js";

/* S3b item 1 (MM-07): a behaviour (script or effects) can be switched off — kept, checked, not run */

const def = (behaviors: unknown[]) => SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "T" },
  questions: [{ id: "q1", code: "Q1", variableName: "A", type: "single_select", text: "A?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] }],
  flow: [{ type: "page", id: "p1", questionIds: ["q1"] }, { type: "end", id: "e", status: "complete" }],
  ux: { styles: [], animations: [], behaviors },
});
const pulse = (extra: Record<string, unknown> = {}) => ({ id: "b1", label: "Pulse", target: { kind: "question", questionId: "q1" }, on: "answer", effects: [{ do: "animate", preset: "pulse" }], ...extra });
const script = (extra: Record<string, unknown> = {}) => ({ id: "b2", label: "Hi", target: { kind: "question", questionId: "q1" }, effects: [], script: 'rs.listen("select", "self", () => rs.addClass("self", "hl"));', ...extra });
let n = 0;
const ids = (p: string) => `${p}_${++n}`;
const run = (d: SurveyDefinition, actions: unknown[]) => { const c = coerceSurveyActions(actions); assert.deepEqual(c.rejected, [], JSON.stringify(c.rejected)); return applySurveyActions(d, c.actions, { ids, now: "2026-10-31T00:00:00Z" }); };

test("absent = on (old surveys parse unchanged); false is kept", () => {
  assert.equal(def([pulse()]).ux!.behaviors[0]!.enabled, undefined);
  assert.equal(def([pulse({ enabled: false })]).ux!.behaviors[0]!.enabled, false);
});

test("the trigger evaluator does not fire a switched-off behaviour", () => {
  const input = (d: SurveyDefinition) => ({ def: d, prev: { q1: undefined }, now: { q1: 1 }, shown: ["q1"], blockId: undefined, active: new Set<string>(), fired: new Set<string>(), state: createResponseState(d, { seed: 1, sessionId: "t" }) });
  assert.equal(evaluateUxTriggers(input(def([pulse()]))).fire.length, 1);
  assert.equal(evaluateUxTriggers(input(def([pulse({ enabled: false })]))).fire.length, 0);
});

test("the audit log sees switch off / on as script.disabled / script.enabled", () => {
  const on = def([script()]), off = def([script({ enabled: false })]);
  assert.equal(scriptItems(off)[0]!.enabled, false);
  assert.deepEqual(diffScriptItems(on, off).map((c) => c.action), ["script.disabled"]);
  assert.deepEqual(diffScriptItems(off, on).map((c) => c.action), ["script.enabled"]);
});

test("IM: update_behavior enabled false / true, said in the description; the outline words say DISABLED", () => {
  const d = def([script()]);
  const r = run(d, [{ op: "update_behavior", id: "b2", enabled: false }]);
  assert.equal(r.def.ux!.behaviors[0]!.enabled, false);
  assert.match(JSON.stringify(r.results), /switched off/);
  assert.match(uxBehaviorWords(r.def, r.def.ux!.behaviors[0]!), /DISABLED/);
  const back = run(r.def, [{ op: "update_behavior", id: "b2", enabled: true }]);
  assert.equal(back.def.ux!.behaviors[0]!.enabled, undefined, "on = the key goes");
  assert.match(JSON.stringify(back.results), /switched on/);
});

test("a switched-off twin is nobody's duplicate; switching it on while its twin runs is refused", () => {
  const d = def([pulse(), pulse({ id: "b9", label: "Pulse (copy)", enabled: false })]);
  // adding a behaviour like b1 while b1 runs is refused; the disabled copy does not count
  const c = coerceSurveyActions([{ op: "update_behavior", id: "b9", enabled: true }]);
  const r = applySurveyActions(d, c.actions, { ids });
  assert.equal(r.def.ux!.behaviors[1]!.enabled, false, "not switched on");
  assert.match(JSON.stringify(r), /already a behaviour for this|repeats a behaviour/);
});

test("the review: a switched-off item's errors are warnings; the test session skips it", () => {
  const bad = script({ script: "fetch('https://x.example');" });
  assert.ok(reviewUx(def([bad])).some((f) => f.level === "critical"));
  const off = reviewUx(def([{ ...bad, enabled: false }]));
  assert.ok(!off.some((f) => f.level === "critical"));
  assert.ok(off.some((f) => /switched off/.test(f.message)));
  assert.equal(proposalCodeItems(def([]), def([script({ enabled: false })])).length, 0);
  assert.equal(proposalCodeItems(def([]), def([script()])).length, 1);
});
