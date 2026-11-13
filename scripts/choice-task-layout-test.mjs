/**
 * THE RESPONDENT'S CONJOINT AND MAXDIFF SCREENS (2026-11-14) — layout, in the runtime preview.
 *
 *   CBC desktop   the page uses more of the screen than a page of ordinary questions; the alternatives are cards
 *                 SIDE BY SIDE; each attribute sits on the same line in every card; "None of these" is one wide
 *                 card under them; clicking anywhere on a card chooses it (the radio still works); nothing scrolls
 *                 sideways; the answer stored is the same { task: alternative }
 *   CBC tablet    three cards still side by side; five wrap two per row
 *   CBC phone     the cards stack; no sideways scroll
 *   MAXDIFF       the row of each pick is marked; the targets are finger-sized; fits a phone
 *   OTHERS        a page of ordinary questions keeps its width
 *
 *   node scripts/choice-task-layout-test.mjs      (runtime on :3001; SHOT=<dir> also writes screenshots)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { maxdiffPlugin, conjointPlugin } from "../packages/designs/dist/index.js";
import { SurveyDefinition } from "../packages/schema/dist/index.js";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const SHOT = process.env.SHOT;
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const base = (id, title) => ({ meta: { id, code: id.toUpperCase(), title, version: "1.0", schemaVersion: 1, status: "draft" }, logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], variables: [], embeddedData: [], listFills: [], scripts: [], deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } } });
const plain = { id: "q0", code: "Q0", variableName: "Q0", type: "single_select", required: true, text: "Do you own a smartphone?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] };
function cbc(alts) {
  const config = { method: "efficient", attributes: [{ name: "Brand", levels: ["Apex", "Nova", "Zen"] }, { name: "Screen", levels: ["6.1 in", "6.5 in", "6.9 in OLED with always-on display"] }, { name: "Battery", levels: ["One day", "Two days", "Three days"] }, { name: "Storage", levels: ["128 GB", "256 GB", "512 GB"] }, { name: "Price", levels: ["$499", "$699", "$899"] }], tasks: 4, alternativesPerTask: alts, noneOption: true, versions: 1 };
  const d = conjointPlugin.generate(config, 9);
  const def = { ...base(`cl_cj${alts}`, "Phones"), questions: [plain, { id: "q", code: "Q1", variableName: "CJ", type: "conjoint_task", variant: "conjoint.cbc", required: true, text: "Which of these phones would you buy?", settings: { designRef: "d1" } }], flow: [{ type: "page", id: "p0", questionIds: ["q0"] }, { type: "page", id: "p1", questionIds: ["q"] }, { type: "end", id: "e", status: "complete" }], designs: [{ id: "d1", kind: "conjoint", name: "P", version: 1, seed: 9, config, file: { format: "json", columns: d.columns, rows: d.rows, summary: d.summary } }] };
  SurveyDefinition.parse(def);
  return def;
}
function md() {
  const config = { items: ["Battery life", "Camera quality", "Screen size", "Price", "Weight", "Storage", "Water resistance", "Charging speed", "Durability", "Brand"], itemsPerTask: 5, tasks: 6, versions: 1, balance: "optimized" };
  const d = maxdiffPlugin.generate(config, 7);
  const def = { ...base("cl_md", "Phones"), questions: [plain, { id: "q", code: "Q1", variableName: "MD", type: "maxdiff_task", variant: "maxdiff.best_worst", required: true, text: "Which matters most to you, and which least?", settings: { designRef: "d1" } }], flow: [{ type: "page", id: "p0", questionIds: ["q0"] }, { type: "page", id: "p1", questionIds: ["q"] }, { type: "end", id: "e", status: "complete" }], designs: [{ id: "d1", kind: "maxdiff", name: "F", version: 1, seed: 7, config, file: { format: "json", columns: d.columns, rows: d.rows, summary: d.summary } }] };
  SurveyDefinition.parse(def);
  return def;
}
const browser = await chromium.launch();
const pageErrors = [];
/** opens the survey, measures the first (ordinary) page's shell, and goes on to the task page */
const open = async (def, w, h = 800) => {
  const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
  await sendPreview(page, { definition: def }, { selector: '[data-qid="q0"]' });
  const plainShell = await page.$eval(".rs-shell", (e) => Math.round(e.getBoundingClientRect().width));
  await page.click('[data-qid="q0"] input[type="radio"]');
  await page.click('[data-testid="rs-next"]');
  await page.waitForSelector('[data-qid="q"] [data-testid="rs-taskpager"]');
  return { page, plainShell };
};
const measure = (page) => page.evaluate(() => {
  const r = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), b: Math.round(b.bottom), r: Math.round(b.right) }; };
  const cards = [...document.querySelectorAll('tr[data-testid="cbc-alt"]:not([data-none])')];
  const none = document.querySelector('tr[data-testid="cbc-alt"][data-none]');
  return {
    shell: r(document.querySelector(".rs-shell")).w,
    sideScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    cards: cards.map(r),
    attrY: cards.map((c) => [...c.querySelectorAll("td[data-label]")].map((td) => r(td).y)),
    chooseY: cards.map((c) => r(c.querySelector(".rs-cbc-pick")).y),
    chooseH: cards.map((c) => r(c.querySelector(".rs-cbc-pick")).h),
    none: none ? r(none) : null,
    table: r(document.querySelector('[data-testid^="cbc-task-"]')),
  };
});
const answers = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__rescriptState.answers)));
const shot = async (page, name) => { if (SHOT) await page.screenshot({ path: `${SHOT}/${name}.png` }); };

console.log("\nCONJOINT — desktop 1366");
{
  const { page, plainShell } = await open(cbc(3), 1366);
  const m = await measure(page);
  assert.ok(plainShell <= 980, `a page of ordinary questions keeps its width (${plainShell})`);
  assert.ok(m.shell >= 1080 && m.shell > plainShell, `the conjoint page is wider (${m.shell} vs ${plainShell})`);
  assert.equal(m.sideScroll, 0);
  ok(`the conjoint page uses ${m.shell}px of a 1366px screen (ordinary page: ${plainShell}px), no sideways scroll`);
  assert.equal(m.cards.length, 3);
  assert.equal(new Set(m.cards.map((c) => c.y)).size, 1, "the three cards start on one line");
  assert.ok(m.cards[0].x < m.cards[1].x && m.cards[1].x < m.cards[2].x, "left to right");
  assert.ok(Math.max(...m.cards.map((c) => c.w)) - Math.min(...m.cards.map((c) => c.w)) <= 2, "equal widths");
  assert.ok(m.cards[2].r <= m.table.r + 1 && m.cards[2].r >= m.table.r - 20, "the cards fill the width of the task");
  for (let a = 0; a < m.attrY[0].length; a++) assert.equal(new Set(m.attrY.map((ys) => ys[a])).size, 1, `attribute ${a + 1} sits on one line across the cards`);
  assert.equal(new Set(m.chooseY).size, 1, "the Choose buttons line up");
  assert.ok(m.chooseH.every((h) => h >= 40));
  ok("three concept cards side by side, equal width, every attribute and the Choose button on the same line across cards");
  assert.ok(m.none && m.none.y >= m.cards[0].b && m.none.w >= m.table.w - 4, "None of these: one wide card under the concepts");
  ok("“None of these” is one full-width card under the concepts");
  /* the whole card chooses */
  const second = (await page.$$('tr[data-testid="cbc-alt"]:not([data-none])'))[1];
  const alt = await second.getAttribute("data-alt");
  const task = await second.getAttribute("data-task");
  await second.click({ position: { x: 30, y: 60 } });
  assert.deepEqual((await answers(page)).q, { [task]: alt });
  assert.ok(await second.evaluate((e) => e.classList.contains("rs-cbc-chosen")));
  const first = (await page.$$('tr[data-testid="cbc-alt"]:not([data-none])'))[0];
  await (await first.$('input[type="radio"]')).check();
  assert.deepEqual((await answers(page)).q, { [task]: await first.getAttribute("data-alt") });
  ok("clicking anywhere on a card chooses it; the radio still works; the stored answer is { task: alternative } as before");
  await shot(page, "cbc-desktop");
  await page.close();
}

console.log("\nCONJOINT — laptop, tablet, phone");
{
  for (const w of [1180, 1024]) {
    const { page } = await open(cbc(3), w, 720);
    const m = await measure(page);
    assert.equal(m.sideScroll, 0); assert.equal(new Set(m.cards.map((c) => c.y)).size, 1);
    assert.ok(m.shell <= w && m.shell >= w - 300, `${w}: ${m.shell}`);
    await page.close();
  }
  ok("1180 and 1024 wide: three cards side by side within the screen, no sideways scroll");
  {
    const { page } = await open(cbc(3), 820);
    const m = await measure(page);
    assert.equal(m.sideScroll, 0); assert.equal(new Set(m.cards.map((c) => c.y)).size, 1, "three cards fit a tablet");
    assert.ok(m.cards.every((c) => c.w >= 170), `readable cards (${m.cards.map((c) => c.w)})`);
    await shot(page, "cbc-tablet");
    await page.close();
    const five = await open(cbc(5), 820);
    const f = await measure(five.page);
    assert.equal(f.sideScroll, 0);
    assert.equal(new Set(f.cards.map((c) => c.x)).size, 2, "five concepts: two per row on a tablet");
    assert.ok(f.cards.every((c) => c.w >= 280));
    await five.page.close();
    const wide = await open(cbc(5), 1366);
    const g = await measure(wide.page);
    assert.equal(new Set(g.cards.map((c) => c.y)).size, 1, "five side by side on a desktop");
    assert.equal(g.sideScroll, 0);
    await wide.page.close();
  }
  ok("tablet 820: three cards side by side; five concepts wrap two per row there and sit in one row on a desktop");
  {
    const { page } = await open(cbc(3), 390, 844);
    const m = await measure(page);
    assert.equal(m.sideScroll, 0);
    assert.equal(new Set(m.cards.map((c) => c.x)).size, 1, "stacked");
    assert.ok(m.cards[1].y > m.cards[0].b - 1);
    assert.ok(m.chooseH.every((h) => h >= 44), "finger-sized Choose");
    const c = (await page.$$('tr[data-testid="cbc-alt"]:not([data-none])'))[2];
    await c.click({ position: { x: 20, y: 12 } });
    assert.equal(Object.values((await answers(page)).q)[0], await c.getAttribute("data-alt"));
    await shot(page, "cbc-phone");
    await page.close();
  }
  ok("phone 390: the cards stack, the Choose button is 44px or more, tapping a card chooses it, no sideways scroll");
}

console.log("\nMAXDIFF");
{
  for (const [w, h, name] of [[1366, 800, "desktop"], [390, 844, "phone"]]) {
    const { page } = await open(md(), w, h);
    const rows = await page.$$('tr[data-testid="md-item"]');
    await (await rows[0].$('input[name$="_best"]')).click();
    await (await rows[3].$('input[name$="_worst"]')).click();
    const m = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('tr[data-testid="md-item"]')];
      const bg = (tr) => getComputedStyle(tr.querySelector("td.rowlabel")).backgroundColor;
      const picks = [...document.querySelectorAll(".rs-md-pick")].map((e) => e.getBoundingClientRect());
      const t = document.querySelector('[data-testid^="md-table-"]').getBoundingClientRect();
      return { marked: rows.map((r) => bg(r) !== bg(rows[1])), minPick: Math.min(...picks.map((p) => Math.min(p.width, p.height))), sideScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth, table: Math.round(t.width), bottom: Math.round(rows[rows.length - 1].getBoundingClientRect().bottom), vh: window.innerHeight };
    });
    assert.deepEqual(m.marked, [true, false, false, true, false], "the two picked rows are marked, the others are not");
    assert.ok(m.minPick >= 44, `targets ${m.minPick}px`);
    assert.equal(m.sideScroll, 0);
    if (name === "desktop") assert.ok(m.bottom < m.vh, "a set of five fits one desktop screen without scrolling");
    const a = (await answers(page)).q;
    assert.deepEqual(Object.keys(Object.values(a)[0]).sort(), ["best", "worst"]);
    await shot(page, `md-${name}`);
    await page.close();
  }
  ok("desktop and phone: the Most and Least rows are marked, targets are 44px or more, a set fits the desktop screen, the answer is { best, worst }");
}

await browser.close();
assert.deepEqual(pageErrors, [], "no page errors");
console.log(`\nCHOICE TASK LAYOUT: ${passed} checks passed`);
