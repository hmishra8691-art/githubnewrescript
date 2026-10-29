/**
 * ADVANCED METHODS AS A TASK (ported from K2 onto the base engine, 2026-10-29 — docs/EXECUTION-ENGINE-2026-10-29.md) — acceptance test G
 * against the Studio dev server with the stand-in model (AI_API_URL=fake:):
 *
 *   [G1] API: "Design a CBC conjoint study for smartphones" → the generation planner's methods path: research design,
 *        skeleton (screening / choice exercise / profile, codes fixed), supporting questions, the design step
 *        (attributes & levels → the Studio's own generator → validation), the analysis plan, the final check by
 *        DESIGN criteria (design_valid:<code>, design_valid:cbc) — not by a question count
 *   [G2] the round-0 design is invalid (a one-level attribute — never invented by the Studio) → a design repair step
 *        names the reason and the repaired design passes; the MaxDiff whose items per task equal its items is
 *        corrected by the Studio itself (no second model call), said in the step's output
 *   [G3] persisted state + the deliverable: the proposal applies; the design has rows, D-efficiency and balance in
 *        its summary, the conjoint readiness lists its estimators, the analysis plan has the design's tests
 *   [G4] browser: "Design a MaxDiff study of smartphone features" typed in Intelligent Mode → a task → completed →
 *        reviewed and applied → the editor's survey has the MaxDiff question with its generated design
 *
 *   flock /tmp/p0/heavy.lock node --experimental-strip-types --no-warnings scripts/methods-task-test.mjs
 */
import { chromium } from "./lib/playwright.mjs";
import assert from "node:assert/strict";
import { openTab, switchMode } from "./lib/nav.mjs";
import { applySurveyActions, coerceSurveyActions, validateSurveyDeliverable, parseCompletionCriteria, conjointPlanReadiness, designProblems } from "../packages/engine/dist/index.js";
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { registerBuiltinDesignGenerators } from "../packages/designs/dist/index.js";

registerBuiltinDesignGenerators();
const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const EMPTY = { meta: { id: "sandbox", code: "S", title: "Smartphone study", version: "1.0" }, questions: [], flow: [{ type: "end", id: "e_ok", status: "complete" }] };
const getTask = (id, q = "") => api("GET", `/api/copilot/tasks/${id}?surveyId=sandbox${q}`);
const DONE = new Set(["completed", "failed", "cancelled"]);
async function runTask(message) {
  const c = await api("POST", "/api/copilot/tasks", { surveyId: "sandbox", message, definition: EMPTY });
  assert.equal(c.status, 200, JSON.stringify(c.d));
  const id = c.d.task.id;
  let t = null;
  for (let i = 0; i < 60; i++) { t = (await api("POST", `/api/copilot/tasks/${id}/advance`, { surveyId: "sandbox" })).d?.task; if (t && (DONE.has(t.status) || t.drive !== "advance")) break; await sleep(200); }
  assert.equal(t?.status, "completed", `${message}: ${t?.status} ${JSON.stringify(t?.report?.problems?.slice(0, 3) ?? null)}`);
  return (await getTask(id, "&steps=1&result=1")).d;
}
const applied = (actions) => { const r = applySurveyActions(SurveyDefinition.parse(EMPTY), coerceSurveyActions(actions, 5000).actions, { now: "2026-10-25T00:00:00.000Z" }); assert.deepEqual(r.errors, [], "the proposal applies with no refusal"); return r.def; };

/* ============================================================== G1–G3: CBC through the API (with a design repair) */
console.log("— G1–G3: a CBC study —");
{
  const s = await runTask("Design a CBC conjoint study for smartphones [fake:bad-design]");
  assert.equal(s.task.planner, "generation");
  const byId = Object.fromEntries(s.steps.map((x) => [x.stepId, x]));
  for (const id of ["design", "skeleton", "method", "analysis", "validate"]) assert.equal(byId[id]?.status, "completed", id);
  assert.ok(s.task.completion.some((c) => /^design_valid:Q\d+$/.test(c)) && s.task.completion.includes("design_valid:cbc"), JSON.stringify(s.task.completion));
  assert.ok(!s.task.completion.some((c) => c.startsWith("questions")), "judged by design criteria, not a question count");
  ok(`[G1] planned by “generation” (methods path): ${Object.keys(byId).length} steps; completion = ${s.task.completion.filter((c) => c.startsWith("design")).join(", ")}`);
  assert.equal(s.task.steps.find((x) => x.stepId === "method").validation.status, "invalid", "round 0 was refused");
  assert.equal(byId.methodr1?.kind, "gen.methods_design_repair");
  assert.equal(byId.methodr1.status, "completed");
  assert.ok(byId.methodr1.input.errors.some((e) => /level/i.test(e)), JSON.stringify(byId.methodr1.input.errors));
  assert.ok(byId.analysis.dependsOn.includes("methodr1") || byId.validate.dependsOn.includes("methodr1"), "the dependents waited for the repair");
  ok("[G2] the one-level attribute was refused with its reason; the design repair step fixed it; dependents waited");
  const def = applied(s.result.actions);
  const q = def.questions.find((x) => x.type === "conjoint_task");
  assert.ok(q, "a CBC question");
  const d = def.designs.find((x) => x.id === q.settings.designRef);
  assert.ok(d.file.rows.length >= 12 * 4 * 3, `rows: ${d.file.rows.length}`);
  assert.ok(typeof d.file.summary.efficiency.pooled === "number" && d.file.summary.efficiency.pooled > 0, "D-efficiency measured");
  assert.ok(d.file.summary.diagnostics, "balance diagnostics");
  assert.deepEqual(designProblems(def, q).filter((p) => p.error), []);
  const ready = conjointPlanReadiness(def, q);
  assert.equal(ready.ready, true, ready.issues.join("; "));
  assert.ok(ready.estimators.some((e) => e.id === "cbc_hb"));
  assert.ok((def.research?.analysisPlan?.tests ?? []).length > 0, "the analysis plan has tests");
  const rep = validateSurveyDeliverable(def, parseCompletionCriteria(s.task.completion));
  assert.equal(rep.ok, true, JSON.stringify(rep.errors.slice(0, 5)));
  ok(`[G3] applied: ${q.code} with a ${d.file.rows.length}-row design (D-efficiency ${d.file.summary.efficiency.pooled.toFixed(2)}), ready for ${ready.estimators.map((e) => e.id).join(" / ")}; analysis planned; design criteria pass`);
}
{
  const s = await runTask("Design a MaxDiff study of smartphone features [fake:bad-design]");
  const method = s.steps.find((x) => x.stepId === "method");
  assert.equal(method.status, "completed");
  assert.ok(!s.steps.some((x) => x.stepId === "methodr1"), "no repair round — the correction was the Studio's own");
  assert.ok(JSON.stringify(method.output.data).includes("Corrected by the Studio"));
  const def = applied(s.result.actions);
  const q = def.questions.find((x) => x.type === "maxdiff_task");
  const d = def.designs.find((x) => x.id === q.settings.designRef);
  assert.ok(d.config.itemsPerTask < d.config.items.length);
  assert.ok(Object.values(d.file.summary.itemShowCounts).every((n) => n > 0), "every item shown");
  assert.ok(validateSurveyDeliverable(def, parseCompletionCriteria(s.task.completion)).ok);
  ok(`[G2] MaxDiff: items per task ${d.config.items.length} → ${d.config.itemsPerTask} corrected by the Studio (1 model call); every item shown; design criteria pass`);
}

/* ============================================================== G4: the browser */
console.log("— G4: in Intelligent Mode —");
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
/* an earlier run's open or paused sandbox tasks would be reattached by the page: close them first */
for (const t of (await api("GET", "/api/copilot/tasks?surveyId=sandbox")).d?.tasks ?? []) if (!DONE.has(t.status)) await api("POST", `/api/copilot/tasks/${t.id}/cancel`, { surveyId: "sandbox" });
await gotoStudio();
await page.evaluate(() => { try { Object.keys(localStorage).filter((k) => k.startsWith("rescript.copilot.")).forEach((k) => localStorage.removeItem(k)); } catch {} });
await loadDef(EMPTY);
await intelligent();
{
  void turnResponses;
  await submit("Design a MaxDiff study of smartphone features");
  await page.waitForSelector('[data-testid="cp-task"]', { timeout: 90_000 });
  const taskId = await page.evaluate(() => { const c = document.querySelectorAll('[data-testid="cp-task"]'); return c[c.length - 1].getAttribute("data-task-id"); });
  assert.ok(taskId, "the study request became a task");
  await page.waitForFunction((tid) => document.querySelector(`[data-testid="cp-task"][data-task-id="${tid}"]`)?.getAttribute("data-task-status") === "completed", taskId, { timeout: 300_000 });
  await page.click(`[data-testid="cp-task"][data-task-id="${taskId}"] [data-testid="cp-task-review"]`);
  await page.waitForSelector('[data-testid="cp-apply"]', { timeout: 30_000 });
  await page.click('[data-testid="cp-apply"]');
  await page.waitForTimeout(2500);
  const def = SurveyDefinition.parse(await readDef());
  const q = def.questions.find((x) => x.type === "maxdiff_task");
  assert.ok(q, "the MaxDiff question is in the editor");
  const d = def.designs.find((x) => x.id === q.settings.designRef);
  assert.ok(d && d.file.rows.length > 0, "with its generated design");
  assert.deepEqual(designProblems(def, q).filter((p) => p.error), []);
  ok(`[G4] typed in Intelligent Mode → task → applied: ${q.code} with ${d.config.items.length} items, ${d.file.rows.length} design rows, ${def.questions.length - 1} supporting questions`);
}
assert.deepEqual(errors, [], `console errors: ${errors.join(" | ")}`);
await browser.close();
console.log(`\n${passed} checks passed`);
