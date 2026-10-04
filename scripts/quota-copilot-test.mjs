/**
 * QUOTA INTELLIGENCE (research-intelligence Phase 4).
 *
 *   - the copilot's quota actions through the fake provider: "500 completes,
 *     50/50 gender, three age bands" → one proposal with the interlocked
 *     cells, the limits adding up, the check after the screener; Apply writes
 *     the real quota the Quota dashboard shows
 *   - Intelligent → Quotas: the feasibility review (an uncovered group) with
 *     its fix as a proposal; the quota's cells; live counts (handed in through
 *     the test seam) → the fieldwork advice with the adjustment as a proposal
 *   - update / delete through the copilot, with the destructive confirmation
 *   - a quota sheet (CSV) imported into a proposal, what it could not match
 *     reported in the tab; an Excel workbook through the same route
 *   - the turn route recognises a quota request and sends the quotas with it
 *
 *   node scripts/quota-copilot-test.mjs      (studio on 3000)
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const opts = (...ls) => ls.map((l, i) => ({ code: i + 1, label: l }));

const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Brand tracker", version: "1.0" },
  questions: [
    { id: "gender", code: "S1", variableName: "GENDER", type: "single_select", text: "What is your gender?", options: opts("Male", "Female", "Prefer not to say") },
    { id: "age", code: "S2", variableName: "AGE", type: "numeric", text: "How old are you?", settings: { min: 16, max: 99 } },
    { id: "region", code: "S3", variableName: "REGION", type: "single_select", text: "Which region do you live in?", options: opts("North", "South", "London") },
    { id: "brand", code: "Q1", variableName: "BRAND", type: "single_select", text: "Which brand did you buy last?", options: opts("Brand A", "Brand B", "Other") },
  ],
  flow: [
    { type: "block", id: "b0", title: "Screening", children: [{ type: "page", id: "p0", questionIds: ["gender", "age"] }] },
    { type: "block", id: "b1", title: "Profile", children: [{ type: "page", id: "p1", questionIds: ["region"] }] },
    { type: "block", id: "b2", title: "Brands", children: [{ type: "page", id: "p2", questionIds: ["brand"] }] },
    { type: "end", id: "e", status: "complete" },
  ],
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (d) => d.accept());

const loadDef = async (def) => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(600);
};
const readDef = async () => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  return JSON.parse(await page.$eval("textarea.code", (e) => e.value));
};
const texts = (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
const intelligent = async () => {
  await openTab(page, "Questions");
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
};
const turn = async (reply, message) => {
  await page.evaluate((r) => window.__rescriptCopilotFake(r), reply);
  const n = (await page.$$('[data-testid="cp-turn"]')).length;
  await page.fill('[data-testid="iq-input"]', message);
  await page.keyboard.press("Enter");
  await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 30000 });
  await page.click('[data-testid="cp-tab-changes"]');
  await page.waitForSelector('[data-testid="cp-changes"]');
};
const apply = async () => { await page.click('[data-testid="cp-panel-apply"]'); await page.waitForTimeout(600); };
const checks = (def) => def.flow.map((n, i) => ({ n, i })).filter(({ n }) => n.type === "quota_check").map(({ n, i }) => ({ i, ids: n.quotaIds, onFull: n.onFull.kind }));

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await loadDef(FIXTURE);
ok("fixture loaded: a screener with gender and age, a profile block, a brand block");

await intelligent();
if (!(await page.evaluate(() => typeof window.__rescriptCopilotFake === "function"))) { console.log("  skip  no fake copilot provider in this build"); await browser.close(); process.exit(0); }

/* ------------------------------------------------ the quota in words */
await turn({
  kind: "proposal", reply: "A 500-complete quota, 50/50 by gender, interlocked with three age bands; the check goes after the screener.",
  actions: [{ op: "create_quota", name: "Gender × Age", total: 500, dimensions: [
    { question: "GENDER", bands: [{ label: "Men", codes: ["Male"], share: 50 }, { label: "Women", codes: ["Female"], share: 50 }] },
    { question: "AGE", bands: [{ label: "18–34", min: 18, max: 34, share: 40 }, { label: "35–54", min: 35, max: 54, share: 35 }, { label: "55+", min: 55 }] },
  ] }],
}, "Set up quotas: 500 completes, 50/50 gender, interlocked with 18–34 (40%), 35–54 (35%) and 55+");
{
  const sm = await texts('[data-testid="cp-summary"] li');
  assert.ok(sm.some((t) => /Add quota “Gender × Age” \(6 cells\)/.test(t)), sm.join(" | "));
  assert.equal(await page.$('[data-testid="cp-destructive"]'), null);
  const problems = (await page.$('[data-testid="cp-new-problems"]')) ? await page.textContent('[data-testid="cp-new-problems"]') : "";
  assert.ok(!/allow \d+ completes in all/.test(problems), `the limits add up: ${problems}`);
}
await apply();
let def = await readDef();
assert.equal(def.quotas.length, 1);
const q = def.quotas[0];
assert.deepEqual(q.cells.map((c) => c.limit), [100, 88, 63, 100, 87, 62]);
assert.equal(q.cells.reduce((s, c) => s + c.limit, 0), 500);
assert.equal(q.targetTotal, 500); assert.equal(q.mode, "hard"); assert.equal(q.onFull.kind, "terminate");
assert.deepEqual(checks(def), [{ i: 1, ids: [q.id], onFull: "terminate" }], "the check follows the Screening block");
ok("copilot: one create_quota in words → six interlocked cells on the real codes, limits that add up, the check after the screener");

/* ------------------------------------------------ the Quota dashboard shows the same quota */
await switchMode(page, "studio");
await openTab(page, "Quotas");
await page.waitForSelector('[data-testid="quota-dashboard"]');
assert.ok(await page.$(`[data-testid="quota-card"][data-quota-id="${q.id}"]`), "the dashboard lists the copilot's quota");
{ const expand = await page.$(`[data-testid="quota-card"][data-quota-id="${q.id}"] [data-testid="quota-expand"]`); if (expand) { await expand.click(); await page.waitForTimeout(200); } }
assert.equal((await page.$$(`[data-testid="quota-card"][data-quota-id="${q.id}"] [data-testid="quota-cell"]`)).length, 6);
ok("the Quota dashboard shows the copilot's quota — one quota system, not two");

/* ------------------------------------------------ Intelligent → Quotas: the review, the fix, the counts' advice */
await intelligent();
await page.click('[data-testid="cp-tab-quotas"]');
await page.waitForSelector('[data-testid="cp-quotas"]');
{
  const findings = await page.$$eval('[data-testid="qt-finding"]', (es) => es.map((e) => ({ kind: e.getAttribute("data-kind"), sev: e.getAttribute("data-severity"), t: e.textContent })));
  assert.ok(findings.some((f) => f.kind === "uncovered" && /Prefer not to say|× 17/.test(f.t)), `the review says who is left out: ${JSON.stringify(findings)}`);
  const card = await page.$(`[data-testid="qt-quota"][data-quota-id="${q.id}"]`);
  assert.ok(card);
  assert.equal((await card.$$('[data-testid="qt-cell"]')).length, 6);
  assert.match(await card.$eval('[data-testid="qt-current"]', (e) => e.textContent), /no counts/);
  /* the live counts, through the seam */
  await page.evaluate((c) => window.__rescriptQuotaCounts(c), { [q.id]: { [q.cells[0].id]: 100, [q.cells[1].id]: 60, [q.cells[2].id]: 40, [q.cells[3].id]: 70, [q.cells[4].id]: 55, [q.cells[5].id]: 3 } });
  await page.waitForSelector('[data-testid="qt-advice"]');
  assert.match(await page.$eval(`[data-testid="qt-quota"][data-quota-id="${q.id}"] [data-testid="qt-current"]`, (e) => e.textContent), /328 \/ 500/);
  const advice = await page.$$eval('[data-testid="qt-advice"] li', (es) => es.map((e) => ({ kind: e.getAttribute("data-kind"), t: e.textContent })));
  assert.ok(advice.some((a) => a.kind === "full_while_open" && /Men × 18–34 \(100\/100\) is full while 5 cells still need/.test(a.t)), JSON.stringify(advice));
  assert.ok(advice.some((a) => a.kind === "under_pace" && /Women × 55\+ has 3 of the ~41 expected/.test(a.t)), JSON.stringify(advice));
  /* the adjustment is a proposal */
  await page.click('[data-testid="qt-adjust"] >> nth=0');
  await page.waitForSelector('[data-testid="cp-changes"]');
  const sm = await texts('[data-testid="cp-summary"] li');
  assert.ok(sm.some((t) => /Change quota “Gender × Age”: Men × 18–34 100 → 110/.test(t)), sm.join(" | "));
  await apply();
  def = await readDef();
  assert.equal(def.quotas[0].cells[0].limit, 110);
}
ok("Intelligent → Quotas: the uncovered group found; live counts → a full cell and a slow cell named with the projected shortfall; the adjustment applied as a proposal");

/* ------------------------------------------------ update and delete through the copilot */
await intelligent();
await turn({ kind: "proposal", reply: "Rescaling to 600 and making it soft.", actions: [{ op: "update_quota", quota: "Gender × Age", total: 600, mode: "soft" }] }, "Rescale the gender × age quota to 600 completes and make it soft");
{
  const sm = await texts('[data-testid="cp-summary"] li');
  assert.ok(sm.some((t) => /Change quota “Gender × Age”: soft; total 500 → 600/.test(t)), sm.join(" | "));
  await apply();
  def = await readDef();
  assert.equal(def.quotas[0].mode, "soft"); assert.equal(def.quotas[0].targetTotal, 600);
  assert.equal(def.quotas[0].cells.reduce((s, c) => s + c.limit, 0), 600);
}
await intelligent();
await turn({ kind: "proposal", reply: "Removing the quota.", actions: [{ op: "delete_quota", quota: "Gender × Age" }] }, "Delete the gender × age quota");
{
  await page.waitForSelector('[data-testid="cp-destructive"]');
  assert.match(await page.textContent('[data-testid="cp-destructive"]'), /Removes quota “Gender × Age” \(6 cells\) and its 1 check/);
  assert.ok(await page.$('[data-testid="cp-panel-apply"][disabled]'), "not until confirmed");
  await page.check('[data-testid="cp-confirm"]');
  await apply();
  def = await readDef();
  assert.equal(def.quotas.length, 0); assert.equal(checks(def).length, 0);
}
ok("update_quota rescales and softens; delete_quota is confirmed and takes the check with it");

/* ------------------------------------------------ a quota sheet: CSV through the attach menu */
await intelligent();
{
  const csv = "Gender,Region,Target\nMale,North,100\nMale,South,80\nFemale,North,100\nFemale,South,80\nFemale,Wales,40\nTotal,,400\n";
  await page.click('[data-testid="iq-attach"]');
  await page.waitForSelector('[data-testid="cp-attach-menu"]');
  assert.ok(await page.$('[data-testid="iq-attach-quotas"]'), "the attach menu offers a quota sheet");
  await page.keyboard.press("Escape").catch(() => {});
  await page.setInputFiles('[data-testid="cp-quota-sheet-file"]', { name: "sample-plan.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.waitForSelector('[data-testid="cp-changes"]', { timeout: 20000 });
  const sm = await texts('[data-testid="cp-summary"] li');
  assert.ok(sm.some((t) => /Add quota “sample-plan.csv” \(4 cells\)/.test(t)), sm.join(" | "));
  await page.click('[data-testid="cp-tab-quotas"]');
  await page.waitForSelector('[data-testid="qt-import-note"]');
  const note = await page.textContent('[data-testid="qt-import-note"]');
  assert.match(note, /sample-plan.csv: sample-plan.csv \(long, 5 cells, total 400\) → 1 quota proposed in Changes/);
  assert.match(note, /Columns matched: Gender → S1, Region → S3/);
  assert.match(await page.textContent('[data-testid="qt-import-issues"]'), /row 6: S3 has no option “Wales”/);
  await page.click('[data-testid="cp-tab-changes"]');
  await apply();
  def = await readDef();
  assert.equal(def.quotas.length, 1);
  assert.deepEqual(def.quotas[0].cells.map((c) => [c.label, c.limit]), [["Male × North", 100], ["Male × South", 80], ["Female × North", 100], ["Female × South", 80]]);
  assert.equal(def.quotas[0].targetTotal, 400);
  assert.equal(def.flow[checks(def)[0].i - 1].id, "b1", "the check follows the Profile block, where REGION is asked");
}
ok("a CSV quota sheet → a proposal with the cells the survey can hold; the row it could not match is reported in the Quotas tab");

/* ------------------------------------------------ an Excel workbook through the route */
{
  const ExcelJS = (await import("/home/claude/rescript/packages/import/node_modules/exceljs/excel.js")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Age by Gender");
  ws.addRow(["Age / Gender", "Male", "Female", "Total"]);
  ws.addRow(["18-34", 100, 100, 200]); ws.addRow(["35+", 150, 150, 300]); ws.addRow(["Total", 250, 250, 500]);
  const bytes = Buffer.from(await wb.xlsx.writeBuffer());
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "plan.xlsx");
  form.append("surveyId", "sandbox"); form.append("definition", JSON.stringify(def));
  const r = await fetch(`${STUDIO}/api/import/quotas`, { method: "POST", body: form });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.sheet.quotas[0].layout, "matrix"); assert.equal(d.sheet.quotas[0].cells, 4); assert.equal(d.sheet.quotas[0].total, 500);
  assert.equal(d.actions.length, 1); assert.deepEqual(d.rejected, []);
  assert.equal(d.actions[0].cells.length, 4); assert.equal(d.actions[0].total, 500);
  assert.deepEqual(d.matched, { Age: "S2", Gender: "S1" });
  const bad = await fetch(`${STUDIO}/api/import/quotas`, { method: "POST", body: (() => { const f = new FormData(); f.append("file", new Blob(["hello"], { type: "text/plain" }), "x.txt"); f.append("surveyId", "sandbox"); f.append("definition", JSON.stringify(def)); return f; })() });
  assert.equal(bad.status, 415, "not a spreadsheet");
}
ok("an Excel cross-tab (Age down, Gender across, totals) through the quota-sheet route: four cells, the total, the columns matched; a text file is refused");

/* ------------------------------------------------ the turn route: a quota turn carries the quotas */
{
  const call = async (message) => {
    const r = await fetch(`${STUDIO}/api/copilot/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: "sandbox", message, definition: def, fake: { kind: "answer", reply: "ok" } }) });
    assert.equal(r.status, 200);
    return (await r.json()).context;
  };
  const t = await call("Which quota cells are full?");
  const plain = await call("Reword Q1");
  assert.equal(t.quota, true); assert.equal(plain.quota, false);
  assert.ok(t.outlineChars > plain.outlineChars + 100, `the quota turn's outline carries the cells: ${t.outlineChars} vs ${plain.outlineChars}`);
  assert.ok(t.promptChars - t.outlineChars > plain.promptChars - plain.outlineChars + 1500, "and the prompt carries the guide");
}
ok("the turn route recognises a quota request and sends the quotas and the guide with it");

/* ------------------------------------------------ the review reports quotas */
await intelligent();
await page.click('[data-testid="cp-tab-review"]');
await page.click('[data-testid="cp-run-review"]');
await page.waitForTimeout(800);
assert.match(await page.textContent('[data-testid="cp-panel"]'), /fall outside every cell of “sample-plan.csv”/);
ok("the review reports the quota's uncovered groups");

assert.deepEqual(errors.filter((e) => !/ResizeObserver/.test(e)), [], errors.join("\n"));
await browser.close();
console.log(`\n${passed} checks passed`);
