import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ObserverNoteInput } from "@rescript/engine";

/**
 * Q5 — THE OBSERVER ROOM'S NOTES (migration 0115): read and written by the Studio through the service role after the
 * route's access check; the runtime marks a question asked or refused when the moderator reaches it.
 */
export const MISSING_0115 = "The observer room needs migration 0115 (ai_interview_observer_notes), which has not been applied to this database.";
export const isMissing0115 = (m: string) => /ai_interview_observer_notes|does not exist|schema cache/i.test(m);

export interface ObserverNoteView {
  id: string; kind: "chat" | "marker" | "question"; body: string; turnSeq: number | null; offsetMs: number | null;
  status: "queued" | "asked" | "refused" | "withdrawn" | null; askedSeq: number | null; refusedReason: string | null; authorLabel: string | null; createdAt: string;
}

const view = (r: Record<string, unknown>): ObserverNoteView => ({
  id: String(r.id), kind: r.kind as ObserverNoteView["kind"], body: String(r.body), turnSeq: r.turn_seq == null ? null : Number(r.turn_seq), offsetMs: r.offset_ms == null ? null : Number(r.offset_ms),
  status: (r.status as ObserverNoteView["status"]) ?? null, askedSeq: r.asked_seq == null ? null : Number(r.asked_seq), refusedReason: (r.refused_reason as string | null) ?? null, authorLabel: (r.author_label as string | null) ?? null, createdAt: String(r.created_at),
});

export async function observerNotes(db: SupabaseClient, surveyId: string, sessionId: string): Promise<ObserverNoteView[]> {
  const { data, error } = await db.from("ai_interview_observer_notes").select("id, kind, body, turn_seq, offset_ms, status, asked_seq, refused_reason, author_label, created_at").eq("survey_id", surveyId).eq("session_id", sessionId).order("created_at", { ascending: true }).limit(500);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map(view);
}

/** add a note to an interview of THIS project; a question for a finished interview is recorded as refused */
export async function addObserverNote(db: SupabaseClient, surveyId: string, sessionId: string, n: ObserverNoteInput, by: { userId: string; label: string }): Promise<{ ok: true } | { error: string; status: number }> {
  const { data: s, error } = await db.from("ai_interview_sessions").select("id, study_id, status, started_at, state").eq("survey_id", surveyId).eq("id", sessionId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!s) return { error: "no such interview", status: 404 };
  const row = s as { study_id: string; status: string; started_at: string; state: { seq?: number } | null };
  const live = row.status === "in_progress";
  const ins = await db.from("ai_interview_observer_notes").insert({
    survey_id: surveyId, study_id: row.study_id, session_id: sessionId, kind: n.kind, body: n.text,
    turn_seq: n.turnSeq ?? row.state?.seq ?? null, offset_ms: Math.max(0, Date.now() - Date.parse(row.started_at)) || null,
    ...(n.kind === "question" ? (live ? { status: "queued" } : { status: "refused", refused_reason: "the interview has finished" }) : {}),
    author_id: by.userId, author_label: by.label,
  });
  if (ins.error) throw new Error(ins.error.message);
  return { ok: true };
}

export async function withdrawObserverQuestion(db: SupabaseClient, surveyId: string, sessionId: string, noteId: string): Promise<void> {
  const { error } = await db.from("ai_interview_observer_notes").update({ status: "withdrawn", updated_at: new Date().toISOString() }).eq("survey_id", surveyId).eq("session_id", sessionId).eq("id", noteId).eq("kind", "question").eq("status", "queued");
  if (error) throw new Error(error.message);
}
