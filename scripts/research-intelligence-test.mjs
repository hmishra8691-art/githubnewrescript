/**
 * RESEARCH INTELLIGENCE (2026-10-17) — planning, validation and traceability in Intelligent Mode.
 *
 * The model is the fake provider's stand-in (`window.__rescriptCopilotFake`), answering the way the
 * research and qualitative guides teach; everything after the reply is real: the route, the engine's
 * gate, the proposal, Apply, and the Review tab's research validation and traceability matrix
 * (`validateResearch` / `researchTraceability`), which are read here from the page and checked
 * against the engine run on the same definition.
 *
 *   1  a research brief → a generated study (objective, hypotheses, methodology, constructs, questions,
 *      analysis plan): the proposal card shows the validation; Apply; the Review tab shows the matrix
 *      with H1 PLANNED (never "supported"), H2 UNTESTED, the gaps flagged (H2 unmeasured, a multi-select
 *      grouping a t-test) and the validation's blocking vs warning vs recommendation counts
 *   2  the chain: "Add a hypothesis about price sensitivity" → "Create three questions to measure it" →
 *      "Include it in the analysis plan" — the matrix follows each step (H3 unmeasured → measured but
 *      untested → planned)
 *   3  a qualitative request → an interview guide (open questions + AI probes + topics + text themes),
 *      validated as a qualitative study, each research question mapped to its questions; a request for
 *      focus groups → the honest limitation, nothing proposed
 *   4  a mixed-methods request → a phased plan (phase 1 qualitative → phase 2 quantitative), validated as mixed
 *
 *   node scripts/research-intelligence-test.mjs     (studio :3000 with AI_API_URL=fake:)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { applySurveyActions, capabilitiesMentioned, coerceSurveyActions, researchTraceability, validateResearch } from "../packages/engine/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const EMPTY = SurveyDefinition.parse({
  meta: { id: "sandbox", code: "BB", title: "Broadband", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [], flow: [{ type: "end", id: "e1", status: "complete" }],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
});
const SCALE = { points: 5, low: "Strongly disagree", high: "Strongly agree" };

/* the stand-in model's replies, checked against the engine first so a failure here is the page's, not the fixture's */
const BRIEF = "Here is the research brief: the client must decide whether cutting the Basic plan's price reduces switching. Create the study — objectives, hypotheses, methodology and the analysis plan.";
const BRIEF_REPLY = {
  kind: "proposal",
  reply: "GENERATED (awaiting your approval): a 10-minute online survey for UK broadband bill payers. RECOMMENDED: n=400. Nothing has been applied or run yet; H1 and H2 are planned, not tested.",
  understanding: { objective: "Decide whether a price cut reduces switching", hypotheses: ["Higher price perception increases switching intention", "Loyalty is higher among customers who joined online"], methodology: "Online quantitative survey, n=400", variables: [{ name: "Price perception", role: "independent" }, { name: "Switching intention", role: "dependent" }], analysis: ["regression of switching intention on price perception"] },
  actions: [
    { op: "create_block", ref: "B_SCR", title: "Screening" },
    { op: "create_question", ref: "AGE", block: "Screening", type: "integer", text: "How old are you?", required: true, validation: [{ kind: "min_value", value: 18 }, { kind: "max_value", value: 99 }] },
    { op: "create_block", ref: "B_CORE", title: "Price and switching" },
    { op: "create_question", ref: "PRICE_PERC", block: "Price and switching", type: "rating", text: "My broadband plan is expensive for what it gives me", scale: SCALE, required: true },
    { op: "create_question", ref: "SWITCH", block: "Price and switching", type: "rating", text: "I am likely to switch broadband provider in the next 12 months", scale: SCALE, required: true },
    { op: "create_question", ref: "CHANNELS", block: "Price and switching", type: "multi", text: "Which of these have you used to buy broadband?", options: ["Online", "Phone", "In a store", "A sales agent", { label: "None of these", exclusive: true }] },
    { op: "create_question", ref: "SAT", block: "Price and switching", type: "rating", text: "Overall, I am satisfied with my provider", scale: SCALE, required: true },
    { op: "create_block", ref: "B_DEM", title: "Demographics" },
    { op: "create_question", ref: "GENDER", block: "Demographics", type: "single", text: "What is your gender?", options: ["Male", "Female", "Another way", "Prefer not to say"] },
    { op: "set_research", objective: "Decide whether cutting the Basic price reduces switching among broadband customers", brief: { businessQuestion: "Should we cut the price of the Basic plan?", decision: "whether to cut the Basic price in Q2" }, hypotheses: ["Higher price perception increases switching intention", "Loyalty is higher among customers who joined online"], researchQuestions: ["Which channels do customers use to buy broadband?"], population: "UK broadband bill payers aged 18+", sampleSize: 400, methodology: "Online quantitative survey, n=400: a regression of switching intention on price perception", constructs: [{ name: "Price perception", role: "independent", questions: ["PRICE_PERC"] }, { name: "Switching intention", role: "dependent", questions: ["SWITCH"] }, { name: "Loyalty", role: "dependent" }], assumptions: ["Stated intention stands in for behaviour"] },
    { op: "set_hypothesis", hypothesis: "H1", detail: { type: "causal", direction: "positive", independent: "Price perception", dependent: "Switching intention" } },
    { op: "set_question_analysis", target: "PRICE_PERC", role: "independent", construct: "Price perception", hypotheses: ["H1"] },
    { op: "set_question_analysis", target: "SWITCH", role: "dependent", construct: "Switching intention", hypotheses: ["H1"] },
    { op: "add_analysis_test", method: "regression", outcome: "SWITCH", variables: ["PRICE_PERC"], hypotheses: ["H1"], reason: "does price perception drive switching" },
    { op: "add_analysis_test", method: "t_test", outcome: "SAT", groupBy: "CHANNELS", hypotheses: ["H2"], reason: "satisfaction by channel" },
  ],
};
const engineRun = (def, actions) => { const c = coerceSurveyActions(actions); assert.deepEqual(c.rejected, [], JSON.stringify(c.rejected)); const r = applySurveyActions(def, c.actions); assert.deepEqual(r.errors, [], JSON.stringify(r.errors)); return r.def; };
const expected1 = engineRun(EMPTY, BRIEF_REPLY.actions);
const v1 = validateResearch(expected1);
assert.ok(v1.counts.blocking >= 2, JSON.stringify(v1.counts));

const CHAIN = [
  ["Add a hypothesis about price sensitivity", { kind: "proposal", reply: "GENERATED: H3 — price-sensitive customers are more likely to switch. It is not measured yet.", actions: [{ op: "add_hypothesis", text: "Price-sensitive customers are more likely to switch provider", detail: { type: "association", direction: "positive", independent: "Price sensitivity", dependent: "Switching intention" } }] }],
  ["Create three questions to measure it", { kind: "proposal", reply: "GENERATED: three agreement items measuring price sensitivity, tagged H3.", actions: [
    { op: "create_question", ref: "PS_1", block: "Price and switching", after: "SWITCH", type: "rating", text: "I always look for the cheapest broadband deal", scale: SCALE, required: true },
    { op: "create_question", ref: "PS_2", block: "Price and switching", after: "PS_1", type: "rating", text: "A small price rise would make me look elsewhere", scale: SCALE, required: true },
    { op: "create_question", ref: "PS_3", block: "Price and switching", after: "PS_2", type: "rating", text: "Price matters more to me than speed", scale: SCALE, required: true },
    ...["PS_1", "PS_2", "PS_3"].map((target) => ({ op: "set_question_analysis", target, role: "independent", construct: "Price sensitivity", hypotheses: ["H3"] })),
  ] }],
  ["Include it in the analysis plan", { kind: "proposal", reply: "GENERATED: a regression of switching intention on the three price-sensitivity items, serving H3. Planned, not run.", actions: [{ op: "add_analysis_test", method: "regression", outcome: "SWITCH", variables: ["PS_1", "PS_2", "PS_3"], hypotheses: ["H3"], reason: "does price sensitivity drive switching" }] }],
];

const QUAL = "Create a qualitative interview guide about why customers switch broadband provider";
const QUAL_REPLY = {
  kind: "proposal", reply: "GENERATED: a self-completion interview guide — a warm-up, two topics with AI follow-up probes, a wrap-up — and a text-themes plan. Themes will be qualitative evidence, not population estimates.",
  actions: [
    { op: "create_block", title: "Warm-up" }, { op: "create_question", ref: "WARMUP", block: "Warm-up", type: "long_text", text: "To start, tell us a little about how your household uses the internet.", required: false },
    { op: "create_block", title: "Triggers" },
    { op: "create_question", ref: "TRIGGER", block: "Triggers", type: "long_text", text: "Think about the last time you considered switching provider. What happened?", required: false },
    { op: "create_question", ref: "TRIGGER_FEEL", block: "Triggers", type: "long_text", text: "How did you feel about your provider at that point?", required: false },
    { op: "create_block", title: "Comparing providers" },
    { op: "create_question", ref: "COMPARE", block: "Comparing providers", type: "long_text", text: "When you compare providers, what do you look at first, and why?", required: false },
    { op: "create_block", title: "Wrap-up" }, { op: "create_question", ref: "WRAPUP", block: "Wrap-up", type: "text", text: "Is there anything else you would like to add?", required: false },
    { op: "set_probe", target: "TRIGGER", maxProbes: 2, minWords: 3, instruction: "Ask what tipped the decision and for a concrete example." },
    { op: "set_probe", target: "TRIGGER_FEEL", maxProbes: 1, instruction: "Ask what would have changed that feeling." },
    { op: "set_probe", target: "COMPARE", maxProbes: 2, instruction: "Ask which source they trusted most." },
    { op: "set_research", objective: "Explore why customers switch broadband provider", methodology: "Qualitative self-completion interview guide with AI follow-up probes", researchQuestions: ["What triggers customers to consider switching?", "How do customers compare providers?"], constructs: [{ name: "Switching triggers", role: "descriptive", questions: ["TRIGGER", "TRIGGER_FEEL"] }, { name: "Comparing providers", role: "descriptive", questions: ["COMPARE"] }] },
    { op: "add_analysis_test", method: "text_themes", variables: ["TRIGGER"], reason: "RQ1: what triggers switching" },
    { op: "add_analysis_test", method: "text_themes", variables: ["COMPARE"], reason: "RQ2: how providers are compared" },
  ],
};
const expectedQual = engineRun(EMPTY, QUAL_REPLY.actions);
assert.equal(validateResearch(expectedQual).kind, "qualitative");
const FOCUS = "Run two moderated focus groups before the survey";
assert.ok(capabilitiesMentioned(FOCUS).some((c) => c.id === "qualitative:moderated" && c.status === "not_supported"), "the registry says so");

const MIXED = "Design a mixed-methods study: qualitative interviews first, then a quantitative survey to test what we learn";
const MIXED_REPLY = {
  kind: "proposal", reply: "GENERATED: a phased plan. Phase 1 (qualitative, probed open questions) explores the triggers; Phase 2 (quantitative) tests H1 from those propositions. Qualitative themes stay evidence; the estimates come from phase 2.",
  actions: [
    { op: "create_block", title: "Phase 1 — exploration" },
    { op: "create_question", ref: "Q_TRIGGER", block: "Phase 1 — exploration", type: "long_text", text: "What would make you think about leaving your provider?", required: false },
    { op: "create_question", ref: "Q_COMPARE", block: "Phase 1 — exploration", type: "long_text", text: "How do you compare broadband providers?", required: false },
    { op: "create_question", ref: "Q_SERVICE", block: "Phase 1 — exploration", type: "long_text", text: "Describe a time the service let you down.", required: false },
    { op: "set_probe", target: "Q_TRIGGER", maxProbes: 2, instruction: "Ask for a concrete example." },
    { op: "set_probe", target: "Q_COMPARE", maxProbes: 2, instruction: "Ask what mattered most." },
    { op: "set_probe", target: "Q_SERVICE", maxProbes: 1, instruction: "Ask what happened next." },
    { op: "create_block", title: "Phase 2 — measurement" },
    { op: "create_question", ref: "PRICE_PERC", block: "Phase 2 — measurement", type: "rating", text: "My broadband plan is expensive for what it gives me", scale: SCALE, required: true },
    { op: "create_question", ref: "SWITCH", block: "Phase 2 — measurement", type: "rating", text: "I am likely to switch provider in the next 12 months", scale: SCALE, required: true },
    { op: "create_question", ref: "TENURE", block: "Phase 2 — measurement", type: "integer", text: "How many years have you been with your provider?", required: true, validation: [{ kind: "min_value", value: 0 }, { kind: "max_value", value: 50 }] },
    { op: "create_question", ref: "REGION", block: "Phase 2 — measurement", type: "single", text: "Where do you live?", options: ["North", "Midlands", "South", "Scotland, Wales or Northern Ireland"] },
    { op: "set_research", objective: "Understand and measure why customers switch broadband provider", methodology: "Mixed methods: Phase 1 qualitative probed open questions → propositions → Phase 2 quantitative survey testing them (n=400)", sampleSize: 400, researchQuestions: ["What triggers customers to consider switching?"], hypotheses: ["Higher price perception increases switching intention"], constructs: [{ name: "Switching triggers", role: "descriptive", questions: ["Q_TRIGGER", "Q_COMPARE", "Q_SERVICE"] }, { name: "Price perception", role: "independent", questions: ["PRICE_PERC"] }, { name: "Switching intention", role: "dependent", questions: ["SWITCH"] }, { name: "Tenure", role: "control", questions: ["TENURE"] }] },
    { op: "set_question_analysis", target: "PRICE_PERC", role: "independent", construct: "Price perception", hypotheses: ["H1"] },
    { op: "set_question_analysis", target: "SWITCH", role: "dependent", construct: "Switching intention", hypotheses: ["H1"] },
    { op: "add_analysis_test", method: "text_themes", variables: ["Q_TRIGGER"], reason: "RQ1 (phase 1): triggers" },
    { op: "add_analysis_test", method: "regression", outcome: "SWITCH", variables: ["PRICE_PERC", "TENURE"], hypotheses: ["H1"], reason: "phase 2: does price perception drive switching" },
  ],
};
const expectedMixed = engineRun(EMPTY, MIXED_REPLY.actions);
assert.equal(validateResearch(expectedMixed).kind, "mixed");

/* ============================================================ the Studio */
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
const goTab = async (name) => { await openTab(page, name); await page.waitForTimeout(150); };
const loadDef = async (def) => {
  await switchMode(page, "studio").catch(() => {});
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(1200);
  await goTab("Questions");
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
};
const readDef = async () => {
  await switchMode(page, "studio");
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  await goTab("Questions");
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
  return SurveyDefinition.parse(JSON.parse(json));
};
const TURNS = '[data-testid="cp-turn"]';
const ask = async (text, reply) => {
  await page.evaluate((r) => window.__rescriptCopilotFake(r), [reply]);
  const k = (await page.$$(TURNS)).length;
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/copilot/turn") && r.request().method() === "POST", { timeout: 90000 }),
    (async () => { await page.fill('[data-testid="iq-input"]', text); await page.keyboard.press("Enter"); })(),
  ]);
  const body = await res.json();
  await page.waitForFunction((c) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > c && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, k, { timeout: 60000 });
  return { body, card: (await page.$$(TURNS)).at(-1) };
};
const refusedOf = (body) => (body.validation?.results ?? []).filter((r) => !r.ok);
const apply = async () => {
  await page.click('[data-testid="cp-tab-changes"]');
  await page.waitForSelector('[data-testid="cp-changes"]');
  if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]');
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(800);
  return readDef();
};
/** the Review tab, run afresh (the stand-in model reads nothing new), and what it shows */
const review = async () => {
  await page.evaluate(() => window.__rescriptCopilotFake([{ kind: "review", reply: "The engine's checks cover this.", findings: [] }]));
  await page.click('[data-testid="cp-tab-review"]');
  if (await page.$('[data-testid="cp-rerun-review"]')) await page.click('[data-testid="cp-rerun-review"]'); else await page.click('[data-testid="cp-run-review"]');
  await page.waitForSelector('[data-testid="cp-validation"]');
  await page.waitForFunction(() => !/the copilot is reading/.test(document.querySelector('[data-testid="cp-review"] .cp-review-head')?.textContent ?? ""), null, { timeout: 60000 }).catch(() => {});
  const v = await page.$eval('[data-testid="cp-validation"]', (e) => ({ kind: e.dataset.kind, blocking: Number(e.dataset.blocking), warnings: Number(e.dataset.warnings), recommendations: Number(e.dataset.recommendations), text: e.textContent }));
  const rows = await page.$$eval('[data-testid="cp-trace-row"]', (rs) => rs.map((r) => ({ id: r.dataset.id, status: r.dataset.status, text: r.textContent })));
  const gaps = await page.$$eval('[data-testid="cp-trace-gap"]', (gs) => gs.map((g) => ({ code: g.dataset.code, severity: g.dataset.severity, text: g.textContent })));
  const research = await page.$$eval('[data-testid="cp-finding"][data-source="research"]', (fs) => fs.map((f) => `${f.dataset.severity}|${f.textContent}`));
  return { v, rows, gaps, research };
};

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
await loadDef(EMPTY);

/* 1 — the research brief → a generated study, validated and traced */
console.log("\n1 — a research brief → plan → study → validation and traceability");
{
  const { body, card } = await ask(BRIEF, BRIEF_REPLY);
  assert.equal(body.reply?.kind, "proposal", JSON.stringify(body).slice(0, 500));
  assert.deepEqual(refusedOf(body), [], "every action passes the engine's gate");
  assert.ok(body.coverage && body.coverage.ok === false && body.coverage.unmeasured.includes("H2"), JSON.stringify(body.coverage));
  const pv = await card.$('[data-testid="cp-proposal-validation"]');
  assert.ok(pv, "the generated study's card shows its validation");
  assert.equal(Number(await pv.getAttribute("data-blocking")), v1.counts.blocking, "the card's count is the engine's on the proposed survey");
  assert.match(await pv.textContent(), /Validation.*Quantitative study: \d+ blocking.*Traceability: 2 hypotheses \(1 planned, 1 untested\)/);
  assert.match(await card.textContent(), /GENERATED \(awaiting your approval\)/);
  const def = await apply();
  assert.deepEqual(def.research.hypotheses, BRIEF_REPLY.actions.find((a) => a.op === "set_research").hypotheses);
  assert.equal(def.research.hypothesisDetails[0].independent, "Price perception", "set_hypothesis beside set_research in one batch is recorded");
  const r = await review();
  assert.equal(r.v.kind, "quantitative");
  const engine = validateResearch(def);
  assert.equal(r.v.blocking, engine.counts.blocking);
  assert.equal(r.v.warnings, engine.counts.warning);
  assert.equal(r.v.recommendations, engine.counts.recommendation);
  assert.deepEqual(r.rows.map((x) => [x.id, x.status]), [["H1", "planned"], ["H2", "untested"], ["RQ1", "descriptive_only"]]);
  assert.match(r.rows[0].text, /Planned — not yet tested/);
  assert.ok(!r.rows.some((x) => /supported/i.test(x.text) && !/nothing is supported/.test(x.text)), "no hypothesis reads as a finding");
  assert.ok(r.gaps.some((g) => g.code === "hypothesis_unmeasured" && g.severity === "critical" && /H2 has no measuring question/.test(g.text)));
  assert.ok(r.gaps.some((g) => g.code === "analysis_incompatible" && /CHANNELS|Q\d+ is a multi-select: its options overlap/.test(g.text)));
  assert.ok(r.research.some((f) => /^critical\|.*multi-select: its options overlap, so it cannot be the groups of a t test/.test(f)), r.research.join("\n"));
  assert.deepEqual(researchTraceability(def).rows.map((x) => x.status), ["planned", "untested", "descriptive_only"]);
  ok(`brief → generated study (${def.questions.length} questions, 2 hypotheses, plan) → Apply → validation ${r.v.blocking} blocking / ${r.v.warnings} warnings / ${r.v.recommendations} recommendations; matrix H1 planned, H2 untested, gaps flagged`);
}

/* 2 — the multi-step chain updates the traceability */
console.log("\n2 — add a hypothesis → three questions → the analysis plan");
{
  const statusOf = async (id) => (await review()).rows.find((x) => x.id === id);
  await ask(...CHAIN[0]);
  let def = await apply();
  assert.equal(def.research.hypotheses.length, 3);
  let r = await review();
  assert.equal(r.rows.find((x) => x.id === "H3")?.status, "untested");
  assert.ok(r.gaps.some((g) => g.code === "hypothesis_unmeasured" && /H3/.test(g.text)), r.gaps.map((g) => g.text).join("\n"));
  await ask(...CHAIN[1]);
  def = await apply();
  r = await review();
  assert.ok(!r.gaps.some((g) => g.code === "hypothesis_unmeasured" && /^H3/.test(g.text)), "H3 measured now");
  assert.ok(r.gaps.some((g) => g.code === "hypothesis_no_analysis" && /H3/.test(g.text)), "but nothing tests it yet");
  assert.match(r.rows.find((x) => x.id === "H3").text, /Q\d+, Q\d+, Q\d+/);
  await ask(...CHAIN[2]);
  def = await apply();
  const h3 = await statusOf("H3");
  assert.equal(h3.status, "planned");
  assert.match(h3.text, /Regression|regression/);
  assert.deepEqual(researchTraceability(def).rows.find((x) => x.id === "H3").gaps, []);
  ok("“Add a hypothesis about price sensitivity” → H3 untested (unmeasured); “Create three questions to measure it” → measured, no analysis; “Include it in the analysis plan” → H3 planned, no gaps");
}

/* 3 — qualitative: an interview guide; focus groups → the honest limitation */
console.log("\n3 — a qualitative request → an interview guide; focus groups → not supported");
{
  await loadDef(EMPTY);
  const { body } = await ask(QUAL, QUAL_REPLY);
  assert.deepEqual(refusedOf(body), []);
  const def = await apply();
  assert.equal(def.questions.filter((q) => q.probe).length, 3, "the topic questions are probed");
  const r = await review();
  assert.equal(r.v.kind, "qualitative");
  assert.equal(r.v.blocking, 0, r.v.text);
  assert.deepEqual(r.rows.map((x) => [x.id, x.status]), [["RQ1", "descriptive_only"], ["RQ2", "descriptive_only"]]);
  assert.match(r.rows[0].text, /qualitative evidence — themes describe what was said, not how many/);
  const { body: fb, card } = await ask(FOCUS, { kind: "answer", reply: "Moderated focus groups are not supported in Rescript — Studio surveys are self-completion. I can build the same discussion as a self-completion interview guide with AI follow-up probes." });
  assert.equal(fb.reply.kind, "answer");
  assert.deepEqual(fb.reply.actions, []);
  assert.equal(await card.$('[data-testid="cp-apply"]'), null, "nothing proposed");
  assert.match(await card.textContent(), /not supported/);
  ok("interview guide: warm-up, two probed topics, wrap-up, topics mapped to their questions, text themes — validated as qualitative with 0 blocking; focus groups → the limitation, nothing proposed");
}

/* 4 — mixed methods: a phased plan */
console.log("\n4 — a mixed-methods request → a phased plan");
{
  await loadDef(EMPTY);
  const { body } = await ask(MIXED, MIXED_REPLY);
  assert.deepEqual(refusedOf(body), []);
  const def = await apply();
  const r = await review();
  assert.equal(r.v.kind, "mixed");
  assert.deepEqual(r.rows.map((x) => [x.id, x.status]), [["H1", "planned"], ["RQ1", "descriptive_only"]]);
  assert.ok(!r.research.some((f) => /does not say how the phases connect|needs both its qualitative/.test(f)), "the phases are connected and both sides recorded");
  assert.equal(validateResearch(def).kind, "mixed");
  ok("mixed methods: Phase 1 probed open questions → Phase 2 measurement; H1 planned from the quantitative phase, RQ1 qualitative evidence");
}

assert.deepEqual(pageErrors, [], pageErrors.join("\n"));
await browser.close();
console.log(`\n${passed} passed`);
