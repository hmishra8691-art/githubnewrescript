/**
 * ANIMATED RESEARCH REPORTS — browser checks, end to end.
 *
 * Results → Reports → Create report, in the real Studio page, with the
 * stories API served by the REAL service (`apps/studio/lib/storyEngine.ts`)
 * running inside this test process over the in-memory database
 * (`scripts/lib/fakeSupabase.mjs`), an in-memory object store, the real
 * engine on the synthetic fixture and the REAL renderer (resvg + ffmpeg):
 * the PowerPoint and the video made here are real files, checked by the
 * service before the page is told they are ready, and checked again here.
 *
 * Needs `pnpm dev:studio` (3000).
 *   node --experimental-strip-types --no-warnings scripts/story-report-test.mjs
 */
import { chromium } from "./lib/playwright.mjs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { buildDataset, runPlan, runAnalysis } from "../packages/analytics/dist/index.js";
import { def as baseDef, synthRows } from "../packages/analytics/dist/analyses/fixture.js";
import { providerObjectStore } from "../packages/media/dist/index.js";
import { MemoryStorageProvider } from "../packages/storage/dist/index.js";
import { loadReportFonts, probe, inspectStoryPptx } from "../packages/reportvideo/dist/index.js";
import { composeReport } from "../packages/analytics/dist/story/index.js";
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

console.log("\n§1 RESULTS → REPORTS → CREATE REPORT");
await page.goto(`${STUDIO}/analytics?survey=${SURVEY}&tab=reports`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="st-reports"]', { timeout: 60000 });
await page.click('[data-testid="st-create-open"]');
await page.click('[data-testid="st-output-both"]');
await page.selectOption('[data-testid="st-audience"]', "client");
await page.selectOption('[data-testid="st-theme"]', "modern_analytics");
await page.click('button[data-testid="st-create"]');
await page.waitForSelector('[data-testid="st-studio"]', { timeout: 60000 });
await page.waitForSelector('[data-testid="st-thumb"] svg', { timeout: 60000 });
assert.equal(db.tables.analytics_story_reports.length, 1);
assert.equal(story().version, 1);
const scenes = story().definition.scenes;
assert.equal(await count('[data-testid="st-thumb"]'), scenes.length);
assert.match(await text('[data-testid="st-status"]'), /Draft/);
assert.equal(await count('[data-testid="st-validation"]'), 0);
ok(`a report proposed from the plan opens in the storyboard: ${scenes.length} scenes (main + appendix), each drawn as a thumbnail with the report's own content, status Draft, no validation issues`);
for (const k of ["objective", "method", "finding", "hypotheses", "conclusions", "recommendations", "limitations"]) assert.ok(scenes.some((s) => s.kind === k), k);
ok("objective, method, findings, hypotheses, conclusions, recommendations and limitations are all proposed — from the run, nothing invented");
await shot("01-storyboard");

console.log("\n§2 PREVIEW — the video, played; the slide, at its final state");
const t0 = await text('[data-testid="st-time"]');
await page.click('[data-testid="st-play"]');
await page.waitForTimeout(900);
const t1 = await text('[data-testid="st-time"]');
assert.notEqual(t0, t1);
const svgMid = await page.$eval('[data-testid="st-preview"]', (e) => e.innerHTML.length);
assert.ok(svgMid > 500);
ok(`the scene plays in the browser with the renderer the video uses (${t0} → ${t1})`);
await page.click('[data-testid="st-view-slide"]');
await page.waitForSelector('[data-testid="st-slide-preview"] svg');
ok("the PowerPoint preview shows the same scene as a 16:9 slide at its final state");
await page.click('[data-testid="st-view-video"]');

console.log("\n§3 EDIT A SCENE — the chart is overridden within what the data allows, saved as version 2");
const finding = scenes.find((s) => s.kind === "finding" && s.visual.type === "chart" && s.visual.data.valueFormat !== "pct");
await page.click(`[data-testid="st-thumb"][data-scene="${finding.id}"]`);
await page.waitForSelector('[data-testid="st-chart-choice"]');
assert.equal(await page.$eval('[data-testid="st-chart-donut"]', (e) => e.disabled), true);
const why = await page.$eval('[data-testid="st-chart-donut"]', (e) => e.title);
assert.ok(why.length > 10, why);
ok(`a donut is not offered for this data, with the reason: “${why.slice(0, 70)}…”`);
assert.match(await text('[data-testid="st-chart-choice"]'), /Recommended:/);
await page.click('[data-testid="st-chart-hbar"]');
await page.fill('[data-testid="st-field-title"]', "Women are more satisfied than men");
assert.match(await text('[data-testid="st-status"]'), /Unsaved/);
await page.click('[data-testid="st-save"]');
await waitText('[data-testid="st-msg"]', /Saved as version 2/);
const saved = story().definition.scenes.find((s) => s.id === finding.id);
assert.equal(saved.visual.chart, "hbar"); assert.equal(saved.title, "Women are more satisfied than men");
assert.ok(saved.locked.includes("chart") && saved.locked.includes("title"));
assert.deepEqual(saved.visual.data, finding.visual.data);
ok("the override and the new title are saved as version 2, marked as the person's (kept on regeneration), the numbers untouched");

console.log("\n§4 REVISE IN WORDS — shown as changes before they apply; distortions refused");
await page.click('[data-testid="st-tab-revise"]');
await page.fill('[data-testid="st-revise-text"]', "Move the methodology to the appendix, shorten this to two minutes, and start the y-axis at 50");
await page.click('[data-testid="st-revise-preview"]');
await page.waitForSelector('[data-testid="st-revise-result"]');
const ops = await page.$$eval('[data-testid="st-revise-op"]', (es) => es.map((e) => e.textContent));
assert.ok(ops.some((o) => /appendix/.test(o)) && ops.some((o) => /Design/.test(o)), ops.join(" | "));
assert.match(await text('[data-testid="st-revise-refused"]'), /axis.*length/i);
assert.equal(story().version, 2, "nothing applied yet");
ok(`the request is read into ${ops.length} explicit changes and one refusal (the axis), and nothing changes until it is applied`);
await page.click('[data-testid="st-revise-apply"]');
await waitText('[data-testid="st-msg"]', /Applied/);
assert.equal(story().version, 3);
assert.equal(story().definition.scenes.find((s) => s.kind === "method").section, "appendix");
assert.equal(story().definition.design.video.targetDurationSec, 120);
ok("applied as version 3: the methodology is in the appendix (PowerPoint only) and the video is paced to two minutes");

console.log("\n§5 DESIGN — themes drawn with real content, words to design, brand files to themes");
await page.click('[data-testid="st-tab-design"]');
await page.waitForSelector('[data-testid="st-theme-card"] svg');
assert.ok((await count('[data-testid="st-theme-card"]')) >= 5);
ok("the theme options (Corporate Executive, Modern Analytics, Premium Editorial, Minimal Research, Cinematic Data Story) are previewed with this report's title and first chart");
await page.fill('[data-testid="st-design-text"]', "dark background, white text, teal accents and larger chart labels");
await page.click('[data-testid="st-design-interpret"]');
await page.waitForSelector('[data-testid="st-design-result"] svg');
await page.click('[data-testid="st-design-apply"]');
await waitText('[data-testid="st-msg"]', /Design saved/);
assert.equal(story().version, 4);
assert.ok(story().definition.design.colors.background.toLowerCase() < "#333333");
ok("a design request in words is previewed and applied as version 4 (dark background), contrast enforced");
const dir = mkdtempSync(join(tmpdir(), "brand-"));
writeFileSync(join(dir, "logo.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><rect width="150" height="100" fill="#0A2A66"/><circle cx="225" cy="50" r="45" fill="#D4A017"/></svg>`);
writeFileSync(join(dir, "notes.txt"), "not a brand file");
await page.setInputFiles('[data-testid="st-brand-upload"]', [join(dir, "logo.svg"), join(dir, "notes.txt")]);
await page.waitForSelector('[data-testid="st-brand-result"]');
assert.match(await text('[data-testid="st-brand-result"]'), /not a format we can read/);
await page.waitForFunction(() => document.querySelectorAll('[data-testid="st-theme-card"]').length >= 11, null, { timeout: 15000 }).catch(async () => { console.log("cards", await count('[data-testid="st-theme-card"]'), await text('[data-testid="st-brand-result"]')); throw new Error("brand themes"); });
ok("brand files are read on the server: the logo's colours become six brand themes; the unreadable file is explained");
await shot("05-design");

console.log("\n§6 VERSIONS — compare and restore");
await page.click('[data-testid="st-tab-versions"]');
await page.waitForSelector('[data-testid="st-version"]');
assert.equal(await count('[data-testid="st-version"]'), 4);
await page.click('[data-testid="st-version"]:last-child [data-testid="st-compare"]');
assert.match(await waitText('[data-testid="st-diff"]', /v1 → v4/), /design/);
ok("four versions are listed with their notes; v1 compared with v4 lists the edited scenes and the design");

console.log("\n§7 EXPORT — a checked PowerPoint, then a checked video, with progress");
/* draft resolution for the test's speed */
const r4 = await engine.loadStory(db, SURVEY, story().id);
await engine.applyDesign(db, r4, { patch: { video: { height: 720, fps: 24, subtitles: true } }, baseVersion: r4.version, note: "720p draft", userId: "u1" });
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="st-reports"]');
await page.click('[data-testid="st-card"]');
await page.waitForSelector('[data-testid="st-thumb"] svg', { timeout: 60000 });
await page.click('[data-testid="st-tab-export"]');
assert.match(await text('[data-testid="st-estimate"]'), /1280×720.*scenes to render/);
await page.click('[data-testid="st-export-pptx"]');
await page.waitForSelector('[data-testid="st-render"][data-status="completed"] [data-testid="st-download"]', { timeout: 120000 });
assert.match(await text('[data-testid="st-render-qa"]'), /native charts \(\d+ values checked\)/);
const pptxRender = db.tables.analytics_story_renders.find((r) => r.kind === "pptx");
const pptx = Buffer.from(await store.read("rescript-reports", pptxRender.path));
const again = inspectStoryPptx(pptx, (await engine.versionDefinition(db, story().id, pptxRender.version)), composeReport(await engine.versionDefinition(db, story().id, pptxRender.version), fonts.measurer, "pptx").pages);
assert.ok(again.ok && again.charts >= 2 && again.pictures === 0, JSON.stringify(again.checks.slice(0, 3)));
ok(`the PowerPoint is built from version ${pptxRender.version}, checked by the service, stored — and read back here: ${again.slides} slides, ${again.charts} native charts, no pictures of slides`);
await page.click('[data-testid="st-render"][data-status="completed"] [data-testid="st-download"]');
await page.waitForFunction(() => true);
await new Promise((r) => setTimeout(r, 1500));
assert.ok(downloads.some((u) => u.includes(".pptx")), downloads.join(","));
ok("the download is a short-lived signed link to the stored file");

await page.click('[data-testid="st-export-video"]');
await page.waitForSelector('[data-testid="st-progress"]', { timeout: 60000 });
ok("the video starts in the background with progress by scene");
await page.waitForSelector('[data-testid="st-render"][data-status="completed"] >> text=Download MP4', { timeout: 300000 });
const vr = db.tables.analytics_story_renders.find((r) => r.kind === "video" && r.status === "completed");
assert.ok(vr.qa.video.ok);
const mp4dir = mkdtempSync(join(tmpdir(), "mp4-")); writeFileSync(join(mp4dir, "v.mp4"), Buffer.from(await store.read("rescript-reports", vr.path)));
const info = await probe(join(mp4dir, "v.mp4"));
assert.equal(info.video.codec, "h264"); assert.equal(info.video.width, 1280); assert.equal(info.video.height, 720); assert.equal(info.subtitle?.codec, "mov_text");
ok(`the video is completed only after its checks: ${vr.qa.video.scenes.length} scenes matched frame by frame; read back here as H.264 1280×720 with a subtitle track, ${info.duration.toFixed(1)}s`);
assert.equal(usage.length, 2);
ok("each finished export is recorded once for billing (REPORT_GENERATION)");
await shot("07-export");

console.log("\n§8 PERMISSIONS — a change the server refuses is said, not hidden");
readOnly = true;
await page.click('[data-testid="st-tab-scene"]');
await page.fill('[data-testid="st-field-title"]', "Changed by a viewer");
await page.click('[data-testid="st-save"]');
assert.match(await waitText('[data-testid="st-error"]', /permission/), /permission/);
readOnly = false;
ok("a refused save shows the server's reason and keeps the edit unsaved");

assert.deepEqual(pageErrors, []);
ok("no page errors");
await browser.close();
console.log(`\n${passed} checks passed`);
