import { NextRequest, NextResponse } from "next/server";
import {
  PLAYBACK_SECONDS,
} from "@rescript/storage";
import { buildFeedback, readScorecard, suggestPractice } from "@rescript/interviews";
import { supabaseAdmin } from "@/lib/admin";
import { candidateGate, isCandidateFailure } from "@/lib/candidate";
import { storageOrResponse } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * FEEDBACK FOR THE PERSON WHO PRACTISED — AND NOBODY ELSE.
 *
 * In a hiring interview the candidate never sees the analysis, and this route
 * is the place that rule is enforced: it answers 404 for any project whose
 * `mode` is not `mock`, indistinguishable from a bad token. A hiring
 * candidate holding their own link learns nothing from it, including that it
 * exists.
 *
 * For a mock interview the candidate IS the audience. They get the scorecard
 * turned into feedback (`buildFeedback` — about the answers, never the
 * person), suggested practice from the same shelf, and, because the recording
 * is theirs, a signed download URL for each of their own answers — the one
 * other place a candidate may ever obtain a playback URL, and only here.
 *
 * `pending` while the transcripts and analysis are still running; the screen
 * polls. Nothing is guessed at while waiting.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const gate = await candidateGate(body?.token);
  if (isCandidateFailure(gate)) return gate.response;

  const db = supabaseAdmin();
  const { data: project } = await db.from("interview_projects")
    .select("mode, template_key, retention_hours, retention_days")
    .eq("id", gate.project.id).maybeSingle();
  if (project?.mode !== "mock") {
    return NextResponse.json({ error: "We could not find this interview. Please check the link." }, { status: 404 });
  }

  const [{ data: analysis }, { data: transcripts }, { data: media }] = await Promise.all([
    db.from("interview_analysis").select("status, score, narrative").eq("interview_id", gate.interview.id).maybeSingle(),
    db.from("interview_transcripts").select("status").eq("interview_id", gate.interview.id),
    db.from("interview_media")
      .select("id, kind, question_id, duration_seconds, storage_key, upload_status")
      .eq("interview_id", gate.interview.id).eq("kind", "answer_video").eq("upload_status", "stored").is("deleted_at", null),
  ]);

  const card = analysis?.status === "complete" ? readScorecard(analysis.score) : null;
  const waiting = (transcripts ?? []).filter((t) => t.status !== "completed" && t.status !== "failed").length;

  /* the person's own recordings, downloadable while they still exist */
  let downloads: { mediaId: string; questionId: string | null; url: string; expiresIn: number }[] = [];
  if (body?.downloads === true && (media ?? []).length) {
    const store = storageOrResponse();
    if (!("response" in store)) {
      downloads = await Promise.all((media ?? []).map(async (m) => ({
        mediaId: m.id as string, questionId: (m.question_id as string | null) ?? null,
        url: await store.storage.createSignedDownloadUrl(m.storage_key as string, {
          expiresIn: PLAYBACK_SECONDS, downloadAs: `practice-answer-${String(m.id).slice(0, 8)}.webm`,
        }),
        expiresIn: PLAYBACK_SECONDS,
      })));
    }
  }

  if (!card) {
    return NextResponse.json({
      ok: true, ready: false,
      waiting: { transcripts: waiting, analysis: analysis?.status ?? "not started" },
      say: waiting
        ? `Transcribing ${waiting} answer${waiting === 1 ? "" : "s"}…`
        : analysis?.status ? "Reading your answers against the requirements…" : "Waiting for your answers to finish saving…",
      downloads,
      retention: retentionSay(project),
    }, { headers: { "cache-control": "no-store" } });
  }

  const feedback = buildFeedback(card);
  const practice = suggestPractice(project.template_key, feedback.practiceNext.categories)
    .map((t) => ({ key: t.key, title: t.title, minutes: t.minutes, category: t.category }));

  return NextResponse.json({
    ok: true, ready: true, feedback, narrative: analysis?.narrative ?? null, practice, downloads,
    retention: retentionSay(project),
  }, { headers: { "cache-control": "no-store" } });
}

function retentionSay(p: { retention_hours: number | null; retention_days: number | null }): string {
  if (p.retention_hours) return `Your recording and answers are deleted ${p.retention_hours} hours after you finish.`;
  if (p.retention_days) return `Your recording and answers are deleted ${p.retention_days} days after you finish.`;
  return "";
}
