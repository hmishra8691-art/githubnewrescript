import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { QualStudy } from "@rescript/schema";
import { qualRowsForInterview, type InterviewTurnRecord, type ModeratorState } from "@rescript/engine";
import type { AiInterviewStore, SessionRec, StudyRec } from "./types";

/**
 * THE AI-INTERVIEW TABLES (migration 0069), read and written with the service role behind the
 * respondent's own token checks (`service.ts`). Admission and each exchange go through the two
 * functions that make them atomic; on completion the transcript is written to the qualitative
 * tables (0065) so the existing coding, quotes, kappa and reports read it unchanged.
 */

const STUDY = "id, survey_id, title, status, link_token, test_token, guide, guide_language, spent_usd, surveys(customer_id)";
const SESSION = "id, study_id, survey_id, participant_id, mode, language, status, excluded, is_test, state, flags, turns_count, cost_usd, version, started_at, ai_interview_participants(number, segment, external_ref, consent)";

type Row = Record<string, unknown>;
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
const fail = (what: string, e: { message: string } | null) => { if (e) throw new Error(`${what}: ${e.message}`); };

function study(r: Row | null): StudyRec | null {
  if (!r) return null;
  const s = one(r.surveys as Row | Row[] | null);
  return { id: String(r.id), surveyId: String(r.survey_id), customerId: (s?.customer_id as string | undefined) ?? null, title: String(r.title), status: r.status as StudyRec["status"], linkToken: String(r.link_token), testToken: String(r.test_token), guide: r.guide as QualStudy, guideLanguage: String(r.guide_language ?? "en"), spentUsd: Number(r.spent_usd ?? 0) };
}
function session(r: Row | null): SessionRec | null {
  if (!r) return null;
  const p = one(r.ai_interview_participants as Row | Row[] | null) ?? {};
  return {
    id: String(r.id), studyId: String(r.study_id), surveyId: String(r.survey_id), participantId: String(r.participant_id), participantNumber: Number(p.number ?? 0), segment: (p.segment as string | null) ?? null,
    mode: r.mode as SessionRec["mode"], language: String(r.language ?? "en"), status: r.status as SessionRec["status"], excluded: !!r.excluded, isTest: !!r.is_test,
    state: (r.state ?? {}) as ModeratorState, flags: Array.isArray(r.flags) ? (r.flags as SessionRec["flags"]) : [], turnsCount: Number(r.turns_count ?? 0), costUsd: Number(r.cost_usd ?? 0), version: Number(r.version ?? 0),
    startedAt: Date.parse(String(r.started_at)), externalRef: (p.external_ref as string | null) ?? null, consent: (p.consent ?? {}) as SessionRec["consent"],
  };
}
const turnOf = (r: Row): InterviewTurnRecord => ({
  seq: Number(r.seq), speaker: r.speaker as InterviewTurnRecord["speaker"], text: String(r.text ?? ""), originalText: (r.original_text as string | null) ?? null, language: (r.language as string | null) ?? null,
  translation: (r.translation as string | null) ?? null, audioMediaId: (r.audio_media_id as string | null) ?? null, videoMediaId: (r.video_media_id as string | null) ?? null,
  decision: (r.decision as InterviewTurnRecord["decision"]) ?? null, offsetMs: Number(r.offset_ms ?? 0), durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
});

export function supabaseStore(db: SupabaseClient): AiInterviewStore {
  return {
    kind: "supabase",
    async studyByLink(token) {
      if (!/^[0-9a-f]{36}$/.test(token)) return null;
      const r = await db.from("ai_interview_studies").select(STUDY).eq("link_token", token).maybeSingle();
      fail("study", r.error);
      return study(r.data as Row | null);
    },
    async studyById(id) {
      const r = await db.from("ai_interview_studies").select(STUDY).eq("id", id).maybeSingle();
      fail("study", r.error);
      return study(r.data as Row | null);
    },
    async begin(a) {
      const r = await db.rpc("rescript_ai_interview_begin", {
        p_study: a.study.id, p_segment: a.segment, p_is_test: a.isTest, p_screener: a.screener, p_consent: a.consent, p_language: a.language,
        p_external_ref: a.externalRef, p_mode: a.mode, p_token_hash: a.tokenHash, p_state: a.state, p_flags: a.flags, p_screened_out: !!a.screenedOut,
      });
      fail("begin", r.error);
      const row = one(r.data as Row | Row[] | null);
      if (!row?.admitted) return { admitted: false, reason: String(row?.reason ?? "refused") };
      return { admitted: true, sessionId: String(row.session_id), participantId: String(row.participant_id), number: Number(row.participant_number) };
    },
    async sessionByHash(hash) {
      const r = await db.from("ai_interview_sessions").select(SESSION).eq("token_hash", hash).maybeSingle();
      fail("session", r.error);
      return session(r.data as Row | null);
    },
    async turns(sessionId) {
      const r = await db.from("ai_interview_turns").select("seq, speaker, text, original_text, language, translation, audio_media_id, video_media_id, decision, offset_ms, duration_ms").eq("session_id", sessionId).order("seq", { ascending: true }).limit(1000);
      fail("turns", r.error);
      return ((r.data ?? []) as Row[]).map(turnOf);
    },
    async recordTurn(a) {
      const turns = a.turns.map((t) => ({ seq: t.seq, speaker: t.speaker, text: t.text, original_text: t.originalText ?? null, language: t.language ?? null, translation: t.translation ?? null, audio_media_id: t.audioMediaId ?? null, video_media_id: t.videoMediaId ?? null, decision: t.decision ?? null, offset_ms: Math.max(0, Math.round(t.offsetMs)), duration_ms: t.durationMs ?? null }));
      const r = await db.rpc("rescript_ai_interview_record_turn", { p_session: a.sessionId, p_expected: a.expected, p_turns: turns, p_state: a.state, p_status: a.status, p_flags: a.flags, p_turns_count: a.turnsCount, p_cost_delta: Number(a.costDelta.toFixed(4)), p_completed: a.completed });
      if (r.error) { if (/duplicate key|unique/i.test(r.error.message)) return null; fail("record", r.error); }
      return r.data == null ? null : Number(r.data);
    },
    async saveQual({ study: st, session: s, transcript }) {
      const existing = await db.from("ai_interview_sessions").select("qual_session_id, qual_transcript_id").eq("id", s.id).maybeSingle();
      fail("session", existing.error);
      if (existing.data?.qual_transcript_id) return { qualSessionId: String(existing.data.qual_session_id), qualTranscriptId: String(existing.data.qual_transcript_id) };
      const rows = qualRowsForInterview(transcript, { surveyId: st.surveyId, participantNumber: s.participantNumber, segment: s.segment, startedAt: new Date(s.startedAt).toISOString(), recording: !!s.consent.recording, consentAt: s.consent.at, mode: s.mode, language: s.language, flags: s.state.flags });
      const qs = await db.from("qual_sessions").insert(rows.session).select("id").single();
      fail("qual session", qs.error);
      const row = { ...rows.transcript, session_id: qs.data!.id };
      let qt = await db.from("qual_transcripts").insert(row).select("id").single();
      /* a database whose 0065 checks were re-tightened by a later migration: the same transcript as an import */
      if (qt.error && /check constraint|violates check/i.test(qt.error.message)) qt = await db.from("qual_transcripts").insert({ ...row, source: "import", format: "speaker" }).select("id").single();
      fail("qual transcript", qt.error);
      await db.from("ai_interview_sessions").update({ qual_session_id: qs.data!.id, qual_transcript_id: qt.data!.id }).eq("id", s.id);
      const ev = await db.from("qual_events").insert({ survey_id: st.surveyId, actor: null, actor_label: "AI moderator", ...rows.event, ids: [qt.data!.id] });
      if (ev.error) console.warn("[rescript:ai-interview] history not recorded", JSON.stringify({ error: ev.error.message }));
      return { qualSessionId: String(qs.data!.id), qualTranscriptId: String(qt.data!.id) };
    },
    async mediaOwned(mediaId, sessionId) {
      if (!/^[0-9a-f-]{36}$/i.test(mediaId)) return false;
      const r = await db.from("media_objects").select("id").eq("id", mediaId).eq("session_id", sessionId).maybeSingle();
      return !r.error && !!r.data;
    },
  };
}
