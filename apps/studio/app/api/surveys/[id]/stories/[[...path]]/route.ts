import { NextRequest, NextResponse } from "next/server";
import type { AuditEvent, Capability } from "@rescript/access";
import { checkStoryForPublish, storyPlayerHtml, type DesignConfig, type DesignPatch, type StoryOp, type BrandInput } from "@rescript/analytics/story";
import { supabaseService } from "@/lib/authServer";
import { audit, isFailure, requireProject, type ProjectContext } from "@/lib/guard";
import { downloadName } from "@/lib/storyCore";
import { assertNotReadOnly, getMeter, projectLookup } from "@/lib/metering";
import { loadDefinition } from "@/lib/analytics";
import { storyDeps } from "@/lib/storyService";
import {
  listStories, loadStory, storyPayload, createStory, saveDefinition, setReviewStatus, versionDefinition, compareVersions, revertTo,
  previewRevision, applyRevision, interpretDesign, applyDesign, analyzeBrand, saveTheme, listThemes, regenerate,
  startRender, stepRender, cancelRender, downloadLink, publishStory, newerDataFor, type Fail,
} from "@/lib/storyEngine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/* its own function on Vercel (routes with the same settings are bundled together, and this one carries the ffmpeg binary) */
export const maxDuration = 300;

/**
 * STORY REPORTS — animated research reports and their PowerPoint (Results → Reports → Create report).
 *
 *   GET    stories                               the survey's story reports
 *   POST   stories                               create one from the analysis plan and a fresh run   { title?, audience?, preset?, themeId?, outputs, environment?, dataset?, maxFindings?, exclude? }
 *   GET    stories/themes · POST stories/themes  saved designs (project or workspace)
 *   GET    stories/<id>                          the storyboard payload: definition, status, checks, timing, estimate, renders, versions
 *   PUT    stories/<id>                          save an edited definition as the next version   { definition, baseVersion, note? }
 *   DELETE stories/<id>
 *   POST   stories/<id>/status                   draft | ready_for_review | ready_to_render
 *   GET    stories/<id>/versions/<n>             one version's definition
 *   GET    stories/<id>/page                     the interactive page for this version, as one self-contained file to send or open offline (analytics.export; ?inline=1 shows it)
 *   GET    stories/<id>/compare?a=&b=            what changed between two versions
 *   POST   stories/<id>/revert                   { version } → a new version with that content
 *   POST   stories/<id>/revise                   { text, selected?, baseVersion } preview — or { apply: true, ops, text, baseVersion }
 *   POST   stories/<id>/design                   { text } preview — or { apply: true, patch | design, baseVersion }
 *   POST   stories/<id>/brand                    brand files (multipart) → colours, fonts, logo, six themes; nothing leaves this server
 *   POST   stories/<id>/regenerate               { sceneId? } from a fresh run; the person's edits survive
 *   POST   stories/<id>/publish                  { note? } freeze this version as the interactive page a share link opens (analytics.publish); answers the report to share, or the scenes that stop it
 *   POST   stories/<id>/renders                  { kind: video | pptx } start an export of the current version (one at a time)
 *   GET    stories/<id>/renders/<rid>            its status
 *   POST   stories/<id>/renders/<rid>/step       advance it (the panel calls this while open; the scheduler does too)
 *   POST   stories/<id>/renders/<rid>/cancel
 *   GET    stories/<id>/renders/<rid>/download   { url } a signed link, ten minutes (?what=subtitles for the SRT)
 *
 * Reading needs analytics.read, changing analytics.edit, exporting
 * analytics.export (and a workspace that is not read-only).
 */

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const bad = (msg: string, status = 400, details?: unknown) => json({ error: msg, ...(details !== undefined ? { details } : {}) }, status);
const failed = (f: Fail) => bad(f.error, f.status, f.details);
const isId = (s: string | undefined): s is string => !!s && /^[0-9a-f-]{36}$/i.test(s);

function log(ctx: ProjectContext, action: AuditEvent, entityId: string | null, detail: Record<string, unknown>) {
  void audit({ action, userId: ctx.user.userId, sessionId: ctx.user.sessionId, surveyId: ctx.surveyId, customerId: ctx.user.customerId, entity: "analytics", entityId, detail });
}
const gate = (req: NextRequest, surveyId: string, cap: Capability) => requireProject(req, surveyId, cap);

export async function GET(req: NextRequest, { params }: { params: { id: string; path?: string[] } }) {
  const ctx = await requireProject(req, params.id, "analytics.read"); if (isFailure(ctx)) return ctx.response;
  const [storyId, sub, a, b] = params.path ?? [];
  const db = supabaseService();
  const deps = storyDeps(db, { userId: ctx.user.userId, surveyId: params.id });
  if (!storyId) return json({ stories: await listStories(db, params.id) });
  if (storyId === "themes") return json({ themes: await listThemes(db, params.id, ctx.user.customerId ?? ctx.survey.customer_id ?? null) });
  if (!isId(storyId)) return bad("Unknown report.", 404);
  const row = await loadStory(db, params.id, storyId); if (!row) return bad("Unknown report.", 404);
  if (!sub) return json(await storyPayload(db, row, deps));
  if (sub === "page") {
    const g = await gate(req, params.id, "analytics.export"); if (isFailure(g)) return g.response;
    const blocked = await assertNotReadOnly(getMeter(), projectLookup(ctx), "export"); if (blocked) return blocked;
    const check = checkStoryForPublish(row.definition);
    if (!check.ok) return json({ error: `The page cannot be made yet: ${check.problems.map((p) => p.message).join(" ")}`, problems: check.problems }, 409);
    const html = storyPlayerHtml(row.definition, { newerData: await newerDataFor(db, row) });
    log(ctx, "analytics.export_generated", row.id, { name: row.title, format: "html", version: row.version });
    const inline = new URL(req.url).searchParams.get("inline") === "1";
    return new NextResponse(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", ...(inline ? {} : { "content-disposition": `attachment; filename="${downloadName(row.title, row.version, "html")}"` }) } });
  }
  if (sub === "versions" && a) { const d = await versionDefinition(db, row.id, Number(a)); return d ? json({ version: Number(a), definition: d }) : bad("Unknown version.", 404); }
  if (sub === "compare") { const u = new URL(req.url); const r = await compareVersions(db, row, Number(u.searchParams.get("a")), Number(u.searchParams.get("b"))); return "ok" in r && r.ok ? json(r) : failed(r as Fail); }
  if (sub === "renders" && isId(a) && !b) { const { data } = await db.from("analytics_story_renders").select("*").eq("id", a).eq("story_id", row.id).maybeSingle(); return data ? json({ render: { id: data.id, kind: data.kind, version: data.version, status: data.status, progress: data.progress, qa: data.qa, providers: data.providers, estimate: data.estimate, bytes: data.bytes, error: data.error, ready: data.status === "completed" } }) : bad("Unknown export.", 404); }
  if (sub === "renders" && isId(a) && b === "download") {
    const ex = await gate(req, params.id, "analytics.export"); if (isFailure(ex)) return ex.response;
    const what = new URL(req.url).searchParams.get("what") === "subtitles" ? "subtitles" : "file";
    const r = await downloadLink(db, params.id, a, deps, what);
    if (!r.ok) return failed(r);
    log(ctx, "analytics.report_downloaded", row.id, { name: row.title, file: r.name, renderId: a });
    return json(r);
  }
  return bad("Unknown request.", 404);
}

export async function POST(req: NextRequest, { params }: { params: { id: string; path?: string[] } }) {
  const ctx = await requireProject(req, params.id, "analytics.read"); if (isFailure(ctx)) return ctx.response;
  const [storyId, sub, renderId, action] = params.path ?? [];
  const db = supabaseService();
  const deps = storyDeps(db, { userId: ctx.user.userId, surveyId: params.id });
  const needs = async (cap: Capability) => { const g = await gate(req, params.id, cap); return isFailure(g) ? g.response : null; };

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  /* brand files: base64 in JSON, read here and never sent to an AI service */
  if (isId(storyId) && sub === "brand") {
    const denied = await needs("analytics.edit"); if (denied) return denied;
    const row = await loadStory(db, params.id, storyId); if (!row) return bad("Unknown report.", 404);
    const list = Array.isArray(body.files) ? (body.files as { name?: unknown; type?: unknown; data?: unknown }[]).slice(0, 8) : [];
    const files = list.filter((f) => typeof f.data === "string" && typeof f.name === "string").map((f) => ({ name: String(f.name).slice(0, 200), mimeType: typeof f.type === "string" && f.type ? f.type : "application/octet-stream", bytes: new Uint8Array(Buffer.from(String(f.data), "base64")) }));
    if (!files.length) return bad("No files were uploaded.");
    if (files.reduce((a, f) => a + f.bytes.length, 0) > 3.2 * 1024 * 1024) return bad("Brand files can be up to 3 MB at a time.", 413);
    return json(analyzeBrand(files, row.definition.design));
  }
  if (!storyId) {
    const denied = await needs("analytics.edit"); if (denied) return denied;
    const loaded = await loadDefinition(db, params.id); if ("error" in loaded) return bad(loaded.error, loaded.status);
    const r = await createStory(db, params.id, loaded, {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(body.audience === "executive" || body.audience === "researcher" || body.audience === "client" ? { audience: body.audience } : {}),
      ...(typeof body.preset === "string" ? { preset: body.preset as never } : {}),
      ...(isId(body.themeId as string) ? { themeId: body.themeId as string } : {}),
      outputs: { pptx: (body.outputs as { pptx?: boolean } | undefined)?.pptx !== false, video: (body.outputs as { video?: boolean } | undefined)?.video !== false },
      environment: body.environment === "TEST" || body.environment === "ALL" ? body.environment : "LIVE",
      dataset: body.dataset === "clean" ? "clean" : "all",
      ...(typeof body.maxFindings === "number" ? { maxFindings: body.maxFindings } : {}),
      ...(Array.isArray(body.exclude) ? { exclude: (body.exclude as unknown[]).filter((x): x is string => typeof x === "string") } : {}),
      userId: ctx.user.userId,
    }, deps);
    if (!r.ok) return failed(r);
    const row = await loadStory(db, params.id, r.id);
    log(ctx, "analytics.report_created", r.id, { name: row?.title, kind: "story", outputs: row?.outputs });
    return json(row ? await storyPayload(db, row, deps) : { id: r.id }, 201);
  }
  if (storyId === "themes") {
    const denied = await needs("analytics.edit"); if (denied) return denied;
    const r = await saveTheme(db, { name: String(body.name ?? ""), design: body.design as DesignConfig, brand: body.brand ?? {}, scope: body.scope === "workspace" ? "workspace" : "project", surveyId: params.id, customerId: ctx.user.customerId ?? ctx.survey.customer_id ?? null, userId: ctx.user.userId });
    return "ok" in r && r.ok ? json(r, 201) : failed(r as Fail);
  }
  if (!isId(storyId)) return bad("Unknown report.", 404);
  const row = await loadStory(db, params.id, storyId); if (!row) return bad("Unknown report.", 404);
  const baseVersion = typeof body.baseVersion === "number" ? body.baseVersion : row.version;
  const brand = (body.brand && typeof body.brand === "object" ? body.brand : null) as BrandInput | null;

  if (sub === "publish") {
    const denied = await needs("analytics.publish"); if (denied) return denied;
    const blocked = await assertNotReadOnly(getMeter(), projectLookup(ctx), "export"); if (blocked) return blocked;
    const r = await publishStory(db, row, { userId: ctx.user.userId, note: typeof body.note === "string" ? body.note.slice(0, 300) : null });
    if (!r.ok) return failed(r);
    log(ctx, "analytics.report_published", r.reportId, { name: row.title, kind: "story", version: r.version, storyVersion: row.version });
    return json({ reportId: r.reportId, version: r.version, publishedAt: r.publishedAt, warnings: r.warnings }, 201);
  }
  if (sub === "renders" && !renderId) {
    const denied = await needs("analytics.export"); if (denied) return denied;
    const blocked = await assertNotReadOnly(getMeter(), projectLookup(ctx), "export"); if (blocked) return blocked;
    const kind = body.kind === "pptx" ? "pptx" : body.kind === "video" ? "video" : null;
    if (!kind) return bad("Choose what to export: video or pptx.");
    const r = await startRender(db, row, { kind, userId: ctx.user.userId }, deps);
    if (!r.ok) return failed(r);
    log(ctx, "analytics.export_generated", row.id, { name: row.title, format: kind === "video" ? "mp4" : "pptx", version: row.version, renderId: r.render.id });
    /* a PowerPoint is made in this request; a video starts here and continues in steps */
    const advanced = r.render.status === "queued" ? await stepRender(db, r.render.id, deps, kind === "pptx" ? 50_000 : 25_000) : r;
    return json({ render: advanced.ok ? advanced.render : r.render }, 201);
  }
  if (sub === "renders" && isId(renderId) && action === "step") {
    const denied = await needs("analytics.export"); if (denied) return denied;
    const { data } = await db.from("analytics_story_renders").select("story_id").eq("id", renderId).maybeSingle();
    if (data?.story_id !== row.id) return bad("Unknown export.", 404);
    const r = await stepRender(db, renderId, deps, 40_000);
    return r.ok ? json({ render: r.render }) : failed(r);
  }
  if (sub === "renders" && isId(renderId) && action === "cancel") {
    const denied = await needs("analytics.export"); if (denied) return denied;
    const r = await cancelRender(db, params.id, renderId);
    return r.ok ? json({ ok: true }) : failed(r);
  }

  const denied = await needs("analytics.edit"); if (denied) return denied;
  if (sub === "status") {
    const s = body.status;
    if (s !== "draft" && s !== "ready_for_review" && s !== "ready_to_render") return bad("Unknown status.");
    const r = await setReviewStatus(db, row, s, deps);
    return r.ok ? json(await storyPayload(db, (await loadStory(db, params.id, row.id))!, deps)) : failed(r);
  }
  if (sub === "revert") {
    const r = await revertTo(db, row, Number(body.version), ctx.user.userId);
    if (!r.ok) return failed(r);
    log(ctx, "analytics.report_modified", row.id, { name: row.title, version: r.version, reverted: Number(body.version) });
    return json(await storyPayload(db, (await loadStory(db, params.id, row.id))!, deps));
  }
  if (sub === "revise") {
    const text = String(body.text ?? "").trim();
    if (body.apply !== true) { if (!text) return bad("Say what to change."); return json({ preview: previewRevision(row, text, typeof body.selected === "string" ? body.selected : null, brand), baseVersion: row.version }); }
    const r = await applyRevision(db, row, { ops: (body.ops ?? []) as StoryOp[], text, baseVersion, userId: ctx.user.userId, brand });
    if (!r.ok) return failed(r);
    log(ctx, "analytics.report_modified", row.id, { name: row.title, version: r.version, revision: text.slice(0, 200) });
    return json({ result: r, ...(await storyPayload(db, (await loadStory(db, params.id, row.id))!, deps)) });
  }
  if (sub === "design") {
    if (body.apply !== true) { const text = String(body.text ?? "").trim(); if (!text) return bad("Describe the look you want."); return json(await interpretDesign(row, text, deps, brand)); }
    const r = await applyDesign(db, row, { ...(body.patch ? { patch: body.patch as DesignPatch } : {}), ...(body.design ? { design: body.design as DesignConfig } : {}), baseVersion, note: String(body.note ?? "Design changed"), userId: ctx.user.userId, brand });
    if (!r.ok) return failed(r);
    log(ctx, "analytics.report_modified", row.id, { name: row.title, version: r.version, design: true });
    return json({ adjustments: r.adjustments, ...(await storyPayload(db, (await loadStory(db, params.id, row.id))!, deps)) });
  }
  if (sub === "regenerate") {
    const loaded = await loadDefinition(db, params.id); if ("error" in loaded) return bad(loaded.error, loaded.status);
    const r = await regenerate(db, row, loaded, deps, { sceneId: typeof body.sceneId === "string" ? body.sceneId : null, userId: ctx.user.userId });
    if (!r.ok) return failed(r);
    log(ctx, "analytics.report_modified", row.id, { name: row.title, version: r.version, regenerated: body.sceneId ?? "all" });
    return json(await storyPayload(db, (await loadStory(db, params.id, row.id))!, deps));
  }
  return bad("Unknown request.", 404);
}

export async function PUT(req: NextRequest, { params }: { params: { id: string; path?: string[] } }) {
  const ctx = await requireProject(req, params.id, "analytics.edit"); if (isFailure(ctx)) return ctx.response;
  const [storyId] = params.path ?? [];
  if (!isId(storyId)) return bad("Unknown report.", 404);
  const db = supabaseService();
  const deps = storyDeps(db, { userId: ctx.user.userId, surveyId: params.id });
  const row = await loadStory(db, params.id, storyId); if (!row) return bad("Unknown report.", 404);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const r = await saveDefinition(db, row, { definition: body.definition, baseVersion: Number(body.baseVersion), ...(typeof body.note === "string" ? { note: body.note } : {}), userId: ctx.user.userId });
  if (!r.ok) return failed(r);
  if (r.version !== row.version) log(ctx, "analytics.report_modified", row.id, { name: row.title, version: r.version, changes: r.changes });
  return json({ saved: r, ...(await storyPayload(db, (await loadStory(db, params.id, row.id))!, deps)) });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string; path?: string[] } }) {
  const ctx = await requireProject(req, params.id, "analytics.edit"); if (isFailure(ctx)) return ctx.response;
  const [storyId] = params.path ?? [];
  if (!isId(storyId)) return bad("Unknown report.", 404);
  const db = supabaseService();
  const row = await loadStory(db, params.id, storyId); if (!row) return bad("Unknown report.", 404);
  await db.from("analytics_story_renders").update({ status: "cancelled", lease_until: null }).eq("story_id", row.id).in("status", ["queued", "rendering", "verifying"]);
  await db.from("analytics_story_reports").update({ deleted_at: new Date().toISOString() }).eq("id", row.id);
  log(ctx, "analytics.report_modified", row.id, { name: row.title, deleted: true });
  return json({ ok: true });
}
