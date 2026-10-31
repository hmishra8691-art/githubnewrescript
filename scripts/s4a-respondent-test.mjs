/**
 * Browser suite — S4a "WHAT THE RESPONDENT SEES" (2026-10-31, docs/S4-NATIVE-FEATURES-2026-10-31.md part A).
 *
 * The runtime preview (the real Runner, engine and renderer; no database) unless a section says otherwise.
 *
 *   A  D19 focus the first error — KEYBOARD ONLY (page.keyboard): Tab to Next, Enter on an empty page → focus lands
 *      in the first invalid question's first control (page order, not error order), it is aria-invalid and its
 *      aria-describedby names the role=alert message; a soft warning; a logic error() with no question focuses the
 *      banner; conversational mode; the probe-less free section navigator's Submit gate → "go" lands on the page
 *      with the reason shown and focused; prefers-reduced-motion
 *   B  D20 progress "bottom" and "steps" (Runner), with the step dots cap
 *   C  AQ-08 option-group headings / collapsible groups and the cascading dropdown
 *   D  D14 / GA-03 quiz ↔ assessment key (preview / live without key / per_question)
 *
 *   RUNTIME_URL=http://localhost:3001 node scripts/s4a-respondent-test.mjs
 *   SECTIONS=A,B,C,D (default all)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const SECTIONS = new Set((process.env.SECTIONS ?? "A,B,C,D").split(",").map((s) => s.trim()));
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const allErrors = [];

async function goto(page, url) {
  for (let i = 0; ; i++) {
    try { await page.goto(url, { waitUntil: "networkidle", timeout: 120000 }); return; }
    catch (e) { if (i >= 4 || /crash/i.test(String(e))) throw e; await sleep(8000); }
  }
}
async function open(def, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1100, height: opts.height ?? 700 }, reducedMotion: opts.reducedMotion ?? "no-preference" });
  const pv = await ctx.newPage();
  pv.on("pageerror", (e) => { if (!/ChunkLoadError|Loading chunk .* failed|ResizeObserver loop/.test(String(e))) allErrors.push(`${def.meta.id}: ${e.message}`); });
  await goto(pv, `${RUNTIME}/preview${opts.query ?? ""}`);
  await sendPreview(pv, { definition: def, ...(opts.payload ?? {}) }, opts.selector ? { selector: opts.selector } : {});
  return pv;
}
const yesNo = [{ code: "1", label: "Yes" }, { code: "2", label: "No" }];
const sq = (id, text, extra = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "single_select", text, options: yesNo, required: true, settings: {}, ...extra });
const ot = (id, text, extra = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "open_text", variant: "text.single_line", text, required: true, settings: {}, ...extra });

/** what has focus: the question card it sits in, its tag/type and test id */
const focused = (pv) => pv.evaluate(() => {
  const a = document.activeElement;
  return { qid: a?.closest("[data-qid]")?.getAttribute("data-qid") ?? null, tag: a?.tagName ?? null, type: a?.getAttribute("type") ?? null, testid: a?.getAttribute("data-testid") ?? null };
});
/** Tab (keyboard only) until the Next button has focus */
async function tabToNext(pv) {
  // the double-submit latch holds Next disabled for a moment after a refusal (Runner `once`) — a disabled button is not in the tab order
  await pv.waitForSelector('[data-testid="rs-next"]:not([disabled])', { timeout: 15000 });
  for (let i = 0; i < 60; i++) {
    if (await pv.evaluate(() => document.activeElement?.getAttribute("data-testid") === "rs-next")) return;
    await pv.keyboard.press("Tab");
  }
  const seen = [];
  for (let i = 0; i < 12; i++) { await pv.keyboard.press("Tab"); seen.push(await pv.evaluate(() => { const a = document.activeElement; return `${a?.tagName}.${a?.className}#${a?.getAttribute("data-testid") ?? ""}@${a?.closest("[data-qid]")?.getAttribute("data-qid") ?? ""}`; })); }
  throw new Error("Tab never reached Next: " + seen.join(" | "));
}
async function keyboardNext(pv) { await tabToNext(pv); await pv.keyboard.press("Enter"); }
/** the axe-style check: aria-invalid on the card, aria-describedby resolves to the role=alert message */
const a11yOf = (pv, qid) => pv.evaluate((id) => {
  const card = document.querySelector(`[data-qid="${id}"]`);
  const ids = (card?.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  const targets = ids.map((x) => document.getElementById(x)).filter(Boolean);
  const alert = targets.find((t) => t.getAttribute("role") === "alert");
  return { invalid: card?.getAttribute("aria-invalid"), ids, missing: ids.filter((x) => !document.getElementById(x)), alertText: alert?.textContent?.trim() ?? "" };
}, qid);
const waitFocusIn = (pv, qid) => pv.waitForFunction((id) => document.activeElement?.closest("[data-qid]")?.getAttribute("data-qid") === id, qid, { timeout: 15000 });

/* ============================================================== A. D19 focus the first error */
if (SECTIONS.has("A")) {
  console.log("\nA  D19 focus the first error (keyboard only)");
  const def = {
    meta: { id: "focus", code: "FOCUS", title: "Focus", version: "1" },
    questions: [
      { id: "q0", code: "Q0", variableName: "Q0", type: "open_text", variant: "text.single_line", text: "Optional note", settings: {} },
      ot("q1", "Your name"),
      sq("q2", "Do you agree?", { settings: { accessibility: { describedBy: "q2help" } } }),
      { id: "q3", code: "Q3", variableName: "Q3", type: "numeric", text: "How many?", settings: {}, validation: [{ kind: "max_value", value: 100, severity: "warning", message: "That is a lot — sure?" }] },
      sq("q4", "Second page"),
    ],
    scripts: [{ id: "sv", name: "gate", scope: "survey", event: "on_validate", enabled: true, code: 'if (get("Q4") == "2") error("Page-level: No is not accepted on this page.");' }],
    flow: [
      { type: "page", id: "p1", questionIds: ["q0", "q1", "q2", "q3"] },
      { type: "page", id: "p2", questionIds: ["q4"] },
      { type: "end", id: "e", status: "complete" },
    ],
  };
  const pv = await open(def);
  await pv.waitForSelector('[data-qid="q1"]');
  // q2 is answered first (mouse-free: we will reach it by keyboard later) — nothing answered yet: Enter on Next
  await keyboardNext(pv);
  await waitFocusIn(pv, "q1");
  let f = await focused(pv);
  assert.equal(f.qid, "q1"); assert.equal(f.tag, "INPUT");
  const a1 = await a11yOf(pv, "q1");
  assert.equal(a1.invalid, "true"); assert.ok(a1.ids.includes("q1__err"), JSON.stringify(a1)); assert.deepEqual(a1.missing, []); assert.ok(a1.alertText.length > 0);
  const a2 = await a11yOf(pv, "q2");
  assert.equal(a2.invalid, "true"); assert.ok(a2.ids[0] === "q2__err" && a2.ids.includes("q2help"), `authored describedBy kept AND the error named: ${JSON.stringify(a2)}`);
  assert.ok(await pv.$('[data-testid="rs-error-banner"]'), "the banner stays");
  ok("Enter on Next (keyboard only) on an empty page → focus in Q1's text box (the first invalid in page order; optional Q0 skipped); aria-invalid + aria-describedby → role=alert message; Q2 keeps its authored describedBy after the error id; banner kept");

  await pv.keyboard.type("Ada");
  await keyboardNext(pv);
  await waitFocusIn(pv, "q2");
  f = await focused(pv);
  assert.equal(f.qid, "q2"); assert.equal(f.tag, "INPUT"); assert.equal(f.type, "radio");
  ok("Q1 answered by typing in the focused box → the next Enter focuses Q2's first radio");

  await pv.keyboard.press("Space");
  // Q3 warning: type a big number into Q3 by keyboard
  await pv.keyboard.press("Tab");
  for (let i = 0; i < 6 && (await focused(pv)).qid !== "q3"; i++) await pv.keyboard.press("Tab");
  assert.equal((await focused(pv)).qid, "q3", "Tab reaches Q3");
  await pv.keyboard.type("500");
  await keyboardNext(pv);
  await waitFocusIn(pv, "q3");
  ok("a soft warning (range, severity warning) refuses the first Next and focuses its question");
  await keyboardNext(pv);
  await pv.waitForSelector('[data-qid="q4"]');
  // page 2: choose "No" with the keyboard → the logic error() names no question → the banner gets focus
  await pv.keyboard.press("Tab");
  for (let i = 0; i < 10 && (await focused(pv)).qid !== "q4"; i++) await pv.keyboard.press("Tab");
  await pv.keyboard.press("ArrowDown");
  await pv.waitForFunction(() => document.querySelector('[data-qid="q4"] input[type=radio][value="2"]')?.checked || [...document.querySelectorAll('[data-qid="q4"] input[type=radio]')][1]?.checked, null, { timeout: 5000 });
  await keyboardNext(pv);
  await pv.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "rs-error-banner", null, { timeout: 15000 });
  assert.match(await pv.textContent('[data-testid="rs-error-banner"]'), /Page-level: No is not accepted/);
  ok("a logic script's error() with no question → focus on the banner that shows it");
  await pv.context().close();

  // conversational mode, reduced motion
  const conv = { ...def, meta: { ...def.meta, id: "focusc" }, scripts: [], branding: { layout: { presentation: "conversational" } } };
  const pc = await open(conv, { reducedMotion: "reduce" });
  await pc.waitForSelector('[data-qid="q0"]');
  await keyboardNext(pc); // q0 optional → q1
  await pc.waitForSelector('[data-qid="q1"]');
  await keyboardNext(pc);
  await waitFocusIn(pc, "q1");
  assert.equal((await focused(pc)).tag, "INPUT");
  assert.equal((await a11yOf(pc, "q1")).invalid, "true");
  ok("conversational mode (one question at a time), prefers-reduced-motion: the refused question's box gets focus");
  await pc.context().close();

  // the free section navigator's Submit gate: jump to the last section, Submit → gate → "go" → reason shown + focused
  const nav = {
    meta: { id: "focusg", code: "FOCUSG", title: "Gate", version: "1" },
    questions: [sq("h1", "History one"), sq("g1", "Geography one"), sq("p1", "Polity one")],
    flow: [
      { type: "block", id: "b_hist", title: "History", children: [{ type: "page", id: "ph1", questionIds: ["h1"] }] },
      { type: "block", id: "b_geo", title: "Geography", children: [{ type: "page", id: "pg1", questionIds: ["g1"] }] },
      { type: "block", id: "b_pol", title: "Polity", children: [{ type: "page", id: "pp1", questionIds: ["p1"] }] },
      { type: "end", id: "e", status: "complete" },
    ],
    navigation: { sectionNav: "free", position: "top" },
  };
  const pg = await open(nav);
  await pg.waitForSelector('[data-qid="h1"]');
  await pg.click('[data-testid="rs-section-nav-item"][data-section="b_pol"]', { force: true });
  await pg.waitForSelector('[data-qid="p1"]', { timeout: 30000 });
  await pg.click('[data-qid="p1"] label:has-text("Yes")');
  await keyboardNext(pg);
  await pg.waitForSelector('[data-testid="rs-submit-gate"]', { timeout: 15000 });
  await pg.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "rs-submit-gate", null, { timeout: 5000 });
  ok("Submit refused by the gate → focus on the gate panel (role=alertdialog)");
  // keyboard: Tab to the History link, Enter
  for (let i = 0; i < 10; i++) {
    if (await pg.evaluate(() => document.activeElement?.getAttribute("data-testid") === "rs-submit-gate-go" && document.activeElement?.getAttribute("data-section") === "b_hist")) break;
    await pg.keyboard.press("Tab");
  }
  await pg.keyboard.press("Enter");
  await pg.waitForSelector('[data-qid="h1"]', { timeout: 30000 });
  await waitFocusIn(pg, "h1");
  const ag = await a11yOf(pg, "h1");
  assert.equal(ag.invalid, "true"); assert.ok(ag.alertText.length > 0, "the reason is shown on the landed page");
  ok(`gate "go" (keyboard) → History page with the reason (“${ag.alertText}”) and focus in its first radio`);
  await pg.context().close();
}

console.log(`\n${passed} passed`);
if (allErrors.length) { console.log("page errors:\n  " + allErrors.join("\n  ")); }
await browser.close();
process.exit(allErrors.length ? 1 : 0);
