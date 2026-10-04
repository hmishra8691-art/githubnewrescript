/**
 * THE ANALYSIS FRAMEWORK, PLANNED BEFORE FIELDWORK (research-intelligence Phase 2).
 *
 *   - Properties → Analysis: a question's role and measurement are inferred
 *     and marked so; setting a field stores it; a reset returns to inference
 *   - Intelligent → Analysis: hypotheses with their coverage, the engine's
 *     proposed plan (unsaved), the most important crosstabs first; "Plan the
 *     analysis" is a proposal in Changes and Apply saves it as one undoable
 *     change; a planned crosstab is removed through the same confirmed path
 *   - the copilot's own analysis actions (through the fake provider) edit the
 *     plan and tag questions; a method the platform cannot run is refused
 *   - the delete dialog says what the analysis plan loses, and the plan is
 *     pruned on delete
 *   - the review reports a plan that no longer fits the survey
 *
 *   node scripts/analysis-framework-test.mjs      (studio on 3000)
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const scale = () => ["Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree"].map((l, i) => ({ code: i + 1, label: l }));
const opts = (...ls) => ls.map((l, i) => ({ code: i + 1, label: l }));
const rule = (ref, operator, value) => ({ type: "rule", source: { kind: "question", ref }, operator, value });

const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Brand choice", version: "1.0" },
  research: {
    objective: "Why consumers choose Brand A over Brand B",
    hypotheses: ["Brand trust increases purchase intention", "Advertising exposure raises awareness"],
    population: "US and UK adults 18–45",
    constructs: [
      { name: "Brand trust", role: "independent", questionIds: ["t1", "t2"] },
      { name: "Purchase intention", role: "dependent", questionIds: ["pi"] },
      { name: "Advertising exposure", role: "independent", questionIds: ["ad"] },
      { name: "Awareness", role: "dependent", questionIds: ["aware"] },
    ],
    analysis: [], assumptions: [], sources: [],
  },
  questions: [
    { id: "age", code: "S1", variableName: "AGE", type: "single_select", text: "How old are you?", options: opts("18–24", "25–34", "35–45", "46+"), skipLogic: [{ id: "sk", when: rule("AGE", "eq", 4), target: { kind: "terminate", status: "screened" } }] },
    { id: "gender", code: "S2", variableName: "GENDER", type: "single_select", text: "Gender", options: opts("Male", "Female", "Other") },
    { id: "country", code: "S3", variableName: "COUNTRY", type: "single_select", text: "Which country do you live in?", options: opts("US", "UK") },
    { id: "aware", code: "Q1", variableName: "AWARE", type: "multi_select", text: "Which brands have you heard of?", options: opts("Brand A", "Brand B", "Brand C") },
    { id: "ad", code: "Q2", variableName: "AD_EXPOSE", type: "single_select", text: "Seen advertising for Brand A recently?", options: opts("Yes", "No") },
    { id: "t1", code: "Q3", variableName: "TRUST_1", type: "single_select", text: "Brand A keeps its promises", options: scale() },
    { id: "t2", code: "Q4", variableName: "TRUST_2", type: "single_select", text: "Brand A is honest", options: scale() },
    { id: "pi", code: "Q5", variableName: "PURCHASE_INT", type: "single_select", text: "How likely are you to buy Brand A?", options: scale() },
    { id: "why", code: "Q6", variableName: "WHY", type: "long_text", text: "Why?" },
  ],
  flow: [
    { type: "block", id: "b0", title: "Screening", children: [{ type: "page", id: "p0", questionIds: ["age", "gender", "country"] }] },
    { type: "block", id: "b1", title: "Brand", children: [{ type: "page", id: "p1", questionIds: ["aware", "ad", "t1", "t2", "pi", "why"] }] },
    { type: "end", id: "e", status: "complete" },
  ],
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (d) => d.accept());

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
  const json = await page.$eval("textarea.code", (e) => e.value);
  return JSON.parse(json);
};
const q = (def, id) => def.questions.find((x) => x.id === id);
const selectQuestion = async (code) => {
  await openTab(page, "Questions");
  await page.waitForSelector(".qcard");
  for (const c of await page.$$(".qcard")) if ((await c.textContent()).includes(code)) { await c.click(); await page.waitForTimeout(300); return; }
  throw new Error(`no card for ${code}`);
};
const ensureSectionOpen = async (id) => {
  const head = `[data-testid="psec-head-${id}"]`;
  await page.waitForSelector(head);
  if ((await page.getAttribute(head, "aria-expanded")) !== "true") { await page.click(head); await page.waitForTimeout(150); }
};
const texts = (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadDef(FIXTURE);
ok("fixture loaded: a research design with two hypotheses and four constructs");

/* ------------------------------------------------ Properties → Analysis */
await selectQuestion("Q5");
await ensureSectionOpen("analysis");
await page.waitForSelector('[data-testid="qa-section"]');
assert.equal(await page.inputValue('[data-testid="qa-role"]'), "dependent", "the construct's role is inferred");
assert.ok(await page.$('[data-testid="qa-inferred-role"]'), "and marked as inferred");
assert.equal(await page.inputValue('[data-testid="qa-measurement"]'), "ordinal");
assert.equal(await page.inputValue('[data-testid="qa-construct"]'), "Purchase intention");
assert.ok(await page.$eval('[data-testid="qa-primary-top_box"]', (e) => e.classList.contains("on")), "an ordinal outcome is reported top-2-box");
assert.ok(await page.$eval('[data-testid="qa-crosstabBy-S2"]', (e) => e.classList.contains("on")), "tabulated by the demographics");
assert.ok(!(await page.$eval('[data-testid="qa-crosstabBy-S1"]', (e) => e.classList.contains("on"))), "not by the screener");
assert.ok(await page.isChecked('[data-testid="qa-hyp-H1"]') && !(await page.isChecked('[data-testid="qa-hyp-H2"]')), "H1 names its construct");
assert.equal(q(await readDef(), "pi").analysis, undefined, "inference stores nothing");
await selectQuestion("Q5");
await ensureSectionOpen("analysis");
await page.click('[data-testid="qa-crosstabBy-S1"]');
await page.waitForTimeout(200);
await page.click('[data-testid="qa-hyp-H2"]');
await page.waitForTimeout(300);
let a = q(await readDef(), "pi").analysis;
assert.deepEqual(a.crosstabBy, ["GENDER", "COUNTRY", "AGE"], "set: the inferred list plus the one clicked, as variable names");
assert.deepEqual(a.hypotheses, ["H1", "H2"]);
assert.equal(a.role, undefined, "untouched fields stay inferred");
await selectQuestion("Q5");
await ensureSectionOpen("analysis");
assert.ok(await page.$('[data-testid="qa-reset-crosstabBy"]'), "a set field offers a reset");
await page.click('[data-testid="qa-reset-crosstabBy"]');
await page.waitForTimeout(300);
a = q(await readDef(), "pi").analysis;
assert.deepEqual(a.crosstabBy, []);
assert.deepEqual(a.hypotheses, ["H1", "H2"]);
ok("Properties → Analysis: inferred role, measurement, reporting and crosstabs; set fields stored by variable, reset returns to inference");

/* ------------------------------------------------ Intelligent → Analysis */
await openTab(page, "Questions");
await switchMode(page, "intelligent");
await page.waitForSelector('[data-testid="intelligent-view"]');
await page.click('[data-testid="cp-tab-analysis"]');
await page.waitForSelector('[data-testid="cp-analysis"]');
assert.ok(await page.$('[data-testid="an-unsaved"]'), "no plan saved: the engine's proposal is shown");
const hyps = await page.$$('[data-testid="an-hyp"]');
assert.equal(hyps.length, 2);
assert.equal(await hyps[0].getAttribute("data-status"), "partly", "measured, nothing planned yet");
const rows = await page.$$eval('[data-testid="an-crosstab"]', (es) => es.map((e) => ({ p: e.getAttribute("data-priority"), t: e.textContent })));
assert.ok(rows.length >= 2 && rows[0].p === "1" && /Q5/.test(rows[0].t), `the most important crosstab first: ${JSON.stringify(rows[0])}`);
assert.ok(await page.$('[data-testid="an-test"][data-method="regression"]'), "a regression on the outcome is planned");
assert.ok(await page.$('[data-testid="an-test"][data-method="chi_square"]'), "awareness by exposure is a chi-square");
assert.ok(await page.$('[data-testid="an-test"][data-method="reliability"]'), "two trust items → reliability");
assert.equal((await page.$$('[data-testid="an-crosstab-remove"]')).length, 0, "nothing to remove from a plan that is not saved");
await page.click('[data-testid="an-propose"]');
await page.waitForSelector('[data-testid="cp-changes"]');
{ const sm = await texts('[data-testid="cp-summary"] li'); assert.ok(sm.some((t) => /Plan the analysis: \d+ crosstabs?, \d+ tests?/.test(t)), `the proposal is the plan: ${sm.join(" | ")}`); }
assert.equal(await page.$('[data-testid="cp-destructive"]'), null, "planning anew is not destructive");
await page.click('[data-testid="cp-panel-apply"]');
await page.waitForTimeout(600);
let def = await readDef();
const plan = def.research.analysisPlan;
assert.equal(plan.source, "engine");
assert.ok(plan.crosstabs.length >= 2 && plan.tests.length >= 4);
assert.ok(plan.crosstabs.every((x) => x.id && x.rows.length && x.columns.length));
ok("Intelligent → Analysis: the engine's framework, hypothesis coverage, important crosstabs first; Plan → Changes → Apply saves it");

await openTab(page, "Questions");
await page.waitForSelector('[data-testid="intelligent-view"]');
await page.click('[data-testid="cp-tab-analysis"]');
await page.waitForSelector('[data-testid="cp-analysis"]');
assert.equal(await page.$('[data-testid="an-unsaved"]'), null);
assert.equal(await page.$$eval('[data-testid="an-hyp"]', (es) => es.map((e) => e.getAttribute("data-status")).join()), "testable,testable", "with the plan saved every hypothesis is testable");
const nx = plan.crosstabs.length;
await page.click('[data-testid="an-crosstab-remove"] >> nth=0');
await page.waitForSelector('[data-testid="cp-destructive"]');
await page.check('[data-testid="cp-confirm"]');
await page.click('[data-testid="cp-panel-apply"]');
await page.waitForTimeout(500);
def = await readDef();
assert.equal(def.research.analysisPlan.crosstabs.length, nx - 1, "one planned crosstab fewer");
ok("a planned crosstab is removed through the confirmed proposal path");

/* ------------------------------------------------ the copilot's own actions (fake provider) */
await openTab(page, "Questions");
await page.waitForSelector('[data-testid="intelligent-view"]');
const fake = await page.evaluate(() => typeof window.__rescriptCopilotFake === "function");
if (fake) {
  await page.evaluate((r) => window.__rescriptCopilotFake(r), {
    kind: "proposal", reply: "I'll tag Q2 as the exposure predictor, add the country banner for intent and a chi-square for H2 — and the Bayesian network the platform does not run.",
    actions: [
      { op: "set_question_analysis", target: "Q2", role: "independent", hypotheses: ["H2"], crosstabBy: ["S3"] },
      { op: "add_crosstab", rows: ["Q5"], columns: ["S3"], priority: 1, hypotheses: ["H1"], reason: "intent by market" },
      { op: "add_analysis_test", method: "bayesian_network", outcome: "Q5" },
      { op: "add_analysis_test", method: "anova", outcome: "Q5", groupBy: "S1", reason: "intent across age" },
    ],
  });
  const n = (await page.$$('[data-testid="cp-turn"]')).length;
  await page.fill('[data-testid="iq-input"]', "Add a crosstab of purchase intent by country and test intent across age groups");
  await page.keyboard.press("Enter");
  await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 30000 });
  await page.click('[data-testid="cp-tab-changes"]');
  await page.waitForSelector('[data-testid="cp-changes"]');
  const summary = await texts('[data-testid="cp-summary"] li');
  assert.ok(summary.some((t) => /Plan crosstab: PURCHASE_INT by COUNTRY/.test(t)), summary.join(" | "));
  assert.ok(summary.some((t) => /Plan anova on PURCHASE_INT across AGE/.test(t)), summary.join(" | "));
  assert.ok(summary.some((t) => /Change Q2: analysis/.test(t)), summary.join(" | "));
  const refused = await page.$('[data-testid="cp-rejected"]');
  assert.ok(refused, "the method the platform does not run is refused, visibly");
  assert.match(await refused.textContent(), /bayesian_network” is not an analysis method the platform runs/);
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(500);
  def = await readDef();
  assert.ok(def.research.analysisPlan.crosstabs.some((x) => x.reason === "intent by market" && x.columns[0] === "COUNTRY" && x.hypotheses[0] === "H1"));
  assert.ok(def.research.analysisPlan.tests.some((t) => t.method === "anova" && t.groupBy === "AGE"));
  assert.deepEqual(q(def, "ad").analysis.crosstabBy, ["COUNTRY"]);
  assert.deepEqual(q(def, "ad").analysis.hypotheses, ["H2"]);
  ok("the copilot's analysis actions edit the plan and tag questions; an unknown method is refused with its reason");
} else console.log("  skip  no fake copilot provider in this build");

/* ------------------------------------------------ delete: the dialog says what the analysis loses, and the plan is pruned */
await switchMode(page, "studio");
await openTab(page, "Questions");
await page.waitForSelector(".qcard");
for (const c of await page.$$(".qcard")) if ((await c.textContent()).includes("Q5")) { await c.hover(); await (await c.$('[data-testid="delete-question"]')).click(); break; }
await page.waitForSelector('[data-testid="delete-question-dialog"]');
const dlg = await page.textContent('[data-testid="delete-question-dialog"]');
assert.match(dlg, /Analysis plan — (?:crosstab|regression|correlation|anova)/, dlg.slice(0, 400));
assert.match(dlg, /construct “Purchase intention”/);
await page.click('[data-testid="delete-question-confirm"]');
await page.waitForTimeout(500);
def = await readDef();
assert.ok(!q(def, "pi"));
const p2 = def.research.analysisPlan;
assert.ok(!JSON.stringify(p2).includes("PURCHASE_INT"), "nothing in the plan still names the deleted question");
assert.ok(p2.tests.some((t) => t.method === "reliability"), "the trust reliability stays");
assert.ok(p2.tests.some((t) => t.method === "chi_square"), "awareness by exposure stays");
ok("deleting a question lists what the analysis plan loses, and the plan is pruned with it");

/* ------------------------------------------------ the review reports a plan that no longer fits */
def.research.analysisPlan.crosstabs.push({ id: "xt_dead", rows: ["AWARE"], columns: ["REGION"], priority: 1, hypotheses: [] });
def.research.analysisPlan.tests.push({ id: "t_bad", method: "t_test", outcome: "TRUST_1", variables: [], groupBy: "GENDER", priority: 1, hypotheses: [] });
await loadDef(def);
await openTab(page, "Questions");
await switchMode(page, "intelligent");
await page.waitForSelector('[data-testid="intelligent-view"]');
await page.click('[data-testid="cp-tab-analysis"]');
await page.waitForSelector('[data-testid="an-issues"]');
const issues = await texts('[data-testid="an-issue"]');
assert.ok(issues.some((t) => /critical.*REGION, which is not in the survey/.test(t)), issues.join(" | "));
assert.ok(issues.some((t) => /t-test compares two groups, but S2 has 3/.test(t)));
await page.click('[data-testid="cp-tab-review"]');
await page.click('[data-testid="cp-run-review"]');
await page.waitForTimeout(800);
const review = await page.textContent('[data-testid="cp-panel"]');
assert.match(review, /REGION, which is not in the survey/);
ok("the review reports dead references and a test on the wrong number of groups");

assert.deepEqual(errors.filter((e) => !/ResizeObserver/.test(e)), [], errors.join("\n"));
await browser.close();
console.log(`\n${passed} checks passed`);
