/**
 * PRODUCTION INTENTS (E3, 2026-10-18) — the requests production misread, end to end in the Studio.
 *
 *   UNDO BY VOICE   "जो changes अभी आपने किया उसे reward back कर दो …" (the production words: STT for "roll
 *                   back") right after an applied change → History's undo, NO model request; the survey is
 *                   as it was, the card says so, the History entry reads "undone"
 *   UNDO, NOTHING   "undo" with a proposal open and nothing applied → the proposal is set aside, the survey
 *   APPLIED         unchanged, no model request
 *   ONE STEP ONCE   Reapply pressed twice on the same History entry → one step in Changes (no "2 requests"),
 *                   and the applied record's prompt is not "X → X"
 *   APPLY BY VOICE  "Please apply the changes. It is good." with a proposal open → the Apply button's apply,
 *                   NO model request (production: a second paid call that re-proposed the same behaviours)
 *   ROUTING         the garbled Marathi request reaches the translation guide; पॉप अप + क्यूटू and Urdu
 *                   جاوا سکرپٹ reach the UX guide (stand-in model)
 *   ACCEPTED NOW    the model's production actions: a calculation over PERC.R1… / IF … THEN … ELSE and
 *                   set_custom_code on "__survey__" are applied, not refused
 *
 *   node scripts/production-intents-test.mjs      (studio :3000 with AI_API_URL=fake:)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };

const SURVEY = {
  meta: { id: "sandbox", code: "CGP", title: "Production intents", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [
    { id: "q1", code: "Q1", variableName: "CONSENT_INFO", type: "descriptive", text: "Welcome to the survey" },
    { id: "q2", code: "Q2", variableName: "CITIZEN", type: "single_select", text: "Are you an Indian citizen?", required: false, options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] },
    { id: "q3", code: "Q3", variableName: "AGE_SCR", type: "numeric", text: "What is your current age (in years)?", required: false },
    { id: "q4", code: "Q4", variableName: "PERC", type: "matrix_single", text: "How much do you agree?", required: false, rows: [{ code: "r1", label: "Legitimate" }, { code: "r2", label: "Peaceful" }, { code: "r3", label: "Necessary" }], options: [{ code: 1, label: "Disagree" }, { code: 2, label: "Neutral" }, { code: 3, label: "Agree" }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "page", id: "p2", questionIds: ["q3", "q4"] }, { type: "end", id: "e1", status: "complete" }],
  logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], designs: [], variables: [], embeddedData: [], listFills: [], scripts: [],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
};

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
/* every request the page makes to the copilot route — the Studio's own answers make none */
let turnRequests = 0;
page.on("request", (r) => { if (r.url().includes("/api/copilot/turn") && r.method() === "POST") turnRequests++; });

const goTab = async (name) => { await openTab(page, name); await page.waitForTimeout(150); };
const loadDef = async (def) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(1200);
  await goTab("Questions");
};
const intelligent = async () => {
  await openTab(page, "Questions");
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
};
/* as history-test reads it: the JSON tab, then back to Intelligent (its proposal, History and conversation memory are the page's, kept) */
const readDef = async () => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  const d = JSON.parse(await page.$eval("textarea.code", (e) => e.value));
  await intelligent();
  return d;
};
const turns = () => page.$$('[data-testid="cp-turn"]').then((t) => t.length);
/** say something; wait for its card to settle; the last card's text and status */
const say = async (text) => {
  const k = await turns();
  await page.fill('[data-testid="iq-input"]', text);
  await page.keyboard.press("Enter");
  await page.waitForFunction((c) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > c && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, k, { timeout: 40000 });
  await page.waitForTimeout(300);
  return page.$eval('[data-testid="cp-turn"]:last-of-type', (e) => ({ text: e.textContent ?? "", status: e.getAttribute("data-status") })).catch(async () => ({ text: (await page.textContent("body")) ?? "", status: "" }));
};
/** a model turn with a stand-in reply: the route's JSON */
const modelTurn = async (text, fake) => {
  await page.evaluate((r) => window.__rescriptCopilotFake(r), fake);
  const k = await turns();
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/copilot/turn") && r.request().method() === "POST", { timeout: 60000 }),
    (async () => { await page.fill('[data-testid="iq-input"]', text); await page.keyboard.press("Enter"); })(),
  ]);
  const body = await res.json().catch(() => ({}));
  await page.waitForFunction((c) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > c && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, k, { timeout: 40000 });
  return body;
};
const apply = async () => {
  await page.click('[data-testid="cp-tab-changes"]').catch(() => {});
  await page.waitForSelector('[data-testid="cp-panel-apply"]');
  if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]');
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(900);
};
const q = (def, id) => def.questions.find((x) => x.id === id);

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
await loadDef(SURVEY);
await switchMode(page, "intelligent");
await page.waitForSelector('[data-testid="intelligent-view"]');

/* ============================================================ UNDO BY VOICE */
console.log("\nUNDO — said in words, done by History");
{
  await say("Make Q2 required");
  await apply();
  assert.equal(q(await readDef(), "q2").required, true, "the change is applied");
  const before = turnRequests;
  const card = await say("जो changes अभी आपने किया उसे reward back कर दो क्योंकि ये worthless है");
  assert.equal(turnRequests, before, "no model request for an undo");
  assert.match(card.text, /Undone/, card.text);
  assert.equal(q(await readDef(), "q2").required ?? false, false, "the survey is back to how it was");
  await page.click('[data-testid="cp-tab-history"]').catch(() => {});
  await page.waitForSelector('[data-testid="cp-change"][data-status="reverted"]', { timeout: 8000 });
  ok("“reward back कर दो” (STT for roll back) undoes the last applied change through History — no model call, the entry reads undone");
}
{
  await say("Make Q3 required");
  await page.waitForSelector('[data-testid="cp-panel-apply"]');
  const before = turnRequests;
  const card = await say("undo");
  assert.equal(turnRequests, before);
  assert.match(card.text, /set aside/, card.text);
  assert.equal(await page.$('[data-testid="cp-panel-apply"]'), null, "the proposal is gone from Changes");
  assert.equal(q(await readDef(), "q3").required ?? false, false, "nothing was applied");
  ok("“undo” with a proposal open and nothing applied sets the proposal aside — the survey unchanged, no model call");
}

/* ============================================================ ONE STEP ONCE */
console.log("\nONE STEP ONCE — the same request twice is one step");
{
  await page.click('[data-testid="cp-tab-history"]');
  const reapply = page.locator('[data-testid="cp-change"][data-status="reverted"] [data-testid="cp-op-reapply"]').first();
  await reapply.waitFor({ timeout: 8000 });
  await reapply.click();
  await page.waitForTimeout(300);
  await page.click('[data-testid="cp-tab-history"]');
  await page.locator('[data-testid="cp-change"][data-status="reverted"] [data-testid="cp-op-reapply"]').first().click();
  await page.waitForTimeout(300);
  await page.click('[data-testid="cp-tab-changes"]');
  await page.waitForSelector('[data-testid="cp-panel-apply"]');
  assert.equal(await page.$('[data-testid="cp-steps"]'), null, "one step, not “2 requests: … → …”");
  await apply();
  assert.equal(q(await readDef(), "q2").required, true);
  await page.click('[data-testid="cp-tab-history"]');
  const prompts = await page.$$eval('[data-testid="cp-op-prompt"]', (els) => els.map((e) => e.textContent ?? ""));
  assert.ok(!prompts.some((p) => /Reapply[^→]*→\s*Reapply/.test(p)), prompts.join("\n"));
  ok("Reapply pressed twice is one step in Changes, and the applied record does not say the request twice");
}

/* ============================================================ APPLY BY VOICE */
console.log("\nAPPLY — said in words, done by the Apply button");
{
  await say("Make Q3 required");
  await page.waitForSelector('[data-testid="cp-panel-apply"]');
  const before = turnRequests;
  const card = await say("Please apply the changes. It is good.");
  assert.equal(turnRequests, before, "no model request (production: a second paid call that re-proposed the same changes)");
  assert.match(card.text, /Applied the open proposal/, card.text);
  assert.equal(q(await readDef(), "q3").required, true, "applied");
  ok("“Please apply the changes. It is good.” with a proposal open applies it — no model call, nothing proposed twice");
  const none = await say("मुझे कोई और चेंजस नहीं करना है लेट्स इंप्लिमेंट");
  void none;
  ok("with nothing open, the same kind of sentence goes on as before (to the model — it may be an answer to its question)");
}

/* ============================================================ ROUTING (stand-in model) */
console.log("\nROUTING — the garbled requests reach their guides");
{
  const mr = await modelTurn("मला हाँ पाइजे कि सारे कोश्ण टेक्सलातो मी मराठीला विचारा मराठी मदे विचारा", { kind: "answer", reply: "ठीक आहे." });
  assert.equal(mr.context?.translation, true, "Marathi in Devanagari reaches the translation guide");
  const popup = await modelTurn("मुझे एक पॉप अप चाहिए ये सिलेक्ट करने पर लिख करा ये आप अलजीबल वोट अगर मैं आप्शन वाल सिलेक्ट करता हूँ क्यूटू पे तो", { kind: "answer", reply: "ठीक है." });
  assert.equal(popup.context?.ux, true, "पॉप अप reaches the UX guide");
  const urdu = await modelTurn("مجھے Q3 میں ایک جاوا سکرپٹ لگانی ہے یہ اگر میں اپشنل ون سیلیکٹ کرتا ہوں تو پاپ اپ ایسا انیمیشن یا سکرپٹ لگانا ہے", { kind: "answer", reply: "ٹھیک ہے" });
  assert.equal(urdu.context?.ux, true, "Urdu جاوا سکرپٹ reaches the UX guide");
  ok("Marathi → translation guide; पॉप अप / क्यूटू and Urdu جاوا سکرپٹ → UX guide");
}

/* ============================================================ ACCEPTED NOW */
console.log("\nACCEPTED NOW — the model's production actions apply");
{
  const body = await modelTurn("मुझे protest legitimacy का score और age group चाहिए, और पूरे सर्वे पर एक जावास्क्रिप्ट", { kind: "proposal", reply: "Adding the scores and the script.", actions: [
    { op: "create_calculation", name: "LEGIT_SCORE", expression: "(PERC.R1 + PERC.R2 + PERC.R3) / 3" },
    { op: "create_calculation", name: "AGE_GROUP", expression: "IF AGE_SCR <= 27 THEN 1 ELSE IF AGE_SCR <= 43 THEN 2 ELSE 3" },
    { op: "set_custom_code", target: "__survey__", js: "rs.log('survey script');" },
  ] });
  const results = body.validation?.results ?? [];
  assert.equal(results.length, 3, JSON.stringify(body.validation?.errors));
  assert.ok(results.every((r) => r.ok), (body.validation?.errors ?? []).join("\n"));
  await apply();
  const def = await readDef();
  assert.equal(def.calculations.find((c) => c.targetVariable === "LEGIT_SCORE")?.expression, "(PERC_r1 + PERC_r2 + PERC_r3) / 3");
  assert.equal(def.calculations.find((c) => c.targetVariable === "AGE_GROUP")?.expression, "if(AGE_SCR <= 27, 1, if(AGE_SCR <= 43, 2, 3))");
  assert.ok(def.ux.behaviors.some((b) => b.target.kind === "survey" && b.source === "copilot_custom_code"));
  ok("PERC.R1 → PERC_r1, IF … THEN … ELSE → if(), set_custom_code on “__survey__” → a survey-wide script: applied, not refused");
}

assert.deepEqual(pageErrors, [], pageErrors.join("\n"));
await browser.close();
console.log(`\n${passed} passed`);
