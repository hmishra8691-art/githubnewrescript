/**
 * THE RESEARCH METHODOLOGY ENGINE (2026-11-09) — browser suite. Studio on :3000 with AI_API_URL=fake: (the sandbox).
 *
 *   1  Intelligent Mode: "Which methodology … how much customers would pay" → pricing, Van Westendorp, alternatives
 *   2  Research tools → Study design opens with that objective; a proposed MaxDiff for pricing is flagged
 *   3  Manual: CBC with attributes → design advice (tasks, concepts, minimum sample) → build and check (the real
 *      generator writes the design file; the analysis plan; 100 simulated respondents) → add → the design is in
 *      Design Generators
 *   4  no page errors
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };
const browser = await chromium.launch();
const errors = [];
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1100 } })).newPage();
p.on("pageerror", (e) => errors.push(String(e)));
p.on("dialog", (d) => d.accept());
for (let i = 0; i < 20; i++) { try { const r = await fetch(`${STUDIO}/sandbox?mode=studio`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 2000)); }
await p.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "load" });
await p.waitForSelector(".block-badge", { timeout: 60000 });

console.log("\n1 — Intelligent Mode answers a methodology question");
await switchMode(p, "intelligent");
await openTab(p, "Questions").catch(() => {});
await p.waitForSelector('[data-testid="intelligent-view"]');
await p.fill('[data-testid="iq-input"]', "Which methodology should I use to find out how much customers would pay for our new plan?");
await p.click('[data-testid="iq-send"]');
await p.waitForFunction(() => /I recommend Van Westendorp/.test(document.querySelector('[data-testid="iq-log"]')?.textContent ?? ""), null, { timeout: 20000 });
assert.match(await p.textContent('[data-testid="iq-log"]'), /Alternatives/);
ok("pricing research → Van Westendorp, with why and alternatives");

console.log("\n2 — Study design opens with the objective; a misfit is flagged");
await switchMode(p, "studio").catch(() => {});
await openTab(p, "Study design");
await p.waitForSelector('[data-testid="sd-rec"]', { timeout: 15000 });
assert.equal(await p.getAttribute('[data-testid="sd-rec"]', "data-category"), "pricing");
await p.fill('[data-testid="sd-objective"]', "I want to use MaxDiff to find out how much customers would pay for our new plan");
await p.click('[data-testid="sd-recommend"]');
await p.waitForSelector('[data-testid="sd-misfit"]');
assert.match(await p.textContent('[data-testid="sd-misfit"]'), /cannot measure price sensitivity/);
ok("the objective carried over from Intelligent Mode; MaxDiff for pricing flagged with the reason");

console.log("\n3 — Manual CBC: advice → build and check → add");
await p.click('[data-testid="sd-method"] [data-testid="method-conjoint_pricing"]');
await p.fill('[data-testid="sd-in-attributes"]', "Price: $9, $14, $19\nStorage: 50 GB, 200 GB, 1 TB\nSupport: Email, 24/7 chat");
await p.fill('[data-testid="sd-sample"]', "200");
await p.waitForSelector('[data-testid="sd-advice"][data-method="cbc"]');
const adv = await p.textContent('[data-testid="sd-advice"]');
assert.match(adv, /12 tasks · 3 concepts per task · minimum ≈ \d+ completes/); assert.match(adv, /below the ≈/);
await p.click('[data-testid="sd-preview"]');
await p.waitForSelector('[data-testid="sd-result"]', { timeout: 30000 });
assert.equal(await p.getAttribute('[data-testid="sd-result"]', "data-ok"), "1", await p.textContent('[data-testid="sd-result"]'));
const res = await p.textContent('[data-testid="sd-result"]');
assert.match(res, /1 generated design file/); assert.match(res, /Simulation/);
await p.click('[data-testid="sd-add"]');
await p.waitForSelector('[data-testid="sd-added"]');
await openTab(p, "Design Generators");
await p.waitForTimeout(800);
const dg = await p.textContent("main").catch(() => "");
assert.match(dg, /conjoint|CBC|Conjoint/i);
ok(`advice “${adv.match(/12 tasks[^·]*· [^·]*· minimum ≈ \d+ completes/)[0]}”; built with the real generator, plan and simulation; added — the design is in Design Generators`);

console.log("\n4 — no page errors");
assert.deepEqual(errors, []);
ok("no page errors");
await browser.close();
console.log(`\n${passed} passed`);
