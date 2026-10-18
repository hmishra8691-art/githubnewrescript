/**
 * THE WORD RESEARCH PLAN, END TO END (2026-10-17) — the download happens, the
 * file opens as a Word package, and it carries the ACTUAL survey's hypotheses,
 * questions and traceability, under a meaningful name.
 *
 *   §1 Intelligent mode: "prepare a Word research plan" → a card with a download
 *      link (these sentences used to go to the model, which said it had made a
 *      document and offered nothing) → BRAND26_Research_Plan_<date>.docx, parsed
 *      here: required parts, well-formed XML, the hypotheses, every question, the
 *      traceability rows, special characters intact
 *   §2 "update the Word document" after the design changed → a new file with the
 *      new hypothesis
 *   §3 the statistical analysis plan in the sandbox is produced, not refused as if
 *      it needed respondents
 *   §4 the Research tab's "Research plan (.docx)" button → the same document
 *
 *   node scripts/research-plan-docx-test.mjs      (studio on 3000, fake AI provider)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { checkDocx } from "../packages/analytics/dist/export/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const scale = () => ["Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree"].map((l, i) => ({ code: i + 1, label: l }));
const opts = (...ls) => ls.map((l, i) => ({ code: i + 1, label: l }));
const FIXTURE = {
  meta: { id: "sandbox", code: "BRAND26", title: "Brand choice & trust — “Café” study", version: "1.0" },
  research: {
    objective: "Why consumers choose Brand A over Brand B",
    hypotheses: ["Brand trust increases purchase intention", "Advertising exposure raises awareness"],
    population: "US and UK adults 18–45",
    constructs: [
      { name: "Brand trust", role: "independent", questionIds: ["t1", "t2"] }, { name: "Purchase intention", role: "dependent", questionIds: ["pi"] },
      { name: "Advertising exposure", role: "independent", questionIds: ["ad"] }, { name: "Awareness", role: "dependent", questionIds: ["aware"] },
    ],
    analysis: [], assumptions: [], sources: [],
  },
  questions: [
    { id: "gender", code: "S2", variableName: "GENDER", type: "single_select", text: "Gender", options: opts("Male", "Female", "Other") },
    { id: "aware", code: "Q1", variableName: "AWARE", type: "multi_select", text: "Which brands have you heard of?", options: opts("Brand A", "Brand B", "Brand C") },
    { id: "ad", code: "Q2", variableName: "AD_EXPOSE", type: "single_select", text: "Seen advertising for Brand A recently?", options: opts("Yes", "No") },
    { id: "t1", code: "Q3", variableName: "TRUST_1", type: "single_select", text: "Brand A keeps its promises", options: scale() },
    { id: "t2", code: "Q4", variableName: "TRUST_2", type: "single_select", text: "Brand A is honest", options: scale() },
    { id: "pi", code: "Q5", variableName: "PURCHASE_INT", type: "single_select", text: "How likely are you to buy Brand A?", options: scale() },
  ],
  flow: [{ type: "block", id: "b1", title: "Brand", children: [{ type: "page", id: "p1", questionIds: ["gender", "aware", "ad", "t1", "t2", "pi"] }] }, { type: "end", id: "e", status: "complete" }],
};
const NAME = /^BRAND26_Research_Plan_\d{4}-\d{2}-\d{2}\.docx$/;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 }, acceptDownloads: true });
page.on("dialog", (d) => d.accept());
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const loadDef = async (def) => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(600);
};
const intelligent = async () => { await openTab(page, "Questions"); await switchMode(page, "intelligent"); await page.waitForSelector('[data-testid="intelligent-view"]'); };
const turns = () => page.$$('[data-testid="cp-turn"]');
const say = async (text) => {
  const n = (await turns()).length;
  await page.fill('[data-testid="iq-input"]', text);
  await page.keyboard.press("Enter");
  await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 60000 });
  await page.waitForTimeout(300);
  return (await turns()).at(-1);
};
const textOf = async (h) => (await h.evaluate((e) => e.innerText)).replace(/\s+/g, " ");
/** the file the click saves, read and checked as a Word package */
const download = async (click) => {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), click()]);
  const buf = readFileSync(await dl.path());
  const c = checkDocx(buf);
  assert.deepEqual(c.problems, [], `the file is a valid .docx (${dl.suggestedFilename()})`);
  return { name: dl.suggestedFilename(), c };
};
const assertPlanContent = (t, what) => {
  for (const h of FIXTURE.research.hypotheses) assert.ok(t.includes(h), `${what}: hypothesis “${h}”`);
  for (const q of FIXTURE.questions) { assert.ok(t.includes(q.variableName), `${what}: ${q.variableName}`); assert.ok(t.includes(q.code), `${what}: ${q.code}`); }
  for (const s of ["Executive summary", "Hypotheses and rationale", "How each question serves the objectives and hypotheses", "Variables and scales", "Hypothesis tests", "Proposed tables and charts", "Quality control requirements", "Limitations, assumptions and recommendations"]) assert.ok(t.includes(s), `${what}: section ${s}`);
  assert.match(t, /Q5 How likely are you to buy Brand A\? PURCHASE_INT H1/, `${what}: Q5 traces to H1`);
  assert.match(t, /Brand choice & trust — “Café” study/, `${what}: special characters`);
  assert.doesNotMatch(t, /p = \.\d|Tested — supported/, `${what}: no result is invented`);
};

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadDef(FIXTURE);

console.log("\n§1 INTELLIGENT MODE — a sentence makes the document, the card offers it, the file is the survey's plan");
await intelligent();
let turn = await say("prepare a Word research plan");
assert.match(await textOf(turn), /The research plan \(Word\) is ready: BRAND26_Research_Plan_\d{4}-\d{2}-\d{2}\.docx/);
const card = await turn.$('[data-testid="cp-output"]');
assert.ok(card, "the card carries the file");
assert.equal(await card.getAttribute("data-kind"), "docx");
let doc = await download(() => turn.$eval('[data-testid="cp-output-download"]', (a) => a.click()));
assert.match(doc.name, NAME);
assertPlanContent(doc.c.text, "the copilot's plan");
assert.ok(doc.c.headers >= 1 && doc.c.footers >= 1 && doc.c.tables >= 8);
ok("“prepare a Word research plan” → a card with a download link → BRAND26_Research_Plan_<date>.docx, a valid package with the hypotheses, every question, the traceability, intact characters, no invented result");

console.log("\n§2 UPDATE — the document follows the design");
const changed = structuredClone(FIXTURE);
changed.research.hypotheses.push("Women trust Brand A more than men do");
await loadDef(changed);
await intelligent();
turn = await say("update the Word document");
assert.match(await textOf(turn), /research plan \(Word\) is ready/i);
doc = await download(() => turn.$eval('[data-testid="cp-output-download"]', (a) => a.click()));
assert.match(doc.name, NAME);
assert.ok(doc.c.text.includes("Women trust Brand A more than men do"), "the new hypothesis is in the regenerated plan");
assert.match(doc.c.text, /H3/);
ok("“update the Word document” regenerates the plan from the design as it is now (H3 appears)");

console.log("\n§3 THE SAP IN THE SANDBOX — produced from the design, not refused for want of respondents");
turn = await say("create the statistical analysis plan");
assert.doesNotMatch(await textOf(turn), /no respondents to report on/);
assert.ok(await turn.$('[data-testid="cp-output"]'), "a card with the file");
ok("the statistical analysis plan is a design document: the sandbox produces it");

console.log("\n§4 THE RESEARCH TAB — one click, the same document");
await loadDef(FIXTURE);
await openTab(page, "Survey Settings");
const DOCS = '.settings-wrap [data-testid="research-design"] [data-testid="research-documents"]';
await page.waitForSelector(`${DOCS} [data-testid="doc-research_plan_docx"]`);
assert.equal(await page.$eval(`${DOCS} [data-testid="doc-research_plan_docx"]`, (b) => b.disabled), false);
doc = await download(() => page.click(`${DOCS} [data-testid="doc-research_plan_docx"]`));
assert.match(doc.name, NAME);
assertPlanContent(doc.c.text, "the Research tab's plan");
ok("Research tab → Research plan (.docx): the same valid, named document with the survey's content");

assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
await browser.close();
console.log(`\n${passed} checks passed`);
