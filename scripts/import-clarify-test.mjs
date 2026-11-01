/**
 * I5 — THE CLARIFICATION ENGINE in the browser (sandbox, fake AI). A Word-style questionnaire whose instructions
 * leave five decisions open is imported into the open survey:
 *   A  the card lists the five questions, specific to the file, with a recommended answer (and why) where one
 *      is supported and none where nothing points to one; nothing was guessed
 *   B  answering four (recommended, an alternative, "Leave it") and applying re-analyses the preview: the
 *      answered questions are gone, the outcome is stated, the definition carries the decided logic
 *   C  Add to this survey: the decided rules are in the survey (display logic, anchored option, embedded source)
 *
 *   node scripts/import-clarify-test.mjs     (Studio dev server with AI_API_URL=fake:)
 */
/* (shared helpers below, as in import-sessions-test) */
/**
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
import { readFileSync } from "node:fs";

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
  questions: [{ id: "q_intro", code: "X1", variableName: "X1", type: "single_select", variant: "single_select.radio", text: "Existing first question", options: [{ code: 1, label: "A" }, { code: 2, label: "B" }] }],
  flow: [{ type: "page", id: "p_a", questionIds: ["q_intro"] }, { type: "end", id: "e_ok", status: "complete" }],
  deployment: { clientSlug: "c", studySlug: "s" },
};
const doc = readFileSync(new URL("../packages/import/corpus/brand-instructions.txt", import.meta.url), "utf8");
const items = async () => page.$$eval('[data-testid="iqi-clarify-item"]', (els) => els.map((e) => ({ kind: e.getAttribute("data-kind"), q: e.querySelector(".iqi-clarify-q")?.textContent ?? "", opts: [...e.querySelectorAll(".iqi-clarify-opt")].map((o) => o.textContent), checked: [...e.querySelectorAll('input[type="radio"]')].findIndex((r) => r.checked) })));

await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
await page.waitForSelector(".block-badge");
await loadDef(base);
await switchMode(page, "intelligent");
await page.waitForSelector('[data-testid="intelligent-view"]');

/* ------------------------------------------------------------ A */
{
  await attach("brand-spec.txt", doc);
  await stageIs("estimated");
  const card = await lastImport();
  await (await card.$('[data-testid="iqi-into-merge"]')).check();
  await (await card.$('[data-testid="iqi-run"]')).click();
  await stageIs("ready");
  await page.waitForSelector('[data-testid="iqi-clarify"]');
  const it = await items();
  assert.equal(it.length, 5, JSON.stringify(it.map((x) => x.kind)));
  const by = (k, re) => it.find((x) => x.kind === k && re.test(x.q));
  const rnd = by("randomize_scope", /S2's options/); assert.ok(rnd); assert.match(rnd.opts[0], /keep “Other” fixed.*recommended/); assert.equal(rnd.checked, 0, "the recommended answer is pre-selected");
  const cust = by("missing_condition", /whether Q2 is shown.*EXISTING CUSTOMER/); assert.ok(cust); assert.equal(cust.checked, -1, "nothing points to an answer: nothing is pre-selected");
  assert.ok(cust.opts.includes("S1 = Yes"));
  assert.ok(by("missing_target", /SKIP THIS QUESTION IF NO/)); assert.ok(by("embedded_source", /REGION/)); assert.ok(by("missing_condition", /Q42/));
  ok("A: five open decisions, each a specific question; recommended answers pre-selected with why; none where nothing points to one");
}

/* ------------------------------------------------------------ B */
{
  const it = await items();
  const idx = (k, re) => it.findIndex((x) => x.kind === k && re.test(x.q));
  const radios = async (i) => (await page.$$('[data-testid="iqi-clarify-item"]'))[i].$$('input[type="radio"]');
  /* Q2: choose "S1 = Yes" */
  const ci = idx("missing_condition", /whether Q2 is shown/);
  const yesAt = it[ci].opts.indexOf("S1 = Yes");
  await (await radios(ci))[yesAt].check();
  /* Q42: "Leave it" (the last option) */
  const qi = idx("missing_condition", /Q42/);
  const r = await radios(qi); await r[r.length - 1].check();
  await (await (await lastImport()).$('[data-testid="iqi-clarify-apply"]')).click();
  await page.waitForSelector('[data-testid="iqi-decided"]', { timeout: 60000 });
  assert.match(await page.textContent('[data-testid="iqi-decided"]'), /5 answers applied; the preview was re-analysed/);
  assert.equal((await page.$$('[data-testid="iqi-clarify-item"]')).length, 0, "every question was answered (Q42 left for Studio is no longer asked)");
  const review = await (await (await lastImport()).$('[data-testid="iqi-issues-btn"]')).textContent();
  assert.match(review, /Review issues \(\d+\)/);
  ok("B: applying the answers re-analyses the preview; the answered questions are gone and the outcome is stated");
}

/* ------------------------------------------------------------ C */
{
  await (await (await lastImport()).$('[data-testid="iqi-merge"]')).click();
  await stageIs("merged");
  const def = await readDef();
  const q = (code) => def.questions.find((x) => x.code === code || x.variableName === code);
  assert.ok(JSON.stringify(q("Q2").displayLogic ?? {}).includes(q("S1").id), "Q2 is shown by S1 = Yes");
  assert.ok(q("S2").options.find((o) => o.label === "Other").flags.includes("anchor_bottom"), "Other stays at the end");
  assert.ok(JSON.stringify(def.flow).includes("REGION"), "REGION is an embedded field");
  ok("C: Add to this survey carries the decided rules — display logic, the anchored option, the embedded field");
}

assert.deepEqual(pageErrors.filter((e) => !/401|Failed to load resource/.test(e)), [], "no page errors");
console.log(`\nimport-clarify: ${passed} passed`);
await browser.close();
