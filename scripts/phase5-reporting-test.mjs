/**
 * RESEARCH ENGINE — PHASE 5 (automated reporting), in the browser.
 *
 *   - "create the client-ready research proposal" → the Word document from
 *     the research design, on the card with its size and what it holds
 *   - the findings outputs without respondents are said to be unanswerable
 *   - rows handed in through the seam → "create the final findings
 *     presentation" with a scripted narrative: the deck is built from a run
 *     on the data, the gate keeps the sentences the run supports and names
 *     the one it dropped, the card shows both; the file is a real deck
 *   - "write the findings report as a Word document" → the Word report
 *   - the Findings tab's Documents buttons go through the engine; the
 *     executive deck is the executive edition
 *   - the output route's gate
 *
 *   node scripts/phase5-reporting-test.mjs      (studio on 3000, fake AI provider)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { openTab, switchMode } from "./lib/nav.mjs";
import { def as synthDef, synthRows } from "/home/claude/rescript/packages/analytics/dist/analyses/fixture.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const FIXTURE = structuredClone(synthDef);
FIXTURE.meta = { ...FIXTURE.meta, id: "sandbox", code: "SANDBOX" };
FIXTURE.research = {
  objective: "What drives satisfaction and recommendation", population: "Adults 18+ who bought in the last year",
  hypotheses: ["Women are more satisfied than men", "Satisfaction differs by region"], researchQuestions: ["Which groups are most satisfied?"], kpis: [{ name: "NPS", variable: "NPS", measure: "promoters − detractors", target: "30", direction: "higher" }],
  constructs: [{ name: "Satisfaction", role: "dependent", questionIds: ["q_sat"] }], analysis: [], assumptions: ["The panel is representative"], sources: ["Brief v2"],
  analysisPlan: {
    crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: ["H1"], reason: "satisfaction by gender" }],
    tests: [
      { id: "t1", method: "t_test", outcome: "SAT", variables: ["SAT"], groupBy: "GENDER", priority: 1, hypotheses: ["H1"] },
      { id: "t2", method: "anova", outcome: "SAT", variables: ["SAT"], groupBy: "REGION", priority: 1, hypotheses: ["H2"] },
    ],
    derived: [], segments: [], source: "researcher",
  },
};
const ROWS = synthRows(400);
const NARRATIVE = { headline: "Women are the more satisfied customers.", summary: ["We set out to learn what drives satisfaction and recommendation.", "Women score 3.86 against 3.07 for men, a strong difference.", "Satisfaction rose 77.7% in the north."], implications: ["H1 is supported: gender is the largest difference measured."], recommendations: ["Plan a follow-up on the gender gap before the next wave."] };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
page.on("dialog", (d) => d.accept());
const errors = [];
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|net::ERR|status of (404|501|502|402|409|401|400)/.test(m.text())) errors.push(m.text()); });

const loadDef = async (def) => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(600);
};
const intelligent = async () => {
  await openTab(page, "Questions");
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
};
const turns = () => page.$$('[data-testid="cp-turn"]');
const settled = async (n) => {
  await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 90000 });
  await page.waitForTimeout(300);
  return (await turns()).at(-1);
};
const say = async (text, fake) => {
  if (fake) await page.evaluate((r) => window.__rescriptCopilotFake(r), fake);
  const n = (await turns()).length;
  await page.fill('[data-testid="iq-input"]', text);
  await page.keyboard.press("Enter");
  const last = await settled(n);
  await page.evaluate(() => window.__rescriptCopilotFakeReset?.());
  return last;
};
const textOf = async (h) => (await h.evaluate((e) => e.innerText)).replace(/\s+/g, " ");
/** the produced file, read back from the card's link: its first bytes and its slide parts */
const fileOf = (h) => h.$eval('[data-testid="cp-output-download"]', async (a) => { const buf = new Uint8Array(await (await fetch(a.href)).arrayBuffer()); let s = ""; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]); const slides = new Set(s.match(/ppt\/slides\/slide\d+\.xml/g) ?? []).size; return { name: a.getAttribute("download"), bytes: buf.length, head: s.slice(0, 2), slides, hasWord: s.includes("word/document.xml") }; });

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadDef(FIXTURE);
await intelligent();
if (!(await page.evaluate(() => typeof window.__rescriptCopilotFake === "function"))) { console.log("  skip  no fake copilot provider in this build"); await browser.close(); process.exit(0); }

/* ------------------------------------------------ 1. the proposal, from the design alone */
{
  const t = await say("Create the client-ready research proposal");
  assert.equal(await t.getAttribute("data-status"), "ready");
  const text = await textOf(t);
  assert.match(text, /The research proposal \(Word\) is ready: What_drives_satisfaction_and_recommendation-research-proposal\.docx \(\d+ KB\)\. Research proposal: 2 hypotheses, 18 questions, the saved analysis plan/);
  const out = await t.$('[data-testid="cp-output"]');
  assert.equal(await out.getAttribute("data-kind"), "docx");
  const f = await fileOf(t);
  assert.equal(f.head, "PK"); assert.ok(f.hasWord, "a Word document"); assert.ok(f.bytes > 5000, `${f.bytes} bytes`);
  assert.equal(await (await t.$('[data-testid="cp-engine-detail"]')).getAttribute("data-kind"), "answer");
  assert.equal(await t.$('[data-testid="cp-output-narrative"]'), null, "no narrative on a proposal");
  ok("the research proposal: a Word document from the design, on the card with its name, size and what it holds — no model, no data needed");
}

/* ------------------------------------------------ 2. the findings outputs need respondents */
{
  const t = await say("create the final findings presentation");
  assert.match(await textOf(t), /The sandbox has no respondents to report on\. Open a survey with fieldwork and ask there/);
  assert.equal(await (await t.$('[data-testid="cp-engine-detail"]')).getAttribute("data-kind"), "refused");
  ok("a findings deck with no respondents: said to be unanswerable here");
}

/* ------------------------------------------------ 3. the deck from a run, with the narrative through the gate */
await page.evaluate((rows) => window.__rescriptAnalyticsRows(rows), ROWS);
{
  const t = await say("create the final findings presentation", NARRATIVE);
  const text = await textOf(t);
  assert.match(text, /The findings presentation \(PowerPoint, client edition\) is ready: What_drives_satisfaction_and_recommendation-findings-client\.pptx \(\d+ KB\)\. \d+ slides: title, summary, .* - 400 completes Narrative gate: 5 of 6 sentences kept; dropped: summary: the number 77\.7% is not in the run\./);
  const f = await fileOf(t);
  assert.equal(f.head, "PK"); assert.equal(f.name, "What_drives_satisfaction_and_recommendation-findings-client.pptx");
  assert.ok(f.slides >= 9, `${f.slides} slides`);
  assert.match(await page.textContent('[data-testid="cp-output-narrative"]'), /5 of 6 sentences kept/);
  ok("the findings deck: a run on the rows, the story slides, the model's narrative kept where the run supports it and dropped where it does not — said on the card");
}
{
  const t = await say("write the findings report as a Word document");
  const text = await textOf(t);
  assert.match(text, /The findings report \(Word\) is ready: What_drives_satisfaction_and_recommendation-findings-report\.docx \(\d+ KB\)\. Findings report: 2 hypotheses, \d significant findings - 400 completes Narrative gate: the model gave nothing - the engine's words stand\./);
  const f = await fileOf(t);
  assert.ok(f.hasWord && f.head === "PK");
  ok("the findings report as Word: from the same run, the engine's words when the model has nothing");
}

/* ------------------------------------------------ 4. the Findings tab's Documents buttons, through the engine */
await page.click('[data-testid="cp-tab-findings"]');
await page.waitForSelector('[data-testid="fd-outputs"]');
{
  const n = (await turns()).length;
  await page.click('[data-testid="fd-output-deck-exec"]');
  const t = await settled(n);
  assert.match(await textOf(t), /The findings presentation \(PowerPoint, executive edition\) is ready: .*-findings-executive\.pptx/);
  const f = await fileOf(t);
  assert.equal(f.name, "What_drives_satisfaction_and_recommendation-findings-executive.pptx");
  await page.click('[data-testid="cp-tab-findings"]');
  const n2 = (await turns()).length;
  await page.click('[data-testid="fd-output-proposal"]');
  const t2 = await settled(n2);
  assert.match(await textOf(t2), /The research proposal \(Word\) is ready/);
  ok("the Findings tab's Documents: each button is a sentence the engine reads — the executive deck is the executive edition, the proposal the proposal");
}

/* ------------------------------------------------ 5. the output route's gate */
{
  const post = (body) => page.evaluate(async (b) => { const x = await fetch("/api/copilot/output", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); const ct = x.headers.get("content-type") ?? ""; return [x.status, ct.includes("json") ? await x.json() : { bytes: (await x.arrayBuffer()).byteLength, disposition: x.headers.get("content-disposition"), output: x.headers.get("x-rescript-output"), narrative: x.headers.get("x-rescript-narrative") }]; }, body);
  let r = await post({ surveyId: "00000000-0000-0000-0000-000000000000", output: { type: "proposal_docx", audience: "client" } });
  assert.equal(r[0], 401, "a real survey needs a session");
  r = await post({ surveyId: "sandbox", output: { type: "findings_pptx", audience: "client" }, definition: FIXTURE, rows: [] });
  assert.equal(r[0], 409); assert.equal(r[1].code, "no_data");
  r = await post({ surveyId: "sandbox", output: { type: "nope" }, definition: FIXTURE });
  assert.equal(r[0], 400);
  r = await post({ surveyId: "sandbox", output: { type: "findings_docx", audience: "researcher" }, definition: FIXTURE, rows: ROWS.slice(0, 60), narrative: false });
  assert.equal(r[0], 200); assert.ok(r[1].bytes > 5000); assert.match(r[1].disposition, /findings-report\.docx/); assert.equal(r[1].narrative, "not asked");
  const noPlan = { ...FIXTURE, research: { ...FIXTURE.research, analysisPlan: undefined } };
  r = await post({ surveyId: "sandbox", output: { type: "findings_pptx", audience: "client" }, definition: noPlan, rows: ROWS.slice(0, 60) });
  assert.ok(r[0] === 200 || r[0] === 409, `the design's own framework runs, or says nothing is planned: ${r[0]}`);
  ok("the output route: a session for a real survey, rows for the sandbox, a known type; narrative off when not asked");
}

assert.deepEqual(errors, [], `console errors: ${errors.join("\n")}`);
await browser.close();
console.log(`\n${passed} passed`);
