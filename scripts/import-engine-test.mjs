/**
 * SUPER INTELLIGENT IMPORT — a questionnaire file in, reviewed, merged (the
 * import brief, phases 1–6, in the browser).
 *
 *   node scripts/import-engine-test.mjs
 *
 * Against the Studio dev server with AI_API_URL=fake: (the sandbox carve-out).
 * Proves, through the Intelligent mode: detection by content (a QSF named
 * .txt), the estimate before anything is charged, scope and target choice,
 * the preview (detected → created, confidence, risks), the issue list and
 * the source → Rescript map, the merge as ONE undoable edit that overwrites
 * nothing, the custom code kept disabled, "what could not be migrated?" from
 * the survey's own record, Deep analysis through the metered route, "why is
 * it not showing?", drag-and-drop, and an unreadable file refused plainly.
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { qsfFixture, docxFixture, DECIPHER_FIXTURE } from "../packages/import/dist/fixtures.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };
const mod = process.platform === "darwin" ? "Meta" : "Control";

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/401|402|422|501|Failed to load resource|ERR_TUNNEL/.test(m.text())) pageErrors.push(m.text().slice(0, 300)); });

const goTab = async (name) => { await openTab(page, name); await page.waitForTimeout(150); };
const loadDef = async (def) => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  await page.click('button:has-text("edit")');
  await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
  await page.click('button:has-text("validate & apply")');
  await page.waitForTimeout(800);
  await goTab("Questions");
};
const readDef = async () => {
  await goTab("JSON");
  await page.waitForSelector("textarea.code");
  const json = await page.$eval("textarea.code", (e) => e.value);
  await goTab("Questions");
  await page.waitForSelector('[data-testid="intelligent-view"]');
  return JSON.parse(json);
};
const lastImport = async () => (await page.$$('[data-testid="iq-import"]')).at(-1);
const stageIs = async (stage, timeout = 20000) => page.waitForFunction((s) => { const els = document.querySelectorAll('[data-testid="iq-import"]'); return els.length && els[els.length - 1].getAttribute("data-stage") === s; }, stage, { timeout });
const attach = async (name, buffer, mimeType = "application/octet-stream") => page.setInputFiles('[data-testid="iq-file"]', { name, mimeType, buffer: Buffer.from(buffer) });
const say = async (text) => { await page.fill('[data-testid="iq-input"]', text); await page.keyboard.press("Enter"); await page.waitForTimeout(300); };

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

/* ------------------------------------------------------------ entry points */
{
  assert.ok(await page.$('[data-testid="iq-attach"]'), "a paperclip beside the microphone");
  assert.match(await page.textContent('[data-testid="iq-import-start"]'), /Import a questionnaire — Qualtrics QSF, Decipher XML, Word, Excel, CSV, PDF or text/);
  // "import this file" opens the picker (it is the same input) — and adds no proposal
  const chooser = page.waitForEvent("filechooser", { timeout: 4000 });
  await say("import this file");
  await chooser;
  assert.equal((await page.$$('[data-testid="iq-turn"]')).length, 0);
  ok("entry points: the paperclip, the welcome card, and “import this file” all open the file picker");
}

/* ------------------------------------------------------------ estimate: detected by content */
{
  await attach("survey_export.txt", JSON.stringify(qsfFixture()), "text/plain");
  await stageIs("estimated");
  const card = await lastImport();
  assert.equal(await card.getAttribute("data-format"), "qsf", "a QSF named .txt is still a QSF");
  assert.match(await (await card.$('[data-testid="iqi-detected"]')).textContent(), /Qualtrics/);
  assert.match(await (await card.$('[data-testid="iqi-detected"]')).getAttribute("title"), /\.txt extension was ignored/);
  assert.match(await (await card.$('[data-testid="iqi-title"]')).textContent(), /Customer Satisfaction 2026/);
  assert.match(await (await card.$('[data-testid="iqi-workload"]')).textContent(), /9 questions · \d+ logic rules · \d custom code item/);
  const est = await (await card.$('[data-testid="iqi-estimate"]')).textContent();
  assert.match(est, /Import: \$[\d.]+/); assert.match(est, /no AI is used/);
  assert.match(est, /Deep custom logic analysis \(optional, after import\)/);
  assert.ok(await card.$('[data-testid="iqi-scope-structure"]') && await card.$('[data-testid="iqi-scope-questions"]'));
  ok("estimate before anything runs: detected by content (.txt ignored), title, workload, cost, the three scopes");
}

/* ------------------------------------------------------------ preview: into this survey */
{
  const card = await lastImport();
  await (await card.$('[data-testid="iqi-into-merge"]')).check();
  await (await card.$('[data-testid="iqi-run"]')).click();
  await stageIs("ready");
  const c = await lastImport();
  const summary = (await c.$$eval('[data-testid="iqi-summary"]', (els) => els.map((e) => e.textContent))).join(" | ");
  assert.match(summary, /I merged your Qualtrics survey \(QSF\) into Rescript — “Customer Satisfaction 2026”/);
  assert.match(summary, /custom logic items? needs? review — none were guessed/);
  const rows = await c.$$eval('[data-testid="iqi-preview"] tbody tr', (trs) => Object.fromEntries(trs.map((t) => [t.dataset.row, [...t.querySelectorAll("td")].slice(1).map((d) => d.textContent)])));
  assert.deepEqual(rows.questions, ["9", "8"], "the unsupported Draw question is a placeholder, not a question: " + JSON.stringify(rows));
  assert.deepEqual(rows.displayLogic, ["4", "3"], "the GeoIP condition was not converted — and the count says so");
  assert.ok(rows.loops && rows.loops[1] === "1" && rows.quotas[1] === "1" && rows.embeddedFields[1] === "2", JSON.stringify(rows));
  assert.match(await (await c.$('[data-testid="iqi-risk-high"]')).textContent(), /high risk \d+/);
  assert.match(await (await c.$('[data-testid="iqi-actual"]')).textContent(), /Charged for this import: \$[\d.]+ \(estimated \$/);
  await (await c.$('[data-testid="iqi-issues-btn"]')).click();
  const issues = await c.$$eval('[data-testid="iqi-issue"]', (els) => els.map((e) => `${e.dataset.severity}|${e.textContent}`));
  assert.ok(issues.some((t) => /^high\|QID8 · JavaScript/.test(t)), issues.slice(0, 4).join("\n"));
  assert.ok(issues.some((t) => /could not be converted/.test(t) && /Not converted automatically|An automatic conversion was attempted/.test(t)));
  await (await c.$('[data-testid="iqi-map-btn"]')).click();
  const map = await c.$$eval('[data-testid="iqi-map-row"]', (els) => els.map((e) => [...e.querySelectorAll("td")].map((d) => d.textContent).join(" ")));
  assert.ok(map.some((r) => /^question QID1 QID1/.test(r)), map.slice(0, 5).join("\n"));
  assert.ok(map.some((r) => /^block BL_screen/.test(r)));
  ok("preview: summary in words, detected → created counts, risks by severity, the actual charge, issues with location/type/why/suggestion, the map");
}

/* ------------------------------------------------------------ merge: one undoable edit, nothing overwritten */
{
  const before = await readDef();
  await switchMode(page, "intelligent");
  await (await (await lastImport()).$('[data-testid="iqi-merge"]')).click();
  await stageIs("merged");
  const after = await readDef();
  assert.equal(after.questions.find((q) => q.id === "q_intro").text, "Existing first question", "the existing survey is untouched");
  assert.equal(after.questions.length, before.questions.length + 10, "QID1–QID10 (the descriptive QID9 included), not the trash");
  assert.ok(after.questions.some((q) => q.id === "QID1_Imported" || q.id === "QID1"), "QID1 came in");
  const qid1 = after.questions.find((q) => q.importedFrom === "QID1" || q.id === "QID1" || q.id === "QID1_Imported");
  assert.ok(qid1);
  assert.ok(after.questions.some((q) => q.variableName === "Q1_Imported"), "Q1 was already a variable here: the import's Q1 is Q1_Imported");
  const script = after.scripts.find((x) => x.ref === "QID8");
  assert.ok(script && script.enabled === false, "QID8's JavaScript is kept, disabled");
  assert.equal(after.imports.at(-1).mode, "merge");
  assert.equal(after.flow.at(-1).type, "end", "the survey still ends with its own End");
  await switchMode(page, "intelligent");
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(400);
  const undone = await readDef();
  assert.equal(undone.questions.length, before.questions.length, "one undo takes the whole import back");
  await switchMode(page, "intelligent");
  await page.keyboard.press(`${mod}+Shift+z`);
  await page.waitForTimeout(400);
  assert.equal((await readDef()).questions.length, after.questions.length);
  await switchMode(page, "intelligent");
  ok("Add to this survey: the imported questions go in beside the existing ones, renames where names collide, code kept disabled — one undo takes it back");
}

/* ------------------------------------------------------------ what could not be migrated? */
{
  await say("What could not be migrated?");
  await page.waitForSelector('[data-testid="iq-import-review"]');
  const card = (await page.$$('[data-testid="iq-import-review"]')).at(-1);
  assert.match(await (await card.$('[data-testid="iqr-summary"]')).textContent(), /items from survey_export\.txt \(\d{4}-\d{2}-\d{2}\) need review — \d+ high risk/);
  const lines = await card.$$eval('[data-testid="iqr-line"]', (els) => els.map((e) => e.textContent));
  assert.ok(lines.some((l) => /QID8 · JavaScript/.test(l)));
  const go = (await card.$$('[data-testid="iqr-go"]'))[0];
  await go.click();
  await page.waitForTimeout(300);
  assert.ok(await page.$('[data-testid="iq-inspector"]'));
  const scripts = await card.$$('[data-testid="iqr-script"]');
  assert.ok(scripts.length >= 1, "the kept code is listed");
  await (await scripts[0].$('[data-testid="iqr-analyze"]')).click();
  await page.waitForFunction(() => { const s = document.querySelector('[data-testid="iqr-script"]'); return s && (s.getAttribute("data-state") === "done" || s.getAttribute("data-state") === "failed"); }, null, { timeout: 20000 });
  const state = await scripts[0].getAttribute("data-state");
  assert.equal(state, "done", await scripts[0].textContent());
  assert.match(await (await scripts[0].$('[data-testid="iqr-analysis"]')).textContent(), /could not explain this code\. Nothing was changed\./, "the fake model explains nothing — and nothing is proposed or applied");
  assert.match(await (await scripts[0].$('[data-testid="iqr-equivalent"]')).textContent(), /No faithful Rescript equivalent was proposed/);
  ok("“What could not be migrated?” answers from the survey's own import record; a line selects its question; Deep analysis runs through the metered route and proposes nothing it cannot justify");
}

/* ------------------------------------------------------------ why is it not showing? */
{
  const before = (await page.$$('[data-testid="iq-turn"]')).length;
  await say("Why is Q2 not showing?");
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="iq-turn"]').length > n, before);
  const t = (await page.$$('[data-testid="iq-turn"]')).at(-1);
  assert.equal(await t.getAttribute("data-kind"), "diagnose");
  assert.match(await t.textContent(), /Nothing in the survey stops Q2 from being shown|Q2 is shown only to some respondents|Q2 can never be shown/);
  assert.equal(await t.$('[data-testid="iq-apply"]'), null, "a diagnosis offers no Apply");
  ok("“Why is Q2 not showing?” is a diagnosis — read-only, every reason");
}

/* ------------------------------------------------------------ a Word questionnaire, new project; Decipher by drop; a file that is not a questionnaire */
{
  await attach("brief.docx", docxFixture());
  await stageIs("estimated");
  let c = await lastImport();
  assert.equal(await c.getAttribute("data-format"), "docx");
  await (await c.$('[data-testid="iqi-scope-questions"]')).check();
  await (await c.$('[data-testid="iqi-run"]')).click();
  await stageIs("ready");
  c = await lastImport();
  const create = await c.$('[data-testid="iqi-create"]');
  assert.ok(create && await create.isDisabled(), "the sandbox cannot create projects — the button says so rather than failing");
  assert.match(await create.getAttribute("title"), /sign in/i);
  await (await c.$('[data-testid="iqi-cancel"]')).click();
  await stageIs("cancelled");

  // drag and drop a Decipher XML onto the conversation
  await page.evaluate((xml) => {
    const dt = new DataTransfer();
    dt.items.add(new File([xml], "automotive.xml", { type: "text/xml" }));
    const main = document.querySelector('[data-testid="iq-main"]');
    main.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    main.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, DECIPHER_FIXTURE);
  await stageIs("estimated");
  c = await lastImport();
  assert.equal(await c.getAttribute("data-format"), "decipher");
  assert.match(await (await c.$('[data-testid="iqi-detected"]')).textContent(), /Decipher/);
  await (await c.$('[data-testid="iqi-cancel"]')).click();

  await attach("notes.xml", "<?xml version='1.0'?><note><to>Tove</to></note>", "text/xml");
  await stageIs("failed");
  c = await lastImport();
  assert.match(await (await c.$('[data-testid="iqi-error"]')).textContent(), /could not be imported/);
  ok("a Word questionnaire (questions only), a Decipher XML dropped on the conversation, and an XML that is not a survey — each read by content");
}

/* ------------------------------------------------------------ the route without a session */
{
  const form = new FormData();
  form.append("file", new Blob([JSON.stringify(qsfFixture())]), "a.qsf");
  form.append("surveyId", "00000000-0000-0000-0000-000000000000");
  const r = await fetch(`${STUDIO}/api/import/analyze`, { method: "POST", body: form });
  assert.equal(r.status, 401, "only the sandbox may import without a session");
  const r2 = await fetch(`${STUDIO}/api/import/custom-logic`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ surveyId: "sandbox", item: {} }) });
  assert.equal(r2.status, 400, "no code, no analysis");
  const bad = await fetch(`${STUDIO}/api/surveys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x", definition: { questions: "nope" }, strict: true }) });
  assert.equal(bad.status, 401, "creating a project needs a session, strict or not");
  ok("the routes: a session outside the sandbox; a custom-logic request without code refused");
}

assert.deepEqual(pageErrors, [], pageErrors.join("\n"));
await browser.close();
console.log(`\nimport engine: ${passed} passed`);
