#!/usr/bin/env node
/**
 * THE IMPORT REVIEW'S RECONSTRUCTION TAB, IN THE STUDIO (2026-11-02).
 *
 *   node scripts/import-reconstruction-studio-test.mjs      (Studio on :3000 — STUDIO_URL to change)
 *
 *   A  Word 10 (informal instructions): the card states the synthetic-respondent result; the Reconstruction tab
 *      shows A mapped 4, B 0, C requires attention 2 (Q2 inferred “previous question”, Q7 unread), each C item with
 *      the source's words, the reading, the native implementation and why, and a button to the decision
 *   B  that button opens the Questions tab; answering Q7 (“show the answers selected at Q4”) and confirming Q2
 *      re-analyses: C is empty, everything is mapped
 *   C  Word 08: B lists Q6 — the written copy of a carried list removed, with the reason
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "./lib/playwright.mjs";
import { switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
const lastImport = async () => (await page.$$('[data-testid="iq-import"]')).at(-1);
const stageIs = async (stage, timeout = 90000) => page.waitForFunction((s) => { const els = document.querySelectorAll('[data-testid="iq-import"]'); return els.length && els[els.length - 1].getAttribute("data-stage") === s; }, stage, { timeout });
const word = (f) => readFileSync(new URL(`../packages/import/corpus/word/${f}`, import.meta.url));
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const count = async (k) => Number((await page.textContent(`[data-testid="iqr-recon-count-${k}"] b`)).trim());

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "domcontentloaded", timeout: 120000 });
await page.waitForSelector(".block-badge", { timeout: 120000 });
await switchMode(page, "intelligent");
await page.waitForSelector('[data-testid="intelligent-view"]');

/* ------------------------------------------------------------ A */
await page.setInputFiles('[data-testid="iq-file"]', { name: "10-informal-instructions.docx", mimeType: DOCX, buffer: word("10-informal-instructions.docx") });
await stageIs("estimated");
await (await (await lastImport()).$('[data-testid="iqi-run"]')).click();
await stageIs("ready");
const dyn = await (await lastImport()).$('[data-testid="iqi-dynamics"]');
assert.ok(dyn, "the card states the synthetic-respondent result");
assert.match(await dyn.textContent(), /dynamic lists, loops and piping: 14 of 14 respondent scenarios behave as expected/);
ok("A: the card states 14 of 14 respondent scenarios behave");
await (await (await lastImport()).$('[data-testid="iqi-review-open"]')).click();
await page.waitForSelector('[data-testid="iqr"]');
await page.click('[data-testid="iqr-tab-recon"]');
await page.waitForSelector('[data-testid="iqr-recon"]');
assert.equal(await count("a"), 4); assert.equal(await count("b"), 0); assert.equal(await count("c"), 2);
const cItems = await page.$$('[data-testid="iqr-recon-c"] [data-testid="iqr-recon-item"]');
const cText = await Promise.all(cItems.map((x) => x.textContent()));
assert.ok(cText.some((t) => /^Q2/.test(t) && /previous question/.test(t) && /Carry forward/.test(t)), cText.join(" | "));
assert.ok(cText.some((t) => /^Q7/.test(t) && /Only show the supermarkets they like/.test(t)), cText.join(" | "));
for (const t of cText) assert.match(t, /Source.*Read as.*Rescript.*Why/s);
ok("A: Reconstruction — A 4, B 0, C 2 (Q2 inferred, Q7 unread), each with source, reading, implementation, why");
const aRows = await page.$$('[data-testid="iqr-recon-a"] [data-testid="iqr-recon-item"]');
assert.equal(aRows.length, 4);
assert.ok((await page.$$('[data-testid="iqr-recon-a"] [data-testid="iqr-recon-tested"]')).length >= 3, "the mapped items show their respondent results");
ok("A: group A lists the 4 mapped relationships with their respondent results");

/* ------------------------------------------------------------ B */
const edit = await cItems[cText.findIndex((t) => /^Q7/.test(t))].$('[data-testid="iqr-recon-edit"]');
assert.ok(edit, "Q7 has a decision to change");
await edit.click();
await page.waitForSelector('[data-testid="iqr-questions"]');
ok("B: “Change this reading…” opens the Questions tab");
await page.click('[data-testid="iqr-close"]');
const items = await page.$$('[data-testid="iqi-clarify-item"]');
let answered = 0;
for (const it of items) {
  const kind = await it.getAttribute("data-kind");
  const labels = await it.$$eval("label", (ls) => ls.map((l) => l.textContent));
  const radios = await it.$$('input[type="radio"]');
  if (kind === "dynamic_list") { const i = labels.findIndex((l) => /selected at Q4/.test(l)); assert.ok(i >= 0, labels.join(" | ")); await radios[i].check(); answered++; }
  if (kind === "confirm_dynamic") { await radios[0].check(); answered++; }
}
assert.equal(answered, 2);
await (await (await lastImport()).$('[data-testid="iqi-clarify-apply"]')).click();
await page.waitForSelector('[data-testid="iqi-decided"]', { timeout: 60000 });
assert.match(await page.textContent('[data-testid="iqi-decided"]'), /2 answers applied/);
await (await (await lastImport()).$('[data-testid="iqi-review-open"]')).click();
await page.waitForSelector('[data-testid="iqr"]');
await page.click('[data-testid="iqr-tab-recon"]');
await page.waitForSelector('[data-testid="iqr-recon"]');
assert.equal(await count("c"), 0, "nothing left to attend to");
assert.equal(await count("a"), 6);
ok("B: answering Q7 (selected at Q4) and confirming Q2 re-analyses — A 6, C 0");
await page.click('[data-testid="iqr-close"]');

/* ------------------------------------------------------------ C */
await page.setInputFiles('[data-testid="iq-file"]', { name: "08-carry-forward-masking.docx", mimeType: DOCX, buffer: word("08-carry-forward-masking.docx") });
await stageIs("estimated");
await (await (await lastImport()).$('[data-testid="iqi-run"]')).click();
await stageIs("ready");
await (await (await lastImport()).$('[data-testid="iqi-review-open"]')).click();
await page.waitForSelector('[data-testid="iqr"]');
await page.click('[data-testid="iqr-tab-recon"]');
assert.equal(await count("b"), 1);
const b = await page.textContent('[data-testid="iqr-recon-b"] [data-testid="iqr-recon-item"]');
assert.match(b, /^Q6/); assert.match(b, /CARRY FORWARD SELECTED FROM Q1/); assert.match(b, /codes/);
ok("C: Word 08 — B lists Q6, the written copy of the carried list removed, with the reason");

assert.deepEqual(pageErrors, []);
await browser.close();
console.log(`\nimport-reconstruction-studio: ${passed} passed`);
