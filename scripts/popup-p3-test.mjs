/**
 * P3 (2026-10-17) — "WHEN Q3 HAS OPTION 1 SELECTED, DISPLAY A POPUP", END TO END.
 *
 * The user's own example. The model used to hand-build an overlay in a script (a position:fixed div
 * appended to the body, its own timers, nothing that closed it when the answer changed — one landed in
 * the far left corner). Now the survey has a popup of its own (the show_popup effect; rs.popup in a
 * script) and the Studio refuses the hand-built kind.
 *
 *   STUDIO   the request → create_behavior on select_option 1 + show_popup center → described in words,
 *            previewed inside the card's preview (never over the Studio), applied; an anchored hint on
 *            option 2; a script that uses rs.popup, then changed with update_behavior "edits" (one string,
 *            the script not resent); a hand-built overlay script → refused on the card with the reason;
 *            a second behaviour for the same thing → refused with "Update <id>"
 *   RUNTIME  desktop 1280×800: Next without an answer is still refused (validation); option 1 → exactly
 *            one centred modal (role=dialog, aria-modal, focus inside, box centred in the viewport, not at
 *            the left edge); Escape closes it; option 2 chosen while it is open → it closes (the hold is
 *            undone) and the anchored hint opens next to option 2; option 1 again → exactly one, the hint
 *            gone; the close button; Next → Back → shown once again (option 1 kept), no duplicates; the
 *            script's banner follows the edited text, opens from 18 and closes below; the survey completes;
 *            no page errors, no script refusals
 *            phone 390×844: option 1 → one centred modal, about 90vw wide, not at the left edge
 *
 *   node scripts/popup-p3-test.mjs     (studio :3000 with AI_API_URL=fake:, runtime :3001 — the
 *   orchestrator runs it; never start the dev servers from a suite)
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
  meta: { id: "sandbox", code: "P3", title: "Popup P3", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [
    { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?", required: true },
    { id: "q2", code: "Q2", variableName: "CIT", type: "single_select", text: "Are you a citizen?", required: true, options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    { id: "q3", code: "Q3", variableName: "VOTE", type: "single_select", text: "Will you vote in the next election?", required: true, options: [{ code: 1, label: "Definitely" }, { code: 2, label: "Maybe" }, { code: 3, label: "No way" }] },
    { id: "q4", code: "Q4", variableName: "REG", type: "single_select", text: "Are you registered?", required: true, options: [{ code: 1, label: "Registered" }, { code: 2, label: "Not registered" }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "page", id: "p2", questionIds: ["q3"] }, { type: "page", id: "p3", questionIds: ["q4"] }, { type: "end", id: "e1", status: "complete" }],
  logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], designs: [], variables: [], embeddedData: [], listFills: [], scripts: [],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
};
const POPUP_TEXT = "Thanks — your vote matters. A few questions about it follow.";
const HINT_TEXT = "What would make it definite? Tell us on the next page.";
const AGE_SCRIPT = `rs.listen("answer", "self", function (e) {\n  if (Number(e.value) >= 18) rs.popup("You are eligible", { placement: "top" });\n  else rs.closePopup();\n});`;
const OVERLAY_SCRIPT = `var overlay = document.createElement('div');
overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center';
var box = document.createElement('div'); box.textContent = 'You are registered!'; overlay.appendChild(box);
document.body.appendChild(overlay);
rs.after(2000, function () { overlay.remove(); });`;

const browser = await chromium.launch();

/* ============================================================ STUDIO */
console.log("\nSTUDIO — the request through Intelligent Mode (stand-in model)");
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

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
await loadDef(SURVEY);
await switchMode(page, "intelligent");
await page.waitForSelector('[data-testid="intelligent-view"]');

{ // the user's request, answered the way the guide now teaches
  const body = await say("When Q3 has option 1 selected, display a popup", {
    kind: "proposal", reply: "Q3: when “Definitely” (option 1) is selected, a centred popup thanks the respondent; it closes when another option is chosen.",
    actions: [{ op: "create_behavior", label: "Q3 option 1 popup", target: "Q3", on: "select_option", options: ["1"], effects: [{ do: "show_popup", title: "Thank you", text: POPUP_TEXT, placement: "center" }] }],
  });
  assert.equal(body.context.ux, true, "the request reaches the UX guide");
  assert.deepEqual(body.validation.results.map((r) => r.ok), [true], JSON.stringify(body.validation.errors));
  assert.match(body.validation.results[0].description, /when option 1 is selected on Q3 → open a centred popup “Thank you”: “Thanks — your vote matters/);
  assert.match(body.validation.results[0].description, /shown only while that holds, closed when it stops/);
  // the card's preview: the real Q3 with the behaviour — the popup appears inside the preview, never over the Studio
  const pr = '[data-testid="cp-ux-shell"] [data-rs-el="option"]';
  await page.waitForSelector(`${pr}[data-rs-id="1"]`);
  await page.click(`${pr}[data-rs-id="1"]`);
  await page.waitForSelector('[data-testid="cp-ux-shell"] [data-rs-ux-popup]', { timeout: 8000 });
  assert.equal(await page.$$eval("[data-rs-ux-popup]", (els) => els.filter((e) => !e.closest('[data-testid="cp-ux-shell"]')).length), 0, "the popup stays inside the card's preview");
  await page.keyboard.press("Escape");
  await apply();
  ok("the request → create_behavior on select_option 1 + show_popup center, described in words, previewed inside the card (not over the Studio), applied");
}
{ // an anchored hint on option 2
  const body = await say("When Q3 option 2 is selected, show a small hint popup next to that option", {
    kind: "proposal", reply: "Q3 option 2: a hint next to it.",
    actions: [{ op: "create_behavior", label: "Q3 maybe hint", target: "Q3", on: "select_option", options: ["2"], effects: [{ do: "show_popup", text: HINT_TEXT, placement: "anchored", target: "Q3.option:2" }] }],
  });
  assert.deepEqual(body.validation.results.map((r) => r.ok), [true], JSON.stringify(body.validation.errors));
  assert.match(body.validation.results[0].description, /open a popup next to Q3 option “Maybe”/);
  await apply();
  ok("an anchored hint next to Q3 option 2 is applied");
}
{ // a script that genuinely needs code still uses the survey's popup
  const body = await say("On Q1 use JavaScript: show a banner popup 'You are eligible' when the age is 18 or more, and remove it below 18", {
    kind: "proposal", reply: "Q1: a banner from 18, removed below.",
    actions: [{ op: "create_behavior", label: "Q1 eligible banner", target: "Q1", script: AGE_SCRIPT }],
  });
  assert.deepEqual(body.validation.results.map((r) => r.ok), [true], JSON.stringify(body.validation.errors));
  await apply();
  ok("a script with rs.popup / rs.closePopup passes the authoring checks and is applied");
}
{ // a small change without resending the script
  const body = await say("Change the Q1 banner text to 'You are an eligible voter'", {
    kind: "proposal", reply: "Q1: the banner's text changed.",
    // a behaviour is named by its id from the outline, or by its label
    actions: [{ op: "update_behavior", id: "Q1 eligible banner", edits: [{ find: "\"You are eligible\"", replace: "\"You are an eligible voter\"" }] }],
  });
  assert.deepEqual(body.validation.results.map((r) => r.ok), [true], JSON.stringify(body.validation.errors));
  assert.match(body.validation.results[0].description, /1 edit to its script \(“"You are eligible"” → “"You are an eligible voter"”\)/);
  await apply();
  ok("update_behavior “edits” changes one string of the stored script (the script is not resent)");
}
{ // the hand-built overlay is refused on the card with the reason
  const body = await say("Q4 pe registered select karne par javascript se popup dikhao", {
    kind: "proposal", reply: "Q4: overlay popup.", memory: "Q4: popup added.",
    actions: [{ op: "create_behavior", label: "Q4 overlay", target: "Q4", on: "select_option", options: ["1"], script: OVERLAY_SCRIPT }],
  });
  assert.equal(body.validation.results[0].ok, false);
  assert.match(body.validation.errors.join(" "), /builds its own popup .*covers the whole screen.*show_popup.*rs\.popup/);
  await page.waitForSelector('[data-testid="cp-refused"]', { timeout: 15000 });
  assert.match(await page.textContent('[data-testid="cp-refused"]'), /builds its own popup/);
  assert.match(body.reply.memory ?? "", /NOT APPLIED/);
  ok("a hand-built overlay script is refused on the card, with the survey's popup as the fix");
}
{ // one behaviour per thing
  const body = await say("When Q3 option 1 is selected also show a message", {
    kind: "proposal", reply: "Q3 option 1: a message.",
    actions: [{ op: "create_behavior", label: "Q3 option 1 message", target: "Q3", on: "select_option", options: ["1"], effects: [{ do: "show_message", text: "Great." }] }],
  });
  assert.equal(body.validation.results[0].ok, false);
  assert.match(body.validation.errors.join(" "), /there is already a behaviour for this — (uxb_\S+) “Q3 option 1 popup”.*Update \1 instead of adding a second one/);
  ok("a second behaviour for the same target and event is refused with “Update <id>”");
}
const def = await readDef();
assert.deepEqual(def.ux.behaviors.map((b) => b.label).sort(), ["Q1 eligible banner", "Q3 maybe hint", "Q3 option 1 popup"]);
assert.ok(!def.ux.behaviors.some((b) => /position:fixed/.test(b.script ?? "")), "no hand-built overlay was stored");
assert.equal(def.ux.behaviors.find((b) => b.label === "Q1 eligible banner").script, AGE_SCRIPT.replace("\"You are eligible\"", "\"You are an eligible voter\""), "the edit changed exactly one string");
assert.deepEqual(pageErrors, [], pageErrors.join("\n"));
ok("saved: the popup, the hint and the edited script — nothing refused was stored; no Studio errors");

/* ============================================================ RUNTIME — desktop */
console.log("\nRUNTIME — desktop 1280×800");
const live = { ...def, meta: { ...def.meta, id: "popupp3" } };
const open = async (viewport) => {
  const ctx = await browser.newContext({ viewport });
  const rt = await ctx.newPage();
  const logs = [], errors = [];
  rt.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
  rt.on("pageerror", (e) => errors.push(String(e)));
  await rt.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  // every popup the survey opens, counted by its text by the page itself
  await rt.evaluate(() => {
    window.__opened = {};
    new MutationObserver((rs) => { for (const r of rs) for (const n of r.addedNodes) if (n.nodeType === 1 && n.hasAttribute("data-rs-ux-popup")) { const k = n.querySelector(".rs-ux-popup-text")?.textContent ?? ""; window.__opened[k] = (window.__opened[k] ?? 0) + 1; } }).observe(document.body, { childList: true, subtree: true });
  });
  await sendPreview(rt, { definition: live }, { selector: '[data-qid="q1"]' });
  return { rt, logs, errors, ctx };
};
const popups = (rt, text) => rt.$$eval("[data-rs-ux-popup]", (els, t) => els.filter((e) => !t || e.textContent.includes(t)).map((e) => {
  const box = e.querySelector(".rs-ux-popup").getBoundingClientRect();
  const d = e.querySelector('[role="dialog"]');
  // the viewport a fixed element is centred in: without the page's scrollbar
  return { placement: e.getAttribute("data-placement"), modal: d?.getAttribute("aria-modal") === "true", left: box.left, top: box.top, width: box.width, height: box.height, bottom: box.bottom, focusInside: e.contains(document.activeElement), vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight };
}), text ?? "");
const opened = (rt, text) => rt.evaluate((t) => window.__opened[t] ?? 0, text);
const centred = (p, vw, vh) => Math.abs(p.vw - vw) <= 20 && Math.abs(p.left + p.width / 2 - p.vw / 2) <= 4 && Math.abs(p.top + p.height / 2 - p.vh / 2) <= 4;
const AGE_TEXT = "You are an eligible voter";

const { rt, logs, errors } = await open({ width: 1280, height: 800 });
const BOX = '[data-qid="q1"] input';
await rt.fill(BOX, "25");
await rt.waitForFunction((t) => [...document.querySelectorAll("[data-rs-ux-popup]")].some((e) => e.textContent.includes(t)), AGE_TEXT, { timeout: 8000 });
let p = await popups(rt, AGE_TEXT);
assert.equal(p.length, 1); assert.equal(p[0].placement, "top"); assert.equal(p[0].modal, false, "a banner is not modal");
await rt.fill(BOX, "15"); await rt.waitForTimeout(400);
assert.equal((await popups(rt, AGE_TEXT)).length, 0, "below 18 the script closes it");
await rt.fill(BOX, "25"); await rt.waitForTimeout(400);
assert.equal((await popups(rt, AGE_TEXT)).length, 1);
ok("Q1: the script's banner carries the edited text, opens from 18 and closes below (rs.popup / rs.closePopup)");

await rt.click('[data-qid="q2"] label:has-text("Yes")');
await rt.click('[data-testid="rs-next"]');
await rt.waitForSelector('[data-qid="q3"]');
await rt.waitForTimeout(300);
assert.equal((await popups(rt)).length, 0, "leaving the page closes its popups");
await rt.click('[data-testid="rs-next"]'); await rt.waitForTimeout(700);
assert.ok(await rt.$('[data-qid="q3"]'), "Next without an answer is still refused (the survey's validation)");
ok("leaving Q1's page closes its popup; on Q3 the survey's own required check still holds Next");

const VW = 1280, VH = 800;
await rt.click('[data-qid="q3"] label:has-text("Definitely")');
await rt.waitForSelector("[data-rs-ux-popup]");
await rt.waitForTimeout(300);
p = await popups(rt, POPUP_TEXT);
assert.equal(p.length, 1, "exactly one popup");
assert.equal(p[0].placement, "center"); assert.equal(p[0].modal, true, "role=dialog, aria-modal");
assert.ok(centred(p[0], VW, VH), `centred in the viewport: ${JSON.stringify(p[0])}`);
assert.ok(p[0].left > 200 && p[0].width >= 320 && p[0].width <= 470, `well sized, not at the left edge: ${JSON.stringify(p[0])}`);
assert.ok(p[0].focusInside, "focus moved into the dialog");
assert.match(await rt.textContent('[data-rs-ux-popup] .rs-ux-popup-title'), /Thank you/);
await rt.keyboard.press("Tab"); await rt.keyboard.press("Tab");
assert.ok((await popups(rt, POPUP_TEXT))[0].focusInside, "Tab stays inside the modal");
await rt.keyboard.press("Escape");
await rt.waitForTimeout(200);
assert.equal((await popups(rt)).length, 0, "Escape closes it");
assert.equal(await rt.$eval('[data-qid="q3"] [data-rs-el="option"][data-rs-id="1"]', (e) => e.classList.contains("selected") || !!e.querySelector("input:checked")), true, "the answer is kept");
ok("Q3 option 1 → exactly one centred modal (dialog, aria-modal, focus inside, centred at 1280×800); Tab stays in it; Escape closes it; the answer is kept");

await rt.click('[data-qid="q3"] label:has-text("Definitely")'); // re-asserting the same option changes nothing
await rt.waitForTimeout(300);
assert.equal((await popups(rt, POPUP_TEXT)).length, 0, "closed by the respondent: stays closed while the answer is unchanged");
// option 2 while option 1's popup is OPEN: re-open it first by going 1 → 3 → 1
await rt.click('[data-qid="q3"] label:has-text("No way")'); await rt.waitForTimeout(250);
await rt.click('[data-qid="q3"] label:has-text("Definitely")');
await rt.waitForSelector("[data-rs-ux-popup]");
assert.equal(await opened(rt, POPUP_TEXT), 2, "opened twice in all — once per selection of option 1");
// the respondent's own change of answer while it is open (a programmatic click: the modal holds the pointer)
await rt.$eval('[data-qid="q3"] label:has-text("Maybe")', (e) => e.click());
await rt.waitForTimeout(400);
assert.equal((await popups(rt, POPUP_TEXT)).length, 0, "option 2 chosen → the option 1 popup closes (the hold is undone)");
p = await popups(rt, HINT_TEXT);
assert.equal(p.length, 1, "the hint opens");
assert.equal(p[0].placement, "anchored"); assert.equal(p[0].modal, false);
const opt2 = await rt.$eval('[data-qid="q3"] [data-rs-el="option"][data-rs-id="2"]', (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
assert.ok((p[0].top >= opt2.bottom - 2 && p[0].top - opt2.bottom <= 24) || (p[0].bottom <= opt2.top + 2 && opt2.top - p[0].bottom <= 24), `anchored next to option 2: ${JSON.stringify({ p: p[0], opt2 })}`);
assert.ok(p[0].left < opt2.right && p[0].left + p[0].width > opt2.left, "beside it horizontally");
await rt.click('[data-qid="q3"] label:has-text("Definitely")');
await rt.waitForSelector(`[data-rs-ux-popup][data-placement="center"]`);
await rt.waitForTimeout(300);
assert.equal((await popups(rt, POPUP_TEXT)).length, 1, "option 1 again → exactly one");
assert.equal((await popups(rt, HINT_TEXT)).length, 0, "the hint goes with option 2");
await rt.click('[data-testid="rs-ux-popup-close"]');
await rt.waitForTimeout(200);
assert.equal((await popups(rt)).length, 0, "the close button closes it");
ok("option 2 chosen while option 1's popup is open → it closes and the anchored hint opens next to option 2; option 1 again → exactly one, the hint gone; the close button");

await rt.click('[data-testid="rs-next"]');
await rt.waitForSelector('[data-qid="q4"]');
await rt.waitForTimeout(300);
assert.equal((await popups(rt)).length, 0, "no popup on the next page");
const before = await opened(rt, POPUP_TEXT);
await rt.click('[data-testid="rs-back"]');
await rt.waitForSelector('[data-qid="q3"]');
await rt.waitForSelector("[data-rs-ux-popup]");
await rt.waitForTimeout(600);
assert.equal((await popups(rt, POPUP_TEXT)).length, 1, "back with option 1 kept → shown, once");
assert.equal(await opened(rt, POPUP_TEXT), before + 1, "opened once more, not twice");
assert.ok(centred((await popups(rt, POPUP_TEXT))[0], VW, VH));
await rt.keyboard.press("Escape");
await rt.click('[data-testid="rs-next"]');
await rt.waitForSelector('[data-qid="q4"]');
await rt.click('[data-qid="q4"] label:has-text("Not registered")');
await rt.click('[data-testid="rs-next"]');
await rt.waitForFunction(() => /complete|thank/i.test(document.body.innerText) || !!document.querySelector('[data-testid="rs-end"]'), null, { timeout: 10000 });
assert.equal((await popups(rt)).length, 0, "nothing left on the end page");
ok("Next → Back: shown once again with option 1 kept, no duplicates; navigation, validation and completion unaffected");

const bad = logs.filter((l) => (/\[rescript:script\]/.test(l) || /^error:/.test(l)) && !/favicon|Failed to load resource|React DevTools|Fast Refresh/.test(l));
assert.deepEqual(bad, [], bad.join("\n"));
assert.deepEqual(errors, [], errors.join("\n"));
ok("no console errors, script refusals or page errors");

/* ============================================================ RUNTIME — phone */
console.log("\nRUNTIME — phone 390×844");
{
  const m = await open({ width: 390, height: 844 });
  await m.rt.fill('[data-qid="q1"] input', "30");
  await m.rt.click('[data-qid="q2"] label:has-text("Yes")');
  await m.rt.click('[data-testid="rs-next"]');
  await m.rt.waitForSelector('[data-qid="q3"]');
  await m.rt.click('[data-qid="q3"] label:has-text("Definitely")');
  await m.rt.waitForSelector('[data-rs-ux-popup][data-placement="center"]');
  await m.rt.waitForTimeout(300);
  const q = await popups(m.rt, POPUP_TEXT);
  assert.equal(q.length, 1);
  assert.ok(centred(q[0], 390, 844), `centred on the phone: ${JSON.stringify(q[0])}`);
  assert.ok(q[0].left >= 16 && q[0].width >= 330 && q[0].width <= 352, `about 90vw, not at the left edge: ${JSON.stringify(q[0])}`);
  await m.rt.click('[data-testid="rs-ux-popup-close"]');
  await m.rt.click('[data-testid="rs-next"]');
  await m.rt.waitForSelector('[data-qid="q4"]');
  assert.deepEqual(m.errors, [], m.errors.join("\n"));
  ok("phone: option 1 → one centred modal about 90vw wide (not at the left edge); closed; the survey moves on");
}

await browser.close();
console.log(`\n${passed} passed`);
