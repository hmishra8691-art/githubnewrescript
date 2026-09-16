import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { candidateGate, isCandidateFailure, touchInterview } from "@/lib/candidate";
import { storageOrResponse } from "@/lib/storage";
import { planUpload, type CompletedPart } from "@rescript/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * FINISH AN UPLOAD — BY ASKING THE STORE, NOT THE BROWSER.
 *
 * This is the route §9 is about: *"do not allow the user to believe an answer
 * is safely stored until upload verification has completed"*. The browser
 * saying it finished is a claim. `getMetadata` returning a size is a fact,
 * and only the fact is allowed to move a response to `stored`.
 *
 * The two are genuinely different. A PUT can return 200 to a browser and the
 * object still not be readable — a proxy that buffered and then failed, a
 * multipart completion that answered 200 with an `<Error>` inside it (S3 does
 * this, and the provider checks for it). A product that trusts the client
 * here ships interviews with no recordings in them and finds out from the
 * candidate.
 *
 * ## What is stored is what the STORE says
 *
 * `file_size` comes from the HEAD, never from the request body. The client's
 * number is an estimate made before the encoder finished; the store's is what
 * the retention sweep, the storage cap and the bill are computed from, and
 * the three of them disagreeing is a whole category of support ticket.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const gate = await candidateGate(body?.token);
  if (isCandidateFailure(gate)) return gate.response;

  const store = storageOrResponse();
  if ("response" in store) return store.response;
  const db = supabaseAdmin();

  const { data: media } = await db
    .from("interview_media")
    .select("id, response_id, storage_key, multipart_upload_id, upload_status, kind, mime_type, file_size")
    .eq("id", String(body?.mediaId ?? ""))
    .eq("interview_id", gate.interview.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!media) return NextResponse.json({ error: "That recording is not part of this interview." }, { status: 404 });

  /* already verified: answer the same thing again rather than doing it twice */
  if (media.upload_status === "stored") {
    return NextResponse.json({ ok: true, mediaId: media.id, alreadyStored: true });
  }

  /* ---- assemble the parts, when there are parts */
  if (media.multipart_upload_id) {
    const parts: CompletedPart[] = Array.isArray(body?.parts)
      ? body.parts
          .map((p: { partNumber?: unknown; etag?: unknown }) => ({
            partNumber: Number(p?.partNumber),
            etag: String(p?.etag ?? "").replace(/^"|"$/g, ""),
          }))
          .filter((p: CompletedPart) => Number.isInteger(p.partNumber) && p.partNumber > 0 && p.etag)
      : [];
    /*
     * The browser's list is checked against the store's rather than trusted.
     * A part the browser thinks it sent and the store has no record of would
     * otherwise produce a completion that fails with an unhelpful S3 error;
     * asking first means the failure is ours and says which part is missing.
     */
    let known: CompletedPart[] = [];
    try {
      known = await store.storage.listUploadedParts(media.storage_key, media.multipart_upload_id);
    } catch { /* an older upload the store has forgotten: fall through to the completion */ }

    /*
     * DEFENCE IN DEPTH: refuse to assemble a recording that is short.
     *
     * The client now verifies against the store before completing, but this
     * route must not depend on the client being correct — assembling
     * whatever happens to be there is how a truncated answer gets marked
     * saved, and a truncated video plays perfectly well, so nobody finds out.
     * The expected part count comes from the size the browser declared at
     * `begin`, which is written on the row.
     */
    if (known.length && media.file_size) {
      const expected = planUpload(Number(media.file_size)).partCount;
      if (known.length < expected) {
        await markFailed(media.id, media.response_id,
          `only ${known.length} of ${expected} parts reached storage`);
        return NextResponse.json(
          { error: "Part of your recording did not reach us. Please try again.", resumable: true },
          { status: 409 },
        );
      }
    }

    const use = known.length ? known : parts;
    if (!use.length) {
      await markFailed(media.id, media.response_id, "no parts reached storage");
      return NextResponse.json(
        { error: "None of your recording reached us. Please try again." }, { status: 409 },
      );
    }
    try {
      await store.storage.completeMultipartUpload(media.storage_key, media.multipart_upload_id, use);
    } catch (e) {
      await markFailed(media.id, media.response_id, (e as Error).message);
      return NextResponse.json(
        { error: "Your recording could not be assembled. Please try again." },
        { status: (e as { status?: number }).status ?? 502 },
      );
    }
  }

  /* ---- the verification the whole route exists for */
  let meta: { size: number; contentType: string | null } | null = null;
  try {
    meta = await store.storage.getMetadata(media.storage_key);
  } catch (e) {
    return NextResponse.json(
      { error: `We could not confirm your recording: ${(e as Error).message}` }, { status: 503 },
    );
  }
  if (!meta || meta.size <= 0) {
    await markFailed(media.id, media.response_id, "the object is not in the store after upload");
    return NextResponse.json(
      { error: "Your recording did not reach us. Please try again." }, { status: 409 },
    );
  }

  const durationSeconds = Number(body?.durationSeconds);
  await db.from("interview_media").update({
    upload_status: "stored",
    file_size: meta.size,
    mime_type: meta.contentType ?? media.mime_type,
    duration_seconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
    uploaded_at: new Date().toISOString(),
    multipart_upload_id: null,
    error: null,
  }).eq("id", media.id);

  if (media.kind !== "answer_audio") {
    await db.from("interview_responses").update({
      status: "stored",
      stored_at: new Date().toISOString(),
      recorded_at: new Date().toISOString(),
      duration_seconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null,
      error: null,
    }).eq("id", media.response_id);
  }

  /*
   * The audio companion is what gets transcribed — a 36 MB video is not
   * something to hand a speech-to-text provider that accepts 25 MB. Queueing
   * happens in Phase 3; the row is created here so a job runner has something
   * to find, and `idempotency_key` means creating it twice is free.
   */
  if (media.kind === "answer_audio") {
    await db.from("interview_transcripts").upsert({
      media_id: media.id,
      interview_id: gate.interview.id,
      project_id: gate.project.id,
      response_id: media.response_id,
      status: "waiting",
    }, { onConflict: "media_id", ignoreDuplicates: true });
  }

  await touchInterview(gate);
  return NextResponse.json({ ok: true, mediaId: media.id, bytes: meta.size, verified: true });

  async function markFailed(mediaId: string, responseId: string | null, reason: string) {
    await db.from("interview_media")
      .update({ upload_status: "failed", error: reason.slice(0, 500) }).eq("id", mediaId);
    if (responseId) {
      await db.from("interview_responses")
        .update({ status: "failed", error: reason.slice(0, 500) }).eq("id", responseId);
    }
  }
}
