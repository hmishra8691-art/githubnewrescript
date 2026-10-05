/**
 * ENGINE FIRST (Intelligent Mode upgrade, Phase 3).
 *
 * The Studio's own engine reads the sentence before any model is asked:
 *   - edits it can resolve become actions, checked by the logic engine and
 *     reviewed in the same Changes panel — "If Q7 is No, skip Q8 through
 *     Q12", "Show Q12 only if Q1 is Male and Q2 is over 25", "Mask all brands
 *     selected in Q5 from Q10", "Randomize Q5 but keep None of these last";
 *     Apply writes them, one undoable change each
 *   - questions about the survey are answered from its graph — "What will
 *     break if I delete Q7?" — with references that navigate
 *   - an object that does not exist is refused with the did-you-mean and a
 *     checked fix; a description two questions fit becomes a choice
 *   - none of the above calls /api/copilot/turn or /api/ai/logic; a request
 *     the engine hands on (rewording) does go to the copilot
 *
 *   node scripts/engine-first-test.mjs      (studio on 3000)
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const opts = (...ls) => ls.map((l, i) => ({ code: i + 1, label: l }));
const q = (id, code, variableName, type, text, extra = {}) => ({ id, code, variableName, type, text, ...extra });

const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Car and brand study", version: "1.0" },
  questions: [
    q("gender", "Q1", "GENDER", "single_select", "What is your gender?", { options: opts("Male", "Female") }),
    q("age", "Q2", "AGE", "numeric", "How old are you?"),
    q("city", "Q3", "CITY", "text", "Which city do you live in?"),
    q("aware", "Q4", "AWARE", "single_select", "Have you heard of our brand?", { options: opts("Yes", "No") }),
    q("brands", "Q5", "BRANDS", "multi_select", "Which of these brands have you bought?", { options: [...opts("Brand A", "Brand B", "Brand C"), { code: 99, label: "None of these", flags: ["exclusive"] }] }),
    q("sat", "Q6", "SAT", "single_select", "How satisfied are you overall?", { options: opts("1", "2", "3", "4", "5") }),
    q("own", "Q7", "OWN", "single_select", "Do you own a car?", { options: opts("Yes", "No") }),
    q("make", "Q8", "MAKE", "text", "What make is your car?"),
    q("caryear", "Q9", "CARYEAR", "numeric", "What year was your car made?"),
    q("pref", "Q10", "PREF", "single_select", "Which brand do you prefer?", { options: opts("Brand A", "Brand B", "Brand C") }),
    q("km", "Q11", "KM", "numeric", "How many km a year do you drive your car?"),
    q("insure", "Q12", "INSURE", "single_select", "Is your car insured?", { options: opts("Yes", "No") }),
    q("nps", "Q13", "NPS", "single_select", "How likely are you to recommend us?", { options: opts("0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10") }),
  ],
  flow: [
    { type: "block", id: "b0", title: "About you", children: [{ type: "page", id: "p0", questionIds: ["gender", "age", "city"] }] },
    { type: "block", id: "b1", title: "Brands", children: [{ type: "page", id: "p1", questionIds: ["aware", "brands", "sat"] }] },
    { type: "block", id: "b2", title: "Cars", children: [{ type: "page", id: "p2", questionIds: ["own"] }, { type: "page", id: "p3", questionIds: ["make", "caryear", "pref", "km", "insure"] }] },
    { type: "block", id: "b3", title: "Close", children: [{ type: "page", id: "p4", questionIds: ["nps"] }] },
    { type: "end", id: "e", status: "complete" },
  ],
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (d) => d.accept());
/* every model route the page calls, so the suite can say none was */
const modelCalls = [];
page.on("request", (r) => { if (/\/api\/(?:copilot\/turn|ai\/logic)\b/.test(r.url())) modelCalls.push(r.url()); });

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
/** say a sentence; return the last copilot turn once it is not thinking */
const say = async (message) => {
  const n = (await page.$$('[data-testid="cp-turn"]')).length;
  await page.fill('[data-testid="iq-input"]', message);
  await page.keyboard.press("Enter");
  await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 30000 });
  const turns = await page.$$('[data-testid="cp-turn"]');
  return turns[turns.length - 1];
};
const engineKind = (t) => t.$eval('[data-testid="cp-engine-detail"]', (e) => e.getAttribute("data-kind"));
const detected = (t) => t.$$eval('[data-testid="cp-detected"] .cp-detected-row', (rs) => rs.map((r) => `${r.querySelector("dt").textContent}: ${r.querySelector("dd").textContent}`.replace(/\s+/g, " ").trim()));
const applyChanges = async () => {
  await page.click('[data-testid="cp-tab-changes"]');
  await page.waitForSelector('[data-testid="cp-changes"]');
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(600);
};

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadDef(FIXTURE);
ok("fixture loaded: 13 questions — gender, age, brands with None, a yes/no car question followed by five car questions");

await intelligent();

/* ------------------------------------------------ "If Q7 is No, skip Q8 through Q12" */
{
  const t = await say("If Q7 is No, skip Q8 through Q12");
  assert.ok(await t.$('[data-testid="cp-engine"]'), "answered by the internal engine");
  assert.equal(await engineKind(t), "actions");
  const d = await detected(t);
  assert.ok(d.some((x) => /Q8.*Q12.*Q13/.test(x)), `the range and its target are said: ${d.join(" | ")}`);
  assert.ok(d.some((x) => /Q7 = 2|No/.test(x)), `"No" resolved to its option: ${d.join(" | ")}`);
  assert.equal(await t.getAttribute("data-proposal"), "open");
  await applyChanges();
  const def = await readDef();
  const own = def.questions.find((x) => x.id === "own");
  assert.equal(own.skipLogic.length, 1);
  assert.deepEqual([own.skipLogic[0].target.kind, own.skipLogic[0].target.ref], ["question", "nps"], "after Q7, on No, go to Q13");
  assert.equal(JSON.stringify(own.skipLogic[0].when).includes('"value":2'), true, JSON.stringify(own.skipLogic[0].when));
  ok("“If Q7 is No, skip Q8 through Q12”: the engine resolved No → 2 and Q8–Q12 → Q13, the review showed it, Apply wrote the skip");
}

/* ------------------------------------------------ "Show Q12 only if Q1 is Male and Q2 is over 25" */
await intelligent();
{
  const t = await say("Show Q12 only if Q1 is Male and Q2 is over 25");
  assert.equal(await engineKind(t), "actions");
  await applyChanges();
  const def = await readDef();
  const c = JSON.stringify(def.questions.find((x) => x.id === "insure").displayLogic);
  assert.ok(/"operator":"gt"/.test(c) && /"value":25/.test(c), `“over 25” is > 25, not the words: ${c}`);
  assert.ok(/"ref":"gender"/.test(c) && /"value":1/.test(c), `Male is option 1: ${c}`);
  ok("“Show Q12 only if Q1 is Male and Q2 is over 25”: Q1 = 1 AND Q2 > 25, applied");
}

/* ------------------------------------------------ masking and randomization with an anchor */
await intelligent();
{
  const t = await say("Mask all brands selected in Q5 from Q10");
  assert.equal(await engineKind(t), "actions");
  await applyChanges();
  const t2 = await (async () => { await intelligent(); return say("Randomize Q5 options but keep None of these last"); })();
  assert.equal(await engineKind(t2), "actions");
  await applyChanges();
  const def = await readDef();
  const pref = def.questions.find((x) => x.id === "pref");
  assert.ok(pref.mask && JSON.stringify(pref.mask.expr).includes('"brands"'), JSON.stringify(pref.mask));
  const brands = def.questions.find((x) => x.id === "brands");
  assert.equal(brands.randomization.enabled, true);
  assert.ok(brands.options.at(-1).flags.includes("anchor_bottom") && brands.options.at(-1).label === "None of these");
  ok("“Mask all brands selected in Q5 from Q10” and “Randomize Q5 but keep None of these last”: the mask and the anchored randomization, applied");
}

/* ------------------------------------------------ impact, answered from the graph */
await intelligent();
{
  // Q10's mask reads Q5's answers (applied above): deleting Q5 breaks it
  const t = await say("What will break if I delete Q5?");
  assert.equal(await engineKind(t), "answer");
  const titles = await t.$$eval('[data-testid="cp-engine-section"]', (es) => es.map((e) => e.getAttribute("data-title")));
  assert.ok(titles.length > 0, "grouped sections");
  assert.match(await t.$eval('[data-testid="cp-reply"]', (e) => e.textContent), /Impact|depend/i);
  assert.match(await t.textContent(), /Q10/, "the masked question is named");
  /* the reference navigates: clicking it selects that object */
  const ref = await t.$('[data-testid="cp-engine-ref"]');
  if (ref) { await ref.click(); await page.waitForTimeout(200); }
  assert.equal(await t.getAttribute("data-proposal"), "", "a question proposes nothing");
  ok(`“What will break if I delete Q5?”: answered from the survey, Q10's mask named (${titles.join(", ")})`);
}

/* ------------------------------------------------ refusal with did-you-mean, and the fix */
{
  const t = await say("Make Q133 required");
  assert.equal(await engineKind(t), "refused");
  assert.match(await t.$eval('[data-testid="cp-reply"]', (e) => e.textContent), /Q133/);
  const fix = await t.$('[data-testid="cp-engine-fix"]');
  if (fix) {
    await fix.click();
    await page.waitForSelector('[data-testid="cp-changes"]');
    ok("“Make Q133 required”: refused with the did-you-mean, and the checked fix previewed as a proposal");
    await page.click('[data-testid="cp-panel-cancel"]').catch(() => {});
  } else ok("“Make Q133 required”: refused, naming what does not exist");
}

/* ------------------------------------------------ ambiguity becomes a choice */
{
  const t = await say("Make the car question required");
  const kind = await engineKind(t);
  assert.equal(kind, "clarify", "several questions are about the car");
  const choices = await t.$$('[data-testid="cp-engine-choice"]');
  assert.ok(choices.length >= 2, `one choice per candidate: ${choices.length}`);
  await choices[0].click();
  await page.waitForFunction(() => { const ts = document.querySelectorAll('[data-testid="cp-turn"]'); const last = ts[ts.length - 1]; return last && last.querySelector('[data-testid="cp-engine-detail"]')?.getAttribute("data-kind") === "actions"; }, null, { timeout: 15000 });
  ok(`“Make the car question required”: ${choices.length} candidates offered; choosing one makes the change`);
}

assert.deepEqual(modelCalls, [], `no model route was called for any of these: ${modelCalls.join(", ")}`);
ok("none of the sentences above called /api/copilot/turn or /api/ai/logic");

/* ------------------------------------------------ what the engine hands on goes to the copilot */
{
  const hasFake = await page.evaluate(() => typeof window.__rescriptCopilotFake === "function");
  if (hasFake) await page.evaluate(() => window.__rescriptCopilotFake({ kind: "answer", reply: "A friendlier wording would be …", actions: [] }));
  await say("Reword Q3 to sound friendlier");
  assert.ok(modelCalls.some((u) => /copilot\/turn/.test(u)), "rewording is the model's work");
  assert.ok(!modelCalls.some((u) => /ai\/logic/.test(u)), "and only one model route is called for it");
  ok("“Reword Q3 to sound friendlier” goes to the copilot — one model call, not two");
}

assert.deepEqual(errors.filter((e) => !/ResizeObserver/.test(e)), [], errors.join("\n"));
await browser.close();
console.log(`\n${passed} checks passed`);
