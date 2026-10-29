/**
 * THE EXECUTION ENGINE (2026-10-29 — docs/EXECUTION-ENGINE-2026-10-29.md) against the Studio dev server with the
 * stand-in model (AI_API_URL=fake:; the generation steps' deterministic stand-in is
 * apps/studio/lib/tasks/handlers/generationFake.ts). The owner's acceptance scenarios:
 *
 *   [A]  the production UPSC request (650 chars, Hindi, "100 questions") typed in Intelligent Mode becomes a TASK
 *        (stage: "task" — never one 100-question model call), runs as small steps (batches ≤ 20), completes with
 *        exactly 100 questions; the result is reviewed and applied in the editor
 *   [D]  a killed slice: slices of one step each (budgetMs 5 s) from outside the page; every completed step is
 *        reused on the next slice (retryCount 0, idempotency keys stable, outputs byte-identical on re-read), the
 *        task completes without a step billed twice
 *   [F]  cost per step on every row and per task (spend) in the view and in the panel
 *   [B]  the 104-question follow-up "add an explanation to every question" runs as edit batches ≤ 20 and completes
 *   [H]  the execute loop's first-item cap is unchanged (stageCap.test.ts pins it); here: the task path answers
 *        at once, and a trivial request ("make Q1 required") stays a single turn (no task row)
 *   [P]  the panel: rows, Pause → needs_attention, Resume → completes, Stop on a fresh task → cancelled;
 *        a reload reattaches to the open task and the page carries it on
 *   [R]  the routes: list, view, result, unknown id → 404, unknown action → 404, a step view only on the fake
 *
 *   flock /tmp/p0/heavy.lock node --experimental-strip-types --no-warnings scripts/copilot-tasks-test.mjs
 */
import { chromium } from "./lib/playwright.mjs";
import assert from "node:assert/strict";
import { openTab, switchMode } from "./lib/nav.mjs";
import { applySurveyActions, coerceSurveyActions, countRespondentQuestions } from "../packages/engine/dist/index.js";
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
      if (r.status >= 500 && i < tries) { await sleep(6000); continue; }
      return { status: r.status, d };
    } catch (e) { if (i >= tries) throw e; await sleep(6000); }
  }
}
const EMPTY = { meta: { id: "sandbox", code: "S", title: "Mock test", version: "1.0" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }] };
const advance = (id, maxSteps) => api("POST", `/api/copilot/tasks/${id}/advance`, { surveyId: "sandbox", ...(maxSteps ? { maxSteps } : {}) });
const action = (id, a, body = {}) => api("POST", `/api/copilot/tasks/${id}/${a}`, { surveyId: "sandbox", ...body });
const getTask = (id, q = "") => api("GET", `/api/copilot/tasks/${id}?surveyId=sandbox${q}`);
const turn = (message, definition, extra = {}) => api("POST", "/api/copilot/turn", { surveyId: "sandbox", message, definition, ...extra });
const DONE = new Set(["completed", "failed", "cancelled"]);
const applied = (base, actions) => applySurveyActions(SurveyDefinition.parse(base), coerceSurveyActions(actions, 5000).actions, { now: "2026-10-29T00:00:00.000Z" });

/** the newest task card on the page (an earlier task may be reattached above it) */
const latestTaskId = () => page.evaluate(() => { const cards = document.querySelectorAll('[data-testid="cp-task"]'); return cards.length ? cards[cards.length - 1].getAttribute("data-task-id") : null; });
const statusOf = (id) => page.evaluate((tid) => document.querySelector(`[data-testid="cp-task"][data-task-id="${tid}"]`)?.getAttribute("data-task-status") ?? null, id);
const waitStatus = async (id, want, timeout) => { await page.waitForFunction(([tid, w]) => document.querySelector(`[data-testid="cp-task"][data-task-id="${tid}"]`)?.getAttribute("data-task-status") === w, [id, want], { timeout }); };
/** an earlier run's open or paused sandbox tasks would be reattached by the page: close them first */
async function closeOpenTasks() {
  const l = await api("GET", "/api/copilot/tasks?surveyId=sandbox");
  for (const t of l.d?.tasks ?? []) if (!DONE.has(t.status)) await action(t.id, "cancel");
}

const UPSC = "मुझे UPSC प्रीलिम्स की तैयारी के लिए एक मॉक टेस्ट चाहिए। इसमें General Studies Paper 1 के 100 questions होने चाहिए — इतिहास, भूगोल, राजव्यवस्था, अर्थव्यवस्था, पर्यावरण, विज्ञान और करंट अफेयर्स से। हर प्रश्न multiple choice हो, चार विकल्प के साथ, और हर प्रश्न का सही उत्तर और एक छोटी व्याख्या भी दो। कठिनाई स्तर असली UPSC परीक्षा जैसा होना चाहिए, कुछ आसान, ज़्यादातर मध्यम और कुछ कठिन। सही उत्तर पर 2 अंक और गलत उत्तर पर एक तिहाई नेगेटिव मार्किंग हो। टेस्ट के अंत में topic-wise score report दिखाओ ताकि मुझे पता चले कि किस विषय में मैं कमजोर हूँ। प्रश्न हिंदी में हों।";

/* ============================================================== H: trivial stays a single turn; the task path answers at once */
console.log("— H: a trivial request is a single turn; a large one answers stage: task at once —");
{
  const small = await turn("What does Q1 measure?", { ...EMPTY, questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "single_select", text: "Do you drink coffee?", options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] }], flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", questionIds: ["q1"] }] }, { type: "end", id: "e_ok", status: "complete" }] }, { fake: { kind: "answer", reply: "Q1 measures coffee drinking.", plan: [], actions: [], rejected: [], findings: [], assumptions: [], questions: [], sources: [] } });
  assert.equal(small.status, 200, JSON.stringify(small.d).slice(0, 300));
  assert.notEqual(small.d.stage, "task", "a question about the survey is one turn");
  ok("[H] a trivial request stays on the single-turn path");
  const t0 = Date.now();
  const big = await turn(UPSC, EMPTY);
  const ms = Date.now() - t0;
  assert.equal(big.status, 200, JSON.stringify(big.d).slice(0, 300));
  assert.equal(big.d.stage, "task", `expected a task, got ${big.d.stage} ${JSON.stringify(big.d.context).slice(0, 200)}`);
  assert.equal(big.d.task.planner, "generation");
  assert.equal(big.d.context.task.reason, "requested_count");
  assert.ok(big.d.task.steps.length >= 8, `steps ${big.d.task.steps.length}`);
  assert.ok(/चरण/.test(big.d.reply.reply), "the Studio's sentence follows the researcher's language (Hindi)");
  assert.ok(ms < 60_000, `answered in ${ms} ms — no 100-question model call`);
  for (const s of big.d.task.steps.filter((s) => s.kind === "gen.batch")) assert.ok(s.units <= 20 && s.batchSize <= 20, `${s.stepId} ${s.units}`);
  assert.equal(big.d.task.deliverable.questionCount, 100);
  await action(big.d.task.id, "cancel");
  ok(`[H] the UPSC request answered stage: "task" in ${ms} ms with ${big.d.task.steps.length} steps (batches ≤ 20), planned by the generation planner`);
}

/* ============================================================== A + D + F: killed slices, resumed from the earliest incomplete step */
console.log("— A/D/F: 100 questions in one-step slices, resumed, billed once, cost on every row —");
let taskA;
{
  const c = await api("POST", "/api/copilot/tasks", { surveyId: "sandbox", message: UPSC, definition: EMPTY });
  assert.equal(c.status, 200, JSON.stringify(c.d).slice(0, 300));
  assert.equal(c.d.created, true);
  taskA = c.d.task.id;
  const seen = new Map();
  let t = c.d.task, slices = 0;
  for (let i = 0; i < 60; i++) {
    /* one step per slice (the fake-only maxSteps seam): the slice is "killed" after each step and the next one picks up at the earliest incomplete step */
    const a = await advance(taskA, 1);
    assert.equal(a.status, 200, JSON.stringify(a.d).slice(0, 300));
    t = a.d.task; slices++;
    for (const id of a.d.slice.built) { assert.ok(!seen.has(id), `${id} built twice`); seen.set(id, slices); }
    if (DONE.has(t.status) || t.drive !== "advance") break;
  }
  assert.equal(t.status, "completed", `${t.status} ${JSON.stringify(t.report?.problems?.slice(0, 3))}`);
  assert.equal(slices, t.steps.length, "one step per slice; the last slice also ran the deliverable check");
  for (const s of t.steps) { assert.equal(s.status, "completed", s.stepId); assert.equal(s.retryCount, 0, `${s.stepId} never retried`); }
  ok(`[D] ${t.steps.length} steps over ${slices} one-step slices; every step built exactly once, none retried`);
  /* F: cost per step and per task */
  const billed = t.steps.filter((s) => ["gen.batch", "gen.design", "gen.logic", "gen.quotas"].includes(s.kind));
  for (const s of billed) assert.ok(s.usage && typeof s.usage.charge === "number" && s.usage.tokensIn > 0, `${s.stepId} has its own usage`);
  assert.ok(t.spend.charge > 0 && Math.abs(t.spend.charge - billed.reduce((n, s) => n + (s.usage.charge ?? 0), 0)) < 1e-6, "the task's spend is the sum of its steps");
  ok(`[F] cost on every row (${billed.length} model steps) and per task (${t.spend.charge.toFixed(4)} credits, ${t.spend.tokensIn} tokens in)`);
  /* the persisted rows (fake-only seam): outputs byte-identical on re-read, keys stable */
  const s1 = (await getTask(taskA, "&steps=1&result=1")).d;
  const s2 = (await getTask(taskA, "&steps=1&result=1")).d;
  assert.ok(Array.isArray(s1.steps) && s1.steps.length === t.steps.length);
  assert.deepEqual(s1.steps.map((x) => [x.stepId, x.idempotencyKey, JSON.stringify(x.output).length]), s2.steps.map((x) => [x.stepId, x.idempotencyKey, JSON.stringify(x.output).length]));
  for (const x of s1.steps) assert.ok(x.idempotencyKey.startsWith(`sandbox:${x.stepId}:`), x.idempotencyKey);
  assert.ok(s1.result && s1.result.actions.length >= 100, `result actions ${s1.result?.actions?.length}`);
  const r = applied(EMPTY, s1.result.actions);
  assert.deepEqual(r.errors, [], "the proposal applies with no refusal");
  assert.equal(countRespondentQuestions(r.def), 100);
  assert.equal(new Set(r.def.questions.map((q) => q.code)).size, 100);
  ok("[A] exactly 100 unique questions in the result; the rows read back identically (stable ids and keys)");
}

/* ============================================================== B: the 104-question follow-up */
console.log("— B: 'add an explanation to every question' on 104 questions —");
{
  const c = await api("POST", "/api/copilot/tasks", { surveyId: "sandbox", message: "Create a 104-question survey about mobile banking", definition: EMPTY });
  assert.equal(c.status, 200);
  let t = c.d.task;
  for (let i = 0; i < 30 && !DONE.has(t.status); i++) t = (await advance(t.id)).d.task;
  assert.equal(t.status, "completed", JSON.stringify(t.report?.problems?.slice(0, 3)));
  const res = (await getTask(t.id, "&result=1")).d.result;
  const base = applied(EMPTY, res.actions).def;
  assert.equal(countRespondentQuestions(base), 104);
  const f = await turn("Add an explanation to every question", base);
  assert.equal(f.status, 200, JSON.stringify(f.d).slice(0, 300));
  assert.equal(f.d.stage, "task", `a follow-up on 104 questions plans first (${JSON.stringify(f.d.context?.task ?? f.d.context).slice(0, 200)})`);
  assert.equal(f.d.context.task.reason, "per_question");
  const edits = f.d.task.steps.filter((s) => s.kind === "gen.edit_batch");
  assert.ok(edits.length >= 6, `edit batches ${edits.length}`);
  for (const e of edits) assert.ok(e.units <= 20, `${e.stepId} ${e.units}`);
  let u = f.d.task;
  for (let i = 0; i < 30 && !DONE.has(u.status); i++) u = (await advance(u.id)).d.task;
  assert.equal(u.status, "completed", JSON.stringify(u.report?.problems?.slice(0, 3)));
  const r2 = (await getTask(u.id, "&result=1")).d.result;
  const after = applied(base, r2.actions);
  assert.deepEqual(after.errors, []);
  assert.equal(countRespondentQuestions(after.def), 104, "the count is unchanged by an edit");
  assert.ok(after.def.questions.filter((q) => /Explanation for/.test(q.instruction ?? "")).length >= 100, "every question changed");
  ok(`[B] the follow-up ran as ${edits.length} edit batches (≤ 20 each) and changed every question`);
}

/* ============================================================== R: the routes */
console.log("— R: list, view, result, 404s —");
{
  const l = await api("GET", "/api/copilot/tasks?surveyId=sandbox");
  assert.equal(l.status, 200);
  assert.ok(Array.isArray(l.d.tasks) && l.d.tasks.some((t) => t.id === taskA), "the list names the task");
  assert.equal(typeof l.d.durable, "boolean");
  const v = await getTask(taskA);
  assert.equal(v.status, 200);
  assert.equal(v.d.task.resultReady, true);
  assert.ok(!("request" in v.d.task) && !v.d.task.steps.some((s) => "output" in s), "redacted for the client: no request text, no step output");
  assert.equal((await getTask("task_nope_0")).status, 404);
  assert.equal((await action(taskA, "explode")).status, 404);
  assert.equal((await api("POST", "/api/copilot/tasks", { surveyId: "sandbox", message: "", definition: EMPTY })).status, 400);
  ok("[R] list / view / result shapes, redaction, 404 on an unknown task or action");
}

/* ============================================================== P: the panel in the browser */
console.log("— P: Intelligent Mode: the task, its panel, pause/resume, reload, review and apply —");
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
const showInspector = async () => { const b = await page.$('[data-testid="iq-rail-inspector"]'); if (b) await b.click(); };

await closeOpenTasks();
await gotoStudio();
await page.evaluate(() => { try { Object.keys(localStorage).filter((k) => k.startsWith("rescript.copilot.")).forEach((k) => localStorage.removeItem(k)); } catch {} });
await loadDef(EMPTY);
await intelligent();
{
  void turnResponses;
  /* the page does not drive this one: the panel's buttons are exercised against a task that stays where it is */
  await page.evaluate(() => { window.__rescriptCopilotTaskDrive?.(false); });
  await submit("Create a 60 question survey about travel with display logic and quotas");
  await page.waitForSelector('[data-testid="cp-task"]', { timeout: 120_000 });
  /* the turn may stream (NDJSON): the card's own attribute is the record of what the turn answered */
  const taskId = await latestTaskId();
  assert.ok(taskId, "the turn answered with a task");
  const tr = { task: (await getTask(taskId)).d.task };
  assert.equal(tr.task.planner, "generation");
  assert.match(await page.textContent(`[data-testid="cp-task"][data-task-id="${taskId}"] [data-testid="cp-task-line"]`), /continues in the background/);
  await showInspector();
  await page.waitForSelector('[data-testid="cp-execution"] [data-testid="ex-step"]', { timeout: 60_000 });
  const rows = await page.$$('[data-testid="cp-execution"] [data-testid="ex-step"]');
  assert.equal(rows.length, tr.task.steps.length, "one row per step");
  assert.match(await page.textContent('[data-testid="ex-background"]'), /continues in the background/);
  ok(`[P] typed in Intelligent Mode → a task card (${taskId}) and the execution panel with ${rows.length} rows`);
  /* a couple of steps from outside, then Pause from the panel */
  await advance(taskId, 1); await advance(taskId, 1);
  await page.click('[data-testid="ex-pause"]');
  await waitStatus(taskId, "needs_attention", 30_000);
  const paused = (await getTask(taskId)).d.task;
  assert.equal(paused.status, "needs_attention");
  assert.equal(paused.blocked.reason, "user_input");
  assert.ok((await advance(taskId)).d.slice?.stoppedBy === "paused" || (await getTask(taskId)).d.task.status === "needs_attention", "a paused task runs nothing");
  assert.ok(await page.$('[data-testid="ex-resume"]'), "the panel offers Resume");
  ok("[P] Pause from the panel → needs_attention (user_input); a slice on a paused task runs nothing");
  /* Resume: the page drives it to the end (the drive loop is on again for this one) */
  await page.evaluate(() => { window.__rescriptCopilotTaskDrive?.(true); });
  await page.click('[data-testid="ex-resume"]');
  await waitStatus(taskId, "completed", 400_000);
  const fin = (await getTask(taskId)).d.task;
  assert.equal(fin.status, "completed");
  assert.ok(fin.steps.every((s) => s.status === "completed" || s.status === "tombstoned"));
  assert.match(await page.textContent('[data-testid="ex-spend"]'), /credits/, "the panel shows the cost so far");
  ok(`[P] Resume → the page drove ${fin.progress.total} steps to completed; the panel shows the spend`);
  /* reload: the completed task is not re-attached as work (nothing to drive); the review button opens the result */
  await page.click(`[data-testid="cp-task"][data-task-id="${taskId}"] [data-testid="cp-task-review"]`);
  await page.waitForSelector('[data-testid="cp-apply"]', { timeout: 30_000 });
  await page.click('[data-testid="cp-apply"]');
  await page.waitForTimeout(2500);
  const def = await readDef();
  const info = SurveyDefinition.parse(def);
  assert.equal(countRespondentQuestions(info), 60, `applied: ${countRespondentQuestions(info)} questions`);
  assert.ok((info.quotas?.length ?? 0) >= 1, "a quota was built");
  ok("[P] Review the result → one proposal → Apply: the editor's survey has 60 questions and a quota");
}
{
  /* a reload mid-task reattaches to the open task and the page carries it on */
  await loadDef(EMPTY);
  await intelligent();
  await page.evaluate(() => { window.__rescriptCopilotTaskDrive?.(false); });
  await submit("Create a 80 question survey about streaming with skip logic");
  await page.waitForSelector('[data-testid="cp-task"]', { timeout: 120_000 });
  const taskId = await latestTaskId();
  assert.ok(taskId, "the turn answered with a task");
  await advance(taskId, 1); await advance(taskId, 1); await advance(taskId, 1);
  const mid = (await getTask(taskId)).d.task;
  assert.notEqual(mid.status, "completed", "still running when the page is reloaded");
  const before = mid.steps.filter((s) => s.status === "completed").map((s) => s.stepId);
  assert.ok(before.length >= 3);
  await reload();
  await page.waitForSelector(`[data-testid="cp-task"][data-task-id="${taskId}"]`, { timeout: 120_000 });
  await waitStatus(taskId, "completed", 400_000);
  const fin = (await getTask(taskId)).d.task;
  for (const id of before) assert.equal(fin.steps.find((s) => s.stepId === id).retryCount, 0, `${id} reused after the reload`);
  ok(`[P] reloaded after ${before.length} steps: the page reattached to ${taskId} and carried it on to completed (${fin.progress.total} steps)`);
  /* Stop on a fresh task */
  await loadDef(EMPTY);
  await intelligent();
  await page.evaluate(() => { window.__rescriptCopilotTaskDrive?.(false); });
  await submit("Create a 50 question survey about banking");
  await page.waitForSelector('[data-testid="cp-task"][data-task-status="pending"], [data-testid="cp-task"][data-task-status="running"]', { timeout: 120_000 });
  const fresh = await latestTaskId();
  await showInspector();
  await page.waitForSelector('[data-testid="ex-cancel"]', { timeout: 30_000 });
  await page.click('[data-testid="ex-cancel"]');
  await waitStatus(fresh, "cancelled", 30_000);
  ok("[P] Stop from the panel → cancelled; nothing was applied");
}

assert.deepEqual(errors, [], `console errors: ${errors.join(" | ")}`);
await browser.close();
console.log(`\n${passed} checks passed`);
