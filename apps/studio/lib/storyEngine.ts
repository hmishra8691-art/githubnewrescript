/**
 * STORY REPORTS — the service: create, edit, version, revise, brand, export.
 *
 * Results → Reports → Create report proposes a story report from the
 * analysis plan and a fresh run of it (the numbers are frozen into the
 * definition at that moment, with the run's id), saves it as version 1, and
 * from then on every change — a storyboard edit, a revision in words, a new
 * design, a regenerated scene — is a new immutable version. Exports are
 * made from a named version and recorded against it:
 *
 *   PowerPoint  built, read back and checked (native charts with the right
 *               numbers, native tables, no screenshots, in bounds) in the
 *               request, then stored.
 *   Video       a background job in steps: narration (when configured and
 *               enabled), scenes rendered and stored one by one by content
 *               hash — an unchanged scene is never rendered twice, a failed
 *               or cancelled job resumes where it stopped — then joined,
 *               decoded and checked frame by frame against the definition.
 *               Only a video that passes is marked completed.
 *
 * Database, storage, fonts and the engine's run are injected (`StoryDeps`),
 * so the same code runs in the Studio and in the tests over the in-memory
 * database. No research data leaves this server for a model: revisions and
 * design requests are read by the deterministic engine; only a design
 * request's leftover words (the look, never the data) may go to a
 * configured model, when the caller provides one.
 */
import type { AnalysisDefinition, AnalysisResult, AnalysisRun, Audience, DatasetSpec } from "@rescript/analytics";
import {
  planStoryReport, composeReport, checkStoryForPublish, defaultDesign, applyDesignPatch, interpretDesignRequest, interpretRevision, applyOps, describeOp, mergeRegenerated, brandTheme, PRESETS, describeStory,
  type StoryReport, type DesignConfig, type DesignPatch, type StoryOp, type BrandInput, type PresetId, type Composed,
} from "@rescript/analytics/story";
import { buildStoryPptx } from "@rescript/analytics/export";
import type { ObjectStore } from "@rescript/media";
import {
  planVideo, renderSegment, assembleVideo, verifyVideo, inspectStoryPptx, analyzeBrandAsset, brandFrom, estimateRender, narrate, visualsFor, RENDERER_VERSION,
  type ReportFonts, type NarrationProvider, type NarrationClip, type ProviderRecord, type BrandAnalysis,
} from "@rescript/reportvideo";
import type { SurveyDefinition } from "@rescript/schema";
import { checkEditedDefinition, designProblems, diffVersions, describeDiff, statusFor, segmentPath, artifactPath, retentionDays, downloadName, REPORTS_BUCKET, type StoryStatus } from "./storyCore.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = { from(table: string): any };
type Ctx = { def: unknown; version?: string | null };

export interface StoryDeps {
  runPlanFor(db: Db, surveyId: string, ctx: Ctx, opts: { environment?: DatasetSpec["environment"]; dataset?: "all" | "clean"; trigger?: string; userId?: string | null; skipEmpty?: boolean }): Promise<{ run: AnalysisRun; stored: { id: string } | null; error?: string }>;
  compute(db: Db, surveyId: string, ctx: Ctx, def: AnalysisDefinition): Promise<AnalysisResult>;
  reportFacts(db: Db, surveyId: string, def: SurveyDefinition): Promise<{ client?: string; fieldwork?: { from?: string; to?: string } }>;
  store(): ObjectStore;
  fonts(): ReportFonts;
  /** the narration provider for a survey's report (metered against that project), or null when none is configured */
  narration(surveyId: string, environment: string): NarrationProvider | null;
  /** a configured model for a design request's leftover words (the look only); absent → deterministic only */
  designModel?: (text: string, current: DesignConfig) => Promise<DesignPatch | null>;
  /** billing: one finished export */
  usage?: (e: { kind: "video" | "pptx"; environment: string; storyId: string; renderId: string; bytes: number; seconds?: number; scenes: number }) => void;
  now?: () => Date;
}

export type Fail = { ok: false; status: number; error: string; details?: unknown };
const fail = (status: number, error: string, details?: unknown): Fail => ({ ok: false, status, error, ...(details !== undefined ? { details } : {}) });

export interface StoryOptions { /** the report row this story is published through, and the version last published (Phase 4 sharing) */ published?: { reportId: string; version: number; storyVersion: number; at: string }; audience: Audience; maxFindings: number; exclude: string[]; environment: DatasetSpec["environment"]; dataset: "all" | "clean"; preset: PresetId }

/* ------------------------------------------------------------------ reading */

export interface StoryRow { id: string; survey_id: string; title: string; definition: StoryReport; version: number; status: string; outputs: { pptx: boolean; video: boolean }; options: Partial<StoryOptions>; run_id: string | null; environment: string; created_at: string; updated_at: string; created_by: string | null }

export async function loadStory(db: Db, surveyId: string, storyId: string): Promise<StoryRow | null> {
  const { data } = await db.from("analytics_story_reports").select("*").eq("id", storyId).eq("survey_id", surveyId).is("deleted_at", null).maybeSingle();
  return (data as StoryRow) ?? null;
}

export async function listStories(db: Db, surveyId: string): Promise<Record<string, unknown>[]> {
  const { data } = await db.from("analytics_story_reports").select("*").eq("survey_id", surveyId).is("deleted_at", null).order("updated_at", { ascending: false }).limit(100);
  const rows = (data ?? []) as StoryRow[];
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const renders = await rendersOf(db, r.id, 5);
    const active = renders.some((x) => ["queued", "rendering", "verifying"].includes(String(x.status)));
    const last = renders.find((x) => x.status === "completed" || x.status === "failed") ?? null;
    out.push({ id: r.id, title: r.title, version: r.version, outputs: r.outputs, updatedAt: r.updated_at, createdAt: r.created_at, scenes: r.definition.scenes.filter((s) => s.section === "main").length, status: statusFor({ stored: r.status, qa: null, activeRender: active, lastRender: last ? { status: String(last.status), version: Number(last.version) } : null, version: r.version }), design: r.definition.design.name });
  }
  return out;
}

async function rendersOf(db: Db, storyId: string, limit = 20): Promise<Record<string, any>[]> {
  const { data } = await db.from("analytics_story_renders").select("*").eq("story_id", storyId).order("created_at", { ascending: false }).limit(limit);
  return (data ?? []) as Record<string, any>[];
}

/** the checks a version passes, for both outputs */
export function checksFor(report: StoryReport, fonts: ReportFonts): { video: Composed["qa"]; pptx: Composed["qa"]; pages: { video: number; pptx: number } } {
  const v = composeReport(report, fonts.measurer, "video");
  const p = composeReport(report, fonts.measurer, "pptx");
  return { video: v.qa, pptx: p.qa, pages: { video: v.pages.length, pptx: p.pages.length } };
}

/** everything the storyboard needs for one report */
export async function storyPayload(db: Db, row: StoryRow, deps: StoryDeps) {
  const fonts = deps.fonts();
  const report = row.definition;
  const qa = checksFor(report, fonts);
  const plan = planVideo(report, fonts);
  const renders = await rendersOf(db, row.id);
  const active = renders.find((x) => ["queued", "rendering", "verifying"].includes(String(x.status))) ?? null;
  const last = renders.find((x) => x.status === "completed" || x.status === "failed") ?? null;
  const { data: versions } = await db.from("analytics_story_versions").select("version, note, changes, created_at, created_by").eq("story_id", row.id).order("version", { ascending: false }).limit(50);
  const { data: cachedRows } = await db.from("analytics_story_segments").select("hash").eq("survey_id", row.survey_id).in("hash", plan.segments.map((s) => s.hash));
  const cached = new Set(((cachedRows ?? []) as { hash: string }[]).map((x) => x.hash));
  const combinedCritical = [...qa.video.critical, ...qa.pptx.critical];
  const newerData = await newerDataFor(db, row);
  return {
    newerData,
    published: row.options?.published ?? null,
    story: { id: row.id, title: row.title, version: row.version, outputs: row.outputs, options: row.options, runId: row.run_id, environment: row.environment, createdAt: row.created_at, updatedAt: row.updated_at, storedStatus: row.status },
    definition: report,
    status: statusFor({ stored: row.status, qa: { critical: combinedCritical }, activeRender: !!active, lastRender: last ? { status: String(last.status), version: Number(last.version) } : null, version: row.version }) as StoryStatus,
    qa,
    timing: { total: plan.total, scenes: plan.segments.map((s) => ({ sceneId: s.sceneId, start: s.start, total: s.timing.total, minimum: s.timing.minimum, enter: s.timing.enter })), pacingNote: plan.pacingNote ?? null, width: plan.width, height: plan.height, fps: plan.fps },
    estimate: estimateRender(plan, report, cached),
    renders: renders.map(publicRender),
    versions: versions ?? [],
    summary: describeStory(report),
    presets: Object.entries(PRESETS).map(([id, d]) => ({ id, name: d.name })),
  };
}

/* ------------------------------------------------------------------ publishing (Phase 4) */

/** responses that arrived after the story's data was frozen — said on the story, never applied to it */
export async function newerDataFor(db: Db, row: StoryRow): Promise<{ since: string; responses: number } | null> {
  const since = row.definition?.createdFrom?.computedAt;
  if (!since) return null;
  try {
    let q = db.from("responses").select("id", { count: "exact", head: true }).eq("survey_id", row.survey_id).is("deleted_at", null).eq("status", "complete").gt("completed_at", since);
    if (row.environment === "LIVE") q = q.eq("is_test", false); else if (row.environment === "TEST") q = q.eq("is_test", true);
    const { count } = await q;
    return count && count > 0 ? { since, responses: count } : null;
  } catch { return null; }
}

/**
 * PUBLISH A STORY VERSION. The story document is frozen — scenes, their numbers
 * and their sources — into an immutable report version, so the existing share
 * route serves it exactly as it serves a report: one link, a password if you
 * set one, revocable, with every view recorded. Nothing is recomputed here and
 * nothing the story holds can be changed by the viewer. A story that does not
 * pass the publish check (headline, source, drawable numbers, contrast) is not
 * published, and the answer names the scene.
 */
export async function publishStory(db: Db, row: StoryRow, o: { userId?: string | null; note?: string | null; now?: Date } = {}): Promise<{ ok: true; reportId: string; version: number; publishedAt: string; warnings: unknown[] } | Fail> {
  const check = checkStoryForPublish(row.definition);
  if (!check.ok) return fail(409, `Not published. ${check.problems.map((p) => p.message).join(" ")}`, { problems: check.problems, warnings: check.warnings });
  const at = (o.now ?? new Date()).toISOString();
  const doc = row.definition;
  const shell = { title: doc.title, subtitle: doc.subtitle, mode: "snapshot", blocks: [], storyId: row.id, storyVersion: row.version, storyDoc: doc };
  let reportId = row.options?.published?.reportId ?? null;
  if (reportId) {
    const { data } = await db.from("analytics_reports").select("id").eq("id", reportId).eq("survey_id", row.survey_id).is("deleted_at", null).maybeSingle();
    if (!data) reportId = null;
  }
  if (!reportId) {
    const { data, error } = await db.from("analytics_reports").insert({ survey_id: row.survey_id, kind: "report", name: `${row.title} (story)`, definition: shell, mode: "snapshot", created_by: o.userId ?? null, updated_by: o.userId ?? null }).select("id").single();
    if (error || !data) return fail(500, error?.message ?? "The story could not be published.");
    reportId = (data as { id: string }).id;
  }
  const { data: last } = await db.from("analytics_report_versions").select("version").eq("report_id", reportId).order("version", { ascending: false }).limit(1);
  const version = ((last as { version: number }[] | null)?.[0]?.version ?? 0) + 1;
  const dataset = { surveyVersion: doc.createdFrom.surveyVersion ?? null, responses: doc.createdFrom.n, environments: [doc.createdFrom.environment], computedAt: doc.createdFrom.computedAt, story: true };
  const ins = await db.from("analytics_report_versions").insert({ report_id: reportId, survey_id: row.survey_id, version, definition: shell, theme: null, snapshot: {}, dataset, note: o.note ?? `Story version ${row.version}`, published_by: o.userId ?? null });
  if (ins.error) return fail(500, ins.error.message);
  await db.from("analytics_reports").update({ published_version: version, name: `${row.title} (story)`, definition: shell, updated_by: o.userId ?? null }).eq("id", reportId);
  await db.from("analytics_story_reports").update({ options: { ...row.options, published: { reportId, version, storyVersion: row.version, at } } }).eq("id", row.id);
  return { ok: true, reportId, version, publishedAt: at, warnings: check.warnings };
}

function publicRender(r: Record<string, any>) {
  return { id: r.id, kind: r.kind, version: r.version, status: r.status, progress: r.progress ?? {}, qa: r.qa ?? null, providers: r.providers ?? [], estimate: r.estimate ?? null, bytes: r.bytes ?? null, error: r.error ?? null, createdAt: r.created_at, startedAt: r.started_at ?? null, finishedAt: r.finished_at ?? null, expiresAt: r.expires_at ?? null, ready: r.status === "completed" && !!r.path };
}

/* ------------------------------------------------------------------ creating */

export interface CreateInput { title?: string; audience?: Audience; preset?: PresetId; themeId?: string | null; outputs?: { pptx: boolean; video: boolean }; environment?: DatasetSpec["environment"]; dataset?: "all" | "clean"; maxFindings?: number; exclude?: string[]; userId: string | null; design?: DesignConfig }

/** the respondent profile: the plan's banner (column) variables, single-coded, as frequencies */
async function profileFor(db: Db, surveyId: string, ctx: Ctx, deps: StoryDeps, spec: DatasetSpec) {
  const def = ctx.def as SurveyDefinition;
  const banners = [...new Set(((def.research?.analysisPlan?.crosstabs ?? []) as { columns?: string[] }[]).flatMap((x) => x.columns ?? []))];
  const singles = new Set(def.questions.filter((q) => q.type === "single_select" || q.type === "dropdown").map((q) => q.variableName ?? q.code));
  const out: { variable: string; label: string; result: AnalysisResult; definition: AnalysisDefinition }[] = [];
  for (const v of banners.filter((b) => singles.has(b)).slice(0, 2)) {
    const definition: AnalysisDefinition = { name: `Profile: ${v}`, kind: "descriptive", dataset: spec, variables: [v] };
    try { out.push({ variable: v, label: def.questions.find((q) => (q.variableName ?? q.code) === v)?.text ?? v, result: await deps.compute(db, surveyId, ctx, definition), definition }); } catch { /* a profile is optional */ }
  }
  return out;
}

async function buildReport(db: Db, surveyId: string, ctx: Ctx, deps: StoryDeps, opts: StoryOptions & { title?: string; design: DesignConfig; userId: string | null }): Promise<{ report: StoryReport; runId: string | null } | Fail> {
  const r = await deps.runPlanFor(db, surveyId, ctx, { environment: opts.environment, dataset: opts.dataset, trigger: "story_report", userId: opts.userId, skipEmpty: true });
  if (r.error && !r.run.items.length) return fail(400, r.error);
  if (r.run.n === 0) return fail(400, `There are no ${opts.environment === "TEST" ? "test" : opts.environment === "ALL" ? "" : "live"} completes to report on yet. Choose another dataset, or wait for responses.`.replace("  ", " "));
  const spec: DatasetSpec = { environment: opts.environment, dataset: opts.dataset };
  const facts = await deps.reportFacts(db, surveyId, ctx.def as SurveyDefinition);
  const profile = await profileFor(db, surveyId, ctx, deps, spec);
  const report = planStoryReport(ctx.def as SurveyDefinition, r.run as never, {
    audience: opts.audience, design: opts.design, ...(opts.title ? { title: opts.title } : {}), ...(facts.client ? { client: facts.client } : {}),
    runId: r.stored?.id ?? null, surveyVersion: ctx.version ?? null, maxFindings: opts.maxFindings, exclude: opts.exclude as never,
    sample: { analysed: r.run.n, environment: opts.environment, dataset: opts.dataset, ...(facts.fieldwork ? { fieldwork: facts.fieldwork } : {}) },
    profile, date: (deps.now?.() ?? new Date()).toISOString().slice(0, 10),
  });
  return { report, runId: r.stored?.id ?? null };
}

export async function createStory(db: Db, surveyId: string, ctx: Ctx, input: CreateInput, deps: StoryDeps): Promise<{ ok: true; id: string } | Fail> {
  const preset: PresetId = input.preset && input.preset in PRESETS ? input.preset : "corporate_executive";
  let design = input.design ?? defaultDesign(preset);
  if (input.themeId) {
    const { data: t } = await db.from("analytics_story_themes").select("*").eq("id", input.themeId).is("deleted_at", null).maybeSingle();
    if (!t) return fail(404, "That saved theme no longer exists.");
    design = t.design as DesignConfig;
  }
  const outputs = { pptx: input.outputs?.pptx !== false, video: input.outputs?.video !== false };
  if (!outputs.pptx && !outputs.video) return fail(400, "Choose PowerPoint, video, or both.");
  const options: StoryOptions = { audience: input.audience ?? "client", maxFindings: Math.max(1, Math.min(12, input.maxFindings ?? 5)), exclude: (input.exclude ?? []).slice(0, 20), environment: input.environment ?? "LIVE", dataset: input.dataset ?? "all", preset };
  const built = await buildReport(db, surveyId, ctx, deps, { ...options, design, userId: input.userId, ...(input.title?.trim() ? { title: input.title.trim().slice(0, 160) } : {}) });
  if ("ok" in built) return built;
  const report = { ...built.report, outputs };
  const { data: row, error } = await db.from("analytics_story_reports").insert({ survey_id: surveyId, title: report.title.slice(0, 200), definition: report, version: 1, status: "draft", outputs, options, run_id: built.runId, environment: options.environment, created_by: input.userId, updated_by: input.userId }).select("*").single();
  if (error || !row) return fail(500, `The report could not be saved: ${error?.message ?? "no row"}`);
  await db.from("analytics_story_versions").insert({ story_id: row.id, version: 1, definition: report, note: `Proposed from the analysis plan and run ${built.runId ? built.runId.slice(0, 8) : "(not stored)"} — ${report.createdFrom.n} completes`, changes: [], created_by: input.userId });
  return { ok: true, id: String(row.id) };
}

/* ------------------------------------------------------------------ versions */

async function saveVersion(db: Db, row: StoryRow, next: StoryReport, meta: { note: string; changes: string[]; userId: string | null; status?: string; runId?: string | null }): Promise<{ ok: true; version: number } | Fail> {
  const version = row.version + 1;
  const ins = await db.from("analytics_story_versions").insert({ story_id: row.id, version, definition: next, note: meta.note.slice(0, 500), changes: meta.changes.slice(0, 60), created_by: meta.userId });
  if (ins.error) return /duplicate|unique/i.test(ins.error.message) ? fail(409, "Someone saved this report at the same moment. Reload to see their version.") : fail(500, ins.error.message);
  const upd = await db.from("analytics_story_reports").update({ definition: next, version, title: next.title.slice(0, 200), status: meta.status ?? "draft", outputs: next.outputs, updated_by: meta.userId, updated_at: new Date().toISOString(), ...(meta.runId !== undefined ? { run_id: meta.runId } : {}) }).eq("id", row.id).eq("version", row.version);
  if (upd.error) return fail(500, upd.error.message);
  return { ok: true, version };
}

/** save an edited definition from the storyboard (optimistic: `baseVersion` must be current) */
export async function saveDefinition(db: Db, row: StoryRow, input: { definition: unknown; baseVersion: number; note?: string; userId: string | null }): Promise<{ ok: true; version: number; changes: string } | Fail> {
  if (input.baseVersion !== row.version) return fail(409, `This report is at version ${row.version}; your edit was made on version ${input.baseVersion}. Reload to see the newer version.`);
  const check = checkEditedDefinition(input.definition, row.definition);
  if (!check.ok) return fail(422, "The edit was not saved.", check.errors);
  const next = input.definition as StoryReport;
  const d = diffVersions(row.definition, next);
  const words = describeDiff(d);
  if (words === "no changes") return { ok: true, version: row.version, changes: words };
  const saved = await saveVersion(db, row, next, { note: input.note?.trim() || `Edited: ${words}`, changes: [...d.changed.map((c) => `${c.title}: ${c.fields.join(", ")}`), ...d.added.map((t) => `added ${t}`), ...d.removed.map((t) => `removed ${t}`)], userId: input.userId });
  return saved.ok ? { ...saved, changes: words } : saved;
}

export async function setReviewStatus(db: Db, row: StoryRow, status: "draft" | "ready_for_review" | "ready_to_render", deps: StoryDeps): Promise<{ ok: true } | Fail> {
  if (status === "ready_to_render") {
    const qa = checksFor(row.definition, deps.fonts());
    const critical = [...qa.video.critical, ...qa.pptx.critical];
    if (critical.length) return fail(422, `${critical.length} issue${critical.length === 1 ? "" : "s"} must be fixed before rendering.`, critical.slice(0, 20));
  }
  await db.from("analytics_story_reports").update({ status }).eq("id", row.id);
  return { ok: true };
}

export async function versionDefinition(db: Db, storyId: string, version: number): Promise<StoryReport | null> {
  const { data } = await db.from("analytics_story_versions").select("definition").eq("story_id", storyId).eq("version", version).maybeSingle();
  return (data?.definition as StoryReport) ?? null;
}

export async function compareVersions(db: Db, row: StoryRow, a: number, b: number) {
  const [x, y] = await Promise.all([versionDefinition(db, row.id, a), versionDefinition(db, row.id, b)]);
  if (!x || !y) return fail(404, "Unknown version.");
  const d = diffVersions(x, y);
  return { ok: true as const, a, b, diff: d, summary: describeDiff(d) };
}

export async function revertTo(db: Db, row: StoryRow, version: number, userId: string | null): Promise<{ ok: true; version: number } | Fail> {
  const def = await versionDefinition(db, row.id, version);
  if (!def) return fail(404, "Unknown version.");
  return saveVersion(db, row, def, { note: `Reverted to version ${version}`, changes: [describeDiff(diffVersions(row.definition, def))], userId });
}

/* ------------------------------------------------------------------ revisions in words */

export interface RevisionPreview { ops: (StoryOp & { describe: string })[]; understood: string[]; refused: { request: string; why: string; alternative?: string }[]; unclear: string[]; changes: string[]; affected: string[] }

export function previewRevision(row: StoryRow, text: string, selected?: string | null, brand?: BrandInput | null): RevisionPreview {
  const reading = interpretRevision(text.slice(0, 2000), row.definition, { ...(selected ? { selected } : {}), brand: brand ?? null });
  const trial = applyOps(row.definition, reading.ops, { brand: brand ?? null });
  return { ops: reading.ops.map((o) => ({ ...o, describe: describeOp(o, row.definition) })), understood: reading.understood, refused: [...reading.refused, ...trial.refused.map((r) => ({ request: r, why: "not possible on this report" }))], unclear: reading.unclear, changes: trial.changes, affected: trial.affected };
}

/** apply the operations the person saw in the preview (sent back as they were shown) */
export async function applyRevision(db: Db, row: StoryRow, input: { ops: StoryOp[]; text: string; baseVersion: number; userId: string | null; brand?: BrandInput | null }): Promise<{ ok: true; version: number; changes: string[]; refused: string[]; affected: string[] } | Fail> {
  if (input.baseVersion !== row.version) return fail(409, `This report changed (now version ${row.version}) since the preview. Preview the request again.`);
  if (!Array.isArray(input.ops) || !input.ops.length) return fail(400, "Nothing to apply.");
  const allowed = new Set(["set_text", "set_chart", "set_bullets", "move", "set_section", "remove", "set_duration", "set_emphasis", "set_motion", "set_layout", "set_highlight", "restore", "design"]);
  const ops = input.ops.filter((o) => o && allowed.has((o as { op: string }).op)).slice(0, 80);
  const out = applyOps(row.definition, ops, { brand: input.brand ?? null });
  const check = checkEditedDefinition(out.report, row.definition);
  if (!check.ok) return fail(422, "The revision was not applied.", check.errors);
  if (!out.changes.length) return fail(422, "None of the changes could be applied.", out.refused);
  const saved = await saveVersion(db, row, out.report, { note: `Revision: “${input.text.slice(0, 200)}”`, changes: out.changes, userId: input.userId });
  return saved.ok ? { ok: true, version: saved.version, changes: out.changes, refused: out.refused, affected: out.affected } : saved;
}

/* ------------------------------------------------------------------ design */

export async function interpretDesign(row: StoryRow, text: string, deps: StoryDeps, brand?: BrandInput | null): Promise<{ patch: DesignPatch; understood: string[]; unclear: string[]; preview: DesignConfig; adjustments: { token: string; from: string; to: string; why: string }[]; model: string | null }> {
  const reading = interpretDesignRequest(text.slice(0, 1000), { brand: brand ?? null, current: row.definition.design });
  let patch = reading.patch;
  let model: string | null = null;
  /* the leftover words only, and only the look: never the report's content */
  if (reading.unclear.length && deps.designModel) {
    try {
      const extra = await deps.designModel(reading.unclear.join("; "), row.definition.design);
      if (extra && Object.keys(extra).length) { patch = { ...extra, ...patch, colors: { ...(extra.colors ?? {}), ...(patch.colors ?? {}) } } as DesignPatch; model = "configured model"; reading.understood.push(`the model read: “${reading.unclear.join("; ").slice(0, 80)}”`); reading.unclear = []; }
    } catch { /* the deterministic reading stands */ }
  }
  const { design, adjustments } = applyDesignPatch(row.definition.design, patch, { brand: brand ?? null });
  return { patch, understood: reading.understood, unclear: reading.unclear, preview: design, adjustments, model };
}

export async function applyDesign(db: Db, row: StoryRow, input: { patch?: DesignPatch; design?: DesignConfig; baseVersion: number; note: string; userId: string | null; brand?: BrandInput | null }): Promise<{ ok: true; version: number; adjustments: unknown[] } | Fail> {
  if (input.baseVersion !== row.version) return fail(409, `This report changed (now version ${row.version}). Reload and try again.`);
  let design: DesignConfig; let adjustments: unknown[] = [];
  if (input.design) { const r = applyDesignPatch(input.design, {}, { brand: input.brand ?? null }); design = r.design; adjustments = r.adjustments; }
  else if (input.patch) { const r = applyDesignPatch(row.definition.design, input.patch, { brand: input.brand ?? null }); design = r.design; adjustments = r.adjustments; }
  else return fail(400, "A design or a patch is required.");
  const problems = designProblems(design);
  if (problems.length) return fail(422, "The design was not saved.", problems);
  const next: StoryReport = { ...row.definition, design };
  const saved = await saveVersion(db, row, next, { note: input.note.slice(0, 300) || "Design changed", changes: [`design: ${describeDiff(diffVersions(row.definition, next))}`], userId: input.userId });
  return saved.ok ? { ...saved, adjustments } : saved;
}

/** brand files, read here: colours, fonts, the logo — and the six themes built from them, contrast-checked */
export function analyzeBrand(files: { name: string; mimeType: string; bytes: Uint8Array }[], current: DesignConfig) {
  const analyses: BrandAnalysis[] = files.slice(0, 8).map((f) => analyzeBrandAsset(f.bytes, f.mimeType, f.name));
  const brand = brandFrom(analyses);
  const input: BrandInput = { colors: brand.colors, fonts: brand.fonts, ...(brand.logo ? { logo: { dataUri: brand.logo.dataUri, width: brand.logo.width, height: brand.logo.height, placement: current.logo?.placement ?? "top_right" } as DesignConfig["logo"] } : {}) };
  const themes = brand.colors.length || brand.logo
    ? (Object.keys(PRESETS) as PresetId[]).map((p) => { const t = brandTheme(p, input); return { preset: p, name: t.design.name, design: t.design, adjustments: t.adjustments }; })
    : [];
  return { analyses: analyses.map((a) => ({ ...a, logo: a.logo ? { width: a.logo.width, height: a.logo.height, transparent: a.logo.transparent, dataUri: a.logo.dataUri.length < 2_000_000 ? a.logo.dataUri : null } : undefined })), brand: { colors: brand.colors, fonts: brand.fonts, hasLogo: !!brand.logo }, themes };
}

export async function saveTheme(db: Db, input: { name: string; design: DesignConfig; brand?: unknown; scope: "project" | "workspace"; surveyId: string; customerId: string | null; userId: string | null }) {
  if (!input.name.trim()) return fail(400, "A theme needs a name.");
  if (input.scope === "workspace" && !input.customerId) return fail(400, "Your account has no workspace to save a theme to — save it to this project instead.");
  const { data, error } = await db.from("analytics_story_themes").insert({ name: input.name.trim().slice(0, 120), design: applyDesignPatch(input.design, {}).design, brand: input.brand ?? {}, survey_id: input.scope === "project" ? input.surveyId : null, customer_id: input.scope === "workspace" ? input.customerId : null, created_by: input.userId }).select("*").single();
  if (error) return fail(500, error.message);
  return { ok: true as const, theme: data };
}

export async function listThemes(db: Db, surveyId: string, customerId: string | null) {
  const q = db.from("analytics_story_themes").select("id, name, design, survey_id, customer_id, created_at").is("deleted_at", null);
  const { data } = customerId ? await q.or(`survey_id.eq.${surveyId},customer_id.eq.${customerId}`) : await q.eq("survey_id", surveyId);
  return ((data ?? []) as Record<string, unknown>[]).map((t) => ({ ...t, scope: t.survey_id ? "project" : "workspace" }));
}

/* ------------------------------------------------------------------ regenerate */

/** re-plan from a fresh run; the person's edits (locked fields, removed/moved scenes) survive. `sceneId` regenerates one scene. */
export async function regenerate(db: Db, row: StoryRow, ctx: Ctx, deps: StoryDeps, input: { sceneId?: string | null; userId: string | null }): Promise<{ ok: true; version: number } | Fail> {
  const o = row.options ?? {};
  const built = await buildReport(db, row.survey_id, ctx, deps, { audience: o.audience ?? row.definition.audience, maxFindings: o.maxFindings ?? 5, exclude: o.exclude ?? [], environment: o.environment ?? "LIVE", dataset: o.dataset ?? "all", preset: o.preset ?? "corporate_executive", design: row.definition.design, userId: input.userId });
  if ("ok" in built) return built;
  if (input.sceneId && !built.report.scenes.some((s) => s.id === input.sceneId)) return fail(404, "That scene is not in the new run's results (its analysis may have been removed from the plan).");
  const merged = mergeRegenerated(row.definition, built.report, input.sceneId ?? undefined);
  return saveVersion(db, row, merged, { note: input.sceneId ? `Scene regenerated from run ${built.runId?.slice(0, 8) ?? ""}` : `Regenerated from run ${built.runId?.slice(0, 8) ?? ""} (${built.report.createdFrom.n} completes)`, changes: [describeDiff(diffVersions(row.definition, merged))], userId: input.userId, ...(input.sceneId ? {} : { runId: built.runId }) });
}

/* ------------------------------------------------------------------ exports */

const ACTIVE = ["queued", "rendering", "verifying"];

export async function startRender(db: Db, row: StoryRow, input: { kind: "video" | "pptx"; userId: string | null }, deps: StoryDeps): Promise<{ ok: true; render: ReturnType<typeof publicRender> } | Fail> {
  const fonts = deps.fonts();
  const report = row.definition;
  const qa = checksFor(report, fonts);
  const critical = input.kind === "video" ? qa.video.critical : qa.pptx.critical;
  if (critical.length) return fail(422, `${critical.length} issue${critical.length === 1 ? "" : "s"} must be fixed before this can be exported.`, critical.slice(0, 20));
  const { data: active } = await db.from("analytics_story_renders").select("*").eq("story_id", row.id).eq("kind", input.kind).in("status", ACTIVE).limit(1);
  if (active?.length) {
    const a = active[0] as Record<string, any>;
    if (Number(a.version) === row.version) return { ok: true, render: publicRender(a) };
    return fail(409, `A ${input.kind === "video" ? "video" : "PowerPoint"} of version ${a.version} is still being made. Cancel it or wait for it to finish.`, { renderId: a.id });
  }
  /* the same version already finished and is still kept: no second charge */
  const { data: done } = await db.from("analytics_story_renders").select("*").eq("story_id", row.id).eq("kind", input.kind).eq("version", row.version).eq("status", "completed").limit(1);
  if (done?.length && (!done[0].expires_at || String(done[0].expires_at) > new Date().toISOString())) return { ok: true, render: publicRender(done[0]) };
  const plan = input.kind === "video" ? planVideo(report, fonts) : null;
  const estimate = plan ? estimateRender(plan, report) : null;
  const ins = await db.from("analytics_story_renders").insert({ story_id: row.id, survey_id: row.survey_id, version: row.version, kind: input.kind, status: "queued", plan_hash: plan?.hash ?? null, plan: plan ? { total: plan.total, width: plan.width, height: plan.height, fps: plan.fps, segments: plan.segments.map((s) => ({ sceneId: s.sceneId, hash: s.hash, total: s.timing.total })) } : {}, progress: { stage: "queued", done: 0, total: plan?.segments.length ?? 1 }, estimate, created_by: input.userId }).select("*").single();
  if (ins.error) return /duplicate|unique/i.test(ins.error.message) ? fail(409, "This export is already being made.") : fail(500, ins.error.message);
  return { ok: true, render: publicRender(ins.data) };
}

const providerRecord = (p: ProviderRecord) => ({ ...p });

/**
 * Advance one export as far as the time budget allows. Safe to call from
 * several places at once (the panel's polling and the scheduler): a lease
 * keeps one worker on a job, and every stored scene is keyed by its hash.
 */
export async function stepRender(db: Db, renderId: string, deps: StoryDeps, budgetMs = 40_000): Promise<{ ok: true; render: ReturnType<typeof publicRender> } | Fail> {
  const t0 = Date.now();
  const now = () => new Date(Date.now()).toISOString();
  const { data: r0 } = await db.from("analytics_story_renders").select("*").eq("id", renderId).maybeSingle();
  if (!r0) return fail(404, "Unknown export.");
  let job = r0 as Record<string, any>;
  if (!ACTIVE.includes(String(job.status))) return { ok: true, render: publicRender(job) };
  if (job.lease_until && String(job.lease_until) > now()) return { ok: true, render: publicRender(job) };
  const lease = new Date(Date.now() + budgetMs + 30_000).toISOString();
  await db.from("analytics_story_renders").update({ lease_until: lease, status: job.status === "queued" ? "rendering" : job.status, started_at: job.started_at ?? now(), attempts: Number(job.attempts ?? 0) + (job.status === "queued" ? 1 : 0) }).eq("id", renderId);
  job = { ...job, lease_until: lease, status: job.status === "queued" ? "rendering" : job.status };
  const update = async (patch: Record<string, unknown>) => { await db.from("analytics_story_renders").update(patch).eq("id", renderId); job = { ...job, ...patch }; };
  const cancelled = async () => { const { data } = await db.from("analytics_story_renders").select("status").eq("id", renderId).maybeSingle(); return data?.status === "cancelled"; };
  const failJob = async (error: string, qa?: unknown) => { await update({ status: "failed", error: error.slice(0, 2000), ...(qa ? { qa } : {}), finished_at: now(), lease_until: null }); return { ok: true as const, render: publicRender(job) }; };
  try {
    const report = await versionDefinition(db, String(job.story_id), Number(job.version));
    if (!report) return failJob("The report version this export was made from no longer exists.");
    const { data: storyRow } = await db.from("analytics_story_reports").select("environment, title").eq("id", job.story_id).maybeSingle();
    const store = deps.store();
    const fonts = deps.fonts();

    if (job.kind === "pptx") {
      const c = composeReport(report, fonts.measurer, "pptx");
      if (!c.qa.ok) return failJob(`The layout checks failed: ${c.qa.critical.slice(0, 3).map((x) => x.message).join("; ")}`, { layout: c.qa });
      const buf = await buildStoryPptx({ report, pages: c.pages, version: Number(job.version) });
      const pq = inspectStoryPptx(buf, report, c.pages);
      if (!pq.ok) return failJob(`The PowerPoint failed its checks: ${pq.checks.filter((x) => x.severity === "critical").slice(0, 3).map((x) => x.message).join("; ")}`, { layout: c.qa, pptx: pq });
      const path = artifactPath(String(job.survey_id), String(job.story_id), Number(job.version), renderId, "pptx");
      await store.put(REPORTS_BUCKET, path, buf, { contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
      const head = await store.head(REPORTS_BUCKET, path);
      if (!head || head.size !== buf.length) return failJob("The PowerPoint was not stored correctly; try again.");
      await update({ status: "completed", qa: { layout: summarizeQa(c.qa), pptx: pq }, storage_provider: store.name, bucket: REPORTS_BUCKET, path, bytes: buf.length, finished_at: now(), lease_until: null, expires_at: new Date(Date.now() + retentionDays() * 86400_000).toISOString(), progress: { stage: "completed", done: 1, total: 1 }, providers: [providerRecord({ kind: "renderer", provider: "rescript-pptx", model: "pptxgenjs native charts", status: "used" })] });
      deps.usage?.({ kind: "pptx", environment: String(storyRow?.environment ?? "TEST"), storyId: String(job.story_id), renderId, bytes: buf.length, scenes: c.pages.length });
      return { ok: true, render: publicRender(job) };
    }

    /* ---- video ---- */
    const progress = { ...(job.progress ?? {}) } as Record<string, any>;
    /* 1. narration, stored so later steps (other invocations) reuse it */
    let clips: NarrationClip[] = [];
    const providers: ProviderRecord[] = [{ kind: "renderer", provider: "rescript-video", model: RENDERER_VERSION, status: "used", detail: "charts, numbers and text drawn deterministically from the report definition" }, visualsFor(report, null).record];
    if (report.design.video.narration) {
      if (Array.isArray(progress.narration)) {
        for (const n of progress.narration as { sceneId: string; path: string; seconds: number; text: string; mimeType: string }[]) clips.push({ sceneId: n.sceneId, text: n.text, seconds: n.seconds, mimeType: n.mimeType, bytes: await store.read(REPORTS_BUCKET, n.path) });
        providers.push(...((progress.narrationRecord ? [progress.narrationRecord] : []) as ProviderRecord[]));
      } else {
        await update({ progress: { ...progress, stage: "narration" } });
        const n = await narrate(report, deps.narration(String(job.survey_id), String(storyRow?.environment ?? "TEST")));
        const stored: { sceneId: string; path: string; seconds: number; text: string; mimeType: string }[] = [];
        for (const c of n.clips) {
          const path = `${job.survey_id}/narration/${renderId}-${c.sceneId.replace(/[^\w-]/g, "_")}.${c.mimeType.includes("wav") ? "wav" : "mp3"}`;
          await store.put(REPORTS_BUCKET, path, c.bytes, { contentType: c.mimeType });
          stored.push({ sceneId: c.sceneId, path, seconds: c.seconds, text: c.text, mimeType: c.mimeType });
        }
        clips = n.clips;
        progress.narration = stored; progress.narrationRecord = n.record;
        providers.push(n.record);
      }
    }
    /* 2. the plan, with the narration's real lengths */
    const plan = planVideo(report, fonts, clips);
    if (!plan.composed.qa.ok) return failJob(`The layout checks failed: ${plan.composed.qa.critical.slice(0, 3).map((x) => x.message).join("; ")}`, { layout: summarizeQa(plan.composed.qa) });
    const { data: cachedRows } = await db.from("analytics_story_segments").select("hash, path, storage_provider").eq("survey_id", job.survey_id).in("hash", plan.segments.map((s) => s.hash));
    const cached = new Map(((cachedRows ?? []) as { hash: string; path: string }[]).map((x) => [x.hash, x.path]));
    const total = plan.segments.length;
    let done = plan.segments.filter((s) => cached.has(s.hash)).length;
    progress.stage = "rendering"; progress.total = total; progress.done = done; progress.reused = progress.reused ?? done; progress.seconds = plan.total;
    await update({ progress, plan_hash: plan.hash, providers: providers.map(providerRecord) });
    /* 3. scenes, one by one, until the budget is spent */
    for (const seg of plan.segments) {
      if (cached.has(seg.hash)) continue;
      if (Date.now() - t0 > budgetMs) { await update({ lease_until: null, progress: { ...progress, done, current: null } }); return { ok: true, render: publicRender(job) }; }
      if (await cancelled()) return { ok: true, render: publicRender({ ...job, status: "cancelled" }) };
      await update({ progress: { ...progress, done, current: { index: seg.index, title: seg.title } } });
      const out = await renderSegment(plan, seg.index, fonts, { audio: clips.find((c) => c.sceneId === seg.sceneId) });
      const path = segmentPath(String(job.survey_id), seg.hash);
      try { await store.put(REPORTS_BUCKET, path, out.bytes, { contentType: "video/mp4" }); }
      catch (e) { if (!(await store.head(REPORTS_BUCKET, path))) throw e; /* another worker stored the same scene */ }
      await db.from("analytics_story_segments").insert({ survey_id: job.survey_id, hash: seg.hash, storage_provider: store.name, bucket: REPORTS_BUCKET, path, bytes: out.bytes.length, seconds: seg.timing.total });
      cached.set(seg.hash, path);
      done++;
    }
    if (Date.now() - t0 > budgetMs * 0.85 && total > 3) { await update({ lease_until: null, progress: { ...progress, done, stage: "assembling", current: null } }); return { ok: true, render: publicRender(job) }; }
    /* 4. join, check, store */
    await update({ status: "verifying", progress: { ...progress, done, stage: "verifying", current: null } });
    const parts: Buffer[] = [];
    for (const seg of plan.segments) parts.push(Buffer.from(await store.read(REPORTS_BUCKET, cached.get(seg.hash)!)));
    const video = await assembleVideo(plan, parts);
    const vqa = await verifyVideo(video, plan, fonts);
    if (!vqa.ok) {
      /* repair once: the scenes that failed are rendered again (their cached copies may be bad), then checked again */
      const bad = [...new Set(vqa.checks.filter((c) => c.severity === "critical" && c.scene !== undefined).map((c) => plan.segments[c.scene!].hash))];
      if (bad.length && Number(job.attempts ?? 1) < 3) {
        for (const h of bad) await db.from("analytics_story_segments").update({ hash: `${h}-rejected-${renderId.slice(0, 8)}` }).eq("survey_id", job.survey_id).eq("hash", h);
        await update({ status: "rendering", attempts: Number(job.attempts ?? 1) + 1, lease_until: null, progress: { ...progress, stage: "repairing", repaired: bad.length } });
        return { ok: true, render: publicRender(job) };
      }
      return failJob(`The video failed its checks: ${vqa.checks.filter((c) => c.severity === "critical").slice(0, 3).map((c) => c.message).join("; ")}`, { layout: summarizeQa(plan.composed.qa), video: vqa });
    }
    const path = artifactPath(String(job.survey_id), String(job.story_id), Number(job.version), renderId, "mp4");
    await store.put(REPORTS_BUCKET, path, video, { contentType: "video/mp4" });
    if (plan.subtitles) await store.put(REPORTS_BUCKET, artifactPath(String(job.survey_id), String(job.story_id), Number(job.version), renderId, "srt"), Buffer.from(plan.subtitles), { contentType: "application/x-subrip" });
    const head = await store.head(REPORTS_BUCKET, path);
    if (!head || head.size !== video.length) return failJob("The video was not stored correctly; try again.");
    await update({ status: "completed", qa: { layout: summarizeQa(plan.composed.qa), video: vqa }, storage_provider: store.name, bucket: REPORTS_BUCKET, path, bytes: video.length, finished_at: now(), lease_until: null, expires_at: new Date(Date.now() + retentionDays() * 86400_000).toISOString(), progress: { ...progress, stage: "completed", done: total, current: null, subtitles: !!plan.subtitles } });
    deps.usage?.({ kind: "video", environment: String(storyRow?.environment ?? "TEST"), storyId: String(job.story_id), renderId, bytes: video.length, seconds: plan.total, scenes: total });
    return { ok: true, render: publicRender(job) };
  } catch (e) {
    const msg = (e as Error).message ?? "unknown error";
    if (Number(job.attempts ?? 1) < 3 && !/cancelled/.test(msg)) { await update({ lease_until: null, attempts: Number(job.attempts ?? 1) + 1, error: msg.slice(0, 500), progress: { ...(job.progress ?? {}), stage: "retrying" } }); return { ok: true, render: publicRender(job) }; }
    return failJob(`The export stopped: ${msg}`);
  }
}

function summarizeQa(q: Composed["qa"]) { return { pages: q.pages, critical: q.critical, warnings: q.warnings.slice(0, 40), repairs: q.repairs, valuesVerified: q.valuesVerified, ok: q.ok }; }

export async function cancelRender(db: Db, surveyId: string, renderId: string): Promise<{ ok: true } | Fail> {
  const { data } = await db.from("analytics_story_renders").select("status, survey_id").eq("id", renderId).maybeSingle();
  if (!data || data.survey_id !== surveyId) return fail(404, "Unknown export.");
  if (!ACTIVE.includes(String(data.status))) return fail(409, `This export has already ${data.status === "completed" ? "finished" : data.status}.`);
  await db.from("analytics_story_renders").update({ status: "cancelled", finished_at: new Date().toISOString(), lease_until: null }).eq("id", renderId);
  return { ok: true };
}

/** a short-lived signed link to a finished, checked artifact */
export async function downloadLink(db: Db, surveyId: string, renderId: string, deps: StoryDeps, what: "file" | "subtitles" = "file"): Promise<{ ok: true; url: string; name: string } | Fail> {
  const { data: r } = await db.from("analytics_story_renders").select("*").eq("id", renderId).maybeSingle();
  if (!r || r.survey_id !== surveyId) return fail(404, "Unknown export.");
  if (r.status !== "completed" || !r.path) return fail(409, "This export is not ready.");
  if (r.expires_at && String(r.expires_at) < new Date().toISOString()) return fail(410, "This export has expired. Make it again from the same version.");
  const { data: s } = await db.from("analytics_story_reports").select("title").eq("id", r.story_id).maybeSingle();
  const name = downloadName(String(s?.title ?? "report"), Number(r.version), what === "subtitles" ? "srt" : r.kind);
  const path = what === "subtitles" ? String(r.path).replace(/\.mp4$/, ".srt") : String(r.path);
  const url = await deps.store().signDownload(String(r.bucket), path, { seconds: 600, downloadAs: name, contentType: what === "subtitles" ? "application/x-subrip" : r.kind === "video" ? "video/mp4" : "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
  return { ok: true, url, name };
}

/** jobs the scheduler should advance: queued, or running with an expired lease */
export async function pendingRenders(db: Db, limit = 5): Promise<string[]> {
  const { data } = await db.from("analytics_story_renders").select("id, status, lease_until, created_at").in("status", ACTIVE).order("created_at", { ascending: true }).limit(50);
  const nowIso = new Date().toISOString();
  return ((data ?? []) as Record<string, any>[]).filter((r) => !r.lease_until || String(r.lease_until) < nowIso).slice(0, limit).map((r) => String(r.id));
}
