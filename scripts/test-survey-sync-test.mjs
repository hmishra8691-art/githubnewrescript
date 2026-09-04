/**
 * Builder → Save → Test Survey consistency (the 2026-09-03 "Test Survey loads
 * Version 1" report).
 *
 * Drives the real editor against a fake server that behaves like the routes
 * (revision guard, versions, deploy), and proves:
 *
 *   1. autosave persists every edit under an increasing revision, and the
 *      final persisted draft is the final state — never an intermediate one;
 *   2. "All changes saved" is never shown while newer edits exist;
 *   3. Test Survey saves FIRST (draft flush, then a version carrying the
 *      current definition), deploys that version, and opens the test link
 *      with `?v=<that version id>` — the handshake the runtime verifies;
 *   4. a failed save refuses to open the test survey and says why;
 *   5. an editor in conflict (behind the server) refuses to save or test,
 *      so an older state can never overwrite a newer one;
 *   6. an edit made moments before clicking Test Survey is in the version.
 *
 * The runtime half — a test link resolving to the latest saved state and
 * never falling back — is `packages/engine/src/testBuild.test.ts`.
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";

const SURVEY = "11111111-2222-3333-4444-555555555555";
const browser = await chromium.launch();

async function studioWithServer(opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  page.on("dialog", (d) => d.accept());
  const toasts = [];
  page.on("console", (m) => { if (/rescript:(save|test)/.test(m.text())) toasts.push(m.text()); });

  const server = { revision: 0, draft: null, writes: [], versions: [], deploys: [], rejected: 0, events: [] };

  await context.route(`**/api/surveys/${SURVEY}/draft`, async (route) => {
    const req = route.request();
    if (req.method() !== "PUT") return route.fulfill({ status: 200, body: "{}" });
    const body = JSON.parse(req.postData());
    server.writes.push(body);
    server.events.push("draft");
    if (opts.rejectDrafts || body.baseRevision !== server.revision) {
      server.rejected++;
      return route.fulfill({ status: 409, contentType: "application/json",
        body: JSON.stringify({ error: "changed elsewhere", conflict: true, revision: server.revision }) });
    }
    if (opts.slowDraftMs) await new Promise((r) => setTimeout(r, opts.slowDraftMs));
    server.revision += 1;
    server.draft = body.definition;
    return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, savedAt: new Date().toISOString(), revision: server.revision }) });
  });
  await context.route(`**/api/surveys/${SURVEY}/versions`, async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ versions: [] }) });
    server.events.push("version");
    if (opts.failVersions) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "database unavailable" }) });
    const body = JSON.parse(route.request().postData());
    // the real route refuses a cut from an editor that is behind (the DB guard);
    // -1 / null still forces, for the sandbox and older builds
    if (typeof body.baseRevision === "number" && body.baseRevision >= 0 && body.baseRevision !== server.revision) {
      server.rejectedVersions = (server.rejectedVersions ?? 0) + 1;
      return route.fulfill({ status: 409, contentType: "application/json",
        body: JSON.stringify({ error: "This survey was changed elsewhere after your editor loaded it, so no version was cut.", conflict: true, revision: server.revision }) });
    }
    server.versions.push(body.definition);
    server.revision += 1;
    server.draft = null;
    const n = server.versions.length;
    return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ id: `ver_${n}`, version: `1.${n}`, variables: 3, revision: server.revision }) });
  });
  await context.route(`**/api/surveys/${SURVEY}/deploy`, async (route) => {
    const body = JSON.parse(route.request().postData());
    server.deploys.push(body);
    server.events.push("deploy");
    return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, url: `http://localhost:3001/t/${body.clientSlug}/${body.studySlug}` }) });
  });
  await context.route(`**/api/surveys/${SURVEY}/publish`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deployments: [] }) }));
  await context.route(`**/api/surveys/${SURVEY}/responses*`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  // the test tab: serve a stub so the popup's URL can be inspected without a database
  await context.route("**/t/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: `<html><body data-testid="stub-test">stub ${route.request().url()}</body></html>` }));

  await page.goto(`http://localhost:3000/sandbox?dbid=${SURVEY}&rev=0`, { waitUntil: "networkidle" });
  await page.waitForSelector(".block-badge");
  return { context, page, server, toasts };
}

const addQuestion = async (page, text) => {
  const bars = await page.$$(".insert-bar");
  await (await bars[bars.length - 1].$("text=+ Question")).click();
  await page.waitForSelector(".qcard.selected .rte-surface");
  await page.waitForFunction(() => document.activeElement?.classList.contains("rte-surface"));
  await page.keyboard.type(text);
  await page.waitForTimeout(120);
};
const settle = (page) => page.waitForTimeout(1500);
const saveState = (page) => page.$eval('[data-testid="save-state"]', (e) => e.textContent.trim());
const toastText = (page) => page.$eval(".toast", (e) => e.textContent).catch(() => "");

/* ============================================ 1. every edit persists, in order */
{
  const { context, page, server } = await studioWithServer();
  for (const t of ["Q1 age", "Q2 gender", "Q3 region", "Q4 income", "Q5 brand"]) await addQuestion(page, t);
  await settle(page);
  assert.equal(server.rejected, 0, "no write was refused");
  assert.equal(server.draft.questions.length, 5, "the FINAL draft holds all five questions");
  const revisions = server.writes.map((w) => w.baseRevision);
  assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b), "writes were based on non-decreasing revisions");
  assert.equal(server.writes.at(-1).baseRevision, server.revision - 1, "the last write was based on the then-current revision");
  assert.match(await saveState(page), /saved/i);
  assert.match(await page.$eval(".topbar .ver", (e) => e.textContent), /rev \d+/, "the header shows the revision the editor is on");
  console.log(`✔ five rapid edits → ${server.writes.length} writes, final draft complete, revision ${server.revision}, header shows rev`);

  /* -------------------------- "saved" is never claimed while edits are pending */
  const { server: s2, page: p2, context: c2 } = await studioWithServer({ slowDraftMs: 900 });
  await addQuestion(p2, "Q1");
  // wait for the first save to be in flight (the slow server holds it 900ms)
  await p2.waitForFunction(() => /saving/i.test(document.querySelector('[data-testid="save-state"]')?.textContent ?? ""), null, { timeout: 5000 });
  await addQuestion(p2, "Q2");              // edit DURING the in-flight save
  // the moment the in-flight save lands, Q2 is still unsaved: the header must
  // not read "all changes saved" — it should read unsaved, or saving again
  await p2.waitForFunction(() => !/saving/i.test(document.querySelector('[data-testid="save-state"]')?.textContent ?? "") ||
    (window.__sawDirtyAfterSave = window.__sawDirtyAfterSave || false, false), null, { timeout: 5000 }).catch(() => {});
  const mid = await saveState(p2);
  assert.doesNotMatch(mid, /all changes saved/i, `while Q2 is unsaved the header must not claim everything is saved (read: "${mid}")`);
  await settle(p2); await p2.waitForTimeout(1500);
  assert.equal(s2.draft.questions.length, 2, "the queued autosave carried Q2");
  assert.match(await saveState(p2), /saved/i);
  console.log("✔ an edit made during an in-flight save is reported as unsaved until its own save lands");
  await c2.close();

  /* ===================================== 3. Test Survey saves, then opens EXACTLY that */
  await addQuestion(page, "Q6 added just before testing");     // unsaved at click time
  const popupP = context.waitForEvent("page");
  await page.click('[data-testid="test-survey"]');
  const popup = await popupP;
  await popup.waitForURL(/\/t\/.*\?v=ver_\d+/, { timeout: 10000 });
  const url = popup.url();
  assert.match(url, /\/t\/client\/study-001\?v=ver_1$/, `the test tab opened with the saved version's id: ${url}`);
  assert.equal(server.versions.length, 1, "one version was cut");
  assert.equal(server.versions[0].questions.length, 6, "the version contains the edit made just before the click — save-before-test");
  assert.deepEqual(server.deploys.map((d) => d.versionId), ["ver_1"], "and that exact version was deployed");
  const order = server.events.join(",");
  assert.match(order, /draft,version,deploy$/, `draft flush → version → deploy, in that order: ${order}`);
  assert.equal(await page.$eval('[data-testid="test-survey"]', (e) => e.title), await page.$eval('[data-testid="test-survey"]', (e) => e.title));
  assert.match(await page.$eval('[data-testid="test-survey"]', (e) => e.title), /Last test build: v1\.1/, "the button remembers which build it opened");
  console.log("✔ Test Survey: flush → version (with the last-second edit) → deploy → open ?v=<that id>");

  // a second click cuts a second version and opens THAT — never the first
  await addQuestion(page, "Q7");
  // the named test window is reused, so the same popup navigates
  await page.click('[data-testid="test-survey"]');
  await popup.waitForURL(/\?v=ver_2$/, { timeout: 10000 });
  assert.equal(server.versions[1].questions.length, 7);
  console.log("✔ the next Test Survey opens the NEXT version, carrying the newer edit");
  await context.close();
}

/* ======================================== 4. a failed save blocks testing */
{
  const { context, page, server } = await studioWithServer({ failVersions: true });
  await addQuestion(page, "Q1");
  await settle(page);
  const before = context.pages().length;
  await page.click('[data-testid="test-survey"]');
  await page.waitForSelector(".toast");
  assert.match(await toastText(page), /could not be saved.*retry before starting the test survey/i,
    "the tester is told the latest changes were not saved and testing is refused");
  await page.waitForTimeout(500);
  assert.equal(context.pages().length, before, "no test tab is left open on an older build");
  assert.equal(server.deploys.length, 0, "nothing was deployed");
  console.log("✔ a failed save refuses to open the test survey and says why");
  await context.close();
}

/* ======================================== 5. a stale editor cannot overwrite */
{
  const { context, page, server } = await studioWithServer({ rejectDrafts: true });
  await addQuestion(page, "Q1");
  await settle(page);
  assert.match(await saveState(page), /changed elsewhere/i, "the editor knows it is behind");
  const versionsBefore = server.versions.length;
  await page.click('[data-testid="test-survey"]');
  await page.waitForSelector(".toast");
  assert.match(await toastText(page), /changed elsewhere.*reload/i);
  assert.equal(server.versions.length, versionsBefore, "no version was cut from the stale state");
  await page.click("text=Save version");
  await page.waitForTimeout(400);
  assert.equal(server.versions.length, versionsBefore, "Save version is refused too — an older state never overwrites a newer one");
  console.log("✔ an editor behind the server refuses to save or test; only Reload gets it moving again");
  await context.close();
}

/* ===== 5b. the conflict is discovered BY the flush inside Save, not before */
{
  /*
   * The case §5 does not cover, and the one that actually bit: a tab left
   * open while the survey moved on elsewhere. It has no pending autosave, so
   * it knows nothing — `hasConflict()` is false — and the flush inside
   * `save()` is the first write in hours. The old code awaited that flush,
   * ignored what it learned, and cut a version anyway; the version route
   * forced past the database's revision guard, so the stale definition became
   * the current version.
   */
  const { context, page, server } = await studioWithServer();
  await addQuestion(page, "Q1");
  await settle(page);
  assert.equal(server.rejected, 0, "the editor starts in sync");
  const versionsBefore = server.versions.length;
  assert.doesNotMatch(await saveState(page), /changed elsewhere/i, "and does not yet know anything is wrong");

  // the survey moves on elsewhere — this tab is told nothing
  server.revision += 5;

  await page.click("text=Save version");
  await page.waitForSelector(".toast");
  assert.match(await toastText(page), /changed elsewhere.*unsaved edits in this tab will be lost/i,
    "the refusal says what reloading costs");
  assert.equal(server.versions.length, versionsBefore, "NO version was cut from the stale state");
  assert.match(await saveState(page), /changed elsewhere/i, "and the editor is now visibly in conflict, not just toasted");

  // Test Survey must not get through either — it saves a version first
  await page.click('[data-testid="test-survey"]');
  await page.waitForTimeout(400);
  assert.equal(server.versions.length, versionsBefore, "Test Survey cannot cut one either");
  assert.equal(server.deploys.length, 0, "and nothing was deployed");
  console.log("✔ a conflict discovered by the flush inside Save stops the version cut — a stale tab cannot overwrite newer work");
  await context.close();
}

/* ===== 5c. the server refuses a stale cut even if the client waves it through */
{
  const { context, page, server } = await studioWithServer();
  await addQuestion(page, "Q1");
  await settle(page);
  const versionsBefore = server.versions.length;
  // the client's own draft flush succeeds, then the row moves under it: only
  // the baseRevision travelling with the POST can catch this
  await page.evaluate(() => {
    const orig = window.fetch;
    window.fetch = (u, o) => {
      if (String(u).includes("/draft")) return Promise.resolve(new Response(JSON.stringify({ ok: true, savedAt: new Date().toISOString(), revision: 1 }), { status: 200, headers: { "content-type": "application/json" } }));
      return orig(u, o);
    };
  });
  server.revision = 99;
  await page.click("text=Save version");
  await page.waitForSelector(".toast");
  assert.equal(server.versions.length, versionsBefore, "the server refused it");
  assert.ok((server.rejectedVersions ?? 0) >= 1, "and refused it on the revision the POST carried");
  assert.match(await toastText(page), /changed elsewhere/i);
  console.log("✔ the version POST carries the editor's revision, so the server refuses a stale cut on its own");
  await context.close();
}

/* ======================================== 6. a failed autosave offers Retry */
{
  const { context, page, server } = await studioWithServer();
  await context.unroute(`**/api/surveys/${SURVEY}/draft`);
  let fail = true;
  await context.route(`**/api/surveys/${SURVEY}/draft`, async (route) => {
    if (route.request().method() !== "PUT") return route.fulfill({ status: 200, body: "{}" });
    server.writes.push(fail ? "500" : "200");
    if (fail) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "database unavailable" }) });
    server.revision += 1;
    server.draft = JSON.parse(route.request().postData()).definition;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, savedAt: new Date().toISOString(), revision: server.revision }) });
  });
  await addQuestion(page, "Q1");
  await settle(page);
  assert.match(await saveState(page), /save failed/i, "a failed save is reported, not hidden");
  assert.ok(await page.$('[data-testid="save-retry"]'), "and a Retry is offered");
  fail = false;
  await page.click('[data-testid="save-retry"]');
  // the click also blur-commits the text field; that edit's own autosave
  // follows ~900ms later, and only then is everything saved
  await page.waitForTimeout(1500);
  assert.match(await saveState(page), /saved/i, "Retry persisted it");
  assert.equal(server.draft.questions.length, 1);
  console.log("✔ Save failed — Retry works");
  await context.close();
}

await browser.close();
console.log("\nALL TEST-SURVEY SYNC CHECKS PASSED");
