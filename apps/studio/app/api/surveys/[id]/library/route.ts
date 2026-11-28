import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition as SurveyDefinitionSchema, normalizeAsParsed, type SurveyDefinition } from "@rescript/schema";
import { applyLibraryUpdate, droppedFieldPaths, ensureElementIds, insertFromLibrary, libraryItems, libraryStatus, sourceDiff, toSource } from "@rescript/engine";
import { customerDb } from "@/lib/db";
import { audit, isFailure, requireEditRight, requireProject } from "@/lib/guard";
import { loadDefinition } from "@/lib/analytics";
import { loadQualityDefinition } from "@/lib/qualityDef";

export const dynamic = "force-dynamic";

/**
 * REUSABLE LIBRARIES (Level 5 roadmap P5; the engine: packages/engine/src/library.ts).
 *
 * A library is another survey of the workspace; what is reused is its latest SAVED VERSION, never its draft, so a
 * library changes only when someone saves a version of it. The caller must be able to read the library survey.
 *
 *   POST { action: "items", library }                         what the library offers
 *   POST { action: "status" }                                 every link in this survey: up to date, update
 *                                                             available, changed here — with the impact
 *   POST { action: "insert", library, itemId, after?, into?, apply? }
 *   POST { action: "update", linkId, apply? }
 *        → without apply: what it would do (notes, the source diff and the resulting definition); nothing is written.
 *        → with apply and baseRevision: saved to the draft under the edit lock and the revision guard.
 *
 * `definition` (status, insert and update, without apply): the survey as it is in the caller's editor, unsaved edits
 * included, instead of the stored draft. The Studio's library screen sends it and applies the returned definition
 * through the editor (its undo, autosave and revision guard), so a preview never disagrees with what is on screen.
 * It is parsed like any other definition and nothing is written; `apply` always works on the stored draft.
 */
async function loadLibrary(req: NextRequest, id: string): Promise<{ def: SurveyDefinition; version: string; title: string } | { response: NextResponse }> {
  const gate = await requireProject(req, id, "project.read");
  if (isFailure(gate)) return { response: gate.response };
  const v = await loadQualityDefinition(customerDb(gate.survey.customer_id) as never, id, "version");
  if ("error" in v) return { response: NextResponse.json({ error: `The library has no saved version to use (${v.error}). Save a version of it first.` }, { status: 409 }) };
  return { def: v.def as SurveyDefinition, version: String(v.version ?? "1"), title: v.def.meta.title };
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const action = String(body?.action ?? "");
  if (action === "items") {
    const lib = await loadLibrary(req, String(body?.library ?? ""));
    if ("response" in lib) return lib.response;
    return NextResponse.json({ library: { id: body.library, title: lib.title, version: lib.version }, items: libraryItems(lib.def) });
  }
  const db = customerDb(gate.survey.customer_id);
  const loaded = await loadDefinition(db as never, params.id);
  if ("error" in loaded) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  let def = loaded.def as SurveyDefinition;
  if (body?.definition != null) {
    if (body?.apply === true) return NextResponse.json({ error: "apply saves the stored draft; to use the editor's survey, preview with it and apply the returned definition in the editor." }, { status: 400 });
    const given = SurveyDefinitionSchema.safeParse(body.definition);
    if (!given.success) return NextResponse.json({ error: `The survey sent is not valid: ${given.error.issues[0]?.path.join(".")} ${given.error.issues[0]?.message}` }, { status: 400 });
    def = given.data;
  }
  if (action === "status") {
    const libraries: Record<string, { def: SurveyDefinition; version: string }> = {};
    for (const id of new Set((def.libraryLinks ?? []).map((l) => l.library.surveyId).filter((x): x is string => !!x))) { const lib = await loadLibrary(req, id); if (!("response" in lib)) libraries[id] = lib; }
    return NextResponse.json({ links: libraryStatus(def, libraries) });
  }
  let result: ReturnType<typeof insertFromLibrary>;
  if (action === "insert") {
    const lib = await loadLibrary(req, String(body?.library ?? ""));
    if ("response" in lib) return lib.response;
    result = insertFromLibrary(def, lib.def, String(body?.itemId ?? ""), { library: { surveyId: String(body.library), title: lib.title }, version: lib.version, after: typeof body?.after === "string" ? body.after : undefined, into: typeof body?.into === "string" ? body.into : undefined, now: new Date().toISOString() });
  } else if (action === "update") {
    const link = (def.libraryLinks ?? []).find((l) => l.id === body?.linkId);
    if (!link?.library.surveyId) return NextResponse.json({ error: "No such library link." }, { status: 404 });
    const lib = await loadLibrary(req, link.library.surveyId);
    if ("response" in lib) return lib.response;
    result = applyLibraryUpdate(def, link.id, lib.def, lib.version);
  } else return NextResponse.json({ error: "action must be items, status, insert or update" }, { status: 400 });
  if ("error" in result) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  const view = { ok: true, notes: result.notes, diff: sourceDiff(toSource(def), toSource(result.def)) };
  if (body?.apply !== true) return NextResponse.json({ ...view, mode: "preview", definition: result.def, link: result.link });

  const edit = await requireEditRight(req, params.id, "survey.edit" as never);
  if (isFailure(edit)) return edit.response;
  const parsed = SurveyDefinitionSchema.safeParse(result.def);
  if (!parsed.success || droppedFieldPaths(normalizeAsParsed(result.def), parsed.data).length) return NextResponse.json({ ...view, ok: false, error: "The result failed the schema check; nothing was saved." }, { status: 422 });
  const definition = ensureElementIds(parsed.data).def;
  const baseRevision = typeof body?.baseRevision === "number" ? body.baseRevision : loaded.revision;
  if (baseRevision == null) return NextResponse.json({ error: "This database has no revision guard (migration 0004); the library cannot save safely." }, { status: 501 });
  const { data, error } = await db.rpc("rescript_save_draft", { p_survey_id: params.id, p_definition: definition, p_base_revision: baseRevision, p_base_version_id: loaded.source === "version" ? loaded.versionId ?? null : null, p_title: definition.meta.title });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) return NextResponse.json({ ...view, ok: false, conflict: !error, error: error ? error.message : "The survey was changed since it was read; nothing was saved." }, { status: error ? 500 : 409 });
  await audit({ action: "library.applied", userId: gate.user.userId, sessionId: gate.user.sessionId, surveyId: params.id, customerId: gate.user.customerId, entity: "survey", entityId: params.id, detail: { action, link: result.link.id, itemId: result.link.itemId, version: result.link.version } });
  return NextResponse.json({ ...view, mode: "applied", revision: Number(row.revision) });
}
