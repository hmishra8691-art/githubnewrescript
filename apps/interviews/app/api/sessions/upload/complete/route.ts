import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure } from "@/lib/auth";
import { assembleAndVerify, readClaimedParts, requireMedia } from "@/lib/recordings";

export const dynamic = "force-dynamic";

/**
 * FINISH A MODERATED RECORDING.
 *
 * The same verification as the candidate path, through the same function: the
 * store's part list beats the browser's, a short upload is refused before
 * anything is assembled, and only a HEAD against the real bucket may move a
 * recording to `stored`.
 *
 * What differs is what happens afterwards. A candidate's answer updates an
 * `interview_responses` row; a moderated recording has none, so there is
 * nothing to advance — the recording is the artefact. What it does instead is
 * create the transcript row, for both audio and video, because unlike a
 * candidate answer there is no separate audio companion: the session recording
 * is the only thing there is to transcribe.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const mediaId = String(body?.mediaId ?? "");
  if (!mediaId) return NextResponse.json({ error: "Which recording?" }, { status: 400 });

  const ctx = await requireMedia(req, mediaId, "candidates.invite");
  if (isFailure(ctx)) return ctx.response;

  const { media } = ctx;
  if (media.kind !== "session_video" && media.kind !== "session_audio") {
    /*
     * A candidate's answer has its own route with its own gate. Letting this
     * one finish an `answer_video` would be a signed-in researcher completing
     * an upload on a respondent's behalf, which is not a thing that should be
     * possible from here.
     */
    return NextResponse.json(
      { error: "That recording is not a session recording." }, { status: 400 },
    );
  }
  if (media.upload_status === "stored") {
    /* already done — a re-sent completion is not an error */
    return NextResponse.json({ ok: true, mediaId, alreadyStored: true });
  }

  const store = (await import("@/lib/storage")).storageOrResponse();
  if ("response" in store) return store.response;
  const db = supabaseAdmin();

  const markFailed = async (reason: string) => {
    await db.from("interview_media")
      .update({ upload_status: "failed", error: reason.slice(0, 500) })
      .eq("id", mediaId);
  };

  const verified = await assembleAndVerify({
    storage: store.storage,
    storageKey: media.storage_key,
    multipartUploadId: media.multipart_upload_id ?? null,
    declaredBytes: media.file_size,
    claimedParts: readClaimedParts(body?.parts),
    onFailure: markFailed,
  });
  if (!verified.ok) return verified.response;

  const durationSeconds = Number(body?.durationSeconds);
  const duration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null;

  await db.from("interview_media").update({
    upload_status: "stored",
    file_size: verified.size,
    mime_type: verified.contentType ?? media.mime_type,
    duration_seconds: duration,
    uploaded_at: new Date().toISOString(),
    multipart_upload_id: null,
    error: null,
  }).eq("id", mediaId);

  /*
   * The transcript row is created for a session recording of either kind.
   * There is no audio companion here — the session recording IS the audio —
   * so waiting for one would mean a moderated interview is never transcribed.
   * `onConflict` makes creating it twice free, which is what lets a retried
   * completion be a no-op rather than a duplicate.
   */
  await db.from("interview_transcripts").upsert({
    media_id: mediaId,
    interview_id: media.interview_id,
    project_id: media.project_id,
    response_id: null,
    status: "waiting",
  }, { onConflict: "media_id", ignoreDuplicates: true });

  return NextResponse.json({ ok: true, mediaId, bytes: verified.size, verified: true });
}
