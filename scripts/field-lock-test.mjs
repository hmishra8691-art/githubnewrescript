/**
 * FIELD HANDLE AND LOCK (audit 2026-11-17, P1-03) — in the real runtime preview.
 *
 *   node scripts/field-lock-test.mjs     (runtime on :3001; RUNTIME_URL to override)
 *
 * A script attached to Q3 copies S1's answer into Q3 and locks it, through `rs.field(code)`, the per-field handle.
 * Locking a REQUIRED question with no answer yet is refused with its reason (D12): the respondent could not answer
 * it and could not move on. A behaviour can lock too (`do: "lock"`), and the lock is put back when the page is left.
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { sendPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };

const def = {
  meta: { id: "fl", code: "FL", title: "Field lock", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [
    { id: "s1", code: "S1", variableName: "S1", type: "single_select", text: "Specialty", required: false, options: [{ code: 1, label: "Cardiology" }, { code: 2, label: "Oncology" }] },
    { id: "q3", code: "Q3", variableName: "Q3", type: "open_text", text: "Specialty code (filled for you)", required: false },
    { id: "q4", code: "Q4", variableName: "Q4", type: "single_select", text: "Years in practice", required: true, options: [{ code: 1, label: "Under 5" }, { code: 2, label: "5 or more" }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["s1", "q3", "q4"] }, { type: "end", id: "e1", status: "complete" }],
  logicFlow: { nodes: [], edges: [] }, displayRules: [], calculations: [], quotas: [], designs: [], variables: [], embeddedData: [], listFills: [], scripts: [],
  deployment: { clientSlug: "c", studySlug: "s", languages: ["en"], access: { mode: "open" } },
  ux: { styles: [], animations: [], behaviors: [
    { id: "fill", label: "fill Q3 from S1, then lock it", target: { kind: "question", questionId: "q3" }, effects: [],
      script: "rs.listen('change', 'S1', async function () { var s1 = rs.field('S1'); var r = await rs.field('Q3').set(String(s1.value())); rs.log('set ' + JSON.stringify(r)); rs.field('Q3').lock(); });" },
    { id: "lockq4", label: "try to lock the required Q4", target: { kind: "question", questionId: "q4" }, effects: [], script: "rs.lock('Q4');" },
  ] },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
await page.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await sendPreview(page, { definition: def }, { selector: '[data-qid="q3"]' });
await page.waitForTimeout(1200);

const inert = (qid) => page.evaluate((id) => document.querySelector(`[data-qid="${id}"]`)?.closest("[data-qid]")?.hasAttribute("inert") ?? null, qid);
assert.equal(await inert("q4"), false, "a required unanswered question is not locked");
assert.ok(logs.some((l) => /rs\.lock refused: a required question with no answer yet/.test(l)), logs.join("\n"));
ok("rs.lock on a required question with no answer is refused (D12), the question stays answerable");

assert.equal(await inert("q3"), false, "Q3 starts editable");
await page.locator('[data-qid="s1"] label', { hasText: "Oncology" }).click();
await page.waitForFunction(() => document.querySelector('[data-qid="q3"]')?.hasAttribute("inert"), null, { timeout: 8000 });
const v = await page.locator('[data-qid="q3"] input, [data-qid="q3"] textarea').first().inputValue();
assert.equal(v, "2", "S1's code copied into Q3 by the script");
ok("rs.field('Q3').set(rs.field('S1').value()) then .lock(): Q3 holds 2 and is inert (no mouse, keyboard or assistive-tech input)");

await page.locator('[data-qid="q3"] input, [data-qid="q3"] textarea').first().click({ force: true }).catch(() => {});
await page.keyboard.type("999");
assert.equal(await page.locator('[data-qid="q3"] input, [data-qid="q3"] textarea').first().inputValue(), "2", "typing into a locked field changes nothing");
ok("typing into the locked field changes nothing");

await browser.close();
console.log(`\nFIELD LOCK: ${passed} checks passed`);
