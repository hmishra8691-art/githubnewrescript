import { cookies } from "next/headers";
import Link from "next/link";
import {
  INTERVIEW_SAY, TELEMETRY_SAY, isParticipantRole, summariseSignals,
  type Participant, type TranscriptSegment,
} from "@rescript/interviews";
import { supabaseAdmin } from "@/lib/admin";
import { SESSION_COOKIE_NAME, can, projectPageGate, signInUrl } from "@/lib/auth";
import {
  InterviewReview, type EvidenceView, type RecordingView,
} from "@/components/InterviewReview";
import { ReviewPanel, type ReviewRequirement } from "@/components/ReviewPanel";

export const dynamic = "force-dynamic";

/**
 * ONE INTERVIEW, EVERYTHING ABOUT IT.
 *
 * The page the product did not have. Recordings existed and could not be
 * watched; transcripts were written and never read; the analysis wrote
 * evidence rows nothing displayed. All of it is loaded here in one pass and
 * handed to a client component, so the page is either complete or it is an
 * error — never a shell that fills in.
 *
 * ## The permission split is real
 *
 * `candidates.read` opens the page; `media.read` is what lets somebody press
 * play. A `viewer` has the first and not the second, so they can follow a
 * project's progress without watching anybody's interview. That distinction is
 * the whole distance between a dashboard a team can see and a privacy incident,
 * and it is enforced twice: the playback route checks it too, because a page
 * that merely hides a button is a page somebody can call the API behind.
 */
export default async function InterviewPage({ params }: { params: { id: string } }) {
  const db = supabaseAdmin();

  const { data: interview } = await db
    .from("interviews")
    .select("id, project_id, customer_id, candidate_name, candidate_email, status, is_test, created_at, completed_at, deleted_at")
    .eq("id", params.id)
    .maybeSingle();

  if (!interview || interview.deleted_at) {
    return (
      <main className="wrap">
        <div className="card"><h1>Not found</h1><p>That interview does not exist.</p></div>
      </main>
    );
  }

  const gate = await projectPageGate(
    cookies().get(SESSION_COOKIE_NAME)?.value ?? null, interview.project_id, "candidates.read",
  );
  if (!gate.ok) {
    const href = signInUrl(`/interviews/${params.id}`);
    return (
      <main className="wrap">
        <div className="card">
          <h1>Rescript Interviews</h1>
          <p>{gate.message}</p>
          {gate.kind === "signed_out" && href && <p><a className="btn" href={href}>Sign in</a></p>}
        </div>
      </main>
    );
  }

  const mayWatch = can(gate.ctx.role, "media.read");
  const mayMap = can(gate.ctx.role, "transcript.read");
  const mayReview = can(gate.ctx.role, "review.write");

  const [{ data: media }, { data: questions }, { data: transcripts }, { data: evidenceRows }, { data: analysis }, { data: telemetry }] =
    await Promise.all([
      db.from("interview_media")
        .select("id, kind, question_id, response_id, duration_seconds, created_at, upload_status")
        .eq("interview_id", params.id)
        .is("deleted_at", null)
        .eq("upload_status", "stored")
        .order("created_at", { ascending: true }),
      db.from("interview_questions")
        .select("id, code, prompt, kind, prompt_media_id, options")
        .eq("project_id", interview.project_id),
      db.from("interview_transcripts")
        .select("media_id, status, text, segments, diarized, speaker_count")
        .eq("interview_id", params.id),
      db.from("interview_evidence")
        .select("requirement_id, verdict, explanation, quote, quote_start_seconds")
        .eq("interview_id", params.id),
      db.from("interview_analysis")
        .select("narrative, summary, status")
        .eq("interview_id", params.id)
        .maybeSingle(),
      db.from("interview_telemetry")
        .select("kind")
        .eq("interview_id", params.id)
        .limit(2000),
    ]);

  /* participants, one call per recording — the database function does the join */
  const participantsByMedia = new Map<string, Participant[]>();
  await Promise.all((media ?? []).map(async (m) => {
    const { data } = await db.rpc("rescript_interview_recording_participants", { p_media: m.id });
    participantsByMedia.set(m.id as string, ((data ?? []) as {
      person_id: string; display_name: string; email: string | null; role: string;
      user_id: string | null; derived: boolean; speaker_label: string | null;
    }[]).map((r) => ({
      id: r.person_id, displayName: r.display_name, email: r.email, userId: r.user_id,
      derived: r.derived, speakerLabel: r.speaker_label,
      role: isParticipantRole(r.role) ? r.role : "observer",
    })));
  }));

  const questionById = new Map((questions ?? []).map((q) => [q.id as string, q]));
  const transcriptByMedia = new Map((transcripts ?? []).map((t) => [t.media_id as string, t]));

  /*
   * THE AUDIO COMPANION IS NOT A RECORDING, IT IS THE VIDEO'S TRANSCRIPT.
   *
   * A candidate answer is captured twice over the same microphone: the video
   * the reviewer watches, and an audio-only track small enough for a speech
   * provider that accepts 25 MB. Both are rows in `interview_media`, so
   * listing them naively puts a second, unwatchable card on the page and —
   * worse — hangs the transcript off that card, leaving the video the
   * reviewer is actually looking at captioned "no transcript".
   *
   * They are siblings by `response_id`, which is what joins them back
   * together. The audio row is then dropped from the list: nobody wants to
   * play it, and offering it invites somebody to review the wrong artefact.
   */
  const transcriptByResponse = new Map<string, (typeof transcripts extends null ? never : NonNullable<typeof transcripts>)[number]>();
  for (const m of media ?? []) {
    if (m.kind !== "answer_audio" || !m.response_id) continue;
    const t = transcriptByMedia.get(m.id as string);
    if (t) transcriptByResponse.set(m.response_id as string, t);
  }

  /*
   * The interviewer's clips are transcribed like everything else; their
   * transcripts are keyed by media id and have no response. Loaded here so a
   * reviewer sees what was actually asked beside what was answered — the
   * brief's section 8 wants both on one screen.
   */
  const promptIds = (questions ?? []).map((q) => q.prompt_media_id).filter((x): x is string => !!x);
  const { data: promptTranscripts } = promptIds.length
    ? await db.from("interview_transcripts").select("media_id, text").in("media_id", promptIds)
    : { data: [] as { media_id: string; text: string | null }[] };
  const promptTextByMedia = new Map((promptTranscripts ?? []).map((t) => [t.media_id as string, t.text as string | null]));

  /*
   * Typed and chosen answers have no media row. They are the answer itself,
   * so they are listed as such — with the question, the way a recording is.
   */
  const { data: written } = await db.from("interview_responses")
    .select("id, question_id, status, answer_kind, answer_text, answer_value, skip_reason")
    .eq("interview_id", params.id)
    .in("answer_kind", ["text", "long_text", "single_choice", "multi_choice"]);

  const recordings: RecordingView[] = (media ?? []).filter((m) => m.kind !== "answer_audio" && m.kind !== "question_prompt").map((m) => {
    const q = questionById.get((m.question_id as string) ?? "");
    /* its own transcript, or its audio sibling's — see above */
    const t = transcriptByMedia.get(m.id as string)
      ?? (m.response_id ? transcriptByResponse.get(m.response_id as string) : undefined);
    return {
      id: m.id as string,
      kind: m.kind as string,
      durationSeconds: m.duration_seconds as number | null,
      createdAt: m.created_at as string,
      questionCode: (q?.code as string) ?? null,
      questionPrompt: (q?.prompt as string) ?? null,
      promptMediaId: (q?.prompt_media_id as string | null) ?? null,
      promptTranscript: q?.prompt_media_id ? promptTextByMedia.get(q.prompt_media_id as string) ?? null : null,
      participants: participantsByMedia.get(m.id as string) ?? [],
      transcript: t
        ? {
            status: t.status as string,
            text: (t.text as string) ?? null,
            segments: (t.segments as TranscriptSegment[] | null) ?? null,
            diarized: !!t.diarized,
            speakerCount: (t.speaker_count as number | null) ?? null,
          }
        : null,
    };
  });

  /* requirements, for naming the evidence rows */
  const { data: requirements } = await db
    .from("interview_requirements")
    .select("id, code, title")
    .eq("project_id", interview.project_id);
  const reqById = new Map((requirements ?? []).map((r) => [r.id as string, r]));

  const evidence: EvidenceView[] = (evidenceRows ?? []).map((e) => {
    const r = reqById.get(e.requirement_id as string);
    return {
      requirementCode: (r?.code as string) ?? "—",
      requirementTitle: (r?.title as string) ?? "Unknown requirement",
      verdict: (e.verdict as EvidenceView["verdict"]) ?? "insufficient",
      explanation: (e.explanation as string) ?? "",
      quote: (e.quote as string) ?? null,
      startSeconds: (e.quote_start_seconds as number | null) ?? null,
    };
  });

  /*
   * Counts, never a score. `summariseSignals` deliberately produces no total
   * and no severity — a number that looks like a suspicion rating is one
   * somebody will treat as evidence about a person.
   */
  const summarised = summariseSignals(
    (telemetry ?? []).map((t) => ({ kind: t.kind as string })) as never,
  );
  const signals = Object.entries(summarised)
    .filter(([, v]) => (v as { count: number }).count > 0)
    .map(([kind, v]) => ({
      kind,
      say: TELEMETRY_SAY[kind as keyof typeof TELEMETRY_SAY] ?? kind,
      count: (v as { count: number }).count,
    }));

  /*
   * The reviewer's own draft, and the analysis verdict per requirement for
   * comparison. The analysis verdict is shown BESIDE the choice and never
   * pre-selected as it: a form that starts on the machine's answer is a form
   * most people agree with.
   */
  const { data: myReview } = mayReview
    ? await db.from("interview_reviews")
        .select("status, assessments, notes, recommendation")
        .eq("interview_id", params.id)
        .eq("reviewer_id", gate.ctx.user.userId)
        .maybeSingle()
    : { data: null };

  const analysisVerdicts = (analysis?.summary ?? {}) as Record<string, { verdict?: string }>;
  const reviewRequirements: ReviewRequirement[] = (requirements ?? []).map((r) => ({
    id: r.id as string,
    code: r.code as string,
    title: r.title as string,
    analysisVerdict: (analysisVerdicts[r.code as string]?.verdict as ReviewRequirement["analysisVerdict"]) ?? null,
  }));

  return (
    <main className="wrap wide">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0 }}>{interview.candidate_name ?? "Interview"}</h1>
          <p className="muted small" style={{ margin: 0 }}>
            {INTERVIEW_SAY[interview.status as keyof typeof INTERVIEW_SAY] ?? interview.status}
            {interview.is_test ? " · test" : ""}
            {analysis?.status === "complete" ? " · analysed" : ""}
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Link className="btn secondary" href={`/interviews/${params.id}/record`}>Record</Link>
          <Link className="btn secondary" href={`/projects/${interview.project_id}`}>Back to project</Link>
        </div>
      </div>

      {!mayWatch && (
        <p className="note warn">
          Your role on this project lets you follow its progress but not watch recordings.
        </p>
      )}

      {(written ?? []).length > 0 && (
        <section className="card" data-testid="written-answers">
          <h2 style={{ marginTop: 0 }}>Written and chosen answers</h2>
          {(written ?? []).map((r) => {
            const q = questionById.get(r.question_id as string);
            const opts = (Array.isArray(q?.options) ? q!.options : []) as { code: string; label: string }[];
            const label = (code: unknown) => opts.find((o) => o.code === String(code))?.label ?? String(code);
            const value = r.answer_kind === "multi_choice" && Array.isArray(r.answer_value)
              ? r.answer_value.map(label).join(", ")
              : r.answer_kind === "single_choice" ? label(r.answer_value) : (r.answer_text as string | null) ?? "";
            return (
              <div key={r.id as string} style={{ borderTop: "1px solid var(--line)", paddingTop: 10, marginTop: 10 }}>
                <strong>{(q?.code as string) ?? "?"}</strong>{" "}
                <span className="muted small">{(q?.prompt as string) ?? ""}</span>
                <p style={{ margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{value || <span className="muted">—</span>}</p>
              </div>
            );
          })}
        </section>
      )}

      <InterviewReview
        interviewId={params.id}
        recordings={mayWatch ? recordings : recordings.map((r) => ({ ...r, transcript: null }))}
        evidence={evidence}
        narrative={(analysis?.narrative as string) ?? null}
        signals={signals}
        canMap={mayMap}
      />

      {mayReview && reviewRequirements.length > 0 && (
        <ReviewPanel
          interviewId={params.id}
          requirements={reviewRequirements}
          initial={myReview
            ? {
                status: myReview.status as string,
                assessments: (myReview.assessments as Record<string, string>) ?? {},
                notes: (myReview.notes as string) ?? "",
                recommendation: (myReview.recommendation as string) ?? null,
              }
            : null}
        />
      )}
    </main>
  );
}
