/**
 * P0 (2026-10-16) — INTELLIGENT MODE'S JAVASCRIPT MUST WORK IN THE REAL SURVEY.
 *
 * The field case, end to end. The researcher asked, in Hindi by voice, for "JavaScript" on the age
 * question (Q3, AGE_SCR): "Yes, you are an eligible voter" from 18 up, Next held until then. The
 * request did not read as one about the survey's behaviour, the model never saw the survey's page
 * hooks, and it wrote generic browser code (AGE_SCR_SCRIPT below, verbatim) that the Studio accepted
 * and the live survey ran to no effect.
 *
 *   STUDIO   the same request, with that script as the model's first answer: the Studio refuses it,
 *            says why (selectors that match nothing, Next disabled by a script, an init() that polls),
 *            the request reaches the UX guide, and the model's correction — validation for the age
 *            limit, a script for the live messages — is proposed, marked "checked, not run yet", applied
 *   RUNTIME  the applied survey in the live runtime: empty / letters → no message, cannot continue;
 *            17 → "must be 18", cannot continue (the survey's own validation message); 18 → "eligible",
 *            continues; typed digit by digit; cleared; Back and forward again → the script starts once,
 *            no duplicate messages; Next is never disabled by the script; no errors, no refusals
 *
 *   node scripts/age-script-p0-test.mjs     (studio :3000 with AI_API_URL=fake:, runtime :3001)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };

const FIELD_REQUEST = "मुझे ख्योशन 3 पे जावस्यूप लगाना अगर एज एटिन के ऊपर मैं टाइप करता हूँ तो यहाँ पर लिख कर रहा है येस आप एलिजिबल वोटर हैं ऐसा उसके बाद मैं नेक्स बटन क्लिक कर पाँ तब तक नेक्स बटन डिसीबल रहा है जब तक मैं एटिन या उसके ऊपर टाइप ना करूं वैल्यू तो";
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
/** the correction a model writes once it has the guide: the age limit is validation, the messages are a script on the real hooks */
const LIVE_MESSAGES = `var box = document.querySelector('[data-qid="q3"] input');
var ok = document.createElement('div'); ok.setAttribute('data-age-msg', 'eligible'); ok.textContent = '✅ Yes, you are an eligible voter!'; ok.hidden = true;
var no = document.createElement('div'); no.setAttribute('data-age-msg', 'ineligible'); no.textContent = '❌ You must be 18 or above to participate.'; no.hidden = true;
box.parentElement.appendChild(ok); box.parentElement.appendChild(no);
function show() { var raw = box.value.trim(); var n = /^[0-9]+$/.test(raw) ? parseInt(raw, 10) : NaN; ok.hidden = !(n >= 18); no.hidden = !(n < 18); }
box.addEventListener('input', show);
show();`;

const SURVEY = {
  meta: { id: "sandbox", code: "CGP", title: "CGP Protest & 2029 Elections", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [
    { id: "q2", code: "Q2", variableName: "CITIZEN", type: "single_select", text: "Are you an Indian citizen currently residing in India?", required: true, options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    { id: "q3", code: "Q3", variableName: "AGE_SCR", type: "numeric", text: "What is your current age (in years)?", required: true },
    { id: "q4", code: "Q4", variableName: "REG", type: "single_select", text: "Are you a registered voter in India?", required: true, options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q2"] }, { type: "page", id: "p2", questionIds: ["q3"] }, { type: "page", id: "p3", questionIds: ["q4"] }, { type: "end", id: "e1", status: "complete" }],
  logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], designs: [], variables: [], embeddedData: [], listFills: [], scripts: [],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
};

const browser = await chromium.launch();

/* ============================================================ STUDIO */
console.log("\nSTUDIO — the field request, the field script, the correction");
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
const goTab = async (name) => { await openTab(page, name); await page.waitForTimeout(150); };
const loadDef = async (def) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(1200);
  await goTab("Questions");
};
const readDef = async () => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  return JSON.parse(await page.$eval("textarea.code", (e) => e.value));
};
await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
await loadDef(SURVEY);
await switchMode(page, "intelligent");
await page.waitForSelector('[data-testid="intelligent-view"]');

let applied;
{
  await page.evaluate((r) => window.__rescriptCopilotFake(r), [
    // what the model answered in the field
    { kind: "proposal", reply: "Q3 (AGE_SCR) पर JavaScript behaviour और Next button disable logic लगाई जा रही है।", actions: [{ op: "set_custom_code", target: "Q3", js: AGE_SCR_SCRIPT }] },
    // the correction, once the refusal (and the guide) came back
    { kind: "proposal", reply: "Q3: 18 से कम उम्र पर survey आगे नहीं बढ़ेगा (validation) और टाइप करते ही message दिखेगा।", actions: [
      { op: "set_validation", target: "Q3", rules: [{ kind: "integer" }, { kind: "min_value", value: 18, message: "You must be 18 or above to participate." }] },
      { op: "create_behavior", label: "Q3 eligibility message", target: "Q3", script: LIVE_MESSAGES },
    ] },
  ]);
  const k = (await page.$$('[data-testid="cp-turn"]')).length;
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/copilot/turn") && r.request().method() === "POST", { timeout: 60000 }),
    (async () => { await page.fill('[data-testid="iq-input"]', FIELD_REQUEST); await page.keyboard.press("Enter"); })(),
  ]);
  const body = await res.json();
  await page.waitForFunction((c) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > c && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, k, { timeout: 40000 });
  assert.equal(body.context?.ux, true, "the Hindi request now reaches the UX guide");
  const refused = (body.context?.repair?.refused ?? []).join(" ");
  assert.match(refused, /matches nothing on a survey page/, refused);
  assert.match(refused, /the answer box of Q3 is \[data-qid="q3"\] input/);
  assert.match(refused, /cannot disable or hide the Next \/ Back button/);
  assert.match(refused, /init\(\) waits for an element by calling itself on a timer/);
  assert.equal(body.context.repair.fixed, true, "the correction was accepted in full");
  ok("the field script is refused before it reaches the survey — each reason named, with the real hook — and goes back to the model once");

  await page.waitForSelector('[data-testid="cp-panel-apply"]');
  assert.equal(await page.$('[data-testid="cp-refused"]'), null, "nothing refused in what is offered");
  const turnText = await page.$eval('[data-testid="cp-turn"]:last-of-type', (e) => e.textContent ?? "").catch(async () => (await page.textContent("body")) ?? "");
  assert.match(turnText + (await page.textContent("body")), /not run yet — try it in Preview/, "the card says the script was checked, not tested");
  ok("the corrected proposal (validation for the age limit + a script for the live messages) is offered, marked “checked, not run yet”");

  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(700);
  applied = await readDef();
  const q3 = applied.questions.find((q) => q.id === "q3");
  assert.ok(q3.validation.some((v) => v.kind === "min_value" && v.value === 18 && /18 or above/.test(v.message ?? "")), JSON.stringify(q3.validation));
  const beh = applied.ux.behaviors.find((b) => b.label === "Q3 eligibility message");
  assert.ok(beh && beh.script === LIVE_MESSAGES && beh.target.questionId === "q3");
  assert.ok(!applied.ux.behaviors.some((b) => /data-variable|sd-question|setTimeout\(init/.test(b.script ?? "")), "the field script was never stored");
  ok("applied: AGE_SCR has min 18 with its message, the script is on Q3 in Styles, animations & scripts, the field script is nowhere");
}
assert.deepEqual(pageErrors, [], pageErrors.join("\n"));

/* ============================================================ RUNTIME */
console.log("\nRUNTIME — the applied survey, in the live runtime");
const rt = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const logs = [], rtErrors = [];
rt.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
rt.on("pageerror", (e) => rtErrors.push(String(e)));
await rt.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await sendPreview(rt, { definition: { ...applied, meta: { ...applied.meta, id: "agep0" } } }, { selector: '[data-qid="q2"]' });
const BOX = '[data-qid="q3"] input';
const msgs = () => rt.evaluate(() => [...document.querySelectorAll("[data-age-msg]")].map((e) => `${e.getAttribute("data-age-msg")}:${e.hidden || getComputedStyle(e).display === "none" ? "hidden" : "shown"}`).sort().join(" "));
const nextDisabled = () => rt.$eval('[data-testid="rs-next"]', (b) => b.disabled || b.hasAttribute("disabled"));
const onAge = () => rt.$(BOX).then(Boolean);
const tryNext = async () => { await rt.click('[data-testid="rs-next"]'); await rt.waitForTimeout(700); };
const settle = () => rt.waitForTimeout(450);

await rt.click('[data-qid="q2"] label:has-text("Yes")');
await tryNext();
await rt.waitForSelector(BOX);
await rt.waitForFunction(() => document.querySelectorAll("[data-age-msg]").length === 2, null, { timeout: 8000 });
assert.equal(await msgs(), "eligible:hidden ineligible:hidden", "empty: neither message");
assert.equal(await nextDisabled(), false, "Next is never disabled by a script");
await tryNext();
assert.ok(await onAge(), "empty: cannot continue");
ok("empty field: no message, Next refuses (the survey's own required check)");

await rt.fill(BOX, "abc"); await settle();
assert.equal(await rt.inputValue(BOX), "", "letters never reach a whole-number box");
assert.equal(await msgs(), "eligible:hidden ineligible:hidden");
await tryNext();
assert.ok(await onAge(), "invalid: cannot continue");
ok("letters: refused at the keystroke, no message, cannot continue");

await rt.fill(BOX, ""); await rt.type(BOX, "1"); await settle();
assert.equal(await msgs(), "eligible:hidden ineligible:shown", "a partial value (1, on the way to 18) reads as under 18");
await rt.type(BOX, "8"); await settle();
assert.equal(await msgs(), "eligible:shown ineligible:hidden", "18, typed digit by digit");
ok("typed digit by digit: 1 → “must be 18”, 18 → “eligible” — the messages follow every keystroke");

await rt.fill(BOX, "17"); await settle();
assert.equal(await msgs(), "eligible:hidden ineligible:shown", "17: under 18");
assert.equal(await nextDisabled(), false);
await tryNext();
assert.ok(await onAge(), "17: cannot continue");
assert.match(await rt.textContent('[data-qid="q3"]'), /You must be 18 or above to participate\./);
ok("17 (boundary − 1): “must be 18” shown, Next refuses with the survey's validation message");

await rt.fill(BOX, ""); await settle();
assert.equal(await msgs(), "eligible:hidden ineligible:hidden", "cleared: neither message");
await rt.fill(BOX, "18"); await settle();
assert.equal(await msgs(), "eligible:shown ineligible:hidden", "18: eligible");
await tryNext();
await rt.waitForSelector('[data-qid="q4"]');
ok("cleared → no message; 18 (the boundary) → “eligible”, and the respondent continues");

await rt.click('[data-testid="rs-back"]');
await rt.waitForSelector(BOX);
await rt.waitForFunction(() => document.querySelectorAll("[data-age-msg]").length >= 2, null, { timeout: 8000 });
await settle();
assert.equal(await rt.$$eval("[data-age-msg]", (e) => e.length), 2, "back on the page: the script started once — no duplicate messages");
assert.equal(await rt.inputValue(BOX), "18");
assert.equal(await msgs(), "eligible:shown ineligible:hidden", "the kept answer shows its message at once");
await rt.fill(BOX, "16"); await settle();
assert.equal(await msgs(), "eligible:hidden ineligible:shown");
await tryNext();
assert.ok(await onAge(), "changed to 16 after coming back: cannot continue");
await rt.fill(BOX, "30"); await settle();
await tryNext();
await rt.waitForSelector('[data-qid="q4"]');
ok("Back and forward again: the script starts once on the page (two messages, not four), follows the kept answer, and the limit still holds");

const bad = logs.filter((l) => /\[rescript:script\]/.test(l));
assert.deepEqual(bad, [], `the script runs without a refusal or a note:\n${bad.join("\n")}`);
assert.deepEqual(rtErrors, [], rtErrors.join("\n"));
ok("no script refusals, notes or page errors in the live runtime");

await browser.close();
console.log(`\n${passed} passed`);
