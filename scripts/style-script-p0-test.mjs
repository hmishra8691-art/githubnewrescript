/**
 * P0-2 (2026-10-16) — INTELLIGENT MODE AND THE STYLE ANIMATION SCRIPT SYSTEM, END TO END.
 *
 * The model's answers below are the ones the production operations log recorded after the first fix
 * (21:23: an age popup + min-18 validation; 21:25: a welcome popup on Q1 when it appears and an
 * "eligible to proceed" popup when Yes is chosen on Q2 — written as {on, options, script}), plus a
 * scoped CSS style and an animation. Each goes through Intelligent Mode (Studio, stand-in model),
 * is applied, saved, and then runs in the live runtime:
 *
 *   CSS        a style on Q2 colours Q2 only, not Q1 or Q3
 *   JS/event   "on select_option 1 + script" is accepted (wrapped into rs.listen) and fires once per
 *              selection of Yes, never for No
 *   appear     the Q1 welcome popup shows once when the page opens, and once again after Next → Back
 *              (no accumulated handlers)
 *   animation  a pulse on Q2's options plays when one is selected
 *   validation the min-18 validation inferred-look-only used to refuse is applied and stops 17
 *   survey     navigation, validation and answers keep working; the survey completes
 *   honesty    no false "cannot create a <script>" diagnostics; a <style>-in-head script is refused
 *              on the card with the reason; the turn's memory says what was NOT applied
 *
 * P3 (2026-10-17): a hand-built overlay (a position:fixed div on the body) is now REFUSED where it is
 * written, with the survey's own popup as the fix. So the 21:23 field answer is refused on the card and
 * its correction (rs.popup / rs.closePopup) is what gets applied; the 21:25 answers are written the way
 * the guide now teaches (on/options + a script that calls rs.popup) and are still accepted first time.
 * Popups are counted by their text as the survey draws them ([data-rs-ux-popup]).
 *
 *   node scripts/style-script-p0-test.mjs     (studio :3000 with AI_API_URL=fake:, runtime :3001)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };

const SURVEY = {
  meta: { id: "sandbox", code: "CGP", title: "CGP", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [
    { id: "q_consent", code: "Q1", variableName: "CONSENT_INFO", type: "single_select", text: "Welcome to the survey. Continue?", required: true, options: [{ code: 1, label: "Continue" }] },
    { id: "q_cit", code: "Q2", variableName: "CITIZEN", type: "single_select", text: "Are you an Indian citizen?", required: true, options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    { id: "q_age", code: "Q3", variableName: "AGE_SCR", type: "numeric", text: "What is your current age (in years)?", required: true },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q_consent"] }, { type: "page", id: "p2", questionIds: ["q_cit"] }, { type: "page", id: "p3", questionIds: ["q_age"] }, { type: "end", id: "e1", status: "complete" }],
  logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], designs: [], variables: [], embeddedData: [], listFills: [], scripts: [],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
};
const overlay = (id, text) => `(function(){
  var overlay = document.createElement('div');
  overlay.setAttribute('data-pop', '${id}');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.3s ease;';
  var box = document.createElement('div'); box.textContent = '${text}'; box.style.cssText = 'background:#fff;padding:24px;border-radius:14px;';
  overlay.appendChild(box); document.body.appendChild(overlay);
  document.body.setAttribute('data-pop-${id}', String(Number(document.body.getAttribute('data-pop-${id}') || 0) + 1));
  rs.after(30, function(){ overlay.style.opacity = '1'; });
  rs.after(1500, function(){ overlay.style.opacity = '0'; rs.after(350, function(){ if (overlay.parentElement) overlay.parentElement.removeChild(overlay); }); });
})();`;
const AGE_POPUP = `var box = document.querySelector('[data-qid="q_age"] input');
var shownFor = null;
function show() { var n = parseInt(box.value, 10); if (isNaN(n) || n < 18) { shownFor = null; return; } if (shownFor === n) return; shownFor = n; ${overlay("age", "You are an Eligible Voter!")} }
box.addEventListener('input', show);`;
/* the correction, through the survey's own popup: shown from 18, closed below */
const AGE_POPUP_FIXED = `var box = document.querySelector('[data-qid="q_age"] input');
function show() { var n = parseInt(box.value, 10); if (n >= 18) rs.popup('You are an Eligible Voter!', { placement: 'center' }); else rs.closePopup(); }
box.addEventListener('input', show);`;

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
const goTab = async (name) => { await openTab(page, name); await page.waitForTimeout(150); };
const loadDef = async (def) => {
  await goTab("JSON"); await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")'); await page.waitForTimeout(1200);
  await goTab("Questions");
};
const readDef = async () => { await goTab("JSON"); await page.waitForSelector("textarea.code"); const d = JSON.parse(await page.$eval("textarea.code", (e) => e.value)); await goTab("Questions"); return d; };
const say = async (text, fake) => {
  await page.evaluate((r) => window.__rescriptCopilotFake(r), fake);
  const k = (await page.$$('[data-testid="cp-turn"]')).length;
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/copilot/turn") && r.request().method() === "POST", { timeout: 60000 }),
    (async () => { await page.fill('[data-testid="iq-input"]', text); await page.keyboard.press("Enter"); })(),
  ]);
  const body = await res.json();
  await page.waitForFunction((c) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > c && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, k, { timeout: 40000 });
  return body;
};
const apply = async () => { await page.waitForSelector('[data-testid="cp-panel-apply"]'); await page.click('[data-testid="cp-panel-apply"]'); await page.waitForTimeout(700); };

console.log("\nSTUDIO — the model's real answers, through Intelligent Mode");
await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
await loadDef(SURVEY);
await switchMode(page, "intelligent");
await page.waitForSelector('[data-testid="intelligent-view"]');

{ // 21:23 — "javascript … popup when the age is 18+": validation + script; look-only was only inferred
  const body = await say("Q3 pe mujhe javascript lagana hai, agar age ki value 18 ke upar dalta hu to wahan pe automatic popup hokar aana chahiye ki you are eligible voter", [{
    kind: "proposal", reply: "Q3: validation + popup.", memory: "Q3 validation: integer, min_value:18. Q3 behaviour: popup on 18+.",
    actions: [
      { op: "set_validation", target: "Q3", rules: [{ kind: "integer" }, { kind: "min_value", value: 18, message: "You must be 18 years or older to participate in this survey." }] },
      { op: "create_behavior", label: "Q3 age popup", target: "Q3", script: AGE_POPUP },
    ],
  }, { // P3: the hand-built overlay is refused; the correction uses the survey's popup
    kind: "proposal", reply: "Q3: the popup through the survey's own popup.", memory: "Q3 validation: integer, min_value:18. Q3 behaviour: rs.popup on 18+.",
    actions: [{ op: "create_behavior", label: "Q3 age popup", target: "Q3", script: AGE_POPUP_FIXED }],
  }]);
  assert.equal(body.context.uxOnly, true, "look-only was inferred from the words");
  assert.match((body.context.repair?.refused ?? []).join(" "), /builds its own popup .*covers the whole screen.*show_popup/, "P3: the hand-built overlay is refused with the survey's popup as the fix");
  assert.equal(body.context.repair.fixed, true);
  assert.deepEqual(body.validation.results.map((r) => r.ok), [true, true], JSON.stringify(body.validation.errors));
  await apply();
  ok("21:23: the min-18 validation is no longer refused when look-only is only inferred; the hand-built overlay is refused (P3) and its rs.popup correction applied");
}
{ // 21:25 — scripts written with on/options
  const body = await say("मुझे अभी क्यूँ एन को पे लगाना है पॉप अप खुड़ा आए की वैलकुम अमेरीकनस और क्यूँ टू पे या सलेक करूगी तो फिर लिख कर आए you are eligible to proceed जावसक्रिप्ट", {
    kind: "proposal", reply: "Q1 welcome popup; Q2 Yes popup.", memory: "Q1 appear → welcome popup; Q2 option 1 → eligible popup.",
    actions: [
      // as the model writes them with the P3 guide: the event and options as on/options, the popup through rs.popup
      { op: "create_behavior", label: "Q1 Welcome Popup", target: "Q1", on: "appear", script: "rs.popup('Welcome Americans!', { placement: 'top', dismiss: 'auto', autoMs: 1500 });" },
      { op: "create_behavior", label: "Q2 Eligible Popup on Yes", target: "Q2", on: "select_option", options: ["1"], script: "rs.popup('You are eligible to proceed!', { placement: 'top', dismiss: 'auto', autoMs: 1500 });" },
    ],
  });
  assert.deepEqual(body.validation.results.map((r) => r.ok), [true, true], JSON.stringify(body.validation.errors));
  assert.equal(body.context.repair, undefined, "accepted first time: no second (paid) model call");
  assert.ok(body.validation.results.every((r) => /not run yet — try it in Preview/.test(r.description)), "each says checked, not run");
  // the card's preview runs the scripts inside the Studio: a popup must stay in the preview, never cover the Studio
  await page.waitForTimeout(600);
  const outside = await page.$$eval("[data-pop], [data-rs-ux-popup]", (els) => els.filter((e) => !e.closest('[data-testid="cp-ux-shell"]')).length);
  assert.equal(outside, 0, "a script's popup in the Studio preview stays inside the preview");
  await apply();
  ok("21:25: “on select_option 1 + script” and “on appear + script” are accepted first time (no repair call), marked checked-not-run, and their popups stay inside the Studio preview");
}
{ // CSS on one question, and an animation on an event
  const body = await say("Give Q2 a red border and make its options pulse when one is selected", {
    kind: "proposal", reply: "Style + animation on Q2.",
    actions: [
      { op: "create_style", label: "Q2 red border", target: "Q2", css: "& { border: 3px solid rgb(220, 20, 60); }" },
      { op: "create_animation", label: "Q2 pulse on select", target: "Q2.options", preset: "pulse", trigger: "select", duration: 600 },
    ],
  });
  assert.deepEqual(body.validation.results.map((r) => r.ok), [true, true], JSON.stringify(body.validation.errors));
  await apply();
  ok("a scoped CSS style and a select-triggered animation on Q2 are applied");
}
{ // what cannot work is refused on the card, with the reason; the memory records it
  const body = await say("Q1 pe fade-in welcome popup chahiye javascript se", {
    kind: "proposal", reply: "Welcome popup with keyframes.", memory: "Q1: fade-in welcome popup added.",
    actions: [{ op: "create_behavior", label: "Q1 keyframes popup", target: "Q1", script: "var s = document.createElement('style'); s.textContent = '@keyframes rsFadeIn{from{opacity:0}to{opacity:1}}'; document.head.appendChild(s); var o = document.createElement('div'); o.style.cssText = 'animation:rsFadeIn 0.35s ease'; document.body.appendChild(o);" }],
  });
  assert.equal(body.validation.results[0].ok, false);
  assert.match(body.validation.errors.join(" "), /cannot add a <style> element/);
  assert.match(body.reply.memory ?? "", /NOT APPLIED \(refused by the Studio\)/, "the memory does not claim it was done");
  await page.waitForSelector('[data-testid="cp-refused"]', { timeout: 15000 });
  ok("a <style>-in-head script is refused on the card with the reason, and the turn's memory says it was NOT applied");
}
const def = await readDef();
assert.ok(def.questions.find((q) => q.id === "q_age").validation.some((v) => v.kind === "min_value" && v.value === 18));
const q2 = def.ux.behaviors.find((b) => b.label === "Q2 Eligible Popup on Yes");
assert.match(q2.script, /^rs\.listen\("select", "self", function \(e\) \{\n  if \(\["1"\]\.indexOf\(String\(e\.option\)\) < 0\) return;/);
assert.ok(!def.ux.behaviors.some((b) => b.label === "Q1 keyframes popup"));
ok("saved: the validation, the scripts (Q2's wrapped in rs.listen, visible in Styles, animations & scripts), the style and the animation — nothing refused was stored");
assert.deepEqual(pageErrors, [], pageErrors.join("\n"));

/* ============================================================ RUNTIME */
console.log("\nRUNTIME — the saved survey, in the live runtime");
const rt = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const logs = [], rtErrors = [];
rt.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
rt.on("pageerror", (e) => rtErrors.push(String(e)));
await rt.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
// every popup the survey opens, counted by its text by the page itself (a page's own changes are undone when it is left)
await rt.evaluate(() => {
  window.__pops = {};
  new MutationObserver((rs) => { for (const r of rs) for (const n of r.addedNodes) if (n.nodeType === 1 && n.hasAttribute("data-rs-ux-popup")) { const k = n.querySelector(".rs-ux-popup-text")?.textContent ?? ""; window.__pops[k] = (window.__pops[k] ?? 0) + 1; } }).observe(document.body, { childList: true, subtree: true });
});
const WELCOME = "Welcome Americans!", ELIGIBLE = "You are eligible to proceed!", AGE = "You are an Eligible Voter!";
await sendPreview(rt, { definition: { ...def, meta: { ...def.meta, id: "p0style" } } }, { selector: '[data-qid="q_consent"]' });
const count = (id) => rt.evaluate((k) => window.__pops[k] ?? 0, id);
const waitCount = (id, n) => rt.waitForFunction(([k, v]) => (window.__pops[k] ?? 0) >= v, [id, n], { timeout: 8000 });
const visibleText = () => rt.evaluate(() => [...document.querySelectorAll("[data-rs-ux-popup]")].map((e) => e.textContent).join("|"));

await waitCount(WELCOME, 1);
assert.match(await visibleText(), /Welcome Americans!/);
await rt.waitForTimeout(400);
assert.equal(await count(WELCOME), 1, "once on open");
ok("Q1: the welcome popup appears once when the page opens (the survey's own popup, a banner)");

await rt.click('[data-qid="q_consent"] label:has-text("Continue")');
await rt.click('[data-testid="rs-next"]');
await rt.waitForSelector('[data-qid="q_cit"]');
const border = (qid) => rt.$eval(`[data-qid="${qid}"]`, (e) => getComputedStyle(e).borderTopColor);
assert.equal(await border("q_cit"), "rgb(220, 20, 60)", "Q2 has the border");
await rt.click('[data-qid="q_cit"] label:has-text("No")'); await rt.waitForTimeout(500);
assert.equal(await count(ELIGIBLE), 0, "No does not fire the Yes popup");
await rt.click('[data-qid="q_cit"] label:has-text("Yes")');
await waitCount(ELIGIBLE, 1);
await rt.waitForTimeout(500);
assert.equal(await count(ELIGIBLE), 1, "one Yes, one popup");
assert.match(await visibleText(), /You are eligible to proceed!/);
const anim = await rt.$$eval('[data-qid="q_cit"] [data-rs-el="option"]', (els) => els.some((e) => /rs-ux/.test(getComputedStyle(e).animationName) || e.getAnimations().length > 0));
assert.ok(anim, "the pulse played on the selected option");
ok("Q2: the scoped border, Yes → exactly one “eligible” popup (No → none), and the pulse animation on select");

await rt.click('[data-testid="rs-back"]');
await rt.waitForSelector('[data-qid="q_consent"]');
await waitCount(WELCOME, 2);
await rt.waitForTimeout(500);
assert.equal(await count(WELCOME), 2, "back on Q1: shown once more, not twice more");
await rt.click('[data-testid="rs-next"]');
await rt.waitForSelector('[data-qid="q_cit"]');
assert.equal(await border("q_cit"), "rgb(220, 20, 60)");
await rt.waitForTimeout(300);
assert.equal(await count(ELIGIBLE), 1, "coming back to Q2 with Yes kept does not fire the select popup again");
ok("Next → Back → Next: the page's script starts once per visit, no accumulated handlers, the style is still applied");

const prevBorder = await rt.$eval('[data-qid="q_cit"]', (e) => getComputedStyle(e).borderTopColor);
await rt.click('[data-testid="rs-next"]');
await rt.waitForSelector('[data-qid="q_age"] input');
assert.notEqual(await border("q_age"), prevBorder, "Q3 is not affected by Q2's style");
await rt.fill('[data-qid="q_age"] input', "17"); await rt.waitForTimeout(400);
assert.equal(await count(AGE), 0);
await rt.click('[data-testid="rs-next"]'); await rt.waitForTimeout(700);
assert.ok(await rt.$('[data-qid="q_age"] input'), "17: cannot continue");
assert.match(await rt.textContent('[data-qid="q_age"]'), /You must be 18 years or older/);
await rt.fill('[data-qid="q_age"] input', "25");
await waitCount(AGE, 1);
assert.match(await visibleText(), /You are an Eligible Voter!/);
await rt.click('[data-testid="rs-ux-popup-close"]');
assert.equal(await rt.$$eval("[data-rs-ux-popup]", (e) => e.length), 0, "the close button closes it");
ok("Q3: 17 → validation stops Next with its message; 25 → the survey's centred popup, closed with its button; Q2's style does not leak to Q3");

await rt.click('[data-testid="rs-next"]');
await rt.waitForFunction(() => /complete|thank/i.test(document.body.innerText) || !!document.querySelector('[data-testid="rs-end"]'), null, { timeout: 10000 });
ok("the survey completes: navigation, validation and answers were never blocked by the scripts");

const scriptLogs = logs.filter((l) => /\[rescript:script\]/.test(l));
assert.deepEqual(scriptLogs, [], `no script refusals, notes or false “<script>” diagnostics:\n${scriptLogs.join("\n")}`);
assert.deepEqual(rtErrors, [], rtErrors.join("\n"));
ok("no script refusals, false diagnostics or page errors in the runtime");

await browser.close();
console.log(`\n${passed} passed`);
