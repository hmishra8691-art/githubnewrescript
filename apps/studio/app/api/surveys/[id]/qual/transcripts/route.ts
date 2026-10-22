import { NextRequest } from "next/server";
import { measurementOf } from "@rescript/engine";
import { readDocxText } from "@rescript/analytics/export";
import { isFailure, requireProject } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { loadDefinition } from "@/lib/analytics";
import { qualGuardCapability } from "@/lib/qual/qualAccess";
import { codingState, importTranscript, openEndsTranscript, parseSpeakerEdit, sessionView, speakerMap, type TranscriptFields } from "@/lib/qual/qualWorkspace";
import { checkRow, json, loadWorkspace, recordEvents, refuse, saveCoding, sessionRow, storeFailure, transcriptRow, UUID } from "@/lib/qual/qualStore";
import { enqueueAutoCode } from "@/lib/qual/autoCode";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * TRANSCRIPTS AND OTHER SOURCES (2026-10-18). Data edit (`responses.manage`).
 *
 *   POST multipart  file (.txt, .vtt, .srt, .docx — up to 10 MB), title?, sessionId?, format?
 *   POST json       { text, title?, fileName?, format?, sessionId? }        a pasted transcript
 *   POST json       { source: "open_ends", questionIds, title?, environment? }  open-ended answers, snapshotted
 *   PATCH json      { id, title?, sessionId?, speakers? }                    the speaker map: role, group
 *   DELETE ?id=…    the source, and every excerpt coded from it
 *
 * Speaker ids and timestamps are kept exactly as the file has them; the
 * moderator is suggested from the label and the group from the session's
 * participants, both editable. Transcribing a recording is `recordings/transcribe`.
 */
const MAX_FILE = 10 * 1024 * 1024;

async function insert(db: ReturnType<typeof supabaseService>, surveyId: string, userId: string, t: TranscriptFields): Promise<string> {
  const row = checkRow(await db.from("qual_transcripts").insert({ survey_id: surveyId, session_id: t.session_id ?? null, title: t.title, source: t.source, format: t.format, language: t.language ?? null, segments: t.segments, speakers: t.speakers, char_count: t.char_count, meta: t.meta, status: "ready", created_by: userId }).select("id").single(), "transcript") as { id: string };
  return row.id;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, qualGuardCapability("manage"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "manage");
  if (refused) return refused;
  const db = supabaseService();
  try {
    let input: { text: string; title?: string; fileName?: string; format?: string; fromDocx?: boolean; sessionId?: string | null };
    if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      const form = await req.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof Blob) || !file.size) return json({ error: "choose a transcript file (.txt, .vtt, .srt or .docx)" }, 400);
      if (file.size > MAX_FILE) return json({ error: `that file is ${Math.round(file.size / 1024 / 1024)} MB — transcripts up to 10 MB are imported` }, 413);
      const fileName = (file as File).name ?? "transcript.txt";
      const bytes = Buffer.from(await file.arrayBuffer());
      const isDocx = /\.docx$/i.test(fileName) || (bytes[0] === 0x50 && bytes[1] === 0x4b);
      let text: string;
      try { text = isDocx ? readDocxText(bytes) : bytes.toString("utf8"); } catch (e) { return json({ error: `that Word file could not be read: ${(e as Error).message}` }, 400); }
      input = { text, fileName, fromDocx: isDocx, title: String(form?.get("title") ?? "") || undefined, format: String(form?.get("format") ?? "") || undefined, sessionId: String(form?.get("sessionId") ?? "") || null };
    } else {
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body) return json({ error: "expected a transcript (multipart file or JSON text)" }, 400);
      if (body.source === "open_ends") {
        const loaded = await loadDefinition(db, params.id);
        if ("error" in loaded) return json({ error: loaded.error }, loaded.status);
        const ids = Array.isArray(body.questionIds) ? body.questionIds.map(String) : [];
        const questions = loaded.def.questions.filter((q) => (ids.includes(q.id) || ids.includes(String(q.code))) && measurementOf(q) === "text");
        if (questions.length !== ids.length || !ids.length) return json({ error: "choose open-ended (text) questions of this survey" }, 400);
        const test = body.environment === "TEST";
        const rows = checkRow(await db.from("responses").select("id, answers").eq("survey_id", params.id).is("deleted_at", null).eq("status", "complete").eq("is_test", test).order("started_at", { ascending: true }).limit(5000), "responses") as { id: string; answers: unknown }[];
        const t = openEndsTranscript(rows ?? [], questions.map((q) => ({ id: q.id, code: String(q.code) })), typeof body.title === "string" ? body.title : undefined);
        if (!t.ok) return json({ error: t.error }, 400);
        t.value.meta.environment = test ? "TEST" : "LIVE";
        const id = await insert(db, params.id, gate.user.userId, t.value);
        /* F2 2026-10-22: the study may code new sources automatically — queued here, coded by the jobs route (no model call now) */
        await enqueueAutoCode(db, params.id, id, gate.user.userId).catch(() => null);
        await recordEvents(db, gate, [{ actor: gate.user.userId, action: "source.open_ends", detail: `Added ${t.value.segments.length} open-ended answers (${questions.map((q) => q.code).join(", ")}, ${test ? "test" : "live"} completes) as a source`, ids: [id] }]);
        return json({ ok: true, id, warnings: t.value.meta.warnings, workspace: await loadWorkspace(db, gate) });
      }
      input = { text: String(body.text ?? ""), title: typeof body.title === "string" ? body.title : undefined, fileName: typeof body.fileName === "string" ? body.fileName : undefined, format: typeof body.format === "string" ? body.format : undefined, sessionId: typeof body.sessionId === "string" && body.sessionId ? body.sessionId : null };
    }
    let participants: ReturnType<typeof sessionView>["participants"] = [];
    if (input.sessionId) {
      if (!UUID.test(input.sessionId)) return json({ error: "no such session" }, 404);
      const s = await sessionRow(db, params.id, input.sessionId);
      if (!s) return json({ error: "no such session" }, 404);
      participants = sessionView(s).participants;
    }
    const t = importTranscript({ ...input, participants });
    if (!t.ok) return json({ error: t.error }, 400);
    const id = await insert(db, params.id, gate.user.userId, t.value);
    await enqueueAutoCode(db, params.id, id, gate.user.userId).catch(() => null);
    await recordEvents(db, gate, [{ actor: gate.user.userId, action: "transcript.imported", detail: `Imported “${t.value.title}” (${t.value.format}, ${t.value.segments.length} turns, ${Object.keys(t.value.speakers).length} speakers)`, ids: [id] }]);
    return json({ ok: true, id, warnings: t.value.meta.warnings, workspace: await loadWorkspace(db, gate) });
  } catch (e) { return storeFailure(e); }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, qualGuardCapability("manage"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "manage");
  if (refused) return refused;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const id = String(body?.id ?? "");
  if (!UUID.test(id)) return json({ error: "which transcript (id)" }, 400);
  try {
    const db = supabaseService();
    const row = await transcriptRow(db, params.id, id);
    if (!row) return json({ error: "no such transcript" }, 404);
    const patch: Record<string, unknown> = {};
    if (typeof body!.title === "string" && body!.title.trim()) patch.title = body!.title.trim().slice(0, 200);
    if (body!.sessionId !== undefined) { const sid = body!.sessionId ? String(body!.sessionId) : null; if (sid && !(UUID.test(sid) && await sessionRow(db, params.id, sid))) return json({ error: "no such session" }, 404); patch.session_id = sid; }
    if (body!.speakers !== undefined) { const e = parseSpeakerEdit(body!.speakers, speakerMap(row)); if (!e.ok) return json({ error: e.error }, 400); patch.speakers = e.value; }
    if (!Object.keys(patch).length) return json({ error: "nothing to change" }, 400);
    checkRow(await db.from("qual_transcripts").update(patch).eq("survey_id", params.id).eq("id", id).select("id"), "transcript");
    await recordEvents(db, gate, [{ actor: gate.user.userId, action: "transcript.updated", detail: `Updated “${row.title}” (${Object.keys(patch).map((k) => (k === "session_id" ? "session" : k)).join(", ")})`, ids: [id] }]);
    return json({ ok: true, workspace: await loadWorkspace(db, gate) });
  } catch (e) { return storeFailure(e); }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, qualGuardCapability("manage"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "manage");
  if (refused) return refused;
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!UUID.test(id)) return json({ error: "which transcript (id)" }, 400);
  try {
    const db = supabaseService();
    const row = await transcriptRow(db, params.id, id);
    if (!row) return json({ error: "no such transcript" }, 404);
    /* the excerpts coded from it go with it — an evidence link to nothing is not evidence (two tries: another coder may be saving) */
    let removed = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = codingState(checkRow(await db.from("qual_codings").select("codebook, excerpts, version").eq("survey_id", params.id).maybeSingle(), "coding") as never);
      const keep = cur.state.excerpts.filter((e) => e.sourceId !== id);
      removed = cur.state.excerpts.length - keep.length;
      if (!removed) break;
      const v = await saveCoding(db, params.id, { ...cur.state, excerpts: keep }, cur.version, gate.user.userId);
      if (v !== null) break;
      if (attempt === 1) return json({ error: "the codebook changed while deleting — try again", code: "version_conflict" }, 409);
    }
    checkRow(await db.from("qual_transcripts").delete().eq("survey_id", params.id).eq("id", id).select("id"), "transcript");
    await recordEvents(db, gate, [{ actor: gate.user.userId, action: "transcript.deleted", detail: `Deleted “${row.title}”${removed ? ` and the ${removed} excerpt${removed === 1 ? "" : "s"} coded from it` : ""}`, ids: [id] }]);
    return json({ ok: true, workspace: await loadWorkspace(db, gate) });
  } catch (e) { return storeFailure(e); }
}
