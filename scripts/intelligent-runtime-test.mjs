/**
 * WHAT INTELLIGENT MODE APPLIES IS WHAT THE RESPONDENT GETS
 * (Intelligent Mode upgrade, Phase 7 — runtime verification).
 *
 * The earlier phases prove that the engine reads a sentence, validates the
 * change and records it. This proves the last step: the change reaches the
 * runtime.
 *
 *   A. The Studio's own Preview window (the runtime's /preview, fed by the
 *      store), opened once and never re-opened, follows every applied change
 *      within the 250 ms push:
 *        - a question's text, an option relabelled, recoded and added;
 *        - a question deleted, then restored from History;
 *        - display logic across pages, answered in the window;
 *        - a translation added, then an option recoded: the runtime in that
 *          language shows the translation on the new code.
 *      None of the engine's edits calls a model route.
 *
 *   B. Test Survey after an applied change: the draft the server receives and
 *      the version it cuts both carry the change, the card says APPLIED · SAVED
 *      only after the save returned, and the version renders the change in the
 *      runtime. (The runtime half — a test link resolving to the latest saved
 *      draft and never falling back — is packages/engine/src/testBuild.test.ts.)
 *
 *   node scripts/intelligent-runtime-test.mjs     (studio :3000 with AI_API_URL=fake:, runtime :3001)
 */
import assert from "node:assert/strict";
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { openPreview } from "./lib/preview.mjs";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const opts = (...ls) => ls.map((l, i) => ({ code: i + 1, label: l }));
const q = (id, code, variableName, type, text, extra = {}) => ({ id, code, variableName, type, text, ...extra });

const FIXTURE = {
  meta: { id: "sandbox", code: "SANDBOX", title: "Runtime check", version: "1.0" },
  questions: [
    q("gender", "Q1", "GENDER", "single_select", "What is your gender?", { options: opts("Male", "Female") }),
    q("age", "Q2", "AGE", "numeric", "How old are you?"),
    q("aware", "Q3", "AWARE", "single_select", "Have you heard of our brand?", { options: opts("Yes", "No") }),
    q("why", "Q4", "WHY", "text", "What do you know about it?"),
    q("nps", "Q5", "NPS", "single_select", "How likely are you to recommend us?", { options: opts("0", "1", "2", "3", "4", "5") }),
  ],
  flow: [
    { type: "block", id: "b0", title: "About you", children: [{ type: "page", id: "p0", questionIds: ["gender", "age"] }] },
    { type: "block", id: "b1", title: "Brand", children: [{ type: "page", id: "p1", questionIds: ["aware"] }, { type: "page", id: "p2", questionIds: ["why"] }] },
    { type: "block", id: "b2", title: "Close", children: [{ type: "page", id: "p3", questionIds: ["nps"] }] },
    { type: "end", id: "e", status: "complete" },
  ],
};

const browser = await chromium.launch();
const errors = [];

/* ------------------------------------------------ the Studio page, with the helpers every Intelligent suite uses */
function studio(page) {
  const turns = () => page.$$('[data-testid="cp-turn"]');
  const h = {
    page,
    modelCalls: [],
    async loadDef(def) {
      await openTab(page, "JSON");
      await page.waitForSelector("textarea.code");
      await page.click('button:has-text("edit")');
      await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
      await page.click('button:has-text("validate & apply")');
      await page.waitForTimeout(600);
    },
    async readDef() {
      await openTab(page, "JSON");
      await page.waitForSelector("textarea.code");
      const d = JSON.parse(await page.$eval("textarea.code", (e) => e.value));
      await h.intelligent();
      return d;
    },
    async intelligent() {
      await openTab(page, "Questions");
      await switchMode(page, "intelligent");
      await page.waitForSelector('[data-testid="intelligent-view"]');
    },
    async panel(tab) {
      if (!(await page.$(`[data-testid="cp-tab-${tab}"]`))) await page.click('[data-testid="iq-toggle-inspector"]');
      await page.click(`[data-testid="cp-tab-${tab}"]`);
      await page.waitForTimeout(150);
    },
    /** say a sentence (with the fake model's reply, when the model is meant to answer); the last turn, settled */
    async say(text, reply) {
      if (reply) await page.evaluate((r) => window.__rescriptCopilotFake(r), reply);
      const n = (await turns()).length;
      await page.fill('[data-testid="iq-input"]', text);
      await page.keyboard.press("Enter");
      await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 30000 });
      const last = (await turns()).at(-1);
      if (await last.$('[data-testid="cp-engine"]')) await page.evaluate(() => window.__rescriptCopilotFakeReset?.());
      return last;
    },
    /** apply the open proposal; wait until its card's save has settled */
    async apply(turn) {
      await h.panel("changes");
      await page.waitForSelector('[data-testid="cp-changes"]');
      if (await page.$('[data-testid="cp-confirm"]')) await page.check('[data-testid="cp-confirm"]');
      await page.click('[data-testid="cp-panel-apply"]');
      await page.waitForFunction((el) => el.getAttribute("data-proposal") === "applied" && el.getAttribute("data-save") && el.getAttribute("data-save") !== "saving", turn, { timeout: 20000 });
    },
    /** an engine sentence, applied: it must be the engine's, and must call no model route */
    async engine(text) {
      const before = h.modelCalls.length;
      const t = await h.say(text);
      assert.ok(await t.$('[data-testid="cp-engine"]'), `“${text}” is read by the engine`);
      assert.equal(await t.$eval('[data-testid="cp-engine-detail"]', (e) => e.getAttribute("data-kind")), "actions", `“${text}” becomes actions`);
      await h.apply(t);
      assert.deepEqual(h.modelCalls.slice(before), [], `“${text}” called no model route`);
      return t;
    },
  };
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.accept());
  page.on("request", (r) => { if (/\/api\/(?:copilot\/turn|ai\/logic)\b/.test(r.url())) h.modelCalls.push(r.url()); });
  return h;
}

/* ------------------------------------------------ the runtime window */
const cardText = (pv, qid) => pv.$eval(`[data-rs-el="question"][data-rs-id="${qid}"]`, (e) => e.textContent.replace(/\s+/g, " ").trim()).catch(() => null);
const optionCodes = (pv, qid) => pv.$$eval(`[data-rs-el="question"][data-rs-id="${qid}"] [data-rs-el="option"]`, (os) => os.map((o) => o.getAttribute("data-rs-id")));
const shownIds = (pv) => pv.$$eval('[data-rs-el="question"]', (qs) => qs.map((x) => x.getAttribute("data-rs-id")));
/** the window shows this within the push (250 ms debounce) plus a render — 4 s is generous, and nothing re-opens the window */
const follows = async (pv, what, fn) => {
  const until = Date.now() + 4000;
  let last;
  while (Date.now() < until) { last = await fn(); if (last === true) return; await pv.waitForTimeout(150); }
  assert.fail(`the preview window did not follow: ${what} (last: ${JSON.stringify(last)})`);
};
const clickOption = (pv, qid, code) => pv.click(`[data-rs-el="question"][data-rs-id="${qid}"] [data-rs-el="option"][data-rs-id="${code}"]`);
const next = async (pv) => { await pv.click('[data-testid="rs-next"]'); await pv.waitForTimeout(500); };

/* ================================================ A. the Preview window follows Intelligent mode */
{
  const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } });
  const s = studio(await context.newPage());
  const { page } = s;
  await page.goto(`${STUDIO}/sandbox?mode=studio`, { waitUntil: "networkidle" });
  await page.waitForSelector(".menubar");
  await s.loadDef(FIXTURE);
  await s.intelligent();
  const fake = await page.evaluate(() => typeof window.__rescriptCopilotFake === "function");

  // the Studio's Preview button — opened ONCE
  const [pv] = await Promise.all([context.waitForEvent("page"), page.click('button[title^="Full-page preview"]')]);
  pv.on("pageerror", (e) => errors.push(`runtime: ${e}`));
  await pv.waitForLoadState("networkidle");
  await pv.waitForSelector('[data-rs-el="question"][data-rs-id="gender"]', { timeout: 15000 });
  assert.match(await cardText(pv, "gender"), /What is your gender\?/);
  ok("the Studio's Preview window opens on the runtime with the survey in the store");

  // a question's text
  await s.engine("change the text of Q1 to “Which gender do you identify with?”");
  await follows(pv, "Q1's new text", async () => /Which gender do you identify with\?/.test((await cardText(pv, "gender")) ?? "") || await cardText(pv, "gender"));
  ok("“change the text of Q1 …”: applied by the engine, shown in the open window");

  // an option relabelled
  await s.engine("change option “Female” in Q1 to “Woman”");
  await follows(pv, "the relabelled option", async () => { const t = (await cardText(pv, "gender")) ?? ""; return (/Woman/.test(t) && !/Female/.test(t)) || t; });
  ok("“change option “Female” in Q1 to “Woman””: the window shows Woman, not Female");

  // a translation (the model's, through the fake provider) — then a recode moves it with the option
  if (fake) {
    const t = await s.say("Translate Q1 into German", {
      kind: "proposal", reply: "I'll add German and translate Q1.",
      actions: [
        { op: "add_language", code: "de" },
        { op: "set_translations", language: "de", entries: [
          { target: "Q1", text: "Welchem Geschlecht fühlen Sie sich zugehörig?" },
          { target: "Q1.option:1", text: "Mann" }, { target: "Q1.option:2", text: "Frau" },
        ] },
      ],
    });
    await s.apply(t);
  }

  // an option recoded: the runtime draws code 5, and the German translation went with it
  await s.engine("recode option Male in Q1 as 5");
  await follows(pv, "Male recoded to 5", async () => { const c = await optionCodes(pv, "gender"); return (c.includes("5") && !c.includes("1")) || c; });
  if (fake) {
    const def = await s.readDef();
    const de0 = def.localization.translations.de;
    assert.equal(de0["q:gender:opt:5"]?.text, "Mann", `the translation moved to the new code: ${JSON.stringify(Object.keys(de0))}`);
    assert.equal(de0["q:gender:opt:1"], undefined, "and is not left behind on the old one");
    const de = await openPreview(browser, RUNTIME, { definition: def }, { search: "?lang=de" });
    const card = await cardText(de, "gender");
    assert.match(card, /Welchem Geschlecht/, card);
    assert.equal(await de.$eval('[data-rs-el="question"][data-rs-id="gender"] [data-rs-el="option"][data-rs-id="5"]', (e) => e.textContent.trim()), "Mann", "option 5 is Mann in German");
    await de.close();
    ok("translated by the model, then recoded by the engine: the runtime in German shows “Mann” on code 5 (the translation moved with the recode)");
  } else ok("“recode option Male in Q1 as 5”: the window draws code 5 (no fake provider: translation step skipped)");

  // an option added
  await s.engine("add options Diverse to Q1");
  await follows(pv, "the new option", async () => /Diverse/.test((await cardText(pv, "gender")) ?? "") || await cardText(pv, "gender"));
  ok("“add options Diverse to Q1”: the new option is drawn");

  // a question deleted, then restored from History
  await s.engine("delete Q2");
  await follows(pv, "Q2 gone", async () => !(await shownIds(pv)).includes("age") || await shownIds(pv));
  await s.panel("history");
  const latest = await page.waitForSelector('[data-op="true"][data-status="applied"]', { timeout: 10000 });
  assert.match(await latest.$eval('[data-testid="cp-op-prompt"]', (e) => e.textContent), /delete Q2/);
  await (await latest.$('[data-testid="cp-undo-change"]')).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-op="true"]')].some((e) => e.getAttribute("data-status") === "reverted" && /delete Q2/.test(e.textContent)), null, { timeout: 10000 });
  await follows(pv, "Q2 restored", async () => (await shownIds(pv)).includes("age") || await shownIds(pv));
  ok("“delete Q2”: gone from the window; Restore in History brings it back, in the window too");

  // display logic across pages, answered in the window
  await s.engine("Show Q4 only if Q3 is Yes");
  const def = await s.readDef();
  assert.match(JSON.stringify(def.questions.find((x) => x.id === "why").displayLogic), /"value":1/);
  await pv.waitForTimeout(800);
  await next(pv);                                      // page 1 → page 2 (Q3)
  await pv.waitForSelector('[data-rs-el="question"][data-rs-id="aware"]');
  await clickOption(pv, "aware", 2);                   // No
  await next(pv);
  const after = await shownIds(pv);
  assert.ok(!after.includes("why") && after.includes("nps"), `on No, Q4 is not asked: ${after}`);
  ok("“Show Q4 only if Q3 is Yes”: answering No in the window goes past Q4");

  // the open window was never re-opened
  assert.equal(context.pages().filter((p) => p.url().startsWith(`${RUNTIME}/preview`) && p !== pv).length, 0, "one preview window throughout");
  await context.close();
}

/* ================================================ B. Test Survey carries the applied change */
{
  const SURVEY = "11111111-2222-3333-4444-555555555555";
  const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } });
  const server = { revision: 0, drafts: [], versions: [], deploys: [] };
  await context.route(`**/api/surveys/${SURVEY}/draft`, async (route) => {
    const req = route.request();
    if (req.method() !== "PUT") return route.fulfill({ status: 200, body: "{}" });
    const body = JSON.parse(req.postData());
    if (body.baseRevision !== server.revision) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "changed elsewhere", conflict: true, revision: server.revision }) });
    await new Promise((r) => setTimeout(r, 400));                 // a save that takes a moment: the card must wait for it
    server.revision += 1; server.drafts.push(body.definition);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, savedAt: new Date().toISOString(), revision: server.revision }) });
  });
  await context.route(`**/api/surveys/${SURVEY}/versions`, async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ versions: [] }) });
    const body = JSON.parse(route.request().postData());
    server.versions.push(body.definition); server.revision += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: `ver_${server.versions.length}`, version: `1.${server.versions.length}`, variables: 5, revision: server.revision }) });
  });
  await context.route(`**/api/surveys/${SURVEY}/deploy`, async (route) => {
    const body = JSON.parse(route.request().postData()); server.deploys.push(body);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, url: `${RUNTIME}/t/${body.clientSlug}/${body.studySlug}` }) });
  });
  await context.route(`**/api/surveys/${SURVEY}/publish`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deployments: [] }) }));
  await context.route(`**/api/surveys/${SURVEY}/responses*`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await context.route("**/t/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: `<html><body data-testid="stub-test">stub</body></html>` }));

  const s = studio(await context.newPage());
  const { page } = s;
  await page.goto(`${STUDIO}/sandbox?dbid=${SURVEY}&rev=0`, { waitUntil: "networkidle" });
  await page.waitForSelector(".menubar");
  await s.loadDef({ ...FIXTURE, deployment: { clientSlug: "client", studySlug: "study-001" } });
  await page.waitForTimeout(1500);                                // the load's own autosave
  await s.intelligent();

  const t = await s.engine("make Q2 required");
  const kicker = await t.$eval(".iq-kicker", (e) => e.textContent.trim());
  assert.match(kicker, /^APPLIED · SAVED/, `the card says saved only once the save returned: ${kicker}`);
  assert.equal(await t.getAttribute("data-save"), "saved");
  assert.equal(server.drafts.at(-1).questions.find((x) => x.id === "age").required, true, "the saved draft carries the change");
  ok(`“make Q2 required” in a saved survey: the draft the server received has it, and the card reads “${kicker}”`);

  const [tab] = await Promise.all([context.waitForEvent("page"), page.click('[data-testid="test-survey"]')]);
  await tab.waitForURL(/\/t\/client\/study-001/, { timeout: 15000 });
  assert.equal(server.versions.length, 1, "Test Survey cut one version");
  const ver = server.versions[0];
  assert.equal(ver.questions.find((x) => x.id === "age").required, true, "the test build carries the applied change");
  assert.deepEqual(server.deploys.at(-1) && [server.deploys.at(-1).clientSlug, server.deploys.at(-1).studySlug], ["client", "study-001"]);

  // the build, run: Q2 is required in the runtime — Next without an answer stays on the page and says so
  const rt = await openPreview(browser, RUNTIME, { definition: ver });
  await rt.waitForSelector('[data-rs-el="question"][data-rs-id="age"]');
  await clickOption(rt, "gender", 1);
  await rt.click('[data-testid="rs-next"]'); await rt.waitForTimeout(500);
  assert.ok((await shownIds(rt)).includes("age"), "still on page 1: Q2 is required");
  await rt.fill('[data-rs-el="question"][data-rs-id="age"] input', "34");
  await next(rt);
  assert.ok((await shownIds(rt)).includes("aware"), "answered: on to page 2");
  await rt.close();
  ok("Test Survey: the version cut and deployed carries the change, and the runtime enforces it (Q2 required)");
  await context.close();
}

assert.deepEqual(errors.filter((e) => !/ResizeObserver/.test(e)), [], `no page errors: ${errors.join("\n")}`);
await browser.close();
console.log(`\n${passed} checks passed`);
