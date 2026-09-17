import { NextRequest, NextResponse } from "next/server";
import { PLAYBACK_SECONDS } from "@rescript/storage";
import { candidateGate, candidateQuestions, isCandidateFailure, recordTelemetry } from "@/lib/candidate";
import { storageOrResponse } from "@/lib/storage";
import { supabaseAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

/**
 * THE ONE THING A CANDIDATE MAY WATCH.
 *
 * Until now a candidate could obtain no playback URL of any kind — `/api/media/
 * [id]/url` is staff-only behind `media.read`, and there was no candidate-side
 * route. That was correct: a respondent must never be able to play back their
 * own or anybody else's answer. This route is the single, deliberately narrow
 * exception: the interviewer's question clip, for a question in THIS
 * candidate's own drawn sequence, and nothing else.
 *
 * The check is not "is this media id a question_prompt" — that would let a
 * candidate with one link enumerate every interviewer clip in the workspace.
 * It is "is this media id the prompt of a question I was given", resolved
 * through the candidate's own rows. A media id that is not in their sequence
 * is a 404 indistinguishable from one that does not exist.
 *
 * Signed for `PLAYBACK_SECONDS` like every other playback URL here: long
 * enough to watch a clip, short enough that a URL pasted somewhere is dead by
 * the time anyone follows it.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const gate = await candidateGate(body?.token);
  if (isCandidateFailure(gate)) return gate.response;

  const mediaId = String(body?.mediaId ?? "");
  const questions = await candidateQuestions(gate, gate.interview.question_sequence ?? []);
  const q = questions.find((x) => x.promptMedia?.id === mediaId);
  if (!q) return NextResponse.json({ error: "No such video." }, { status: 404 });

  const store = storageOrResponse();
  if ("response" in store) return store.response;

  const { data: media } = await supabaseAdmin()
    .from("interview_media")
    .select("id, storage_key, mime_type, upload_status, deleted_at")
    .eq("id", mediaId)
    .eq("kind", "question_prompt")
    .maybeSingle();
  if (!media || media.deleted_at || media.upload_status !== "stored") {
    return NextResponse.json({ error: "No such video." }, { status: 404 });
  }

  const url = await store.storage.createSignedDownloadUrl(media.storage_key, { expiresIn: PLAYBACK_SECONDS });
  await recordTelemetry(gate, [{
    kind: "prompt_playback_started", responseId: q.responseId, questionId: q.questionId,
    detail: { mediaId },
  }]);

  return NextResponse.json(
    { ok: true, url, expiresIn: PLAYBACK_SECONDS, mimeType: media.mime_type ?? null },
    { headers: { "cache-control": "no-store" } },
  );
}
