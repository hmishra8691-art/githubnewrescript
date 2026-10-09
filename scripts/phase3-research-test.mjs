/**
 * RESEARCH ENGINE — PHASE 3 (RESEARCH INTELLIGENCE), the Studio.
 *
 *   1. Structured hypotheses: the Research design editor shows each
 *      hypothesis's reading (parsed from its words), records a change to
 *      it, and records research questions, KPIs and the audience; the
 *      Analysis tab shows the reading beside the coverage.
 *   2. The graph: "which questions measure H1", "what depends on H1" and
 *      "what will break if I delete Q4" answered from one dependency index,
 *      hypotheses and KPIs included.
 *   3. Relevance: "make the questionnaire shorter without losing the
 *      important research objectives" is a proposal removing only what
 *      serves nothing; "which questions could be removed" ranks them.
 *   4. The audience: "make this survey more suitable for first-time
 *      smartphone buyers and remove unnecessary questions" — the model's
 *      rewording, and the engine's two steps offered when it has nothing.
 *   5. A document card merged into the research model.
 *   6. The coverage gate on a generation: a loose answer connected on a
 *      second pass, the card saying so.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const opts = (...ls) => ls.map((l, i) => ({ code: i + 1, label: l }));
const q = (id, code, variableName, type, text, extra = {}) => ({ id, code, variableName, type, text, ...extra });
const rule = (ref, operator, value) => ({ type: "rule", source: { kind: "question", ref }, operator, value });
const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Brand switching", version: "1.0" },
  research: { objective: "Understand why customers switch from Brand A to Brand B", hypotheses: ["Price perception drives switching", "Service satisfaction reduces switching"], constructs: [{ name: "Price perception", role: "independent", questionIds: ["q6"] }, { name: "Switching", role: "dependent", questionIds: ["q4"] }], kpis: [{ name: "Switching rate", variable: "SWITCHED", measure: "share Yes", direction: "lower" }], analysis: [], assumptions: [], sources: [] },
  questions: [
    q("q1", "Q1", "AGE", "numeric", "How old are you?", { skipLogic: [{ id: "s1", when: rule("AGE", "lt", 18), target: { kind: "terminate", status: "screened" } }] }),
    q("q2", "Q2", "GENDER", "single_select", "What is your gender?", { options: opts("Male", "Female", "Prefer not to say") }),
    q("q3", "Q3", "BRAND_PREF", "single_select", "Which brand do you prefer?", { options: opts("Brand A", "Brand B", "Brand C"), analysis: { role: "dependent", hypotheses: ["H1"] } }),
    q("q4", "Q4", "SWITCHED", "single_select", "Have you switched brands in the last 12 months?", { options: opts("Yes", "No") }),
    q("q5", "Q5", "REASONS", "multi_select", "Why did you switch?", { options: opts("Price", "Quality", "Availability") }),
    q("q6", "Q6", "PRICE_PERC", "single_select", "Brand B offers better value for money", { options: opts("Strongly disagree", "Disagree", "Neither", "Agree", "Strongly agree") }),
    q("q7", "Q7", "SAT", "single_select", "Overall, how satisfied are you with your current brand?", { options: opts("1", "2", "3", "4", "5"), analysis: { role: "independent", hypotheses: ["H2"] } }),
    q("q8", "Q8", "PETS", "single_select", "Do you have pets?", { options: opts("Yes", "No") }),
    q("q9", "Q9", "COLOUR", "single_select", "What is your favourite colour?", { options: opts("Red", "Blue") }),
  ],
  flow: [
    { type: "block", id: "b1", title: "Screener", children: [{ type: "page", id: "p1", title: "Screener", questionIds: ["q1", "q2"] }] },
    { type: "block", id: "b2", title: "Brands", children: [{ type: "page", id: "p2", title: "Brands", questionIds: ["q3", "q4", "q5", "q6", "q7"] }] },
    { type: "block", id: "b3", title: "Other topics", children: [{ type: "page", id: "p3", title: "Other topics", questionIds: ["q8", "q9"] }] },
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
const apply = async () => { if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]'); await page.click('[data-testid="cp-apply"]'); await page.waitForTimeout(500); };
const RD = '.settings-wrap [data-testid="research-design"]';

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadDef(FIXTURE);
ok("fixture loaded: hypotheses, constructs, a KPI, a screener, two questions that serve nothing");

/* ============================================================ 1. structured hypotheses in the editor */
{
  await openTab(page, "Survey Settings");
  await page.waitForSelector(RD);
  const readings = await page.$$eval(`${RD} [data-testid="rd-hypothesis-reading"]`, (bs) => bs.map((b) => b.textContent));
  assert.equal(readings.length, 2);
  assert.match(readings[0], /causal · Price perception ↑ switching/, "H1 read from its words");
  assert.match(readings[1], /causal · Service satisfaction ↓ switching/);
  await page.click(`${RD} [data-testid="rd-hypothesis"] >> nth=0 >> [data-testid="rd-hypothesis-reading"]`);
  await page.waitForSelector(`${RD} [data-testid="rd-reading"]`);
  const dirSelect = `${RD} [data-testid="rd-reading-direction"]`;
  assert.match(await page.$eval(dirSelect, (s) => s.options[0].textContent), /positive \(from the words\)/, "the parsed value is the default");
  await page.selectOption(dirSelect, "negative");
  await page.selectOption(`${RD} [data-testid="rd-reading-expectedEffect"]`, "large");
  await page.fill(`${RD} [data-testid="rd-reading-dependent"]`, "Switching");
  await page.waitForTimeout(300);
  assert.match(await page.$eval(`${RD} [data-testid="rd-hypothesis"] >> nth=0 >> [data-testid="rd-hypothesis-reading"]`, (b) => b.textContent), /Price perception ↓ Switching · large effect/, "the reading follows the recorded fields");
  // research questions, a KPI, the audience
  await page.fill(`${RD} [data-testid="rd-question-new"]`, "Why do customers switch?");
  await page.click(`${RD} [data-testid="rd-question-add"]`);
  await page.click(`${RD} [data-testid="rd-kpi-add"]`);
  const kpis = await page.$$(`${RD} [data-testid="rd-kpi"]`);
  assert.equal(kpis.length, 2);
  await page.fill(`${RD} [data-testid="rd-kpi"] >> nth=1 >> [data-testid="rd-kpi-name"]`, "Satisfaction");
  await page.selectOption(`${RD} [data-testid="rd-kpi"] >> nth=1 >> [data-testid="rd-kpi-variable"]`, "SAT");
  await page.fill(`${RD} [data-testid="rd-audience"]`, "First-time smartphone buyers");
  await page.selectOption(`${RD} [data-testid="rd-audience-literacy"]`, "plain");
  await page.waitForTimeout(400);
  const def = await readDef();
  assert.deepEqual(def.research.hypothesisDetails[0], { direction: "negative", expectedEffect: "large", dependent: "Switching" });
  assert.deepEqual(def.research.researchQuestions, ["Why do customers switch?"]);
  assert.equal(def.research.kpis[1].name, "Satisfaction");
  assert.equal(def.research.kpis[1].variable, "SAT");
  assert.deepEqual(def.research.audience, { description: "First-time smartphone buyers", characteristics: [], literacy: "plain" });
  ok("Research design: each hypothesis has a reading from its words; direction, effect and the dependent construct recorded; research question, KPI and audience stored");
  await intelligent();
  await page.click('[data-testid="cp-tab-analysis"]');
  await page.waitForSelector('[data-testid="an-hypotheses"]');
  const shown = await page.$$eval('[data-testid="an-hyp-reading"]', (es) => es.map((e) => e.textContent));
  assert.match(shown[0], /Price perception ↓ Switching · large effect/);
  ok("Intelligent → Analysis shows the reading beside each hypothesis's coverage");
}

/* ============================================================ 2. the graph */
{
  await loadDef(FIXTURE);
  await intelligent();
  const m = await say("Which questions measure H1?");
  assert.ok(await m.$('[data-testid="cp-engine"]'));
  assert.equal(await m.getAttribute("data-kind"), "answer");
  const text = await textOf(m);
  assert.match(text, /H1 .* is measured by Q3 \(tagged\), Q4 \(construct “Switching”\), Q6 \(construct “Price perception”\)/);
  assert.ok((await m.$$('[data-testid="cp-engine-ref"]')).length >= 3);
  const d = await say("What depends on H1?");
  assert.equal(await d.getAttribute("data-kind"), "answer");
  assert.match(await textOf(d), /H1/);
  const b = await say("What will break if I delete Q4?");
  assert.equal(await b.getAttribute("data-kind"), "answer");
  const bt = await textOf(b);
  assert.match(bt, /hypothesis H1/);
  assert.match(bt, /KPI “Switching rate”/);
  ok("“Which questions measure H1”, “What depends on H1”, “What will break if I delete Q4” — one graph, hypotheses and KPIs included");
}

/* ============================================================ 3. relevance */
{
  const w = await say("Which questions could be removed?");
  assert.equal(await w.getAttribute("data-kind"), "answer");
  assert.match(await textOf(w), /Q8, Q9 serve nothing in the research design/);
  const t = await say("Make the questionnaire shorter without losing the important research objectives.");
  assert.ok(await t.$('[data-testid="cp-engine"]'), (await textOf(t)).slice(0, 200));
  assert.equal(await t.getAttribute("data-proposal"), "open");
  const text = await textOf(t);
  assert.match(text, /Remove 2 questions that serve nothing in the research design: Q9 .* Q8/);
  assert.match(text, /essential questions stay \(Q1, Q3, Q4, Q6, Q7\)/);
  await apply();
  const def = await readDef();
  assert.deepEqual(def.questions.map((x) => x.code), ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7"]);
  await intelligent();
  const again = await say("Remove the unnecessary questions");
  assert.ok(await again.$('[data-testid="cp-engine"]'));
  assert.match(await textOf(again), /Every question serves the design or the sample/);
  ok("“Make the questionnaire shorter without losing the important research objectives” → only the two unconnected questions proposed, applied; asked again, nothing is unnecessary");
}

/* ============================================================ 4. the audience */
{
  await loadDef(FIXTURE);
  await intelligent();
  const t = await say("Make this survey more suitable for first-time smartphone buyers and remove unnecessary questions.");
  assert.equal(await t.getAttribute("data-status"), "failed", "the fake model has nothing usable");
  const fb = await t.$('[data-testid="cp-fallback"]');
  assert.ok(fb, "the engine's steps are offered");
  const choices = await t.$$('[data-testid="cp-fallback-choice"]');
  assert.equal(choices.length, 2);
  assert.match(await textOf(fb), /Record the audience/i);
  assert.match(await textOf(fb), /Remove the questions that serve nothing/i);
  const n = (await turns()).length;
  await choices[0].click();
  const rec = await settled(n);
  assert.ok(await rec.$('[data-testid="cp-engine"]'));
  assert.match(await textOf(rec), /Record the audience as “First-time smartphone buyers”/);
  await apply();
  assert.equal((await readDef()).research.audience.description, "First-time smartphone buyers");
  await intelligent();
  const n2 = (await turns()).length;
  await page.fill('[data-testid="iq-input"]', "Remove the unnecessary questions");
  await page.keyboard.press("Enter");
  const rm = await settled(n2);
  assert.equal(await rm.getAttribute("data-proposal"), "open");
  await cancel();
  ok("“Make this survey more suitable for first-time smartphone buyers and remove unnecessary questions”: the model's rewording; without one, the audience is recorded and the removals proposed, one click each");
}

/* ============================================================ 5. a document card into the research model */
{
  await loadDef(FIXTURE);
  await intelligent();
  const card = { title: "Switching study", type: "paper", summary: "Price and service drive switching.", objectives: [{ text: "Explain switching among young adults" }], hypotheses: [{ text: "Price perception drives switching" }, { text: "Availability drives switching" }], constructs: [{ name: "Availability", definition: "the brand being in stock where the customer shops" }], scales: [], findings: [], questionAreas: [] };
  await page.evaluate((c) => window.__rescriptCopilotFakeDoc({ summary: c }), card);
  await page.setInputFiles('[data-testid="cp-research-file"]', [{ name: "switching.txt", mimeType: "text/plain", buffer: Buffer.from("Switching study. Price perception drives switching. Availability drives switching. Availability is the brand being in stock where the customer shops.") }]);
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="cp-doc"]').length >= 1, null, { timeout: 30000 });
  await page.waitForSelector('[data-testid="cp-doc-merge"]');
  assert.match(await page.textContent('[data-testid="cp-doc-merge-adds"]'), /adds 1 hypothesis and 1 construct/, "the objective and H1 are in the design already");
  await page.click('[data-testid="cp-doc-merge"]');
  await page.waitForSelector('[data-testid="cp-changes"]');
  // a previewed fix is applied from the Changes panel
  if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]');
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(500);
  const def = await readDef();
  assert.deepEqual(def.research.hypotheses, ["Price perception drives switching", "Service satisfaction reduces switching", "Availability drives switching"]);
  assert.ok(def.research.constructs.some((c) => c.name === "Availability" && c.definition === "the brand being in stock where the customer shops"));
  assert.ok(def.research.constructs.find((c) => c.name === "Price perception").questionIds.includes("q6"), "the existing constructs keep their questions");
  assert.deepEqual(def.research.sources, ["switching.txt"]);
  await intelligent();
  await page.click('[data-testid="cp-tab-research"]');
  await page.waitForSelector('[data-testid="cp-doc-merge"]');
  assert.equal(await page.$eval('[data-testid="cp-doc-merge"]', (b) => b.disabled), true, "nothing left to add");
  for (const doc of (await (await fetch(`${STUDIO}/api/copilot/documents?surveyId=sandbox`)).json()).documents ?? []) await fetch(`${STUDIO}/api/copilot/documents?surveyId=sandbox&id=${encodeURIComponent(doc.id)}`, { method: "DELETE" });
  ok("a document card → “Use in the research design”: the new hypothesis and construct recorded through a proposal, the existing ones untouched; nothing left to add afterwards");
}

/* ============================================================ 6. the coverage gate */
{
  await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
  await page.waitForSelector(".menubar");
  await loadDef({ meta: { id: "sandbox", code: "S", title: "Skincare study", version: "1.0" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }] });
  await intelligent();
  if (await page.$eval('[data-testid="iq-plan-first"] input', (e) => e.checked)) await page.click('[data-testid="iq-plan-first"] input');
  const LOOSE = { kind: "proposal", reply: "Two blocks.", actions: [
    { op: "set_research", objective: "Test whether exposure increases purchase intention", hypotheses: ["Exposure increases purchase intention"], constructs: [{ name: "Exposure", role: "independent", questions: ["EXPOSE"] }, { name: "Purchase intention", role: "dependent", questions: [] }] },
    { op: "create_question", ref: "EXPOSE", type: "rating", text: "How often do you see skincare content?", scale: { points: 5, low: "Never", high: "Very often" } },
    { op: "create_question", ref: "HOBBY", type: "single_select", text: "What is your favourite hobby?", options: ["Sport", "Music"] },
  ] };
  const FIXED = { kind: "proposal", reply: "Two blocks, connected.", actions: [
    { op: "set_research", objective: "Test whether exposure increases purchase intention", hypotheses: ["Exposure increases purchase intention"], constructs: [{ name: "Exposure", role: "independent", questions: ["EXPOSE"] }, { name: "Purchase intention", role: "dependent", questions: ["PI"] }] },
    { op: "create_question", ref: "EXPOSE", type: "rating", text: "How often do you see skincare content?", scale: { points: 5, low: "Never", high: "Very often" } },
    { op: "create_question", ref: "PI", type: "rating", text: "How likely are you to buy premium skincare in the next 3 months?", scale: { points: 5, low: "Very unlikely", high: "Very likely" } },
  ] };
  await fakeNext([LOOSE, FIXED]);
  const n = (await turns()).length;
  await page.fill('[data-testid="iq-input"]', "My hypothesis is that exposure increases purchase intention. Create a new survey that tests it.");
  await page.keyboard.press("Enter");
  const t = await settled(n);
  assert.equal(await t.getAttribute("data-kind"), "proposal");
  assert.equal(await t.getAttribute("data-mode"), "generate");
  const cov = await t.$('[data-testid="cp-coverage"]');
  assert.ok(cov, "the coverage is shown on a generation");
  assert.equal(await cov.getAttribute("data-ok"), "1");
  assert.match(await textOf(cov), /every hypothesis measured \(H1\); every question serves the design or the sample \(connected on a second pass\)/);
  assert.match(await textOf(t), /Two blocks, connected\./, "the second answer is the one proposed");
  await apply();
  const def = await readDef();
  assert.deepEqual(def.questions.map((x) => x.variableName), ["EXPOSE", "PI"]);
  await intelligent();
  // a second pass that is no better is not taken: the first answer stands, and the card says what is loose
  await loadDef({ meta: { id: "sandbox", code: "S", title: "Skincare study", version: "1.0" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }] });
  await intelligent();
  const WORSE = { kind: "proposal", reply: "Still loose.", actions: [...LOOSE.actions, { op: "create_question", ref: "PET", type: "single_select", text: "Do you have a pet?", options: ["Yes", "No"] }] };
  await fakeNext([LOOSE, WORSE]);
  const n2 = (await turns()).length;
  await page.fill('[data-testid="iq-input"]', "My hypothesis is that exposure increases purchase intention. Create a new survey that tests it.");
  await page.keyboard.press("Enter");
  const t2 = await settled(n2);
  const cov2 = await t2.$('[data-testid="cp-coverage"]');
  assert.equal(await cov2.getAttribute("data-ok"), "0");
  assert.match(await textOf(cov2), /H1 has no question that measures it; Q2 serves no hypothesis/);
  assert.doesNotMatch(await textOf(cov2), /second pass/);
  assert.match(await textOf(t2), /Two blocks\./, "the first answer stands");
  await cancel();
  await page.click('[data-testid="iq-plan-first"] input');
  ok("the coverage gate: the loose answer (an unmeasured hypothesis, a hobby question) goes back once; the connected answer is proposed, the card says so; a second pass no better is not taken");
}

assert.deepEqual(errors, [], `no console errors:\n${errors.join("\n")}`);
await browser.close();
console.log(`\n${passed} checks passed`);
