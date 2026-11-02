/**
 * 2026-11-02 — THE STUDIO SIDE of the hypothesis → construct → question links, "I don't know" and "Other — specify"
 * (sandbox, no model).
 *
 *   A  Survey Settings → Research design: "+ hypothesis" creates the constructs its sides name and links the
 *      questions that certainly measure them — the definition holds both sides of every link straight away
 *   B  a difference between groups links the question whose answer options define them (codes recorded)
 *   C  an uncertain match is listed, not linked; "link" links it (and tags the question); "Link all constructs"
 *      run again creates nothing new
 *   D  Questions → a numeric question: "Enable “I don't know” option" and its label are saved on the question
 *   E  Questions → a single-choice question: typing "Please specify" as an option label gives it the box
 *
 *   node scripts/research-links-studio-test.mjs      (Studio dev server)
 */
import { chromium } from "./lib/playwright.mjs";
import assert from "node:assert/strict";
import { openTab } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const SECTIONS = (process.env.SECTIONS ?? "ABCDE").toUpperCase();
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const opts = (...ls) => ls.map((l, i) => ({ code: i + 1, label: l }));
const q = (id, code, variableName, type, text, extra = {}) => ({ id, code, variableName, type, text, ...extra });
const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Links", version: "1.0" },
  questions: [
    q("q1", "Q1", "PRICE_PERC", "single_select", "How do you perceive the price of your plan?", { options: opts("Cheap", "Fair", "Expensive") }),
    q("q2", "Q2", "SWITCH", "single_select", "How likely are you to switch provider next year?", { options: opts("Likely", "Unlikely") }),
    q("q3", "Q3", "GENDER", "single_select", "What is your gender?", { options: opts("Male", "Female") }),
    q("q4", "Q4", "SAT", "single_select", "Overall, how satisfied are you with your provider?", { options: opts("1", "2", "3", "4", "5") }),
    q("q5", "Q5", "BILL", "numeric", "What do you pay each month? (price)"),
  ],
  flow: [{ type: "page", id: "p1", title: "Page 1", questionIds: ["q1", "q2", "q3", "q4", "q5"] }, { type: "end", id: "e1", status: "complete" }],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
page.on("dialog", (d) => d.accept());
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
const loadDef = async (def) => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(600);
};
const readDef = async () => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  return JSON.parse(await page.$eval("textarea.code", (e) => e.value));
};
const RD = '.settings-wrap [data-testid="research-design"]';
const toResearch = async () => { await openTab(page, "Survey Settings"); await page.waitForSelector(RD); };
const selectQuestion = async (code) => {
  await openTab(page, "Questions");
  await page.waitForSelector(".qcard");
  for (const c of await page.$$(".qcard")) if ((await c.textContent()).includes(code)) { await c.click(); await page.waitForTimeout(300); return; }
  throw new Error(`no card for ${code}`);
};

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForSelector(".menubar", { timeout: 120000 });
await loadDef(FIXTURE);

if (/[ABC]/.test(SECTIONS)) {
  await toResearch();
  await page.fill(`${RD} [data-testid="rd-hypothesis-new"]`, "Higher price perception increases switching intention");
  await page.click(`${RD} [data-testid="rd-hypothesis-add"]`);
  await page.waitForTimeout(400);
  let def = await readDef();
  const c = (n) => def.research.constructs.find((x) => x.name === n);
  assert.deepEqual(def.research.hypotheses, ["Higher price perception increases switching intention"]);
  assert.deepEqual(c("Price perception")?.questionIds, ["q1"], JSON.stringify(def.research.constructs));
  assert.deepEqual(c("Switching")?.questionIds, ["q2"]);
  assert.deepEqual([def.questions[0].analysis?.construct, def.questions[0].analysis?.hypotheses], ["Price perception", ["H1"]]);
  assert.deepEqual([def.questions[1].analysis?.construct, def.questions[1].analysis?.hypotheses], ["Switching", ["H1"]]);
  ok("A: “+ hypothesis” made Price perception (Q1) and Switching (Q2), linked both ways, in the same edit");

  if (SECTIONS.includes("B")) {
    await toResearch();
    await page.fill(`${RD} [data-testid="rd-hypothesis-new"]`, "Women are more satisfied than men");
    await page.click(`${RD} [data-testid="rd-hypothesis-add"]`);
    await page.waitForTimeout(400);
    def = await readDef();
    assert.deepEqual(c("Gender")?.questionIds, ["q3"], JSON.stringify(def.research.constructs));
    assert.deepEqual(c("Satisfaction")?.questionIds, ["q4"]);
    assert.deepEqual(def.research.hypothesisDetails[1].groupOptions, { questionId: "q3", higher: [2], lower: [1] });
    ok("B: a difference between groups: Gender ← Q3 with its answer codes (2 higher, 1 lower), Satisfaction ← Q4");
  }

  if (SECTIONS.includes("C")) {
    await toResearch();
    const review = `${RD} [data-testid="rd-construct-review-item"][data-question="q5"]`;
    await page.waitForSelector(review);
    assert.match(await page.textContent(review), /1 of the 2 words of “Price perception”/);
    def = await readDef();
    assert.equal(def.questions[4].analysis, undefined, "listed, not linked");
    await toResearch();
    await page.click(`${review} [data-testid="rd-review-link"]`);
    await page.waitForTimeout(400);
    def = await readDef();
    assert.deepEqual(c("Price perception").questionIds, ["q1", "q5"]);
    assert.deepEqual([def.questions[4].analysis?.construct, def.questions[4].analysis?.hypotheses], ["Price perception", ["H1"]]);
    const before = JSON.stringify(def.research.constructs);
    await toResearch();
    await page.click(`${RD} [data-testid="rd-link-all"]`);
    await page.waitForTimeout(400);
    def = await readDef();
    assert.equal(JSON.stringify(def.research.constructs), before, "regenerating creates nothing new and links nothing twice");
    ok("C: an uncertain match is listed, not linked; “link” links it with the question's tags; “Link all constructs” again changes nothing");
  }
}

if (SECTIONS.includes("D")) {
  await selectQuestion("Q5");
  const toggle = '[data-testid="dont-know-toggle"]';
  await page.waitForSelector(toggle, { state: "attached" });
  await page.$eval(toggle, (el) => el.scrollIntoView({ block: "center" }));
  await page.click(toggle);
  await page.waitForSelector('[data-testid="dont-know-label"]');
  await page.fill('[data-testid="dont-know-label"]', "Not sure");
  await page.waitForTimeout(300);
  const def = await readDef();
  assert.equal(def.questions[4].settings.dontKnow, true);
  assert.equal(def.questions[4].settings.dontKnowLabel, "Not sure");
  await selectQuestion("Q1");
  assert.equal(await page.$('[data-testid="dont-know-toggle"]'), null, "a choice question does not offer it");
  ok("D: “Enable “I don't know” option” and its label are saved on the numeric question; a choice question has no such setting");
}

if (SECTIONS.includes("E")) {
  await selectQuestion("Q3");
  await page.click('[data-testid="add-option"]');
  await page.waitForTimeout(200);
  await page.keyboard.type("Please specify");
  await page.waitForTimeout(400);
  const def = await readDef();
  const added = def.questions[2].options.at(-1);
  assert.equal(added.label.replace(/<[^>]*>/g, ""), "Please specify");
  assert.ok(added.flags.includes("other_specify"), JSON.stringify(added));
  ok("E: typing “Please specify” as an option label gives it the specify box");
}

assert.deepEqual(pageErrors, [], "no page errors");
console.log(`\nresearch-links-studio: ${passed} passed`);
await browser.close();
