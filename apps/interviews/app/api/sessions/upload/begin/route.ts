import { NextRequest, NextResponse } from "next/server";
import { checkParticipants } from "@rescript/interviews";
import {
  PART_BYTES, UPLOAD_SECONDS, planUpload, responseMediaKey,
} from "@rescript/storage";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireProject } from "@/lib/auth";
import { setParticipants } from "@/lib/recordings";
import { storageOrResponse } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * START A MODERATED RECORDING.
 *
 * The candidate's own upload is gated by a link token: an unauthenticated
 * person proving they hold a secret. This one is the opposite — a signed-in
 * researcher recording a session they are running — so it is gated by a
 * project role, and `candidates.invite` is the capability, because starting a
 * recording of somebody is the same weight of act as inviting them.
 *
 * ## It is bound to a question, not to a response
 *
 * `interview_responses` exists because a candidate answers questions alone,
 * one row per answer. A moderated session has no such row: the interviewer
 * asks, the respondent replies, and the recording contains both. So this
 * writes `question_id` and leaves `response_id` null — which is why 0033 made
 * that looseness explicit in a comment rather than leaving it to be rediscovered.
 *
 * ## Participants are set here, not afterwards
 *
 * §7 asks the researcher who is in the recording BEFORE it starts, and the
 * list is written with the media row in the same request. A recording that
 * exists for a while with nobody attributed is a recording somebody will
 * transcribe and then have to reconstruct the room from memory.
 */

const extensionFor = (mime: string) =>
  mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : mime.includes("audio") ? "webm" : "webm";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));

  const interviewId = String(body?.interviewId ?? "");
  const questionId = String(body?.questionId ?? "") || null;
  if (!interviewId) {
    return NextResponse.json({ error: "Which interview is this recording for?" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: interview, error: ivError } = await db
    .from("interviews")
    .select("id, project_id, customer_id, status, deleted_at")
    .eq("id", interviewId)
    .maybeSingle();
  if (ivError) {
    return NextResponse.json({ error: "We could not look that interview up." }, { status: 503 });
  }
  if (!interview || interview.deleted_at) {
    return NextResponse.json({ error: "That interview does not exist." }, { status: 404 });
  }

  const ctx = await requireProject(req, interview.project_id, "candidates.invite");
  if (isFailure(ctx)) return ctx.response;

  /* the participant list is part of starting, so it is validated before anything is signed */
  const rawParticipants = Array.isArray(body?.participants) ? body.participants : [];
  const participants = rawParticipants
    .filter((p: unknown): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p: Record<string, unknown>) => ({
      personId: String(p.personId ?? ""),
      role: String(p.role ?? "interviewer"),
    }))
    .filter((p: { personId: string }) => !!p.personId);

  const { errors } = checkParticipants(participants);
  if (errors.length) {
    return NextResponse.json({ error: errors[0].message, errors }, { status: 400 });
  }

  const store = storageOrResponse();
  if ("response" in store) return store.response;

  const audioOnly = body?.kind === "session_audio";
  const kind = audioOnly ? "session_audio" : "session_video";
  const mimeType = String(body?.mimeType ?? (audioOnly ? "audio/webm" : "video/webm"));
  const declaredBytes = Number(body?.bytes);
  const bytes = Number.isFinite(declaredBytes) && declaredBytes > 0 ? declaredBytes : 0;
  const clientToken = String(body?.clientToken ?? "") || null;

  /*
   * A take that reaches us twice — a double-click, a re-sent request after a
   * timeout that actually succeeded — must not start a second upload of the
   * same recording and pay for both. The same partial-unique index the
   * candidate path relies on does the work; this read is what turns the
   * collision into the original row rather than an error.
   */
  if (clientToken) {
    const { data: already } = await db
      .from("interview_media")
      .select("id, storage_key, multipart_upload_id, upload_status")
      .eq("interview_id", interviewId)
      .eq("client_token", clientToken)
      .is("deleted_at", null)
      .maybeSingle();
    if (already && already.upload_status !== "failed") {
      return NextResponse.json({ ok: true, mediaId: already.id, duplicate: true });
    }
  }

  const mediaId = crypto.randomUUID();
  const storageKey = responseMediaKey({
    organizationId: interview.customer_id,
    interviewId: interview.id,
    /*
     * There is no response row, so the question stands in for one in the key.
     * `session` keeps moderated recordings visibly apart from answers when
     * somebody is looking at a bucket listing trying to understand an invoice.
     */
    responseId: `session-${questionId ?? "unassigned"}`,
    fileName: `${mediaId}-${audioOnly ? "audio" : "session"}.${extensionFor(mimeType)}`,
  });

  const plan = planUpload(bytes || PART_BYTES);
  let multipartUploadId: string | null = null;
  let uploadUrl: string | null = null;
  let partUrls: { partNumber: number; url: string; start: number; end: number }[] = [];

  try {
    if (plan.kind === "single") {
      uploadUrl = await store.storage.createSignedUploadUrl(storageKey, { expiresIn: UPLOAD_SECONDS });
    } else {
      const mp = await store.storage.createMultipartUpload(storageKey, { contentType: mimeType });
      multipartUploadId = mp.uploadId;
      partUrls = await Promise.all(
        Array.from({ length: plan.partCount }, (_, i) => i + 1).map(async (partNumber) => ({
          partNumber,
          url: await store.storage.signUploadPart(storageKey, mp.uploadId, partNumber, {
            expiresIn: UPLOAD_SECONDS,
          }),
          start: (partNumber - 1) * plan.partBytes,
          end: Math.min(partNumber * plan.partBytes, plan.totalBytes),
        })),
      );
    }
  } catch (e) {
    return NextResponse.json(
      { error: `Storage would not accept this recording: ${(e as Error).message}` },
      { status: (e as { status?: number }).status ?? 502 },
    );
  }

  const { error: insertError } = await db.from("interview_media").insert({
    id: mediaId,
    customer_id: interview.customer_id,
    project_id: interview.project_id,
    interview_id: interview.id,
    response_id: null,
    question_id: questionId,
    kind,
    storage_provider: store.storage.name,
    storage_key: storageKey,
    mime_type: mimeType,
    file_size: bytes || null,
    upload_status: "uploading",
    multipart_upload_id: multipartUploadId,
    client_token: clientToken,
    recorded_by: ctx.user.userId,
  });
  if (insertError) {
    /* nothing was uploaded, so the multipart is abandoned rather than left to be billed for */
    if (multipartUploadId) {
      await store.storage.abortMultipartUpload(storageKey, multipartUploadId).catch(() => {});
    }
    return NextResponse.json({ error: "We could not start the recording. Please try again." }, { status: 503 });
  }

  /*
   * Written after the media row because the list references it, and not rolled
   * back if it fails: a recording with no participants is recoverable — the
   * researcher ticks the boxes again — while a lost recording is not.
   */
  let participantWarning: string | null = null;
  if (participants.length) {
    const saved = await setParticipants(mediaId, participants, ctx.user.userId);
    if (!saved.ok) participantWarning = "The recording started, but the participant list did not save.";
  }

  return NextResponse.json({
    ok: true,
    mediaId,
    kind: plan.kind,
    uploadUrl,
    partUrls,
    partBytes: plan.partBytes,
    partCount: plan.partCount,
    warning: participantWarning,
  });
}
