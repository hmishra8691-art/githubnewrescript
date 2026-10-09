/**
 * RESEARCH ENGINE — PHASE 2 (NATURAL-LANGUAGE INTELLIGENCE), the Studio.
 *
 *   1. The audit's descriptive sentences are read by the engine, in the
 *      sandbox with no usable model: the screener exclusion, the scale
 *      change, the crosstab, the key crosstabs, the unconnected questions —
 *      each a proposal or an answer on an engine card, never "not understood".
 *   2. An ambiguity is a choice: two age questions → two sentences to pick.
 *   3. What needs the model but has no model: the engine's standard items
 *      are offered as executable choices — after the fake provider's unusable
 *      answer, and once the Studio knows there is no model at all.
 *   4. The change plan: a generation is planned first, the plan is shown,
 *      ticked and approved; the approved items are built one call each into
 *      one proposal; the built card lists them; setting a plan aside builds
 *      nothing. "Plan first" off: the single reply as before.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const opts = (...ls) => ls.map((l, i) => ({ code: i + 1, label: l }));
const q = (id, code, variableName, type, text, extra = {}) => ({ id, code, variableName, type, text, ...extra });
const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Brand switching", version: "1.0" },
  research: { objective: "Understand why customers switch from Brand A to Brand B", hypotheses: ["Price perception drives switching", "Service satisfaction reduces switching"], constructs: [{ name: "Price perception", role: "independent", questionIds: ["q6"] }], analysis: [], assumptions: [], sources: [] },
  questions: [
    q("q1", "Q1", "AGE", "numeric", "How old are you?"),
    q("q2", "Q2", "GENDER", "single_select", "What is your gender?", { options: opts("Male", "Female", "Prefer not to say") }),
    q("q3", "Q3", "BRAND_PREF", "single_select", "Which brand do you prefer?", { options: opts("Brand A", "Brand B", "Brand C"), analysis: { role: "dependent", hypotheses: ["H1"] } }),
    q("q4", "Q4", "SWITCHED", "single_select", "Have you switched brands in the last 12 months?", { options: opts("Yes", "No"), analysis: { role: "dependent", hypotheses: ["H1", "H2"] } }),
    q("q5", "Q5", "REASONS", "multi_select", "Why did you switch?", { options: opts("Price", "Quality", "Availability") }),
    q("q6", "Q6", "PRICE_PERC", "single_select", "Brand B offers better value for money", { options: opts("Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree") }),
    q("q7", "Q7", "SAT", "single_select", "Overall, how satisfied are you with your current brand?", { options: opts("1", "2", "3", "4", "5", "6", "7"), analysis: { role: "independent", hypotheses: ["H2"] } }),
    q("q8", "Q8", "PETS", "single_select", "Do you have pets?", { options: opts("Yes", "No") }),
    q("q9", "Q9", "REGION", "single_select", "Which region do you live in?", { options: opts("North", "South") }),
  ],
  flow: [
    { type: "block", id: "b1", title: "Screener", children: [{ type: "page", id: "p1", title: "Screener", questionIds: ["q1", "q2"] }] },
    { type: "block", id: "b2", title: "Brands", children: [{ type: "page", id: "p2", title: "Brands", questionIds: ["q3", "q4", "q5", "q6", "q7"] }] },
    { type: "block", id: "b3", title: "About you", children: [{ type: "page", id: "p3", title: "About you", questionIds: ["q8", "q9"] }] },
    { type: "end", id: "e1", status: "complete" },
  ],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
page.on("dialog", (d) => d.accept());
const errors = [];
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|net::ERR|status of (404|501|502|402)/.test(m.text())) errors.push(m.text()); });

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
  await intelligent();
  return JSON.parse(json);
};
const intelligent = async () => {
  await openTab(page, "Questions");
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
};
const fakeNext = (reply) => page.evaluate((r) => window.__rescriptCopilotFake(r), reply);
const turns = () => page.$$('[data-testid="cp-turn"]');
const settled = async (n) => {
  await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 45000 });
  await page.waitForTimeout(300);
  return (await turns()).at(-1);
};
const say = async (text, reply) => {
  if (reply) await fakeNext(reply);
  const n = (await turns()).length;
  await page.fill('[data-testid="iq-input"]', text);
  await page.keyboard.press("Enter");
  const last = await settled(n);
  if (await last.$('[data-testid="cp-engine"]')) await page.evaluate(() => window.__rescriptCopilotFakeReset?.());
  return last;
};
const textOf = async (h) => (await h.evaluate((e) => e.innerText)).replace(/\s+/g, " ");
const cancel = async () => { if (await page.$('[data-testid="cp-panel-cancel"]')) { await page.click('[data-testid="cp-panel-cancel"]'); await page.waitForTimeout(200); } };
const apply = async () => {
  // a change that removes or rewrites existing content is confirmed in the Changes panel first, like any proposal
  if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]');
  await page.click('[data-testid="cp-apply"]');
  await page.waitForTimeout(500);
};
const engineProposal = async (t, what) => {
  assert.ok(await t.$('[data-testid="cp-engine"]'), `${what}: read by the engine — ${(await textOf(t)).slice(0, 200)}`);
  assert.equal(await t.getAttribute("data-kind"), "proposal", what);
  assert.equal(await t.getAttribute("data-proposal"), "open", what);
};

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadDef(FIXTURE);
await intelligent();
ok("fixture loaded: the audit's brand-switching survey");

/* ============================================================ 1. the sentences, read by the engine */
{
  const t = await say("Change the screener so that respondents under 25 are excluded.");
  await engineProposal(t, "screener exclusion");
  const text = await textOf(t);
  assert.match(text, /Q1 \(AGE\) is where the survey learns it/);
  assert.match(text, /screen out when Q1 < 25/);
  assert.match(text, /respondents under 25 → Q1 \(AGE\) under 25/, "the population, as resolved");
  await apply();
  const def = await readDef();
  const q1 = def.questions.find((x) => x.id === "q1");
  assert.equal(q1.skipLogic.length, 1);
  assert.equal(q1.skipLogic[0].target.kind, "terminate");
  ok("“Change the screener so that respondents under 25 are excluded” → a screened terminate on Q1, applied");
}
{
  await page.click('[data-testid="cp-structure-pane"] [data-qid="q7"], [data-testid="cp-structure-pane"] [data-id="q7"]').catch(() => {});
  const t = await say("Change Q7 to a 5-point satisfaction scale");
  await engineProposal(t, "scale change");
  assert.match(await textOf(t), /Very dissatisfied · Dissatisfied · Neither satisfied nor dissatisfied · Satisfied · Very satisfied/);
  assert.match(await textOf(t), /replaces its 7 current options/);
  await apply();
  const def = await readDef();
  assert.deepEqual(def.questions.find((x) => x.id === "q7").options.map((o) => o.label), ["Very dissatisfied", "Dissatisfied", "Neither satisfied nor dissatisfied", "Satisfied", "Very satisfied"]);
  ok("“Change Q7 to a 5-point satisfaction scale” → the options replaced with the anchors, applied");
  const multi = await say("Change Q5 to a 5-point scale");
  assert.ok(await multi.$('[data-testid="cp-engine"]'));
  assert.match(await textOf(multi), /multi-select — each option is a separate answer/);
  assert.ok(await multi.$('[data-testid="cp-engine-fix"]'), "the fix is offered");
  ok("a multi-select has no scale: refused precisely, with the single-select conversion one click away");
}
{
  const t = await say("Create a cross-tab between age and brand preference.");
  await engineProposal(t, "crosstab");
  assert.match(await textOf(t), /BRAND_PREF \(Q3.*by AGE \(Q1/);
  assert.match(await textOf(t), /AGE goes in the banner as the demographic/);
  await apply();
  const def = await readDef();
  assert.equal(def.research.analysisPlan.crosstabs.length, 1);
  assert.deepEqual([def.research.analysisPlan.crosstabs[0].rows, def.research.analysisPlan.crosstabs[0].columns], [["BRAND_PREF"], ["AGE"]]);
  ok("“Create a cross-tab between age and brand preference” → add_crosstab, the demographic in the banner, applied to the plan");
  const key = await say("Create the most important crosstabs for this research");
  await engineProposal(key, "key crosstabs");
  assert.match(await textOf(key), /Hypothesis-linked tables come first/);
  await apply();
  const after = await readDef();
  assert.ok(after.research.analysisPlan.crosstabs.length >= 3, `planned: ${after.research.analysisPlan.crosstabs.length}`);
  ok("“Create the most important crosstabs for this research” → the framework's priorities planned");
}
{
  // on the fixture as it was: the crosstabs just planned connect the demographics, which is right, but not what this asks
  await loadDef(FIXTURE);
  await intelligent();
  const t = await say("Which questions are not connected to any hypothesis?");
  assert.ok(await t.$('[data-testid="cp-engine"]'));
  assert.equal(await t.getAttribute("data-kind"), "answer");
  const text = await textOf(t);
  assert.match(text, /not connected to any hypothesis, construct or planned analysis/);
  assert.match(text, /Q5/);
  assert.match(text, /Q8/);
  assert.match(text, /Demographics and screeners are expected here/);
  assert.ok((await t.$$('[data-testid="cp-engine-ref"]')).length >= 3, "each question a link");
  ok("“Which questions are not connected to any hypothesis?” → answered from the design, with navigable references");
}

/* ============================================================ 2. an ambiguity is a choice */
{
  const raw = JSON.parse(JSON.stringify(FIXTURE));
  raw.questions.push(q("q10", "Q10", "CHILD_AGE", "numeric", "How old is your eldest child?"));
  raw.flow[2].children[0].questionIds.push("q10");
  await loadDef(raw);
  await intelligent();
  const t = await say("Screen out respondents under 25");
  assert.ok(await t.$('[data-testid="cp-engine"]'));
  assert.equal(await t.getAttribute("data-kind"), "clarify");
  const choices = await t.$$('[data-testid="cp-engine-choice"]');
  assert.equal(choices.length, 2);
  assert.match(await textOf(t), /which question should the screener read/);
  const n = (await turns()).length;
  await choices[0].click();
  const picked = await settled(n);
  await engineProposal(picked, "the picked choice");
  assert.match(await textOf(picked), /Q1 < 25/);
  await cancel();
  ok("two age questions: the engine asks which, each choice a sentence it then reads to the rule");
}

/* ============================================================ 3. no model: what the engine can do instead */
{
  await loadDef(FIXTURE);
  await intelligent();
  // the fake provider answers with nothing usable: the failed turn carries the engine's standard items
  const t = await say("Add a question to measure purchase intent.");
  assert.equal(await t.getAttribute("data-status"), "failed");
  assert.equal(await t.$eval('[data-testid="cp-failure"]', (e) => e.getAttribute("data-code")), "unusable");
  const fb = await t.$('[data-testid="cp-fallback"]');
  assert.ok(fb, "what the engine can do without a model is offered on the failed turn");
  const fbChoices = await t.$$('[data-testid="cp-fallback-choice"]');
  assert.equal(fbChoices.length, 2);
  assert.match(await textOf(fb), /How likely are you to purchase Brand B in the next 3 months\?/i);
  const n = (await turns()).length;
  await fbChoices[0].click();
  const made = await settled(n);
  await engineProposal(made, "the standard item");
  await apply();
  const def = await readDef();
  const intent = def.questions.find((x) => /likely are you to purchase/.test(x.text));
  assert.ok(intent, "the question exists");
  assert.equal(intent.options.length, 5);
  assert.equal(intent.required, true);
  ok("“Add a question to measure purchase intent” with an unusable model answer: the engine's standard 5-point item is one click away, and applies");
  // the Studio learns there is no model at all: the next such sentence is an engine question with the choices, no model call
  await page.route("**/api/copilot/turn", (route) => route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ error: "No language model is configured on this Studio (AI_API_URL).", code: "ai_unconfigured", failure: { code: "not_configured", title: "NO LANGUAGE MODEL CONFIGURED", message: "This Studio has no language model configured, so only the engine's own reading is available.", next: ["Set AI_API_URL, AI_API_KEY and AI_MODEL on the server (see .env.example)."] } }) }));
  const first = await say("Make the questionnaire feel warmer.");
  assert.equal(await first.$eval('[data-testid="cp-failure"]', (e) => e.getAttribute("data-code")), "not_configured");
  await page.unroute("**/api/copilot/turn");
  let calls = 0;
  await page.route("**/api/copilot/turn", (route) => { calls++; return route.continue(); });
  const design = await say("Create a research design for understanding why customers are switching from Brand A to Brand B.");
  assert.ok(await design.$('[data-testid="cp-engine"]'), "an engine card, no model call");
  assert.equal(await design.getAttribute("data-kind"), "clarify");
  assert.equal(calls, 0, "the model was not asked");
  assert.match(await textOf(design), /No language model is configured on this Studio/);
  const rec = await design.$('[data-testid="cp-engine-choice"]');
  assert.match(await textOf(rec), /Record the objective/i);
  const n2 = (await turns()).length;
  await rec.click();
  const obj = await settled(n2);
  await engineProposal(obj, "the objective");
  assert.match(await textOf(obj), /Set the research objective to “Why customers are switching from Brand A to Brand B”/);
  await cancel();
  await page.unroute("**/api/copilot/turn");
  ok("with no model known: “Create a research design for …” is the engine's question with the step it can take, nothing sent to the model");
}

/* ============================================================ 4. the change plan */
await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
const EMPTY = { meta: { id: "sandbox", code: "S", title: "Skincare study", version: "1.0" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }] };
await loadDef(EMPTY);
await intelligent();
const PLAN = { kind: "plan", summary: "A four-block questionnaire that tests exposure → purchase intention, with the design recorded and the analysis planned.", items: [
  { id: "d", title: "Record the research design", kind: "design", objects: [], reason: "the hypothesis names exposure (IV) and purchase intention (DV)" },
  { id: "s", title: "Add the screener", kind: "create", objects: ["Screener"], reason: "the population is 18–35 buyers", detail: "age and a recent-purchase check, both terminating" },
  { id: "e", title: "Add the exposure block", kind: "create", objects: ["Exposure"], reason: "measures the independent variable" },
  { id: "a", title: "Plan the analysis", kind: "analysis", objects: [], reason: "PI by exposure, the regression" },
], questions: ["Which platforms matter most to you?"], assumptions: ["Online panel, 10 minutes"] };
const ITEM_D = { kind: "proposal", reply: "Recorded the objective and the hypothesis.", actions: [{ op: "set_research", objective: "Test whether social media exposure increases premium skincare purchase intention", hypotheses: ["More exposure → higher purchase intention"], population: "18–35" }] };
const ITEM_S = { kind: "proposal", reply: "Two screener questions, both terminating.", actions: [
  { op: "create_block", title: "Screener" },
  { op: "create_question", ref: "AGE", type: "numeric", text: "How old are you?", required: true },
  { op: "create_question", ref: "BUY", type: "yes_no", text: "Have you bought a skincare product in the last 6 months?", required: true },
  { op: "add_skip", from: "AGE", when: "AGE < 18 OR AGE > 35", to: "screen_out" },
] };
const ITEM_E = { kind: "proposal", reply: "The exposure grid.", actions: [
  { op: "create_block", title: "Exposure" },
  { op: "create_question", ref: "EXPOSE", type: "matrix", text: "How often do you see skincare content from each of these?", rows: ["Influencers", "Brands", "Friends"], scale: { points: 5, low: "Never", high: "Very often" } },
] };
{
  assert.equal(await page.$eval('[data-testid="iq-plan-first"] input', (e) => e.checked), true, "plan first is on by default");
  const t = await say("My hypothesis is that social media exposure increases the likelihood of purchasing premium skincare among 18–35s. Create a survey that tests it.", PLAN);
  assert.equal(await t.getAttribute("data-status"), "plan");
  assert.equal(await t.getAttribute("data-mode"), "generate");
  assert.match(await textOf(t), /CHANGE PLAN/);
  const items = await t.$$('[data-testid="cp-plan-item"]');
  assert.equal(items.length, 4);
  assert.deepEqual(await t.$$eval('[data-testid="cp-plan-item"] b', (bs) => bs.map((b) => b.textContent)), ["Record the research design", "Add the screener", "Add the exposure block", "Plan the analysis"]);
  assert.match(await textOf(t), /age and a recent-purchase check, both terminating/, "the item's detail");
  assert.match(await textOf(t), /Which platforms matter most to you\?/, "the copilot's question before building");
  assert.match(await textOf(t), /Online panel, 10 minutes/, "its assumption");
  assert.equal(await page.$('[data-testid="cp-apply"]'), null, "nothing to apply yet — no action has been written");
  assert.equal((await readDef()).questions.length, 0, "nothing was built");
  // (reading the JSON remounts the view: the plan card is still there, its state with it)
  const t2 = (await turns()).at(-1);
  assert.equal(await t2.getAttribute("data-status"), "plan", "the plan survives a tab change");
  // untick the analysis item, build the other three — one scripted reply per item
  await (await t2.$$('[data-testid="cp-plan-tick"]'))[3].click();
  assert.match(await t2.$eval('[data-testid="cp-plan-build"]', (b) => b.textContent), /Build 3 of 4/);
  await fakeNext([ITEM_D, ITEM_S, ITEM_E]);
  const n = (await turns()).length;
  await t2.$eval('[data-testid="cp-plan-build"]', (b) => b.click());
  await page.waitForFunction(() => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); const l = t[t.length - 1]; return l && l.getAttribute("data-status") !== "thinking" && l.getAttribute("data-status") !== "plan"; }, null, { timeout: 45000 });
  await page.waitForTimeout(300);
  const built = (await turns()).at(-1);
  assert.equal((await turns()).length, n, "the same card becomes the proposal");
  assert.equal(await built.getAttribute("data-status"), "ready");
  assert.equal(await built.getAttribute("data-kind"), "proposal");
  assert.equal(await built.getAttribute("data-proposal"), "open");
  assert.ok(await built.$('[data-testid="cp-plan-built"]'), "the card says what it was built from");
  assert.deepEqual(await built.$$eval('[data-testid="cp-plan-built-item"] b', (bs) => bs.map((b) => b.textContent)), ["Record the research design", "Add the screener", "Add the exposure block"]);
  assert.match(await textOf(built), /Record the research design: Recorded the objective and the hypothesis\. Add the screener: Two screener questions/);
  await apply();
  const def = await readDef();
  assert.equal(def.questions.length, 3, `built: ${def.questions.map((x) => x.code).join(",")}`);
  assert.equal(def.research.objective, "Test whether social media exposure increases premium skincare purchase intention");
  assert.ok(!def.research.analysisPlan, "the unticked item was not built");
  assert.equal(def.questions.find((x) => x.variableName === "AGE").skipLogic.length, 1);
  ok("plan first: the plan is shown with items, detail, questions and assumptions; 3 of 4 ticked and built one call each into one proposal; applied");
}
{
  const t = await say("Create a new survey from scratch about brand loyalty, with a loyalty block and a demographics block.", { kind: "plan", summary: "Two blocks.", items: [{ id: "l", title: "Add the loyalty block", kind: "create", reason: "H2" }, { id: "g", title: "Add demographics", kind: "create", reason: "cuts" }] });
  assert.equal(await t.getAttribute("data-status"), "plan");
  await t.$eval('[data-testid="cp-plan-cancel"]', (b) => b.click());
  await page.waitForTimeout(300);
  assert.equal(await t.getAttribute("data-status"), "empty");
  assert.match(await textOf(t), /Plan set aside — nothing was built/);
  assert.equal((await readDef()).questions.length, 3);
  ok("a plan set aside builds nothing");
  await page.evaluate(() => window.__rescriptCopilotFakeReset?.());
}
{
  // plan first off: the single reply, as before
  await page.click('[data-testid="iq-plan-first"] input');
  assert.equal(await page.$eval('[data-testid="iq-plan-first"] input', (e) => e.checked), false);
  const DIRECT = { kind: "proposal", reply: "One block.", plan: [{ block: "Trust", questions: 1 }], actions: [{ op: "create_block", title: "Trust" }, { op: "create_question", ref: "TRUST", type: "rating", text: "How much do you trust skincare recommendations from influencers?", scale: { points: 5, low: "Not at all", high: "Completely" } }] };
  const t = await say("My hypothesis is that trust mediates the effect. Create a new survey section that tests it.", DIRECT);
  assert.equal(await t.getAttribute("data-status"), "ready");
  assert.equal(await t.getAttribute("data-kind"), "proposal");
  assert.equal(await t.$('[data-testid="cp-change-plan"]'), null);
  await cancel();
  // …and a plan-shaped answer is then not a plan: with plan first off, the route never asks for one, so it is an answer with nothing in it
  const notPlanned = await say("Create a new survey from scratch about loyalty.", { kind: "plan", summary: "x", items: [{ id: "a", title: "Add a block", kind: "create", reason: "r" }] });
  assert.equal(await notPlanned.getAttribute("data-status"), "failed", "no plan stage when plan first is off");
  assert.equal(await notPlanned.$('[data-testid="cp-change-plan"]'), null);
  await page.evaluate(() => window.__rescriptCopilotFakeReset?.());
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".menubar");
  await intelligent();
  assert.equal(await page.$eval('[data-testid="iq-plan-first"] input', (e) => e.checked), false, "the preference is kept");
  await page.click('[data-testid="iq-plan-first"] input');
  ok("plan first off: the single-reply generation as before; the preference survives a reload");
}

assert.deepEqual(errors, [], `no console errors:\n${errors.join("\n")}`);
await browser.close();
console.log(`\n${passed} checks passed`);
