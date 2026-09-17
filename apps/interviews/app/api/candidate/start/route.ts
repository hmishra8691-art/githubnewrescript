import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import {
  candidateGate, candidateQuestions, ensureSequence, isCandidateFailure,
  recordTelemetry, touchInterview,
} from "@/lib/candidate";
import { progressOf, SIGNALS_CAVEAT } from "@rescript/interviews";
import { storageProvider } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * OPEN AN INTERVIEW.
 *
 * Everything the candidate's browser needs, in one reply: the project's own
 * words, the consent statement, this candidate's sequence, and where they got
 * to. One request rather than four, because the four would be four chances
 * for a page to half-load on a bad connection at the most fragile moment of
 * the whole product.
 *
 * `ensureSequence` draws the questions the first time and never again. The
 * reply is therefore identical on a refresh, on another device and after a
 * crash — which is what makes "you are on question 4 of 13" a fact rather
 * than a guess.
 *
 * Storage being unconfigured is reported HERE, as `canRecord: false`, rather
 * than at the moment somebody stops recording. A candidate who has just
 * spoken for four minutes into a product that was never able to save it is
 * the single worst thing this application can do to a person.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const gate = await candidateGate(body?.token);
  if (isCandidateFailure(gate)) return gate.response;

  const db = supabaseAdmin();
  const sequence = await ensureSequence(gate);
  const questions = await candidateQuestions(gate, sequence);

  const first = gate.interview.status === "invited";
  if (first) {
    await db.from("interviews").update({
      status: "started",
      started_at: gate.interview.started_at ?? new Date().toISOString(),
      user_agent: (req.headers.get("user-agent") ?? "").slice(0, 400),
    }).eq("id", gate.interview.id);
  }
  await touchInterview(gate);
  await recordTelemetry(gate, [{ kind: "interview_opened" }]);

  const progress = progressOf(questions.map((q) => ({
    questionId: q.questionId,
    status: q.status as never,
    required: q.required,
  })));

  return NextResponse.json({
    ok: true,
    interview: {
      id: gate.interview.id,
      status: first ? "started" : gate.interview.status,
      candidateName: gate.interview.candidate_name,
      consentGivenAt: gate.interview.consent_given_at,
      isTest: gate.interview.is_test,
    },
    project: {
      name: gate.project.name,
      instructions: gate.project.instructions,
      consentText: gate.project.consent_text,
      /*
       * Said to the candidate on their own screen, because a retention period
       * nobody is told about is a policy, not a promise. Hours when the
       * project says hours — a practice recording is kept a day.
       */
      mode: gate.project.mode ?? "hiring",
      retentionSay: gate.project.retention_hours
        ? `Your recording is kept for ${gate.project.retention_hours} hours after you finish, then deleted.`
        : gate.project.retention_days
          ? `Your recording is kept for ${gate.project.retention_days} day${gate.project.retention_days === 1 ? "" : "s"} after you finish, then deleted.`
          : null,
    },
    questions,
    /*
     * The frozen draw, so the browser can rebuild the same definition the
     * server rebuilds at `finish` and walk it with the same engine. Ids only —
     * the question content travels once, above.
     */
    sequence: (gate.interview.question_sequence ?? []).map((s) => s.questionId),
    seed: gate.interview.selection_seed,
    projectName: gate.project.name,
    progress,
    /* the honest answer about whether this deployment can keep a recording */
    canRecord: !!storageProvider(),
    notice: SIGNALS_CAVEAT,
  });
}
