/**
 * I4 — IMPORT SESSIONS in the browser (sandbox, fake AI, the in-memory session store):
 *
 *   A  a run is recorded: the card says so and when the file expires; the API lists it as "analyzed" with its
 *      report digest (mapping classes, graph findings, script verdicts) and the file kept
 *   B  merging marks it "applied"; Roll back restores the survey exactly as it was before the import, as one
 *      edit (⌘Z brings the import back), and marks it "rolled_back"; a second rollback is refused
 *   C  a cancelled preview is "discarded"; the welcome card's Recent imports lists the sessions with their outcome
 *   D  the routes: an unknown session reveals nothing (401 without a sign-in); a rollback of a session that was never applied is refused (409)
 *
 *   node scripts/import-sessions-test.mjs     (Studio dev server with AI_API_URL=fake:)
 */
import assert from "node:assert/strict";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { qsfFixture } from "../packages/import/dist/fixtures.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };
const mod = process.platform === "darwin" ? "Meta" : "Control";

const SECTIONS = (process.env.SECTIONS ?? "ABCD").toUpperCase();
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

const goTab = async (name) => { await openTab(page, name); await page.waitForTimeout(150); };
const loadDef = async (def) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def, null, 2));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(800);
  await goTab("Questions");
};
const readDef = async () => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  await goTab("Questions");
  return JSON.parse(json);
};
const lastImport = async () => (await page.$$('[data-testid="iq-import"]')).at(-1);
const stageIs = async (stage, timeout = 60000) => page.waitForFunction((s) => { const els = document.querySelectorAll('[data-testid="iq-import"]'); return els.length && els[els.length - 1].getAttribute("data-stage") === s; }, stage, { timeout });
const attach = async (name, buffer) => page.setInputFiles('[data-testid="iq-file"]', { name, mimeType: "application/octet-stream", buffer: Buffer.from(buffer) });
const api = async (path, init) => page.evaluate(async ([p, i]) => { const r = await fetch(p, i); return { status: r.status, body: await r.json().catch(() => null) }; }, [path, init ?? {}]);
const sessions = async () => (await api("/api/import/sessions?surveyId=sandbox&limit=50")).body.sessions;

const base = {
  meta: { id: "sandbox", code: "BASE", title: "Existing study", version: "1.0" },
  questions: [
    { id: "q_intro", code: "Q1", variableName: "Q1", type: "single_select", variant: "single_select.radio", text: "Existing first question", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }] },
    { id: "q_last", code: "Q2", variableName: "LAST", type: "open_text", variant: "text.single_line", text: "Existing last question" },
  ],
  flow: [{ type: "page", id: "p_a", questionIds: ["q_intro"] }, { type: "page", id: "p_b", questionIds: ["q_last"] }, { type: "end", id: "e_ok", status: "complete" }],
  deployment: { clientSlug: "c", studySlug: "s" },
};

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
await loadDef(base);
await switchMode(page, "intelligent");
await page.waitForSelector('[data-testid="intelligent-view"]');
const before = (await sessions()).length;

/* ------------------------------------------------------------ A: a run is recorded */
let sessionId;
if (SECTIONS.includes("A")) {
  await attach("tracker.qsf", JSON.stringify(qsfFixture()));
  await stageIs("estimated");
  const card = await lastImport();
  await (await card.$('[data-testid="iqi-into-merge"]')).check();
  await (await card.$('[data-testid="iqi-run"]')).click();
  await stageIs("ready");
  const note = await (await (await lastImport()).$('[data-testid="iqi-session"]')).textContent();
  assert.match(note, /Recorded in the import history · the file is kept until/);
  const list = await sessions();
  assert.equal(list.length, before + 1);
  const s = list[0];
  sessionId = s.id;
  assert.equal(s.status, "analyzed"); assert.equal(s.into, "merge"); assert.equal(s.fileName, "tracker.qsf"); assert.equal(s.format, "qsf");
  assert.equal(s.hasSource, true, "the file is kept"); assert.equal(s.hasPrior, true, "the survey before the import is kept");
  assert.ok(Date.parse(s.sourceExpiresAt) - Date.now() > 89 * 86_400_000, "for 90 days");
  const one = (await api(`/api/import/sessions/${sessionId}`)).body;
  assert.ok(one.digest.mapping.unsupported >= 1, "the digest carries the mapping classes (the fixture's Captcha)");
  assert.ok(one.digest.scripts.some((x) => x.location === "QID8"), "and the script verdicts");
  assert.ok("findings" in one.digest.graph, "and the graph findings");
  assert.equal(one.session.canonical, undefined, "the model is not sent to the browser");
  ok("A: a run is recorded — the card says so; the history has it as analyzed, with the file (90 days), the prior survey and the report digest");
}

/* ------------------------------------------------------------ B: apply, then roll back */
if (SECTIONS.includes("B")) {
  await (await (await lastImport()).$('[data-testid="iqi-merge"]')).click();
  await stageIs("merged");
  await page.waitForFunction(async (id) => (await (await fetch(`/api/import/sessions/${id}`)).json()).session?.status === "applied", sessionId, { timeout: 60000 });
  const merged = await readDef();
  assert.ok(merged.questions.length > base.questions.length);
  await switchMode(page, "intelligent");
  await (await (await lastImport()).$('[data-testid="iqi-rollback"]')).click();
  await stageIs("rolled_back");
  const after = await readDef();
  assert.deepEqual(after.questions.map((q) => q.id), base.questions.map((q) => q.id), "exactly the questions there were before the import");
  assert.deepEqual(after.flow.map((n) => n.id), base.flow.map((n) => n.id), "and the same flow");
  assert.equal((await api(`/api/import/sessions/${sessionId}`)).body.session.status, "rolled_back");
  /* the rollback was ONE edit: undo brings the import back */
  await switchMode(page, "intelligent");
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(500);
  const undone = await readDef();
  assert.equal(undone.questions.length, merged.questions.length, "⌘Z brings the merged survey back");
  const again = await api(`/api/import/sessions/${sessionId}/rollback`, { method: "POST" });
  assert.equal(again.status, 409); assert.match(again.body.error, /Only an applied import can be rolled back; this one is rolled back/);
  ok("B: merge → applied; Roll back restores the survey exactly as before, as one undoable edit → rolled_back; a second rollback is refused");
}

/* ------------------------------------------------------------ C: cancelled = discarded; the history on the welcome card */
/* self-contained (the sessions it reads are made here, through the route), so it can run on its own: SECTIONS=CD */
const runViaApi = async (name, into = "new") => page.evaluate(async ([n, body, i]) => {
  const f = new FormData(); f.set("file", new File([body], n)); f.set("surveyId", "sandbox"); f.set("phase", "run"); f.set("into", i);
  if (i === "merge") f.set("existing", JSON.stringify({ meta: { id: "sandbox", code: "B", title: "B", version: "1" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] }));
  const r = await fetch("/api/import/analyze", { method: "POST", body: f }); return (await r.json()).session;
}, [name, JSON.stringify(qsfFixture()), into]);
if (SECTIONS.includes("C")) {
  await switchMode(page, "intelligent");
  await attach("second.qsf", JSON.stringify(qsfFixture()));
  await stageIs("estimated");
  await (await (await lastImport()).$('[data-testid="iqi-run"]')).click();
  await stageIs("ready");
  await (await (await lastImport()).$('[data-testid="iqi-cancel"]')).click();
  await page.waitForFunction(async () => (await (await fetch("/api/import/sessions?surveyId=sandbox")).json()).sessions[0]?.status === "discarded", null, { timeout: 60000 });
  const m = await runViaApi("third.qsf", "merge");
  assert.ok(m?.id && m.keepsPrior, "a merge run through the route keeps the survey before it");
  /* a fresh visit: the welcome card lists the recent imports */
  await page.goto(`${STUDIO}/sandbox?mode=intelligent`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector('[data-testid="iq-import-history"]', { timeout: 60000 });
  const rows = await page.$$eval('[data-testid="iq-import-history-row"]', (els) => els.map((e) => [e.getAttribute("data-status"), e.textContent]));
  assert.ok(rows.length >= 2 && rows.length <= 5, `2-5 rows: ${rows.length}`);
  assert.equal(rows[0][0], "analyzed"); assert.match(rows[0][1], /third\.qsf.*into this survey.*previewed.*file kept/);
  assert.equal(rows[1][0], "discarded"); assert.match(rows[1][1], /second\.qsf.*new project.*cancelled/);
  ok("C: a cancelled preview is discarded; Recent imports on the welcome card lists each import with its outcome (newest first)");
}

/* ------------------------------------------------------------ D: the routes refuse what they must */
if (SECTIONS.includes("D")) {
  /* an id that is not a sandbox session is answered as a signed-in matter: no session here → 401, so nothing reveals whether it exists */
  assert.equal((await api("/api/import/sessions/mem-nope-1")).status, 401);
  assert.equal((await api("/api/import/sessions/mem-nope-1/rollback", { method: "POST" })).status, 401);
  const made = await runViaApi("fourth.qsf");
  await api(`/api/import/sessions/${made.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "discarded" }) });
  const disc = (await sessions()).find((x) => x.id === made.id);
  assert.equal(disc.status, "discarded");
  const r = await api(`/api/import/sessions/${disc.id}/rollback`, { method: "POST" });
  assert.equal(r.status, 409); assert.match(r.body.error, /this one is discarded/);
  const re = await api(`/api/import/sessions/${disc.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "applied" }) });
  assert.equal(re.status, 409, "a discarded import cannot be marked applied");
  ok("D: an unknown session reveals nothing (401 without a sign-in); a rollback or apply of a session in the wrong state is refused with the reason");
}

assert.deepEqual(pageErrors.filter((e) => !/401|Failed to load resource/.test(e)), [], "no page errors");
console.log(`\nimport-sessions: ${passed} passed`);
await browser.close();
