/**
 * INTELLIGENT ENGINE RELIABILITY (2026-10-17) — the production failures of the
 * last three weeks, reproduced in the browser against the Studio dev server
 * with AI_API_URL=fake: (the stand-in model is `window.__rescriptCopilotFake`,
 * scripted provider failures `window.__rescriptCopilotFault`):
 *
 *   [1] a ~24k-character pasted brief → a reviewable plan WITH assumptions (the
 *       stand-in first answers with questions, as the real model did; the route
 *       asks once more for the plan) — never a questionnaire back
 *   [2] staged generation: one item per request, progress on the card, the
 *       draft applied ONCE (a double click applies nothing twice)
 *   [3] a provider timeout mid-stage: the built stages are kept, the failed
 *       stage is retried, nothing is built twice; a provider that keeps timing
 *       out stops with Resume, and Resume finishes it
 *   [4] unsupported: the exact sentence, no model call, no charge (and the
 *       route says the same to any caller)
 *   [5] mixed: the supported part is proposed, the rest is named as outside
 *   [6] the multi-turn chain: each turn's request carries what the turn
 *       before created; no localized edit goes to plan-first generation
 *   [7] a build whose items come back empty never says it succeeded
 *
 *   node scripts/intelligent-engine-test.mjs      (Studio on :3000, AI_API_URL=fake:)
 */
import { chromium } from "./lib/playwright.mjs";
import assert from "node:assert/strict";
import { openTab, switchMode } from "./lib/nav.mjs";
import { MASTER_PROMPT_BRIEF } from "../apps/studio/lib/copilot/fixtures/masterPromptBrief.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const UNSUPPORTED = "This request is outside the supported capabilities of Intelligent Mode. You can use this engine for research planning, hypothesis development, survey design and programming, supported analysis, data-quality workflows, translation, and research reporting.";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1700, height: 1150 } });
page.on("dialog", (d) => d.accept());
const errors = [];
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|net::ERR|status of (402|404|413|501|502|503|504)/.test(m.text())) errors.push(m.text()); });
const turnRequests = [];
const turnResponses = [];
page.on("request", (r) => { if (r.url().endsWith("/api/copilot/turn") && r.method() === "POST") { try { turnRequests.push(JSON.parse(r.postData() ?? "{}")); } catch { turnRequests.push({}); } } });
page.on("response", async (r) => { if (r.url().endsWith("/api/copilot/turn") && r.request().method() === "POST") { try { turnResponses.push(await r.json()); } catch { turnResponses.push(null); } } });

const EMPTY = { meta: { id: "sandbox", code: "S", title: "Industry study", version: "1.0" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }] };
const opts = (...ls) => ls.map((l, i) => ({ code: i + 1, label: l }));
const FOUR = {
  meta: { id: "sandbox", code: "S", title: "Pricing study", version: "1.0" },
  questions: [
    { id: "q1", code: "Q1", variableName: "AGE", type: "numeric", text: "How old are you?" },
    { id: "q2", code: "Q2", variableName: "BRAND", type: "single_select", text: "Which brand do you buy most often?", options: opts("Brand A", "Brand B") },
    { id: "q3", code: "Q3", variableName: "SAT", type: "single_select", text: "How satisfied are you?", options: opts("Low", "High") },
    { id: "q4", code: "Q4", variableName: "SPEND", type: "numeric", text: "How much do you spend a month?" },
  ],
  flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4"] }] }, { type: "end", id: "e_ok", status: "complete" }],
};
const loadDef = async (def) => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(600);
};
const intelligent = async () => { await openTab(page, "Questions"); await switchMode(page, "intelligent"); await page.waitForSelector('[data-testid="intelligent-view"]'); };
const readDef = async () => { await openTab(page, "JSON"); await page.waitForSelector("textarea.code"); const json = await page.$eval("textarea.code", (e) => e.value); await intelligent(); return JSON.parse(json); };
const fakeNext = (reply) => page.evaluate((r) => window.__rescriptCopilotFake(r), reply);
const faultNext = (f) => page.evaluate((x) => window.__rescriptCopilotFault(x), f);
const turns = () => page.$$('[data-testid="cp-turn"]');
const textOf = async (h) => (await h.evaluate((e) => e.innerText)).replace(/\s+/g, " ");
const lastTurn = async () => (await turns()).at(-1);
const waitStatus = (re, timeout = 30000) => page.waitForFunction((src) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); const l = t[t.length - 1]; return !!l && new RegExp(src).test(l.getAttribute("data-status") ?? ""); }, re.source, { timeout });
const submit = async (text, reply) => {
  if (reply) await fakeNext(reply);
  /* a 24k brief is set as the textarea's value (typing it would take minutes), then sent with Enter like any request */
  await page.$eval('[data-testid="iq-input"]', (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, text);
  await page.focus('[data-testid="iq-input"]');
  await page.keyboard.press("Enter");
};
const apply = async () => { if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]'); await page.click('[data-testid="cp-apply"]'); await page.waitForTimeout(500); };
const noRawText = async (t) => {
  const text = await textOf(t);
  assert.doesNotMatch(text, /\b(401|403|429|503|504)\b|rate.?limit exceeded|x-api-key|sk-ant|insufficient_quota|stack|ProviderError|TypeError/i, `no raw provider text on the card: ${text.slice(0, 300)}`);
  return text;
};
/* the response listener reads bodies asynchronously: wait until as many responses as requests were read */
const settled = async () => { for (let i = 0; i < 60 && turnResponses.length < turnRequests.length; i++) await page.waitForTimeout(100); };
const fresh = async (def = EMPTY) => {
  await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
  await page.waitForSelector(".menubar");
  await page.evaluate(() => { try { Object.keys(localStorage).filter((k) => k.startsWith("rescript.copilot.checkpoint.")).forEach((k) => localStorage.removeItem(k)); localStorage.removeItem("rescript.copilot.planFirst"); } catch {} });
  await loadDef(def);
  await intelligent();
  turnRequests.length = 0;
  turnResponses.length = 0;
};

const mk = (id, title) => ({ id, title, kind: "create", objects: [title], reason: `builds ${title}` });
const item = (n, title) => ({ kind: "proposal", reply: `${title} added.`, actions: [{ op: "create_block", title }, { op: "create_question", ref: `Q_${n}`, type: "single_select", text: `Question for ${title}?`, options: ["Yes", "No"] }] });
const PLAN4 = { kind: "plan", summary: "Four blocks.", items: [mk("a", "Screener"), mk("b", "Exposure"), mk("c", "Intent"), mk("d", "About you")], questions: [], assumptions: [] };
const ITEMS4 = [item("A", "Screener"), item("B", "Exposure"), item("C", "Intent"), item("D", "About you")];
const PROMPT = "Create a customer satisfaction survey about our new skincare line, with a screener, exposure, intent and demographics.";

/* ============================================================ [1] the long brief → a plan with assumptions */
await fresh();
{
  /* the production answer to the brief (2026-10-16 12:49), then — asked once more — the plan */
  const ASKED = { kind: "clarify", reply: "This is a very large and detailed brief — I want to make sure I build exactly the right survey before generating 80–120 questions across 10+ blocks. I have a few questions…", questions: ["Which panel provider?", "Which currency for the price questions?", "Do you have brand guidelines?"], actions: [] };
  const sections = ["Screening and firmographics", "Research portfolio", "Technology stack", "End-to-end workflow", "Questionnaire design and programming", "Data quality", "Analysis and reporting", "AI adoption", "Buying process and pricing", "Demographics and close"];
  const PLAN = { kind: "plan", summary: "A 25–30 minute global B2B study among research professionals, in the brief's ten sections, with a stage loop, a MaxDiff and Van Westendorp.", items: [{ id: "d", title: "Record the research design (objectives, H1–H8, constructs)", kind: "design", reason: "the brief's objectives and hypotheses" }, ...sections.map((s, i) => ({ id: `s${i + 1}`, title: `Build the “${s}” block`, kind: "create", objects: [s], reason: `section 8.${i + 1} of the brief` })), { id: "l", title: "Add the stage loop, quotas and screen-outs", kind: "logic", reason: "sections 6 and 7" }, { id: "an", title: "Plan the analysis", kind: "analysis", reason: "section 11" }], questions: ["Which panel provider?", "Which currency?"], assumptions: ["Prices in USD", "Hindi and Simplified Chinese versions come after the English master is approved", "The competitor list is supplied before fieldwork"] };
  await submit(MASTER_PROMPT_BRIEF, [ASKED, PLAN]);
  await waitStatus(/^plan$/, 45000);
  assert.equal(turnRequests.length, 1, "one request");
  assert.ok(turnRequests[0].message.length > 24_000, `the brief was sent whole: ${turnRequests[0].message.length}`);
  await settled();
  const res = turnResponses[0];
  assert.equal(res.stage, "plan");
  assert.equal(res.context.longBrief, true);
  assert.equal(res.context.planRetried, true, "the questions-only answer was asked once more for a plan");
  assert.ok(res.context.messageChars > 20_000, "the route read the brief whole (it used to read 8,000 characters)");
  const t = await lastTurn();
  assert.equal((await t.$$('[data-testid="cp-plan-item"]')).length, 13);
  assert.match(await t.$eval('[data-testid="cp-plan-assumptions"]', (e) => e.textContent), /Prices in USD.*competitor list/s, "the assumptions are stated");
  assert.ok((await t.$$('[data-testid="cp-plan-questions"] button')).length <= 1, "at most one question");
  ok("a ~24k pasted brief is read whole and planned: 13 items with stated assumptions and at most one question — the stand-in's questions-only answer was asked once more, never shown as a questionnaire");
}
{
  /* the same brief, and a model that never plans: ONE focused question — no list, no 100-question single reply */
  await fresh();
  await submit(MASTER_PROMPT_BRIEF, [{ kind: "clarify", reply: "I have a few questions.", questions: ["Which panel provider will you use?", "Which currency?", "Brand guidelines?"], actions: [] }, { kind: "clarify", reply: "Still need answers.", questions: ["Which panel provider will you use?"] }]);
  await waitStatus(/^ready$/, 45000);
  const t = await lastTurn();
  const text = await textOf(t);
  assert.match(text, /Before I plan this brief I need one thing: Which panel provider will you use\?/);
  assert.equal(turnRequests.length, 1);
  ok("a model that will not plan the brief: the researcher gets one focused question, not a questionnaire");
}

/* ============================================================ [2] staged generation, progress, applied once */
{
  await fresh();
  await submit(PROMPT, PLAN4);
  await waitStatus(/^plan$/);
  await settled(); turnRequests.length = 0; turnResponses.length = 0;
  for (let i = 0; i < 4; i++) await faultNext({ budgetMs: 1 });
  await fakeNext(ITEMS4);
  const progress = [];
  const watch = setInterval(async () => { try { const p = await page.$eval('[data-testid="cp-turn"]:last-of-type [data-testid="cp-progress"]', (e) => `${e.getAttribute("data-phase")}:${e.getAttribute("data-done")}/${e.getAttribute("data-total")}`); if (p && progress.at(-1) !== p) progress.push(p); } catch {} }, 40);
  await (await lastTurn()).$eval('[data-testid="cp-plan-build"]', (b) => b.click());
  await waitStatus(/^ready$/, 45000);
  clearInterval(watch);
  assert.equal(turnRequests.length, 4, "one stage per request");
  assert.deepEqual(turnRequests.map((r) => (r.done ?? []).map((d) => d.id).join("")), ["", "a", "ab", "abc"], "each request carries the stages already built (idempotent stage ids)");
  /* responses are read asynchronously, so counted by kind rather than by position */
  await settled();
  assert.deepEqual(turnResponses.map((r) => r?.stage).sort(), ["executed", "progress", "progress", "progress"], "three checkpoints, then the draft");
  const t = await lastTurn();
  assert.match(await textOf(t), /Your survey draft is ready for review\./);
  /* a double click on Apply applies once */
  if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]');
  await page.$eval('[data-testid="cp-apply"]', (b) => { b.click(); b.click(); });
  await page.waitForTimeout(700);
  const def = await readDef();
  assert.deepEqual(def.questions.map((q) => q.variableName ?? q.code).sort(), ["Q_A", "Q_B", "Q_C", "Q_D"], "four questions, once each");
  ok(`staged generation: four requests, one stage each, progress on the card (${progress.slice(0, 4).join(" → ") || "seen"}), the draft applied once even on a double click`);
}

/* ============================================================ [3] a provider timeout mid-stage */
{
  await fresh();
  await submit(PROMPT, PLAN4);
  await waitStatus(/^plan$/);
  await settled(); turnRequests.length = 0; turnResponses.length = 0;
  turnResponses.length = 0;
  await faultNext({ faults: [null, null, { kind: "timeout" }] });
  await fakeNext(ITEMS4);
  await (await lastTurn()).$eval('[data-testid="cp-plan-build"]', (b) => b.click());
  await waitStatus(/^ready$/, 45000);
  await settled();
  const checkpoint = turnResponses.find((r) => r?.stage === "progress");
  assert.ok(checkpoint, "a checkpoint came back");
  assert.deepEqual(checkpoint.builtIds, ["a", "b"], "the two stages built before the timeout are kept");
  assert.equal(checkpoint.waiting?.failure?.code, "timeout");
  assert.deepEqual(turnRequests[1].done.map((d) => d.id), ["a", "b"], "the retry carries them — they are not built again");
  await apply();
  const def = await readDef();
  assert.deepEqual(def.questions.map((q) => q.variableName ?? q.code).sort(), ["Q_A", "Q_B", "Q_C", "Q_D"]);
  ok("a provider timeout on stage 3: stages 1–2 are kept, stage 3 is retried by itself, four questions once each");
}
{
  /* a provider that keeps timing out: the card stops (the work kept), Resume finishes it */
  await fresh();
  await submit(PROMPT, PLAN4);
  await waitStatus(/^plan$/);
  /* request 1 builds stage a, then times out; requests 2–5 time out at once — the fourth round without a new stage stops the card (MAX_STALLED_ROUNDS) */
  await faultNext({ faults: [null, { kind: "timeout" }] });
  for (let i = 0; i < 4; i++) await faultNext({ faults: [{ kind: "timeout" }] });
  await fakeNext(ITEMS4);
  await (await lastTurn()).$eval('[data-testid="cp-plan-build"]', (b) => b.click());
  for (let i = 0; i < 120; i++) { const st = await (await lastTurn()).getAttribute("data-status"); if (st !== "thinking") break; const b = await page.$('[data-testid="cp-resume-now"]'); if (b) await b.click().catch(() => {}); await page.waitForTimeout(300); }
  await waitStatus(/^failed$/, 30000);
  let t = await lastTurn();
  const text = await noRawText(t);
  assert.match(text, /DID NOT ANSWER IN TIME/);
  assert.equal(await t.$eval('[data-testid="cp-work"]', (e) => e.getAttribute("data-built")), "1", "the one stage built is kept");
  await settled(); turnRequests.length = 0; turnResponses.length = 0;
  await fakeNext(ITEMS4.slice(1));
  await page.click('[data-testid="cp-resume"]');
  await waitStatus(/^ready$/, 45000);
  assert.deepEqual(turnRequests[0].done.map((d) => d.id), ["a"], "Resume does not build stage 1 again");
  await apply();
  const def = await readDef();
  assert.deepEqual(def.questions.map((q) => q.variableName ?? q.code).sort(), ["Q_A", "Q_B", "Q_C", "Q_D"]);
  ok("a provider that keeps timing out: the card stops with the work kept and no raw text; Resume builds only the failed and pending stages");
}

/* ============================================================ [4] unsupported */
{
  await fresh();
  await submit("Write me a poem about the sea");
  await waitStatus(/^ready$/);
  const t = await lastTurn();
  assert.ok((await textOf(t)).includes(UNSUPPORTED), "the exact sentence");
  assert.equal(turnRequests.length, 0, "no request to the model route — nothing charged");
  /* the route itself, for any other caller: the same sentence, no model call, no charge */
  const r = await page.evaluate(async (def) => { const x = await fetch("/api/copilot/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: "sandbox", message: "book a flight to Delhi for tomorrow", definition: def }) }); return { status: x.status, d: await x.json() }; }, EMPTY);
  assert.equal(r.status, 200);
  assert.equal(r.d.reply.reply, UNSUPPORTED);
  assert.equal(r.d.usage.charge, 0);
  assert.equal(r.d.context.modelCalled, false);
  /* a real research request in Hindi is never refused */
  await settled(); turnRequests.length = 0; turnResponses.length = 0;
  await submit("मैं मुंबई में रहता हूँ और यहाँ पे पानी की समस्या बहुत सारी है, कुछ लोग slum में रहते हैं और कुछ अच्छे residential apartments में, मेरा मानना है कि slums में purified पानी नहीं मिलता, please help me design a survey", { kind: "plan", summary: "Mumbai water study.", items: [mk("a", "Screener"), mk("b", "Water access")], questions: [], assumptions: ["Hindi and English versions"] });
  await waitStatus(/^plan$/, 30000);
  assert.equal(turnRequests.length, 1, "the Hindi brief went to the model");
  ok("unsupported: the exact sentence with no model call and no charge (in the page and from the route); a Hindi research brief is planned, never refused");
}

/* ============================================================ [5] mixed */
{
  await fresh();
  await submit("Add an NPS question to the survey and book me a flight to Delhi", { kind: "proposal", reply: "I'll add an NPS question.", actions: [{ op: "create_block", title: "Loyalty" }, { op: "create_question", ref: "NPS", block: "Loyalty", type: "nps", text: "How likely are you to recommend us to a friend or colleague?" }] });
  await waitStatus(/^ready$/);
  const t = await lastTurn();
  const text = await textOf(t);
  assert.equal(turnRequests.length, 1, "the supported part went to the model");
  assert.match(text, /I'll add an NPS question\./);
  assert.match(text, /This part of your request is outside the supported capabilities of Intelligent Mode and was not done: “book me a flight to Delhi”/);
  await settled();
  assert.equal(turnResponses[0].context.scope, "mixed");
  await apply();
  const def = await readDef();
  assert.deepEqual(def.questions.map((q) => q.variableName), ["NPS"]);
  ok("mixed: the NPS question is proposed and applied; the flight is named as outside, in the Studio's words");
}

/* ============================================================ [6] the multi-turn chain */
{
  await fresh(FOUR);
  const chain = [
    ["Add a hypothesis about price sensitivity", { kind: "proposal", reply: "I'll record a hypothesis about price sensitivity.", actions: [{ op: "add_hypothesis", text: "Price-sensitive shoppers switch brands more often" }], memory: "H1: price-sensitive shoppers switch brands more often." }, null],
    ["Create three questions to measure it", { kind: "proposal", reply: "Three questions measure price sensitivity.", actions: [{ op: "create_question", ref: "PRICE_1", block: "Main", type: "single_select", text: "I compare prices before I buy.", options: ["Agree", "Disagree"] }, { op: "create_question", ref: "PRICE_2", block: "Main", type: "single_select", text: "I switch brands for a discount.", options: ["Agree", "Disagree"] }, { op: "create_question", ref: "PRICE_3", block: "Main", type: "single_select", text: "Price matters more than brand.", options: ["Agree", "Disagree"] }] }, /Price-sensitive shoppers switch brands more often/],
    ["Include them in the analysis plan with the hypothesis", { kind: "proposal", reply: "PRICE_1–3 are tagged to H1.", actions: [{ op: "set_question_analysis", target: "PRICE_1", role: "independent", hypotheses: ["H1"] }, { op: "set_question_analysis", target: "PRICE_2", role: "independent", hypotheses: ["H1"] }] }, /PRICE_1, PRICE_2, PRICE_3/],
  ];
  for (const [text, reply, expectInMemory] of chain) {
    const before = turnRequests.length;
    await submit(text, reply);
    await waitStatus(/^ready$/, 30000);
    assert.equal(turnRequests.length, before + 1, `“${text}” went to the model`);
    const req = turnRequests.at(-1);
    if (expectInMemory) assert.match(JSON.stringify(req.memory), expectInMemory, `“${text}” carries what the turn before created`);
    await settled();
    const res = turnResponses.at(-1);
    assert.notEqual(res.stage, "plan", `“${text}” is a localized edit, not a plan-first generation`);
    assert.notEqual(res.context.mode, "generate", `“${text}” mode ${res.context.mode}`);
    await apply();
  }
  const def = await readDef();
  assert.ok(["PRICE_1", "PRICE_2", "PRICE_3"].every((v) => def.questions.some((q) => q.variableName === v)));
  assert.equal(def.research?.hypotheses?.length, 1);
  ok("the multi-turn chain: “it” reaches the model as the hypothesis, “them” as PRICE_1–3; no localized edit is routed to plan-first generation");
}

/* ============================================================ [7] nothing built is never a success */
{
  await fresh();
  await submit(PROMPT, { kind: "plan", summary: "Two blocks.", items: [mk("a", "Screener"), mk("b", "Exposure")], questions: [], assumptions: [] });
  await waitStatus(/^plan$/);
  await fakeNext([{ kind: "proposal", reply: "Screener added.", actions: [] }, { kind: "proposal", reply: "Exposure added.", actions: [] }]);
  await (await lastTurn()).$eval('[data-testid="cp-plan-build"]', (b) => b.click());
  await page.waitForFunction(() => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); const l = t[t.length - 1]; return !!l && /ready|failed/.test(l.getAttribute("data-status") ?? ""); }, null, { timeout: 30000 });
  const t = await lastTurn();
  const text = await textOf(t);
  assert.match(text, /Nothing was built/);
  assert.doesNotMatch(text, /ready for review/);
  assert.equal(await t.$('[data-testid="cp-apply"]'), null, "nothing to apply");
  ok("a build whose items come back empty says “Nothing was built” — never ready, never applied");
}

assert.deepEqual(errors, [], `console errors: ${errors.join(" | ")}`);
await browser.close();
console.log(`\n${passed} passed`);
