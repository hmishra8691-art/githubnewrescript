/**
 * Browser suite — S4b "TIMERS AND BEHAVIOUR CONDITIONS" (2026-11-01, docs/S4-NATIVE-FEATURES-2026-10-31.md part B).
 *
 * The runtime preview (the real Runner, engine and renderer; no database) unless a section says otherwise.
 *
 *   A  native timers: a page countdown (role=timer, aria-live off) that advances with an unanswered required question
 *      and writes TIMER_P1_ELAPSED / TIMER_P1_TIMED_OUT; an answered INVALID question at timeout stops the page (error
 *      shown, focus) until fixed; a question lock disables its inputs; a message; minSeconds keeps Next disabled with
 *      the explanation and then announces once; the warning is announced once and its pulse is off under reduced motion
 *   B  behaviour conditions: a message after 5 s on a page (time_on_page >= 5); a mobile-only question at a phone
 *      viewport (and not on a desktop one); timed_out.Q1 shows a note once Q1's timer ran out
 *   C  the Studio (needs :3000): Properties → Timer writes question.timer; the display-logic source list has
 *      "Respondent behaviour" and no SYSTEM_* group; the flow page's Timer
 *
 *   RUNTIME_URL=http://localhost:3001 node scripts/s4b-timers-conditions-test.mjs
 *   SECTIONS=A,B,C (default all)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const SECTIONS = new Set((process.env.SECTIONS ?? "A,B,C").split(",").map((s) => s.trim()));
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const allErrors = [];
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

async function goto(page, url) {
  for (let i = 0; ; i++) {
    try { await page.goto(url, { waitUntil: "networkidle", timeout: 120000 }); return; }
    catch (e) { if (i >= 4 || /crash/i.test(String(e))) throw e; await sleep(8000); }
  }
}
async function open(def, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1100, height: opts.height ?? 700 }, reducedMotion: opts.reducedMotion ?? "no-preference", ...(opts.userAgent ? { userAgent: opts.userAgent, isMobile: true, hasTouch: true } : {}) });
  const pv = await ctx.newPage();
  pv.on("pageerror", (e) => { if (!/ChunkLoadError|Loading chunk .* failed|ResizeObserver loop/.test(String(e))) allErrors.push(`${def.meta.id}: ${e.message}`); });
  await goto(pv, `${RUNTIME}/preview`);
  await sendPreview(pv, { definition: def });
  return pv;
}
const yesNo = [{ code: "1", label: "Yes" }, { code: "2", label: "No" }];
const sq = (id, extra = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "single_select", text: `Question ${id}`, options: yesNo, required: true, settings: {}, ...extra });
const nq = (id, extra = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "numeric", text: `Number ${id}`, required: true, settings: {}, validation: [{ kind: "max_value", value: 10, message: "10 or less, please." }], ...extra });
const note = (id, text, displayLogic) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "html", text, settings: {}, displayLogic });
const survey = (id, questions, pages) => ({ meta: { id, code: id.toUpperCase(), title: id, version: "1" }, questions, flow: [...pages, { type: "end", id: "e1", status: "complete" }] });
const embedded = (pv) => pv.evaluate(() => ({ ...(window.__rescriptState?.embedded ?? {}) }));
const rule = (ref, operator, value, scope) => ({ type: "rule", source: { kind: "behavior", ref, ...(scope ? { scope } : {}) }, operator, value });

/* ============================================================== A. native timers */
if (SECTIONS.has("A")) {
  console.log("\nA  native timers");
  {
    const def = survey("s4b-a1", [sq("q1"), nq("q2", { required: false }), sq("q3")], [
      { type: "page", id: "p1", questionIds: ["q1", "q2"], timer: { limitSeconds: 4, show: "countdown", onTimeout: "advance" } },
      { type: "page", id: "p2", questionIds: ["q3"] },
    ]);
    const pv = await open(def);
    await pv.waitForSelector('[data-qid="q1"]');
    const t = await pv.$eval('[data-testid="rs-timer"]', (e) => ({ text: e.textContent, role: e.querySelector('[role="timer"]')?.getAttribute("aria-live"), ref: e.getAttribute("data-ref") }));
    assert.equal(t.role, "off", "the visible clock is not read every second");
    assert.equal(t.ref, "p1");
    assert.match(t.text, /0:0[34]/);
    await pv.waitForSelector('[data-qid="q3"]', { timeout: 12000 });
    const em = await embedded(pv);
    assert.equal(em.TIMER_P1_TIMED_OUT, 1);
    assert.ok(em.TIMER_P1_ELAPSED >= 3.9 && em.TIMER_P1_ELAPSED < 8, `elapsed ${em.TIMER_P1_ELAPSED}`);
    ok("page countdown (role=timer, aria-live off) → at 0 the page advances through Next with required Q1 unanswered; TIMER_P1_ELAPSED / _TIMED_OUT = 1 recorded");
    await pv.context().close();
  }
  {
    const def = survey("s4b-a2", [sq("q1"), nq("q2"), sq("q3")], [
      { type: "page", id: "p1", questionIds: ["q1", "q2"], timer: { limitSeconds: 3, onTimeout: "advance" } },
      { type: "page", id: "p2", questionIds: ["q3"] },
    ]);
    const pv = await open(def);
    await pv.waitForSelector('[data-qid="q2"] input');
    await pv.fill('[data-qid="q2"] input', "99");
    await sleep(4500);
    assert.ok(await pv.$('[data-qid="q1"]'), "still on page 1: an answered invalid question stops the page");
    assert.equal(await pv.$eval('[data-qid="q2"]', (e) => e.getAttribute("aria-invalid")), "true");
    assert.equal(await pv.evaluate(() => document.activeElement?.closest("[data-qid]")?.getAttribute("data-qid")), "q2", "focus on the invalid answer");
    assert.equal(await pv.$('[data-qid="q1"][aria-invalid="true"]'), null, "the unanswered Q1 is not flagged — it is skipped");
    assert.equal((await embedded(pv)).TIMER_P1_TIMED_OUT, 1);
    await pv.fill('[data-qid="q2"] input', "5");
    await pv.waitForSelector('[data-testid="rs-next"]:not([disabled])');
    await pv.click('[data-testid="rs-next"]');
    await pv.waitForSelector('[data-qid="q3"]', { timeout: 10000 });
    ok("timeout with an answered INVALID value: the page stays, the error shows on Q2 with focus, Q1 (unanswered) is not flagged; fixed → Next goes through");
    await pv.context().close();
  }
  {
    const def = survey("s4b-a3", [sq("q1", { required: false, timer: { limitSeconds: 2, show: "hidden", onTimeout: "lock" } }), sq("q2", { required: false, timer: { limitSeconds: 2, show: "hidden", onTimeout: "message", message: "Time is up for Q2." } }),
      note("n1", "<p>Q1 ran out of time.</p>", rule("timed_out", "eq", true, "Q1"))], [
      { type: "page", id: "p1", questionIds: ["q1", "q2", "n1"] },
    ]);
    const pv = await open(def);
    await pv.waitForSelector('[data-qid="q1"] input');
    assert.equal(await pv.$('[data-testid="rs-timer"]'), null, "hidden clocks draw nothing");
    assert.equal(await pv.$('[data-qid="n1"]'), null, "timed_out.Q1 is false before the timeout");
    assert.equal(await pv.$eval('[data-qid="q1"] input', (e) => e.disabled), false);
    await pv.waitForSelector('[data-qid-lock="q1"][data-locked="true"]', { timeout: 8000 });
    const s = await pv.evaluate(() => ({
      q1: [...document.querySelectorAll('[data-qid="q1"] input')].every((e) => e.matches(":disabled")),
      q2: [...document.querySelectorAll('[data-qid="q2"] input')].some((e) => e.matches(":disabled")),
      msg: document.querySelector('[data-testid="rs-timer-message"]')?.textContent ?? "",
      announce: document.querySelector('[data-testid="rs-timer-announce"]')?.textContent ?? "",
    }));
    assert.deepEqual([s.q1, s.q2], [true, false], "the lock disables only Q1's inputs");
    assert.match(s.msg, /Time is up for Q2/);
    assert.match(s.announce, /Time is up/);
    await pv.waitForSelector('[data-qid="n1"]', { timeout: 5000 });
    ok("question timers: lock disables Q1's inputs (fieldset), message shows Q2's text, “Time is up” is announced politely; timed_out.Q1 shows its note");
    await pv.context().close();
  }
  {
    const def = survey("s4b-a4", [sq("q1", { required: false }), sq("q2")], [
      { type: "page", id: "p1", questionIds: ["q1"], timer: { minSeconds: 3, show: "countdown" } },
      { type: "page", id: "p2", questionIds: ["q2"] },
    ]);
    const pv = await open(def);
    await pv.waitForSelector('[data-qid="q1"]');
    const s = await pv.evaluate(() => ({ disabled: document.querySelector('[data-testid="rs-next"]').disabled, describedBy: document.querySelector('[data-testid="rs-next"]').getAttribute("aria-describedby"), note: document.querySelector('[data-testid="rs-min-wait"]')?.textContent ?? "" }));
    assert.equal(s.disabled, true);
    assert.equal(s.describedBy, "rs-min-wait");
    assert.match(s.note, /Next becomes available after 3 seconds/);
    await pv.waitForSelector('[data-testid="rs-next"]:not([disabled])', { timeout: 8000 });
    assert.equal(await pv.$('[data-testid="rs-min-wait"]'), null);
    await pv.waitForFunction(() => /continue now/.test(document.querySelector('[data-testid="rs-timer-announce"]')?.textContent ?? ""), null, { timeout: 3000 });
    await pv.click('[data-testid="rs-next"]');
    await pv.waitForSelector('[data-qid="q2"]', { timeout: 10000 });
    ok("minSeconds: Next disabled with the explanation (aria-describedby), enabled after 3 s, “You can continue now” announced once");
    await pv.context().close();
  }
  for (const reduced of ["no-preference", "reduce"]) {
    const def = survey(`s4b-a5-${reduced}`, [sq("q1", { required: false })], [{ type: "page", id: "p1", questionIds: ["q1"], timer: { limitSeconds: 60, warnAtSeconds: 58, onTimeout: "lock" } }]);
    const pv = await open(def, { reducedMotion: reduced });
    await pv.waitForSelector('[data-testid="rs-timer"]');
    await pv.waitForSelector('[data-testid="rs-timer"].rs-timer-warn', { timeout: 8000 });
    const announce = await pv.waitForFunction(() => document.querySelector('[data-testid="rs-timer-announce"]')?.textContent ?? "", null, { timeout: 3000 }).then((h) => h.jsonValue());
    assert.match(announce, /^\d+ seconds left\.$/);
    await sleep(1500);
    assert.equal(await pv.$eval('[data-testid="rs-timer-announce"]', (e) => e.textContent), announce, "announced once, not every second");
    const anim = await pv.$eval('[data-testid="rs-timer"]', (e) => getComputedStyle(e).animationName);
    if (reduced === "reduce") assert.equal(anim, "none"); else assert.equal(anim, "rs-timer-pulse");
    await pv.context().close();
  }
  ok("warning: at warnAtSeconds the clock turns to the warning state and “N seconds left.” is announced once; the pulse is off under prefers-reduced-motion");
}

/* ============================================================== B. behaviour conditions */
if (SECTIONS.has("B")) {
  console.log("\nB  behaviour conditions");
  {
    const def = survey("s4b-b1", [sq("q1", { required: false }), note("n1", "<p>Take your time — there is no rush.</p>", rule("time_on_page", "gte", 5))], [{ type: "page", id: "p1", questionIds: ["q1", "n1"] }]);
    const pv = await open(def);
    await pv.waitForSelector('[data-qid="q1"]');
    const t0 = Date.now();
    assert.equal(await pv.$('[data-qid="n1"]'), null, "not shown at first");
    await pv.waitForSelector('[data-qid="n1"]', { timeout: 10000 });
    const after = (Date.now() - t0) / 1000;
    assert.ok(after >= 3.5, `shown after ${after}s`);
    ok(`time_on_page >= 5: the message appears by itself after ~5 s on the page (seen after ${after.toFixed(1)} s of polling)`);
    await pv.context().close();
  }
  {
    const def = survey("s4b-b2", [sq("q1", { required: false }), sq("qm", { required: false, text: "Mobile only", displayLogic: rule("device", "eq", "mobile") })], [{ type: "page", id: "p1", questionIds: ["q1", "qm"] }]);
    const phone = await open(def, { width: 390, height: 844, userAgent: IPHONE_UA });
    await phone.waitForSelector('[data-qid="q1"]');
    assert.ok(await phone.$('[data-qid="qm"]'), "shown at a phone viewport");
    await phone.context().close();
    const desk = await open(def);
    await desk.waitForSelector('[data-qid="q1"]');
    assert.equal(await desk.$('[data-qid="qm"]'), null, "hidden on a desktop");
    await desk.context().close();
    ok("device = mobile: the question shows at a phone viewport (iPhone user agent) and not on a desktop");
  }
}

/* ============================================================== C. the Studio */
if (SECTIONS.has("C")) {
  console.log("\nC  Studio: Timer properties, the behaviour sources, the page timer");
  const { openHarness } = await import("./lib/variantHarness.mjs");
  const { openSectionWorkspace, saveWorkspace, LD_BODY } = await import("./lib/logicWorkspace.mjs");
  const h = await openHarness();
  try {
    await h.loadDef({
      meta: { id: "sandbox", code: "S4B", title: "S4b", version: "1.0" },
      questions: [sq("q1"), sq("q2")],
      flow: [{ type: "page", id: "p1", title: "Page one", questionIds: ["q1", "q2"] }, { type: "end", id: "e1", status: "complete" }],
    });
    await h.goTab("Questions");
    await (await h.page.$$('[data-testid="qcard"]'))[1].click();
    await h.page.waitForTimeout(250);
    const head = '[data-testid="psec-head-timer"]';
    await h.page.waitForSelector(head, { timeout: 15000 });
    if ((await h.page.getAttribute(head, "aria-expanded")) !== "true") await h.page.click(head);
    await h.page.click('[data-testid="question-timer-on"]');
    await h.page.fill('[data-testid="question-timer-limit"]', "45");
    await h.page.selectOption('[data-testid="question-timer-on-timeout"]', "lock");
    await h.page.fill('[data-testid="question-timer-warn"]', "50");
    await h.page.waitForTimeout(300);
    assert.ok(await h.page.$('[data-testid="question-timer-lint"]'), "a warning longer than the limit is flagged");
    await h.page.fill('[data-testid="question-timer-warn"]', "10");
    await h.page.waitForTimeout(300);
    let def = await h.readDef();
    assert.deepEqual(def.questions.find((q) => q.id === "q2").timer, { limitSeconds: 45, show: "countdown", onTimeout: "lock", warnAtSeconds: 10 });
    ok("Properties → Timer: on, 45 s, lock, warn 10 → question.timer; a warning ≥ the limit shows the lint chip");

    /* readDef visits the JSON tab: select the question again before its logic */
    await h.goTab("Questions");
    await h.page.click('[data-testid="qcard"][data-qid="q2"]');
    await h.page.waitForTimeout(250);
    const body = await openSectionWorkspace(h.page, "display-logic");
    await h.page.click(`${body} [data-testid="lb-add-condition"] >> nth=0`);
    await h.page.waitForSelector(`${body} select.ref-select`);
    const groups = await h.page.$eval(`${body} select.ref-select`, (el) => [...el.querySelectorAll("optgroup")].map((g) => g.label));
    assert.ok(groups.includes("Respondent behaviour"), groups.join(", "));
    assert.ok(!groups.some((g) => /SYSTEM_/.test(g)), `no SYSTEM_* group in a display condition: ${groups.join(", ")}`);
    await h.page.$eval(`${body} select.ref-select`, (el) => { el.value = "behavior:device"; el.dispatchEvent(new Event("change", { bubbles: true })); });
    await h.page.waitForTimeout(200);
    await h.page.selectOption(`${body} [data-testid="cond-value"]`, "mobile");
    await h.page.waitForTimeout(200);
    await saveWorkspace(h.page);
    def = await h.readDef();
    assert.deepEqual(def.questions.find((q) => q.id === "q2").displayLogic?.children?.[0] ?? def.questions.find((q) => q.id === "q2").displayLogic,
      { type: "rule", source: { kind: "behavior", ref: "device" }, operator: "eq", value: "mobile" });
    ok("display logic: the source list has “Respondent behaviour” and no SYSTEM_* group; device → mobile is stored as a behaviour rule");

    await h.goTab("Survey Flow");
    const card = '[data-testid="flow-block"][data-node-id="p1"]';
    await h.page.waitForSelector(card, { timeout: 15000 });
    await h.page.click(`${card} .block-toggle >> nth=0`);
    await h.page.click('[data-testid="page-timer-toggle-p1"] summary');
    await h.page.waitForSelector('[data-testid="page-timer-p1-on"]', { timeout: 15000 });
    await h.page.click('[data-testid="page-timer-p1-on"]');
    await h.page.fill('[data-testid="page-timer-p1-min"]', "10");
    await h.page.waitForTimeout(300);
    def = await h.readDef();
    assert.equal(def.flow.find((n) => n.id === "p1").timer?.minSeconds, 10);
    ok("Flow → block → page Timer writes flow page.timer (minimum 10 s before Next)");
  } finally { await h.close(); }
}

console.log(`\n${passed} passed`);
if (allErrors.length) { console.log("page errors:\n  " + allErrors.join("\n  ")); }
await browser.close();
process.exit(allErrors.length ? 1 : 0);
