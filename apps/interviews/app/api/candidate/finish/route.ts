import { NextRequest, NextResponse } from "next/server";
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
  const progress = progressOf(questions.map((q) => ({
    questionId: q.questionId, status: q.status as never, required: q.required,
  })));

  if (!progress.complete) {
    return NextResponse.json({
      ok: false,
      error: "Some questions still need an answer before you can finish.",
      outstanding: questions
        .filter((q) => q.required && q.status !== "stored" && q.status !== "skipped")
        .map((q) => ({ responseId: q.responseId, code: q.code, position: q.position, status: q.status })),
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
