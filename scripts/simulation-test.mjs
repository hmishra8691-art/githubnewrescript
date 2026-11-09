/**
 * SIMULATED TEST RESPONDENTS (2026-11-09) — browser suite. Studio on :3000 with AI_API_URL=fake: (the sandbox).
 *
 *   1  Intelligent Mode: "Generate 60 test responses …" runs through the real engine and answers with the findings
 *   2  Research tools → Tests opens with that run: verdict, endings, coverage, journeys; a journey opens
 *   3  Manual: count, expectations (one right, one wrong) → expected vs actual shows the broken one with examples
 *   4  Download CSV and Excel: every row a TEST respondent SIM-<run>-…; Save is disabled in the sandbox (no database)
 *   5  no page errors
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const DEF = {
  meta: { id: "sandbox", code: "SIMT", title: "Car study", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Do you own a car?", required: true, options: [{ id: "o1", code: 1, label: "Yes" }, { id: "o2", code: 2, label: "No" }] },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Which brand?", required: true, displayLogic: { type: "rule", source: { kind: "question", ref: "q1" }, operator: "eq", value: 1 }, randomization: { enabled: true }, settings: { recordOrder: true }, options: [{ id: "a", code: 1, label: "A" }, { id: "b", code: 2, label: "B" }, { id: "c", code: 3, label: "C" }] },
    { id: "q3", code: "Q3", variableName: "Q3", type: "numeric", text: "Age", required: true, validation: [{ kind: "min_value", value: 18 }, { kind: "max_value", value: 99 }] },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2"] }, { type: "page", id: "p2", questionIds: ["q3"] }, { type: "end", id: "e1", status: "complete" }],
};

const browser = await chromium.launch();
const errors = [];
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true })).newPage();
p.on("pageerror", (e) => errors.push(String(e)));
p.on("dialog", (d) => d.accept());
for (let i = 0; i < 20; i++) { try { const r = await fetch(`${STUDIO}/sandbox?mode=studio`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 2000)); }
await p.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "load" });
await p.waitForSelector(".block-badge", { timeout: 60000 });
await switchMode(p, "studio").catch(() => {});
await openTab(p, "JSON");
await p.waitForSelector("textarea.code");
await p.click('button:has-text("edit")');
await p.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(DEF));
await p.click('button:has-text("validate & apply")');
await p.waitForTimeout(1200);

console.log("\n1 — Intelligent Mode runs the simulation from a sentence");
await p.keyboard.press("Escape").catch(() => {});
await switchMode(p, "intelligent").catch(async (e) => { await p.screenshot({ path: "/tmp/claude-0/sim-fail.png" }); throw e; });
await openTab(p, "Questions").catch(() => {});
await p.waitForSelector('[data-testid="intelligent-view"]');
await p.fill('[data-testid="iq-input"]', "Generate 60 test responses and thoroughly test the questionnaire, including skip logic, randomization and validation");
await p.click('[data-testid="iq-send"]');
await p.waitForFunction(() => /simulated test respondents went through the survey/.test(document.querySelector('[data-testid="iq-log"]')?.textContent ?? ""), null, { timeout: 30000 });
const said = await p.textContent('[data-testid="iq-log"]');
assert.match(said, /60 simulated test respondents/); assert.match(said, /Validation probes/);
ok(`answered: “${said.match(/60 simulated[^.]*\./)?.[0]}”`);

console.log("\n2 — the full report in Research tools → Tests");
await switchMode(p, "studio").catch(() => {});
await openTab(p, "Tests");
await p.waitForSelector('[data-testid="sim-report"]', { timeout: 15000 });
const rows = await p.$$('[data-testid="sim-journey-row"]');
assert.equal(rows.length, 60);
assert.match(await p.textContent('[data-testid="sim-report"]'), /Coverage/);
await rows[0].$('[data-testid="sim-open"]').then((b) => b.click());
await p.waitForSelector('[data-testid="sim-journey"]');
assert.match(await p.textContent('[data-testid="sim-journey"]'), /p1: shown Q1/);
ok("the Intelligent run is waiting in Tests: 60 journeys, coverage, a journey opens (pages, shown, hidden by logic)");

console.log("\n3 — Manual: expectations checked against what actually happened");
await p.click('[data-testid="sim-mode-manual"]');
await p.fill('[data-testid="sim-count"]', "50");
await p.fill('[data-testid="sim-expect"]', "Q2 shown when Q1 = 1\nQ2 hidden when Q1 = 2\nQ2 shown");
await p.click('[data-testid="sim-run"]');
await p.waitForFunction(() => document.querySelectorAll('[data-testid="sim-expectation"]').length === 3, null, { timeout: 30000 });
const broken = await p.$$eval('[data-testid="sim-expectation"]', (e) => e.map((x) => Number(x.getAttribute("data-broken"))));
assert.deepEqual(broken.slice(0, 2), [0, 0]); assert.ok(broken[2] > 0, "the wrong expectation is reported broken");
assert.equal(await p.getAttribute('[data-testid="sim-report"]', "data-ok"), "0");
ok(`expected vs actual: right expectations met, the wrong one broken for ${broken[2]} respondents`);

console.log("\n4 — downloads; saving needs a project");
const [csv] = await Promise.all([p.waitForEvent("download"), p.click('[data-testid="sim-csv"]')]);
const text = await (await import("node:fs")).promises.readFile(await csv.path(), "utf8");
const lines = text.trim().split(/\r?\n/);
assert.equal(lines.length, 51, `header + 50 rows (${lines.length})`);
assert.match(lines[1], /SIM-[A-Z0-9]+-0001/);
const [xl] = await Promise.all([p.waitForEvent("download"), p.click('[data-testid="sim-xlsx"]')]);
const buf = await (await import("node:fs")).promises.readFile(await xl.path());
assert.equal(buf.subarray(0, 2).toString(), "PK", "a real .xlsx");
assert.equal(await p.isDisabled('[data-testid="sim-store"]'), true);
ok(`CSV ${lines.length - 1} SIM rows; Excel ${buf.length} bytes; “Save as test data” disabled in the sandbox`);

console.log("\n5 — no page errors");
assert.deepEqual(errors, []);
ok("no page errors");
await browser.close();
console.log(`\n${passed} passed`);
