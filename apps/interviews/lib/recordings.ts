import "server-only";
import { NextRequest, NextResponse } from "next/server";
import {
  COMPLETION_SAY, checkAfterAssembly, checkBeforeAssembly, completionReason,
  isParticipantRole, type Participant, type ParticipantRole,
} from "@rescript/interviews";
import { PLAYBACK_SECONDS, type CompletedPart } from "@rescript/storage";
import { supabaseAdmin } from "./admin";
import {
  isFailure, requireProject, type GuardFailure, type InterviewCapability, type ProjectContext,
} from "./auth";
import { storageOrResponse } from "./storage";

/**
 * REACHING A RECORDING, WITH THE PROJECT'S PERMISSIONS ATTACHED.
 *
 * Every route that touches one media row asks the same two questions in the
 * same order — does it exist, and may this person do this to it — and the
 * order matters: the project is discovered FROM the recording, so the
 * permission check cannot be skipped by naming a recording in a project the
 * caller has no role in.
 *
 * It lives here rather than in each route because §18 turns on it. A signed
 * playback URL, a participant edit and a deletion are three routes with one
 * rule between them, and a rule written three times is a rule that will be
 * written differently twice.
 */

export interface MediaContext extends ProjectContext {
  media: {
    id: string;
    customer_id: string;
    project_id: string;
    interview_id: string | null;
    response_id: string | null;
    question_id: string | null;
    kind: string;
    storage_provider: string;
    storage_key: string;
    mime_type: string | null;
    file_size: number | null;
    duration_seconds: number | null;
    upload_status: string;
    processing_status: string;
    /** set while a multipart upload is in flight, so an interrupted one can resume */
    multipart_upload_id: string | null;
    client_token: string | null;
    deleted_at: string | null;
    recorded_by: string | null;
    created_at: string;
  };
}

export async function requireMedia(
  req: NextRequest, mediaId: string, capability: InterviewCapability,
): Promise<MediaContext | GuardFailure> {
  const db = supabaseAdmin();
  const { data: media, error } = await db
    .from("interview_media")
    .select("id, customer_id, project_id, interview_id, response_id, question_id, kind, storage_provider, storage_key, mime_type, file_size, duration_seconds, upload_status, processing_status, multipart_upload_id, client_token, deleted_at, recorded_by, created_at")
    .eq("id", mediaId)
    .maybeSingle();

  if (error) {
    return { response: NextResponse.json(
      { error: "We could not look that recording up. Please try again." }, { status: 503 }) };
  }
  /*
   * A deleted recording is GONE, not forbidden — 404 for both, so a stale link
   * and a link to somebody else's project are indistinguishable from outside.
   * §18 asks that a deleted recording cannot be reached through a stale URL,
   * and this is the half of that which lives in the application; the other
   * half is that signed URLs are minutes long, below.
   */
  if (!media || media.deleted_at) {
    return { response: NextResponse.json({ error: "That recording does not exist." }, { status: 404 }) };
  }

  const project = await requireProject(req, media.project_id, capability);
  if (isFailure(project)) return project;

  return { ...project, media: media as MediaContext["media"] };
}

/* ------------------------------------------------------------ playback */

/**
 * A URL that plays this recording, and stops working shortly.
 *
 * Fifteen minutes (`PLAYBACK_SECONDS`) is long enough to watch a long answer
 * and short enough that a URL pasted into a ticket is dead before anybody
 * clicks it. The bucket is private and has no public access, so this signature
 * is the only way in — which is the point: revoking somebody's access to a
 * project revokes their recordings at the next page load rather than at the
 * expiry of a link nobody can recall.
 *
 * Deliberately NOT cached anywhere. A cached signed URL outlives the
 * permission check that produced it.
 */
export async function playbackUrl(ctx: MediaContext): Promise<
  { ok: true; url: string; expiresIn: number } | { ok: false; response: NextResponse }
> {
  if (ctx.media.upload_status !== "stored") {
    return { ok: false, response: NextResponse.json(
      { error: "That recording has not finished uploading yet.", status: ctx.media.upload_status },
      { status: 409 }) };
  }
  const store = storageOrResponse();
  if ("response" in store) return { ok: false, response: store.response };

  try {
    const url = await store.storage.createSignedDownloadUrl(ctx.media.storage_key, {
      expiresIn: PLAYBACK_SECONDS,
    });
    return { ok: true, url, expiresIn: PLAYBACK_SECONDS };
  } catch (e) {
    return { ok: false, response: NextResponse.json(
      { error: `Storage would not release that recording: ${(e as Error).message}` },
      { status: (e as { status?: number }).status ?? 502 }) };
  }
}

/* ---------------------------------------------------- finishing an upload */

export interface AssembleInput {
  storage: {
    listUploadedParts(key: string, uploadId: string): Promise<CompletedPart[]>;
    completeMultipartUpload(key: string, uploadId: string, parts: CompletedPart[]): Promise<unknown>;
    getMetadata(key: string): Promise<{ size: number; contentType: string | null } | null>;
  };
  storageKey: string;
  multipartUploadId: string | null;
  /** the size the browser declared at `begin`, which is how many parts are owed */
  declaredBytes: number | null;
  /** what the browser says it uploaded; checked against the store, never trusted */
  claimedParts: readonly CompletedPart[];
  /** called before every refusal, so the row records why rather than only the caller */
  onFailure: (reason: string) => Promise<void>;
}

/**
 * ASSEMBLE A MULTIPART UPLOAD AND PROVE THE OBJECT IS THERE.
 *
 * Extracted from the candidate route rather than copied for the moderated one.
 * This is the piece where a real bug lived — a completion that assembled
 * whatever parts happened to be present marked a truncated recording "saved",
 * and a truncated video plays perfectly, so nobody found out — and two copies
 * of it would be two chances to lose that fix.
 *
 * Three refusals, in order of how badly they would end:
 *
 *   1. the store holds FEWER parts than the declared size implies. That is a
 *      short recording, and it is refused before anything is assembled;
 *   2. no parts at all reached the store;
 *   3. the object is absent, or empty, after the store said the upload
 *      completed. `getMetadata` is a HEAD against the real bucket and is the
 *      only thing in this system permitted to move a recording to `stored` —
 *      the client's word is never enough.
 *
 * It takes a storage-shaped object rather than the provider type so the whole
 * thing can be exercised against `MemoryStorageProvider` with no database.
 */
export async function assembleAndVerify(
  input: AssembleInput,
): Promise<{ ok: true; size: number; contentType: string | null } | { ok: false; response: NextResponse }> {
  const { storage, storageKey, multipartUploadId } = input;

  /*
   * The DECISIONS are in `@rescript/interviews` — pure, and tested against a
   * real object store in Node. This function does the I/O around them and
   * turns a verdict into an HTTP answer; it deliberately makes no judgement of
   * its own, so the candidate path and the moderated path cannot come to
   * different conclusions about the same upload.
   */
  let knownParts: CompletedPart[] | null = null;
  if (multipartUploadId) {
    try {
      knownParts = await storage.listUploadedParts(storageKey, multipartUploadId);
    } catch {
      /* an upload the store has forgotten: `null` means "could not ask" */
      knownParts = null;
    }
  }

  const before = checkBeforeAssembly({
    multipartUploadId,
    knownParts,
    claimedParts: input.claimedParts,
    declaredBytes: input.declaredBytes,
  });
  if (!before.ok) {
    await input.onFailure(completionReason(before));
    return { ok: false, response: NextResponse.json(
      { error: COMPLETION_SAY[before.code], resumable: true }, { status: 409 }) };
  }

  if (multipartUploadId && before.parts) {
    try {
      await storage.completeMultipartUpload(storageKey, multipartUploadId, before.parts);
    } catch (e) {
      await input.onFailure((e as Error).message);
      return { ok: false, response: NextResponse.json(
        { error: "Your recording could not be assembled. Please try again." },
        { status: (e as { status?: number }).status ?? 502 }) };
    }
  }

  let meta: { size: number; contentType: string | null } | null = null;
  try {
    meta = await storage.getMetadata(storageKey);
  } catch (e) {
    /*
     * 503, not 409. We could not CHECK — which is not evidence the recording is
     * missing, and telling somebody their interview was lost because a HEAD
     * timed out is the worst available answer.
     */
    return { ok: false, response: NextResponse.json(
      { error: `We could not confirm your recording: ${(e as Error).message}` }, { status: 503 }) };
  }

  const after = checkAfterAssembly(meta);
  if (!after.ok) {
    await input.onFailure(completionReason(after));
    return { ok: false, response: NextResponse.json(
      { error: COMPLETION_SAY[after.code], resumable: true }, { status: 409 }) };
  }

  return { ok: true, size: after.size, contentType: after.contentType };
}

/** The browser's part list, cleaned. Anything malformed is dropped rather than trusted. */
export function readClaimedParts(raw: unknown): CompletedPart[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p: { partNumber?: unknown; etag?: unknown }) => ({
      partNumber: Number(p?.partNumber),
      etag: String(p?.etag ?? "").replace(/^"|"$/g, ""),
    }))
    .filter((p) => Number.isInteger(p.partNumber) && p.partNumber > 0 && !!p.etag);
}

/* -------------------------------------------------------- participants */

export interface ParticipantRow {
  person_id: string;
  display_name: string;
  email: string | null;
  role: string;
  user_id: string | null;
  derived: boolean;
  speaker_label: string | null;
}

/** Who is in one recording, in reading order, straight from the database function. */
export async function participantsOf(mediaId: string): Promise<Participant[]> {
  const db = supabaseAdmin();
  const { data } = await db.rpc("rescript_interview_recording_participants", { p_media: mediaId });
  const rows = (Array.isArray(data) ? data : []) as ParticipantRow[];
  return rows.map((r) => ({
    id: r.person_id,
    displayName: r.display_name,
    email: r.email,
    userId: r.user_id,
    derived: r.derived,
    role: (isParticipantRole(r.role) ? r.role : "observer") as ParticipantRole,
    speakerLabel: r.speaker_label,
  }));
}

/**
 * Replace a recording's participant list.
 *
 * The validation that matters — that a person belongs to this recording's
 * project — is in `rescript_interview_set_participants`, not here. That is
 * deliberate: it is the check that stops a name leaking between projects, and
 * a check in one of several callers is a check the next caller forgets. This
 * function's job is to turn a refusal into an HTTP answer.
 */
export async function setParticipants(
  mediaId: string,
  list: readonly { personId: string; role: string }[],
  actorUserId: string | null,
): Promise<{ ok: true; count: number } | { ok: false; response: NextResponse }> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("rescript_interview_set_participants", {
    p_media: mediaId,
    p_people: list.map((p) => p.personId),
    p_roles: list.map((p) => p.role),
    p_actor: actorUserId,
  });

  if (error) {
    /*
     * The database's message is the useful one — "person X does not belong to
     * this recording's project" tells a programmer exactly what happened. It is
     * safe to return: the id in it is one the caller just sent.
     */
    return { ok: false, response: NextResponse.json(
      { error: error.message || "That participant list could not be saved." }, { status: 409 }) };
  }
  return { ok: true, count: typeof data === "number" ? data : list.length };
}
