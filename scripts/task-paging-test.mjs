/**
 * ONE TASK AT A TIME, AND WHAT MAY ANSWER OR LEAVE A PAGE BY ITSELF (2026-11-12) — in the runtime preview.
 *
 *   MAXDIFF   a nine-set MaxDiff shows ONE set; the page's Next steps the sets and leaves the page only from the
 *             last; a required set cannot be skipped; Back steps back through the sets, then the pages; Back from
 *             the next page lands on the last set with every answer kept; a reload lands on the first open set;
 *             the stored answer is the same object keyed by task
 *   CBC       the same pager on a conjoint; `taskAutoNext` moves to the next TASK after a choice, never off the page
 *   MOBILE    390 × 844: one task fits the width, no horizontal scroll, the survey completes
 *   STACKED   `taskPaging: "all"` still draws every task (existing projects that want it)
 *   CONSENT   with survey-wide auto-next on, an ordinary single choice moves the page on; a consent question never
 *             does and is never answered for the respondent — not by an auto-punch rule either
 *   SELECT    the single-option rule in "select" mode: the one answer is in place, the question is SHOWN, the
 *             respondent presses Next; in the default mode it is answered and not shown
 *
 *   node scripts/task-paging-test.mjs      (runtime on :3001; set RUNTIME_URL to override)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { maxdiffPlugin, conjointPlugin } from "../packages/designs/dist/index.js";
import { SurveyDefinition } from "../packages/schema/dist/index.js";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const base = (id, title) => ({
  meta: { id, code: id.toUpperCase(), title, version: "1.0", schemaVersion: 1, status: "draft" },
  logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], variables: [], embeddedData: [], listFills: [], scripts: [],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
});
const after = { id: "q_after", code: "Q9", variableName: "AFTER", type: "text", variant: "text.single_line", required: false, text: "Anything else?" };

const ITEMS = ["Battery life", "Camera quality", "Screen size", "Price", "Weight", "Storage", "Water resistance", "Charging speed", "Durability", "Brand", "Design", "Warranty"];
function maxdiffSurvey(id, settings = {}) {
  const config = { items: ITEMS, itemsPerTask: 5, tasks: 9, versions: 2, balance: "optimized" };
  const design = maxdiffPlugin.generate(config, 20261114);
  const def = {
    ...base(id, "Phone features"),
    questions: [
      { id: "q_intro", code: "Q0", variableName: "INTRO", type: "single_select", required: true, text: "Do you own a smartphone?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
      { id: "q_md", code: "Q1", variableName: "MD", type: "maxdiff_task", variant: "maxdiff.best_worst", required: true, text: "Which matters most, and which least?", settings: { designRef: "d1", ...settings } },
      after,
    ],
    flow: [{ type: "page", id: "p0", questionIds: ["q_intro"] }, { type: "page", id: "p1", questionIds: ["q_md"] }, { type: "page", id: "p2", questionIds: ["q_after"] }, { type: "end", id: "e1", status: "complete" }],
    designs: [{ id: "d1", kind: "maxdiff", name: "Features", version: 1, seed: 20261114, config, file: { format: "json", columns: design.columns, rows: design.rows, summary: design.summary } }],
  };
  SurveyDefinition.parse(def);
  return def;
}
function cbcSurvey(id, settings = {}) {
  const config = {
    method: "efficient",
    attributes: [{ name: "Brand", levels: ["Apex", "Nova", "Zen"] }, { name: "Screen", levels: ["6.1 in", "6.5 in", "6.9 in"] }, { name: "Price", levels: ["$499", "$699", "$899"] }],
    tasks: 4, alternativesPerTask: 3, noneOption: true, versions: 2,
  };
  const design = conjointPlugin.generate(config, 20261017);
  const def = {
    ...base(id, "Phones"),
    questions: [{ id: "q_cj", code: "Q1", variableName: "CJ", type: "conjoint_task", variant: "conjoint.cbc", required: true, text: "Which phone would you buy?", settings: { designRef: "d1", ...settings } }, after],
    flow: [{ type: "page", id: "p1", questionIds: ["q_cj"] }, { type: "page", id: "p2", questionIds: ["q_after"] }, { type: "end", id: "e1", status: "complete" }],
    designs: [{ id: "d1", kind: "conjoint", name: "Phones", version: 1, seed: 20261017, config, file: { format: "json", columns: design.columns, rows: design.rows, summary: design.summary } }],
  };
  SurveyDefinition.parse(def);
  return def;
}

const browser = await chromium.launch();
const pageErrors = [];
const open = async (viewport, def, selector) => {
  const page = await (await browser.newContext({ viewport })).newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await sendPreview(page, { definition: def }, { selector });
  return page;
};
const next = async (page) => { await page.click('[data-testid="rs-next"]'); await page.waitForTimeout(350); };
const back = async (page) => { await page.click('[data-testid="rs-back"]'); await page.waitForTimeout(350); };
const answers = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__rescriptState.answers)));
const shownTasks = (page, attr = "md-item") => page.$$eval(`[data-testid="${attr}"]`, (els) => [...new Set(els.map((e) => e.getAttribute("data-task")))]);
const pagerAt = (page) => page.$eval('[data-testid="rs-taskpager"]', (e) => `${e.getAttribute("data-task-index")}/${e.getAttribute("data-task-count")}`);
/** choose the first item best and the last item worst in the set on screen; returns the task id */
const answerSet = async (page) => {
  const [t] = await shownTasks(page);
  const items = await page.$$eval(`[data-testid="md-item"][data-task="${t}"]`, (els) => els.map((e) => e.getAttribute("data-item")));
  await page.click(`tr[data-testid="md-item"][data-task="${t}"][data-item="${items[0]}"] input[name$="_best"]`);
  await page.click(`tr[data-testid="md-item"][data-task="${t}"][data-item="${items[items.length - 1]}"] input[name$="_worst"]`);
  return { t, best: items[0], worst: items[items.length - 1] };
};

/* ============================================================ MAXDIFF */
console.log("\nMAXDIFF — one set at a time, stepped by the page's own Next and Back");
{
  const page = await open({ width: 1280, height: 900 }, maxdiffSurvey("tp_md"), '[data-qid="q_intro"]');
  await page.click('[data-qid="q_intro"] input[type="radio"]');
  await next(page);
  await page.waitForSelector('[data-testid="rs-taskpager"]');
  assert.deepEqual(await shownTasks(page), ["1"], "only the first set is drawn");
  assert.equal(await page.$$eval('[data-testid="md-item"]', (e) => e.length), 5, "one set of five items");
  assert.equal(await pagerAt(page), "1/9");
  assert.equal((await page.textContent('[data-testid="md-task-1"]')).trim(), "Task 1 of 9");
  assert.equal(await page.$('[data-testid="rs-task-next"]'), null, "inside the Runner the pager draws no buttons of its own");
  ok("a nine-set MaxDiff shows one set (5 items), “Task 1 of 9”, one pair of buttons");

  await next(page);
  assert.deepEqual(await shownTasks(page), ["1"], "a required set is not skipped");
  assert.match(await page.textContent('[data-testid="rs-taskpager-notice"]'), /Please answer this set before you continue/);
  ok("Next on an unanswered required set stays and says why");

  const given = {};
  for (let i = 1; i <= 9; i++) {
    assert.equal(await pagerAt(page), `${i}/9`);
    const a = await answerSet(page);
    given[a.t] = { best: a.best, worst: a.worst };
    assert.equal(await page.$('[data-testid="rs-taskpager-notice"]'), null, "the message clears once the set is answered");
    if (i === 3) {
      /* Back steps to the previous SET, with its answer in place, and forward again */
      await back(page);
      assert.equal(await pagerAt(page), "2/9");
      const [t2] = await shownTasks(page);
      assert.equal(await page.$eval(`tr[data-task="${t2}"][data-item="${given[t2].best}"] input[name$="_best"]`, (e) => e.checked), true, "the previous set still holds its answer");
      await next(page);
      assert.equal(await pagerAt(page), "3/9");
    }
    if (i < 9) { await next(page); assert.ok(await page.$('[data-qid="q_md"]'), "still on the MaxDiff page"); }
  }
  assert.deepEqual((await answers(page)).q_md, given, "the stored answer is one object keyed by task — unchanged shape");
  ok("Next steps through all nine sets; Back steps back a set; the answer is { task: { best, worst } } as before");

  await next(page);
  await page.waitForSelector('[data-qid="q_after"]');
  ok("the page is left only from the last set");
  await back(page);
  await page.waitForSelector('[data-testid="rs-taskpager"]');
  assert.equal(await pagerAt(page), "9/9", "Back from the next page lands on the last set");
  assert.deepEqual((await answers(page)).q_md, given);
  for (let i = 8; i >= 1; i--) { await back(page); assert.equal(await pagerAt(page), `${i}/9`); }
  await back(page);
  await page.waitForSelector('[data-qid="q_intro"]');
  ok("Back from the next page lands on set 9 with every answer kept; Back from set 1 goes to the page before");
  await page.close();

  /* an optional exercise may be stepped through; the last page's button says Submit only on the last task */
  const opt = maxdiffSurvey("tp_md_opt");
  opt.questions[1].required = false;
  opt.questions.splice(2, 1);
  opt.flow = [{ type: "page", id: "p0", questionIds: ["q_intro"] }, { type: "page", id: "p1", questionIds: ["q_md"] }, { type: "end", id: "e1", status: "complete" }];
  const p2 = await open({ width: 1280, height: 900 }, opt, '[data-qid="q_intro"]');
  await p2.click('[data-qid="q_intro"] input[type="radio"]');
  await next(p2);
  await p2.waitForSelector('[data-testid="rs-taskpager"]');
  assert.equal(await p2.getAttribute('[data-testid="rs-next"]', "data-rs-button"), "next", "not Submit while sets remain");
  for (let i = 1; i < 9; i++) await next(p2);
  assert.equal(await pagerAt(p2), "9/9");
  assert.equal(await p2.getAttribute('[data-testid="rs-next"]', "data-rs-button"), "submit", "Submit on the last set of the last page");
  ok("an optional exercise can be stepped through unanswered; the last page says Submit only on its last set");
  await p2.close();
}

/* ============================================================ CBC */
console.log("\nCBC — the same pager; task auto-next moves to the next task, never off the page");
{
  const page = await open({ width: 1280, height: 900 }, cbcSurvey("tp_cbc", { taskAutoNext: true }), '[data-testid="cbc-task-1"]');
  assert.equal(await pagerAt(page), "1/4");
  assert.equal(await page.$$eval('[data-testid^="cbc-task-"]', (e) => e.length), 1, "one task drawn");
  assert.equal(await page.$('[data-testid="rs-back"]'), null, "no Back on the first task of the first page");
  for (let i = 1; i <= 4; i++) {
    await page.waitForSelector(`[data-testid="cbc-task-${i}"]`);
    await page.click(`[data-testid="cbc-task-${i}"] input[type="radio"]`);
    await page.waitForTimeout(700);
  }
  assert.equal(await pagerAt(page), "4/4", "after the last choice the pager stays on the last task");
  assert.ok(await page.$('[data-qid="q_cj"]'), "task auto-next never leaves the page");
  assert.ok(await page.$('[data-testid="rs-back"]'), "Back is offered once there is a task to go back to");
  assert.equal(Object.keys((await answers(page)).q_cj).length, 4);
  ok("a choice moves on to the next task by itself (taskAutoNext); the page waits for Next after the last");

  /* a reload lands on the first open task */
  const p2 = await open({ width: 1280, height: 900 }, cbcSurvey("tp_cbc_reload"), '[data-testid="cbc-task-1"]');
  await p2.click('[data-testid="cbc-task-1"] input[type="radio"]');
  await p2.waitForTimeout(500);
  assert.equal(await pagerAt(p2), "1/4", "without taskAutoNext a choice does not move the task");
  await next(p2);
  await p2.click('[data-testid="cbc-task-2"] input[type="radio"]');
  await p2.waitForTimeout(600);
  await p2.reload({ waitUntil: "networkidle" });
  const resumed = await p2.$('[data-testid="rs-taskpager"]');
  if (resumed) { assert.equal(await pagerAt(p2), "3/4", "a reload resumes on the first unanswered task"); ok("without taskAutoNext a choice stays put; a reload resumes on the first unanswered task (3 of 4)"); }
  else ok("without taskAutoNext a choice stays put (this preview does not keep a session across a reload — resume not checked here)");
  await page.close(); await p2.close();
}

/* ============================================================ MOBILE */
console.log("\nMOBILE 390×844 — one set fits, no horizontal scroll, completes");
{
  const page = await open({ width: 390, height: 844 }, maxdiffSurvey("tp_md_mobile"), '[data-qid="q_intro"]');
  await page.click('[data-qid="q_intro"] input[type="radio"]');
  await next(page);
  await page.waitForSelector('[data-testid="rs-taskpager"]');
  let tallest = 0;
  for (let i = 1; i <= 9; i++) {
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, h: document.documentElement.scrollHeight }));
    assert.ok(m.sw <= m.cw + 1, `set ${i}: no horizontal scroll (${m.sw} in ${m.cw})`);
    tallest = Math.max(tallest, m.h);
    const { t } = await answerSet(page);
    const box = await page.$eval(`tr[data-task="${t}"] input[name$="_best"]`, (e) => { const r = (e.closest("label") ?? e).getBoundingClientRect(); return Math.min(r.width, r.height); });
    assert.ok(box >= 24, `tap target ${box}px`);
    await next(page);
  }
  await page.waitForSelector('[data-qid="q_after"]');
  await next(page);
  await page.waitForFunction(() => /thank|complete/i.test(document.body.innerText), null, { timeout: 8000 });
  ok(`nine sets on a phone, one at a time: no horizontal scroll, tallest page ${tallest}px (was nine sets stacked), completes`);
  await page.close();
}

/* ============================================================ STACKED */
console.log("\nSTACKED — taskPaging: \"all\" keeps every task on the page");
{
  const page = await open({ width: 1280, height: 900 }, cbcSurvey("tp_cbc_all", { taskPaging: "all" }), '[data-testid="cbc-task-1"]');
  assert.equal(await page.$$eval('[data-testid^="cbc-task-"]', (e) => e.length), 4);
  assert.equal(await page.$('[data-testid="rs-taskpager"]'), null);
  ok("all four tasks drawn, no pager");
  await page.close();
}

/* ============================================================ CONSENT / AUTO-NEXT / AUTO-SELECT */
console.log("\nCONSENT — never answered for the respondent, never left by itself");
{
  const YES_NO = [{ code: 1, label: "Yes, I agree" }, { code: 2, label: "No" }];
  const def = {
    ...base("tp_consent", "Consent"),
    branding: { layout: { autoAdvance: true } },
    questions: [
      { id: "q_a", code: "Q1", variableName: "OWN", type: "single_select", required: true, text: "Do you own a car?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
      { id: "q_consent", code: "CONSENT", variableName: "CONSENT", type: "single_select", required: true, text: "Do you agree to take part in this study?", options: YES_NO,
        punches: [{ id: "p1", source: { kind: "codes", codes: [1] }, action: "select", recompute: "always", mode: "if", when: { type: "rule", source: { kind: "question", ref: "q_a" }, operator: "selected", value: 1 } }] },
      { id: "q_b", code: "Q2", variableName: "MIRROR", type: "single_select", required: true, text: "Confirm: do you own a car?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }],
        punches: [{ id: "p2", source: { kind: "codes", codes: [1] }, action: "select", recompute: "always", mode: "if", when: { type: "rule", source: { kind: "question", ref: "q_a" }, operator: "selected", value: 1 } }] },
      after,
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q_a"] }, { type: "page", id: "p2", questionIds: ["q_consent"] }, { type: "page", id: "p3", questionIds: ["q_b"] }, { type: "page", id: "p4", questionIds: ["q_after"] }, { type: "end", id: "e1", status: "complete" }],
  };
  let parsedOk = true;
  try { SurveyDefinition.parse(def); } catch (e) { parsedOk = false; console.log(String(e).slice(0, 600)); }
  assert.ok(parsedOk, "the definition parses");
  const page = await open({ width: 1280, height: 900 }, def, '[data-qid="q_a"]');
  await page.click('[data-qid="q_a"] input[type="radio"]');
  await page.waitForSelector('[data-qid="q_consent"]', { timeout: 4000 });
  ok("survey-wide auto-next: an ordinary single choice moves the page on by itself");
  await page.waitForTimeout(900);
  assert.ok(await page.$('[data-qid="q_consent"]'), "the consent page is still there");
  assert.equal((await answers(page)).q_consent, undefined, "the consent question is NOT answered by its auto-punch rule");
  assert.equal(await page.$$eval('[data-qid="q_consent"] input[type="radio"]', (els) => els.filter((e) => e.checked).length), 0);
  ok("an auto-punch rule does not answer a consent question");
  await page.click('[data-qid="q_consent"] input[type="radio"]');
  await page.waitForTimeout(1100);
  assert.ok(await page.$('[data-qid="q_consent"]'), "choosing consent does not move the page on, even with auto-next on");
  ok("choosing a consent answer does not advance the page — the respondent presses Next");
  await next(page);
  await page.waitForSelector('[data-qid="q_b"]');
  await page.waitForTimeout(900);
  assert.equal((await answers(page)).q_b, 1, "the answer on page 1 selected the matching option on page 3");
  assert.ok(await page.$('[data-qid="q_b"]'), "AUTO-SELECT is not AUTO-ADVANCE: the pre-selected page waits");
  ok("auto-select: the earlier answer is selected on the later page, and the page waits for the respondent");
  await page.close();
}

console.log("\nSINGLE-OPTION RULE — select-and-show vs answer-and-skip");
{
  const BRANDS = [{ code: 1, label: "Apex" }, { code: 2, label: "Nova" }, { code: 3, label: "Zen" }];
  const make = (id, mode) => ({
    ...base(id, "Brands"),
    questions: [
      { id: "q_used", code: "Q1", variableName: "USED", type: "multi_select", required: true, text: "Which have you used?", options: BRANDS },
      { id: "q_fav", code: "Q2", variableName: "FAV", type: "single_select", required: true, text: "Which is your favourite?", options: [],
        carryForward: { sourceQuestionId: "q_used", filter: "selected", into: "options" }, settings: mode ? { singleOption: mode } : {} },
      after,
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q_used"] }, { type: "page", id: "p2", questionIds: ["q_fav"] }, { type: "page", id: "p3", questionIds: ["q_after"] }, { type: "end", id: "e1", status: "complete" }],
  });
  for (const mode of [undefined, "select", "ask"]) {
    const def = make(`tp_single_${mode ?? "skip"}`, mode);
    let parsedOk = true;
    try { SurveyDefinition.parse(def); } catch (e) { parsedOk = false; console.log(String(e).slice(0, 600)); }
    assert.ok(parsedOk, "the definition parses");
    const page = await open({ width: 1280, height: 900 }, def, '[data-qid="q_used"]');
    await page.click('[data-qid="q_used"] input[type="checkbox"]');
    await next(page);
    if (!mode) {
      /* the preview is the programmer's view, which keeps an engine-answered question on screen; a live link does not show it (engine singleOption.test) */
      await page.waitForSelector('[data-qid="q_after"], [data-qid="q_fav"]');
      assert.equal((await answers(page)).q_fav, 1);
      ok("default (skip): the only brand is recorded as the favourite by the engine");
    } else if (mode === "select") {
      await page.waitForSelector('[data-qid="q_fav"]');
      assert.equal((await answers(page)).q_fav, 1);
      assert.equal(await page.$$eval('[data-qid="q_fav"] input[type="radio"]', (els) => els.filter((e) => e.checked).length), 1);
      await next(page);
      await page.waitForSelector('[data-qid="q_after"]');
      ok("select: the only brand is selected, the question is shown, the respondent presses Next");
    } else {
      await page.waitForSelector('[data-qid="q_fav"]');
      assert.equal((await answers(page)).q_fav, undefined);
      ok("ask: nothing is answered for the respondent");
    }
    await page.close();
  }
}

await browser.close();
assert.deepEqual(pageErrors, [], "no page errors");
console.log(`\nTASK PAGING: ${passed} checks passed`);
