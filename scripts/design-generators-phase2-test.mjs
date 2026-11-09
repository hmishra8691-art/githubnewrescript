/**
 * DESIGN GENERATORS — PHASE 2 (2026-11-09) — browser suite. Studio on :3000 with AI_API_URL=fake: (the sandbox).
 *
 *   1  the library lists Partial-profile CBC (a design method) and the Kano model (a study methodology)
 *   2  the partial-profile sample: every task shows 5 of the 10 attributes; its facts say so; generated and attached
 *   3  Describe it: "partial profile … show 5 attributes per task" → CBC with attributesPerTask, read by the rules in
 *      the sandbox (the AI reading is server-side and metered; the route answers with the rules' reading here)
 *   4  the Kano model: its sample built by the real builder (functional, dysfunctional, importance grids) → Study design
 *   5  no page errors
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const browser = await chromium.launch();
const errors = [];
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
p.on("pageerror", (e) => errors.push(String(e)));
for (let i = 0; i < 20; i++) { try { const r = await fetch(`${STUDIO}/sandbox?mode=studio`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 2000)); }
await p.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "load" });
await p.waitForSelector(".block-badge", { timeout: 60000 });
await switchMode(p, "studio").catch(() => {});
const attachedCount = () => p.$$eval('h3.sec:has-text("Attached design files") ~ .card', (c) => c.length);
const rowsPerTask = (scope) => p.$$eval(`${scope} [data-testid="design-task"]`, (ts) => ts.map((t) => t.querySelectorAll("tbody tr").length));

console.log("\n1 — the library");
await openTab(p, "Design Generators");
await p.waitForSelector('[data-testid="design-workspace"] [data-testid="method-library"]');
const names = await p.$$eval('[data-testid="method-library"] .ml-name', (n) => n.map((x) => x.textContent));
assert.ok(names.includes("Partial-profile CBC") && names.includes("Kano model (feature classification)"), names.join(" | "));
const order = names.indexOf("Partial-profile CBC") - names.indexOf("Choice-based conjoint (CBC)");
assert.equal(order, 1, "listed right after CBC");
ok(`${names.length} methods: Partial-profile CBC after CBC, the Kano model among the studies`);

console.log("\n2 — the partial-profile sample");
await p.click('[data-testid="method-design:conjoint@partial"]');
const scope = '[data-testid="design-method-conjoint@partial"]';
await p.waitForSelector(`${scope} [data-testid="dm-sample"] [data-testid="design-preview"]`, { timeout: 15000 });
const rows = await rowsPerTask(`${scope} [data-testid="dm-sample"]`);
assert.ok(rows.length >= 2 && rows.every((n) => n === 5), `attribute rows per task: ${rows}`);
const facts = await p.textContent(`${scope} [data-testid="design-facts"]`);
assert.match(facts, /Attributes shown per task5 — each attribute in 9 of a respondent.s 18 tasks/);
assert.match(await p.textContent(`${scope} [data-testid="dm-params"]`), /attributes per task: 5/);
const before = await attachedCount();
await p.click('[data-testid="dm-use-sample"]');
await p.waitForSelector('[data-testid="dm-guided"] [data-testid="dg-generate"]');
await p.click('[data-testid="dm-guided"] [data-testid="dg-generate"]');
await p.waitForFunction((n) => document.querySelectorAll('h3.sec ~ .card').length > n, before, { timeout: 30000 }).catch(() => {});
assert.equal(await attachedCount(), before + 1);
const genRows = await rowsPerTask('[data-testid="dm-guided"]');
assert.ok(genRows.length && genRows.every((n) => n === 5), `generated: ${genRows}`);
ok(`every task shows 5 of the 10 attributes (each attribute in 9 of a respondent’s 18 tasks); generated and attached`);

console.log("\n3 — Describe it");
await p.click('[data-testid="dm-tab-describe"]');
await p.fill('[data-testid="dm-describe-text"]', "A partial-profile conjoint for an electric car with 10 attributes, showing 5 attributes per task, 3 alternatives.");
const [resp] = await Promise.all([p.waitForResponse((r) => r.url().includes("/api/designs/interpret")), p.click('[data-testid="dm-understand"]')]);
const body = await resp.json();
assert.equal(body.ok, true); assert.equal(body.source, "rules"); assert.equal(body.read.attributesPerTask, 5);
await p.waitForSelector('[data-testid="dm-recommendation"][data-kind="conjoint"]');
assert.match(await p.textContent('[data-testid="dm-why"]'), /[Pp]artial profile/);
const api = await (await fetch(`${STUDIO}/api/designs/interpret`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) })).json();
assert.match(api.error, /Describe the design/);
ok("“partial profile … 5 attributes per task” → CBC with 5 per task, read by the rules (sandbox); a too-short request refused");

console.log("\n4 — the Kano model");
await p.click('[data-testid="method-study:kano"]');
await p.waitForSelector('[data-testid="study-method-kano"] [data-testid="dm-study-sample"] .dm-qs li');
const qs = await p.$$eval('[data-testid="dm-study-sample"] .dm-qs li', (l) => l.map((x) => x.textContent));
assert.ok(qs.length === 3 && /HAD each/.test(qs[0]) && /did NOT have/.test(qs[1]) && /important/.test(qs[2]), qs.join(" | "));
await p.click('[data-testid="dm-open-study"]');
await p.waitForSelector('[data-testid="study-design"] [data-testid="sd-chosen"]');
assert.match(await p.textContent('[data-testid="sd-chosen"]'), /Kano model/);
ok("the Kano sample: functional, dysfunctional and importance grids → Study design opens with the Kano model chosen");

assert.deepEqual(errors, []);
ok("no page errors");
console.log(`\n${passed} passed`);
await browser.close();
