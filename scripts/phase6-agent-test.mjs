/**
 * RESEARCH ENGINE — PHASE 6 (the research agent), in the browser.
 *
 *   - "start the research workflow for <objective>" → the card says where
 *     the study stands, the Workflow tab opens on the twelve steps
 *   - the objective step: the engine's action, approved in Changes, and the
 *     step is done at once; the assumptions read from the objective
 *   - the hypotheses step: the model's (cloud), priced; in INTERNAL mode the
 *     model is not called — a model turn gets the internal-mode card, a
 *     sentence with an engine alternative gets the alternative, and the
 *     step asks the researcher instead; "cloud once" lets one call through
 *   - the framework from the hypotheses, each construct with the questions
 *     that measure it; the questionnaire's standard item; the plan; the
 *     KPIs; the design document produced from the tab; the structure
 *   - History: each step recorded with its workflow step, rolled back as
 *     any other change
 *   - the workflow route's gate and shape
 *
 *   node scripts/phase6-agent-test.mjs      (studio on 3000, fake AI provider)
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const opts = (...ls) => ls.map((l, i) => ({ code: i + 1, label: l }));
const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Brand switching" },
  questions: [
    { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
    { id: "q2", code: "Q2", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female") },
    { id: "q4", code: "Q4", variableName: "SWITCHED", type: "single_select", text: "Have you switched brands in the last 12 months?", options: opts("Yes", "No") },
    { id: "q6", code: "Q6", variableName: "PRICE_PERC", type: "single_select", text: "Brand B offers better value for money", options: opts("Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree") },
    { id: "q7", code: "Q7", variableName: "SAT", type: "single_select", text: "Overall, how satisfied are you with your current brand?", options: opts("1", "2", "3", "4", "5", "6", "7") },
    { id: "q9", code: "Q9", variableName: "REGION", type: "single_select", text: "Which region do you live in?", options: opts("North", "South", "East") },
  ],
  flow: [
    { type: "block", id: "b1", title: "Screener", children: [{ type: "page", id: "p1", title: "Screener", questionIds: ["q1", "q2"] }] },
    { type: "block", id: "b2", title: "Brands", children: [{ type: "page", id: "p2", title: "Brands", questionIds: ["q4", "q6", "q9", "q7"] }] },
    { type: "block", id: "b3", title: "About you", children: [{ type: "page", id: "p3", title: "About you", questionIds: [] }] },
    { type: "end", id: "e", status: "complete" },
  ],
};
const OBJECTIVE = "Understand why UK adults who bought a car switch from Brand A to Brand B";

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
const apply = async () => { if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]'); await page.click('[data-testid="cp-apply"]'); await page.waitForTimeout(600); };
const tab = async (id) => { await page.click(`[data-testid="cp-tab-${id}"]`); await page.waitForTimeout(150); };
const status = (id) => page.getAttribute(`[data-testid="wf-step-${id}"]`, "data-status");
const why = (id) => page.textContent(`[data-testid="wf-why-${id}"]`);
const doStep = async (id) => { await tab("workflow"); const n = (await turns()).length; await page.click(`[data-testid="wf-do-${id}"]`); return settled(n); };
const stepDone = async (id) => { await tab("workflow"); await page.waitForFunction((k) => document.querySelector(`[data-testid="wf-step-${k}"]`)?.getAttribute("data-status") === "done", id, { timeout: 10000 }); };

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await page.evaluate(() => { try { window.localStorage.setItem("rescript.copilot.mode", "cloud"); } catch {} });
await loadDef(FIXTURE);
await intelligent();
if (!(await page.evaluate(() => typeof window.__rescriptCopilotFake === "function"))) { console.log("  skip  no fake copilot provider in this build"); await browser.close(); process.exit(0); }

/* ------------------------------------------------ 1. the workflow from a sentence */
{
  const t = await say(`start the research workflow for ${OBJECTIVE}`);
  assert.equal(await t.getAttribute("data-status"), "ready");
  const text = await textOf(t);
  assert.match(text, /0 of 12 steps done — next: Objective \(the engine has 1 action ready\)/);
  assert.match(text, /→ Objective — Record the objective "Understand why UK adults/);
  assert.match(text, /· Structured hypotheses — The hypotheses state what the objective expects\./);
  assert.match(text, /Execution: cloud/);
  await page.waitForSelector('[data-testid="cp-workflow"]');
  assert.equal(await page.getAttribute('[data-testid="cp-panel"]', "data-tab"), "workflow");
  assert.equal(await page.getAttribute('[data-testid="cp-workflow"]', "data-next"), "objective");
  assert.equal(await status("objective"), "ready");
  assert.equal(await status("assumptions"), "blocked");
  assert.match(await page.textContent('[data-testid="wf-summary"]'), /Objective to record: “Understand why UK adults/);
  assert.equal((await page.$$('[data-testid^="wf-step-"]')).length, 12);
  ok("“start the research workflow for …”: the card says where the study stands, the Workflow tab opens on the twelve steps with the objective to record");
}

/* ------------------------------------------------ 2. the objective and the assumptions: engine steps, approved in Changes */
{
  const t = await doStep("objective");
  assert.equal(await t.getAttribute("data-status"), "ready");
  assert.equal(await page.getAttribute('[data-testid="cp-panel"]', "data-tab"), "changes");
  assert.match(await textOf(t), /Objective: Record the objective/);
  await apply();
  await stepDone("objective");
  assert.match(await why("objective"), /The objective is recorded/);
  assert.equal(await status("assumptions"), "ready");
  assert.match(await why("assumptions"), /the population "UK adults who bought a car" read from the objective, as assumptions to confirm; it still needs which methodology and how many completes are planned/);
  // the questions the researcher must answer, each with a sentence that goes to the box
  const examples = await page.$$('[data-testid="wf-questions-assumptions"] [data-testid="wf-example"]');
  assert.equal(examples.length, 2);
  await examples[1].click();
  assert.equal(await page.inputValue('[data-testid="iq-input"]'), "Set the sample size to 400");
  await page.fill('[data-testid="iq-input"]', "");
  const t2 = await doStep("assumptions");
  await apply();
  void t2;
  await tab("workflow");
  assert.equal(await status("assumptions"), "needs_input");
  assert.equal(await status("hypotheses"), "model");
  assert.equal(await page.getAttribute('[data-testid="cp-workflow"]', "data-next"), "assumptions");
  ok("the objective step applied through Changes is done at once; the assumptions read from the objective are recorded, what is left is asked with a sentence to finish");
}

/* ------------------------------------------------ 3. the model step, priced; internal mode */
{
  await tab("workflow");
  assert.match(await page.textContent('[data-testid="wf-cost"]'), /Model steps from here: structured hypotheses \(drafting call, fake|gpt|[\w.-]+, ~[\d.]+ credits\) — about [\d.]+ credits in all, each approved before it is made\./);
  const ask = await page.$('[data-testid="wf-ask-hypotheses"]');
  assert.ok(ask, "the model step has its button");
  assert.match(await ask.textContent(), /Ask the model \(~[\d.]+ credits/);
  // internal: nothing is sent to a model
  await page.click('[data-testid="wf-mode-internal"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="cp-workflow"]')?.getAttribute("data-mode") === "internal");
  assert.equal(await status("hypotheses"), "needs_input");
  assert.match(await why("hypotheses"), /internal mode calls no model to draft them/);
  assert.match(await page.textContent('[data-testid="wf-cost"]'), /In internal mode the model is not called: one step is yours to answer instead\./);
  assert.equal(await page.getAttribute('[data-testid="wf-ask-hypotheses"]', "disabled"), "", "the model button is disabled in internal mode");
  // a model sentence is refused with the cause and the switch, nothing charged
  let t = await say("rewrite every question in a friendlier tone", { kind: "proposal", reply: "Rewritten.", actions: [{ op: "update_question", target: "Q1", text: "How old are you, friend?" }] });
  assert.equal(await t.getAttribute("data-status"), "failed");
  assert.equal(await (await t.$('[data-testid="cp-failure"]')).getAttribute("data-code"), "internal_mode");
  assert.match(await textOf(t), /INTERNAL MODE — NO MODEL CALLED/);
  assert.match(await textOf(t), /Switch the project to cloud execution in the Workflow tab/);
  await page.evaluate(() => window.__rescriptCopilotFakeReset?.());
  // a sentence with an engine alternative gets the alternative
  t = await say("add a question to measure purchase intent");
  assert.equal(await t.getAttribute("data-status"), "ready");
  assert.match(await textOf(t), /This project runs in internal mode — nothing is sent to a language model \(switch to cloud in the Workflow tab\), so the copilot cannot write this\./);
  assert.ok(await t.$('[data-testid="cp-engine-choice"]'), "the standard items offered");
  // cloud once: the next model step goes through
  await tab("workflow");
  await page.check('[data-testid="wf-once-box"]');
  assert.equal(await status("hypotheses"), "needs_input");
  assert.equal(await page.getAttribute('[data-testid="wf-ask-hypotheses"]', "disabled"), null, "let through once: the step's model button works");
  const n = (await turns()).length;
  await page.evaluate((r) => window.__rescriptCopilotFake(r), { kind: "proposal", reply: "Two hypotheses.", actions: [{ op: "add_hypothesis", text: "Price perception drives switching" }, { op: "add_hypothesis", text: "Women are more satisfied than men" }] });
  await page.click('[data-testid="wf-ask-hypotheses"]');
  t = await settled(n);
  assert.equal(await page.isChecked('[data-testid="wf-once-box"]').catch(() => false), false, "used up");
  await page.evaluate(() => window.__rescriptCopilotFakeReset?.());
  assert.equal(await t.getAttribute("data-status"), "ready");
  assert.match(await textOf(t), /Two hypotheses/);
  await apply();
  await tab("workflow");
  assert.equal(await status("hypotheses"), "ready", "the readings parsed from the words are the engine's");
  assert.match(await why("hypotheses"), /H1 and H2 read from the words/);
  // and the next model turn is refused again
  t = await say("rewrite every question in a friendlier tone", { kind: "proposal", reply: "Rewritten.", actions: [] });
  assert.equal(await t.getAttribute("data-status"), "failed");
  await page.evaluate(() => window.__rescriptCopilotFakeReset?.());
  await tab("workflow");
  await page.click('[data-testid="wf-mode-cloud"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="cp-workflow"]')?.getAttribute("data-mode") === "cloud");
  ok("the model step is priced before any call; internal mode calls no model — a model turn says so with the switch, an engine alternative is offered, the step asks the researcher; cloud-once lets one call through");
}

/* ------------------------------------------------ 4. the engine's steps to the design document */
{
  await doStep("hypotheses"); await apply(); await stepDone("hypotheses");
  await tab("workflow");
  assert.equal(await status("framework"), "ready");
  assert.match(await why("framework"), /Price perception \(independent, measured by Q6\), Switching \(dependent, measured by Q4\), Gender \(independent, measured by Q2\), Satisfaction \(dependent, measured by Q7\)/);
  await doStep("framework"); await apply(); await stepDone("framework");
  await tab("workflow");
  assert.equal(await status("questionnaire"), "done");
  assert.equal(await status("variables"), "done");
  assert.equal(await status("analysis_plan"), "ready");
  await doStep("analysis_plan"); await apply(); await stepDone("analysis_plan");
  await tab("workflow");
  assert.match(await why("analysis_plan"), /The plan holds \d+ crosstabs?, \d+ tests?/);
  assert.equal(await status("recommendations"), "done");
  assert.equal(await status("reporting_framework"), "ready");
  await doStep("reporting_framework"); await apply(); await stepDone("reporting_framework");
  await tab("workflow");
  assert.match(await why("reporting_framework"), /2 KPIs recorded \(Switching, Satisfaction\)/);
  // the design document from the tab: the file on the card, the step done
  assert.equal(await status("design_document"), "ready");
  const t = await doStep("design_document");
  assert.match(await textOf(t), /The research proposal \(Word\) is ready: .*-research-proposal\.docx/);
  await stepDone("design_document");
  assert.match(await why("design_document"), /The research proposal was produced this session/);
  // the structure: REGION to the closing block
  assert.equal(await status("survey_structure"), "ready");
  assert.match(await why("survey_structure"), /Q9 \(REGION\) is a demographic asked mid-survey/);
  await doStep("survey_structure"); await apply(); await stepDone("survey_structure");
  await tab("workflow");
  assert.equal(await status("deck"), "blocked");
  assert.match(await why("deck"), /After fieldwork/);
  assert.match(await page.textContent('[data-testid="wf-summary"]'), /^10 of 12 steps done — next: Assumptions \(you are asked\)/, "the assumptions still want the methodology and the sample size; the deck waits for fieldwork");
  ok("framework, plan, KPIs, design document and structure: each step the engine's, approved in Changes, done at once; the deck waits for fieldwork");
}

/* ------------------------------------------------ 5. History: each step recorded with its workflow step, rolled back like any change */
{
  await tab("history");
  const ops = await page.$$('[data-testid="cp-change"]');
  assert.ok(ops.length >= 6, `${ops.length} changes`);
  await ops[0].$eval('[data-testid="cp-op-expand"]', (b) => b.click());
  await page.waitForSelector('[data-testid="cp-op-intent"]');
  assert.match(await page.textContent('[data-testid="cp-op-intent"]'), /workflow: survey_structure/);
  await page.click('[data-testid="cp-undo-change"]');
  await page.waitForTimeout(600);
  await tab("workflow");
  assert.equal(await status("survey_structure"), "ready", "rolled back: the step is to do again");
  ok("History records each step with its workflow step; a step rolls back like any other change and the workflow says so");
}

/* ------------------------------------------------ 6. the workflow route */
{
  const post = (body) => page.evaluate(async (b) => { const x = await fetch("/api/copilot/workflow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return [x.status, await x.json()]; }, body);
  let r = await post({ surveyId: "00000000-0000-0000-0000-000000000000" });
  assert.equal(r[0], 401, "a real survey needs a session");
  r = await post({ surveyId: "sandbox" });
  assert.equal(r[0], 400);
  r = await post({ surveyId: "sandbox", definition: FIXTURE, setMode: "nope" });
  assert.equal(r[0], 400);
  r = await post({ surveyId: "sandbox", definition: FIXTURE, objective: OBJECTIVE, mode: "internal" });
  assert.equal(r[0], 200);
  assert.equal(r[1].workflow.total, 12);
  assert.equal(r[1].workflow.next.id, "objective");
  assert.deepEqual(r[1].workflow.next.actions, [{ op: "set_research", objective: OBJECTIVE }]);
  assert.deepEqual(r[1].mode, { project: "cloud", effective: "internal", override: true, sandbox: true }, "the request's mode overrides the project's for this reading");
  assert.equal(r[1].model.configured, true);
  assert.equal(r[1].runAvailable, false);
  const withHyp = { ...FIXTURE, research: { objective: OBJECTIVE, population: "UK adults", methodology: "Online panel", sampleSize: 300, hypotheses: [], constructs: [], analysis: [], assumptions: [], sources: [] } };
  r = await post({ surveyId: "sandbox", definition: withHyp, runAvailable: true });
  assert.equal(r[0], 200);
  assert.deepEqual(r[1].mode, { project: "cloud", effective: "cloud", override: false, sandbox: true });
  assert.deepEqual(r[1].cost.steps.map((c) => [c.id, c.tier]), [["hypotheses", "large"]]);
  assert.ok(typeof r[1].cost.steps[0].charge === "number" && r[1].cost.steps[0].model.length > 0);
  assert.equal(r[1].cost.total, r[1].cost.steps[0].charge, "the cloud steps' total");
  assert.equal(r[1].runAvailable, true);
  // the same survey read in internal mode: the step is priced for information, nothing is in the total
  r = await post({ surveyId: "sandbox", definition: withHyp, mode: "internal" });
  assert.equal(r[0], 200);
  assert.equal(r[1].workflow.steps.find((x) => x.id === "hypotheses").status, "needs_input");
  assert.deepEqual(r[1].cost.steps.map((c) => c.id), ["hypotheses"]);
  assert.equal(r[1].cost.total, 0, "nothing priced into the total in internal mode");
  // setMode confirms the sandbox's own choice
  r = await post({ surveyId: "sandbox", definition: withHyp, setMode: "internal" });
  assert.deepEqual(r[1].mode, { project: "internal", effective: "internal", override: false, sandbox: true });
  ok("the workflow route: a session for a real survey, a definition for the sandbox, a known mode; the steps, the effective mode, the priced model steps, the data");
}

assert.deepEqual(errors, [], `console errors: ${errors.join("\n")}`);
await browser.close();
console.log(`\n${passed} passed`);
