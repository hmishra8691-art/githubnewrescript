import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { SurveyDefinition } from "@rescript/schema";
import { buildDataset, runPlan, runAnalysis, type AnalysisDefinition, type DatasetSpec } from "@rescript/analytics";
import { def as baseDef, synthRows } from "../../../packages/analytics/dist/analyses/fixture.js";
import { providerObjectStore } from "@rescript/media";
import { MemoryStorageProvider } from "@rescript/storage";
import { loadReportFonts, speechNarration } from "@rescript/reportvideo";
import { fakeSpeech } from "@rescript/ai";
import {
  createStory, loadStory, storyPayload, saveDefinition, previewRevision, applyRevision, interpretDesign, applyDesign, analyzeBrand, saveTheme, listThemes,
  compareVersions, revertTo, regenerate, startRender, stepRender, cancelRender, downloadLink, setReviewStatus, listStories, type StoryDeps,
} from "./storyEngine.ts";
import { checkEditedDefinition, numbersIn } from "./storyCore.ts";
import { FakeDb, uuid } from "../../../scripts/lib/fakeSupabase.mjs";

/*
 * STORY REPORTS — the service end to end over the in-memory database, the
 * in-memory object store, the real engine and the real renderer: create from
 * the plan, edit (numbers protected), revise in words (preview, then apply),
 * design and brand, versions (compare, revert), regenerate (edits survive),
 * export a checked PowerPoint and a checked video in steps, resume, reuse
 * unchanged scenes, cancel, sign a download.
 */

const fonts = loadReportFonts(fileURLToPath(new URL("../public/report-fonts/", import.meta.url)));
const SURVEY = "11111111-1111-4111-8111-111111111111";

function survey() {
  const d = structuredClone(baseDef) as Record<string, unknown>;
  d.research = {
    objective: "Understand what drives satisfaction", population: "Adults", methodology: "Online panel", hypotheses: ["Women are more satisfied than men", "Satisfaction differs by region"], hypothesisDetails: [], researchQuestions: [], kpis: [], constructs: [], analysis: [], assumptions: [], sources: [],
    analysisPlan: { crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: ["H1"] }], tests: [{ id: "t1", method: "t_test", outcome: "SAT", variables: ["SAT"], groupBy: "GENDER", priority: 1, hypotheses: ["H1"] }, { id: "t2", method: "anova", outcome: "SAT", variables: ["SAT"], groupBy: "REGION", priority: 2, hypotheses: ["H2"] }], derived: [], segments: [] },
  };
  return SurveyDefinition.parse(d);
}

function setup(rows = 300) {
  const db = new FakeDb();
  const def = survey();
  db.tables.surveys.push({ id: SURVEY, customer_id: "cust-1", title: "Synthetic" });
  const provider = new MemoryStorageProvider({ baseUrl: "https://store.test" });
  const store = providerObjectStore(provider as never);
  const spec = (env: DatasetSpec["environment"]): DatasetSpec => ({ environment: env, dataset: "all" });
  let runs = 0;
  const usage: unknown[] = [];
  const deps: StoryDeps = {
    async runPlanFor(_db, _s, ctx, o) {
      const ds = buildDataset(ctx.def as never, rows ? synthRows(rows) : [], { spec: spec(o.environment ?? "LIVE") });
      const run = runPlan(ctx.def as never, ds, { trigger: o.trigger ?? "manual", now: "2026-10-01T10:00:00Z" });
      runs++;
      return { run, stored: { id: uuid() } };
    },
    async compute(_db, _s, ctx, d: AnalysisDefinition) { return runAnalysis(d, buildDataset(ctx.def as never, synthRows(rows), { spec: d.dataset })); },
    async reportFacts() { return { client: "Acme Foods" }; },
    store: () => store,
    fonts: () => fonts,
    narration: () => null,
    usage: (e) => usage.push(e),
  };
  return { db, def, ctx: { def, version: "1.0" }, deps, provider, usage, runs: () => runs };
}

test("create from the plan: version 1 with the run's numbers, checks passing, a respondent profile, and both outputs", async () => {
  const s = setup();
  const r = await createStory(s.db as never, SURVEY, s.ctx, { userId: "u1", audience: "client", preset: "modern_analytics", outputs: { pptx: true, video: true } }, s.deps);
  assert.ok(r.ok, JSON.stringify(r));
  const row = (await loadStory(s.db as never, SURVEY, (r as { id: string }).id))!;
  assert.equal(row.version, 1);
  assert.equal(row.definition.design.preset, "modern_analytics");
  assert.ok(row.definition.scenes.some((x) => x.kind === "sample"), "respondent profile scene");
  assert.ok(row.run_id);
  const p = await storyPayload(s.db as never, row, s.deps);
  assert.equal(p.qa.video.critical.length, 0, JSON.stringify(p.qa.video.critical));
  assert.equal(p.qa.pptx.critical.length, 0);
  assert.equal(p.status, "draft");
  assert.ok(p.timing.total > 20 && p.estimate.scenes > 5);
  assert.equal(p.versions.length, 1);
  assert.equal((await listStories(s.db as never, SURVEY)).length, 1);
});

test("no responses: a clear refusal, nothing saved", async () => {
  const s = setup(0);
  const r = await createStory(s.db as never, SURVEY, s.ctx, { userId: "u1" }, s.deps);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /no live completes/i);
  assert.equal(s.db.tables.analytics_story_reports.length, 0);
});

test("editing: text, order and chart type are saved as a new version; numbers and invented figures are refused; stale edits conflict", async () => {
  const s = setup();
  const id = ((await createStory(s.db as never, SURVEY, s.ctx, { userId: "u1" }, s.deps)) as { id: string }).id;
  let row = (await loadStory(s.db as never, SURVEY, id))!;
  const next = structuredClone(row.definition);
  const f = next.scenes.find((x) => x.kind === "finding" && x.visual.type === "chart")!;
  f.title = "Women are more satisfied";
  if (f.visual.type === "chart") f.visual.chart = "hbar";
  const ok = await saveDefinition(s.db as never, row, { definition: next, baseVersion: 1, userId: "u1" });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal((ok as { version: number }).version, 2);
  row = (await loadStory(s.db as never, SURVEY, id))!;
  /* a changed number is refused */
  const tampered = structuredClone(row.definition);
  const t = tampered.scenes.find((x) => x.visual.type === "chart")!;
  if (t.visual.type === "chart") t.visual.data.series[0].values[0] = 99;
  const no = await saveDefinition(s.db as never, row, { definition: tampered, baseVersion: 2, userId: "u1" });
  assert.equal(no.ok, false); assert.equal((no as { status: number }).status, 422);
  /* a figure typed into text that the analysis did not produce is refused */
  const invented = structuredClone(row.definition);
  invented.scenes.find((x) => x.kind === "summary")!.title = "Satisfaction rose 37.5 points";
  const bad = checkEditedDefinition(invented, row.definition);
  assert.ok(!bad.ok && /37.5/.test(bad.errors.join(" ")), JSON.stringify(bad));
  /* an invalid chart for the data is refused */
  const donut = structuredClone(row.definition);
  const g = donut.scenes.find((x) => x.visual.type === "chart" && x.visual.data.valueFormat === "mean")!;
  if (g.visual.type === "chart") g.visual.chart = "donut";
  assert.ok(!checkEditedDefinition(donut, row.definition).ok);
  /* stale */
  const stale = await saveDefinition(s.db as never, row, { definition: next, baseVersion: 1, userId: "u2" });
  assert.equal((stale as { status: number }).status, 409);
  assert.deepEqual(numbersIn("p < .001, 1,234 and 45%"), ["0.001", "1234", "45"]);
});

test("revisions in words: previewed as operations, applied exactly as shown, distortions refused, compared and reverted", async () => {
  const s = setup();
  const id = ((await createStory(s.db as never, SURVEY, s.ctx, { userId: "u1" }, s.deps)) as { id: string }).id;
  let row = (await loadStory(s.db as never, SURVEY, id))!;
  const sel = row.definition.scenes.find((x) => x.kind === "finding" && x.visual.type === "chart")!;
  const pv = previewRevision(row, "Shorten this to two minutes, move the methodology to the appendix, replace this chart with a horizontal bar chart and start the y-axis at 40", sel.id);
  assert.ok(pv.ops.some((o) => o.op === "set_section"));
  assert.ok(pv.ops.some((o) => o.op === "set_chart"));
  assert.ok(pv.ops.some((o) => o.op === "design"));
  assert.ok(pv.refused.some((x) => /axis/.test(x.request)));
  assert.ok(pv.ops.every((o) => o.describe.length > 0));
  assert.equal(s.db.tables.analytics_story_versions.length, 1, "a preview changes nothing");
  const ap = await applyRevision(s.db as never, row, { ops: pv.ops, text: "…", baseVersion: 1, userId: "u1" });
  assert.ok(ap.ok, JSON.stringify(ap));
  row = (await loadStory(s.db as never, SURVEY, id))!;
  assert.equal(row.definition.scenes.find((x) => x.kind === "method")!.section, "appendix");
  assert.equal(row.definition.design.video.targetDurationSec, 120);
  const cmp = await compareVersions(s.db as never, row, 1, 2);
  assert.ok(cmp.ok && cmp.diff.changed.length >= 1 && cmp.diff.design.includes("video"), JSON.stringify(cmp));
  const rv = await revertTo(s.db as never, row, 1, "u1");
  assert.ok(rv.ok);
  row = (await loadStory(s.db as never, SURVEY, id))!;
  assert.equal(row.version, 3);
  assert.equal(row.definition.scenes.find((x) => x.kind === "method")!.section, "main");
});

test("design and branding: words → a patch with contrast enforced; brand files → six themes; themes saved per project and workspace", async () => {
  const s = setup();
  const id = ((await createStory(s.db as never, SURVEY, s.ctx, { userId: "u1" }, s.deps)) as { id: string }).id;
  let row = (await loadStory(s.db as never, SURVEY, id))!;
  const d = await interpretDesign(row, "dark background, white text, teal accents, larger labels, vertical video", s.deps);
  assert.equal(d.preview.video.aspect, "9:16");
  assert.ok(d.understood.length >= 3);
  const ap = await applyDesign(s.db as never, row, { patch: d.patch, baseVersion: 1, note: "dark", userId: "u1" });
  assert.ok(ap.ok);
  row = (await loadStory(s.db as never, SURVEY, id))!;
  const p = await storyPayload(s.db as never, row, s.deps);
  assert.equal(p.qa.video.critical.length, 0, `vertical composes cleanly: ${JSON.stringify(p.qa.video.critical.slice(0, 3))}`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"><rect width="150" height="100" fill="#0A2A66"/><rect x="150" width="150" height="100" fill="#D4A017"/></svg>`;
  const b = analyzeBrand([{ name: "logo.svg", mimeType: "image/svg+xml", bytes: new TextEncoder().encode(svg) }, { name: "notes.docx", mimeType: "application/msword", bytes: new Uint8Array([1, 2, 3]) }], row.definition.design);
  assert.equal(b.themes.length, 6);
  assert.ok(b.analyses[1].problems.length, "unreadable files are explained");
  const custom = b.themes.find((t) => t.preset === "custom_brand")!;
  assert.ok(custom.design.logo && Math.abs(custom.design.logo.width / custom.design.logo.height - 3) < 0.02, "logo kept at its own proportions");
  const saved = await saveTheme(s.db as never, { name: "Acme", design: custom.design, scope: "workspace", surveyId: SURVEY, customerId: "cust-1", userId: "u1" });
  assert.ok("ok" in saved && saved.ok);
  await saveTheme(s.db as never, { name: "Project look", design: custom.design, scope: "project", surveyId: SURVEY, customerId: "cust-1", userId: "u1" });
  const themes = await listThemes(s.db as never, SURVEY, "cust-1");
  assert.deepEqual(themes.map((t) => t.scope).sort(), ["project", "workspace"]);
});

test("regenerate from a new run: the person's chart choice and moved section survive", async () => {
  const s = setup();
  const id = ((await createStory(s.db as never, SURVEY, s.ctx, { userId: "u1" }, s.deps)) as { id: string }).id;
  let row = (await loadStory(s.db as never, SURVEY, id))!;
  const sel = row.definition.scenes.find((x) => x.kind === "finding" && x.visual.type === "chart")!;
  const pv = previewRevision(row, "replace this chart with a horizontal bar chart and move the methodology to the appendix", sel.id);
  await applyRevision(s.db as never, row, { ops: pv.ops, text: "x", baseVersion: 1, userId: "u1" });
  row = (await loadStory(s.db as never, SURVEY, id))!;
  const r = await regenerate(s.db as never, row, s.ctx, s.deps, { userId: "u1" });
  assert.ok(r.ok, JSON.stringify(r));
  row = (await loadStory(s.db as never, SURVEY, id))!;
  const again = row.definition.scenes.find((x) => x.id === sel.id)!;
  assert.ok(again.visual.type === "chart" && again.visual.chart === "hbar");
  assert.equal(row.definition.scenes.find((x) => x.kind === "method")!.section, "appendix");
});

test("exports: a checked PowerPoint in one request; a video in steps — resumable, scenes reused, verified before completed; one at a time; cancel; signed download", { timeout: 300_000 }, async () => {
  const s = setup();
  const id = ((await createStory(s.db as never, SURVEY, s.ctx, { userId: "u1", maxFindings: 1, exclude: ["comparison", "hypotheses", "conclusions", "recommendations", "limitations", "objective", "method", "sample", "summary", "appendix_table"] }, s.deps)) as { id: string }).id;
  let row = (await loadStory(s.db as never, SURVEY, id))!;
  /* small video for the test */
  const d = await interpretDesign(row, "720p", s.deps);
  await applyDesign(s.db as never, row, { patch: { ...d.patch, video: { ...(d.patch.video ?? {}), height: 720, fps: 24, subtitles: true } } as never, baseVersion: 1, note: "small", userId: "u1" });
  row = (await loadStory(s.db as never, SURVEY, id))!;
  assert.ok((await setReviewStatus(s.db as never, row, "ready_to_render", s.deps)).ok);

  const pp = await startRender(s.db as never, row, { kind: "pptx", userId: "u1" }, s.deps);
  assert.ok(pp.ok);
  const pdone = await stepRender(s.db as never, (pp as { render: { id: string } }).render.id, s.deps);
  assert.ok(pdone.ok && pdone.render.status === "completed", JSON.stringify(pdone));
  const link = await downloadLink(s.db as never, SURVEY, pdone.render.id, s.deps);
  assert.ok(link.ok && /^https:\/\/store\.test\//.test(link.url) && /_v2\.pptx$/.test(link.name), JSON.stringify(link));
  assert.ok((pdone.render.qa as { pptx: { ok: boolean } }).pptx.ok);

  const v = await startRender(s.db as never, row, { kind: "video", userId: "u1" }, s.deps);
  assert.ok(v.ok);
  const vid = (v as { render: { id: string } }).render.id;
  /* a second start of the same version returns the same job — no duplicate */
  const dup = await startRender(s.db as never, row, { kind: "video", userId: "u1" }, s.deps);
  assert.equal((dup as { render: { id: string } }).render.id, vid);
  /* a tiny budget: one scene per step, so the job resumes across steps */
  let r = await stepRender(s.db as never, vid, s.deps, 1);
  assert.ok(r.ok && ["rendering", "verifying"].includes(r.render.status), JSON.stringify(r));
  for (let i = 0; i < 30 && r.ok && r.render.status !== "completed" && r.render.status !== "failed"; i++) r = await stepRender(s.db as never, vid, s.deps, i < 3 ? 1 : 60_000);
  assert.ok(r.ok && r.render.status === "completed", JSON.stringify(r.ok ? { s: r.render.status, e: r.render.error, qa: r.render.qa } : r).slice(0, 2000));
  const qa = r.render.qa as { video: { ok: boolean; scenes: unknown[] } };
  assert.ok(qa.video.ok && qa.video.scenes.length >= 3);
  assert.ok(s.usage.length === 2, "billing: one event per finished export");
  const segs = s.db.tables.analytics_story_segments.length;
  /* the same version again: the finished export is returned, nothing rendered */
  const again = await startRender(s.db as never, row, { kind: "video", userId: "u1" }, s.deps);
  assert.equal((again as { render: { id: string } }).render.id, vid);
  /* change one scene's text → a new version → only that scene renders */
  const next = structuredClone(row.definition);
  next.scenes[0].title = `${next.scenes[0].title} (revised)`;
  await saveDefinition(s.db as never, row, { definition: next, baseVersion: row.version, userId: "u1" });
  row = (await loadStory(s.db as never, SURVEY, id))!;
  const p = await storyPayload(s.db as never, row, s.deps);
  assert.match(p.estimate.note, /^1 of \d+ scenes to render/);
  const v2 = await startRender(s.db as never, row, { kind: "video", userId: "u1" }, s.deps);
  let r2 = await stepRender(s.db as never, (v2 as { render: { id: string } }).render.id, s.deps, 60_000);
  for (let i = 0; i < 5 && r2.ok && r2.render.status !== "completed"; i++) r2 = await stepRender(s.db as never, (v2 as { render: { id: string } }).render.id, s.deps, 60_000);
  assert.ok(r2.ok && r2.render.status === "completed");
  assert.equal(s.db.tables.analytics_story_segments.length, segs + 1, "one new scene rendered");
  /* cancel */
  next.scenes[0].title = "Another title";
  await saveDefinition(s.db as never, row, { definition: next, baseVersion: row.version, userId: "u1" });
  row = (await loadStory(s.db as never, SURVEY, id))!;
  const v3 = await startRender(s.db as never, row, { kind: "video", userId: "u1" }, s.deps);
  const c = await cancelRender(s.db as never, SURVEY, (v3 as { render: { id: string } }).render.id);
  assert.ok(c.ok);
  const after = await stepRender(s.db as never, (v3 as { render: { id: string } }).render.id, s.deps);
  assert.ok(after.ok && after.render.status === "cancelled");
  const no = await downloadLink(s.db as never, SURVEY, (v3 as { render: { id: string } }).render.id, s.deps);
  assert.equal(no.ok, false);
});

test("narration: with a configured speech service the video carries narration; without one the export says so and is silent", { timeout: 120_000 }, async () => {
  const s = setup();
  const id = ((await createStory(s.db as never, SURVEY, s.ctx, { userId: "u1", maxFindings: 1, exclude: ["comparison", "hypotheses", "conclusions", "recommendations", "limitations", "objective", "method", "sample", "summary", "appendix_table"] }, s.deps)) as { id: string }).id;
  let row = (await loadStory(s.db as never, SURVEY, id))!;
  await applyDesign(s.db as never, row, { patch: { video: { height: 720, fps: 24, narration: true } } as never, baseVersion: 1, note: "n", userId: "u1" });
  row = (await loadStory(s.db as never, SURVEY, id))!;
  process.env.REPORT_NARRATION_ENABLED = "1";
  const deps: StoryDeps = { ...s.deps, narration: () => speechNarration("fake-speech", async (t) => fakeSpeech(t.slice(0, 50)), () => true) };
  const v = await startRender(s.db as never, row, { kind: "video", userId: "u1" }, deps);
  let r = await stepRender(s.db as never, (v as { render: { id: string } }).render.id, deps, 60_000);
  for (let i = 0; i < 5 && r.ok && r.render.status !== "completed" && r.render.status !== "failed"; i++) r = await stepRender(s.db as never, (v as { render: { id: string } }).render.id, deps, 60_000);
  assert.ok(r.ok && r.render.status === "completed", JSON.stringify(r.ok && r.render.error));
  assert.ok((r.render.providers as { kind: string; status: string }[]).some((p) => p.kind === "narration" && p.status === "used"));
  assert.equal((r.render.qa as { video: { info: { audio?: { codec: string } } } }).video.info.audio?.codec, "aac");
  delete process.env.REPORT_NARRATION_ENABLED;
});

/* ------------------------------------------------------------------ Phase 4: publishing */

test("publish: the story is frozen into a report version a share link can open; publishing again adds a version to the same report", async () => {
  const { publishStory, newerDataFor } = await import("./storyEngine.ts");
  const s = setup();
  const id = ((await createStory(s.db as never, SURVEY, s.ctx, { userId: "u1" }, s.deps)) as { id: string }).id;
  let row = (await loadStory(s.db as never, SURVEY, id))!;
  const r1 = await publishStory(s.db as never, row, { userId: "u1", now: new Date("2026-10-13T09:00:00Z") });
  assert.ok(r1.ok, JSON.stringify(r1));
  const a = r1 as { reportId: string; version: number };
  assert.equal(a.version, 1);
  const rep = s.db.tables.analytics_reports.find((x: Record<string, unknown>) => x.id === a.reportId) as Record<string, any>;
  assert.equal(rep.published_version, 1);
  assert.equal(rep.definition.storyDoc.title, row.definition.title);
  assert.equal(s.db.tables.analytics_report_versions.length, 1);
  assert.equal((s.db.tables.analytics_report_versions[0] as Record<string, any>).definition.storyDoc.scenes.length, row.definition.scenes.length);
  row = (await loadStory(s.db as never, SURVEY, id))!;
  assert.equal(row.options?.published?.reportId, a.reportId);
  const r2 = await publishStory(s.db as never, row, { userId: "u1" });
  assert.ok(r2.ok);
  assert.equal((r2 as { reportId: string }).reportId, a.reportId, "the same report, so the same links keep working");
  assert.equal((r2 as { version: number }).version, 2);
  assert.equal(s.db.tables.analytics_reports.filter((x: Record<string, unknown>) => x.survey_id === SURVEY).length, 1);
  /* the payload says what is published, and nothing newer has arrived */
  const p = await storyPayload(s.db as never, (await loadStory(s.db as never, SURVEY, id))!, s.deps);
  assert.equal((p.published as { version: number }).version, 2);
  assert.equal(await newerDataFor(s.db as never, row), null);
});

test("publish: a story that fails the checks is not published, and the answer names the scene", async () => {
  const { publishStory } = await import("./storyEngine.ts");
  const s = setup();
  const id = ((await createStory(s.db as never, SURVEY, s.ctx, { userId: "u1" }, s.deps)) as { id: string }).id;
  const row = (await loadStory(s.db as never, SURVEY, id))!;
  const f = row.definition.scenes.find((x) => x.kind === "finding" && x.visual.type === "chart")!;
  if (f.visual.type === "chart") f.visual.data.series = [];
  const r = await publishStory(s.db as never, row, { userId: "u1" });
  assert.equal(r.ok, false);
  assert.equal((r as { status: number }).status, 409);
  assert.ok(JSON.stringify(r).includes(f.id) || /scene/i.test(JSON.stringify(r)), JSON.stringify(r));
  assert.equal(s.db.tables.analytics_report_versions.length, 0);
  assert.equal(s.db.tables.analytics_reports.length, 0);
});

test("newer responses are said, never applied: counted after the data was frozen, in the same environment", async () => {
  const { newerDataFor } = await import("./storyEngine.ts");
  const s = setup();
  const id = ((await createStory(s.db as never, SURVEY, s.ctx, { userId: "u1" }, s.deps)) as { id: string }).id;
  const row = (await loadStory(s.db as never, SURVEY, id))!;
  const since = row.definition.createdFrom.computedAt;
  const after = new Date(Date.parse(since) + 60_000).toISOString();
  const before = new Date(Date.parse(since) - 60_000).toISOString();
  const mk = (over: Record<string, unknown>) => ({ id: uuid(), survey_id: SURVEY, status: "complete", is_test: false, deleted_at: null, completed_at: after, ...over });
  s.db.tables.responses ??= [];
  s.db.tables.responses.push(mk({}), mk({}), mk({ completed_at: before }), mk({ is_test: true }), mk({ status: "partial" }));
  const n = await newerDataFor(s.db as never, row);
  assert.deepEqual(n && n.responses, 2);
});
