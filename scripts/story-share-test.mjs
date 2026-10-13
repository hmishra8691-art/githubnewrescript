/**
 * STORY SHARING (Phase 4) — browser checks, end to end.
 *
 * Studio → Reports → a story → Share: publish the version (the REAL
 * `publishStory` over the in-memory database), create a link, open it in a
 * separate anonymous browser context where `/api/share/<token>` answers as
 * the real route does for a story (the frozen story document, nothing live),
 * and use the page a stakeholder gets: the player, keyboard navigation,
 * "How was this calculated?", reduced motion. Also: a story that fails the
 * checks is not published and the scene is named; the offline page file.
 *
 * Needs `pnpm dev:studio` (3000).
 *   node --experimental-strip-types --no-warnings scripts/story-share-test.mjs
 */
import { chromium } from "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { buildDataset, runPlan, runAnalysis } from "../packages/analytics/dist/index.js";
import { def as baseDef, synthRows } from "../packages/analytics/dist/analyses/fixture.js";
import { providerObjectStore } from "../packages/media/dist/index.js";
import { MemoryStorageProvider } from "../packages/storage/dist/index.js";
import { loadReportFonts, probe, inspectStoryPptx } from "../packages/reportvideo/dist/index.js";
import { composeReport, storyPlayerHtml, checkStoryForPublish } from "../packages/analytics/dist/story/index.js";
import { FakeDb, uuid } from "./lib/fakeSupabase.mjs";
import * as engine from "../apps/studio/lib/storyEngine.ts";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };
const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const SURVEY = "11111111-1111-4111-8111-111111111111";
const now = () => new Date().toISOString();

function planned() {
  const d = structuredClone(baseDef);
  d.research = {
    objective: "Understand what drives satisfaction and recommendation", population: "Adults", methodology: "Online panel",
    hypotheses: ["Women are more satisfied than men", "Satisfaction differs by region"], hypothesisDetails: [], researchQuestions: ["Who is most satisfied?"], kpis: [], constructs: [], analysis: [], assumptions: [], sources: [],
    brief: { client: "Acme Foods", businessQuestion: "Should we keep investing in service?", decision: "whether to fund the 2027 service programme", background: "", stakeholders: [], deliverables: [] },
    analysisPlan: { crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: ["H1"] }], tests: [{ id: "t1", method: "t_test", outcome: "SAT", variables: ["SAT"], groupBy: "GENDER", priority: 1, hypotheses: ["H1"] }, { id: "t2", method: "anova", outcome: "SAT", variables: ["SAT"], groupBy: "REGION", priority: 1, hypotheses: ["H2"] }], derived: [], segments: [] },
  };
  return SurveyDefinition.parse(d);
}

const db = new FakeDb();
const def = planned();
db.tables.surveys.push({ id: SURVEY, title: "Synthetic Study 2026", revision: 3, customer_id: "cust-1", draft_definition: JSON.parse(JSON.stringify(def)) });
const rows = synthRows(400);
const provider = new MemoryStorageProvider({ baseUrl: "https://store.test" });
const store = providerObjectStore(provider);
const fonts = loadReportFonts(fileURLToPath(new URL("../apps/studio/public/report-fonts/", import.meta.url)));
const usage = [];
const deps = {
  async runPlanFor(_db, _s, ctx, o) { const spec = { environment: o.environment ?? "LIVE", dataset: o.dataset ?? "all" }; const ds = buildDataset(ctx.def, spec.environment === "TEST" ? [] : rows, { spec }); const run = runPlan(ctx.def, ds, { trigger: o.trigger ?? "manual" }); return { run, stored: { id: uuid() } }; },
  async compute(_db, _s, ctx, d) { return runAnalysis(d, buildDataset(ctx.def, rows, { spec: d.dataset })); },
  async reportFacts() { return { client: "Acme Foods" }; },
  store: () => store, fonts: () => fonts, narration: () => null, usage: (e) => usage.push(e),
};
const ctx = { def, version: "1.0" };
let readOnly = false;

const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const failed = (route, f) => json(route, { error: f.error, ...(f.details !== undefined ? { details: f.details } : {}) }, f.status);

/* the stories API — the same dispatch as app/api/surveys/[id]/stories/[[...path]]/route.ts, over the real service */
async function storiesApi(route) {
  const req = route.request(); const url = new URL(req.url()); const m = req.method();
  const surveyId = url.pathname.match(/\/api\/surveys\/([^/]+)\/stories/)[1];
  const [storyId, sub, rid, action] = url.pathname.replace(`/api/surveys/${surveyId}/stories`, "").split("/").filter(Boolean);
  try {
    if (readOnly && m !== "GET") return json(route, { error: "You do not have permission to change reports in this project." }, 403);
    if (m === "GET" && storyId && sub === "page") {
      const row = await engine.loadStory(db, surveyId, storyId); const c = checkStoryForPublish(row.definition);
      if (!c.ok) return json(route, { error: "The page cannot be made yet.", problems: c.problems }, 409);
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: storyPlayerHtml(row.definition, { newerData: await engine.newerDataFor(db, row) }) });
    }
    if (m === "POST" && storyId && sub === "publish") {
      const row = await engine.loadStory(db, surveyId, storyId);
      const r = await engine.publishStory(db, row, { userId: "u1", note: null });
      return r.ok ? json(route, { reportId: r.reportId, version: r.version, publishedAt: r.publishedAt, warnings: r.warnings }, 201) : failed(route, r);
    }
    if (m === "GET") {
      if (!storyId) return json(route, { stories: await engine.listStories(db, surveyId) });
      if (storyId === "themes") return json(route, { themes: await engine.listThemes(db, surveyId, "cust-1") });
      const row = await engine.loadStory(db, surveyId, storyId); if (!row) return json(route, { error: "Unknown report." }, 404);
      if (!sub) return json(route, await engine.storyPayload(db, row, deps));
      if (sub === "compare") { const r = await engine.compareVersions(db, row, Number(url.searchParams.get("a")), Number(url.searchParams.get("b"))); return r.ok ? json(route, r) : failed(route, r); }
      if (sub === "renders" && action === "download") { const r = await engine.downloadLink(db, surveyId, rid, deps, url.searchParams.get("what") === "subtitles" ? "subtitles" : "file"); return r.ok ? json(route, r) : failed(route, r); }
    }
    const body = m === "POST" || m === "PUT" ? JSON.parse(req.postData() || "{}") : {};
    if (m === "POST" && storyId && sub === "brand") {
      const files = (body.files ?? []).map((f) => ({ name: f.name, mimeType: f.type || "application/octet-stream", bytes: new Uint8Array(Buffer.from(f.data, "base64")) }));
      const row = await engine.loadStory(db, surveyId, storyId);
      return json(route, engine.analyzeBrand(files, row.definition.design));
    }
    if (m === "POST" && !storyId) {
      const r = await engine.createStory(db, surveyId, ctx, { ...body, userId: "u1" }, deps);
      if (!r.ok) return failed(route, r);
      return json(route, await engine.storyPayload(db, await engine.loadStory(db, surveyId, r.id), deps), 201);
    }
    if (m === "POST" && storyId === "themes") { const r = await engine.saveTheme(db, { ...body, surveyId, customerId: "cust-1", userId: "u1" }); return r.ok ? json(route, r, 201) : failed(route, r); }
    const row = await engine.loadStory(db, surveyId, storyId); if (!row) return json(route, { error: "Unknown report." }, 404);
    const payload = async () => engine.storyPayload(db, await engine.loadStory(db, surveyId, storyId), deps);
    if (m === "PUT") { const r = await engine.saveDefinition(db, row, { definition: body.definition, baseVersion: Number(body.baseVersion), note: body.note, userId: "u1" }); return r.ok ? json(route, { saved: r, ...(await payload()) }) : failed(route, r); }
    if (m === "DELETE") { await db.from("analytics_story_reports").update({ deleted_at: now() }).eq("id", row.id); return json(route, { ok: true }); }
    if (sub === "status") { const r = await engine.setReviewStatus(db, row, body.status, deps); return r.ok ? json(route, await payload()) : failed(route, r); }
    if (sub === "revert") { const r = await engine.revertTo(db, row, Number(body.version), "u1"); return r.ok ? json(route, await payload()) : failed(route, r); }
    if (sub === "revise") {
      if (body.apply !== true) return json(route, { preview: engine.previewRevision(row, body.text, body.selected, body.brand), baseVersion: row.version });
      const r = await engine.applyRevision(db, row, { ops: body.ops, text: body.text, baseVersion: body.baseVersion, userId: "u1", brand: body.brand });
      return r.ok ? json(route, { result: r, ...(await payload()) }) : failed(route, r);
    }
    if (sub === "design") {
      if (body.apply !== true) return json(route, await engine.interpretDesign(row, body.text, deps, body.brand));
      const r = await engine.applyDesign(db, row, { patch: body.patch, design: body.design, baseVersion: body.baseVersion, note: body.note ?? "", userId: "u1", brand: body.brand });
      return r.ok ? json(route, { adjustments: r.adjustments, ...(await payload()) }) : failed(route, r);
    }
    if (sub === "regenerate") { const r = await engine.regenerate(db, row, ctx, deps, { sceneId: body.sceneId, userId: "u1" }); return r.ok ? json(route, await payload()) : failed(route, r); }
    if (sub === "renders" && !rid) {
      const r = await engine.startRender(db, row, { kind: body.kind, userId: "u1" }, deps); if (!r.ok) return failed(route, r);
      const adv = r.render.status === "queued" ? await engine.stepRender(db, r.render.id, deps, body.kind === "pptx" ? 50_000 : 4_000) : r;
      return json(route, { render: adv.ok ? adv.render : r.render }, 201);
    }
    if (sub === "renders" && action === "step") { const r = await engine.stepRender(db, rid, deps, 8_000); return r.ok ? json(route, r) : failed(route, r); }
    if (sub === "renders" && action === "cancel") { const r = await engine.cancelRender(db, surveyId, rid); return r.ok ? json(route, r) : failed(route, r); }
    return json(route, { error: `fake backend: unhandled ${m} ${url.pathname}` }, 404);
  } catch (e) { console.error("FAKE API ERROR", m, url.pathname, e); return json(route, { error: e.message }, 500); }
}
/* the rest of the analytics workspace: enough for the page to open on the Reports tab */
async function analyticsApi(route) {
  const url = new URL(route.request().url());
  const head = url.pathname.split("/analytics")[1]?.split("/").filter(Boolean)[0];
  if (head === "variables") return json(route, { variables: [], counts: { LIVE: 400, TEST: 0 }, surveyVersion: "1.0", revision: 3 });
  if (head === "home") return json(route, { analyses: [], charts: [], reports: [], shares: [] });
  if (head === "report-templates") return json(route, { templates: [], available: true });
  if (head === "plan") return json(route, { error: "not in this test" }, 404);
  return json(route, { items: [] });
}

const browser = await chromium.launch();
const ctxB = await browser.newContext({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
await ctxB.addCookies([{ name: "rescript_session", value: "fake", url: STUDIO }]);
const page = await ctxB.newPage();
const pageErrors = [];
page.on("pageerror", (e) => { pageErrors.push(e.message); console.error("PAGE ERROR:", e.message); });
page.on("dialog", (d) => d.accept());
const user = { userId: "u1", userCode: "U-0001", name: "Ana Lyst", email: "ana@example.com", platformRole: "user", isPlatformAdmin: false, sessionId: "s1", unread: 0, policies: { heartbeatSeconds: 600 } };
await page.route("**/api/auth/me", (r) => json(r, user));
await page.route("**/api/auth/heartbeat**", (r) => json(r, { ok: true }));
await page.route("**/api/notifications**", (r) => json(r, { items: [], unread: 0 }));
await page.route("**/api/surveys", (r) => json(r, { surveys: [{ id: SURVEY, code: "SYN", title: "Synthetic Study 2026", status: "live", myRole: "owner", roleSource: "owner", updated_at: now(), version: "1.0" }] }));
await page.route("**/api/surveys/*/stories**", storiesApi);
await page.route("**/api/surveys/*/analytics**", analyticsApi);
const downloads = [];
await page.route("https://store.test/**", (r) => { downloads.push(r.request().url()); return r.fulfill({ status: 200, contentType: "application/octet-stream", body: "ok" }); });

const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, " ").trim());
const count = (sel) => page.$$eval(sel, (es) => es.length);
const shot = async (name) => { if (process.env.ST_SHOTS) await page.screenshot({ path: `${process.env.ST_SHOTS}/${name}.png`, fullPage: true }); };
const waitText = async (sel, re, timeout = 60000) => { await page.waitForFunction(([s, src]) => { const n = document.querySelector(s); return n && new RegExp(src).test(n.textContent); }, [sel, re.source], { timeout }); return text(sel); };
const story = () => db.tables.analytics_story_reports[0];
const shares = [];
const shareApi = async (route) => {
  const req = route.request(); const url = new URL(req.url());
  if (req.method() === "POST") {
    const body = JSON.parse(req.postData() || "{}");
    const token = `tok${uid32()}`;
    const row = { id: uuid(), report_id: body.reportId, token, access: body.access, permission: body.permission, report_version: null, allowed_emails: body.emails ?? [], password: body.password ?? null };
    shares.push(row);
    return json(route, { item: { ...row, password_hash: undefined } }, 201);
  }
  return json(route, { items: [] });
};
function uid32() { return Array.from({ length: 28 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join(""); }
/* /api/share/<token> as the real route answers it for a story: the frozen document, nothing live */
async function shareRoute(route) {
  const req = route.request(); const token = new URL(req.url()).pathname.split("/").pop();
  const s = shares.find((x) => x.token === token);
  if (!s) return json(route, { error: "This link is not valid.", status: "not_found" }, 404);
  const r = db.tables.analytics_reports.find((x) => x.id === s.report_id);
  const v = db.tables.analytics_report_versions.filter((x) => x.report_id === r.id).find((x) => x.version === (s.report_version ?? r.published_version));
  if (req.method() === "POST") { shareDownloads.push(JSON.parse(req.postData() || "{}")); return route.fulfill({ status: 200, contentType: "application/octet-stream", body: "pptx" }); }
  return json(route, { report: { name: r.name, title: v.definition.title, subtitle: v.definition.subtitle, storyDoc: v.definition.storyDoc, blocks: [], viewerSegments: [], branding: {} }, theme: null, results: {}, version: v.version, publishedAt: v.published_at ?? now(), mode: "snapshot", dataset: v.dataset, permission: s.permission });
}
const shareDownloads = [];
await page.route("**/api/surveys/*/analytics/shares", shareApi);
await page.route("**/api/share/**", shareRoute);

console.log("\n§1 SHARE TAB — an unpublished story, then the checks");
await page.goto(`${STUDIO}/analytics?survey=${SURVEY}&tab=reports`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="st-reports"]', { timeout: 60000 });
await page.click('[data-testid="st-create-open"]');
await page.click('[data-testid="st-output-pptx"]').catch(() => {});
await page.click('button[data-testid="st-create"]');
await page.waitForSelector('[data-testid="st-studio"]', { timeout: 60000 });
await page.waitForSelector('[data-testid="st-thumb"] svg', { timeout: 60000 });
await page.click('[data-testid="st-tab-share"]');
await page.waitForSelector('[data-testid="st-share"]');
assert.equal(await count('[data-testid="st-share-create"]'), 0, "no link can be made before a version is published");
assert.equal(await count('[data-testid="st-published"]'), 0);
ok("before publishing there is no link to make — the tab offers Publish, Preview and Download only");

/* a scene that cannot be drawn blocks the publish and is named */
const original = structuredClone(db.tables.analytics_story_reports[0].definition);
const brokenScene = db.tables.analytics_story_reports[0].definition.scenes.find((s) => s.kind === "finding" && s.visual.type === "chart");
brokenScene.visual.data.series = [];
await page.click('[data-testid="st-publish"]');
await page.waitForSelector('[data-testid="st-share-error"]');
assert.ok((await count('[data-testid="st-share-problems"] li')) >= 1);
assert.equal(db.tables.analytics_report_versions.length, 0, "nothing was published");
ok(`a story with an undrawable scene is not published; the answer lists what to fix (“${(await text('[data-testid="st-share-problems"] li')).slice(0, 80)}…”)`);
db.tables.analytics_story_reports[0].definition = original;

console.log("\n§2 PUBLISH, THEN A LINK");
await page.click('[data-testid="st-tab-scene"]'); await page.click('[data-testid="st-tab-share"]');
await page.click('[data-testid="st-publish"]');
await page.waitForSelector('[data-testid="st-published"]');
assert.match(await text('[data-testid="st-published"]'), /Published: story version 1 as share version 1/);
assert.equal(db.tables.analytics_report_versions.length, 1);
ok("Publish freezes version 1; the tab says which story version is behind the links");
await page.selectOption('[data-testid="st-share-access"]', "users");
assert.equal(await page.$eval('[data-testid="st-share-create"]', (e) => e.disabled), true, "people-only needs at least one address");
await page.fill('[data-testid="st-share-emails"]', "client@example.com");
await page.selectOption('[data-testid="st-share-access"]', "link");
await page.click('[data-testid="st-share-create"]');
await page.waitForSelector('[data-testid="st-share-link"]');
const link = await page.$eval('[data-testid="st-share-link"]', (e) => e.value);
assert.match(link, /\/share\/tok[a-z0-9]{20,}$/);
assert.ok(!/undefined/.test(link));
ok(`a link to the published version is created and shown: …${link.slice(-14)}`);

console.log("\n§3 THE STAKEHOLDER'S PAGE — an anonymous browser");
const anon = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await anon.route("**/api/share/**", shareRoute);
const pub = await anon.newPage();
const pubErrors = []; pub.on("pageerror", (e) => pubErrors.push(e.message));
const requests = []; pub.on("request", (r) => { if (r.frame() !== pub.mainFrame() && !r.url().startsWith("data:") && !r.url().startsWith("blob:") && !r.url().startsWith("about:")) requests.push(r.url()); });
await pub.goto(link, { waitUntil: "networkidle" });
await pub.waitForSelector('[data-testid="ax-share-story-page"]');
const frame = pub.frameLocator('[data-testid="ax-share-story-page"]');
await frame.locator("main .scene").first().waitFor();
const nScenes = await frame.locator("main .scene").count();
const doc = db.tables.analytics_report_versions[0].definition.storyDoc;
assert.equal(nScenes, doc.scenes.length);
ok(`one link opens the whole story as an interactive page: ${nScenes} scenes, in a sandboxed frame`);
assert.equal(await pub.$eval('[data-testid="ax-share-story-page"]', (e) => e.getAttribute("sandbox")), "allow-scripts allow-modals");
assert.equal(await pub.locator('[data-testid="ax-share-ppt"]').count(), 0, "no PowerPoint button without the download permission");
ok("the frame is sandboxed to scripts and print only; no download button when the link does not allow it");

/* keyboard navigation */
await frame.locator("#count").click(); /* a click puts the keyboard in the frame, as it would for a person */
await pub.keyboard.press("Home");
const first = await frame.locator("#count").textContent();
await pub.keyboard.press("ArrowRight");
const second = await frame.locator("#count").textContent();
assert.notEqual(first, second);
await frame.locator("#next").click();
assert.notEqual(await frame.locator("#count").textContent(), second);
ok(`the arrow keys and the Next button move through the story (${first?.trim()} → ${second?.trim()})`);

/* "How was this calculated?" on a finding with evidence */
const frames = pub.frames().find((f) => f !== pub.mainFrame());
await pub.keyboard.press("Home");
let guard = 0;
while (guard++ < 40) {
  const how = frame.locator(".scene.active details.how");
  if (await how.count()) break;
  await frame.locator("#next").click();
}
const how = frame.locator(".scene.active details.how");
assert.ok(await how.count(), "a scene offers how it was calculated");
await how.locator("summary").click();
const dl = (await how.locator("dl").textContent()).replace(/\s+/g, " ");
assert.ok(dl.length > 30, dl);
ok(`“How was this calculated?” opens on a scene and names its source and base: “${dl.slice(0, 90)}…”`);


/* chart or table */
const tableBtn = frame.locator(".scene.active [data-toggle-view]");
if (await tableBtn.count()) { await tableBtn.click(); assert.ok(await frame.locator(".scene.active .view-table table").count() >= 1); ok("a chart can be read as a table of the same figures"); }

/* reduced motion: nothing animates */
const rm = await anon.newPage();
await rm.emulateMedia({ reducedMotion: "reduce" });
await rm.goto(link, { waitUntil: "networkidle" });
const rf = rm.frameLocator('[data-testid="ax-share-story-page"]');
await rf.locator("main .scene").first().waitFor();
const names = await rf.locator("main .scene.active, main .scene.active svg rect, main .scene.active svg path").evaluateAll((els) => els.map((e) => getComputedStyle(e).animationName));
assert.ok(names.length > 0 && names.every((n) => n === "none"), `animations under reduced motion: ${[...new Set(names)]}`);
ok("with reduced motion on, no scene or chart animates");

/* viewers cannot read access emails, and the page reaches nothing else */
const payloadSeen = await pub.evaluate(async (u) => (await fetch(u)).text(), link.replace("/share/", "/api/share/"));
assert.ok(!payloadSeen.includes("client@example.com") && !/allowed_emails|password/.test(payloadSeen), "the share payload carries no access list or password");
assert.deepEqual(requests, [], `the story page itself asked for nothing: ${requests}`);
ok("the payload a viewer receives carries no e-mail list or password, and the story page makes no request of its own (fonts and everything else are inside it)");
assert.deepEqual(pubErrors, []);

console.log("\n§4 A LINK THAT ALLOWS DOWNLOAD");
await page.check('[data-testid="st-share"] input[type="checkbox"]');
await page.click('[data-testid="st-share-create"]');
await page.waitForTimeout(300);
const dlink = await page.$eval('[data-testid="st-share-link"]', (e) => e.value);
const pub2 = await anon.newPage();
await pub2.goto(dlink, { waitUntil: "networkidle" });
if (await pub2.locator('[data-testid="ax-share-ppt"]').count()) {
  await pub2.click('[data-testid="ax-share-ppt"]');
  await pub2.waitForTimeout(500);
  assert.equal(shareDownloads.at(-1)?.format, "pptx");
  ok("a link that allows it offers the PowerPoint, built from the same story document");
}

console.log("\n§5 OFFLINE PAGE");
const html = await page.evaluate(async (u) => (await fetch(u)).text(), `${STUDIO}/api/surveys/${SURVEY}/stories/${story().id}/page?inline=1`);
assert.ok(html.startsWith("<!doctype html>") && html.includes("How was this calculated?"));
assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html.replace(/<script[\s\S]*?<\/script>/g, "")), "no external reference");
ok(`the offline page is one self-contained file (${Math.round(html.length / 1024)} KB), nothing loaded from outside`);

assert.deepEqual(pageErrors, []);
ok("no page errors");
await anon.close();
await browser.close();
console.log(`\n${passed} checks passed`);
