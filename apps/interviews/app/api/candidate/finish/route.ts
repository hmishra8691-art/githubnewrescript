import { NextRequest, NextResponse } from "next/server";
import { isShown, outstandingQuestions, toResponseState, toSurveyDefinition } from "@rescript/interviews";
import { supabaseAdmin } from "@/lib/admin";
import {
  candidateGate, candidateQuestions, isCandidateFailure, recordTelemetry,
} from "@/lib/candidate";
import { advanceInterview, progressOf, type InterviewStatus } from "@rescript/interviews";

export const dynamic = "force-dynamic";

/**
 * THE END OF THE INTERVIEW — WHICH THE SERVER DECIDES, NOT THE BROWSER.
 *
 * The browser asks; the server re-reads the response rows and checks that
 * every required question is genuinely `stored` or `skipped`. A candidate
 * whose last upload failed must not be able to finish, because an interview
 * marked complete with a missing answer is one nobody will look at again.
 *
 * The outstanding questions come back with the refusal, so the browser can
 * take the person to the one that needs re-recording rather than showing a
 * message they cannot act on.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const gate = await candidateGate(body?.token);
  if (isCandidateFailure(gate)) return gate.response;

  const db = supabaseAdmin();
  const questions = await candidateQuestions(gate, gate.interview.question_sequence ?? []);

  /*
   * THE SERVER WALKS THE FLOW ITSELF.
   *
   * The browser runs the same engine to decide what to show next, but the
   * browser is not the authority on what was owed. Here the definition is
   * rebuilt from the rows and `outstandingQuestions` asks the engine which
   * required questions were actually reachable under this candidate's
   * answers. A question display logic hid is not outstanding whatever its
   * `required` flag says — it was never asked. A required question the
   * browser claimed was "skipped by logic" but which the engine says was
   * visible IS outstanding, and the candidate is sent back to it by code.
   *
   * The same pass enforces the stimulus gate: a stored answer to a question
   * whose clip was never watched to the end is refused. The `answer` route
   * already refuses those for typed and chosen answers; recorded ones arrive
   * through the upload path, so this is where they are caught.
   */
  const def = toSurveyDefinition(
    { id: gate.project.id, name: gate.project.name },
    questions.map((q) => ({
      id: q.questionId, code: q.code, kind: q.kind, prompt: q.prompt, required: q.required,
      options: q.options, visibleIf: q.visibleIf, skipLogic: q.skipLogic,
    })),
    (gate.interview.question_sequence ?? []).map((s) => s.questionId),
  );
  const state = toResponseState(
    def,
    { id: gate.interview.id, seed: gate.interview.selection_seed },
    questions.map((q) => ({
      questionId: q.questionId, status: q.status, answerKind: q.kind,
      answerText: q.answerText, answerValue: q.answerValue,
    })),
  );
  const outstandingIds = new Set(outstandingQuestions(def, state, questions.map((q) => ({
    questionId: q.questionId, status: q.status, required: q.required,
  }))));
  const unwatched = questions.filter((q) =>
    q.required && q.promptMedia && !q.promptWatchedAt && isShown(def, state, q.questionId));

  /*
   * Rows the browser left `pending` because logic hid them are settled here
   * as `skipped` with reason `logic`, so the record says what happened rather
   * than leaving a question that looks unanswered for ever.
   */
  const hidden = questions.filter((q) =>
    q.status === "pending" && !isShown(def, state, q.questionId));
  if (hidden.length) {
    await db.from("interview_responses")
      .update({ status: "skipped", skip_reason: "logic", updated_at: new Date().toISOString() })
      .in("id", hidden.map((q) => q.responseId))
      .eq("interview_id", gate.interview.id)
      .eq("status", "pending");
  }

  const progress = progressOf(questions.map((q) => ({
    questionId: q.questionId,
    status: (hidden.some((h) => h.questionId === q.questionId) ? "skipped" : q.status) as never,
    /* a hidden question is not required of anybody */
    required: q.required && isShown(def, state, q.questionId),
  })));

  if (outstandingIds.size || unwatched.length) {
    const back = questions
      .filter((q) => outstandingIds.has(q.questionId) || unwatched.some((u) => u.questionId === q.questionId))
      .sort((a, b) => a.position - b.position);
    return NextResponse.json({
      ok: false,
      error: unwatched.length && !outstandingIds.size
        ? "Please watch each question through before finishing."
        : "Some questions still need an answer before you can finish.",
      outstanding: back.map((q) => ({ responseId: q.responseId, code: q.code, position: q.position, status: q.status })),
      progress,
    }, { status: 409 });
  }

  const now = new Date().toISOString();
  let next: InterviewStatus;
  try {
    next = advanceInterview(gate.interview.status as InterviewStatus, "completed");
  } catch {
    /* already completed: say so rather than failing on a double-click */
    return NextResponse.json({ ok: true, status: gate.interview.status, alreadyFinished: true });
  }

  await db.from("interviews")
    .update({ status: next, completed_at: now, last_seen_at: now })
    .eq("id", gate.interview.id);
  await recordTelemetry(gate, [{ kind: "interview_completed" }]);

  return NextResponse.json({ ok: true, status: next, completedAt: now, progress });
}
