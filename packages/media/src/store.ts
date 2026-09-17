/**
 * THE LIFE OF A RECORDING, AS ROWS.
 *
 * A recording passes through three facts, and each of them is written down
 * before the next one is attempted:
 *
 *   1. someone intends to store one  → `media_objects` row, status `pending`
 *   2. the bytes arrived             → status `stored`, `uploaded_at` set
 *   3. it should be transcribed      → `media_transcripts` row, status `waiting`
 *
 * Writing (1) BEFORE handing out the upload URL is the point. The browser
 * uploads straight to object storage — it has to, because a serverless host
 * refuses a request body of this size long before any route of ours runs — so
 * the application never sees the bytes and cannot infer afterwards that an
 * upload happened. A row at `pending` with no `stored` to follow it is an
 * upload that failed, and it is the only thing that can tell us so.
 *
 * Every function here takes the database as an argument rather than importing
 * a client. That keeps this package free of `server-only` and of
 * `@supabase/supabase-js`, so the whole policy is testable with a stub —
 * which is how the existing upload-cleanup helper is written, and for the
 * same reason.
 */
import {
  MEDIA_KINDS, mediaPath, safeSegment, withinLimit, acceptsType, secondsThatFit,
  type MediaKind, type TranscriptStatus,
} from "./plan.js";
import { mediaUrl, type MediaStores, type ObjectStore, type PartGrant } from "./objectStore.js";
import type { CompletedPart } from "@rescript/storage";

/** How long a playback or download URL minted on demand lives. */
export const PLAYBACK_URL_SECONDS = 15 * 60;

export interface DbError { message: string }
export interface DbResult<T> { data: T | null; error: DbError | null }

/**
 * The slice of the Supabase client this package calls.
 *
 * `from()` is typed loosely on purpose: the query builder is a deeply
 * chained generic type that cannot be restated structurally without either
 * importing the library or writing a worse copy of it. The boundaries of
 * every function below are typed exactly; only the builder in between is not.
 */
export interface MediaDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<DbResult<unknown>>;
  /**
   * Where the bytes live — see `objectStore.ts`. `primary` takes everything
   * new; `byName` finds the store a row says holds it, so nothing already
   * stored has to move.
   */
  stores: MediaStores;
}

/** Everything a store operation needs to know about a row. */
export interface ObjectRef { bucket: string; path: string; storage_provider?: string | null }

export function storeFor(db: MediaDb, ref: { storage_provider?: string | null }): ObjectStore {
  const s = db.stores.byName(ref.storage_provider);
  if (!s) throw new MediaError(`no object store named "${ref.storage_provider}" is configured on this installation`, 501);
  return s;
}

export interface MediaRow {
  id: string;
  customer_id: string;
  survey_id: string;
  question_id: string | null;
  response_id: string | null;
  session_id: string | null;
  kind: MediaKind;
  bucket: string;
  path: string;
  original_filename: string | null;
  mime_type: string | null;
  bytes: number | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  status: "pending" | "stored" | "failed";
  error: string | null;
  uploaded_at: string | null;
  created_at: string;
  storage_provider: string;
  multipart_upload_id: string | null;
  client_token: string | null;
}

export interface TranscriptRow {
  id: string;
  media_id: string;
  survey_id: string;
  status: TranscriptStatus;
  attempts: number;
  text: string | null;
  language: string | null;
  model: string | null;
  provider: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export class MediaError extends Error {
  readonly status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------ buckets */

/**
 * What the PRIMARY store will accept for a bucket, given what this package
 * would like. The Supabase store answers with the project's own ceiling
 * (the history of why is in `objectStore.ts`); the provider store answers
 * with the wish. Kept under its old name for the callers that had it.
 */
export async function ensureBucket(db: MediaDb, bucket: string, maxBytes: number): Promise<number> {
  return db.stores.primary.ceiling(bucket, maxBytes);
}

/** Testing seam, kept for callers; the cache now lives inside the legacy store. */
export function resetBucketCache(): void { /* nothing to forget here any more */ }

/**
 * What storage will really accept for this kind, and how long a take fits.
 */
export async function mediaLimits(db: MediaDb, kind: MediaKind): Promise<{ maxBytes: number; maxSeconds: number }> {
  const spec = MEDIA_KINDS[kind];
  const maxBytes = await db.stores.primary.ceiling(spec.bucket, spec.maxBytes);
  return { maxBytes, maxSeconds: secondsThatFit(kind, maxBytes) };
}

/* ------------------------------------------------------------ upload */

export interface BeginUpload {
  kind: MediaKind;
  customerId: string;
  surveyId: string;
  questionId?: string | null;
  sessionId?: string | null;
  responseId?: string | null;
  /**
   * The key this recording's answer lives under in `responses.answers`.
   *
   * The question id outside a loop, `<questionId>__<iteration>` inside one.
   * Recorded because the server has to be able to put the finished transcript
   * back into the right answer without the browser's help — the browser may
   * have submitted and closed by then.
   */
  answerKey?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  /** What the client says it is about to send; refused here if over the limit. */
  bytes?: number | null;
  durationSeconds?: number | null;
  width?: number | null;
  height?: number | null;
  now?: number;
  /**
   * The browser's name for this take. A second begin with the same token —
   * a double-click, a retried request, a refresh mid-upload — gets THIS
   * upload back (resumed where it stopped) rather than a second object.
   */
  clientToken?: string | null;
}

export interface UploadTicket {
  mediaId: string;
  bucket: string;
  path: string;
  /** which store took it — what the row records */
  storageProvider: string;
  /** "single": PUT the whole object to `uploadUrl`. "multipart": PUT each of `parts`, then confirm with the etags. */
  kind: "single" | "multipart";
  /** PUT the bytes here (single). Valid for two hours. */
  uploadUrl: string | null;
  /** headers the store wants on that PUT, if any */
  uploadHeaders: Record<string, string>;
  uploadId: string | null;
  partBytes: number;
  partCount: number;
  parts: PartGrant[];
  /** parts the store already has, when this is a resume */
  uploaded: CompletedPart[];
  /** the object is already there — a begin repeated after a completed upload */
  alreadyStored: boolean;
  /** kept for older clients; the Supabase store used it, nothing else does */
  token: string;
  maxBytes: number;
}

/**
 * Reserve a place for an object and hand back a URL the browser can PUT to.
 *
 * The signed upload URL is what keeps a 50 MB video out of our own request
 * body. It is minted with the service role and is good for one object at one
 * path, so the browser gains the ability to write exactly the thing we
 * already wrote a row for — and nothing else.
 */
export async function beginUpload(db: MediaDb, req: BeginUpload): Promise<UploadTicket> {
  const spec = MEDIA_KINDS[req.kind];
  if (!spec) throw new MediaError(`unknown media kind ${req.kind}`, 400);

  if (req.mimeType) {
    const verdict = acceptsType(req.kind, req.mimeType);
    if (!verdict.ok) throw new MediaError(verdict.message!, 415);
  }

  const store = db.stores.primary;

  /*
   * The ceiling is settled BEFORE the size is judged, because what the size
   * is judged against comes from the store. Asking the other way round is how
   * a 0.2 MB take came to be refused for being too large.
   */
  const ceiling = await store.ceiling(spec.bucket, spec.maxBytes);
  if (typeof req.bytes === "number" && req.bytes > 0) {
    const verdict = withinLimit(req.kind, req.bytes, ceiling);
    if (!verdict.ok) throw new MediaError(verdict.message!, 413);
  }

  /*
   * THE SAME TAKE TWICE IS ONE UPLOAD. A client token names the take; a row
   * that already carries it is handed back — complete if it is stored,
   * resumed from the parts the store has if it is not — instead of a second
   * row and a second object.
   */
  const clientToken = req.clientToken ? String(req.clientToken).slice(0, 120) : null;
  if (clientToken) {
    const { data: prior } = await db.from("media_objects")
      .select("id, bucket, path, status, storage_provider, multipart_upload_id, bytes")
      .eq("survey_id", req.surveyId).eq("client_token", clientToken).neq("status", "failed")
      .maybeSingle();
    if (prior) {
      const held = storeFor(db, prior);
      const base = {
        mediaId: prior.id as string, bucket: prior.bucket as string, path: prior.path as string,
        storageProvider: prior.storage_provider as string, token: "", maxBytes: ceiling,
        uploadHeaders: {}, uploaded: [] as CompletedPart[], parts: [] as PartGrant[],
      };
      if (prior.status === "stored") {
        return { ...base, kind: "single", uploadUrl: null, uploadId: null, partBytes: 0, partCount: 0, alreadyStored: true };
      }
      if (prior.multipart_upload_id && held.multipart) {
        const bytes = Number(req.bytes) || Number(prior.bytes) || 0;
        const r = await held.resumeUpload(prior.bucket, prior.path, prior.multipart_upload_id, bytes);
        return {
          ...base, kind: "multipart", uploadUrl: null, uploadId: prior.multipart_upload_id as string,
          partBytes: r.partBytes, partCount: r.partCount, parts: r.parts, uploaded: r.uploaded, alreadyStored: false,
        };
      }
      const grant = await held.grantUpload(prior.bucket, prior.path, { bytes: req.bytes, contentType: req.mimeType });
      if (grant.kind === "single") {
        return { ...base, kind: "single", uploadUrl: grant.url, uploadHeaders: grant.headers ?? {}, uploadId: null, partBytes: 0, partCount: 1, alreadyStored: false };
      }
      await db.from("media_objects").update({ multipart_upload_id: grant.uploadId }).eq("id", prior.id);
      return { ...base, kind: "multipart", uploadUrl: null, uploadId: grant.uploadId, partBytes: grant.partBytes, partCount: grant.partCount, parts: grant.parts, alreadyStored: false };
    }
  }

  const path = mediaPath(req.kind, {
    surveyId: req.surveyId,
    questionId: req.questionId,
    sessionId: req.sessionId,
    fileName: req.fileName,
    mimeType: req.mimeType,
    now: req.now,
  });

  const { data: row, error } = await db
    .from("media_objects")
    .insert({
      customer_id: req.customerId,
      survey_id: req.surveyId,
      question_id: req.questionId ?? null,
      response_id: req.responseId ?? null,
      session_id: req.sessionId ?? null,
      answer_key: req.answerKey ?? req.questionId ?? null,
      kind: req.kind,
      bucket: spec.bucket,
      path,
      original_filename: req.fileName ? safeSegment(req.fileName) : null,
      mime_type: req.mimeType ?? null,
      bytes: req.bytes ?? null,
      duration_seconds: req.durationSeconds ?? null,
      width: req.width ?? null,
      height: req.height ?? null,
      status: "pending",
      storage_provider: store.name,
      client_token: clientToken,
    })
    .select("id")
    .single();
  if (error || !row) throw new MediaError(`could not record the upload: ${error?.message ?? "no row"}`);

  let grant;
  try {
    grant = await store.grantUpload(spec.bucket, path, { bytes: req.bytes, contentType: req.mimeType });
  } catch (e) {
    await db.from("media_objects").update({ status: "failed", error: (e as Error).message }).eq("id", row.id);
    throw new MediaError(`could not open the upload: ${(e as Error).message}`);
  }
  if (grant.kind === "multipart") {
    await db.from("media_objects").update({ multipart_upload_id: grant.uploadId }).eq("id", row.id);
  }

  return {
    mediaId: row.id as string,
    bucket: spec.bucket,
    path,
    storageProvider: store.name,
    kind: grant.kind,
    uploadUrl: grant.kind === "single" ? grant.url : null,
    uploadHeaders: grant.kind === "single" ? (grant.headers ?? {}) : {},
    uploadId: grant.kind === "multipart" ? grant.uploadId : null,
    partBytes: grant.kind === "multipart" ? grant.partBytes : 0,
    partCount: grant.kind === "multipart" ? grant.partCount : 1,
    parts: grant.kind === "multipart" ? grant.parts : [],
    uploaded: [],
    alreadyStored: false,
    token: "",
    maxBytes: ceiling,
  };
}

/**
 * Which parts of an in-flight multipart upload the store has, and grants for
 * the rest — what a browser asks after an interruption. Never trusts its own
 * memory of what it sent; the store's list is the fact.
 */
export async function resumeUpload(db: MediaDb, mediaId: string, bytes?: number | null): Promise<UploadTicket> {
  const { data: row, error } = await db.from("media_objects")
    .select("id, bucket, path, status, storage_provider, multipart_upload_id, bytes, mime_type")
    .eq("id", mediaId).maybeSingle();
  if (error) throw new MediaError(`could not read the upload: ${error.message}`);
  if (!row) throw new MediaError("no such upload", 404);
  const store = storeFor(db, row);
  const base = {
    mediaId, bucket: row.bucket as string, path: row.path as string, storageProvider: row.storage_provider as string,
    token: "", maxBytes: 0, uploadHeaders: {}, uploaded: [] as CompletedPart[], parts: [] as PartGrant[],
  };
  if (row.status === "stored") {
    return { ...base, kind: "single", uploadUrl: null, uploadId: null, partBytes: 0, partCount: 0, alreadyStored: true };
  }
  if (!row.multipart_upload_id) {
    const grant = await store.grantUpload(row.bucket, row.path, { bytes, contentType: row.mime_type });
    if (grant.kind === "single") {
      return { ...base, kind: "single", uploadUrl: grant.url, uploadHeaders: grant.headers ?? {}, uploadId: null, partBytes: 0, partCount: 1, alreadyStored: false };
    }
    await db.from("media_objects").update({ multipart_upload_id: grant.uploadId }).eq("id", mediaId);
    return { ...base, kind: "multipart", uploadUrl: null, uploadId: grant.uploadId, partBytes: grant.partBytes, partCount: grant.partCount, parts: grant.parts, alreadyStored: false };
  }
  const total = Number(bytes) || Number(row.bytes) || 0;
  const r = await store.resumeUpload(row.bucket, row.path, row.multipart_upload_id, total);
  return {
    ...base, kind: "multipart", uploadUrl: null, uploadId: row.multipart_upload_id as string,
    partBytes: r.partBytes, partCount: r.partCount, parts: r.parts, uploaded: r.uploaded, alreadyStored: false,
  };
}

export interface StoredMedia {
  mediaId: string;
  bucket: string;
  path: string;
  url: string;
  mimeType: string | null;
  bytes: number | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  fileName: string | null;
  uploadedAt: string;
}

/**
 * The bytes arrived. Prove it, then say so.
 *
 * "Prove it" is a storage listing rather than trust in the client's word: the
 * browser reporting success and the object existing are two different facts,
 * and the whole reason this row exists is to be the one that is true.
 */
export async function confirmUpload(
  db: MediaDb,
  mediaId: string,
  observed: { bytes?: number | null; durationSeconds?: number | null; width?: number | null; height?: number | null } = {},
  /** the etags of a multipart upload's parts, so the store can assemble it */
  parts: CompletedPart[] = [],
): Promise<StoredMedia> {
  const { data: row, error } = await db
    .from("media_objects")
    .select("id, bucket, path, kind, mime_type, bytes, duration_seconds, width, height, original_filename, storage_provider, multipart_upload_id, status")
    .eq("id", mediaId)
    .maybeSingle();
  if (error) throw new MediaError(`could not read the upload: ${error.message}`);
  if (!row) throw new MediaError("no such upload", 404);

  const spec = MEDIA_KINDS[row.kind as MediaKind];
  const store = storeFor(db, row);

  /*
   * A multipart upload is assembled here, from the etags the browser was
   * handed for each part. Assembling is what makes the object exist; until
   * then the store holds parts, not a file.
   */
  if (row.multipart_upload_id && row.status !== "stored") {
    if (!parts.length) {
      throw new MediaError("the upload was sent in parts, and the confirmation names none of them", 400);
    }
    try {
      await store.completeUpload(row.bucket, row.path, row.multipart_upload_id, parts);
    } catch (e) {
      await db.from("media_objects").update({ status: "failed", error: `could not assemble the upload: ${(e as Error).message}` }).eq("id", mediaId);
      throw new MediaError(`the recording could not be assembled from its parts: ${(e as Error).message}`, 409);
    }
  }

  /*
   * PROVE IT. The browser reporting success and the object existing are two
   * different facts, and the whole reason this row exists is to be the one
   * that is true. The store's HEAD is the fact; its size is what is recorded.
   */
  let head;
  try {
    head = await store.head(row.bucket, row.path);
  } catch (e) {
    throw new MediaError(`could not confirm the upload: ${(e as Error).message}`);
  }
  if (!head) {
    await db.from("media_objects").update({ status: "failed", error: "the object was not found in storage" }).eq("id", mediaId);
    throw new MediaError("the recording did not reach storage. Try the upload again.", 409);
  }

  const bytes = head.size > 0 ? head.size : (observed.bytes ?? row.bytes ?? null);
  if (typeof bytes === "number" && bytes > 0) {
    const ceiling = await store.ceiling(row.bucket, spec.maxBytes);
    const verdict = withinLimit(row.kind as MediaKind, bytes, ceiling);
    if (!verdict.ok) {
      await store.remove(row.bucket, [row.path]);
      await db.from("media_objects").update({ status: "failed", error: verdict.message }).eq("id", mediaId);
      throw new MediaError(verdict.message!, 413);
    }
  }

  const uploadedAt = new Date().toISOString();
  const patch: Record<string, unknown> = { status: "stored", uploaded_at: uploadedAt, error: null, multipart_upload_id: null };
  if (typeof bytes === "number") patch.bytes = bytes;
  if (head.contentType && !row.mime_type) patch.mime_type = head.contentType;
  if (typeof observed.durationSeconds === "number" && observed.durationSeconds > 0) {
    patch.duration_seconds = Math.round(observed.durationSeconds * 100) / 100;
  }
  if (typeof observed.width === "number" && observed.width > 0) patch.width = Math.round(observed.width);
  if (typeof observed.height === "number" && observed.height > 0) patch.height = Math.round(observed.height);
  const updated = await db.from("media_objects").update(patch).eq("id", mediaId);
  if (updated.error) throw new MediaError(`could not save the upload: ${updated.error.message}`);

  /*
   * THE URL A DEFINITION OR AN ANSWER KEEPS. For the legacy store it is the
   * long-lived signed URL it always was. For a provider store it is the
   * application's own stable URL: a signed URL there lives fifteen minutes,
   * and the app mints one on each play, after checking who is asking.
   */
  const url = store.name === "supabase"
    ? await store.signDownload(row.bucket, row.path, { seconds: spec.signedSeconds })
    : mediaUrl(mediaId, row.original_filename);

  return {
    mediaId,
    bucket: row.bucket,
    path: row.path,
    url,
    mimeType: (patch.mime_type as string | undefined) ?? row.mime_type ?? null,
    bytes: typeof patch.bytes === "number" ? (patch.bytes as number) : (row.bytes ?? null),
    durationSeconds: typeof patch.duration_seconds === "number" ? (patch.duration_seconds as number) : (row.duration_seconds ?? null),
    width: typeof patch.width === "number" ? (patch.width as number) : (row.width ?? null),
    height: typeof patch.height === "number" ? (patch.height as number) : (row.height ?? null),
    fileName: row.original_filename ?? null,
    uploadedAt,
  };
}

/**
 * A fresh, short-lived URL for an object we already hold — what the
 * `/api/media/[id]` routes redirect to after their access check. Fifteen
 * minutes by default, whichever store holds the object.
 */
export async function freshUrl(
  db: MediaDb, mediaId: string,
  opts: { seconds?: number; download?: boolean } = {},
): Promise<{ url: string; row: { id: string; kind: MediaKind; survey_id: string; session_id: string | null; response_id: string | null; question_id: string | null; mime_type: string | null; original_filename: string | null; status: string; customer_id: string } }> {
  const { data: row, error } = await db
    .from("media_objects")
    .select("id, bucket, path, kind, survey_id, session_id, response_id, question_id, mime_type, original_filename, status, storage_provider, customer_id")
    .eq("id", mediaId).maybeSingle();
  if (error) throw new MediaError(error.message);
  if (!row) throw new MediaError("no such recording", 404);
  if (row.status !== "stored") throw new MediaError("that recording has not finished uploading", 409);
  const store = storeFor(db, row);
  const url = await store.signDownload(row.bucket, row.path, {
    seconds: opts.seconds ?? PLAYBACK_URL_SECONDS,
    downloadAs: opts.download ? (row.original_filename ?? `${row.kind}-${String(row.id).slice(0, 8)}`) : null,
    contentType: row.mime_type,
  });
  return { url, row: row as never };
}

/* ------------------------------------------------------------ transcripts */

/**
 * Queue a transcription for a stored recording, idempotently.
 *
 * Idempotent because the client may confirm an upload twice — a retry, a
 * double-click, a refresh mid-flight — and a second job would be a second
 * charge for the same seconds of audio.
 */
export async function queueTranscript(db: MediaDb, mediaId: string, surveyId: string): Promise<TranscriptRow> {
  const existing = await db.from("media_transcripts").select("*").eq("media_id", mediaId).maybeSingle();
  if (existing.error) throw new MediaError(existing.error.message);
  if (existing.data) return existing.data as TranscriptRow;

  const { data, error } = await db
    .from("media_transcripts")
    .insert({ media_id: mediaId, survey_id: surveyId, status: "waiting" })
    .select("*")
    .single();
  /* a racing insert loses the unique constraint, which is the right outcome */
  if (error) {
    const again = await db.from("media_transcripts").select("*").eq("media_id", mediaId).maybeSingle();
    if (again.data) return again.data as TranscriptRow;
    throw new MediaError(`could not queue the transcript: ${error.message}`);
  }
  return data as TranscriptRow;
}

export interface ClaimedJob {
  id: string;
  media_id: string;
  survey_id: string;
  attempts: number;
  bucket: string;
  path: string;
  mime_type: string | null;
  duration_seconds: number | null;
  kind: MediaKind;
  storage_provider?: string | null;
  bytes?: number | null;
}

/**
 * Take ownership of one transcription, or return null because somebody else
 * already has it. The decision is made in SQL — see
 * `rescript_claim_transcription` — so two runners cannot both pay for it.
 */
export async function claimTranscript(db: MediaDb, mediaId: string, opts: { staleSeconds?: number; maxAttempts?: number } = {}): Promise<ClaimedJob | null> {
  const { data, error } = await db.rpc("rescript_claim_transcription", {
    p_media: mediaId,
    p_stale_seconds: opts.staleSeconds ?? 180,
    p_max_attempts: opts.maxAttempts ?? 3,
  });
  if (error) throw new MediaError(`could not claim the transcript: ${error.message}`);
  const rows = (data ?? []) as ClaimedJob[];
  return rows.length ? rows[0] : null;
}

export async function markTranscript(
  db: MediaDb,
  jobId: string,
  status: TranscriptStatus,
  patch: Partial<Pick<TranscriptRow, "text" | "language" | "model" | "provider" | "error">> = {},
): Promise<void> {
  const row: Record<string, unknown> = { status, ...patch };
  if (status === "completed" || status === "failed") row.completed_at = new Date().toISOString();
  const { error } = await db.from("media_transcripts").update(row).eq("id", jobId);
  if (error) throw new MediaError(`could not save the transcript: ${error.message}`);
}

/**
 * Let a failed transcript be tried again from the top.
 *
 * The attempt cap exists to stop AUTOMATIC re-driving from billing a customer
 * for a clip the provider genuinely cannot read. A person who has just fixed
 * their API key and pressed "Retry transcription" is not that, and telling
 * them the button is spent because the software already tried three times
 * before they fixed it would be absurd. So an explicit human retry resets the
 * count; nothing that runs on its own may call this.
 */
export async function resetTranscript(db: MediaDb, mediaId: string): Promise<void> {
  const { error } = await db
    .from("media_transcripts")
    .update({ status: "waiting", attempts: 0, error: null, claimed_at: null })
    .eq("media_id", mediaId)
    .eq("status", "failed");
  if (error) throw new MediaError(`could not reset the transcript: ${error.message}`);
}

export async function transcriptFor(db: MediaDb, mediaId: string): Promise<TranscriptRow | null> {
  const { data, error } = await db.from("media_transcripts").select("*").eq("media_id", mediaId).maybeSingle();
  if (error) throw new MediaError(error.message);
  return (data as TranscriptRow) ?? null;
}

/**
 * Put a finished transcript into the answer it belongs to.
 *
 * This is the step that was missing, and the reason a transcript could be
 * generated, stored and retryable while the export column stayed blank. The
 * browser cannot do it: the job finishes twenty to sixty seconds after the
 * respondent stopped speaking, and by then they may have pressed Next — or
 * submitted, after which `api/session/save` deliberately refuses further
 * writes so a stale tab cannot rewrite a finished interview.
 *
 * So the runner that produced the transcript writes it, through a database
 * function that patches one path under one row lock rather than rewriting the
 * whole answer document. A transcript landing mid-interview cannot cost an
 * answer to a question it knows nothing about.
 *
 * Returns false when the session no longer exists — a purged respondent,
 * which is not an error.
 */
export async function mergeTranscriptIntoAnswer(
  db: MediaDb,
  args: { sessionId: string; answerKey: string; transcript: Record<string, unknown> },
): Promise<boolean> {
  const { data, error } = await db.rpc("rescript_set_answer_transcript", {
    p_session: args.sessionId,
    p_answer_key: args.answerKey,
    p_transcript: args.transcript,
  });
  if (error) throw new MediaError(`could not save the transcript onto the answer: ${error.message}`);
  return data === true;
}

/** Download the stored bytes so a transcript can be re-driven without the recording. */
export async function readObject(db: MediaDb, ref: ObjectRef): Promise<Uint8Array> {
  try {
    return await storeFor(db, ref).read(ref.bucket, ref.path);
  } catch (e) {
    throw new MediaError(`could not read the recording: ${(e as Error).message}`);
  }
}

/** The store's account of an object — its size before anybody downloads it. */
export async function headObject(db: MediaDb, ref: ObjectRef): Promise<{ size: number; contentType: string | null } | null> {
  return storeFor(db, ref).head(ref.bucket, ref.path);
}

/* ------------------------------------------------------------ cleanup */

export interface PurgeReport {
  objects: number;
  rows: number;
  warnings: string[];
}

function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Remove the given rows' objects and then the rows.
 *
 * Objects first, deliberately. Storage cannot join the Postgres transaction,
 * so one of the two has to go first and the only safe order is the one whose
 * failure is recoverable: a row without an object is a broken link the next
 * sweep can clear, while an object without a row is invisible forever — which
 * is exactly the state this whole table was added to end.
 */
export interface RemovableRow { id: string; bucket: string; path: string; storage_provider?: string | null; kind?: string | null; bytes?: number | null; customer_id?: string | null; survey_id?: string | null }

export async function removeMedia(
  db: MediaDb,
  rows: Array<RemovableRow>,
  reason = "removed",
): Promise<PurgeReport> {
  const report: PurgeReport = { objects: 0, rows: 0, warnings: [] };
  if (!rows.length) return report;

  /*
   * Rows may name a store the installation does not have (a provider that
   * was configured once and removed). Those cannot be deleted from here and
   * are said, not skipped silently.
   */
  const gone = new Set<string>();
  const groups = new Map<string, RemovableRow[]>();
  for (const r of rows) {
    const k = `${r.storage_provider ?? "supabase"}\u0000${r.bucket}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const [, group] of groups) {
    const sample = group[0]!;
    let store: ObjectStore;
    try { store = storeFor(db, sample); } catch (e) {
      report.warnings.push(`${group.length} objects in ${sample.bucket}: ${(e as Error).message}`);
      continue;
    }
    for (const batch of batches(group, 100)) {
      let result;
      try {
        result = await store.remove(sample.bucket, batch.map((r) => r.path));
      } catch (e) {
        report.warnings.push(`storage remove threw for ${batch.length} objects in ${sample.bucket}: ${(e as Error).message}`);
        continue;
      }
      const failed = new Map(result.failed.map((f) => [f.path, f.reason]));
      const audit: Record<string, unknown>[] = [];
      for (const r of batch) {
        const verified = !failed.has(r.path);
        if (verified) { gone.add(r.id); report.objects++; }
        else report.warnings.push(`storage remove failed for ${r.bucket}/${r.path}: ${failed.get(r.path)}`);
        if (r.customer_id) {
          audit.push({
            customer_id: r.customer_id, survey_id: r.survey_id ?? null, media_id: r.id,
            storage_provider: store.name, bucket: r.bucket, path: r.path, kind: r.kind ?? null,
            bytes: r.bytes ?? null, reason, verified,
            detail: verified ? {} : { error: failed.get(r.path) },
          });
        }
      }
      if (audit.length) {
        const { error } = await db.from("media_deletions").insert(audit);
        if (error) report.warnings.push(`the deletion audit could not be written: ${error.message}`);
      }
    }
  }

  /*
   * Only rows whose objects are CONFIRMED gone lose their rows. A row whose
   * object is still there is the one thing that can find it again; the next
   * sweep tries it.
   */
  for (const batch of batches(rows.filter((r) => gone.has(r.id)).map((r) => r.id), 200)) {
    if (!batch.length) continue;
    const { error } = await db.from("media_objects").delete().in("id", batch);
    if (error) report.warnings.push(`could not delete ${batch.length} media rows: ${error.message}`);
    else report.rows += batch.length;
  }
  return report;
}

async function rowsWhere(db: MediaDb, apply: (q: unknown) => unknown): Promise<RemovableRow[]> {
  const q = db.from("media_objects").select("id, bucket, path, storage_provider, kind, bytes, customer_id, survey_id");
  const { data, error } = await (apply(q) as PromiseLike<DbResult<RemovableRow[]>>);
  if (error) throw new MediaError(error.message);
  return data ?? [];
}

/** Everything a survey owns, across every bucket. */
export async function purgeSurveyMedia(db: MediaDb, surveyId: string): Promise<PurgeReport> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await rowsWhere(db, (q: any) => q.eq("survey_id", surveyId));
  return removeMedia(db, rows, "purge_survey");
}

/** One question's recordings — every take, not just the one still referenced. */
export async function purgeQuestionMedia(db: MediaDb, surveyId: string, questionId: string): Promise<PurgeReport> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await rowsWhere(db, (q: any) => q.eq("survey_id", surveyId).eq("question_id", questionId));
  return removeMedia(db, rows, "purge_question");
}

/**
 * The media of particular responses.
 *
 * By SESSION id rather than response id, because a purge deletes the
 * `responses` row and the cascade would take these rows with it before
 * anything had a chance to delete the objects they name. Reading the sessions
 * first, and deleting the objects first, is what stops an erasure request
 * leaving the recording behind.
 */
export async function purgeSessionMedia(db: MediaDb, sessionIds: string[]): Promise<PurgeReport> {
  if (!sessionIds.length) return { objects: 0, rows: 0, warnings: [] };
  const out: PurgeReport = { objects: 0, rows: 0, warnings: [] };
  for (const batch of batches(sessionIds, 100)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await rowsWhere(db, (q: any) => q.in("session_id", batch));
    const r = await removeMedia(db, rows, "purge_session");
    out.objects += r.objects;
    out.rows += r.rows;
    out.warnings.push(...r.warnings);
  }
  return out;
}

/**
 * Uploads that were reserved and never arrived.
 *
 * A `pending` row older than the window is a browser that closed mid-upload.
 * The object may or may not exist; `removeMedia` tolerates both.
 */
export async function sweepAbandonedUploads(db: MediaDb, olderThanMinutes = 120): Promise<PurgeReport> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await rowsWhere(db, (q: any) => q.eq("status", "pending").lt("created_at", cutoff));
  /* an in-flight multipart upload is released too, or its parts are billed for ever */
  for (const r of rows as Array<RemovableRow & { multipart_upload_id?: string | null }>) {
    if (r.multipart_upload_id) {
      try { await storeFor(db, r).abortUpload(r.bucket, r.path, r.multipart_upload_id); } catch { /* the object delete below still runs */ }
    }
  }
  return removeMedia(db, rows, "abandoned");
}

/* ------------------------------------------------------------ copying */

/**
 * Duplicate a stored object for another survey, inside the store. The bytes
 * never pass through the application; what comes back is a new row and the
 * URL to keep. A cloned survey used to point at the original's file, so
 * deleting the original broke the clone — this is what makes a clone a copy.
 */
export async function copyMedia(
  db: MediaDb, mediaId: string,
  target: { surveyId: string; questionId?: string | null; now?: number },
): Promise<StoredMedia> {
  const { data: row, error } = await db.from("media_objects")
    .select("id, customer_id, kind, bucket, path, mime_type, bytes, duration_seconds, width, height, original_filename, storage_provider, status")
    .eq("id", mediaId).maybeSingle();
  if (error) throw new MediaError(error.message);
  if (!row) throw new MediaError("no such recording", 404);
  if (row.status !== "stored") throw new MediaError("that recording has not finished uploading", 409);

  const from = storeFor(db, row);
  /* the copy lands in the PRIMARY store when the source's store can copy across; otherwise beside its source */
  const spec = MEDIA_KINDS[row.kind as MediaKind];
  const path = mediaPath(row.kind as MediaKind, {
    surveyId: target.surveyId, questionId: target.questionId ?? null,
    fileName: row.original_filename, mimeType: row.mime_type, now: target.now,
  });
  await from.copy(row.bucket, row.path, spec.bucket, path, { contentType: row.mime_type });

  const { data: made, error: insertError } = await db.from("media_objects").insert({
    customer_id: row.customer_id, survey_id: target.surveyId, question_id: target.questionId ?? null,
    kind: row.kind, bucket: spec.bucket, path, original_filename: row.original_filename,
    mime_type: row.mime_type, bytes: row.bytes, duration_seconds: row.duration_seconds,
    width: row.width, height: row.height, status: "stored", uploaded_at: new Date().toISOString(),
    storage_provider: from.name,
  }).select("id").single();
  if (insertError || !made) {
    await from.remove(spec.bucket, [path]).catch(() => {});
    throw new MediaError(`could not record the copy: ${insertError?.message ?? "no row"}`);
  }
  const url = from.name === "supabase"
    ? await from.signDownload(spec.bucket, path, { seconds: spec.signedSeconds })
    : mediaUrl(made.id as string, row.original_filename);
  return {
    mediaId: made.id as string, bucket: spec.bucket, path, url,
    mimeType: row.mime_type ?? null, bytes: row.bytes ?? null, durationSeconds: row.duration_seconds ?? null,
    width: row.width ?? null, height: row.height ?? null, fileName: row.original_filename ?? null,
    uploadedAt: new Date().toISOString(),
  };
}
