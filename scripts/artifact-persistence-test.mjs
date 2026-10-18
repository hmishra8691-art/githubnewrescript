/**
 * PERSISTENT DOCUMENT LINKS, END TO END (2026-10-18, docs/ARTIFACTS-AND-REPORT-THEMES-2026-10-18.md).
 *
 *   §1 the sandbox: "prepare a Word research plan" → a card with the file (ONE generation request)
 *   §2 asking again → the kept file, "kept from earlier", no request
 *   §3 RELOAD → the card is offered again (restored, current) → Download → the same valid file, no request
 *   §4 the Research tab lists the kept version (v1, current) and downloads it without a request
 *   §5 the design changes → "New version available" in the Research tab and on the card → Make the new
 *      version → one more request, version 2; the earlier version stays downloadable
 *   §6 a SAVED project (API mocked in the real routes' shapes): after a reload the card comes back from
 *      GET /artifacts, Download asks GET /artifacts/<id> for a signed link and saves the file — no output
 *      request; a second Download asks for a NEW link (an expired link is never reused); a 403 (another
 *      person's private document) is said on the card
 *
 * The number of generation requests (POST /api/copilot/output) is counted from the network throughout.
 *
 *   node scripts/artifact-persistence-test.mjs      (studio on 3000, fake AI provider; build @rescript/analytics first)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "./lib/playwright.mjs";
import { openTab, switchMode } from "./lib/nav.mjs";
import { checkDocx, buildResearchPlanDocx } from "../packages/analytics/dist/export/index.js";
import { SurveyDefinition } from "../packages/schema/dist/index.js";

const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
let passed = 0;
const ok = (m) => { console.log("  ok  ", m); passed++; };
const opts = (...ls) => ls.map((l, i) => ({ code: i + 1, label: l }));
const FIXTURE = {
  meta: { id: "sandbox", code: "KEEP26", title: "Kept documents study", version: "1.0" },
  research: { objective: "Why consumers choose Brand A over Brand B", hypotheses: ["Brand trust increases purchase intention"], analysis: [], assumptions: [], sources: [] },
  questions: [
    { id: "gender", code: "S2", variableName: "GENDER", type: "single_select", text: "Gender", options: opts("Male", "Female") },
    { id: "pi", code: "Q1", variableName: "PURCHASE_INT", type: "single_select", text: "How likely are you to buy Brand A?", options: opts("Unlikely", "Neutral", "Likely") },
  ],
  flow: [{ type: "block", id: "b1", title: "Main", children: [{ type: "page", id: "p1", questionIds: ["gender", "pi"] }] }, { type: "end", id: "e", status: "complete" }],
};
const NAME = /^KEEP26_Research_Plan_\d{4}-\d{2}-\d{2}\.docx$/;

const browser = await chromium.launch();
const errors = [];

async function studioPage(context, url, seed) {
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  /* a dev server recompiling under a reload is not this suite's subject (see reloadStudio); every other page error fails it */
  page.on("pageerror", (e) => { if (!/ChunkLoadError|Loading chunk .* failed/.test(String(e))) errors.push(String(e)); });
  page.on("console", (m) => { if (m.type() === "error" && /artifact|sandboxArtifacts|DocumentOutput/i.test(m.text())) errors.push(`console: ${m.text()}`); });
  if (seed) await page.addInitScript((d) => { window.__rescriptSandboxSeed = d; }, seed);
  const counts = { output: 0, links: 0, lists: 0 };
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/api\/copilot\/output$/.test(r.url())) counts.output++;
    if (r.method() === "GET" && /\/api\/surveys\/[^/]+\/artifacts\/[^/?]+/.test(r.url())) counts.links++;
    if (r.method() === "GET" && /\/api\/surveys\/[^/]+\/artifacts(\?|$)/.test(r.url())) counts.lists++;
  });
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector(".menubar");
  return { page, counts };
}
const helpers = (page) => {
  const turns = () => page.$$('[data-testid="cp-turn"]');
  return {
    turns,
    intelligent: async () => { await openTab(page, "Questions"); await switchMode(page, "intelligent"); await page.waitForSelector('[data-testid="intelligent-view"]'); },
    say: async (text) => {
      const n = (await turns()).length;
      await page.fill('[data-testid="iq-input"]', text);
      await page.keyboard.press("Enter");
      await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") !== "thinking"; }, n, { timeout: 60000 });
      await page.waitForTimeout(300);
      return (await turns()).at(-1);
    },
    download: async (click) => {
      const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), click()]);
      const buf = readFileSync(await dl.path());
      const c = checkDocx(buf);
      assert.deepEqual(c.problems, [], `a valid .docx (${dl.suggestedFilename()})`);
      return { name: dl.suggestedFilename(), c, buf };
    },
    loadDef: async (def) => {
      await openTab(page, "JSON");
      await page.waitForSelector("textarea.code");
      await page.click('button:has-text("edit")');
      await page.$eval("textarea.code", (el, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }, JSON.stringify(def));
      await page.click('button:has-text("validate & apply")');
      await page.waitForTimeout(600);
    },
  };
};
/*
 * A RELOAD ON A SHARED DEV SERVER: the first request after a reload can land while the dev server recompiles
 * (or while its supervisor restarts it after another suite), which shows a blank page or "Loading chunk … failed"
 * for longer than one wait. The page is reloaded once more in that case — a page error from OUR code still fails
 * the suite (it is collected in `errors` and asserted at the end).
 */
async function reloadStudio(page) {
  for (let attempt = 1; ; attempt++) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 }).catch(() => null);
    try { await page.waitForSelector(".menubar", { timeout: 60000 }); return; }
    catch (e) {
      if (attempt >= 3) throw new Error(`the Studio did not come back after a reload (${attempt} tries): ${e.message}`);
      console.log(`  …  the Studio was not up after the reload (try ${attempt}); reloading again`);
      await page.waitForTimeout(5000);
    }
  }
}
const textOf = async (h) => (await h.evaluate((e) => e.innerText)).replace(/\s+/g, " ");

/* ============================================================ §1–§5 the sandbox (this tab keeps its documents) */
{
  const context = await browser.newContext({ viewport: { width: 1700, height: 1150 }, acceptDownloads: true });
  let { page, counts } = await studioPage(context, `${STUDIO}/sandbox?mode=studio`, FIXTURE);
  let h = helpers(page);

  console.log("\n§1 GENERATE — one request, a card with the file");
  await h.intelligent();
  let turn = await h.say("prepare a Word research plan");
  assert.match(await textOf(turn), /The research plan \(Word\) is ready: KEEP26_Research_Plan_\d{4}-\d{2}-\d{2}\.docx \(\d+ KB\)\..* Version 1\./);
  assert.equal(counts.output, 1, "one generation request");
  let doc = await h.download(() => turn.$eval('[data-testid="cp-output-download"]', (a) => a.click()));
  assert.match(doc.name, NAME);
  const v1Text = doc.c.text;
  ok("“prepare a Word research plan” → one POST /api/copilot/output → a card offering KEEP26_Research_Plan_<date>.docx (version 1)");

  console.log("\n§2 ASK AGAIN — the kept file, no request");
  turn = await h.say("prepare a Word research plan");
  assert.match(await textOf(turn), /Version 1, kept from earlier — nothing changed, so nothing was regenerated/);
  assert.equal(await (await turn.$('[data-testid="cp-output"]')).getAttribute("data-reused"), "1");
  assert.equal(counts.output, 1, "no second generation request");
  ok("the same request again: the kept version, said so, and still ONE generation request");

  console.log("\n§3 RELOAD — the link is restored and downloads without generating");
  await reloadStudio(page);
  counts.output = 0;
  h = helpers(page);
  await h.intelligent();
  const restored = await page.waitForSelector('[data-testid="cp-output"][data-restored="1"]', { timeout: 15000 });
  assert.equal(await restored.getAttribute("data-stale"), "0", "nothing changed: the kept version is current");
  assert.equal(await restored.getAttribute("data-version"), "1");
  doc = await h.download(() => restored.$eval('[data-testid="cp-output-download"]', (b) => b.click()));
  assert.match(doc.name, NAME);
  assert.equal(doc.c.text, v1Text, "the same document");
  assert.equal(counts.output, 0, "no generation request after the reload");
  ok("after a reload the card is back (restored, current, v1); Download saves the same file and makes no generation request");

  console.log("\n§4 THE RESEARCH TAB — the kept version, downloaded without a request");
  await openTab(page, "Survey Settings");
  const DOCS = '[data-testid="research-documents"]';
  const line = await page.waitForSelector(`${DOCS} [data-testid="doc-line-research_plan_docx"][data-version="1"]`, { timeout: 15000 });
  assert.equal(await line.getAttribute("data-state"), "current");
  assert.match(await page.$eval(`${DOCS} [data-testid="doc-research_plan_docx"]`, (b) => b.textContent), /Research plan \(\.docx\) · v1/);
  doc = await h.download(() => page.click(`${DOCS} [data-testid="doc-research_plan_docx"]`));
  assert.equal(doc.c.text, v1Text);
  assert.equal(counts.output, 0, "the Research tab downloaded the kept file");
  ok("the Research tab shows “Research plan (.docx) · v1” (current) and downloads the kept file with no request");

  console.log("\n§5 THE DESIGN CHANGES — a new version is available, made on request; the earlier one kept");
  const changed = structuredClone(FIXTURE);
  changed.research.hypotheses.push("Women intend to buy Brand A more than men do");
  await h.loadDef(changed);
  await openTab(page, "Survey Settings");
  await page.waitForSelector(`${DOCS} [data-testid="doc-line-research_plan_docx"][data-state="stale"]`, { timeout: 15000 });
  assert.ok(await page.$(`${DOCS} [data-testid="doc-stale-research_plan_docx"]`), "“New version available” in the Research tab");
  await h.intelligent();
  const stale = await page.waitForSelector('[data-testid="cp-output"][data-stale="1"]', { timeout: 15000 });
  assert.match(await textOf(stale), /A new version is available/);
  const before = (await h.turns()).length;
  await stale.$eval('[data-testid="cp-output-regenerate"]', (b) => b.click());
  await page.waitForFunction((k) => { const t = document.querySelectorAll('[data-testid="cp-turn"]'); return t.length > k && t[t.length - 1].getAttribute("data-status") === "ready"; }, before, { timeout: 60000 });
  const v2 = (await h.turns()).at(-1);
  assert.equal(await (await v2.$('[data-testid="cp-output"]')).getAttribute("data-version"), "2");
  assert.equal(counts.output, 1, "exactly one generation for the new version");
  doc = await h.download(() => v2.$eval('[data-testid="cp-output-download"]', (a) => a.click()));
  assert.ok(doc.c.text.includes("Women intend to buy Brand A more than men do"), "version 2 carries the new hypothesis");
  await openTab(page, "Survey Settings");
  await page.waitForSelector(`${DOCS} [data-testid="doc-line-research_plan_docx"][data-version="2"][data-state="current"]`, { timeout: 15000 });
  const earlier = await page.$$eval(`${DOCS} [data-testid="doc-versions-research_plan_docx"] option`, (os) => os.map((o) => o.textContent));
  assert.ok(earlier.some((t) => /^v1 · /.test(t)), `version 1 stays downloadable: ${earlier}`);
  ok("a changed design: “New version available” (Research tab and card) → Make the new version → one request → v2 with the new hypothesis; v1 still listed");
  await context.close();
}

/* ============================================================ §6 a saved project (the artifacts API, mocked in the real routes' shapes) */
{
  const SURVEY = "11111111-2222-4333-8444-555555555555";
  const AID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const plan = await buildResearchPlanDocx(SurveyDefinition.parse(FIXTURE), { date: "2026-10-18" });
  const context = await browser.newContext({ viewport: { width: 1700, height: 1150 }, acceptDownloads: true });
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const view = { id: AID, type: "research_plan_docx", edition: "standard", version: 3, name: "KEEP26_Research_Plan_2026-10-18.docx", size: plan.length, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", createdAt: "2026-10-18T09:00:00Z", createdBy: "u1", summary: "Research plan: 1 hypotheses", narrative: null, visibility: "project", themeRef: null, themeVersion: null, fingerprint: "rese-0000000000000001", source: "copilot", inputs: {} };
  let linkNo = 0;
  let forbid = false;
  await context.route(`**/api/surveys/${SURVEY}/draft`, (route) => json(route, route.request().method() === "PUT" ? { ok: true, savedAt: new Date().toISOString(), revision: 1 } : {}));
  await context.route(`**/api/surveys/${SURVEY}/artifacts`, (route) => json(route, { lines: [{ type: "research_plan_docx", edition: "standard", label: "Research plan (.docx)", latest: view, versions: [view], state: "current", current: view.fingerprint }], theme: null }));
  await context.route(`**/api/surveys/${SURVEY}/artifacts/${AID}`, (route) => {
    if (forbid) return json(route, { error: "This document is private to the person who made it.", code: "artifact_private" }, 403);
    linkNo++;
    /* the "signed URL": a data: URL (a browser download from an <a download> is not routed through Playwright's interception, so a stand-in store URL would reach the dev server) — distinct per link */
    return json(route, { url: `data:${view.mime};base64,${Buffer.from(plan).toString("base64")}#sig=${linkNo}`, expiresAt: new Date(Date.now() + 120_000).toISOString(), name: view.name, size: plan.length, version: 3, mime: view.mime, artifact: view });
  });
  const { page, counts } = await studioPage(context, `${STUDIO}/sandbox?dbid=${SURVEY}&rev=0`, FIXTURE);
  const h = helpers(page);
  await h.intelligent();
  const card = await page.waitForSelector('[data-testid="cp-output"][data-restored="1"]', { timeout: 15000 });
  assert.equal(await card.getAttribute("data-artifact"), AID);
  assert.equal(await card.getAttribute("data-version"), "3");
  let doc = await h.download(() => card.$eval('[data-testid="cp-output-download"]', (b) => b.click()));
  assert.equal(doc.name, view.name);
  assert.equal(linkNo, 1, "one signed link minted for the download");
  doc = await h.download(() => card.$eval('[data-testid="cp-output-download"]', (b) => b.click()));
  assert.equal(linkNo, 2, "a second download asks for a NEW link (an expired one is never reused)");
  assert.equal(counts.output, 0, "no generation request");
  forbid = true;
  await card.$eval('[data-testid="cp-output-download"]', (b) => b.click());
  await page.waitForSelector('[data-testid="cp-output-note"]', { timeout: 10000 });
  assert.match(await page.$eval('[data-testid="cp-output-note"]', (e) => e.textContent), /private to the person who made it/);
  ok("a saved project: the kept document comes back from GET /artifacts after a reload; each Download mints a fresh signed link (2 downloads = 2 links), no generation; a 403 is said on the card");
  await context.close();
}

assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
await browser.close();
console.log(`\n${passed} checks passed`);
