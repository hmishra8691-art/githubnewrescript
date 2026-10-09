/**
 * RESEARCH ENGINE — PHASE 4 (automated analysis), in the browser.
 *
 *   - a data question in the sandbox with no respondents is answered as
 *     unanswerable, with where to ask
 *   - rows handed in through the test seam → "which groups consider Alpha",
 *     "does satisfaction differ by gender", "what is the average NPS among
 *     women", "which brand is most considered" are answered on the data by
 *     the ask route: the sentence, the base, the test, the sections; with a
 *     run on the page the planned finding on the same pair is shown too
 *   - "test whether NPS differs by region" plans an ANOVA through the gate
 *     and applies; "what analyses are planned for satisfaction" answers from
 *     the plan; "remove the crosstab of satisfaction by gender" removes it
 *   - the Findings tab on a run with the Phase 4 fields: the correction
 *     summary, the adjusted p on each finding, the data advice with its
 *     recommendation, the discoveries beyond the plan
 *   - the ask route refuses a real survey without a session and the
 *     sandbox without rows
 *
 *   node scripts/phase4-analysis-test.mjs      (studio on 3000, fake AI provider)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { openTab, switchMode } from "./lib/nav.mjs";
import { def as synthDef, synthRows, synthDataset, spec } from "/home/claude/rescript/packages/analytics/dist/analyses/fixture.js";
import { buildDataset } from "/home/claude/rescript/packages/analytics/dist/dataset.js";
import { runPlan, compactRun } from "/home/claude/rescript/packages/analytics/dist/findings.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

/* the synthetic survey with a plan: a gender effect on satisfaction (and so on the items and NPS) is planted; region is not */
const FIXTURE = structuredClone(synthDef);
FIXTURE.meta = { ...FIXTURE.meta, id: "sandbox", code: "SANDBOX" };
FIXTURE.research = {
  objective: "What drives satisfaction", population: "adults",
  hypotheses: ["Women are more satisfied than men", "Satisfaction differs by region"],
  constructs: [{ name: "Satisfaction", role: "dependent", questionIds: ["q_sat"] }], analysis: [], assumptions: [], sources: [],
  analysisPlan: {
    crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: ["H1"], reason: "satisfaction by gender" }],
    tests: [
      { id: "t1", method: "t_test", outcome: "SAT", variables: ["SAT"], groupBy: "GENDER", priority: 1, hypotheses: ["H1"] },
      { id: "t2", method: "anova", outcome: "SAT", variables: ["SAT"], groupBy: "REGION", priority: 1, hypotheses: ["H2"] },
      { id: "t3", method: "anova", outcome: "NPS", variables: ["NPS"], groupBy: "COUNTRY", priority: 2, hypotheses: ["H2"] },
    ],
    derived: [], segments: [], source: "researcher",
  },
};
const ROWS = synthRows(400);
/* a run with the Phase 4 fields: on a small, skewed dataset so the data advice has something to say */
const ADVICE_ROWS = synthRows(44).map((r, i) => ({ ...r, answers: { ...r.answers, q_gender: i < 12 ? 1 : 2, q_sat: i < 12 ? (i === 0 ? 5 : 1) : 3 + (i % 3) } }));
const RUN = compactRun(runPlan(FIXTURE, synthDataset(400), { trigger: "halfway", now: "2026-10-09T09:00:00Z" }));
const ADVICE_RUN = compactRun(runPlan(FIXTURE, buildDataset(FIXTURE, ADVICE_ROWS, { spec }), { trigger: "first_results", now: "2026-10-09T10:00:00Z", discover: false }));
assert.ok(RUN.corrections && RUN.discoveries && RUN.discoveries.segments.length >= 2, "the run carries corrections and discoveries before the browser is opened");
assert.ok(ADVICE_RUN.advice?.some((a) => a.recommended?.test === "mann_whitney"), "the small skewed dataset draws a Mann–Whitney recommendation");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
page.on("dialog", (d) => d.accept());
const errors = [];
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|net::ERR|status of (404|501|502|402|409|401)/.test(m.text())) errors.push(m.text()); });

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
const intelligent = async () => {
  await openTab(page, "Questions");
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
};
const turns = () => page.$$('[data-testid="cp-turn"]');
const settled = async (n) => {
  await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 45000 });
  await page.waitForTimeout(300);
  return (await turns()).at(-1);
};
const say = async (text) => {
  const n = (await turns()).length;
  await page.fill('[data-testid="iq-input"]', text);
  await page.keyboard.press("Enter");
  return settled(n);
};
const textOf = async (h) => (await h.evaluate((e) => e.innerText)).replace(/\s+/g, " ");
const sectionsOf = (h) => h.$$eval('[data-testid="cp-engine-section"]', (es) => es.map((e) => [e.getAttribute("data-title"), [...e.querySelectorAll("li")].map((li) => li.textContent.replace(/\s+/g, " ").trim())]));
const apply = async () => { if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]'); await page.click('[data-testid="cp-panel-apply"]'); await page.waitForTimeout(500); };

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadDef(FIXTURE);
await intelligent();
if (!(await page.evaluate(() => typeof window.__rescriptCopilotFake === "function"))) { console.log("  skip  no fake copilot provider in this build"); await browser.close(); process.exit(0); }

/* ------------------------------------------------ 1. no respondents in the sandbox */
{
  const t = await say("Which groups consider Alpha?");
  assert.equal(await t.getAttribute("data-status"), "ready");
  const text = await textOf(t);
  assert.match(text, /The sandbox has no respondents to read\. Open a survey with fieldwork and ask there/);
  assert.equal(await (await t.$('[data-testid="cp-engine-detail"]')).getAttribute("data-kind"), "refused");
  assert.equal(await t.$('[data-testid="cp-data"]'), null, "nothing was read");
  ok("a data question with no respondents: said to be unanswerable here, with where to ask — no model, no guess");
}

/* ------------------------------------------------ 2. data questions answered on the rows */
await page.evaluate((rows) => window.__rescriptAnalyticsRows(rows), ROWS);
{
  const t = await say("Which groups consider Alpha?");
  const text = await textOf(t);
  assert.match(text, /78% of respondents chose “Alpha” \(Q7 — Brands considered, 242 of 311\)\. No group chooses it significantly more than the rest \(13 groups across 3 demographics, each against the rest, Holm-adjusted\)\./);
  const data = await t.$('[data-testid="cp-data"]');
  assert.ok(data, "the data line");
  assert.equal(await data.getAttribute("data-n"), "400");
  assert.equal(await data.getAttribute("data-source"), "sandbox");
  assert.match(await textOf(data), /Read from the data 400 sandbox respondents/i);
  const sections = await sectionsOf(t);
  assert.deepEqual(sections.map((s) => s[0]), ["“Alpha” by Gender", "“Alpha” by Region", "“Alpha” by Country"]);
  assert.match(sections[0][1][0], /^(?:Male|Female) — \d\d% \(\d+ of \d+\)$/);
  const det = await t.$eval('[data-testid="cp-detected"]', (e) => e.textContent.replace(/\s+/g, " "));
  assert.match(det, /question\s*Q7\s*option\s*Alpha/);
  ok("“which groups consider Alpha”: every demographic, each group against the rest, Holm-adjusted — the base, the sections, what the engine read");
}
{
  const t = await say("Does satisfaction differ by gender?");
  const text = await textOf(t);
  assert.match(text, /Yes — Q4 — Overall satisfaction differs by Gender: Female 3\.86 vs Male 3\.07 \(Welch's t-test, p < \.001, Cohen's d = -?1\.01 — a strong effect\)\./);
  assert.match(await textOf(await t.$('[data-testid="cp-data"]')), /t welch, p < \.001, Cohen's d = -?1\.01 — significant/);
  assert.equal(await t.$('[data-testid="cp-data-run"]'), null, "no run on the page yet");
  ok("“does satisfaction differ by gender”: yes, with the means, the test, the p and the effect");
}
{
  const t = await say("what is the average NPS among women");
  assert.match(await textOf(t), /The average Q5 — Recommend\? among Q1 \(GENDER\) = “Female” is 6\.89 \(median 7\.0, SD 1\.69, n = 208, 95% CI 6\.66–7\.12\)\./);
  assert.equal(await (await t.$('[data-testid="cp-data"]')).getAttribute("data-n"), "208", "the base is the population");
  ok("“the average NPS among women”: the population resolved to Q1 = Female, the mean with its interval on that base");
}
{
  const t = await say("which brand is most considered");
  assert.match(await textOf(t), /The most chosen answer to Q7 — Brands considered is “Alpha”: 78% \(242 of 311\), ahead of “Beta” at 47%\./);
  const t2 = await say("what share of men chose Beta in Q6");
  assert.match(await textOf(t2), /\d\d% of respondents among Q1 \(GENDER\) = “Male” chose “Beta” \(Q6 — Brands aware of, \d+ of \d+\), 95% CI \d\d%–\d\d%\./);
  const c = await say("which groups prefer Alpha");
  assert.equal(await (await c.$('[data-testid="cp-engine-detail"]')).getAttribute("data-kind"), "clarify");
  const choices = await c.$$eval('[data-testid="cp-engine-choice"] .iq-example-about', (es) => es.map((e) => e.textContent));
  assert.deepEqual(choices, ["which groups prefer Alpha in Q6", "which groups prefer Alpha in Q7"]);
  ok("the most common answer, a share of a population, and an option two questions share asked back as a choice");
}

/* ------------------------------------------------ 3. with a run on the page: the planned finding beside the live answer */
await page.evaluate((r) => window.__rescriptAnalysisRun(r), RUN);
{
  const t = await say("does satisfaction differ by gender");
  const fromRun = await t.$('[data-testid="cp-data-run"]');
  assert.ok(fromRun, "the planned finding on the same pair");
  assert.match(await textOf(fromRun), /In the plan's last run: Overall satisfaction (across|by) Gender.*\(run of 2026-10-09\)/);
  ok("with a run on the page, the planned finding on the same variables is shown beside the live answer");
}

/* ------------------------------------------------ 4. the plan by sentence */
{
  const t = await say("test whether NPS differs by region");
  assert.equal(await t.getAttribute("data-status"), "ready");
  assert.match(await textOf(t), /Plan an ANOVA of NPS \(Q5\) across REGION — NPS is interval and REGION has 3 groups\. It runs from the Analysis tab/);
  await apply();
  let d = await readDef();
  const anova = d.research.analysisPlan.tests.find((x) => x.method === "anova" && x.groupBy === "REGION" && x.outcome === "NPS");
  assert.ok(anova, "the ANOVA is in the plan");
  assert.deepEqual(anova.variables, ["NPS"]);
  await intelligent();
  const q = await say("what analyses are planned for satisfaction");
  assert.match(await textOf(q), /SAT \(Q4\) is read by 1 crosstab, 2 tests in the saved plan, serving H1, H2\./);
  const sections = await sectionsOf(q);
  assert.deepEqual(sections.map((s) => [s[0], s[1].length]), [["Crosstabs", 1], ["Tests", 2]]);
  const r = await say("remove the crosstab of satisfaction by gender");
  assert.match(await textOf(r), /Remove the crosstab SAT by GENDER \(H1\) from the analysis plan\./);
  assert.ok(await page.$('[data-testid="cp-destructive"]'), "a removal is confirmed");
  await apply();
  d = await readDef();
  assert.equal(d.research.analysisPlan.crosstabs.length, 0);
  assert.equal(d.research.analysisPlan.tests.length, 4);
  await intelligent();
  const again = await say("run a t-test of satisfaction by gender");
  assert.match(await textOf(again), /A t-test of SAT \(Q4\) across GENDER is already in the analysis plan \(H1\) — nothing to add\./);
  ok("tests planned, queried and removed by sentence — through the gate, applied, confirmed where destructive, a repeat said as nothing to add");
}

/* ------------------------------------------------ 5. the Findings tab on a run with the Phase 4 fields */
await page.evaluate((r) => window.__rescriptAnalysisRun(r), RUN);
await page.click('[data-testid="cp-tab-findings"]');
await page.waitForSelector('[data-testid="fd-verdict"]');
{
  assert.match(await page.textContent('[data-testid="fd-corrections"]'), /Holm correction over 2 tests for H1, 2 tests for H2: every significant finding holds\./);
  const adjusted = await page.$$eval('[data-testid="fd-adjusted"]', (es) => es.map((e) => [e.getAttribute("data-holds"), e.textContent.replace(/\s+/g, " ").trim()]));
  assert.ok(adjusted.length >= 3, `each corrected finding shows its adjusted p: ${adjusted.length}`);
  assert.ok(adjusted.some((a) => a[0] === "1" && /Holm-adjusted p < \.001/.test(a[1])), JSON.stringify(adjusted));
  const t3 = await page.$eval('[data-testid="fd-finding"]:has-text("Recommend? across Country")', (e) => e.textContent.replace(/\s+/g, " "));
  assert.match(t3, /Pairwise \(Holm-adjusted, 28 pairs\): UK > France/);
  assert.equal(await page.$('[data-testid="fd-advice"]'), null, "nothing to advise on the full dataset");
  assert.match(await page.textContent('[data-testid="fd-discoveries-summary"]'), /^Beyond the plan: \d segment differences the plan did not test \(\d+ outcome × cut pairs looked at, 3 waves; p-values Holm-adjusted\)\.$/);
  const disc = await page.$$eval('[data-testid="fd-discovery"]', (es) => es.map((e) => [e.getAttribute("data-kind"), e.textContent.replace(/\s+/g, " ").trim()]));
  assert.ok(disc.some((x) => x[0] === "segment" && /Recommend\? differs by Gender: Female highest/.test(x[1])), JSON.stringify(disc));
  assert.equal(await page.$('[data-testid="fd-corrected"]'), null, "no verdict changes under correction here");
  ok("Findings: the correction summary, each finding's adjusted p, the pairs behind a significant ANOVA, the discoveries beyond the plan");
}
await page.evaluate((r) => window.__rescriptAnalysisRun(r), ADVICE_RUN);
await page.waitForSelector('[data-testid="fd-advice"]');
{
  const items = await page.$$eval('[data-testid="fd-advice-item"]', (es) => es.map((e) => [e.getAttribute("data-planned"), e.getAttribute("data-recommended"), e.textContent.replace(/\s+/g, " ").trim()]));
  const t1 = items.find((x) => x[0] === "t1");
  assert.ok(t1, JSON.stringify(items));
  assert.equal(t1[1], "mann_whitney");
  assert.match(t1[2], /below 30 per group.*Recommended: Mann–Whitney — Overall satisfaction is skewed/);
  assert.equal(await page.$('[data-testid="fd-discoveries"]'), null, "this run looked at nothing beyond the plan");
  /* the first discovery can be put in the plan with one click — back on the full run */
  await page.evaluate((r) => window.__rescriptAnalysisRun(r), RUN);
  await page.waitForSelector('[data-testid="fd-plan-discovery"]');
  const n = (await turns()).length;
  await page.click('[data-testid="fd-plan-discovery"]');
  const t = await settled(n);
  assert.match(await textOf(t), /Plan a t-test of NPS \(Q5\) across GENDER — NPS is interval and GENDER has two groups/);
  ok("Findings: the data advice names the check and the method it recommends; a discovery goes into the plan with one click, through the engine");
}

/* ------------------------------------------------ 6. the ask route's gate */
{
  const q = { kind: "mean", variable: "SAT", question: "Q4", words: "" };
  let r = await page.evaluate(async (body) => { const x = await fetch("/api/copilot/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return [x.status, await x.json()]; }, { surveyId: "00000000-0000-0000-0000-000000000000", query: q });
  assert.equal(r[0], 401, "a real survey needs a session");
  r = await page.evaluate(async (body) => { const x = await fetch("/api/copilot/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return [x.status, await x.json()]; }, { surveyId: "sandbox", query: q, definition: FIXTURE, rows: [] });
  assert.equal(r[0], 409); assert.equal(r[1].code, "no_data");
  r = await page.evaluate(async (body) => { const x = await fetch("/api/copilot/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return [x.status, await x.json()]; }, { surveyId: "sandbox", query: { kind: "nope", variable: "SAT" }, definition: FIXTURE, rows: ROWS.slice(0, 5) });
  assert.equal(r[0], 400);
  r = await page.evaluate(async (body) => { const x = await fetch("/api/copilot/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return [x.status, await x.json()]; }, { surveyId: "sandbox", query: { ...q, population: { condition: { bogus: true }, expression: "x", words: "x" } }, definition: FIXTURE, rows: ROWS.slice(0, 5) });
  assert.equal(r[0], 400); assert.match(r[1].error, /population's condition does not parse/);
  ok("the ask route: a real survey needs a session, the sandbox needs rows, a malformed query or population is refused");
}

assert.deepEqual(errors, [], `console errors: ${errors.join("\n")}`);
await browser.close();
console.log(`\n${passed} passed`);
