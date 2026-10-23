import { NextRequest } from "next/server";
import { checkCorrection, editSegmentExcerpts, type EditOutcome } from "@rescript/analytics";
import { isFailure, requireProject } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { qualGuardCapability } from "@/lib/qual/qualAccess";
import { codingState, correctedSegment, type StoredSegment } from "@/lib/qual/qualWorkspace";
import { checkRow, hasPii, json, loadWorkspace, recordEvents, refuse, saveCoding, storeFailure, transcriptRow, UUID } from "@/lib/qual/qualStore";
import { parseCorrection } from "@/lib/qual/synthesisWorkspace";
import { coderSets, listAssignments, saveCoderSet, SYNTHESIS_MIGRATION_MESSAGE, missingSynthesisMigration } from "@/lib/qual/synthesisStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * CORRECT A TRANSCRIPT SEGMENT, WITH HISTORY (2026-10-22). Data edit + contact details (a correction is made on
 * the text as recorded, never on a redacted copy).
 *
 *   POST { transcriptId, segmentId, text, revision }   the corrected words of one turn
 *   GET  ?transcriptId=…                               the transcript's revision and its corrections, newest first
 *
 * Every excerpt on the segment moves with the edit (`editSegmentExcerpts`): outside its span it shifts; inside it
 * is re-anchored to the corrected words (old quote kept, flagged for review); a deleted span invalidates it
 * (rejected, with the reason) — never a quote that is not the text. The same is done to the blind double-coding
 * sets. The transcript's `revision` is compare-and-set (409 on a stale one); if the excerpts cannot be saved the
 * transcript is put back, so the two never disagree. Each correction is a row in qual_transcript_revisions and an
 * entry in the history.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, qualGuardCapability("read"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "read");
  if (refused) return refused;
  const tid = req.nextUrl.searchParams.get("transcriptId") ?? "";
  if (!UUID.test(tid)) return json({ error: "which transcript (transcriptId)" }, 400);
  try {
    const r = await supabaseService().from("qual_transcript_revisions").select("revision, segment_id, before_text, after_text, outcomes, actor_label, created_at").eq("survey_id", params.id).eq("transcript_id", tid).order("revision", { ascending: false }).limit(200);
    if (r.error && missingSynthesisMigration(r.error.message)) return json({ error: SYNTHESIS_MIGRATION_MESSAGE, code: "migration_required" }, 503);
    const rows = checkRow(r, "revisions") as { revision: number; segment_id: string; before_text: string; after_text: string; outcomes: EditOutcome[]; actor_label: string | null; created_at: string }[];
    const pii = hasPii(gate);
    const cur = checkRow(await supabaseService().from("qual_transcripts").select("revision").eq("survey_id", params.id).eq("id", tid).maybeSingle(), "transcript") as { revision: number } | null;
    if (!cur) return json({ error: "no such transcript" }, 404);
    return json({ ok: true, revision: cur.revision ?? 0, revisions: (rows ?? []).map((x) => ({ revision: x.revision, segmentId: x.segment_id, ...(pii ? { before: x.before_text, after: x.after_text } : {}), outcomes: (x.outcomes ?? []).map((o) => ({ excerptId: o.excerptId, outcome: o.outcome })), actor: x.actor_label, at: x.created_at })) });
  } catch (e) { return storeFailure(e); }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, qualGuardCapability("manage"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "manage");
  if (refused) return refused;
  if (!hasPii(gate)) return json({ error: "Correcting a transcript needs the text as recorded, and your access shows it redacted (no contact details).", code: "insufficient_role" }, 403);
  const p = parseCorrection(await req.json().catch(() => null));
  if (!p.ok) return json({ error: p.error }, 400);
  const { transcriptId, segmentId, text, revision } = p.value;
  if (!UUID.test(transcriptId)) return json({ error: "no such transcript" }, 404);
  const db = supabaseService();
  try {
    const row = await transcriptRow(db, params.id, transcriptId);
    if (!row) return json({ error: "no such transcript" }, 404);
    const rev = await db.from("qual_transcripts").select("revision").eq("survey_id", params.id).eq("id", transcriptId).single();
    if (rev.error && missingSynthesisMigration(rev.error.message)) return json({ error: SYNTHESIS_MIGRATION_MESSAGE, code: "migration_required" }, 503);
    const current = Number((checkRow(rev, "transcript") as { revision: number }).revision ?? 0);
    if (current !== revision) return json({ error: "The transcript was corrected by someone else since you opened it — reload, then correct again.", code: "version_conflict", revision: current }, 409);
    const segs = (Array.isArray(row.segments) ? row.segments : []) as StoredSegment[];
    const at = segs.findIndex((s) => String(s.id) === segmentId);
    if (at < 0) return json({ error: "no such segment" }, 404);
    const before = String(segs[at].text ?? "");
    const bad = checkCorrection(before, text);
    if (bad) return json({ error: bad }, 400);
    /* word timings follow the correction (#17): kept words keep theirs, corrected ones are re-aligned (approximate) or flagged stale */
    const next = segs.map((s, i) => (i === at ? correctedSegment(s, text) : s));
    const nowIso = new Date().toISOString();
    /* 1. the transcript, compare-and-set on its revision */
    const up = checkRow(await db.from("qual_transcripts").update({ segments: next, revision: current + 1, char_count: next.reduce((n, s) => n + String(s.text ?? "").length, 0) }).eq("survey_id", params.id).eq("id", transcriptId).eq("revision", current).select("id"), "transcript") as unknown[];
    if (!up?.length) return json({ error: "The transcript changed at the same moment — reload, then correct again.", code: "version_conflict" }, 409);
    /* 2. the excerpts on that segment, moved with the edit (retried: a coder may be saving) */
    let outcomes: EditOutcome[] = [], summary = "", saved = false;
    for (let attempt = 0; attempt < 3 && !saved; attempt++) {
      const cur = codingState(checkRow(await db.from("qual_codings").select("codebook, excerpts, version").eq("survey_id", params.id).maybeSingle(), "coding") as never);
      const r = editSegmentExcerpts(cur.state.excerpts, transcriptId, segmentId, before, text, { now: nowIso, revision: current + 1 });
      outcomes = r.outcomes; summary = r.summary;
      if (!r.outcomes.length) { saved = true; break; }
      saved = (await saveCoding(db, params.id, { ...cur.state, excerpts: r.excerpts }, cur.version, gate.user.userId)) !== null;
    }
    if (!saved) {
      /* put the transcript back: the excerpts were not moved, so the old text is the one they match */
      await db.from("qual_transcripts").update({ segments: segs, revision: current + 2 }).eq("survey_id", params.id).eq("id", transcriptId).eq("revision", current + 1);
      return json({ error: "The coding changed while correcting — nothing was changed; try again.", code: "version_conflict" }, 409);
    }
    /* 3. the blind double-coding sets (each coder's private excerpts) */
    for (const a of await listAssignments(db, params.id).catch(() => [])) {
      for (const set of await coderSets(db, params.id, a.id)) {
        const r = editSegmentExcerpts(set.excerpts, transcriptId, segmentId, before, text, { now: nowIso, revision: current + 1 });
        if (r.outcomes.length) await saveCoderSet(db, params.id, a.id, { coder: set.coder, excerpts: r.excerpts }, set.version);
      }
    }
    checkRow(await db.from("qual_transcript_revisions").insert({ survey_id: params.id, transcript_id: transcriptId, revision: current + 1, segment_id: segmentId, before_text: before, after_text: text, outcomes, actor: gate.user.userId, actor_label: gate.user.fullName || gate.user.email || null }).select("id"), "revision");
    await recordEvents(db, gate, [{ actor: gate.user.userId, action: "transcript.corrected", detail: `Corrected ${segmentId} of “${row.title}” (revision ${current + 1}): ${summary}`, ids: [transcriptId, ...outcomes.filter((o) => o.outcome !== "unchanged").map((o) => o.excerptId)] }]);
    return json({ ok: true, revision: current + 1, outcomes, summary, workspace: await loadWorkspace(db, gate) });
  } catch (e) { return storeFailure(e); }
}
