/**
 * THE OPERATION HISTORY, HONEST COMPLETION, STATE SYNC (Intelligent Mode
 * upgrade, Phase 5 — the audit's R11, R12, R20, R21).
 *
 *   (a) an engine proposal applied: the card says APPLIED · SANDBOX (NOT
 *       SAVED) · AI CHANGE #001 — not "applied" before the editor has it, not
 *       "saved" when nothing was — and History has it: the prompt, Engine,
 *       Applied, #001, the target (a link that selects), what was applied,
 *       the engine operations, no model call
 *   (b) a save refused (`__rescriptSaveFault("conflict")`, the sandbox's
 *       seam): the card says NOT SAVED — CONFLICT with the reason and a
 *       "Try saving again"; History says Not saved
 *   (c) a model turn (fake reply) is recorded with its call; an engine
 *       refusal and an engine answer are recorded too
 *   (f) ⌘Z after an apply marks the entry Reverted ("undone with ⌘Z") — on
 *       the server too; ⌘⇧Z marks it applied again
 *   (g) a grammar proposal that has gone stale is refused at Apply WITHOUT
 *       an undo step, without touching the survey; History says Failed
 *   (d) a reload: History still lists everything (the server keeps it), and
 *       the next change is numbered after the last, not #001 again
 *   (e) Compare shows before → after; Reapply puts the actions back into
 *       the Changes panel as a new proposal; Restore reverts (and asks
 *       first when later edits would go with it)
 *
 *   node scripts/history-test.mjs      (studio on 3000, AI_API_URL=fake:)
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const mod = process.platform === "darwin" ? "Meta" : "Control";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const opts = (...ls) => ls.map((l, i) => ({ code: i + 1, label: l }));
const q = (id, code, variableName, type, text, extra = {}) => ({ id, code, variableName, type, text, ...extra });

const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "History study", version: "1.0" },
  questions: [
    q("gender", "Q1", "GENDER", "single_select", "What is your gender?", { options: opts("Male", "Female") }),
    q("age", "Q2", "AGE", "numeric", "How old are you?"),
    q("city", "Q3", "CITY", "text", "Which city do you live in?"),
    q("aware", "Q4", "AWARE", "single_select", "Have you heard of our brand?", { options: opts("Yes", "No") }),
    q("brands", "Q5", "BRANDS", "multi_select", "Which of these brands have you bought?", { options: [...opts("Brand A", "Brand B", "Brand C"), { code: 99, label: "None of these", flags: ["exclusive"] }] }),
    q("sat", "Q6", "SAT", "single_select", "How satisfied are you overall?", { options: opts("1", "2", "3", "4", "5") }),
    q("nps", "Q7", "NPS", "single_select", "How likely are you to recommend us?", { options: opts("0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10") }),
  ],
  flow: [
    { type: "block", id: "b0", title: "About you", children: [{ type: "page", id: "p0", questionIds: ["gender", "age", "city"] }] },
    { type: "block", id: "b1", title: "Brands", children: [{ type: "page", id: "p1", questionIds: ["aware", "brands", "sat"] }, { type: "page", id: "p2", questionIds: ["nps"] }] },
    { type: "end", id: "e", status: "complete" },
  ],
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } });
/* the sandbox opens on this survey on every load — a reload is the same survey, its history on the server */
await context.addInitScript((f) => { window.__rescriptSandboxSeed = f; }, FIXTURE);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (d) => d.accept());

const turns = () => page.$$('[data-testid="cp-turn"]');
const say = async (text, reply) => {
  if (reply) await page.evaluate((r) => window.__rescriptCopilotFake(r), reply);
  const n = (await turns()).length;
  await page.fill('[data-testid="iq-input"]', text);
  await page.keyboard.press("Enter");
  await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 30000 });
  const last = (await turns()).at(-1);
  if (await last.$('[data-testid="cp-engine"]')) await page.evaluate(() => window.__rescriptCopilotFakeReset?.());
  return last;
};
const panel = async (tab) => { await page.click(`[data-testid="cp-tab-${tab}"]`); await page.waitForTimeout(150); };
const text = async (el, sel) => ((await (sel ? el.$(sel) : el)) ? (await (await (sel ? el.$(sel) : el)).textContent()).replace(/\s+/g, " ").trim() : null);
const intelligent = async () => {
  await openTab(page, "Questions");
  await switchMode(page, "intelligent");
  await page.waitForSelector('[data-testid="intelligent-view"]');
};
const readDef = async () => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  const d = JSON.parse(await page.$eval("textarea.code", (e) => e.value));
  await intelligent();
  return d;
};
/** apply the open proposal from the Changes panel; wait until its card's save has settled */
const applyOpen = async (turn) => {
  await panel("changes");
  await page.waitForSelector('[data-testid="cp-changes"]');
  if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]');
  await page.click('[data-testid="cp-panel-apply"]');
  await page.waitForFunction((el) => el.getAttribute("data-proposal") === "applied" && el.getAttribute("data-save") && el.getAttribute("data-save") !== "saving" && el.getAttribute("data-n"), turn, { timeout: 20000 });
};
/** the History entry with this AI change number (or prompt) */
const entry = async (by) => {
  await panel("history");
  const sel = typeof by === "number" ? `[data-op="true"][data-n="${by}"]` : null;
  if (sel) { await page.waitForSelector(sel, { timeout: 10000 }); return page.$(sel); }
  await page.waitForFunction((p) => [...document.querySelectorAll('[data-op="true"] [data-testid="cp-op-prompt"]')].some((e) => e.textContent.includes(p)), by, { timeout: 10000 });
  for (const e of await page.$$('[data-op="true"]')) if ((await text(e, '[data-testid="cp-op-prompt"]')).includes(by)) return e;
  return null;
};
const attr = (el, a) => el.getAttribute(a);
const expand = async (e) => { if (!(await e.$('[data-testid="cp-op-detail"]'))) await (await e.$('[data-testid="cp-op-expand"]')).click(); await e.waitForSelector('[data-testid="cp-op-detail"]'); };
/** what the server has for an entry — the record itself, not the page's copy */
const serverOp = (n) => page.evaluate(async (num) => {
  const scope = sessionStorage.getItem("rescript.sandboxHistory");
  const r = await fetch(`/api/copilot/operations?surveyId=sandbox&scope=${scope}`, { cache: "no-store" });
  const d = await r.json();
  return d.operations.find((o) => o.changeN === num) ?? null;
}, n);

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".menubar");
await intelligent();
assert.equal((await page.$$('[data-testid="cp-sp-q"]')).length, 7, "the seeded survey is open");
ok("the sandbox opens on the seeded 7-question survey (the same one after a reload)");

/* ------------------------------------------------ (a) an engine proposal, applied: the truth about it */
{
  const t = await say("Make Q3 required");
  assert.ok(await t.$('[data-testid="cp-engine"]'), "read by the engine");
  assert.equal(await attr(t, "data-proposal"), "open");
  await applyOpen(t);
  assert.equal(await text(t, ".iq-kicker"), "APPLIED · SANDBOX (NOT SAVED) · AI CHANGE #001");
  assert.equal(await attr(t, "data-save"), "sandbox");
  await page.waitForSelector(".toast");
  assert.match(await page.textContent(".toast"), /Applied as AI change #001 — the sandbox saves nothing/);
  const e = await entry(1);
  assert.equal(await attr(e, "data-testid"), "cp-change");
  assert.deepEqual([await attr(e, "data-status"), await attr(e, "data-source")], ["applied", "engine"]);
  assert.equal(await text(e, '[data-testid="cp-op-n"]'), "AI Change #001");
  assert.equal(await text(e, '[data-testid="cp-op-status"]'), "Applied");
  assert.equal(await text(e, '[data-testid="cp-op-source"]'), "Engine");
  assert.equal(await text(e, '[data-testid="cp-op-prompt"]'), "“Make Q3 required”");
  assert.ok(await page.$('[data-testid="cp-history-not-durable"]'), "the sandbox's history says where it is kept");
  assert.match(await page.textContent('[data-testid="cp-history-not-durable"]'), /kept in this server's memory, for this browser tab/);
  await expand(e);
  assert.match(await text(e, '[data-testid="cp-op-intent"]'), /kind: actions/);
  assert.equal(await text(e, '[data-testid="cp-op-targets"]'), "Q3");
  assert.ok((await text(e, '[data-testid="cp-op-applied"]')).length > 0, "what was applied, in words");
  assert.match(await text(e, '[data-testid="cp-op-engine-ops"]'), /^[a-z_]+(, [a-z_]+)*$/);
  assert.match(await text(e, '[data-testid="cp-op-api-calls"]'), /^none — read by the Studio's own engine/);
  assert.match(await text(e, '[data-testid="cp-op-status-detail"]'), /Sandbox — nothing is saved here/);
  // the target is a link that selects the question
  await (await e.$('[data-testid="cp-op-target"]')).click();
  await page.waitForTimeout(200);
  assert.equal(await page.$eval('[data-testid="cp-sp-q"].sel', (x) => x.dataset.code), "Q3");
  const rec = await serverOp(1);
  assert.equal(rec.status, "applied"); assert.equal(rec.prompt, "Make Q3 required"); assert.equal(rec.hasBefore, true); assert.equal(rec.hasAfter, true);
  ok(`(a) applied: “${await text(t, ".iq-kicker")}”; History: “Make Q3 required” · Engine · Applied · #001 · target Q3 (selects) · applied · engine ops ${await text(e, '[data-testid="cp-op-engine-ops"]')} · no model call; the server's record holds before and after`);
}

/* ------------------------------------------------ (b) a refused save says NOT SAVED, why, and offers a retry */
{
  const t = await say("Make Q4 required");
  await page.evaluate(() => window.__rescriptSaveFault("conflict"));
  await applyOpen(t);
  assert.equal(await attr(t, "data-save"), "failed");
  assert.equal(await text(t, ".iq-kicker"), "APPLIED · NOT SAVED — CONFLICT · AI CHANGE #002");
  assert.match(await text(t, '[data-testid="cp-save-failed"]'), /NOT saved — this survey changed elsewhere; your save was refused/);
  assert.ok(await t.$('[data-testid="cp-retry-save"]'), "a retry is offered");
  assert.match(await page.textContent(".toast"), /but NOT saved — this survey changed elsewhere/);
  const e = await entry(2);
  assert.equal(await attr(e, "data-status"), "save_failed");
  assert.equal(await text(e, '[data-testid="cp-op-status"]'), "Not saved");
  assert.match(await text(e, '[data-testid="cp-op-not-saved"]'), /Not saved: this survey changed elsewhere/);
  assert.equal((await serverOp(2)).status, "save_failed", "the server's record says it too");
  // the retry runs the same flush: the sandbox's fault was one-shot, so the card now tells the sandbox's truth
  await (await t.$('[data-testid="cp-retry-save"]')).click();
  await page.waitForFunction((el) => el.getAttribute("data-save") === "sandbox", t);
  assert.equal(await text(t, ".iq-kicker"), "APPLIED · SANDBOX (NOT SAVED) · AI CHANGE #002");
  ok("(b) a refused save: “APPLIED · NOT SAVED — CONFLICT · AI CHANGE #002” with the store's reason and Try saving again; History: Not saved (server too); the retry re-flushes");
}

/* ------------------------------------------------ (c) a model turn, an engine refusal, an engine answer */
{
  const m = await say("Reword Q3 to sound friendlier", { kind: "answer", reply: "“Which city do you call home?” reads warmer.", actions: [] });
  assert.ok(!(await m.$('[data-testid="cp-engine"]')), "the model's turn");
  const e = await entry("Reword Q3 to sound friendlier");
  assert.deepEqual([await attr(e, "data-status"), await attr(e, "data-source"), await attr(e, "data-testid")], ["answered", "model", "cp-op"]);
  await expand(e);
  const calls = await e.$$eval('[data-testid="cp-op-api-call"]', (xs) => xs.map((x) => x.textContent));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^\/api\/copilot\/turn · /, calls[0]);
  assert.match(await text(e, '[data-testid="cp-op-intent"]'), /kind: answer/);

  await say("Make Q133 required");
  const r = await entry("Make Q133 required");
  assert.deepEqual([await attr(r, "data-status"), await attr(r, "data-source")], ["refused", "engine"]);
  await expand(r);
  assert.match(await text(r, '[data-testid="cp-op-status-detail"]'), /Q133/);

  await say("What depends on Q5?");
  const a = await entry("What depends on Q5?");
  assert.deepEqual([await attr(a, "data-status"), await attr(a, "data-source")], ["answered", "engine"]);
  ok(`(c) recorded: the model's answer with its call (“${calls[0]}”), the engine's refusal of Q133 with why, the engine's answer about Q5`);
}

/* ------------------------------------------------ (f) ⌘Z and ⌘⇧Z are seen by the history */
{
  const t = await say("Make Q6 required");
  await applyOpen(t);
  const n = Number(await attr(t, "data-n"));
  assert.equal(n, 3);
  await panel("history");
  await page.click('[data-testid="iq-log"]', { position: { x: 5, y: 5 } }).catch(() => {});
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press(`${mod}+z`);
  await page.waitForFunction((k) => document.querySelector(`[data-op="true"][data-n="${k}"]`)?.getAttribute("data-status") === "reverted", n, { timeout: 10000 });
  let e = await entry(n);
  await expand(e);
  assert.equal(await text(e, '[data-testid="cp-op-status-detail"]'), "undone with ⌘Z");
  assert.match(await text(e), /undone/);
  await page.waitForFunction(async (k) => { const s = sessionStorage.getItem("rescript.sandboxHistory"); const d = await (await fetch(`/api/copilot/operations?surveyId=sandbox&scope=${s}`)).json(); return d.operations.find((o) => o.changeN === k)?.status === "reverted"; }, n, { timeout: 10000 });
  assert.equal((await serverOp(n)).statusDetail, "undone with ⌘Z");
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press(`${mod}+Shift+z`);
  await page.waitForFunction((k) => document.querySelector(`[data-op="true"][data-n="${k}"]`)?.getAttribute("data-status") === "applied", n, { timeout: 10000 });
  e = await entry(n);
  await expand(e);
  assert.equal(await text(e, '[data-testid="cp-op-status-detail"]'), "redone with ⌘⇧Z");
  await page.waitForTimeout(400);
  assert.equal((await serverOp(n)).status, "applied", "and on the server");
  assert.equal((await serverOp(n)).changeN, 3, "the redo keeps its number");
  ok("(f) ⌘Z after an apply: #003 Reverted, “undone with ⌘Z” (server too); ⌘⇧Z: applied again, “redone with ⌘⇧Z”, still #003");
}

/* ------------------------------------------------ (g) a grammar proposal refused at Apply leaves no trace in the editor */
{
  const say2 = async (s) => {
    const k = (await page.$$('[data-testid="iq-turn"]')).length;
    await page.fill('[data-testid="iq-input"]', s);
    await page.keyboard.press("Enter");
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="iq-turn"]').length > n, k, { timeout: 20000 });
    return (await page.$$('[data-testid="iq-turn"]')).at(-1);
  };
  // two readings of the same sentence: each fine on its own; the second goes stale when the first is applied
  const g1 = await say2("Add a hidden variable for respondent type");
  const g2 = await say2("Add a hidden variable for respondent type");
  assert.equal(await attr(g1, "data-state"), "open");
  assert.equal(await attr(g2, "data-state"), "open");
  await (await g1.$('[data-testid="iq-apply"]')).click();
  await page.waitForFunction((el) => el.dataset.state === "applied" && el.dataset.save === "sandbox", g1, { timeout: 20000 });
  assert.match(await text(g1, ".iq-kicker"), /^APPLIED · SANDBOX \(NOT SAVED\) · AI CHANGE #004$/);
  const view = '[data-testid="intelligent-view"]';
  const before = { depth: await page.getAttribute(view, "data-undo-depth"), label: await page.getAttribute(view, "data-undo-label"), save: await page.getAttribute(view, "data-save"), questions: (await page.$$('[data-testid="cp-sp-q"]')).length };
  assert.match(before.label, /^Applied proposal: /);
  await (await g2.$('[data-testid="iq-apply"]')).click();
  await g2.waitForSelector('[data-testid="iq-error"]', { timeout: 10000 });
  await page.waitForTimeout(300);
  const after = { depth: await page.getAttribute(view, "data-undo-depth"), label: await page.getAttribute(view, "data-undo-label"), save: await page.getAttribute(view, "data-save"), questions: (await page.$$('[data-testid="cp-sp-q"]')).length };
  assert.deepEqual(after, before, "no undo step, the same undo label, the save state untouched, the survey as it was");
  assert.equal(await attr(g2, "data-state"), "open", "never marked applied");
  assert.match(await text(g2, '[data-testid="iq-error"]'), /already in use/);
  const ge = (await page.$$('[data-op="true"]'));
  await panel("history");
  const failed = [];
  for (const x of await page.$$('[data-op="true"][data-source="grammar"]')) failed.push(await attr(x, "data-status"));
  assert.deepEqual(failed.sort(), ["applied", "failed"], `the grammar's two entries: ${failed}`);
  const fe = await page.$('[data-op="true"][data-source="grammar"][data-status="failed"]');
  await expand(fe);
  assert.match(await text(fe, '[data-testid="cp-op-status-detail"]'), /^Not applied — the engine refused it: .*already in use/);
  void ge;
  ok(`(g) a stale grammar proposal refused at Apply: undo depth ${before.depth} and label “${before.label}” unchanged, survey untouched; History: Grammar · Failed with the engine's reason (the first one: applied as #004)`);
}

/* ------------------------------------------------ (d) a reload: the history is the server's, the numbering continues */
{
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".menubar");
  await intelligent();
  if (!(await page.$('[data-testid="cp-tab-history"]'))) await page.click('[data-testid="iq-toggle-inspector"]');
  await panel("history");
  await page.waitForSelector('[data-op="true"][data-n="4"]', { timeout: 15000 });
  const listed = await page.$$eval('[data-op="true"]', (es) => es.map((e) => `${e.dataset.n || "-"}:${e.dataset.status}:${e.dataset.source}`));
  for (const want of ["1:applied:engine", "2:save_failed:engine", "3:applied:engine", "4:applied:grammar", "-:answered:model", "-:refused:engine", "-:answered:engine", "-:failed:grammar"]) assert.ok(listed.includes(want), `${want} in ${listed.join(" ")}`);
  const prompts = await page.$$eval('[data-op="true"] [data-testid="cp-op-prompt"]', (es) => es.map((e) => e.textContent));
  assert.equal(prompts.at(-1), "“Make Q3 required”", "newest first: the first operation is last");
  const t = await say("Make Q2 required");
  await applyOpen(t);
  assert.equal(await text(t, ".iq-kicker"), "APPLIED · SANDBOX (NOT SAVED) · AI CHANGE #005");
  ok(`(d) after a reload History lists all ${listed.length} operations from the server, newest first; the next change is #005, not #001`);
}

/* ------------------------------------------------ (e) Compare, Reapply, Restore */
{
  // Compare an entry made before the reload: its surveys come from the server's record
  const e1 = await entry(1);
  await (await e1.$('[data-testid="cp-op-compare"]')).click();
  await e1.waitForSelector('[data-testid="cp-compare"][data-state="ready"]', { timeout: 10000 });
  const rows = await e1.$$eval('[data-testid="cp-compare-row"]', (rs) => rs.map((r) => `${r.dataset.code} | ${r.dataset.category} | ${r.textContent.replace(/\s+/g, " ").trim()}`));
  assert.ok(rows.some((r) => /^Q3 \| Required \|/.test(r)), rows.join("\n"));
  const summary = await e1.$$eval('[data-testid="cp-compare-summary"] li', (ls) => ls.map((l) => l.textContent));
  assert.ok(summary.length > 0);
  assert.equal(await e1.$('[data-testid="cp-row-check"]'), null, "read-only: no ticks in what already happened");
  // Reapply: the actions, from the record, proposed again against the survey as it is now
  await (await e1.$('[data-testid="cp-op-reapply"]')).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="cp-panel"]')?.getAttribute("data-tab") === "changes");
  await page.waitForSelector('[data-testid="cp-changes"]');
  const changes = await page.$$eval('[data-testid="cp-modified"] [data-testid="cp-row"]', (rs) => rs.map((r) => `${r.dataset.code} | ${r.dataset.category}`));
  assert.ok(changes.includes("Q3 | Required"), changes.join("\n"));
  const fix = await entry("Reapply AI change #001");
  assert.deepEqual([await attr(fix, "data-status"), await attr(fix, "data-source")], ["proposed", "fix"]);
  await panel("changes");
  await page.click('[data-testid="cp-panel-cancel"]');
  await panel("history");
  await page.waitForFunction(() => document.querySelector('[data-op="true"][data-source="fix"]')?.getAttribute("data-status") === "cancelled", null, { timeout: 10000 });
  // Restore #001 (made before the reload — the survey has changed since): it asks first, and nothing happens until confirmed
  const again1 = await entry(1);
  await (await again1.$('[data-testid="cp-undo-change"]')).click();
  await again1.waitForSelector('[data-testid="cp-revert-warning"]', { timeout: 10000 });
  assert.match(await text(again1, '[data-testid="cp-revert-warning"]'), /has changed since AI change #001.*also undoes the edits made after it/);
  // Restore the latest (#005): the store's own undo, the entry reverted, Q2 optional again
  const e5 = await entry(5);
  await (await e5.$('[data-testid="cp-undo-change"]')).click();
  await page.waitForFunction(() => document.querySelector('[data-op="true"][data-n="5"]')?.getAttribute("data-status") === "reverted", null, { timeout: 10000 });
  const def = await readDef();
  assert.equal(def.questions.find((x) => x.code === "Q2").required, false, "restored");
  await panel("history");
  await page.waitForTimeout(400);
  const r5 = await serverOp(5);
  assert.deepEqual([r5.status, r5.statusDetail], ["reverted", "restored from History"]);
  ok(`(e) Compare #001 (from the server): ${rows.length} row(s) incl. “Q3 | Required”, read-only; Reapply → a new “fix” proposal in Changes (Q3 | Required), cancelled → Cancelled; Restore #001 asks first; Restore #005 reverts it (server: reverted)`);
}

assert.deepEqual(errors.filter((e) => !/ResizeObserver/.test(e)), [], errors.join("\n"));
await browser.close();
console.log(`\n${passed} checks passed`);
