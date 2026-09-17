import { NextRequest, NextResponse } from "next/server";
import { CHOICE_KINDS, TYPED_KINDS, checkCodeAnswer, isFlowKind, readCodeSettings } from "@rescript/interviews";
import { supabaseAdmin } from "@/lib/admin";
import { candidateGate, candidateQuestions, isCandidateFailure, recordTelemetry, touchInterview } from "@/lib/candidate";

export const dynamic = "force-dynamic";

/**
 * EVERY ANSWER THAT IS NOT A RECORDING, AND EVERY NON-ANSWER.
 *
 * Until now a candidate could do exactly one thing to a question: record a
 * video into it. The schema allowed `audio` and `text` kinds since 0030 and
 * nothing honoured them; there was no route to submit typed words, no route to
 * say "I choose B", no route to skip, and no route to prove a stimulus video
 * was watched. `retake()` and `next()` in the browser changed local state and
 * told the server nothing, so a reload showed a skipped question as pending
 * and a retaken one as answered.
 *
 * Four actions, one route, because they are four facts about the same row:
 *
 *   answer   — a typed or chosen value; the row becomes `stored`
 *   skip     — the candidate passed on an optional question, or logic hid it
 *   watched  — the interviewer's clip played to the end
 *   retake   — a recorded answer is being replaced; the old take is retired
 *
 * ## The server is the authority on what counts as an answer
 *
 * A choice has to be one of the question's options. A typed answer has to
 * have words in it. A `required` question cannot be skipped by the candidate
 * — only by logic, and the browser says which. None of that is trusted from
 * the request: the question is re-read here and the value checked against it.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const gate = await candidateGate(body?.token);
  if (isCandidateFailure(gate)) return gate.response;

  const responseId = String(body?.responseId ?? "");
  const action = String(body?.action ?? "answer");
  if (!responseId) return NextResponse.json({ error: "Which question?" }, { status: 400 });

  const questions = await candidateQuestions(gate, gate.interview.question_sequence ?? []);
  const q = questions.find((x) => x.responseId === responseId);
  if (!q) return NextResponse.json({ error: "That question is not part of this interview." }, { status: 404 });

  const db = supabaseAdmin();
  const now = new Date().toISOString();

  /* ---------------------------------------------------------- watched */
  if (action === "watched") {
    /*
     * Idempotent, and only ever set once: the first time the clip ended is
     * the fact worth keeping. A second report is a reload, not a second
     * viewing.
     */
    if (!q.promptWatchedAt) {
      await db.from("interview_responses")
        .update({ prompt_watched_at: now, updated_at: now })
        .eq("id", responseId).eq("interview_id", gate.interview.id).is("prompt_watched_at", null);
      await recordTelemetry(gate, [{
        kind: "prompt_playback_completed", responseId, questionId: q.questionId,
        detail: { mediaId: q.promptMedia?.id ?? null },
      }]);
    }
    await touchInterview(gate);
    return NextResponse.json({ ok: true, watchedAt: q.promptWatchedAt ?? now });
  }

  /* ------------------------------------------------------------- skip */
  if (action === "skip") {
    const reason = body?.reason === "logic" ? "logic" : "optional";
    /*
     * A required question is skippable ONLY by logic. The browser evaluates
     * the same engine the server does, but the browser is not the authority
     * — so a `logic` skip on a required question is accepted here and then
     * re-checked at `finish`, which walks the flow server-side and refuses if
     * the question turns out to have been visible. Lying to this route gains
     * a candidate nothing except a refusal later with a clear message.
     */
    if (q.required && reason !== "logic") {
      return NextResponse.json({ error: "That question needs an answer." }, { status: 400 });
    }
    if (q.status === "stored") {
      return NextResponse.json({ error: "That question already has an answer." }, { status: 409 });
    }
    await db.from("interview_responses")
      .update({ status: "skipped", skip_reason: reason, updated_at: now })
      .eq("id", responseId).eq("interview_id", gate.interview.id);
    await recordTelemetry(gate, [{
      kind: "question_skipped", responseId, questionId: q.questionId, detail: { reason },
    }]);
    await touchInterview(gate);
    return NextResponse.json({ ok: true, status: "skipped", reason });
  }

  /* ----------------------------------------------------------- retake */
  if (action === "retake") {
    if (q.retries >= q.maxRetries) {
      return NextResponse.json({ error: "No re-records left for this question." }, { status: 409 });
    }
    /*
     * THE SUPERSEDED TAKE IS RETIRED, NOT LEFT BESIDE THE NEW ONE.
     *
     * A retake used to mint a fresh client token and upload a second
     * `answer_video` for the same response, both `stored`, both billed, both
     * listed on the review page with nothing saying which was current.
     * Marking the old media `deleted_at` here means the retention sweep
     * removes the bytes and the reviewer sees one answer.
     */
    const { data: retired } = await db.from("interview_media")
      .update({ deleted_at: now, upload_status: "deleted", error: "superseded by a re-record" })
      .eq("response_id", responseId).eq("interview_id", gate.interview.id).is("deleted_at", null)
      .select("id");
    await db.from("interview_transcripts").delete().eq("response_id", responseId);
    /*
     * A transcription already queued for the retired take is cancelled rather
     * than left to run into "that recording does not exist" — it would stop
     * without billing, but as a failed job somebody might chase.
     */
    const retiredIds = (retired ?? []).map((m) => m.id as string);
    if (retiredIds.length) {
      await db.from("interview_jobs")
        .update({ status: "cancelled", error: "the take was superseded by a re-record", completed_at: now })
        .eq("kind", "transcription").in("subject_id", retiredIds).in("status", ["queued", "failed"]);
    }
    await db.from("interview_responses")
      .update({
        status: "pending", retries: q.retries + 1, answer_text: null, answer_value: null,
        answer_kind: null, stored_at: null, recorded_at: null, updated_at: now,
      })
      .eq("id", responseId).eq("interview_id", gate.interview.id);
    await recordTelemetry(gate, [{
      kind: "recording_discarded", responseId, questionId: q.questionId, detail: { retry: q.retries + 1 },
    }]);
    await touchInterview(gate);
    return NextResponse.json({ ok: true, status: "pending", retries: q.retries + 1 });
  }

  /* ----------------------------------------------------------- answer */
  if (!isFlowKind(q.kind) || (!TYPED_KINDS.includes(q.kind) && !CHOICE_KINDS.includes(q.kind))) {
    return NextResponse.json(
      { error: "That question is answered by recording, not by typing." },
      { status: 400 },
    );
  }

  /*
   * The stimulus gate, enforced where it cannot be bypassed. If the question
   * has a clip and it has not been watched to the end, no answer is accepted
   * — a disabled button in the browser is a suggestion, this is the rule.
   */
  if (q.promptMedia && !q.promptWatchedAt) {
    return NextResponse.json(
      { error: "Please watch the question through before answering.", code: "prompt_unwatched" },
      { status: 409 },
    );
  }

  let patch: Record<string, unknown>;
  if (CHOICE_KINDS.includes(q.kind)) {
    const allowed = new Set(q.options.map((o) => o.code));
    const raw = body?.value;
    const codes = (Array.isArray(raw) ? raw : [raw]).map(String).filter((c) => allowed.has(c));
    if (!codes.length) {
      return NextResponse.json({ error: "Choose one of the options given." }, { status: 400 });
    }
    if (q.kind === "single_choice" && codes.length !== 1) {
      return NextResponse.json({ error: "Choose exactly one." }, { status: 400 });
    }
    patch = {
      answer_value: q.kind === "single_choice" ? codes[0] : codes,
      answer_text: null,
      answer_kind: q.kind,
    };
  } else if (q.kind === "code") {
    /*
     * The same check the editor ran before enabling Save. Whitespace is kept:
     * indentation is part of a program. The language is stored beside the
     * text so the reviewer sees it highlighted as what it is.
     */
    const verdict = checkCodeAnswer(body?.value, body?.language, readCodeSettings(q.codeSettings));
    if (!verdict.ok) return NextResponse.json({ error: verdict.error, code: verdict.code }, { status: 400 });
    patch = { answer_text: verdict.text, answer_value: { language: verdict.language }, answer_kind: "code" };
  } else {
    const text = String(body?.value ?? "").trim();
    if (!text) return NextResponse.json({ error: "Write something first." }, { status: 400 });
    patch = { answer_text: text.slice(0, 20_000), answer_value: null, answer_kind: q.kind };
  }

  const { error } = await db.from("interview_responses")
    .update({ ...patch, status: "stored", stored_at: now, recorded_at: now, updated_at: now })
    .eq("id", responseId).eq("interview_id", gate.interview.id);
  if (error) return NextResponse.json({ error: "That answer could not be saved." }, { status: 503 });

  await recordTelemetry(gate, [{
    kind: "question_answered", responseId, questionId: q.questionId, detail: { kind: q.kind },
  }]);
  await touchInterview(gate);
  return NextResponse.json({ ok: true, status: "stored" });
}
