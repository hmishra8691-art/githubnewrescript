import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions } from "./surveyActions.js";
import { validateUxItem, validateUxScript } from "./ux.js";
import { SCRIPT_CHECKED, scriptAuthoringProblems } from "./uxScriptGuard.js";

/**
 * P0 (2026-10-16): Intelligent Mode generated JavaScript that looked right and did nothing.
 *
 * A Hindi request ("Q3 पे जावस्यूप लगाना … एलिजिबल वोटर … नेक्स बटन डिसीबल") was not recognised as a
 * request about the survey's behaviour, so the model never saw the survey's page hooks and wrote
 * generic browser code — SurveyJS / data-variable selectors, a Next button disabled by the script,
 * an init() that re-ran itself every 300 ms looking for an input that does not exist. The gate let
 * it through with one warning and the live survey ran it to no effect. AGE_SCR below is that
 * script, verbatim: the authoring checks must refuse it, say what to use instead, and accept the
 * same intent written against the survey's real hooks.
 */
const AGE_SCR_SCRIPT = `(function(){
  // --- helper: find the Next button ---
  function getNextBtn(){
    return document.querySelector('button[data-role="next"], button.next-button, button[aria-label="Next"], .sv-nav-next button, .sd-navigation__next-btn');
  }

  // --- inject message elements once ---
  function injectMessages(inputEl){
    var wrap = inputEl.parentElement;
    if(document.getElementById('age-eligible-msg')) return;
    var ok = document.createElement('div');
    ok.id = 'age-eligible-msg';
    ok.innerHTML = '&#9989; Yes, you are an eligible voter!';
    var no = document.createElement('div');
    no.id = 'age-ineligible-msg';
    no.innerHTML = '&#10060; You must be 18 or above to participate.';
    wrap.appendChild(ok);
    wrap.appendChild(no);
  }

  // --- main logic ---
  function handleAge(inputEl){
    injectMessages(inputEl);
    var val = parseInt(inputEl.value, 10);
    var okMsg = document.getElementById('age-eligible-msg');
    var noMsg = document.getElementById('age-ineligible-msg');
    var nextBtn = getNextBtn();

    if(!inputEl.value || isNaN(val)){
      okMsg.style.display = 'none';
      noMsg.style.display = 'none';
      if(nextBtn){ nextBtn.disabled = true; nextBtn.style.opacity='0.4'; nextBtn.style.cursor='not-allowed'; }
    } else if(val >= 18){
      okMsg.style.display = 'block';
      noMsg.style.display = 'none';
      if(nextBtn){ nextBtn.disabled = false; nextBtn.style.opacity=''; nextBtn.style.cursor=''; }
    } else {
      okMsg.style.display = 'none';
      noMsg.style.display = 'block';
      if(nextBtn){ nextBtn.disabled = true; nextBtn.style.opacity='0.4'; nextBtn.style.cursor='not-allowed'; }
    }
  }

  // --- attach after page renders ---
  function init(){
    var input = document.querySelector('input[data-variable="AGE_SCR"], input[name="AGE_SCR"], .sd-question[data-name="AGE_SCR"] input');
    if(!input){
      setTimeout(init, 300);
      return;
    }
    // disable Next immediately (field is empty on load)
    var nextBtn = getNextBtn();
    if(nextBtn){ nextBtn.disabled = true; nextBtn.style.opacity='0.4'; nextBtn.style.cursor='not-allowed'; }
    input.addEventListener('input', function(){ handleAge(input); });
    input.addEventListener('change', function(){ handleAge(input); });
  }

  init();
}());
`;

/** the same intent against the real hooks (live messages only — stopping the respondent is validation) */
const HOOKED = `var card = document.querySelector('[data-qid="q3"]');
var input = card.querySelector('input');
var next = document.querySelector('[data-testid="rs-next"]');
var ok = document.createElement('div'); ok.id = 'age-eligible-msg'; ok.textContent = 'Yes, you are an eligible voter!'; ok.style.display = 'none';
var no = document.createElement('div'); no.id = 'age-ineligible-msg'; no.textContent = 'You must be 18 or above to participate.'; no.style.display = 'none';
input.parentElement.appendChild(ok); input.parentElement.appendChild(no);
function update(){
  var raw = input.value; var val = parseInt(raw, 10);
  if (!raw || isNaN(val)) { ok.style.display='none'; no.style.display='none'; }
  else if (val >= 18) { ok.style.display='block'; no.style.display='none'; }
  else { ok.style.display='none'; no.style.display='block'; }
}
input.addEventListener('input', update);
update();
`;

const survey = () => SurveyDefinition.parse({
  meta: { id: "cgp", code: "CGP", title: "Voters", version: "1" },
  questions: [
    { id: "q2", code: "Q2", variableName: "CITIZEN", type: "single_select", text: "Citizen?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    { id: "q3", code: "Q3", variableName: "AGE_SCR", type: "numeric", text: "What is your current age (in years)?", required: true },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q2", "q3"] }, { type: "end", id: "e", status: "complete" }],
});

test("the field script: refused when Intelligent Mode writes it, with each reason and the real hook", () => {
  const r = applySurveyActions(survey(), [{ op: "set_custom_code", target: "Q3", js: AGE_SCR_SCRIPT } as never]);
  assert.equal(r.results[0]!.ok, false, "not accepted");
  const why = r.errors.join(" ");
  assert.match(why, /“input\[data-variable="AGE_SCR"\], input\[name="AGE_SCR"\], \.sd-question\[data-name="AGE_SCR"\] input” matches nothing/);
  assert.match(why, /the answer box of Q3 is \[data-qid="q3"\] input/, "names the question's real answer box");
  assert.match(why, /“button\[data-role="next"\], button\.next-button, button\[aria-label="Next"\], \.sv-nav-next button, \.sd-navigation__next-btn” matches nothing/);
  assert.match(why, /\[data-testid="rs-next"\]/);
  assert.match(why, /cannot disable or hide the Next \/ Back button/);
  assert.match(why, /set_validation/, "says that stopping the respondent is validation");
  assert.match(why, /init\(\) waits for an element by calling itself on a timer/);
  assert.equal(r.def.ux?.behaviors?.length ?? 0, 0, "nothing stored");
});

test("the same intent on the real hooks is accepted, and the card says it was checked, not run", () => {
  const r = applySurveyActions(survey(), [{ op: "set_custom_code", target: "Q3", js: HOOKED } as never]);
  assert.equal(r.results[0]!.ok, true, r.errors.join("; "));
  assert.ok(r.results[0]!.description.includes(SCRIPT_CHECKED), r.results[0]!.description);
  const b = r.def.ux!.behaviors[0]!;
  assert.equal(b.target.questionId, "q3");
  assert.equal(b.script, HOOKED);
  // and the validation that stops a respondent under 18 goes through the normal action
  const v = applySurveyActions(r.def, [{ op: "set_validation", target: "Q3", rules: [{ kind: "integer" }, { kind: "min_value", value: 18, message: "You must be 18 or above to participate." }] } as never]);
  assert.equal(v.results[0]!.ok, true, v.errors.join("; "));
  const created = applySurveyActions(survey(), [{ op: "create_behavior", label: "Q3 eligibility", target: "Q3", script: HOOKED } as never]);
  assert.equal(created.results[0]!.ok, true, created.errors.join("; "));
  assert.ok(created.results[0]!.description.endsWith(SCRIPT_CHECKED));
});

test("a stored script is never stopped by the new checks: the runtime gate and the Studio editor only warn", () => {
  const def = survey();
  assert.deepEqual(validateUxScript(AGE_SCR_SCRIPT, def).errors, [], "the runtime still runs what it ran before");
  const item = { id: "b1", label: "old", target: { kind: "question" as const, questionId: "q3" }, effects: [], script: AGE_SCR_SCRIPT };
  const lenient = validateUxItem(def, "behavior", item);
  assert.deepEqual(lenient.errors, []);
  assert.ok(lenient.warnings.some((w) => /matches nothing/.test(w)) && lenient.warnings.some((w) => /Next \/ Back/.test(w)), "the author is told, the script is kept");
  assert.ok(validateUxItem(def, "behavior", item, { authoring: true }).errors.length >= 4);
});

test("what is NOT refused: a selector list with one real hook, enabling Next, own elements, one-off timers, radios by question id", () => {
  const def = survey();
  const ok = (code: string) => assert.deepEqual(scriptAuthoringProblems(code, def), [], code);
  ok(`var n = document.querySelector('.next-button, [data-testid="rs-next"]'); n.classList.add('ready');`);
  ok(`var next = document.querySelector('[data-testid="rs-next"]'); next.disabled = false; next.style.opacity = '';`);
  ok(`var msg = document.createElement('button'); msg.disabled = true; document.querySelector('[data-qid="q3"]').appendChild(msg);`);
  ok(`rs.after(500, function () { rs.showMessage('Q3', 'Take your time'); });`);
  ok(`function hint() { rs.showMessage('Q3', 'hi'); } setTimeout(hint, 2000);`);
  ok(`for (const r of document.querySelectorAll('input[name="q2"]')) r.parentElement.classList.add('x');`);
  ok(`document.querySelector('[data-qid="q3"] input').addEventListener('input', function (e) { rs.log(e.target.value); });`);
});

test("what IS refused, each on its own", () => {
  const def = survey();
  const one = (code: string, re: RegExp) => { const p = scriptAuthoringProblems(code, def); assert.equal(p.length, 1, `${code}\n${p.join("\n")}`); assert.match(p[0]!, re); };
  one(`document.querySelector('#NextButton').classList.add('x');`, /Qualtrics/);
  one(`document.querySelector('.sd-question input').focus();`, /SurveyJS/);
  one(`document.querySelector('[data-qid="q3"] input').setAttribute('data-x', '1'); document.querySelector('[data-testid="rs-next"]').disabled = true;`, /cannot disable or hide the Next/);
  one(`var nextBtn = document.querySelector('[data-testid="rs-next"]'); nextBtn.setAttribute('disabled', '');`, /cannot disable or hide the Next/);
  one(`function wait() { var el = document.querySelector('[data-qid="q3"] input'); if (!el) { rs.after(200, wait); return; } el.classList.add('x'); } wait();`, /wait\(\) waits for an element/);
  one(`function go() { if (!document.querySelector('[data-qid="q3"]')) return setTimeout(() => go(), 100); } go();`, /go\(\) waits for an element/);
  one(`document.querySelector('input[name="AGE_SCR"]').focus();`, /the answer box of Q3 is \[data-qid="q3"\] input/);
});

/* ---------------------------------------------------------------------------------------------
 * P0-2 (2026-10-16 21:23 / 21:25, production operations log): what the model wrote AFTER the first
 * fix, and why some of it was refused or would not have worked.
 * ------------------------------------------------------------------------------------------- */
import { questionHooks } from "./ux.js";
const popupSurvey = () => SurveyDefinition.parse({
  meta: { id: "cgp", code: "CGP", title: "Voters", version: "1" },
  questions: [
    { id: "q_consent", code: "Q1", variableName: "CONSENT_INFO", type: "single_select", text: "Welcome", options: [{ code: 1, label: "Continue" }] },
    { id: "q_cit", code: "Q2", variableName: "CITIZEN", type: "single_select", text: "Citizen?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    { id: "q_age", code: "Q3", variableName: "AGE_SCR", type: "numeric", text: "Age?" },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q_consent"] }, { type: "page", id: "p2", questionIds: ["q_cit"] }, { type: "page", id: "p3", questionIds: ["q_age"] }, { type: "end", id: "e", status: "complete" }],
});
const OVERLAY = `(function(){
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;display:flex;opacity:0;transition:opacity 0.3s ease;';
  var msg = document.createElement('div'); msg.textContent = 'You are eligible to proceed!';
  overlay.appendChild(msg); document.body.appendChild(overlay);
  rs.after(30, function(){ overlay.style.opacity = '1'; });
  rs.after(2200, function(){ overlay.style.opacity = '0'; rs.after(350, function(){ if (overlay.parentElement) overlay.parentElement.removeChild(overlay); }); });
})();`;
const NOTE = "rs.showMessage('self', 'You are eligible to proceed!');";

test("21:25 — a script with on/options (\"run this when option 1 is selected\") is written the supported way, not refused", () => {
  // the wrapping is what is tested here; the hand-built OVERLAY itself is refused since P3 (popup.test.ts)
  const r = applySurveyActions(popupSurvey(), [
    { op: "create_behavior", label: "Q2 Eligible Popup on Yes", target: "Q2", on: "select_option", options: ["1"], script: NOTE },
    { op: "create_behavior", label: "Q1 Welcome Popup", target: "Q1", on: "appear", script: NOTE.replace("You are eligible to proceed!", "Welcome Americans!") },
  ] as never);
  assert.deepEqual(r.results.map((x) => x.ok), [true, true], r.errors.join("; "));
  const [q2, q1] = r.def.ux!.behaviors;
  assert.equal(q2!.on, undefined); assert.equal(q2!.options, undefined);
  assert.ok(q2!.script!.startsWith(`rs.listen("select", "self", function (e) {\n  if (["1"].indexOf(String(e.option)) < 0) return;\n`), q2!.script);
  assert.ok(q2!.script!.includes("You are eligible to proceed!"));
  assert.equal(q1!.script, NOTE.replace("You are eligible to proceed!", "Welcome Americans!"), "appear: the script runs when the page opens, as written");
  assert.deepEqual(validateUxScript(q2!.script!, r.def).errors, [], "the wrapped script passes the runtime gate");
  // the same on update_behavior
  const u = applySurveyActions(r.def, [{ op: "update_behavior", id: q1!.id, on: "deselect_option", options: ["1"], script: "rs.hideMessage('self');" }] as never);
  assert.equal(u.results[0]!.ok, true, u.errors.join("; "));
  assert.match(u.def.ux!.behaviors[1]!.script!, /^rs\.listen\("deselect", "self"/);
  // options on an event that has none, and an unknown event, are refused with the reason
  assert.match(applySurveyActions(popupSurvey(), [{ op: "create_behavior", label: "x", target: "Q2", on: "hover", options: ["1"], script: NOTE }] as never).errors.join(" "), /options apply to select_option/);
});

test("21:23 — the age popup as a hand-built overlay is refused with the survey's popup as the fix (P3); <style> in document.head and inline keyframes are refused too", () => {
  const no = applySurveyActions(popupSurvey(), [{ op: "create_behavior", label: "Q3 popup", target: "Q3", script: `var box = document.querySelector('[data-qid="q_age"] input');\nfunction show(){ if (parseInt(box.value, 10) >= 18) { ${OVERLAY} } }\nbox.addEventListener('input', show);` }] as never);
  assert.equal(no.results[0]!.ok, false);
  assert.match(no.errors.join(" "), /builds its own popup .*covers the whole screen.*show_popup.*rs\.popup/);
  // the same intent through the survey's popup passes
  const ok = applySurveyActions(popupSurvey(), [{ op: "create_behavior", label: "Q3 popup", target: "Q3", script: `rs.listen("answer", "self", function (e) { if (Number(e.value) >= 18) rs.popup("You are an eligible voter!", { placement: "center" }); else rs.closePopup(); });` }] as never);
  assert.equal(ok.results[0]!.ok, true, ok.errors.join("; "));
  const head = scriptAuthoringProblems(`var s = document.createElement('style'); s.textContent = '@keyframes rsFadeIn{from{opacity:0}to{opacity:1}}'; document.head.appendChild(s); var o = document.createElement('div'); o.style.cssText = 'animation:rsFadeIn 0.35s ease'; document.body.appendChild(o);`, popupSurvey());
  assert.ok(head.some((e) => /cannot add a <style> element/.test(e) && /create_animation/.test(e)), head.join("\n"));
  assert.ok(head.some((e) => /inline animation “rsFadeIn” names keyframes the survey does not have/.test(e)), head.join("\n"));
  assert.deepEqual(scriptAuthoringProblems(`var o = document.createElement('div'); o.style.animation = 'rs-ux-pulse 0.6s'; document.body.appendChild(o);`, popupSurvey()), [], "the survey's own keyframes are fine");
});

test("a selector must name what is in this survey: the id, not the code; an option code that exists", () => {
  const d = popupSurvey();
  const byCode = scriptAuthoringProblems(`document.querySelector('[data-qid="Q3"] input').addEventListener('input', function(){});`, d);
  assert.match(byCode.join(" "), /\[data-qid="Q3"\] names Q3 by its code — a card carries the question's id: \[data-qid="q_age"\]/);
  assert.match(scriptAuthoringProblems(`document.querySelector('[data-qid="AGE_SCR"]').classList.add('x');`, d).join(" "), /by its variable name/);
  assert.match(scriptAuthoringProblems(`document.querySelector('[data-qid="q_cit"] [data-rs-el="option"][data-rs-id="9"]').classList.add('x');`, d).join(" "), /Q2 has no option coded “9” \(options: 1, 2\)/);
  assert.deepEqual(scriptAuthoringProblems(`document.querySelector('[data-qid="q_cit"] [data-rs-el="option"][data-rs-id="1"]').classList.add('x');`, d), []);
});

test("a script with a “when” is refused where it is written (scripts run whenever their page opens) and only warned about in the editor", () => {
  const r = applySurveyActions(popupSurvey(), [{ op: "create_behavior", label: "guarded", target: "Q3", script: "rs.showMessage('self', 'hi');", when: "Q2 = 1" }] as never);
  assert.equal(r.results[0]!.ok, false);
  assert.match(r.errors.join(" "), /a “when” condition does not apply to a script/);
});

test("questionHooks: what a script can name on the page, per question", () => {
  const d = popupSurvey();
  assert.deepEqual(questionHooks(d, d.questions[1]!), [
    'card [data-qid="q_cit"]',
    'option [data-qid="q_cit"] [data-rs-el="option"][data-rs-id="<code>"] (1 Yes, 2 No); in a handler, rs.listen("select", "Q2", (e) => e.option) gives the code',
    "on page 2 of 3 (a script on Q2 starts when that page opens and is undone when it is left)",
  ]);
  assert.match(questionHooks(d, d.questions[2]!).join(" · "), /answer box \[data-qid="q_age"\] input/);
});
