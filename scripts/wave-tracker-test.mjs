/**
 * MULTI-WAVE TRACKER (2026-11-09, Rapid Studio phase 3) — browser suite. Studio on :3000 with AI_API_URL=fake: (sandbox).
 *
 *   1  Results → Wave tracker: three waves uploaded — a Qualtrics-style CSV (label row), a CSV whose variable was renamed
 *      and whose scale changed, and an Excel workbook; the sandbox says waves stay in the session; live data is disabled
 *   2  mapping: the renamed variable is found, the 5→7 scale change is flagged not comparable; a manual override applies
 *   3  KPIs are suggested from the baseline; with AGE as a composition check, wave 2's awareness rise (a younger sample)
 *      is reported as sample composition while wave 3's real rise is a genuine change; the trend is tested
 *   4  the CSV download holds one row per KPI × wave with verdicts; the panel's Ask box answers
 *   5  Intelligent Mode answers a tracking question from the same waves
 *   6  no page errors
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const DIR = process.env.TMPDIR_WT ?? "/tmp/claude-0/wave-tracker";
fs.mkdirSync(DIR, { recursive: true });
let passed = 0;
const ok = (m) => { passed++; console.log(`  ok   ${m}`); };

/* deterministic waves: awareness 70 % among the young, 30 % among the old, plus a lift */
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function rows(n, young, lift, seed, satMax) {
  const r = rng(seed);
  return Array.from({ length: n }, () => { const y = r() < young; return { aware: r() < (y ? 0.7 : 0.3) + lift ? 1 : 0, age: y ? 1 : 2, sat: 1 + Math.floor(r() * satMax) }; });
}
const w1 = rows(600, 0.3, 0, 1, 5), w2 = rows(600, 0.7, 0, 2, 7), w3 = rows(600, 0.3, 0.15, 3, 5);
fs.writeFileSync(path.join(DIR, "wave1.csv"), ["AWARE,AGE,SAT", "Are you aware of Brand A?,What is your age group?,How satisfied are you with Brand A?", ...w1.map((x) => `${x.aware},${x.age},${x.sat}`)].join("\n"));
fs.writeFileSync(path.join(DIR, "wave2.csv"), ["AWARE_W2,AGE,SAT", ...w2.map((x) => `${x.aware},${x.age},${x.sat}`)].join("\n"));
const require = createRequire(path.resolve("packages/exporters/package.json"));
const ExcelJS = require("exceljs");
const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Wave 3");
ws.addRow(["Brand tracker — wave 3"]); ws.addRow([]); ws.addRow(["AWARE", "AGE", "SAT"]);
for (const x of w3) ws.addRow([x.aware, x.age, x.sat]);
await wb.xlsx.writeFile(path.join(DIR, "wave3.xlsx"));

const browser = await chromium.launch();
const errors = [];
const p = await (await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true })).newPage();
p.on("pageerror", (e) => errors.push(String(e)));
for (let i = 0; i < 20; i++) { try { const r = await fetch(`${STUDIO}/sandbox?mode=studio`); if (r.status < 500) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 2000)); }
await p.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "load" });
await p.waitForSelector(".block-badge", { timeout: 60000 });
await switchMode(p, "studio").catch(() => {});

console.log("\n1 — three waves uploaded");
await openTab(p, "Wave tracker");
await p.waitForSelector('[data-testid="wave-tracker"]');
assert.match(await p.textContent('[data-testid="wt-note"]'), /Sandbox: waves stay in this browser session/);
assert.ok(await p.isDisabled('[data-testid="wt-live"]'));
const upload = async (file, label, count) => {
  if (label) await p.fill('[data-testid="wt-label"]', label);
  await p.setInputFiles('[data-testid="wt-file"]', path.join(DIR, file));
  await p.waitForFunction((n) => document.querySelectorAll('[data-testid="wt-waves"] tbody tr').length === n, count, { timeout: 20000 });
};
await upload("wave1.csv", "2025 Q1", 1);
await upload("wave2.csv", "2025 Q2", 2);
await upload("wave3.xlsx", "2025 Q3", 3);
const wavesText = await p.textContent('[data-testid="wt-waves"]');
assert.match(wavesText, /2025 Q1baseline/); assert.match(wavesText, /600/);
assert.equal((wavesText.match(/600/g) ?? []).length, 3, "the label row and the workbook's title rows are not respondents");
ok("three waves of 600: CSV with a label row, renamed CSV, Excel with title rows; sandbox note shown; live data disabled");

console.log("\n2 — mapping to the baseline");
const map = await p.textContent('[data-testid="wt-mapping"]');
assert.match(map, /AWARE.*renamed/s); assert.match(map, /variable named AWARE_W2/);
assert.match(map, /scale changed: 1–5 → 1–7/);
ok("AWARE → AWARE_W2 (renamed); SAT flagged: scale changed 1–5 → 1–7");
await p.selectOption('[data-testid="wt-map-AGE"]', "__none");
await p.waitForFunction(() => /not in this wave/.test(document.querySelector('[data-testid="wt-mapping"]')?.textContent ?? ""));
await p.selectOption('[data-testid="wt-map-AGE"]', "__auto");
await p.waitForFunction(() => !/not in this wave/.test(document.querySelector('[data-testid="wt-mapping"]')?.textContent ?? ""));
ok("a manual override (“not asked in this wave”) applies and reverts to automatic");

console.log("\n3 — KPIs, significance and composition");
await p.waitForSelector('[data-testid="wt-results"]');
const kpiRows = await p.$$eval('[data-testid="wt-kpis"] tbody tr', (r) => r.length);
assert.equal(kpiRows, 2, "AWARE (share) and SAT (top box) suggested");
let aware = await p.textContent('[data-testid="wt-kpi-AWARE"]');
assert.match(aware, /Genuine change/, "without composition checks the younger sample looks like brand growth");
await p.check('[data-testid="wt-composition"] input[type=checkbox] >> nth=0');
await p.waitForFunction(() => /Sample composition/.test(document.querySelector('[data-testid="wt-kpi-AWARE"]')?.textContent ?? ""));
aware = await p.textContent('[data-testid="wt-kpi-AWARE"]');
const rowsAware = await p.$$eval('[data-testid="wt-kpi-AWARE"] table tbody tr', (rs) => rs.map((r) => r.textContent));
assert.match(rowsAware[1], /Sample composition/, rowsAware[1]);
assert.match(rowsAware[2], /Genuine change/, rowsAware[2]);
assert.match(aware, /Trend rising/);
assert.ok(await p.$('[data-testid="wt-kpi-AWARE"] svg.wt-chart path.wt-line.adj'), "the matched line is drawn");
assert.match(await p.textContent('[data-testid="wt-comp-table"]'), /shifted/);
const sat = await p.textContent('[data-testid="wt-kpi-SAT"]');
assert.match(sat, /Not comparable/);
ok("wave 2: sample composition (AGE shifted, not significant once matched); wave 3: genuine change; trend rising; SAT across the scale change: not comparable");

console.log("\n4 — download and the panel's Ask box");
const [dl] = await Promise.all([p.waitForEvent("download"), p.click('[data-testid="wt-export"]')]);
const csv = fs.readFileSync(await dl.path(), "utf8").replace(/^﻿/, "");
const lines = csv.trim().split("\n");
assert.equal(lines.length, 1 + 2 * 3);
assert.match(lines[0], /^KPI,Measure,Wave,Value,Base/);
assert.ok(lines.some((l) => /composition/.test(l)) && lines.some((l) => /genuine_change/.test(l)));
ok(`${dl.suggestedFilename()}: ${lines.length - 1} KPI × wave rows with verdicts`);
await p.fill('[data-testid="wt-ask"]', "Is the change in awareness since the last wave real?");
await p.click('[data-testid="wt-ask-go"]');
const ans = await p.textContent('[data-testid="wt-answer"]');
assert.match(ans, /3 waves/); assert.match(ans, /2025 Q3 against 2025 Q2/); assert.match(ans, /a genuine change/);
ok(`Ask: “${ans.slice(0, 120)}…”`);

console.log("\n5 — Intelligent Mode answers from the same waves");
await switchMode(p, "intelligent");
await openTab(p, "Questions").catch(() => {});
await p.waitForSelector('[data-testid="intelligent-view"]');
await p.fill('[data-testid="iq-input"]', "Compare the waves against the baseline — which KPI changes are genuine?");
await p.click('[data-testid="iq-send"]');
await p.waitForFunction(() => /waves \(2025 Q1 n=600/.test(document.querySelector('[data-testid="iq-log"]')?.textContent ?? ""), null, { timeout: 20000 });
const said = await p.textContent('[data-testid="iq-log"]');
assert.match(said, /2025 Q3 against 2025 Q1/); assert.match(said, /Sample composition shifted/);
ok("Intelligent Mode: the vs-baseline comparison, with the composition shift named");

console.log("\n6 — page errors");
assert.deepEqual(errors, []);
ok("no page errors");
await browser.close();
console.log(`\n${passed} passed`);
