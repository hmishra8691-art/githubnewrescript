/**
 * INTELLIGENT MODE — the import as a person does it (2026-11-13), in the Studio sandbox (no account; fake AI):
 * upload a Word questionnaire → the stages appear → the questions are shown in plain words → answer one → the
 * survey is updated in place → answer the rest → the final report shows what is pending.
 *
 *   AI_API_URL=fake: next dev -p 3000   (apps/studio), then   node scripts/intelligent-import-ui-test.mjs
 */
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "./lib/playwright.mjs";
import { wordDocFixture } from "../packages/import/dist/fixtures.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const SHOT = process.env.SHOT_DIR ?? "";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const dir = mkdtempSync(join(tmpdir(), "iqx-"));
const file = join(dir, "smartphone.docx");
writeFileSync(file, wordDocFixture([
  { p: "Smartphone Features Study", style: "Heading1" },
  { p: "SECTION A: SCREENER", style: "Heading1" },
  "S1. Which smartphone brands do you own? [SELECT ALL THAT APPLY]", "1. Apex", "2. Nova", "3. None of these (TERMINATE)",
  { p: "SECTION B: MAIN", style: "Heading1" },
  "ASK ONLY EXISTING CUSTOMERS",
  "Q1. Why did you choose your brand?",
  "Q2. PROGRAMMER NOTE: MAXDIFF - 6 items, 3 per screen, 4 screens. Which matters most and least?", "1. Price", "2. Quality", "3. Design", "4. Service", "5. Speed", "6. Range",
  "Q3. Which age group are you in? [SINGLE ANSWER]", "1. 18-25", "2. 25-34", "3. 35+",
  "Q4. Which of these phones is the most appealing and which the least appealing?", "1. Phone A", "2. Phone B", "3. Phone C", "4. Phone D",
]));

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(`${STUDIO}/sandbox`, { waitUntil: "networkidle", timeout: 90000 });
await page.click('[data-testid="menu-button-mode"]');
await page.click('text=/Intelligent/i >> nth=0').catch(() => {});
await page.waitForSelector('[data-testid="iq-file"]', { state: "attached", timeout: 30000 });
ok("Intelligent Mode opens in the sandbox");

await page.setInputFiles('[data-testid="iq-file"]', file);
await page.waitForSelector('[data-testid="iqi-run"]:not([disabled])', { timeout: 60000 });
await page.waitForTimeout(400);
/* the run button belongs to the card just added (the last one) */
await page.locator('[data-testid="iqi-run"]').last().click();
await page.waitForSelector('[data-testid="iqx-stages"]', { timeout: 120000 });
const stages = await page.$$eval('[data-testid="iqx-stage"]', (els) => els.map((e) => `${e.getAttribute("data-stage")}:${e.getAttribute("data-state")}`));
assert.deepEqual(stages.map((s) => s.split(":")[0]), ["scan", "understand", "analyze", "clarify", "program", "validate", "test", "finalize"]);
assert.ok(stages.includes("clarify:waiting"));
ok(`the eight stages are shown with their state (${stages.join(", ")})`);
if (SHOT) await page.screenshot({ path: join(SHOT, "iqx-1-stages.png"), fullPage: false });

const asks = await page.$$('[data-testid="iqx-ask"]');
assert.ok(asks.length >= 2, `questions shown: ${asks.length}`);
const firstText = await asks[0].innerText();
assert.match(firstText, /Why I'm asking/);
assert.match(firstText, /EXISTING CUSTOMERS/);
assert.match(await page.innerText('[data-testid="iqx-asks"]'), /everything else is already programmed/i);
ok(`${asks.length} questions in plain words — what was found, why it is asked, the document's own words, the choices`);

await page.click('[data-testid="iqx-tab-understood"]');
const understood = await page.innerText('[data-testid="iqx-understood"]');
assert.match(understood, /SCREENER/); assert.match(understood, /MaxDiff/); assert.match(understood, /both include 25/);
ok("“What I understood”: purpose, sections with their role, the MaxDiff as a placeholder, the overlapping age bands flagged");
await page.click('[data-testid="iqx-tab-understood"]');

/* answer the first question (first choice) — the survey is updated in place */
await asks[0].$('[data-testid="iqx-ask-option"]').then((el) => el.check());
await page.click('[data-testid="iqx-answer"]');
await page.waitForFunction((n) => document.querySelectorAll('[data-testid="iqx-ask"]').length === n - 1, asks.length, { timeout: 90000 });
assert.match(await page.innerText('[data-testid="iqx-answered"]'), /1 answer on record/);
ok("one answer applied: that question leaves the list and is on record; the others stay — no re-upload");

/* the rest: first choice for each */
for (const a of await page.$$('[data-testid="iqx-ask"]')) await a.$('[data-testid="iqx-ask-option"]').then((el) => el.check());
await page.click('[data-testid="iqx-answer"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="iqx-ask"]').length === 0, null, { timeout: 90000 });
await page.click('[data-testid="iqx-tab-report"]');
const report = await page.innerText('[data-testid="iqx-report"]');
assert.equal(await page.getAttribute('[data-testid="iqx-report"]', "data-verdict"), "passed_with_pending");
assert.match(report, /Q2 — MaxDiff/);
assert.match(report, /Completed/);
assert.ok((await page.$$('[data-testid="iqx-pending"]')).length >= 1);
ok("all answered: the final report says “passed — items pending”, lists what was completed and the MaxDiff design still to add");
if (SHOT) await page.screenshot({ path: join(SHOT, "iqx-2-report.png"), fullPage: true });

await browser.close();
assert.deepEqual(pageErrors, [], "no page errors");
console.log(`\nINTELLIGENT IMPORT UI: ${passed} checks passed`);
