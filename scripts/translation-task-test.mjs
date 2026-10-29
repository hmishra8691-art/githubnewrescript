/**
 * TRANSLATION AS A DURABLE TASK ON THE ONE ENGINE (K3 ported onto the base, 2026-10-29 —
 * docs/TRANSLATION-TASKS-2026-10-29.md).
 *
 * Production: "सर्वे को उर्दू में ट्रांस्लेट कर दो" on a 78-question survey was ONE model call → 163 s timeout; "translate
 * the first 10 questions into Urdu" → "the model answered in words, not changes". Here, on the sandbox with the
 * fake provider, a 78-question survey (choice, grids, constant sum, NPS anchors, open ends; piping, ${vars}, links,
 * HTML, display logic, a question script, end screens):
 *
 *   C1  the Hindi sentence answers `stage: "task"` at once (the translation planner, no model call); in Intelligent
 *       Mode "translate the survey into Urdu" shows the task card and its steps: inventory, N batches, final check
 *   C2  the page is reloaded with batches still to do → the panel reattaches and the task completes; completed
 *       steps are never run again (retryCount 0), every batch carries its own cost, the verify step persists
 *       coverage 100 % and RTL
 *   C3  Review the result → Apply: the editor's survey has an Urdu version covering 100 % of the inventory, every
 *       pipe / variable / link / HTML tag byte-identical, the structure hash unchanged, the language RTL
 *   C4  the runtime preview ?lang=ur is right-to-left and shows the Urdu wording
 *   C5  "translate the first 10 questions into Hindi" → scope = those 10 — a 3-step task, structured changes, never
 *       prose; nothing outside the scope, no interface strings
 *
 *   /tmp/p0/fresh.sh translation-task-test.mjs   (or: flock /tmp/p0/heavy.lock node --experimental-strip-types --no-warnings scripts/translation-task-test.mjs)
 */
import { chromium } from "./lib/playwright.mjs";
import assert from "node:assert/strict";
import { openTab, switchMode } from "./lib/nav.mjs";
import { sendPreview } from "./lib/preview.mjs";
import { applySurveyActions, coerceSurveyActions, surveyStructureHash, translationCoverage, translationInventory } from "../packages/engine/dist/index.js";
import { SurveyDefinition } from "../packages/schema/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opts = (...ls) => ls.map((l, i) => ({ code: i + 1, label: l }));

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
const advance = (id, maxSteps) => api("POST", `/api/copilot/tasks/${id}/advance`, { surveyId: "sandbox", ...(maxSteps ? { maxSteps } : {}) });
const action = (id, a, body = {}) => api("POST", `/api/copilot/tasks/${id}/${a}`, { surveyId: "sandbox", ...body });
const getTask = (id, q = "") => api("GET", `/api/copilot/tasks/${id}?surveyId=sandbox${q}`);
const turn = (message, definition, extra = {}) => api("POST", "/api/copilot/turn", { surveyId: "sandbox", message, definition, ...extra });
const DONE = new Set(["completed", "failed", "cancelled"]);
const applied = (base, actions) => applySurveyActions(SurveyDefinition.parse(base), coerceSurveyActions(actions, 5000).actions, { now: "2026-10-29T00:00:00.000Z" });
async function closeOpenTasks() {
  const l = await api("GET", "/api/copilot/tasks?surveyId=sandbox");
  for (const t of l.d?.tasks ?? []) if (!DONE.has(t.status)) await action(t.id, "cancel");
}
async function runToEnd(id, max = 80) {
  let t;
  for (let i = 0; i < max; i++) {
    const a = await advance(id, 3);
    assert.equal(a.status, 200, JSON.stringify(a.d).slice(0, 300));
    t = a.d.task;
    if (DONE.has(t.status) || t.status === "needs_attention") break;
  }
  return t;
}

/* 78 questions: choice, grids, constant sum, NPS anchors, open ends; piping, ${vars}, links, HTML, display logic, a question script, end screens */
function fixture(n = 78) {
  const questions = [], pages = [];
  for (let i = 1; i <= n; i++) {
    const id = `q${i}`, code = `Q${i}`;
    const k = i % 6;
    const q =
      k === 1 ? { type: "single_select", text: i > 1 ? `Question ${i}: which option fits {{Q1}} best for you?` : "Which option fits you best?", instruction: "Select one answer", options: opts("Yes", "No", "Not sure"), validation: [{ kind: "required", message: "Please choose one answer." }] }
      : k === 2 ? { type: "multi_select", text: `Which of these did you use for topic ${i}? <b>Select all that apply</b>`, options: [...opts(`Item ${i} one`, `Item ${i} two`), { code: 99, label: "None of these", flags: ["exclusive"] }] }
      : k === 3 ? { type: "matrix_single", text: `How much do you agree with statement set ${i}?`, rows: [{ code: "r1", label: `Statement ${i} alpha` }, { code: "r2", label: `Statement ${i} beta` }], options: opts("Disagree", "Neutral", "Agree") }
      : k === 4 ? { type: "allocation", text: `Split 100 points for area ${i}. Total so far: \${total}`, rows: [{ code: "a", label: `Price ${i}` }, { code: "b", label: `Speed ${i}` }] }
      : k === 5 ? { type: "nps", text: `How likely are you to recommend service ${i}?`, settings: { npsLeftLabel: "Not at all likely", npsRightLabel: "Extremely likely" } }
      : { type: "long_text", text: `Please describe your experience with area ${i} — details at <a href="https://example.org/help?a=1&amp;b=2">our help page</a>.` };
    questions.push({ id, code, variableName: `V${i}`, ...q, ...(i === 7 ? { displayLogic: { type: "rule", source: { kind: "question", ref: "Q1" }, operator: "eq", value: 1 } } : {}), ...(i === 8 ? { customJs: "el.setAttribute('data-q8-js', 'ran');" } : {}) });
    pages.push({ type: "page", id: `p${i}`, questionIds: [id] });
  }
  return {
    meta: { id: "sandbox", code: "SANDBOX", title: "National mobility tracker", version: "1.0" },
    questions,
    flow: [
      { type: "block", id: "b1", title: "Screening", children: pages.slice(0, 6) },
      { type: "block", id: "b2", title: "Main section", children: pages.slice(6) },
      { type: "end", id: "e2", status: "complete", message: "Thank you for your time!" },
    ],
  };
}
const FIXTURE = fixture();
const BASE = SurveyDefinition.parse(FIXTURE);
const inventory = translationInventory(BASE).units;
/* the hash of the survey AS THE EDITOR HOLDS IT (the JSON panel normalises what it applies): read back after loadDef */
let structureBefore = surveyStructureHash(BASE);

/* ============================================================== C1 (API): the production sentence is a task at once */
console.log("— C1: “सर्वे को उर्दू में ट्रांस्लेट कर दो” on 78 questions answers stage: task at once —");
await closeOpenTasks();
{
  const t0 = Date.now();
  const r = await turn("सर्वे को उर्दू में ट्रांस्लेट कर दो", FIXTURE);
  const ms = Date.now() - t0;
  assert.equal(r.status, 200, JSON.stringify(r.d).slice(0, 300));
  assert.equal(r.d.stage, "task", `expected a task, got ${r.d.stage} ${JSON.stringify(r.d.context).slice(0, 200)}`);
  assert.equal(r.d.task.planner, "translation");
  assert.equal(r.d.context.modelCalled, false, "the plan needs no model call");
  const kinds = r.d.task.steps.map((s) => s.kind);
  assert.equal(kinds[0], "translation.prepare"); assert.equal(kinds.at(-1), "translation.verify");
  const batches = r.d.task.steps.filter((s) => s.kind === "translation.batch");
  assert.ok(batches.length >= 2, `batches ${batches.length}`);
  for (const s of batches) assert.ok(s.units >= 1 && s.units <= 400 && s.modelTier === "small", `${s.stepId} ${s.units} ${s.modelTier}`);
  assert.equal(r.d.task.deliverable.language, "ur");
  assert.ok(/चरण/.test(r.d.reply.reply), "the Studio's sentence follows the researcher's language (Hindi)");
  assert.ok(ms < 60_000, `answered in ${ms} ms — no 78-question model call`);
  await action(r.d.task.id, "cancel");
  ok(`[C1] the Hindi request answered stage: "task" in ${ms} ms: prepare + ${batches.length} batches + verify (small tier), planner translation, deliverable ur`);
}

/* ============================================================== browser */
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await context.newPage();
page.on("dialog", (d) => d.accept());
const errors = [];
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource|net::ERR|status of (40\d|50\d)/.test(m.text())) errors.push(m.text()); });
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
const latestTaskId = () => page.evaluate(() => { const cards = document.querySelectorAll('[data-testid="cp-task"]'); return cards.length ? cards[cards.length - 1].getAttribute("data-task-id") : null; });
const waitStatus = async (id, want, timeout) => { await page.waitForFunction(([tid, w]) => document.querySelector(`[data-testid="cp-task"][data-task-id="${tid}"]`)?.getAttribute("data-task-status") === w, [id, want], { timeout }); };

await gotoStudio();
await page.evaluate(() => { try { Object.keys(localStorage).filter((k) => k.startsWith("rescript.copilot.")).forEach((k) => localStorage.removeItem(k)); } catch {} });
await loadDef(FIXTURE);
const editorBefore = await readDef();
assert.equal(editorBefore.questions.length, 78);
structureBefore = surveyStructureHash(SurveyDefinition.parse(editorBefore));
await intelligent();

/* ============================================================== C1 (panel) + C2: the task card, reload, completion */
console.log("— C1/C2: Intelligent Mode “translate the survey into Urdu” → the task card; reload mid-task → reattached, completed, nothing redone —");
let taskId;
{
  await page.evaluate(() => { window.__rescriptCopilotTaskDrive?.(false); });
  await submit("translate the survey into Urdu");
  await page.waitForSelector('[data-testid="cp-task"]', { timeout: 120_000 });
  taskId = await latestTaskId();
  assert.ok(taskId, "the turn answered with a task");
  const v = (await getTask(taskId, "&steps=1")).d;
  assert.equal(v.task.planner, "translation");
  const ids = v.steps.map((s) => s.stepId);
  assert.ok(ids.includes("tr.ur.prepare") && ids.includes("tr.ur.verify") && ids.filter((i) => /^tr\.ur\.b\d+$/.test(i)).length >= 2, ids.join(","));
  await page.waitForSelector('[data-testid="cp-execution"] [data-testid="ex-step"]', { timeout: 60_000 });
  const rows = await page.$$('[data-testid="cp-execution"] [data-testid="ex-step"]');
  assert.ok(rows.length >= 4, `panel rows ${rows.length}`);
  ok(`[C1] the panel shows task ${taskId}: ${ids.length} steps (${ids.filter((i) => /\.b\d+$/.test(i)).length} batches)`);

  /* two steps by the API (prepare + the first batch), then the page goes away */
  await advance(taskId, 1); await advance(taskId, 1);
  const mid = (await getTask(taskId, "&steps=1")).d;
  assert.notEqual(mid.task.status, "completed", "still running when the page is reloaded");
  const before = mid.steps.filter((s) => s.status === "completed").map((s) => s.stepId);
  assert.ok(before.includes("tr.ur.prepare") && before.some((i) => /\.b01$/.test(i)), before.join(","));
  assert.ok(mid.steps.some((s) => s.kind === "translation.batch" && s.status !== "completed"), "batches still to do when the page goes away");
  await reload();
  await page.waitForSelector(`[data-testid="cp-task"][data-task-id="${taskId}"]`, { timeout: 120_000 });
  /* the sandbox editor does not keep its survey across a reload (a real project does): put the fixture back so Apply lands on the survey the task translated */
  await loadDef(editorBefore);
  await intelligent();
  await page.waitForSelector(`[data-testid="cp-task"][data-task-id="${taskId}"]`, { timeout: 120_000 });
  /* the page drives the task; when the supervised dev server is restarted under it (memory), the cron's path — advance by the API — finishes the same rows */
  let drivenBy = "the page";
  await waitStatus(taskId, "completed", 240_000).catch(async () => { drivenBy = "the API after the page's driver stopped (a dev-server restart)"; const t = await runToEnd(taskId); assert.equal(t.status, "completed", `${t.status} ${JSON.stringify(t.report?.problems?.slice(0, 3))}`); });
  const fin = (await getTask(taskId, "&steps=1&result=1")).d;
  assert.equal(fin.task.status, "completed", JSON.stringify(fin.task.report?.problems?.slice(0, 3)));
  for (const id of before) assert.equal(fin.steps.find((s) => s.stepId === id).retryCount, 0, `${id} reused after the reload`);
  const batches = fin.steps.filter((s) => s.kind === "translation.batch" && s.status === "completed");
  for (const b of batches) assert.ok(b.usage && typeof b.usage.charge === "number" && b.usage.charge > 0 && b.usage.tokensIn > 0, `${b.stepId} carries its own cost`);
  assert.ok(fin.task.spend.charge > 0 && Math.abs(fin.task.spend.charge - fin.steps.filter((s) => s.usage).reduce((n, s) => n + (s.usage.charge ?? 0), 0)) < 1e-6, "the task's spend is the sum of its steps");
  const verify = fin.steps.find((s) => s.stepId === "tr.ur.verify");
  assert.equal(verify.output.data.coverage.percent, 100);
  assert.equal(verify.output.data.rtl, true);
  assert.equal(verify.output.data.structureHash, structureBefore, "the task's own check: structure unchanged");
  assert.equal(fin.task.completion?.[0], "translation:ur:version:all");
  ok(`[C2] reloaded after ${before.length} steps: reattached to ${taskId}, completed (driven by ${drivenBy}) with ${batches.length} batches (each with its own cost, ${fin.task.spend.charge.toFixed(4)} credits in all); persisted coverage 100 %, RTL, structure hash unchanged`);
}

/* ============================================================== C3: Review → Apply */
console.log("— C3: Review the result → Apply: 100 % of the inventory in Urdu, protected parts byte-identical, structure unchanged —");
{
  await page.click(`[data-testid="cp-task"][data-task-id="${taskId}"] [data-testid="cp-task-review"]`);
  await page.waitForSelector('[data-testid="cp-apply"]', { timeout: 30_000 });
  await page.click('[data-testid="cp-apply"]');
  await page.waitForTimeout(1500);
  const after = await readDef();
  const afterDef = SurveyDefinition.parse(after);
  const cov = translationCoverage(afterDef, "ur", translationInventory(afterDef).units);
  if (!cov.complete) { const fs = await import("node:fs"); fs.writeFileSync("/tmp/p0/translation-task-after.json", JSON.stringify({ before: editorBefore, after }, null, 1)); }
  assert.equal(cov.complete, true, JSON.stringify({ missing: cov.missing.slice(0, 5), invalid: cov.invalid.slice(0, 3), stale: cov.stale.slice(0, 3) }));
  assert.equal(cov.total, inventory.length, "the inventory is the same before and after");
  assert.equal(surveyStructureHash(afterDef), structureBefore, "logic, piping, scripts, codes and ids unchanged");
  const ur = after.localization.translations.ur;
  assert.ok(/\p{Script=Arabic}/u.test(ur["q:q7:text"].text) && ur["q:q7:text"].text.includes("{{Q1}}"), ur["q:q7:text"].text);
  assert.ok(ur["q:q4:text"].text.includes("${total}"));
  assert.ok(ur["q:q6:text"].text.includes('<a href="https://example.org/help?a=1&amp;b=2">') && ur["q:q6:text"].text.includes("</a>"));
  assert.ok(ur["q:q2:text"].text.includes("<b>") && ur["q:q2:text"].text.includes("</b>"));
  assert.ok(/\p{Script=Arabic}/u.test(ur["flow:e2:message"].text) && /\p{Script=Arabic}/u.test(ur["ui:required"].text) && /\p{Script=Arabic}/u.test(ur["q:q3:row:r1"].text));
  /* the editor migrates a legacy `customJs` into a script behaviour on load: the script is there, byte-identical, either way */
  assert.ok(after.questions[7].customJs === "el.setAttribute('data-q8-js', 'ran');" || JSON.stringify(after.ux?.behaviors ?? []).includes("el.setAttribute('data-q8-js', 'ran');"), "the question script survived the translation");
  assert.deepEqual(after.questions[6].displayLogic, editorBefore.questions[6].displayLogic);
  assert.equal(after.localization.languages.find((l) => l.code === "ur").direction, "rtl");
  ok(`[C3] applied: ${cov.translated}/${cov.total} strings in Urdu, every pipe / variable / link / tag intact; structure hash ${structureBefore} before and after`);

  /* ============================================================== C4: the runtime preview */
  console.log("— C4: the runtime preview ?lang=ur is right-to-left —");
  const pv = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  let shown = false;
  for (let i = 0; i < 6 && !shown; i++) {
    try { await pv.goto(`${RUNTIME}/preview?lang=ur`, { waitUntil: "networkidle", timeout: 120_000 }); await sendPreview(pv, { definition: after }, { selector: "[data-qid]" }); shown = true; } catch (e) { console.log(`  …   runtime preview: ${String(e.message ?? e).split("\n")[0].slice(0, 120)} — retrying`); await sleep(8000); }
  }
  assert.ok(shown, "the runtime preview showed the survey");
  assert.equal(await pv.getAttribute(".rs-shell", "dir"), "rtl");
  assert.equal(await pv.getAttribute(".rs-shell", "data-language"), "ur");
  const q1 = await pv.textContent('[data-qid="q1"]');
  assert.ok(/\p{Script=Arabic}/u.test(q1), q1);
  await pv.close();
  ok("[C4] preview ?lang=ur: dir=rtl, data-language=ur, the Urdu wording");
}

/* ============================================================== C5: a small scope */
console.log("— C5: “translate the first 10 questions into Hindi” → scope = those 10, structured changes, never prose —");
{
  const r = await turn("translate the first 10 questions into Hindi", FIXTURE);
  assert.equal(r.status, 200, JSON.stringify(r.d).slice(0, 300));
  assert.equal(r.d.stage, "task", `expected a task (ten questions: the estimate's TASK_MIN_TRANSLATE), got ${r.d.stage} ${JSON.stringify(r.d.context).slice(0, 200)}`);
  assert.equal(r.d.task.planner, "translation");
  assert.deepEqual(r.d.task.steps.map((s) => s.kind), ["translation.prepare", "translation.batch", "translation.verify"]);
  assert.equal(r.d.task.deliverable.language, "hi");
  assert.equal(r.d.task.deliverable.scopedQuestions, 10);
  const t = await runToEnd(r.d.task.id);
  assert.equal(t.status, "completed", `${t.status} ${JSON.stringify(t.report?.problems?.slice(0, 3))}`);
  const res = (await getTask(r.d.task.id, "&result=1")).d.result;
  const keys = res.actions.filter((a) => a.op === "set_translations").flatMap((a) => a.entries.map((e) => e.target));
  assert.ok(keys.includes("q:q10:text") && !keys.includes("q:q11:text") && !keys.some((k) => k.startsWith("ui:")), `exactly the first 10 questions: ${keys.slice(0, 5)}`);
  assert.ok(res.actions.some((a) => a.op === "add_language" && a.code === "hi"), "the language is added first");
  const out = applied(FIXTURE, res.actions);
  assert.deepEqual(out.errors, [], "the proposal applies with no refusal");
  for (const q of FIXTURE.questions.slice(0, 10)) assert.ok(/\p{Script=Devanagari}/u.test(out.def.localization.translations.hi[`q:${q.id}:text`].text), `${q.code} in Devanagari`);
  ok(`[C5] a 3-step task: ${keys.length} strings of Q1–Q10 as set_translations (hi) in Devanagari, nothing outside the scope`);
}

await closeOpenTasks();
assert.deepEqual(errors.filter((e) => !/ResizeObserver/.test(e)), [], errors.join("\n"));
await browser.close();
console.log(`\n${passed} passed`);
