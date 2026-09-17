import { NextRequest, NextResponse } from "next/server";
import { PART_BYTES, UPLOAD_SECONDS, planUpload, remainingParts, safeKeySegment } from "@rescript/storage";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireProject } from "@/lib/auth";
import { assembleAndVerify, readClaimedParts } from "@/lib/recordings";
import { enqueue } from "@/lib/runner";
import { storageOrResponse } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * THE INTERVIEWER ASKING — RECORDED, STORED, ATTACHED TO THE QUESTION.
 *
 * `interview_questions.prompt_media_id` and the `question_prompt` media kind
 * have existed since 0030 with zero code references. Nothing wrote a clip,
 * nothing attached one, nothing played one. This is the write path; the
 * candidate's `/api/candidate/prompt` route is the read path; `Interview.tsx`
 * is the player.
 *
 * ## One route, three steps
 *
 * `?step=begin|parts|complete`, driven by the same `RecordingUploader` the
 * candidate and the moderated session use — it takes custom endpoints, so the
 * browser half of the protocol is reused wholesale and this route is only the
 * server half. The three steps share one file because they share one
 * authorization (`questions.edit` on this project), one key scheme and one
 * media row, and three files would be three places to get one of those wrong.
 *
 * ## Where the object lives
 *
 * `organizations/<org>/projects/<project>/prompts/<question>/<media>.<ext>` —
 * under the organization prefix like everything else, so the retention and
 * orphan sweeps that walk that prefix see it, but NOT under any interview,
 * because it belongs to none. A clip is project content; a candidate's
 * recording is candidate data with a retention clock. They must not share a
 * deletion path.
 *
 * ## Replacing a clip
 *
 * A new `begin` for a question that already has a stored clip supersedes it:
 * the old row is marked deleted so the sweep removes the bytes, and the
 * question points at the new one only once it has been verified `stored`.
 * Between begin and complete the question keeps its old clip, so a browser
 * that closes mid-upload leaves the interview exactly as it was.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; questionId: string } },
) {
  const gate = await requireProject(req, params.id, "questions.edit");
  if (isFailure(gate)) return gate.response;

  const step = req.nextUrl.searchParams.get("step") ?? "begin";
  const body = await req.json().catch(() => ({}));
  const db = supabaseAdmin();

  const { data: question } = await db.from("interview_questions")
    .select("id, code, prompt_media_id")
    .eq("id", params.questionId).eq("project_id", params.id).is("archived_at", null)
    .maybeSingle();
  if (!question) return NextResponse.json({ error: "No such question." }, { status: 404 });

  const store = storageOrResponse();
  if ("response" in store) return store.response;

  /* ------------------------------------------------------------ begin */
  if (step === "begin") {
    const mimeType = String(body?.mimeType ?? "video/webm").slice(0, 120);
    const declared = Number(body?.bytes);
    const bytes = Number.isFinite(declared) && declared > 0 ? declared : 0;
    const clientToken = String(body?.clientToken ?? "").slice(0, 64) || null;

    if (clientToken) {
      const { data: already } = await db.from("interview_media")
        .select("id, upload_status").eq("question_id", question.id).eq("kind", "question_prompt")
        .eq("client_token", clientToken).is("deleted_at", null).maybeSingle();
      if (already && already.upload_status !== "failed") {
        return NextResponse.json({ ok: true, mediaId: already.id, duplicate: true });
      }
    }

    const mediaId = crypto.randomUUID();
    const ext = mimeType.includes("mp4") ? "mp4" : mimeType.startsWith("audio/") ? "weba" : "webm";
    const storageKey = [
      "organizations", safeKeySegment(gate.project.customer_id),
      "projects", safeKeySegment(params.id),
      "prompts", safeKeySegment(question.id),
      `${mediaId}.${ext}`,
    ].join("/");

    const plan = planUpload(bytes || PART_BYTES);
    let multipartUploadId: string | null = null;
    let uploadUrl: string | null = null;
    let parts: { partNumber: number; url: string }[] = [];
    try {
      if (plan.kind === "single") {
        uploadUrl = await store.storage.createSignedUploadUrl(storageKey, { expiresIn: UPLOAD_SECONDS });
      } else {
        const mp = await store.storage.createMultipartUpload(storageKey, { contentType: mimeType });
        multipartUploadId = mp.uploadId;
        parts = await Promise.all(Array.from({ length: plan.partCount }, (_, i) => i + 1).map(async (n) => ({
          partNumber: n,
          url: await store.storage.signUploadPart(storageKey, mp.uploadId, n, { expiresIn: UPLOAD_SECONDS }),
        })));
      }
    } catch (e) {
      return NextResponse.json(
        { error: `Storage would not accept this recording: ${(e as Error).message}` },
        { status: (e as { status?: number }).status ?? 502 },
      );
    }

    const { error } = await db.from("interview_media").insert({
      id: mediaId,
      customer_id: gate.project.customer_id,
      project_id: params.id,
      interview_id: null,
      response_id: null,
      question_id: question.id,
      kind: "question_prompt",
      storage_provider: store.storage.name,
      storage_key: storageKey,
      mime_type: mimeType,
      file_size: bytes || null,
      upload_status: "uploading",
      multipart_upload_id: multipartUploadId,
      client_token: clientToken,
      recorded_by: gate.user.userId,
    });
    if (error) return NextResponse.json({ error: "We could not start saving that clip." }, { status: 503 });

    return NextResponse.json({
      ok: true, mediaId, kind: plan.kind, partBytes: plan.partBytes, partCount: plan.partCount,
      uploadUrl, uploadId: multipartUploadId, parts,
    });
  }

  /* the remaining steps name a media row that must be THIS question's prompt */
  const mediaId = String(body?.mediaId ?? "");
  const { data: media } = await db.from("interview_media")
    .select("id, storage_key, multipart_upload_id, upload_status, file_size, mime_type")
    .eq("id", mediaId).eq("question_id", question.id).eq("kind", "question_prompt").is("deleted_at", null)
    .maybeSingle();
  if (!media) return NextResponse.json({ error: "No such upload." }, { status: 404 });

  /* ------------------------------------------------------------ parts */
  if (step === "parts") {
    if (!media.multipart_upload_id) return NextResponse.json({ ok: true, complete: media.upload_status === "stored", uploaded: [], parts: [] });
    let known;
    try {
      known = await store.storage.listUploadedParts(media.storage_key, media.multipart_upload_id);
    } catch (e) {
      return NextResponse.json({ error: `We could not check what has arrived: ${(e as Error).message}` }, { status: 503 });
    }
    const plan = planUpload(Number(media.file_size ?? 0) || 0);
    const missing = remainingParts(plan, known);
    const parts = await Promise.all(missing.map(async (p) => ({
      partNumber: p.partNumber,
      url: await store.storage.signUploadPart(media.storage_key, media.multipart_upload_id!, p.partNumber, { expiresIn: UPLOAD_SECONDS }),
    })));
    return NextResponse.json({ ok: true, complete: parts.length === 0, uploaded: known, parts });
  }

  /* --------------------------------------------------------- complete */
  if (step === "complete") {
    if (media.upload_status === "stored") {
      return NextResponse.json({ ok: true, mediaId: media.id, alreadyStored: true });
    }
    const verified = await assembleAndVerify({
      storage: store.storage,
      storageKey: media.storage_key,
      multipartUploadId: media.multipart_upload_id ?? null,
      declaredBytes: media.file_size,
      partsReleased: Number.isFinite(Number(body?.partsReleased)) ? Number(body.partsReleased) : null,
      claimedParts: readClaimedParts(body?.parts),
      onFailure: async (reason) => {
        await db.from("interview_media").update({ upload_status: "failed", error: reason.slice(0, 500) }).eq("id", media.id);
      },
    });
    if (!verified.ok) return verified.response;

    const now = new Date().toISOString();
    const duration = Number(body?.durationSeconds);
    await db.from("interview_media").update({
      upload_status: "stored", file_size: verified.size, stored_at: now,
      duration_seconds: Number.isFinite(duration) && duration > 0 ? duration : null,
      multipart_upload_id: null,
    }).eq("id", media.id);

    /*
     * ATTACH, AND RETIRE THE PREVIOUS CLIP.
     *
     * The question points at the new clip only now, after the HEAD proved it
     * exists. The old one is marked deleted rather than removed here — the
     * retention sweep owns object deletion, and it reads keys from rows, so
     * the row has to stay until the bytes are gone.
     */
    if (question.prompt_media_id && question.prompt_media_id !== media.id) {
      await db.from("interview_media")
        .update({ deleted_at: now, upload_status: "deleted", error: "replaced by a newer clip" })
        .eq("id", question.prompt_media_id).is("deleted_at", null);
      await db.from("interview_transcripts").delete().eq("media_id", question.prompt_media_id);
    }
    await db.from("interview_questions").update({ prompt_media_id: media.id, updated_at: now }).eq("id", question.id);

    /*
     * The interviewer's clip is transcribed too — the brief's section 5 wants
     * the question's words alongside the video, and the analysis benefits
     * from knowing what was actually asked rather than what the prompt text
     * says was asked. Same queue, same runner, `response_id: null` because it
     * answers nothing.
     */
    await db.from("interview_transcripts").upsert({
      media_id: media.id, interview_id: null, project_id: params.id, response_id: null, status: "waiting",
    }, { onConflict: "media_id", ignoreDuplicates: true });
    await enqueue({
      kind: "transcription", subjectId: media.id, customerId: gate.project.customer_id,
      projectId: params.id, interviewId: null, priority: 150,
    });

    return NextResponse.json({ ok: true, mediaId: media.id, bytes: verified.size, promptMediaId: media.id });
  }

  return NextResponse.json({ error: "Unknown step." }, { status: 400 });
}

/** Remove the clip from a question without deleting the question. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; questionId: string } },
) {
  const gate = await requireProject(req, params.id, "questions.edit");
  if (isFailure(gate)) return gate.response;
  const db = supabaseAdmin();
  const { data: question } = await db.from("interview_questions")
    .select("id, prompt_media_id").eq("id", params.questionId).eq("project_id", params.id).maybeSingle();
  if (!question) return NextResponse.json({ error: "No such question." }, { status: 404 });
  if (!question.prompt_media_id) return NextResponse.json({ ok: true });

  const now = new Date().toISOString();
  await db.from("interview_media")
    .update({ deleted_at: now, upload_status: "deleted", error: "removed from the question" })
    .eq("id", question.prompt_media_id).is("deleted_at", null);
  await db.from("interview_transcripts").delete().eq("media_id", question.prompt_media_id);
  await db.from("interview_questions").update({ prompt_media_id: null, updated_at: now }).eq("id", question.id);
  return NextResponse.json({ ok: true });
}
