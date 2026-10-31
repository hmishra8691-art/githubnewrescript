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
 *   E  the Studio (needs :3000): Branding preview draws bottom / steps; Option groups "Respondents see"; the cascading
 *      dropdown editor; the quiz tick writes question.assessment
 *
 *   RUNTIME_URL=http://localhost:3001 node scripts/s4a-respondent-test.mjs
 *   SECTIONS=A,B,C,D (default all)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const SECTIONS = new Set((process.env.SECTIONS ?? "A,B,C,D,E").split(",").map((s) => s.trim()));
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

/* ============================================================== B. D20 progress bottom / steps */
if (SECTIONS.has("B")) {
  console.log("\nB  D20 progress indicator: bottom and steps");
  const pages = (n) => Array.from({ length: n }, (_, i) => ({ type: "page", id: `pp${i + 1}`, questionIds: [`s${i + 1}`] }));
  const paper = (id, n, layout) => ({
    meta: { id, code: id.toUpperCase(), title: "Progress", version: "1" },
    questions: Array.from({ length: n }, (_, i) => ({ ...sq(`s${i + 1}`, `Question ${i + 1}`), required: false })),
    flow: [...pages(n), { type: "end", id: "e", status: "complete" }],
    branding: { layout },
  });
  const prog = (pv) => pv.evaluate(() => {
    const el = document.querySelector('[data-testid="rs-progress"]');
    if (!el) return null;
    const after = (sel) => { const o = document.querySelector(sel); return o ? !!(o.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) : null; };
    return {
      position: el.getAttribute("data-position"), style: el.getAttribute("data-style"), role: el.getAttribute("role"),
      now: el.getAttribute("aria-valuenow"), max: el.getAttribute("aria-valuemax"), text: el.getAttribute("aria-valuetext"),
      label: el.querySelector('[data-testid="rs-progress-label"]')?.textContent ?? null,
      dots: el.querySelectorAll(".rs-progress-dot").length, current: el.querySelectorAll(".rs-progress-dot.current").length,
      afterNav: after(".rs-nav"), afterQuestions: after("#rs-questions"),
    };
  });
  const p1 = await open(paper("progb", 3, { progressBar: "bottom", progressStyle: "steps" }));
  let g = await prog(p1);
  assert.equal(g.position, "bottom"); assert.equal(g.style, "steps"); assert.equal(g.role, "progressbar");
  assert.equal(g.label, "Page 1 of 3"); assert.equal(g.now, "1"); assert.equal(g.max, "3"); assert.equal(g.text, "Page 1 of 3");
  assert.equal(g.dots, 3); assert.equal(g.current, 1);
  assert.equal(g.afterNav, true, "drawn after the page body and its buttons"); assert.equal(g.afterQuestions, true);
  await p1.click('[data-testid="rs-next"]'); await p1.waitForSelector('[data-qid="s2"]');
  g = await prog(p1);
  assert.equal(g.label, "Page 2 of 3"); assert.equal(g.now, "2");
  ok("bottom + steps: after the questions and Next; role=progressbar 1..3, “Page 1 of 3” with 3 dots (1 current) → Next → “Page 2 of 3”");
  await p1.context().close();

  const p2 = await open(paper("progt", 14, { progressBar: "top", progressStyle: "steps" }));
  g = await prog(p2);
  assert.equal(g.position, "top"); assert.equal(g.afterQuestions, false, "top: before the questions");
  assert.equal(g.label, "Page 1 of 14"); assert.equal(g.dots, 0, "past 12 pages: the text alone");
  ok("top + steps on a 14-page paper: before the questions, “Page 1 of 14”, no dots (cap 12)");
  await p2.context().close();

  const p3 = await open(paper("progp", 3, { progressBar: "bottom", progressStyle: "percent" }));
  g = await prog(p3);
  assert.equal(g.position, "bottom"); assert.equal(g.style, "percent"); assert.equal(g.label, "25%"); assert.equal(g.now, "25"); assert.equal(g.afterNav, true);
  ok("bottom + percent: “25%” (page 1 of 3, the end screen is the +1), aria-valuenow 25, after Next");
  await p3.context().close();

  const p4 = await open(paper("progn", 3, { progressBar: "none", progressStyle: "steps" }));
  assert.equal(await prog(p4), null);
  ok("none: no indicator");
  await p4.context().close();
}

/* ============================================================== C. AQ-08 option groups + cascading dropdown */
if (SECTIONS.has("C")) {
  console.log("\nC  AQ-08 visible option groups and the cascading dropdown");
  const opts = ["Apple", "Pear", "Plum", "Carrot", "Leek"].map((label, i) => ({ code: i + 1, label }));
  const groups = (scope = "options") => [
    { id: "g_fruit", name: "Fruit", label: "Fruit", display: "heading", scope, members: scope === "rows" ? ["r1", "r2"] : [1, 2, 3] },
    { id: "g_veg", name: "Veg", label: "Vegetables", display: "collapsible", scope, members: scope === "rows" ? ["r3", "r4"] : [4, 5] },
  ];
  const def = {
    meta: { id: "groups", code: "GROUPS", title: "Groups", version: "1" },
    questions: [
      { id: "qs", code: "QS", variableName: "QS", type: "single_select", text: "Pick one", options: opts, optionGroups: groups(), required: false, settings: {} },
      { id: "qm", code: "QM", variableName: "QM", type: "multi_select", text: "Pick any", options: opts, optionGroups: groups(), required: false, settings: {} },
      { id: "qd", code: "QD", variableName: "QD", type: "dropdown", text: "Pick from the list", options: opts, optionGroups: groups(), required: false, settings: {} },
      { id: "qx", code: "QX", variableName: "QX", type: "matrix_single", text: "Rate each", options: [{ code: 1, label: "Bad" }, { code: 2, label: "Good" }],
        rows: ["r1", "r2", "r3", "r4"].map((code, i) => ({ code, label: ["Apple", "Pear", "Carrot", "Leek"][i], flags: [], validation: [], required: false })), optionGroups: groups("rows"), required: false, settings: {} },
      { id: "qc", code: "QC", variableName: "QC", type: "dropdown", variant: "single_select.cascading_dropdown", text: "Where do you live?", required: true,
        settings: { cascadeParents: [{ code: "IN", label: "India" }, { code: "US", label: "United States" }], cascadeParentLabel: "Country", cascadeChildLabel: "State" },
        options: [{ code: 1, label: "Maharashtra", meta: { parent: "IN" } }, { code: 2, label: "Kerala", meta: { parent: "IN" } }, { code: 3, label: "Texas", meta: { parent: "US" } }] },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["qs", "qm", "qd", "qx"] }, { type: "page", id: "p2", questionIds: ["qc"] }, { type: "end", id: "e", status: "complete" }],
  };
  const pv = await open(def, { height: 1400 });
  const groupInfo = (qid) => pv.$$eval(`[data-qid="${qid}"] [data-testid="rs-optgroup"]`, (els) => els.map((e) => ({
    group: e.getAttribute("data-group"), display: e.getAttribute("data-display"), open: e.getAttribute("data-open"),
    heading: (e.querySelector(".rs-optgroup-heading, .rs-optgroup-toggle")?.textContent ?? e.getAttribute("label") ?? "").trim(),
    labelledby: e.getAttribute("aria-labelledby"), role: e.getAttribute("role"),
    values: [...e.querySelectorAll("input, option")].map((i) => i.value),
  })));
  let g = await groupInfo("qs");
  assert.equal(g.length, 2);
  assert.equal(g[0].heading, "Fruit"); assert.equal(g[0].role, "group"); assert.deepEqual(g[0].values, ["1", "2", "3"]);
  assert.ok(await pv.$(`[id="${g[0].labelledby}"]`), "the group is named by its heading");
  assert.equal(g[1].display, "collapsible"); assert.equal(g[1].open, "0"); assert.deepEqual(g[1].values, [], "collapsed: members not drawn");
  const toggle = '[data-qid="qs"] [data-testid="rs-optgroup-toggle"]';
  assert.equal(await pv.getAttribute(toggle, "aria-expanded"), "false");
  // keyboard: focus the disclosure button and press Enter
  await pv.focus(toggle); await pv.keyboard.press("Enter");
  await pv.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-expanded") === "true", toggle);
  g = await groupInfo("qs");
  assert.deepEqual(g[1].values, ["4", "5"]);
  await pv.keyboard.press("Tab"); await pv.keyboard.press("Space");
  assert.equal(await pv.$eval('[data-qid="qs"] input[value="4"]', (e) => e.checked), true, "Tab into the opened group, Space selects Carrot");
  await pv.focus(toggle); await pv.keyboard.press("Space");
  await pv.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-expanded") === "false", toggle);
  ok("single choice: “Fruit” heading (role=group named by it, members 1–3); “Vegetables” collapsible — closed, Enter opens (aria-expanded), Tab+Space selects inside, Space closes");
  g = await groupInfo("qm");
  assert.deepEqual(g.map((x) => [x.heading.replace(/\s*\(\d+\)$/, "").replace(/^[▸▾]\s*/, ""), x.display]), [["Fruit", "heading"], ["Vegetables", "collapsible"]]);
  ok("multiple choice: the same groups");
  const og = await pv.$$eval('[data-qid="qd"] select optgroup', (els) => els.map((e) => [e.getAttribute("label"), [...e.querySelectorAll("option")].map((o) => o.value)]));
  assert.deepEqual(og, [["Fruit", ["1", "2", "3"]], ["Vegetables", ["4", "5"]]]);
  ok("dropdown: <optgroup label=Fruit> 1–3, <optgroup label=Vegetables> 4–5 (a native select cannot collapse)");
  const rows = () => pv.$$eval('[data-qid="qx"] tbody tr', (trs) => trs.map((t) => t.classList.contains("rs-matrix-group") ? `#${t.textContent.trim().replace(/^[▸▾]\s*/, "")}` : t.querySelector(".rowlabel")?.textContent.trim()));
  assert.deepEqual(await rows(), ["#Fruit", "Apple", "Pear", "#Vegetables (2)"]);
  await pv.click('[data-qid="qx"] [data-testid="rs-optgroup-toggle"]');
  assert.deepEqual(await rows(), ["#Fruit", "Apple", "Pear", "#Vegetables (2)", "Carrot", "Leek"]);
  ok("matrix rows: a “Fruit” header row (th scope=rowgroup) and a collapsible “Vegetables” row group — opened, its rows appear");
  await pv.click('[data-testid="rs-next"]');
  await pv.waitForSelector('[data-qid="qc"]');
  const child = '[data-testid="rs-cascade-child"]', parent = '[data-testid="rs-cascade-parent"]';
  assert.equal(await pv.$eval(child, (e) => e.disabled), true, "the second list waits for the first");
  const labels = await pv.$$eval('[data-qid="qc"] .rs-cascade-label', (e) => e.map((x) => x.textContent));
  assert.deepEqual(labels, ["Country", "State"]);
  await pv.selectOption(parent, "IN");
  assert.deepEqual(await pv.$$eval(`${child} option`, (os) => os.map((o) => o.textContent)).then((x) => x.slice(1)), ["Maharashtra", "Kerala"]);
  await pv.selectOption(child, "2");
  await pv.selectOption(parent, "US");
  assert.equal(await pv.$eval(child, (e) => e.value), "", "changing the parent clears a child that no longer belongs");
  assert.deepEqual(await pv.$$eval(`${child} option`, (os) => os.map((o) => o.textContent)).then((x) => x.slice(1)), ["Texas"]);
  await pv.click('[data-testid="rs-next"]');
  await pv.waitForSelector('[data-qid="qc"] [data-testid="rs-errors"]');
  await pv.selectOption(child, "3");
  const st = await pv.evaluate(() => { const a = (window.__rescriptState ?? {}).answers ?? {}; return { v: a.qc, parent: a.qc__parent }; });
  assert.deepEqual(st, { v: 3, parent: "US" }, "the answer is the child code; the parent sits beside it (__parent)");
  await pv.click('[data-testid="rs-next"]');
  await pv.waitForSelector('[data-testid="rs-ended"], .rs-end', { timeout: 30000 });
  ok("cascading dropdown: Country → State (labels, second list disabled until a country), India → Maharashtra/Kerala, switching to the US clears Kerala and offers Texas; required refuses an empty child; Texas completes");
  await pv.context().close();
}

/* ============================================================== D. D14 / GA-03 one answer key */
if (SECTIONS.has("D")) {
  console.log("\nD  D14 / GA-03 the quiz reads question.assessment; a withheld key = a plain choice");
  const quizDef = (id, extra = {}, q = {}) => ({
    meta: { id, code: id.toUpperCase(), title: "Quiz", version: "1" },
    questions: [
      { id: "qz", code: "QZ", variableName: "QZ", type: "single_select", variant: "gamified.quiz", text: "Which article protects life and liberty?", required: true, settings: {},
        options: [{ code: 1, label: "Article 14" }, { code: 2, label: "Article 19" }, { code: 3, label: "Article 21" }], assessment: { correct: [3] }, ...q },
      { id: "q2", code: "Q2", variableName: "Q2", type: "open_text", variant: "text.single_line", text: "Any comment?", settings: {} },
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["qz"] }, { type: "page", id: "p2", questionIds: ["q2"] }, { type: "end", id: "e", status: "complete" }],
    ...extra,
  });
  const launch = async (def) => {
    const r = await fetch(`${RUNTIME}/api/session/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "launch", definition: def }) });
    const j = await r.json(); assert.ok(j.url, JSON.stringify(j)); return j.url;
  };
  const openLink = async (url) => {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => allErrors.push(`${url}: ${e.message}`));
    await goto(pg, `${RUNTIME}${url}`);
    await pg.waitForSelector('[data-qid="qz"]', { timeout: 120000 }); // a cold dev compile of /n/ can take a minute
    return pg;
  };

  // 1. a scored paper (results after submit): the respondent's copy has no key — a plain single choice
  const paper = await openLink(await launch(quizDef("quizp", { assessment: { enabled: true, showResults: "after_submit" } })));
  assert.equal(await paper.$('[data-qid="qz"] [data-testid="quiz"]'), null, "not the quiz widget");
  assert.equal(await paper.$$eval('[data-qid="qz"] input[type=radio]', (e) => e.length), 3, "an ordinary radio list");
  assert.equal(await paper.$('[data-testid="quiz-nokey"]'), null, "never the author hint");
  const src = await paper.content();
  assert.ok(!/No correct answer is marked yet/.test(src));
  await paper.click('[data-qid="qz"] label:has-text("Article 14")');
  assert.equal(await paper.$('[data-testid="quiz-verdict"]'), null, "no instant feedback");
  assert.equal(await paper.$eval('[data-qid="qz"] input[value="1"]', (e) => e.checked), true);
  ok("scored paper, results after submit (test link /n/, the stripped respondent copy): plain radio list, no verdict, no author hint");
  await paper.context().close();

  // 2. per_question results: the key is sent by design — instant feedback from question.assessment
  const pq = await openLink(await launch(quizDef("quizq", { assessment: { enabled: true, showResults: "per_question" } })));
  await pq.waitForSelector('[data-qid="qz"] [data-testid="quiz"]');
  await pq.click('[data-qid="qz"] .rs-quizopt[data-code="1"]');
  await pq.waitForSelector('[data-qid="qz"] [data-testid="quiz-verdict"].wrong');
  assert.ok(await pq.$('[data-qid="qz"] .rs-quizopt.right[data-code="3"]'), "the assessment key's answer is highlighted");
  ok("per_question paper: the quiz widget, a wrong pick → “Not quite”, Article 21 (assessment.correct) highlighted");
  await pq.context().close();

  // 3. an ordinary survey, quiz keyed ONLY through question.assessment (no option meta): feedback works in preview
  const pv = await open(quizDef("quizo"), { selector: '[data-qid="qz"]' });
  await pv.click('[data-qid="qz"] .rs-quizopt[data-code="3"]');
  await pv.waitForSelector('[data-qid="qz"] [data-testid="quiz-verdict"].right');
  ok("ordinary survey, key only in question.assessment (set_answer_key / Properties): instant feedback “Correct”");
  await pv.context().close();

  // 4. an unkeyed quiz: the author hint in preview only, never as a respondent
  const unkeyed = quizDef("quizn", {}, { assessment: undefined });
  const pa = await open(unkeyed, { selector: '[data-qid="qz"]' });
  await pa.waitForSelector('[data-testid="quiz-nokey"]');
  await pa.click('[data-qid="qz"] .rs-quizopt[data-code="1"]');
  assert.equal(await pa.$('[data-testid="quiz-verdict"]'), null, "no verdict against an empty key");
  await pa.context().close();
  const pr = await open(unkeyed, { selector: '[data-qid="qz"]', payload: { respondentView: true } });
  assert.equal(await pr.$('[data-testid="quiz-nokey"]'), null);
  ok("unkeyed quiz: the author hint in preview, absent “as a respondent”; no “Not quite” against an empty key");
  await pr.context().close();
}

/* ============================================================== E. the Studio editors */
if (SECTIONS.has("E")) {
  console.log("\nE  Studio: Branding preview, Option groups, cascading editor, quiz key");
  const { openHarness } = await import("./lib/variantHarness.mjs");
  const h = await openHarness();
  try {
    const opts = ["Apple", "Pear", "Carrot"].map((label, i) => ({ code: i + 1, label, flags: [] }));
    await h.loadDef({
      meta: { id: "sandbox", code: "S4A", title: "S4a", version: "1.0" },
      questions: [
        { id: "qs", code: "QS", variableName: "QS", type: "single_select", variant: "single_select.radio", text: "Pick one", options: opts, settings: {},
          optionGroups: [{ id: "g_fruit", name: "Fruit", scope: "options", members: [1, 2] }] },
        { id: "qc", code: "QC", variableName: "QC", type: "dropdown", variant: "single_select.cascading_dropdown", text: "Where?", settings: { cascadeParents: [{ code: "IN", label: "India" }, { code: "US", label: "United States" }] },
          options: [{ code: 1, label: "Kerala", flags: [], meta: { parent: "IN" } }, { code: 2, label: "Texas", flags: [], meta: { parent: "US" } }] },
        { id: "qz", code: "QZ", variableName: "QZ", type: "single_select", variant: "gamified.quiz", text: "Which?", settings: {},
          options: [{ code: 1, label: "A", flags: [], meta: { correct: true } }, { code: 2, label: "B", flags: [] }, { code: 3, label: "C", flags: [] }] },
      ],
      flow: [{ type: "page", id: "p1", questionIds: ["qs", "qc", "qz"] }, { type: "end", id: "e1", status: "complete" }],
      branding: { layout: { progressBar: "bottom", progressStyle: "steps" } },
    });
    // Branding preview
    await h.goTab("Branding");
    await h.page.waitForSelector('[data-testid="theme-preview-progress"]');
    let pr = await h.page.$eval('[data-testid="theme-preview-progress"]', (e) => ({ pos: e.getAttribute("data-position"), style: e.getAttribute("data-style"), label: e.querySelector('[data-testid="theme-preview-progress-label"]')?.textContent, dots: e.querySelectorAll(".rs-progress-dot").length, afterNext: !!(document.querySelector('[data-testid="theme-preview-next"]').compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) }));
    assert.deepEqual(pr, { pos: "bottom", style: "steps", label: "Page 3 of 7", dots: 7, afterNext: true });
    await h.page.selectOption('[data-testid="branding-progress-bar"]', "top");
    await h.page.waitForTimeout(250);
    pr = await h.page.$eval('[data-testid="theme-preview-progress"]', (e) => ({ pos: e.getAttribute("data-position"), afterNext: !!(document.querySelector('[data-testid="theme-preview-next"]').compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) }));
    assert.deepEqual(pr, { pos: "top", afterNext: false });
    ok("Branding preview: bottom + steps → “Page 3 of 7”, 7 dots, after the buttons; Progress bar → top moves it above");

    // Option groups → Respondents see
    const def0 = await h.readDef();
    await h.goTab("Questions");
    await (await h.page.$$('[data-testid="qcard"]'))[def0.questions.findIndex((q) => q.id === "qs")].click();
    await h.page.waitForTimeout(250);
    const head = '[data-testid="psec-head-option-groups"]';
    await h.page.waitForSelector(head, { timeout: 15000 });
    if ((await h.page.getAttribute(head, "aria-expanded")) !== "true") await h.page.click(head);
    await h.page.waitForSelector('[data-testid="group-display-g_fruit"]');
    await h.page.selectOption('[data-testid="group-display-g_fruit"]', "collapsible");
    await h.page.waitForSelector('[data-testid="group-label-g_fruit"]');
    await h.page.fill('[data-testid="group-label-g_fruit"]', "Fresh fruit");
    await h.page.waitForTimeout(300);
    let def = await h.readDef();
    const g = def.questions.find((q) => q.id === "qs").optionGroups[0];
    assert.deepEqual([g.display, g.label], ["collapsible", "Fresh fruit"]);
    ok("Properties → Option groups: “Respondents see” = a collapsible group, heading “Fresh fruit” → optionGroups[0] {display, label}");

    // the cascading editor and the quiz tick (question editor)
    const openEditor = async (qid) => {
      await h.goTab("Questions");
      await h.page.click('[data-testid="close-question"]').catch(() => {});
      const d = await h.readDef();
      await h.goTab("Questions");
      await (await h.page.$$('[data-testid="qcard"]'))[d.questions.findIndex((q) => q.id === qid)].click();
      await h.page.waitForTimeout(250);
    };
    await openEditor("qc");
    await h.page.waitForSelector('[data-testid="cascade-parents"]');
    assert.equal(await h.page.$$eval('[data-testid="cascade-parent-row"]', (e) => e.length), 2);
    assert.ok(await h.page.$('[data-testid="option-meta-parent-0"]'), "each option has a parent column");
    await h.page.click('[data-testid="cascade-parent-add"]');
    await h.page.fill('[data-testid="cascade-parent-label"]', "Country");
    await h.page.waitForTimeout(300);
    assert.ok(await h.page.$('[data-testid="cascade-problem"]'), "the new parent has no children — the lint says so");
    def = await h.readDef();
    const qc = def.questions.find((q) => q.id === "qc");
    assert.equal(qc.settings.cascadeParents.length, 3); assert.equal(qc.settings.cascadeParentLabel, "Country");
    ok("cascading dropdown editor: the first list (2 rows + 1 added), the prompt, a parent column per option, the lint chip");

    await openEditor("qz");
    await h.page.waitForSelector('[data-testid="option-meta-correct-2"]');
    assert.equal(await h.page.$eval('[data-testid="option-meta-correct-0"]', (e) => e.checked), true, "the legacy meta.correct reads as ticked");
    await h.page.click('[data-testid="option-meta-correct-2"]');
    await h.page.waitForTimeout(300);
    def = await h.readDef();
    const qz = def.questions.find((q) => q.id === "qz");
    assert.deepEqual(qz.assessment.correct.map(String).sort(), ["1", "3"]);
    assert.ok(!qz.options.some((o) => o.meta?.correct), "the legacy key moved into question.assessment");
    ok("quiz editor: ticking C writes question.assessment.correct [1, 3] and drops option.meta.correct");
  } finally { await h.close(); }
}

console.log(`\n${passed} passed`);
if (allErrors.length) { console.log("page errors:\n  " + allErrors.join("\n  ")); }
await browser.close();
process.exit(allErrors.length ? 1 : 0);
