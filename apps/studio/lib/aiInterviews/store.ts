import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { qualRowsForInterview, transcriptForQual, buildModeratorPlan, type InterviewTurnRecord, type ModeratorFlag } from "@rescript/engine";
import type { QualStudy } from "@rescript/schema";
import type { SessionRow, StudyRow, TurnRow } from "./view";

/**
 * THE AI-INTERVIEW TABLES (migration 0069) for the Studio's routes — service role, behind the
 * route's guard. The respondent's side writes through the runtime; the researcher's side here reads
 * the live view and transcripts, launches / pauses / closes a study, ends an interview (writing what
 * was said to the qualitative tables) and excludes one.
 */

export const MIGRATION_MESSAGE = "AI-moderated interviews need database migration 0069. Ask an administrator to apply it; the guide and its AI settings still work.";
export const missing0069 = (m: string | undefined) => /ai_interview_|rescript_ai_interview/i.test(m ?? "") && /does not exist|schema cache|could not find/i.test(m ?? "");
export class AiInterviewStoreError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status = 500, code?: string) { super(message); this.status = status; this.code = code; }
}
const check = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
  if (r.error) { if (missing0069(r.error.message)) throw new AiInterviewStoreError(MIGRATION_MESSAGE, 503, "migration_required"); throw new AiInterviewStoreError(`${what}: ${r.error.message}`); }
  return r.data as T;
};

const STUDY = "id, survey_id, title, status, link_token, test_token, guide, guide_language, spent_usd, launched_at, closed_at";
const SESSION = "id, status, mode, language, excluded, exclusion_reason, is_test, flags, state, turns_count, cost_usd, started_at, last_activity_at, completed_at, qual_transcript_id, ai_interview_participants(number, segment)";

/** the open study (live or paused), else the latest closed one */
export async function currentStudy(db: SupabaseClient, surveyId: string): Promise<StudyRow | null> {
  const rows = check(await db.from("ai_interview_studies").select(STUDY).eq("survey_id", surveyId).order("launched_at", { ascending: false }).limit(5), "studies") as StudyRow[];
  return rows.find((r) => r.status !== "closed") ?? rows[0] ?? null;
}

export async function sessionsOf(db: SupabaseClient, studyId: string): Promise<SessionRow[]> {
  /* idle 30 minutes = abandoned (the runtime's admission sweeps too; the live view should not wait for the next participant) */
  await db.from("ai_interview_sessions").update({ status: "abandoned", completed_at: new Date().toISOString() }).eq("study_id", studyId).eq("status", "in_progress").lt("last_activity_at", new Date(Date.now() - 30 * 60_000).toISOString());
  return check(await db.from("ai_interview_sessions").select(SESSION).eq("study_id", studyId).order("started_at", { ascending: false }).limit(1000), "interviews") as SessionRow[];
}

export async function turnsOf(db: SupabaseClient, surveyId: string, sessionId: string): Promise<TurnRow[]> {
  return check(await db.from("ai_interview_turns").select("seq, speaker, text, original_text, translation, language, offset_ms, duration_ms, decision, audio_media_id, video_media_id").eq("survey_id", surveyId).eq("session_id", sessionId).order("seq", { ascending: true }).limit(1000), "turns") as TurnRow[];
}

export async function launch(db: SupabaseClient, surveyId: string, row: Record<string, unknown>, quotas: { segment: string; target: number }[], opts: { replace: boolean }): Promise<StudyRow> {
  const open = check(await db.from("ai_interview_studies").select("id").eq("survey_id", surveyId).in("status", ["live", "paused"]), "studies") as { id: string }[];
  if (open.length && !opts.replace) throw new AiInterviewStoreError("This project already has AI interviews running. Close them first, or relaunch with the current guide (the running study is closed; its interviews are kept).", 409, "already_open");
  if (open.length) check(await db.from("ai_interview_studies").update({ status: "closed", closed_at: new Date().toISOString() }).in("id", open.map((o) => o.id)).select("id"), "close");
  const st = check(await db.from("ai_interview_studies").insert({ ...row, survey_id: surveyId }).select(STUDY).single(), "launch") as StudyRow;
  if (quotas.length) check(await db.from("ai_interview_quotas").insert(quotas.map((q) => ({ study_id: st.id, ...q }))).select("study_id"), "quotas");
  return st;
}

export async function setStudyStatus(db: SupabaseClient, surveyId: string, studyId: string, status: "live" | "paused" | "closed"): Promise<boolean> {
  const rows = check(await db.from("ai_interview_studies").update({ status, ...(status === "closed" ? { closed_at: new Date().toISOString() } : {}) }).eq("survey_id", surveyId).eq("id", studyId).neq("status", "closed").select("id"), "study") as { id: string }[];
  return rows.length > 0;
}

interface FullSession { id: string; study_id: string; survey_id: string; status: string; mode: string; language: string | null; is_test: boolean; excluded: boolean; state: { flags?: ModeratorFlag[]; covered?: string[]; answers?: number } | null; started_at: string; version: number; qual_transcript_id: string | null; ai_interview_participants: { number: number; segment: string | null; consent: { recording?: boolean; at?: string } } | { number: number; segment: string | null; consent: { recording?: boolean; at?: string } }[] | null }
async function fullSession(db: SupabaseClient, surveyId: string, id: string): Promise<FullSession | null> {
  return check(await db.from("ai_interview_sessions").select("id, study_id, survey_id, status, mode, language, is_test, excluded, state, started_at, version, qual_transcript_id, ai_interview_participants(number, segment, consent)").eq("survey_id", surveyId).eq("id", id).maybeSingle(), "interview") as FullSession | null;
}

/** write what was said to the qualitative tables (idempotent); null when there is nothing to write */
async function writeQual(db: SupabaseClient, s: FullSession, study: StudyRow, endedBy: "participant" | "researcher"): Promise<string | null> {
  if (s.qual_transcript_id || s.is_test) return s.qual_transcript_id;
  const turns = await turnsOf(db, s.survey_id, s.id);
  if (!turns.some((t) => t.speaker === "participant")) return null;
  const p = Array.isArray(s.ai_interview_participants) ? s.ai_interview_participants[0] : s.ai_interview_participants;
  const guide = study.guide as QualStudy;
  const plan = buildModeratorPlan(guide, { guideLanguage: study.guide_language, title: study.title });
  const label = `P${p?.number ?? "?"}`;
  const records: InterviewTurnRecord[] = turns.map((t) => ({ seq: t.seq, speaker: t.speaker, text: t.text, originalText: t.original_text, translation: t.translation, language: t.language, audioMediaId: t.audio_media_id, videoMediaId: t.video_media_id, offsetMs: t.offset_ms, durationMs: t.duration_ms }));
  const transcript = transcriptForQual(records, { studyId: study.id, interviewId: s.id, title: `AI interview — ${label}${p?.segment ? ` (${p.segment})` : ""}`, participantLabel: label, segment: p?.segment ?? null, mode: s.mode, language: s.language, moderatorName: plan.persona.name, flags: s.state?.flags ?? [], covered: s.state?.covered ?? [] });
  const rows = qualRowsForInterview(transcript, { surveyId: s.survey_id, participantNumber: p?.number ?? 0, segment: p?.segment ?? null, startedAt: s.started_at, recording: !!p?.consent?.recording, consentAt: p?.consent?.at, mode: s.mode, language: s.language ?? "", flags: s.state?.flags ?? [], endedBy });
  const qs = check(await db.from("qual_sessions").insert(rows.session).select("id").single(), "qual session") as { id: string };
  let qt = await db.from("qual_transcripts").insert({ ...rows.transcript, session_id: qs.id }).select("id").single();
  if (qt.error && /check constraint|violates check/i.test(qt.error.message)) qt = await db.from("qual_transcripts").insert({ ...rows.transcript, source: "import", format: "speaker", session_id: qs.id }).select("id").single();
  const t = check(qt, "qual transcript") as { id: string };
  await db.from("ai_interview_sessions").update({ qual_session_id: qs.id, qual_transcript_id: t.id }).eq("id", s.id);
  await db.from("qual_events").insert({ survey_id: s.survey_id, actor: null, actor_label: "AI moderator", ...rows.event, ids: [t.id] });
  return t.id;
}

export async function endInterview(db: SupabaseClient, surveyId: string, id: string, userId: string): Promise<{ ended: boolean; transcriptId: string | null }> {
  const s = await fullSession(db, surveyId, id);
  if (!s) throw new AiInterviewStoreError("no such interview", 404);
  if (s.status !== "in_progress") throw new AiInterviewStoreError("that interview is not in progress", 409, "not_in_progress");
  const rows = check(await db.from("ai_interview_sessions").update({ status: "ended", ended_by: userId, completed_at: new Date().toISOString(), version: s.version + 1 }).eq("id", id).eq("version", s.version).eq("status", "in_progress").select("id"), "end") as { id: string }[];
  if (!rows.length) throw new AiInterviewStoreError("the interview moved on — reload and try again", 409, "version_conflict");
  const study = check(await db.from("ai_interview_studies").select(STUDY).eq("id", s.study_id).single(), "study") as StudyRow;
  const transcriptId = await writeQual(db, { ...s, status: "ended" }, study, "researcher");
  return { ended: true, transcriptId };
}

/** exclude: kept for the record, never a complete; its transcript leaves the coding workspace unless excerpts already cite it */
export async function excludeInterview(db: SupabaseClient, surveyId: string, id: string, excluded: boolean, reason: string | undefined, citing: (transcriptId: string) => Promise<number>): Promise<{ transcriptKept: boolean; citations: number }> {
  const s = await fullSession(db, surveyId, id);
  if (!s) throw new AiInterviewStoreError("no such interview", 404);
  check(await db.from("ai_interview_sessions").update({ excluded, exclusion_reason: excluded ? reason ?? null : null }).eq("id", id).select("id"), "exclude");
  if (excluded && s.qual_transcript_id) {
    const n = await citing(s.qual_transcript_id);
    if (n) return { transcriptKept: true, citations: n };
    check(await db.from("qual_transcripts").delete().eq("id", s.qual_transcript_id).select("id"), "transcript");
    await db.from("ai_interview_sessions").update({ qual_transcript_id: null }).eq("id", id);
    return { transcriptKept: false, citations: 0 };
  }
  if (!excluded && !s.qual_transcript_id && (s.status === "completed" || s.status === "ended" || s.status === "flagged")) {
    const study = check(await db.from("ai_interview_studies").select(STUDY).eq("id", s.study_id).single(), "study") as StudyRow;
    await writeQual(db, s, study, s.status === "ended" ? "researcher" : "participant");
  }
  return { transcriptKept: !!s.qual_transcript_id, citations: 0 };
}
