/**
 * P0 (2026-10-16) — INTELLIGENT MODE CAN BUILD A LIST FILL, AND IT WORKS IN THE SURVEY.
 *
 * The field case (operations log, 2026-10-14, translated from Hindi): Q37 rates 10 smartphone
 * brands 1 Never heard of … 5 Very familiar; the brands rated 3–5 go to Q38 (a ranking); if more
 * than 5 qualify, randomly assign 4; Apple on top, and in the four, whenever it qualifies. The model
 * had no List Fill action and wrote `set_mask` with an invented expression
 * (`Q37.Selected where (@option.rating >= 3) UNION {Apple}`), corrected twice by hand.
 *
 *   STUDIO   the request; the model's reply (fake provider) is one create_list_fill; the engine
 *            resolves Q37's rows, the 3–5 rule, Apple's priority and Q38 (aligning Q38's codes to
 *            Q37's by label), the card describes it in words, it is applied
 *   RUNTIME  the applied survey in the runtime preview: rate the brands, Next — Q38 shows exactly the
 *            brands that qualify (Apple first when rated); 7 qualify → exactly 4, Apple on top;
 *            Back, re-rate, Next → Q38 follows the new ratings (nothing stale, no duplicates);
 *            nothing qualifies → Q38 is skipped
 *
 *   node scripts/listfill-intelligent-test.mjs     (studio :3000 with AI_API_URL=fake:, runtime :3001)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };

const BRANDS = ["Apple", "Samsung", "Xiaomi", "OnePlus", "Vivo", "Oppo", "Realme", "Motorola", "Nokia", "Google"];
const SCALE = ["Never heard of", "Heard of", "Somewhat familiar", "Familiar", "Very familiar"];
const FIELD_REQUEST = "Q37 is a grid of 10 smartphone brands × familiarity (1 Never heard of … 5 Very familiar). The brands rated Somewhat familiar, Familiar or Very familiar (codes 3–5) should be shown in the next question Q38 (a ranking). If more than 5 qualify, randomly assign 4. Apple must always be shown and on top: if Apple qualifies it is in the four, at the top; if not, any four, but priority to Apple.";
const MODEL_REPLY = {
  kind: "proposal",
  reply: "Q37 में 3–5 रेटिंग वाले ब्रांड Q38 में दिखेंगे; 5 से ज़्यादा हों तो 4 रैंडम, Apple qualify करे तो सबसे ऊपर।",
  actions: [{ op: "create_list_fill", name: "BRANDS", source: "Q37", eligible: { minValue: 3 }, count: 4, allIfAtMost: 5, method: "priority_random", priority: { Apple: 1 }, destinations: ["Q38"], whenUnused: "hide" }],
};

const SURVEY = {
  meta: { id: "sandbox", code: "LF", title: "Smartphone brands", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [
    {
      id: "q37", code: "Q37", variableName: "FAMILIARITY", type: "matrix_single", variant: "matrix.single", required: true,
      text: "How familiar are you with each of these smartphone brands?",
      rows: BRANDS.map((label, i) => ({ code: `r${i + 1}`, label })),
      options: SCALE.map((label, i) => ({ code: i + 1, label })),
    },
    // the ranking was created from the same brand names, so its codes are 1..10, not Q37's r1..r10
    { id: "q38", code: "Q38", variableName: "RANK", type: "ranking", variant: "ranking.drag", required: false, text: "Rank these brands, most preferred first", options: BRANDS.map((label, i) => ({ code: i + 1, label })) },
    { id: "q39", code: "Q39", variableName: "WHY", type: "text", variant: "text.multi_line", required: false, text: "Anything else about smartphones?" },
  ],
  flow: [{ type: "page", id: "p37", questionIds: ["q37"] }, { type: "page", id: "p38", questionIds: ["q38"] }, { type: "page", id: "p39", questionIds: ["q39"] }, { type: "end", id: "e1", status: "complete" }],
  logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], designs: [], variables: [], embeddedData: [], listFills: [], scripts: [],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
};

const browser = await chromium.launch();

/* ============================================================ STUDIO */
console.log("\nSTUDIO — the field request, answered with a List Fill");
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
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
const readDef = async () => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  return JSON.parse(await page.$eval("textarea.code", (e) => e.value));
};
await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
await loadDef(SURVEY);
await switchMode(page, "intelligent");
await page.waitForSelector('[data-testid="intelligent-view"]');

let applied;
{
  await page.evaluate((r) => window.__rescriptCopilotFake(r), [MODEL_REPLY]);
  const k = (await page.$$('[data-testid="cp-turn"]')).length;
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/copilot/turn") && r.request().method() === "POST", { timeout: 60000 }),
    (async () => { await page.fill('[data-testid="iq-input"]', FIELD_REQUEST); await page.keyboard.press("Enter"); })(),
  ]);
  const body = await res.json();
  await page.waitForFunction((c) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > c && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, k, { timeout: 40000 });
  // the engine's own check of the reply, as the route ran it
  const results = body.validation?.results ?? [];
  const lfResult = results.find((r) => r.op === "create_list_fill");
  assert.ok(lfResult, `the reply carries the List Fill action: ${JSON.stringify(body.validation ?? body).slice(0, 600)}`);
  assert.equal(lfResult.ok, true, lfResult.error);
  assert.match(lfResult.description, /List Fill BRANDS: from Q37 rows rated 3–5/, "the engine says what the list does, in words");
  assert.match(lfResult.description, /Apple first when eligible/);
  assert.match(lfResult.description, /into Q38/);
  assert.ok(!results.some((r) => r.op === "set_mask"), "no set_mask with an invented expression");
  await page.waitForSelector('[data-testid="cp-panel-apply"]');
  assert.equal(await page.$('[data-testid="cp-refused"]'), null, "nothing refused");
  assert.match((await page.textContent('[data-testid="cp-summary"]').catch(() => "")) ?? "", /Add List Fill BRANDS/, "the Changes list names the new List Fill");
  ok("the request is answered with create_list_fill, nothing refused, described in words (Q37 rows rated 3–5, 4 items, Apple first, into Q38)");

  // recoding Q38 to Q37's row codes is a destructive change: the researcher confirms it, as for any other
  assert.ok(await page.$('[data-testid="cp-confirm"]'), "the recode of Q38 is shown as destructive, to be confirmed");
  await page.check('[data-testid="cp-confirm"]');
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForTimeout(700);
  applied = await readDef();
  assert.equal(applied.listFills.length, 1);
  const lf = applied.listFills[0];
  assert.equal(lf.name, "BRANDS");
  assert.deepEqual(lf.source, { kind: "question", questionId: "q37", take: "all" });
  assert.deepEqual(lf.selection.count, { kind: "fixed", n: 4, allUpTo: 5 });
  assert.equal(lf.options.find((o) => o.label === "Apple").priority, 1);
  const q38 = applied.questions.find((q) => q.id === "q38");
  assert.deepEqual(q38.mask.expr, { kind: "listFill", listFillId: lf.id });
  assert.deepEqual(q38.options.map((o) => String(o.code)), BRANDS.map((_, i) => `r${i + 1}`), "Q38 carries Q37's codes now");
  assert.ok(!applied.questions.some((q) => JSON.stringify(q.mask ?? {}).includes("@option")), "no invented mask expression anywhere");
  ok("applied: def.listFills has BRANDS (Q37 rows, ≥ 3, 4 / all when ≤ 5, Apple priority 1), Q38 masked to LISTFILL(BRANDS) with Q37's codes");
}
assert.deepEqual(pageErrors, [], pageErrors.join("\n"));

/* ============================================================ RUNTIME */
console.log("\nRUNTIME — the applied survey, in the runtime preview");
const rt = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
const rtErrors = [];
rt.on("pageerror", (e) => rtErrors.push(String(e)));
await rt.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await sendPreview(rt, { definition: { ...applied, meta: { ...applied.meta, id: "lfp0" } } }, { selector: '[data-qid="q37"]' });

const labelOf = Object.fromEntries(BRANDS.map((b, i) => [`r${i + 1}`, b]));
const rate = async (ratings) => {
  for (let i = 0; i < BRANDS.length; i++) {
    await rt.click(`[data-qid="q37"] td[data-rs-el="cell"][data-rs-id="r${i + 1}::${ratings[i]}"] input`);
  }
};
const rated = (...on) => BRANDS.map((b) => (on.includes(b) ? 4 : 1));
const next = async () => { await rt.click('[data-testid="rs-next"]'); await rt.waitForTimeout(600); };
const back = async () => { await rt.click('[data-testid="rs-back"]'); await rt.waitForSelector('[data-qid="q37"]'); await rt.waitForTimeout(300); };
const shownInQ38 = async () => {
  await rt.waitForSelector('[data-qid="q38"]');
  return rt.$$eval('[data-qid="q38"] [data-rs-el="option"]', (els) => els.map((e) => e.getAttribute("data-rs-id")));
};

// 2 qualify → both, Apple first
await rate(rated("Apple", "Nokia"));
await next();
let shown = (await shownInQ38()).map((c) => labelOf[c]);
assert.deepEqual(shown, ["Apple", "Nokia"]);
ok("2 brands rated 3–5 → Q38 ranks exactly those two, Apple first");

// Back, 7 qualify → exactly 4, Apple on top, no duplicates
await back();
const seven = ["Apple", "Samsung", "Xiaomi", "OnePlus", "Vivo", "Oppo", "Realme"];
await rate(rated(...seven));
await next();
shown = (await shownInQ38()).map((c) => labelOf[c]);
assert.equal(shown.length, 4, JSON.stringify(shown));
assert.equal(new Set(shown).size, 4, "no duplicates");
assert.equal(shown[0], "Apple", "Apple on top");
assert.ok(shown.every((b) => seven.includes(b)), `only brands rated 3–5: ${shown}`);
ok(`Back, 7 rated 3–5 → Q38 shows exactly 4 (${shown.join(", ")}), Apple on top, no duplicates`);

// Back, Apple dropped, only 3 qualify → those 3, Apple gone (re-decided, nothing stale)
await back();
await rate(rated("Oppo", "Realme", "Google"));
await next();
shown = (await shownInQ38()).map((c) => labelOf[c]);
assert.deepEqual(shown, ["Oppo", "Realme", "Google"]);
ok("Back, re-rated → Q38 follows the new ratings (Oppo, Realme, Google); the old four are gone");

// Back, 5 qualify (Apple not among them) → all 5, Apple not forced in
await back();
const five = ["Samsung", "Vivo", "Oppo", "Realme", "Google"];
await rate(rated(...five));
await next();
shown = (await shownInQ38()).map((c) => labelOf[c]);
assert.deepEqual(shown, five);
ok("5 qualify → all 5 (“more than 5 → 4”); Apple not rated → not forced in");

// Back, nothing qualifies → Q38 skipped
await back();
await rate(rated());
await next();
await rt.waitForSelector('[data-qid="q39"]', { timeout: 8000 });
assert.equal(await rt.$('[data-qid="q38"]'), null);
ok("nothing rated 3–5 → Q38 is skipped (whenUnused: hide); the respondent goes straight to Q39");

// and back up again: Q38 returns with the new list
await rt.click('[data-testid="rs-back"]');
await rt.waitForSelector('[data-qid="q37"]');
await rate(rated("Apple", "Samsung"));
await next();
shown = (await shownInQ38()).map((c) => labelOf[c]);
assert.deepEqual(shown, ["Apple", "Samsung"]);
ok("rated again → Q38 is back with Apple, Samsung");

assert.deepEqual(rtErrors, [], rtErrors.join("\n"));
ok("no page errors in the runtime");

await browser.close();
console.log(`\n${passed} passed`);
