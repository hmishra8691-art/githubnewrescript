/**
 * LARGE SURVEY GENERATION AS A TASK (ported from K2 onto the base engine, 2026-10-29 — docs/EXECUTION-ENGINE-2026-10-29.md) — acceptance test B
 * against the Studio dev server with the stand-in model (AI_API_URL=fake:; the generation steps' deterministic
 * stand-in is apps/studio/lib/tasks/handlers/generationFake.ts):
 *
 *   [B1] API: "Create a 300-question survey … display logic, skips, quotas and randomization" is planned by the
 *        generation planner (outline → skeleton with codes Q1–Q300 fixed up front → adaptive batches → randomization →
 *        logic per range → quotas → final check); an invalid batch gets a targeted REPAIR and wrong logic a logic
 *        repair (the fake's [fake:…] markers); slices are run one step at a time from outside, as a page or the
 *        cron would, so every completed step is reused by the next slice. The task completes only after the final
 *        check.
 *   [B2] persisted state (GET …?steps=1&result=1): every step completed or replaced, plan version bumped by the
 *        repairs, step validations, usage and idempotency keys; the result is ONE proposal that applies to the
 *        survey with no refusal; 300 unique codes Q1–Q300 in order; display logic (incl. nested AND/OR/NOT), skip
 *        logic, a quota and a randomizer; the deliverable check passes on the applied survey; ids stable across reads
 *   [B3] browser: the same kind of request typed in Intelligent Mode (250 questions) becomes a task, the page is
 *        reloaded midway (a new execution continues the same plan, completed steps reused), the result is reviewed
 *        and applied, and the editor's survey has 250 questions with logic, quotas and a randomizer
 *
 *   flock /tmp/p0/heavy.lock node --experimental-strip-types --no-warnings scripts/large-survey-task-test.mjs
 */
import { chromium } from "./lib/playwright.mjs";
import assert from "node:assert/strict";
import { openTab, switchMode } from "./lib/nav.mjs";
import { applySurveyActions, coerceSurveyActions, validateSurveyDeliverable, parseCompletionCriteria, questionOrder } from "../packages/engine/dist/index.js";
import { SurveyDefinition } from "../packages/schema/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* resilient to a supervised server restart: wait and repeat the same request, never skip the check */
async function api(method, path, body, { tries = 10, timeout = 150_000 } = {}) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${STUDIO}${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) });
      const d = await r.json().catch(() => null);
      if (r.status >= 500 && !(d && d.crashed) && i < tries) { await sleep(6000); continue; }
      return { status: r.status, d };
    } catch (e) { if (i >= tries) throw e; await sleep(6000); }
  }
}

const EMPTY = { meta: { id: "sandbox", code: "S", title: "Streaming study", version: "1.0" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }] };
const advance = (id, maxSteps) => api("POST", `/api/copilot/tasks/${id}/advance`, { surveyId: "sandbox", ...(maxSteps ? { maxSteps } : {}) });
const getTask = (id, q = "") => api("GET", `/api/copilot/tasks/${id}?surveyId=sandbox${q}`);
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** the applied survey: the proposal's actions on the base, as the Studio's Apply replays them */
function applyResult(base, actions) {
  const def = SurveyDefinition.parse(base);
  const r = applySurveyActions(def, coerceSurveyActions(actions, 5000).actions, { now: "2026-10-25T00:00:00.000Z" });
  return r;
}
function inspect(def) {
  const conds = def.questions.filter((q) => q.displayLogic);
  return {
    questions: def.questions.length,
    /* the order respondents meet them in (the flow), not the array the definition stores them in */
    codes: questionOrder(def).map((id) => def.questions.find((q) => q.id === id).code),
    display: conds.length,
    nested: conds.some((q) => { const s = JSON.stringify(q.displayLogic); return s.includes('"op":"not"') && (s.includes('"op":"or"') || s.includes('"op":"and"')); }),
    skips: def.questions.filter((q) => (q.skipLogic ?? []).length).length,
    quotas: def.quotas?.length ?? 0,
    randomizers: JSON.stringify(def.flow).split('"type":"randomizer"').length - 1,
  };
}

/* ============================================================== B1 / B2: the API */
console.log("— B1/B2: 300 questions through the task API —");
let apiTaskId;
/* E1_ONLY_BROWSER=1 runs B3 alone while iterating on the browser part — the acceptance run is always the whole suite */
if (process.env.E1_ONLY_BROWSER === "1") console.log("  (B1/B2 not run: E1_ONLY_BROWSER=1)");
else {
  const message = "Create a 300-question survey on streaming habits with display logic, skips, quotas and randomization [fake:invalid-batch] [fake:bad-logic]";
  const c = await api("POST", "/api/copilot/tasks", { surveyId: "sandbox", message, definition: EMPTY });
  assert.equal(c.status, 200, JSON.stringify(c.d).slice(0, 300));
  apiTaskId = c.d.task.id;
  assert.equal(c.d.task.status, "pending", "created, not built in the request");
  assert.equal(c.d.task.planner, "generation");
  /* run in bounded slices (as the page and the cron do): three steps per slice, so completed steps are reused across many slices */
  let t = null, partialSeen = false, slices = 0;
  const built = new Set();
  for (let i = 0; i < 200; i++) {
    const a = await advance(apiTaskId, 3);
    assert.equal(a.status, 200, JSON.stringify(a.d).slice(0, 300));
    t = a.d?.task; slices++;
    for (const id of a.d.slice?.built ?? []) { assert.ok(!built.has(id), `${id} built twice`); built.add(id); }
    if (t && !partialSeen && t.progress?.completed > 3 && t.status === "running") {
      /* midway: the persisted state is real — a fresh read shows the same completed steps and the plan */
      const mid = (await getTask(apiTaskId, "&steps=1")).d;
      assert.ok(mid.steps.filter((s) => s.status === "completed").length >= 3);
      assert.equal(mid.task.planner, "generation");
      partialSeen = true;
    }
    if (t && (TERMINAL.has(t.status) || t.drive !== "advance")) break;
  }
  assert.equal(t?.status, "completed", `${t?.status}: ${JSON.stringify(t?.report?.problems?.slice(0, 3) ?? null)}`);
  assert.ok(partialSeen, "a partial state was observed and read back");
  ok(`[B1] planned by “generation”, run in ${slices} bounded slices of ≤ 3 steps, completed after the final check (${t.progress.total} steps)`);

  const s = (await getTask(apiTaskId, "&steps=1&result=1")).d;
  const steps = Object.fromEntries(s.steps.map((x) => [x.stepId, x]));
  const cur = Object.values(steps);
  assert.ok(cur.every((x) => x.status === "completed" || x.status === "tombstoned"), cur.filter((x) => x.status !== "completed").map((x) => `${x.stepId}:${x.status}`).join(","));
  assert.ok(s.task.planVersion >= 2, "the repairs made new plan versions");
  const batchRepair = cur.find((x) => x.kind === "gen.batch_repair");
  assert.ok(batchRepair, "an invalid batch got a targeted repair step");
  assert.equal(batchRepair.input.slots.length, 1, "…for exactly the bad question");
  assert.ok(batchRepair.input.errors.some((e) => /needs options/.test(e)), "…with the exact error");
  const logicRepair = cur.find((x) => x.kind === "gen.logic_repair");
  assert.ok(logicRepair && logicRepair.input.errors.some((e) => /QNOPE99/.test(e)), "wrong logic got a logic repair naming the bad reference");
  for (const x of cur) assert.equal(x.retryCount, 0, `${x.stepId} was never retried — completed steps are reused, not rebuilt`);
  for (const x of cur.filter((x) => x.kind?.startsWith("gen."))) assert.ok(x.idempotencyKey?.startsWith(`sandbox:${x.stepId}:`), `${x.stepId} idempotency key`);
  const modelSteps = cur.filter((x) => x.status === "completed" && ["gen.batch", "gen.batch_repair", "gen.design", "gen.logic", "gen.logic_repair", "gen.quotas"].includes(x.kind));
  for (const x of modelSteps) assert.ok(x.usage && x.usage.tokensIn > 0, `${x.stepId} has its own usage`);
  assert.ok(Math.abs(s.task.spend.charge - cur.reduce((n, x) => n + (x.usage?.charge ?? 0), 0)) < 1e-6, "the task's spend is the sum of its steps' (billed once each)");
  assert.equal(s.task.steps.find((x) => x.stepId === "validate").validation.status, "valid");
  ok("[B2] persisted: batch repair for 1 question, logic repair, plan v" + s.task.planVersion + ", no step retried or billed twice, validations stored");

  const r = applyResult(EMPTY, s.result.actions);
  assert.deepEqual(r.errors, [], "the proposal applies with no refusal");
  const info = inspect(r.def);
  assert.equal(info.questions, 300);
  assert.deepEqual(info.codes, Array.from({ length: 300 }, (_, i) => `Q${i + 1}`), "codes Q1–Q300, unique, in order");
  assert.ok(info.display >= 30 && info.nested && info.skips >= 2 && info.quotas >= 1 && info.randomizers >= 1, JSON.stringify(info));
  const rep = validateSurveyDeliverable(r.def, parseCompletionCriteria(s.task.completion));
  assert.equal(rep.ok, true, JSON.stringify(rep.errors.slice(0, 5)));
  const again = (await getTask(apiTaskId, "&result=1")).d;
  assert.deepEqual(again.result.actions, s.result.actions, "the result reads back identically (stable ids, order)");
  ok(`[B2] the proposal applies: 300 questions, ${info.display} display rules (nested AND/OR/NOT), ${info.skips} skips, ${info.quotas} quota, ${info.randomizers} randomizer; deliverable check passes; stable on re-read`);
}

/* ============================================================== B3: the browser */
console.log("— B3: in Intelligent Mode, reloaded midway —");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await context.newPage();
page.on("dialog", (d) => d.accept());
const errors = [];
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|net::ERR|status of (40\d|50\d)/.test(m.text())) errors.push(m.text()); });
const turnResponses = [];
page.on("response", async (r) => { if (r.url().endsWith("/api/copilot/turn") && r.request().method() === "POST") { try { turnResponses.push(await r.json()); } catch { turnResponses.push(null); } } });

const gotoStudio = async () => { for (let i = 0; i < 10; i++) { try { await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "load", timeout: 120_000 }); await page.waitForSelector(".menubar", { timeout: 120_000 }); return; } catch { await sleep(8000); } } throw new Error("Studio not reachable"); };
const loadDef = async (def) => {
  await openTab(page, "JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(600);
};
const intelligent = async () => { await openTab(page, "Questions"); await switchMode(page, "intelligent"); await page.waitForSelector('[data-testid="intelligent-view"]'); };
const readDef = async () => { await openTab(page, "JSON"); await page.waitForSelector("textarea.code"); const json = await page.$eval("textarea.code", (e) => e.value); await intelligent(); return JSON.parse(json); };
const submit = async (text) => {
  await page.$eval('[data-testid="iq-input"]', (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, text);
  await page.focus('[data-testid="iq-input"]');
  await page.keyboard.press("Enter");
};
const reload = async () => { await page.reload({ waitUntil: "load" }).then(() => page.waitForSelector(".menubar", { timeout: 120_000 })).catch(async () => { await sleep(8000); await gotoStudio(); }); await intelligent(); };

/* an earlier run's open or paused sandbox tasks would be reattached by the page: close them first */
for (const t of (await api("GET", "/api/copilot/tasks?surveyId=sandbox")).d?.tasks ?? []) if (!TERMINAL.has(t.status)) await api("POST", `/api/copilot/tasks/${t.id}/cancel`, { surveyId: "sandbox" });
await gotoStudio();
await page.evaluate(() => { try { Object.keys(localStorage).filter((k) => k.startsWith("rescript.copilot.")).forEach((k) => localStorage.removeItem(k)); } catch {} });
await loadDef(EMPTY);
await intelligent();
{
  void turnResponses;
  /* the page does not drive this time: a partial execution happens from outside, then a reload (a new execution) takes over */
  await page.evaluate(() => { window.__rescriptCopilotTaskDrive?.(false); });
  await submit("Create a 250-question survey about mobile banking with display logic, skip logic, quotas and randomization");
  await page.waitForSelector('[data-testid="cp-task"]', { timeout: 90_000 });
  const taskId = await page.evaluate(() => { const c = document.querySelectorAll('[data-testid="cp-task"]'); return c[c.length - 1].getAttribute("data-task-id"); });
  assert.ok(taskId, "the turn answered with a task — no single 250-question model call");
  /* part of it runs (one-step slices from outside the page), then the page is reloaded mid-task */
  let mid = null;
  for (let i = 0; i < 40; i++) { await advance(taskId, 1); mid = (await getTask(taskId, "&steps=1")).d; if (mid.steps.filter((x) => x.status === "completed").length >= 4) break; }
  assert.notEqual(mid.task.status, "completed", "still running when the page is reloaded");
  const before = mid.steps.filter((x) => x.status === "completed").map((x) => x.stepId);
  assert.ok(before.length >= 4, "partial progress before the reload");
  assert.equal(mid.task.planner, "generation");
  await reload();
  await page.waitForSelector(`[data-testid="cp-task"][data-task-id="${taskId}"]`, { timeout: 90_000 });
  await page.waitForFunction((tid) => document.querySelector(`[data-testid="cp-task"][data-task-id="${tid}"]`)?.getAttribute("data-task-status") === "completed", taskId, { timeout: 400_000 });
  const fin = (await getTask(taskId, "&steps=1")).d;
  for (const sid of before) assert.equal(fin.steps.find((x) => x.stepId === sid).retryCount, 0, `${sid} reused after the reload, not regenerated`);
  ok(`[B3] typed in Intelligent Mode → a task (${fin.task.progress.total} steps); reloaded after ${before.length} steps; the same plan continued and completed`);
  await page.click(`[data-testid="cp-task"][data-task-id="${taskId}"] [data-testid="cp-task-review"]`);
  await page.waitForSelector('[data-testid="cp-apply"]', { timeout: 30_000 });
  /* a proposal that replaces something asks for a confirmation first — none is expected from a fresh generation */
  assert.equal(await page.$('[data-testid="cp-confirm"]'), null, "a generated survey on an empty draft replaces nothing");
  await page.click('[data-testid="cp-apply"]');
  await page.waitForTimeout(2500);
  const def = await readDef();
  const info = inspect(SurveyDefinition.parse(def));
  assert.equal(info.questions, 250, `applied: ${info.questions} questions`);
  assert.equal(new Set(info.codes).size, 250, "unique codes");
  assert.ok(info.display >= 20 && info.skips >= 2 && info.quotas >= 1 && info.randomizers >= 1, JSON.stringify(info));
  const rep = validateSurveyDeliverable(def, parseCompletionCriteria(fin.task.completion));
  assert.equal(rep.ok, true, JSON.stringify(rep.errors.slice(0, 5)));
  ok(`[B3] reviewed and applied in the editor: 250 questions, ${info.display} display rules, ${info.skips} skips, ${info.quotas} quota, ${info.randomizers} randomizer — the final check passes on the editor's survey`);
}

assert.deepEqual(errors, [], `console errors: ${errors.join(" | ")}`);
await browser.close();
console.log(`\n${passed} checks passed`);
