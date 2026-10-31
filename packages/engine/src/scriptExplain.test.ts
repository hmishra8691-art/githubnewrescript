import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, type SurveyAction } from "./surveyActions.js";
import { interpretRequest, DEFER_TO_GRAMMAR } from "./nlIntent.js";
import { explainScripts, findScripts, sanitizeScriptHealthLite, scriptDossier, scriptQuestion, scriptReadsWrites, SCRIPT_QUESTION_REASON } from "./scriptExplain.js";

/* S2a D10: debug / why / explain a script — the copilot's, with the script in full; the engine's own answer without a model */
const LONG = `rs.listen('answer', 'self', function () {\n${"  // padding so the script is longer than the outline's 600-char excerpt\n".repeat(12)}  if (rs.getAnswer('Q1') == 1) rs.showMessage('self', 'Thanks');\n});`;
const def = (() => {
  const empty = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "x" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });
  const r = applySurveyActions(empty, [
    { op: "create_block", title: "Main" },
    { op: "create_question", ref: "A", type: "single", text: "Own?", options: ["Yes", "No"] },
    { op: "create_question", ref: "B", type: "single", text: "Satisfied?", options: ["a", "b", "c"] },
    { op: "create_behavior", label: "Thank owners", target: "Q2", script: LONG },
  ] as SurveyAction[]);
  assert.ok(r.valid, r.errors.join("; "));
  return { ...r.def, scripts: [{ id: "scr_total", name: "Total", event: "on_submit", scope: "survey", code: "set('TOTAL', (get('Q1') || 0) + 1);", enabled: true }] } as SurveyDefinition;
})();

test("a question about a script is recognised (debug / why / explain + a script word or a script's name); writing one is not", () => {
  for (const s of ["Debug the script on Q2", "Why does the script on Q2 not work", "Explain what the script on Q2 does", "Explain the JavaScript on Q2", "Why doesn't Total run", "The script on Q2 does not work"]) assert.equal(scriptQuestion(def, s), true, s);
  for (const s of ["Write a script that shows a popup on Q2", "Explain Q2", "Why is Q2 not shown", "Add a behaviour to Q2"]) assert.equal(scriptQuestion(def, s), false, s);
});

test("the copilot gets it (not the grammar); the dossier carries the script in full, its check and its field health", () => {
  const i = interpretRequest(def, "Debug the script on Q2");
  assert.equal(i.kind, "model");
  if (i.kind !== "model") return;
  assert.equal(i.reason, SCRIPT_QUESTION_REASON);
  assert.notEqual(i.reason, DEFER_TO_GRAMMAR);
  const refs = findScripts(def, "Debug the script on Q2");
  assert.deepEqual(refs.map((r) => r.label), ["Thank owners"]);
  const bid = refs[0].id;
  const d = scriptDossier(def, refs, sanitizeScriptHealthLite({ sessions: 9, scripts: [{ script: bid, failures: 4, sessions: 3, messages: [{ message: "TypeError: x is null", count: 4 }] }] }));
  assert.ok(LONG.length > 600);
  assert.ok(d.includes(JSON.stringify(LONG)), "the script in full, not an excerpt");
  assert.match(d, /check: passes the script check/);
  assert.match(d, /failed in 3 of 9 sessions \(4 failures\): “TypeError: x is null”/);
  assert.match(d, /reads Q1/);
});

test("without a model: the engine explains a behaviour script and a Scripts-panel script from the code, the check and health", () => {
  const a = explainScripts(def, "Explain what the script on Q2 does");
  assert.match(a.answer, /“Thank owners”/);
  assert.match(a.answer, /listens for the answer to Q2/);
  assert.match(a.answer, /shows a message; reads Q1; writes nothing/);
  assert.match(a.answer, /passes the script check/);
  assert.doesNotMatch(a.answer, /could not find/i);
  const t = explainScripts(def, "Why doesn't Total run");
  assert.match(t.answer, /“Total” \(Scripts panel, the survey\)/);
  assert.match(t.answer, /runs on on_submit/);
  assert.match(t.answer, /writes TOTAL/);
  assert.match(t.answer, /No language model is configured/);
  assert.equal(t.sections.length, 1);
  assert.match(explainScripts(def, "Explain the script on Q1").answer, /No script matches/);
});

test("reads / writes / hooks are read from the code; the page-sent health is bounded", () => {
  const rw = scriptReadsWrites(`var c=document.querySelector('[data-qid="q_7"]'); rs.listen('select','Q3',function(){ rs.setEmbedded("SEEN", 1); rs.popup('x'); }); rs.getAnswer("Q3");`);
  assert.deepEqual(rw.reads, ["Q3"]);
  assert.deepEqual(rw.writes, ["SEEN"]);
  assert.deepEqual(rw.hooks, ["q_7"]);
  assert.deepEqual(rw.events, ["select on Q3"]);
  assert.equal(sanitizeScriptHealthLite("nope"), null);
  const h = sanitizeScriptHealthLite({ sessions: -5, scripts: [{ script: "x".repeat(500), failures: 1e12, sessions: 2, messages: [{ message: "a\u0000b".repeat(200) }, {}, {}, {}] }, { nope: 1 }] })!;
  assert.equal(h.sessions, 0);
  assert.equal(h.scripts.length, 1);
  assert.equal(h.scripts[0].script.length, 120);
  assert.equal(h.scripts[0].failures, 1_000_000);
  assert.equal(h.scripts[0].messages!.length, 3);
  assert.ok(!h.scripts[0].messages![0].message.includes("\u0000"));
});
