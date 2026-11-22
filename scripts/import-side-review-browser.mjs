/**
 * THE SIDE-BY-SIDE REVIEW'S ACCEPTANCE IS KEPT WITH THE IMPORT (I6, 2026-11-22). In the sandbox (fake provider,
 * in-memory import history): import a Qualtrics file, open the review, accept every question imported as written,
 * close the review and open it again — the acceptance comes back from the server, not from the component. Then
 * un-accept one and see the count follow. Needs the Studio running (STUDIO_URL). Exit code 1 on failure.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "./lib/playwright.mjs";
import { switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
const reviewCalls = [];
page.on("request", (r) => { if (/\/api\/import\/sessions\/[^/]+\/review/.test(r.url())) reviewCalls.push(r.method()); });
const lastImport = async () => (await page.$$('[data-testid="iq-import"]')).at(-1);
const stageIs = (s, timeout = 90000) => page.waitForFunction((x) => { const els = document.querySelectorAll('[data-testid="iq-import"]'); return els.length && els[els.length - 1].getAttribute("data-stage") === x; }, s, { timeout });
const acceptedCount = async () => Number(/^(\d+) accepted/.exec(await page.textContent('[data-testid="iqr-side-left"]'))?.[1] ?? NaN);
try {
  await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector(".block-badge", { timeout: 120000 });
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
  await page.setInputFiles('[data-testid="iq-file"]', { name: "simple.qsf", mimeType: "application/json", buffer: readFileSync(new URL("../packages/import/corpus/qsf/01-simple-satisfaction.qsf", import.meta.url)) });
  await stageIs("estimated");
  await (await (await lastImport()).$('[data-testid="iqi-run"]')).click();
  await stageIs("ready");
  const openSide = async () => {
    await (await (await lastImport()).$('[data-testid="iqi-review-open"]')).click();
    await page.waitForSelector('[data-testid="iqr"]');
    await page.click('[data-testid="iqr-tab-side"]');
    await page.waitForSelector('[data-testid="iqr-side-left"]');
  };
  await openSide();
  await page.waitForFunction(() => /Kept with the import|record|only/.test(document.querySelector('[data-testid="iqr-side"]')?.textContent ?? ""), null, { timeout: 20000 });
  assert.equal(await acceptedCount(), 0);
  await page.click('[data-testid="iqr-side-accept-same"]');
  await page.waitForFunction(() => /Kept with the import\./.test(document.querySelector('[data-testid="iqr-side-left"]')?.textContent ?? ""), null, { timeout: 20000 });
  const n = await acceptedCount();
  assert.ok(n >= 1, `accepted ${n}`);
  ok(`"Accept all as written" accepts ${n} questions and says they are kept with the import`);
  await page.click('[data-testid="iqr-close"]');
  await openSide();
  await page.waitForFunction((want) => new RegExp(`^${want} accepted`).test(document.querySelector('[data-testid="iqr-side-left"]')?.textContent ?? ""), n, { timeout: 20000 });
  ok(`closed and opened again: ${n} accepted, read back from the server`);
  const boxes = page.locator('[data-testid="iqr-side-accept"]:checked');
  await boxes.first().uncheck();
  await page.waitForFunction((want) => new RegExp(`^${want} accepted.*Kept with the import`).test(document.querySelector('[data-testid="iqr-side-left"]')?.textContent ?? ""), n - 1, { timeout: 20000 });
  ok(`un-accepting one saves ${n - 1}`);
  assert.ok(reviewCalls.filter((m) => m === "GET").length >= 2 && reviewCalls.filter((m) => m === "POST").length >= 2, JSON.stringify(reviewCalls));
  ok("the review read and wrote through /api/import/sessions/[id]/review");
  assert.deepEqual(errors, []);
  ok("no page errors");
  console.log(`\n${passed} checks passed`);
} catch (e) {
  console.error("FAIL", e.message);
  await page.screenshot({ path: process.env.SHOT ?? "/tmp/import-side-failure.png", fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally { await browser.close(); }
