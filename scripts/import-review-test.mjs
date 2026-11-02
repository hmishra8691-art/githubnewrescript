/**
 * I7 — THE IMPORT REVIEW in the browser (sandbox, fake AI), on corpus file 04 (121 questions, 13 blocks):
 *   A  Open full review: Summary counts, the six compatibility categories; clicking an element opens the
 *      inspector with the source as read and the reconstructed Rescript element (the drill-down: DD → placeholder)
 *   B  Flow & logic: blocks, questions with "shown if …", the screen-out branch's condition in words, the
 *      panel redirect with its piped PID
 *   C  Blocks: Import selected blocks (2 of 13) re-analyses the preview with only those (20 questions); the
 *      dependency on an unselected block is reported; Re-run with every block brings back all 121
 *
 *   D  (I8) Behaviour: a Word questionnaire with TERMINATE IF / IF … SKIP TO / ASK IF — the card says every logic
 *      scenario behaves as the document says, and the Fidelity report lists each one, met and not met
 *
 *   node scripts/import-review-test.mjs     (Studio dev server with AI_API_URL=fake:; SECTIONS=ABCD by default)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "./lib/playwright.mjs";
import { switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const SECTIONS = (process.env.SECTIONS ?? "ABCD").toUpperCase();
let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
const lastImport = async () => (await page.$$('[data-testid="iq-import"]')).at(-1);
const stageIs = async (stage, timeout = 90000) => page.waitForFunction((s) => { const els = document.querySelectorAll('[data-testid="iq-import"]'); return els.length && els[els.length - 1].getAttribute("data-stage") === s; }, stage, { timeout });
const created = async () => Number(await page.$eval('[data-testid="iq-import"]:last-of-type tr[data-row="questions"] td:nth-child(3)', (e) => e.textContent));
const qsf = readFileSync(new URL("../packages/import/corpus/qsf/04-large-121-questions.qsf", import.meta.url));

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForSelector(".block-badge", { timeout: 120000 });
await switchMode(page, "intelligent");
await page.waitForSelector('[data-testid="intelligent-view"]');
let fullCreated = 0;
if (/[ABC]/.test(SECTIONS)) {
  await page.setInputFiles('[data-testid="iq-file"]', { name: "large.qsf", mimeType: "application/json", buffer: qsf });
  await stageIs("estimated");
  await (await (await lastImport()).$('[data-testid="iqi-run"]')).click();
  await stageIs("ready");
  fullCreated = await created();
  assert.ok(fullCreated >= 120, `the whole survey is in the preview (${fullCreated})`);
  await (await (await lastImport()).$('[data-testid="iqi-review-open"]')).click();
  await page.waitForSelector('[data-testid="iqr"]');
}

if (SECTIONS.includes("A")) {
  assert.equal(await page.textContent('[data-testid="iqr-count-questions"]'), "121");
  assert.equal(await page.textContent('[data-testid="iqr-count-blocks"]'), "13");
  assert.equal(await page.textContent('[data-testid="iqr-count-redirects"]'), "2");
  for (const k of ["full", "converted", "configure", "partial", "unsupported", "clarify"]) assert.ok(await page.$(`[data-testid="iqr-cat-count-${k}"]`), k);
  assert.match(await page.textContent('[data-testid="iqr-cat-count-full"]'), /Fully supported \d{3}/);
  await page.click('[data-testid="iqr-tab-compat"]');
  const partial = await page.$('[data-testid="iqr-compat-partial"]');
  const dd = (await partial.$$('[data-testid="iqr-compat-item"]')).at(0);
  assert.match(await dd.textContent(), /car \(DD\/DL\)/);
  await dd.click();
  await page.waitForFunction(() => /"sourceType": "DD\/DL"/.test(document.querySelector('[data-testid="iqr-inspect-source"]')?.textContent ?? ""), null, { timeout: 30000 });
  assert.match(await page.textContent('[data-testid="iqr-inspect-rebuilt"]'), /Not migrated/, "the reconstructed element is the placeholder, side by side");
  assert.match(await page.textContent('[data-testid="iqr-compat-configure"]'), /script on QID62/);
  ok("A: Summary counts and six categories; an element opens the inspector — the source as read beside the reconstructed element");
}

if (SECTIONS.includes("B")) {
  await page.click('[data-testid="iqr-tab-flow"]');
  const nodes = await page.$$eval('[data-testid="iqr-flow-node"]', (els) => els.map((e) => [e.getAttribute("data-kind"), e.textContent]));
  assert.equal(nodes.filter(([k]) => k === "question").length, 121);
  assert.ok(nodes.some(([k, t]) => k === "branch" && /when B1_1 = Not at all/.test(t)), "the screen-out condition in words");
  assert.ok(nodes.some(([k, t]) => k === "end" && /screened.*→ https:\/\/panel\.example\.com\/so\?pid=\$\{e:\/\/Field\/PID\}/.test(t)), "the redirect with its piped PID");
  assert.ok(nodes.some(([k, t]) => k === "question" && /B2_1.*shown if B1_1 = Very/.test(t)), "a question's display logic in words");
  assert.ok(nodes.some(([k, t]) => k === "question" && /depends on .*display ← QID1/.test(t)), "and what it depends on");
  ok("B: Flow & logic lists blocks, questions with their conditions, the branch, the end with its redirect, and dependencies");
}

if (SECTIONS.includes("C")) {
  await page.click('[data-testid="iqr-tab-blocks"]');
  const boxes = await page.$$('[data-testid="iqr-block"]');
  assert.equal(boxes.length, 13);
  for (const [i, b] of boxes.entries()) if (i !== 1 && i !== 2) await b.uncheck();
  await page.click('[data-testid="iqr-rerun-selected"]');
  await page.waitForFunction(() => /Only 2 selected blocks/.test(document.querySelector('[data-testid="iqi-blocks-note"]')?.textContent ?? ""), null, { timeout: 90000 });
  assert.equal(await created(), 20, "the preview now holds the two blocks' 20 questions");
  await page.click('[data-testid="iqr-tab-summary"]');
  assert.match(await page.textContent('[data-testid="iqr-summary"]'), /point.? at something that is not in the imported survey|reference/i, "the dependency on block 1 is reported");
  await page.click('[data-testid="iqr-tab-blocks"]');
  assert.equal((await page.$$('[data-testid="iqr-block"]')).length, 13, "every block can still be chosen");
  await page.click('[data-testid="iqr-rerun-all"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="iqi-blocks-note"]'), null, { timeout: 90000 });
  assert.equal(await created(), fullCreated);
  await page.click('[data-testid="iqr-close"]');
  assert.equal(await page.$('[data-testid="iqr"]'), null);
  ok("C: Import selected blocks → 20 questions, the outside dependency reported; Re-run with every block → the whole survey again");
}

if (SECTIONS.includes("D")) {
  const docx = readFileSync(new URL("../packages/import/corpus/word/02-complex-instructions.docx", import.meta.url));
  await page.setInputFiles('[data-testid="iq-file"]', { name: "category-study.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: docx });
  await stageIs("estimated");
  await (await (await lastImport()).$('[data-testid="iqi-run"]')).click();
  await stageIs("ready");
  const card = await lastImport();
  const line = await card.$('[data-testid="iqi-behaviour"]');
  assert.ok(line, "the card has a behaviour line");
  assert.match(await line.textContent(), /behaviour: 6 of 6 logic scenarios behave as the source says/);
  assert.equal(await line.getAttribute("data-failed"), "0");
  await (await card.$('[data-testid="iqi-fidelity-btn"]')).click();
  await page.waitForSelector('[data-testid="iqi-behaviour-detail"]');
  const rows = await card.$$eval('[data-testid="iqi-behaviour-row"]', (els) => els.map((e) => [e.getAttribute("data-result"), e.textContent]));
  assert.equal(rows.length, 6);
  assert.ok(rows.every(([r]) => r === "pass"));
  assert.ok(rows.some(([, t]) => /S1: if S1 = No → end \(screened\)/.test(t) && /met — S1 = No/.test(t) && /ended screened/.test(t)), "the screener scenario, its answers and what happened");
  assert.ok(rows.some(([, t]) => /not met/.test(t) && /Q2 not shown/.test(t)), "the not-met side of a display rule");
  ok("D: a Word questionnaire's rules run on the engine — 6 of 6 scenarios behave as the document says, each listed with what was given and what happened");
}

assert.deepEqual(pageErrors, [], "no page errors");
console.log(`\nimport-review: ${passed} passed`);
await browser.close();
