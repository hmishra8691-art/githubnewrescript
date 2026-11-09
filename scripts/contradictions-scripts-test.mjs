/**
 * RAPID STUDIO PHASE 4 (2026-11-09) — browser suite. Studio on :3000 with AI_API_URL=fake: (the sandbox).
 *
 *   1  Survey Settings → Quality checks → Consistency lists the contradiction checks THIS questionnaire supports:
 *      "None of these" alone, awareness → usage brands, children ≤ household, years ≤ age
 *   2  Scripts: "Check scripts" separates the stages — the AI's total script executed (not validated: no test case),
 *      a guarded script that never ran, a refused one, an on_complete one only generated; the sandbox note says why
 *      nothing is validated; editing the code marks the check stale and records a person as its last writer
 *   3  Intelligent Mode: "Did the AI's scripts run?" answers with the same stages
 *   4  no page errors
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const brands = [{ id: "b1", code: 1, label: "Alpha" }, { id: "b2", code: 2, label: "Beta" }, { id: "b3", code: 3, label: "Gamma" }, { id: "b9", code: 99, label: "None of these", flags: ["exclusive"] }];
const DEF = {
  meta: { id: "sandbox", code: "P4", title: "Phase 4", version: "1.0", schemaVersion: 1, status: "draft" },
  questions: [
    { id: "aw", code: "Q1", variableName: "Q1", type: "multi_select", text: "Which of these brands have you heard of?", required: true, options: brands },
    { id: "us", code: "Q2", variableName: "Q2", type: "multi_select", text: "Which of these brands have you used?", required: true, options: brands.map((b) => ({ ...b, id: `u${b.id}` })) },
    { id: "age", code: "Q3", variableName: "AGE", type: "numeric", text: "How old are you?", required: true, settings: { minValue: 18, maxValue: 99 } },
    { id: "hh", code: "Q4", variableName: "Q4", type: "numeric", text: "How many people live in your household, including yourself?", required: true, settings: { minValue: 1, maxValue: 10 } },
    { id: "ch", code: "Q5", variableName: "Q5", type: "numeric", text: "How many children under 18 live with you?", required: true, settings: { minValue: 0, maxValue: 9 } },
    { id: "yrs", code: "Q6", variableName: "Q6", type: "numeric", text: "For how long have you lived at this address? Number of years.", required: true, settings: { minValue: 0, maxValue: 99 } },
  ],
  calculations: [{ id: "c1", targetVariable: "PEOPLE", label: "People", expression: "0", when: { type: "rule", source: { kind: "question", ref: "hh" }, operator: "gt", value: 100 } }],
  flow: [{ type: "page", id: "p1", questionIds: ["aw", "us"] }, { type: "page", id: "p2", questionIds: ["age", "hh", "ch", "yrs"] }, { type: "end", id: "e1", status: "complete" }],
  scripts: [
    { id: "s_total", name: "People total", scope: "page", ref: "p2", event: "on_submit", code: "setCalc('PEOPLE', get('Q4'));", enabled: true, origin: "ai" },
    { id: "s_never", name: "Large households", scope: "page", ref: "p2", event: "on_submit", code: "flag('large');", enabled: true, origin: "ai", when: { type: "rule", source: { kind: "question", ref: "hh" }, operator: "gt", value: 50 } },
    { id: "s_bad", name: "Imported redirect", scope: "survey", event: "on_load", code: "window.location = 'https://example.com'", enabled: false, origin: "import" },
    { id: "s_end", name: "At the end", scope: "survey", event: "on_complete", code: "flag('done');", enabled: true },
  ],
};

const browser = await chromium.launch();
const errors = [];
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
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

console.log("\n1 — contradiction checks this questionnaire supports");
await openTab(p, "Survey Settings");
await p.waitForSelector('[data-testid="quality-settings"]');
if (!(await p.isChecked('[data-testid="quality-enabled"]'))) await p.click('[data-testid="quality-enabled"]');
await p.click('[data-testid="qrules-consistency"] .row');
await p.waitForSelector('[data-testid="qs-logic-checks"]');
const logic = await p.textContent('[data-testid="qs-logic-checks"]');
for (const re of [/"None of these" alone at Q1/, /brands at Q2 must also be chosen at Q1/, /Q5 must not exceed Q4/, /Q6 \(years\) must not exceed the age at Q3/]) assert.match(logic, re);
for (const id of ["consistency.exclusive_combined", "consistency.funnel", "consistency.part_whole", "consistency.age_years"]) assert.ok(await p.$(`[data-testid="qrule-${id}"]`), id);
ok("Consistency lists: None of these alone · brand funnel Q1 → Q2 · children ≤ household · years ≤ age; the four rules are configurable");

console.log("\n2 — Scripts: generated ≠ executed ≠ validated");
await openTab(p, "Scripts");
await p.waitForSelector('[data-testid="script-lifecycle"]');
assert.equal(await p.getAttribute('[data-testid="logic-script-card"][data-id="s_total"] [data-testid="script-stage"]', "data-stage"), "unchecked");
await p.click('[data-testid="script-check"]');
await p.waitForSelector('[data-testid="script-check-counts"]', { timeout: 30000 });
const stage = (id) => p.getAttribute(`[data-testid="logic-script-card"][data-id="${id}"] [data-testid="script-stage"]`, "data-stage");
assert.equal(await stage("s_total"), "executed");
assert.equal(await stage("s_never"), "not_reached");
assert.equal(await stage("s_bad"), "refused");
assert.equal(await stage("s_end"), "generated");
const why = await p.textContent('[data-testid="logic-script-card"][data-id="s_total"] [data-testid="script-stage"]');
assert.match(why, /last written by AI/); assert.match(why, /Ran for 100 of 100 simulated respondents without errors — not validated: no passing test case checks PEOPLE/);
assert.match(await p.textContent('[data-testid="logic-script-card"][data-id="s_never"] [data-testid="script-stage"]'), /never ran for any of 100 simulated respondents/);
assert.match(await p.textContent('[data-testid="script-check-counts"]'), /sandbox has no test cases/);
ok("People total: executed for 100/100, not validated (no test case) · Large households: never ran · redirect: refused · on_complete: generated only");
const field = '[data-testid="logic-script-card"][data-id="s_total"] [data-testid="script-code"]';
await p.waitForSelector(field, { timeout: 60000 });
await p.click(field);
await p.keyboard.press("Control+End");
await p.keyboard.type("\nlog('checked');");
await p.click("h2:has-text('Custom Scripts')"); // leaving the field saves, as in the code-editor suite
await p.waitForSelector('[data-testid="script-check-stale"]', { timeout: 10000 });
await p.click('[data-testid="script-check"]');
await p.waitForFunction(() => !document.querySelector('[data-testid="script-check-stale"]'));
assert.match(await p.textContent('[data-testid="logic-script-card"][data-id="s_total"] [data-testid="script-stage"]'), /last written by person/);
ok("an edit marks the check stale; re-checked, the script is now last written by a person");

console.log("\n3 — Intelligent Mode");
await switchMode(p, "intelligent");
await openTab(p, "Questions").catch(() => {});
await p.waitForSelector('[data-testid="intelligent-view"]');
await p.fill('[data-testid="iq-input"]', "Did the AI's scripts run? Which ones are validated?");
await p.click('[data-testid="iq-send"]');
await p.waitForFunction(() => /logic scripts, checked against 100 simulated respondents/.test(document.querySelector('[data-testid="iq-log"]')?.textContent ?? ""), null, { timeout: 30000 });
const said = await p.textContent('[data-testid="iq-log"]');
assert.match(said, /4 logic scripts, checked against 100 simulated respondents: 1 refused, 1 never ran, 1 generated, 1 executed/);
assert.match(said, /only “validated” means a passing test case checked what the script produces/);
ok("answered with the four stages and what validated means");

console.log("\n4 — page errors");
assert.deepEqual(errors, []);
ok("no page errors");
await browser.close();
console.log(`\n${passed} passed`);
