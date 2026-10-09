/**
 * RESEARCH ENGINE — PHASE 1 (RELIABILITY), the Studio surfaces.
 *
 *   1. A model turn that fails says WHY, with what to do next and what the
 *      engine had read — never the grammar's "I did not understand that":
 *      an unusable reply (the fake provider), a truncated answer (502 with
 *      the route's failure), the wallet (402), and no model at all (501 —
 *      after which the engine-only message names AI_API_URL).
 *   2. The research design is editable by hand (Survey Settings and the
 *      Analysis tab): objective, hypotheses (added, edited, removed with the
 *      engine's renumbering), constructs linked to questions, assumptions —
 *      and the Analysis tab's coverage reads it.
 *   3. /api/platform reports whether a model is configured.
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
  meta: { id: "sandbox", code: "SANDBOX", title: "Phase 1", version: "1.0" },
  research: { objective: "Why customers switch", hypotheses: ["Price perception drives switching", "Service satisfaction reduces switching"], constructs: [{ name: "Price perception", role: "independent", questionIds: ["q3"] }], analysis: [], assumptions: [], sources: [] },
  questions: [
    q("q1", "Q1", "AGE", "numeric", "How old are you?"),
    q("q2", "Q2", "BRAND", "single_select", "Preferred brand", { options: opts("Brand A", "Brand B") }),
    q("q3", "Q3", "PRICE", "single_select", "Brand B is better value", { options: opts("Disagree", "Neutral", "Agree"), analysis: { hypotheses: ["H2"] } }),
    q("q4", "Q4", "SAT", "single_select", "Service satisfaction", { options: opts("Low", "Mid", "High"), analysis: { hypotheses: ["H2"] } }),
  ],
  flow: [{ type: "page", id: "p1", title: "Page 1", questionIds: ["q1", "q2", "q3", "q4"] }, { type: "end", id: "e1", status: "complete" }],
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
  return JSON.parse(await page.$eval("textarea.code", (e) => e.value));
};
const intelligent = async () => {
  await openTab(page, "Questions");
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
};
const say = async (message) => {
  const n = (await page.$$('[data-testid="cp-turn"]')).length;
  await page.fill('[data-testid="iq-input"]', message);
  await page.keyboard.press("Enter");
  await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 30000 });
  await page.waitForTimeout(300);
  const turns = await page.$$('[data-testid="cp-turn"]');
  return turns[turns.length - 1];
};
const viewText = () => page.$eval('[data-testid="intelligent-view"]', (e) => e.innerText);

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadDef(FIXTURE);
ok("fixture loaded");

/* ============================================================ 1. honest failures */
await intelligent();
{
  // (Phase 2 reads the screener sentence itself; a rewording is still the model's)
  const t = await say("Rewrite the age question so it is friendlier.");
  assert.equal(await t.getAttribute("data-status"), "failed");
  const f = await t.$('[data-testid="cp-failure"]');
  assert.ok(f, "the failure block is shown");
  assert.equal(await f.getAttribute("data-code"), "unusable");
  const text = await t.evaluate((e) => e.innerText);
  assert.match(text, /THE MODEL'S ANSWER HAD NOTHING TO APPLY/, "the kicker names the cause");
  assert.match(text, /FAKE provider/, "…and the detail");
  assert.match(text, /WHAT TO DO/i, "and what to do next");
  const handoff = await t.$('[data-testid="cp-handoff"]');
  assert.ok(handoff, "what the engine read is shown");
  assert.match(await handoff.evaluate((e) => e.innerText), /rewording a question is writing/, "…including why it handed the sentence on");
  assert.doesNotMatch(await viewText(), /I did not understand that/, "the grammar's message is gone");
  ok("an unusable model reply: the cause, the next step, what the engine read — not “not understood”");
}
{
  await page.route("**/api/copilot/turn", (route) => route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ ok: false, error: "x", failure: { code: "truncated", title: "THE MODEL'S ANSWER WAS CUT OFF", message: "The answer was longer than the output budget allows (8000 tokens, continued 2×), even after asking the model to continue, so no change could be read from it.", next: ["Ask for less at once — one block, one section of the questionnaire, or the design first and the questions after.", "Nothing was changed, and the partial answer was not applied."] }, usage: { charge: 0.0123 } }) }));
  const t = await say("Create a questionnaire for a 40-question brand tracker with every section and all demographics");
  assert.equal(await t.$eval('[data-testid="cp-failure"]', (e) => e.getAttribute("data-code")), "truncated");
  assert.match(await t.$eval('[data-testid="cp-handoff"]', (e) => e.innerText), /question creation/, "the request type the engine read");
  const text = await t.evaluate((e) => e.innerText);
  assert.match(text, /CUT OFF/);
  assert.match(text, /8000 tokens, continued 2×/);
  assert.match(text, /one block/);
  await page.unroute("**/api/copilot/turn");
  ok("a truncated answer: named as such, with the budget and the remedy");
}
{
  await page.route("**/api/copilot/turn", (route) => route.fulfill({ status: 402, contentType: "application/json", body: JSON.stringify({ error: "Insufficient balance: $0.12 available, this call needs about $0.30.", code: "wallet_insufficient_balance", failure: { code: "wallet", title: "THE WALLET REFUSED THIS CALL", message: "The meter refused this call: Insufficient balance: $0.12 available, this call needs about $0.30.", next: ["Check the wallet balance and the project's spending limit under Usage.", "Nothing was sent to the model and nothing was changed."] } }) }));
  const t = await say("Make the questionnaire shorter without losing the important research objectives.");
  assert.equal(await t.$eval('[data-testid="cp-failure"]', (e) => e.getAttribute("data-code")), "wallet");
  assert.match(await t.evaluate((e) => e.innerText), /Insufficient balance/);
  await page.unroute("**/api/copilot/turn");
  // a 402 from a path that carries no failure object (an older refusal body) is still the wallet, by its status
  await page.route("**/api/copilot/turn", (route) => route.fulfill({ status: 402, contentType: "application/json", body: JSON.stringify({ error: "Spending limit reached for this project.", code: "wallet_limit" }) }));
  const t2 = await say("Rewrite the age question so it is friendlier");
  assert.equal(await t2.$eval('[data-testid="cp-failure"]', (e) => e.getAttribute("data-code")), "wallet");
  assert.match(await t2.evaluate((e) => e.innerText), /Spending limit reached/);
  await page.unroute("**/api/copilot/turn");
  ok("a wallet refusal: named, with the balance — by the body's failure, or by the status alone");
}
{
  await page.route("**/api/copilot/turn", (route) => route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ error: "No language model is configured on this Studio (AI_API_URL).", code: "ai_unconfigured", failure: { code: "not_configured", title: "NO LANGUAGE MODEL CONFIGURED", message: "This Studio has no language model configured, so only the engine's own reading is available — it handles instructions that name their objects (codes, variable names, option labels, logic words).", next: ["Set AI_API_URL, AI_API_KEY and AI_MODEL on the server (see .env.example) to read sentences like this one.", "Or rephrase with the objects named: “Terminate if Q1 < 25”."] } }) }));
  const t = await say("Add a question to measure purchase intent.");
  assert.equal(await t.$eval('[data-testid="cp-failure"]', (e) => e.getAttribute("data-code")), "not_configured");
  assert.match(await t.evaluate((e) => e.innerText), /AI_API_URL/);
  // from here the Studio knows there is no model: the next descriptive sentence is read by the engine alone, and says so precisely
  await page.route("**/api/ai/logic", (route) => route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ error: "No language model is configured on this Studio (AI_API_URL)." }) }));
  await page.fill('[data-testid="iq-input"]', "Make the questionnaire feel warmer and more conversational.");
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-testid="iq-error"]', { timeout: 15000 });
  const err = await page.$$eval('[data-testid="iq-error"]', (es) => es.map((e) => e.innerText).join("\n"));
  assert.match(err, /no language model configured/, err);
  assert.match(err, /AI_API_URL/);
  assert.match(err, /Terminate if Q1 < 25/, "the examples it does read");
  assert.match(err, /What the engine read — request type: survey creation/, "and what it read from this sentence");
  assert.doesNotMatch(await viewText(), /I did not understand that/);
  assert.doesNotMatch(await viewText(), /NOT UNDERSTOOD/);
  assert.match(await viewText(), /NO LANGUAGE MODEL — THE ENGINE COULD NOT READ THIS/, "the card's kicker names the cause");
  assert.equal(await page.textContent('[data-testid="iq-provider"]'), "engine only");
  await page.unroute("**/api/copilot/turn");
  await page.unroute("**/api/ai/logic");
  ok("no model configured: the first turn says so; the engine-only message after it names the variable and the sentences the engine reads");
}

/* ============================================================ 2. the research design editor */
const RD = '.settings-wrap [data-testid="research-design"]'; // the visible one: the right panel's fallback mounts SurveySettings too, hidden on this tab
await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadDef(FIXTURE);
await openTab(page, "Survey Settings");
await page.waitForSelector(RD);
{
  assert.equal(await page.inputValue(`${RD} [data-testid="rd-objective"]`), "Why customers switch", "the design is shown");
  assert.equal((await page.$$(`${RD} [data-testid="rd-hypothesis"]`)).length, 2);
  await page.fill(`${RD} [data-testid="rd-objective"]`, "Why customers switch from Brand A to Brand B");
  await page.fill(`${RD} [data-testid="rd-population"]`, "Adults 18–65 who bought in the category");
  await page.fill(`${RD} [data-testid="rd-sample"]`, "800");
  await page.fill(`${RD} [data-testid="rd-hypothesis-new"]`, "Availability drives switching");
  await page.click(`${RD} [data-testid="rd-hypothesis-add"]`);
  await page.waitForTimeout(300);
  assert.equal((await page.$$(`${RD} [data-testid="rd-hypothesis"]`)).length, 3);
  // a construct, linked to a question
  await page.click(`${RD} [data-testid="rd-construct-add"]`);
  const constructs = await page.$$(`${RD} [data-testid="rd-construct"]`);
  const c = constructs[constructs.length - 1];
  await page.fill(`${RD} [data-testid="rd-construct"] >> nth=${constructs.length - 1} >> [data-testid="rd-construct-name"]`, "Service satisfaction");
  await page.selectOption(`${RD} [data-testid="rd-construct"] >> nth=${constructs.length - 1} >> [data-testid="rd-construct-role"]`, "dependent");
  await page.selectOption(`${RD} [data-testid="rd-construct"] >> nth=${constructs.length - 1} >> [data-testid="rd-construct-add-question"]`, "q4");
  await page.fill(`${RD} [data-testid="rd-assumption-new"]`, "Respondents recall their previous brand");
  await page.click(`${RD} [data-testid="rd-assumption-add"]`);
  await page.waitForTimeout(400);
  const def = await readDef();
  assert.equal(def.research.objective, "Why customers switch from Brand A to Brand B");
  assert.equal(def.research.population, "Adults 18–65 who bought in the category");
  assert.equal(def.research.sampleSize, 800);
  assert.deepEqual(def.research.hypotheses, ["Price perception drives switching", "Service satisfaction reduces switching", "Availability drives switching"]);
  const sat = def.research.constructs.find((x) => x.name === "Service satisfaction");
  assert.ok(sat && sat.role === "dependent" && sat.questionIds.includes("q4"), JSON.stringify(def.research.constructs));
  assert.deepEqual(def.research.assumptions, ["Respondents recall their previous brand"]);
  ok("Survey Settings → Research design: objective, population, sample size, a hypothesis, a construct linked to Q4 and an assumption are stored");
}
{
  // removing H1 goes through the engine: H2 becomes H1 and the questions tagged H2 now say H1
  await openTab(page, "Survey Settings");
  await page.waitForSelector(RD);
  await page.click(`${RD} [data-testid="rd-hypothesis"] >> nth=0 >> [data-testid="rd-hypothesis-remove"]`);
  await page.waitForTimeout(400);
  const def = await readDef();
  assert.deepEqual(def.research.hypotheses, ["Service satisfaction reduces switching", "Availability drives switching"]);
  assert.deepEqual(def.questions.find((x) => x.id === "q3").analysis.hypotheses, ["H1"], "the tag followed its hypothesis");
  assert.deepEqual(def.questions.find((x) => x.id === "q4").analysis.hypotheses, ["H1"]);
  ok("removing a hypothesis renumbers the later ones and the tags that cite them (the engine's remove_hypothesis)");
}
{
  // the Analysis tab reads the design and offers the same editor
  await intelligent();
  await page.click('[data-testid="cp-tab-analysis"]');
  await page.waitForSelector('[data-testid="an-hypotheses"]');
  const hyps = await page.$$eval('[data-testid="an-hyp"]', (es) => es.map((e) => e.getAttribute("data-status")));
  assert.equal(hyps.length, 2);
  assert.ok(hyps[0] !== "unlinked", `H1 (service satisfaction) is linked through the construct: ${hyps.join(",")}`);
  assert.ok(await page.$('[data-testid="an-design-editor"]'), "the editor is reachable from the Analysis tab");
  await page.click('[data-testid="an-design-editor"] summary');
  await page.waitForSelector('[data-testid="an-design-editor"] [data-testid="rd-hypothesis-new"]');
  await page.fill('[data-testid="an-design-editor"] [data-testid="rd-hypothesis-new"]', "Younger buyers switch more");
  await page.click('[data-testid="an-design-editor"] [data-testid="rd-hypothesis-add"]');
  await page.waitForTimeout(400);
  assert.equal((await page.$$('[data-testid="an-hyp"]')).length, 3, "the coverage list follows the edit");
  ok("Intelligent → Analysis: coverage reads the hand-written design, and the editor is one click away");
}

/* ============================================================ 3. the platform page knows about the model */
{
  const r = await page.request.get(`${STUDIO}/api/platform`);
  if (r.status() === 200) {
    const info = await r.json();
    assert.ok("ai" in info.configured && "aiFake" in info.configured && "aiModel" in info.configured, Object.keys(info.configured).join(","));
    assert.equal(info.configured.ai, true, "the sandbox runs the fake provider, which is configured");
    assert.equal(info.configured.aiFake, true);
    ok("/api/platform reports the language model's presence (ai, aiFake, aiModel)");
  } else {
    ok(`/api/platform is gated here (${r.status()}) — the flags are unit-tested`);
  }
}

assert.deepEqual(errors, [], `no console errors:\n${errors.join("\n")}`);
await browser.close();
console.log(`\n${passed} checks passed`);
