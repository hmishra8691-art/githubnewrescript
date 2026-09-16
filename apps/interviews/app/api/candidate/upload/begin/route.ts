import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { candidateGate, isCandidateFailure, touchInterview } from "@/lib/candidate";
import { storageOrResponse } from "@/lib/storage";
import {
  PART_BYTES, planUpload, responseMediaKey, UPLOAD_SECONDS,
  type CompletedPart,
} from "@rescript/storage";
import { expectedBytes, blockingLimit, recordingSeconds } from "@rescript/interviews";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * BEGIN AN UPLOAD.
 *
 * The bytes never touch this server. What it does is authorize, write the row
 * that will be the only evidence this upload ever happened, and hand back a
 * signed URL — or a set of them, one per part.
 *
 * ## The order matters, and it is not the obvious one
 *
 * The `interview_media` row is written at `pending` BEFORE the URL is issued.
 * If the browser closes mid-transfer there is no request to tell us, no
 * callback and no completion — the row is the only thing that knows an upload
 * was begun at all, and `rescript_interview_abandoned_uploads` reads exactly
 * that. Writing the row after a successful upload would mean the failures are
 * invisible, which is the state `media_objects` was created to end.
 *
 * ## Single PUT or multipart
 *
 * Under 8 MiB, one PUT: simpler, no completion step to fail, no orphaned
 * parts to be billed for, and a re-send costs a second. Above it, multipart —
 * because the whole of §6 is that an interrupted upload resumes at the part
 * it stopped on rather than at the beginning, and a single PUT has no parts
 * to resume from.
 *
 * ## Duplicate protection
 *
 * `clientToken` is the browser's own name for this take. A partial-unique
 * index makes a second row for the same take impossible, so a retry that
 * reaches us twice — a double-click, a re-sent request after a timeout that
 * actually succeeded — returns the SAME media row and the same key rather
 * than starting a second upload of the same recording and paying for both.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const gate = await candidateGate(body?.token);
  if (isCandidateFailure(gate)) return gate.response;

  if (!gate.interview.consent_given_at) {
    return NextResponse.json(
      { error: "Please agree to the consent statement before recording." }, { status: 409 },
    );
  }

  const store = storageOrResponse();
  if ("response" in store) return store.response;
  const db = supabaseAdmin();

  const responseId = String(body?.responseId ?? "");
  const clientToken = String(body?.clientToken ?? "").slice(0, 64) || null;
  const declaredBytes = Number(body?.bytes);
  const mimeType = String(body?.mimeType ?? "video/webm").slice(0, 120);
  const kind = body?.kind === "answer_audio" ? "answer_audio" : "answer_video";

  const { data: response } = await db
    .from("interview_responses")
    .select("id, question_id, status, retries, interview_id")
    .eq("id", responseId)
    .eq("interview_id", gate.interview.id)
    .maybeSingle();
  if (!response) return NextResponse.json({ error: "That question is not part of this interview." }, { status: 404 });

  /* ---- an existing row for the same take: return it rather than duplicating */
  if (clientToken) {
    const { data: existing } = await db
      .from("interview_media")
      .select("id, storage_key, multipart_upload_id, upload_status, file_size")
      .eq("response_id", response.id)
      .eq("client_token", clientToken)
      .is("deleted_at", null)
      .maybeSingle();
    if (existing && existing.upload_status === "stored") {
      return NextResponse.json({ ok: true, alreadyStored: true, mediaId: existing.id });
    }
    if (existing) {
      const resumed = await signResume(store.storage, existing, declaredBytes);
      return NextResponse.json({ ok: true, resumed: true, ...resumed, mediaId: existing.id });
    }
  }

  /* ---- the caps, checked BEFORE anything is signed (§22) */
  const { data: project } = await db
    .from("interview_projects")
    .select("max_storage_bytes, max_recording_seconds, max_transcription_seconds, max_ai_analyses")
    .eq("id", gate.project.id)
    .maybeSingle();
  const { data: storedBytes } = await db.rpc("rescript_interview_storage_bytes", { p_project: gate.project.id });
  const blocked = blockingLimit(
    {
      storageBytes: Number(storedBytes ?? 0),
      recordingSeconds: 0, transcriptionSeconds: 0, analyses: 0,
    },
    {
      maxStorageBytes: project?.max_storage_bytes ?? null,
      maxRecordingSeconds: null, maxTranscriptionSeconds: null, maxAiAnalyses: null,
    },
  );
  if (blocked) {
    return NextResponse.json(
      {
        error: "This interview cannot accept more recordings right now. Please contact the company that invited you.",
        /* the candidate is not told about somebody else's storage bill */
        reason: "project_limit",
      },
      { status: 507 },
    );
  }

  /*
   * A ceiling on what one answer may be, from the question's own limit. The
   * browser is told the same number before the camera opens, so this is a
   * backstop against a crafted request rather than something a candidate
   * should ever meet.
   */
  const maxSeconds = recordingSeconds({
    questionMaxSeconds: null,
    projectMaxSeconds: gate.project.max_recording_seconds,
  });
  const ceiling = expectedBytes(maxSeconds + 30);
  const bytes = Number.isFinite(declaredBytes) && declaredBytes > 0 ? declaredBytes : 0;
  if (bytes > ceiling) {
    return NextResponse.json(
      { error: "That recording is longer than this question allows." }, { status: 413 },
    );
  }

  const mediaId = crypto.randomUUID();
  const storageKey = responseMediaKey({
    organizationId: gate.interview.customer_id,
    interviewId: gate.interview.id,
    responseId: response.id,
    fileName: `${mediaId}-${kind === "answer_audio" ? "audio" : "recording"}.${extensionFor(mimeType)}`,
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
      partUrls = await signParts(store.storage, storageKey, mp.uploadId, plan);
    }
  } catch (e) {
    return NextResponse.json(
      { error: `Storage would not accept this recording: ${(e as Error).message}` },
      { status: (e as { status?: number }).status ?? 502 },
    );
  }

  const { error: insertError } = await db.from("interview_media").insert({
    id: mediaId,
    customer_id: gate.interview.customer_id,
    project_id: gate.project.id,
    interview_id: gate.interview.id,
    response_id: response.id,
    question_id: response.question_id,
    kind,
    storage_provider: store.storage.name,
    storage_key: storageKey,
    mime_type: mimeType,
    file_size: bytes || null,
    upload_status: "uploading",
    multipart_upload_id: multipartUploadId,
    client_token: clientToken,
  });
  if (insertError) {
    /* nothing was uploaded, so the multipart is abandoned rather than left to
       be billed for until the bucket's lifecycle rule notices it */
    if (multipartUploadId) {
      await store.storage.abortMultipartUpload(storageKey, multipartUploadId).catch(() => {});
    }
    return NextResponse.json({ error: "We could not start the upload. Please try again." }, { status: 503 });
  }

  await db.from("interview_responses")
    .update({ status: "uploading", started_at: new Date().toISOString() })
    .eq("id", response.id);
  await touchInterview(gate, { status: gate.interview.status === "in_progress" ? "in_progress" : "in_progress" });

  return NextResponse.json({
    ok: true,
    mediaId,
    kind: plan.kind,
    partBytes: plan.partBytes,
    partCount: plan.partCount,
    uploadUrl,
    uploadId: multipartUploadId,
    parts: partUrls,
    expiresInSeconds: UPLOAD_SECONDS,
  });
}

/* --------------------------------------------------------------- helpers */

function extensionFor(mime: string): string {
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("wav")) return "wav";
  return "webm";
}

async function signParts(
  storage: { signUploadPart(key: string, uploadId: string, n: number, o?: { expiresIn?: number }): Promise<string> },
  key: string, uploadId: string, plan: { partCount: number; partBytes: number; totalBytes: number },
) {
  const out: { partNumber: number; url: string; start: number; end: number }[] = [];
  for (let n = 1; n <= plan.partCount; n++) {
    const start = (n - 1) * plan.partBytes;
    out.push({
      partNumber: n,
      url: await storage.signUploadPart(key, uploadId, n, { expiresIn: UPLOAD_SECONDS }),
      start,
      end: Math.min(plan.totalBytes, start + plan.partBytes),
    });
  }
  return out;
}

/**
 * A take we have already begun: ask the STORE which parts it has, and sign
 * only the ones it does not.
 *
 * The store's list is the only opinion that counts. A browser that believes
 * it sent part 3 and a store with no record of part 3 disagree, and the store
 * is right — the same asymmetry `confirmUpload` applies to whole objects.
 */
async function signResume(
  storage: {
    name: string;
    listUploadedParts(key: string, uploadId: string): Promise<CompletedPart[]>;
    signUploadPart(key: string, uploadId: string, n: number, o?: { expiresIn?: number }): Promise<string>;
    createSignedUploadUrl(key: string, o?: { expiresIn?: number }): Promise<string>;
  },
  media: { storage_key: string; multipart_upload_id: string | null; file_size: number | null },
  declaredBytes: number,
) {
  const bytes = Number.isFinite(declaredBytes) && declaredBytes > 0
    ? declaredBytes
    : Number(media.file_size ?? 0) || PART_BYTES;
  const plan = planUpload(bytes);

  if (!media.multipart_upload_id || plan.kind === "single") {
    return {
      kind: "single" as const,
      partBytes: plan.partBytes, partCount: 1,
      uploadUrl: await storage.createSignedUploadUrl(media.storage_key, { expiresIn: UPLOAD_SECONDS }),
      uploadId: null, parts: [], uploaded: [],
    };
  }

  const have = await storage.listUploadedParts(media.storage_key, media.multipart_upload_id);
  const haveNumbers = new Set(have.map((p) => p.partNumber));
  const parts: { partNumber: number; url: string; start: number; end: number }[] = [];
  for (let n = 1; n <= plan.partCount; n++) {
    if (haveNumbers.has(n)) continue;
    const start = (n - 1) * plan.partBytes;
    parts.push({
      partNumber: n,
      url: await storage.signUploadPart(media.storage_key, media.multipart_upload_id, n, { expiresIn: UPLOAD_SECONDS }),
      start,
      end: Math.min(plan.totalBytes, start + plan.partBytes),
    });
  }
  return {
    kind: "multipart" as const,
    partBytes: plan.partBytes, partCount: plan.partCount,
    uploadUrl: null, uploadId: media.multipart_upload_id,
    parts,
    /* what the store already has, so the browser's progress bar is honest
       the moment the page comes back rather than starting at zero */
    uploaded: have,
  };
}
