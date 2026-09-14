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
  storage: {
    listBuckets(): PromiseLike<DbResult<Array<{ name: string; file_size_limit?: number | null }>>>;
    createBucket(name: string, opts: { public: boolean; fileSizeLimit?: number }): PromiseLike<{ error: DbError | null }>;
    from(bucket: string): {
      createSignedUploadUrl(path: string): PromiseLike<DbResult<{ signedUrl: string; token: string; path: string }>>;
      createSignedUrl(path: string, seconds: number): PromiseLike<DbResult<{ signedUrl: string }>>;
      download(path: string): PromiseLike<DbResult<{ arrayBuffer(): Promise<ArrayBuffer>; type?: string }>>;
      remove(paths: string[]): PromiseLike<DbResult<unknown>>;
      list(path: string, opts?: { limit: number }): PromiseLike<DbResult<{ name: string }[]>>;
    };
  };
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

const ensured = new Map<string, number>();

/** True for the storage service's refusal of a limit above the project's own. */
function isLimitRefusal(message: string): boolean {
  return /exceeded the maximum allowed size|maximum allowed size|exceeds the maximum/i.test(message);
}

/**
 * Make sure the bucket exists, and find out what it will actually accept.
 *
 * ## Why this is not just `createBucket`
 *
 * A Supabase project has a GLOBAL upload limit — 50 MB by default — and a
 * bucket may not declare a limit above it. `createBucket` with a 150 MB
 * `fileSizeLimit` is therefore refused outright with "The object exceeded the
 * maximum allowed size", which is a sentence about a bucket that reads like a
 * sentence about a file. A researcher recording a one-second clip was told
 * their 0.2 MB take was too big.
 *
 * So the limit we ask for is a preference, not an assertion. If the project
 * will not have it, the bucket is created without one and inherits the
 * project's — and the number that comes back is what everything downstream
 * measures against, rather than the number this package would have liked.
 *
 * Returns the effective ceiling in bytes.
 */
export async function ensureBucket(db: MediaDb, bucket: string, maxBytes: number): Promise<number> {
  const known = ensured.get(bucket);
  if (known !== undefined) return known;

  const { data: buckets, error } = await db.storage.listBuckets();
  if (error) throw new MediaError(`could not check storage buckets: ${error.message}`);

  const existing = buckets?.find((b) => b.name === bucket);
  if (existing) {
    const limit = typeof existing.file_size_limit === "number" && existing.file_size_limit > 0
      ? Math.min(existing.file_size_limit, maxBytes)
      : maxBytes;
    ensured.set(bucket, limit);
    return limit;
  }

  let made = await db.storage.createBucket(bucket, { public: false, fileSizeLimit: maxBytes });
  if (made.error && isLimitRefusal(made.error.message)) {
    /* the project will not allow a bucket this permissive — take its own */
    made = await db.storage.createBucket(bucket, { public: false });
  }
  if (made.error && !/already exists/i.test(made.error.message)) {
    throw new MediaError(`could not create the storage bucket: ${made.error.message}`);
  }

  /* read back rather than assume: the bucket may have been created without
     our limit, either by the retry above or by another process */
  const after = await db.storage.listBuckets();
  const row = after.data?.find((b) => b.name === bucket);
  const limit = row && typeof row.file_size_limit === "number" && row.file_size_limit > 0
    ? Math.min(row.file_size_limit, maxBytes)
    : maxBytes;
  ensured.set(bucket, limit);
  return limit;
}

/** Testing seam: forget what this process believes about buckets. */
export function resetBucketCache(): void { ensured.clear(); }

/**
 * What storage will really accept for this kind, and how long a take fits.
 *
 * The recorder asks this BEFORE the camera is opened, so the duration it
 * offers is one that can actually be stored. A ceiling discovered at upload
 * time is a ceiling discovered after the interview.
 */
export async function mediaLimits(db: MediaDb, kind: MediaKind): Promise<{ maxBytes: number; maxSeconds: number }> {
  const spec = MEDIA_KINDS[kind];
  const maxBytes = await ensureBucket(db, spec.bucket, spec.maxBytes);
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
}

export interface UploadTicket {
  mediaId: string;
  bucket: string;
  path: string;
  /** PUT the bytes here. Valid for two hours, single use. */
  uploadUrl: string;
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

  /*
   * The bucket is settled BEFORE the size is judged, because what the size is
   * judged against comes from the bucket. Asking the other way round is how a
   * 0.2 MB take came to be refused for being too large: the limit this package
   * would like was never the limit storage would accept.
   */
  const ceiling = await ensureBucket(db, spec.bucket, spec.maxBytes);
  if (typeof req.bytes === "number" && req.bytes > 0) {
    const verdict = withinLimit(req.kind, req.bytes, ceiling);
    if (!verdict.ok) throw new MediaError(verdict.message!, 413);
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
    })
    .select("id")
    .single();
  if (error || !row) throw new MediaError(`could not record the upload: ${error?.message ?? "no row"}`);

  const signed = await db.storage.from(spec.bucket).createSignedUploadUrl(path);
  if (signed.error || !signed.data) {
    await db.from("media_objects").update({ status: "failed", error: signed.error?.message ?? "no upload url" }).eq("id", row.id);
    throw new MediaError(`could not open the upload: ${signed.error?.message ?? "no upload url"}`);
  }

  return {
    mediaId: row.id as string,
    bucket: spec.bucket,
    path,
    uploadUrl: signed.data.signedUrl,
    token: signed.data.token,
    maxBytes: ceiling,
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
): Promise<StoredMedia> {
  const { data: row, error } = await db
    .from("media_objects")
    .select("id, bucket, path, kind, mime_type, bytes, duration_seconds, width, height, original_filename")
    .eq("id", mediaId)
    .maybeSingle();
  if (error) throw new MediaError(`could not read the upload: ${error.message}`);
  if (!row) throw new MediaError("no such upload", 404);

  const spec = MEDIA_KINDS[row.kind as MediaKind];
  const folder = String(row.path).split("/").slice(0, -1).join("/");
  const leaf = String(row.path).split("/").pop()!;
  const listed = await db.storage.from(row.bucket).list(folder, { limit: 1000 });
  if (listed.error) throw new MediaError(`could not confirm the upload: ${listed.error.message}`);
  if (!listed.data?.some((f) => f.name === leaf)) {
    await db.from("media_objects").update({ status: "failed", error: "the object was not found in storage" }).eq("id", mediaId);
    throw new MediaError("the recording did not reach storage. Try the upload again.", 409);
  }

  const bytes = observed.bytes ?? row.bytes ?? null;
  if (typeof bytes === "number" && bytes > 0) {
    const verdict = withinLimit(row.kind as MediaKind, bytes, ensured.get(row.bucket));
    if (!verdict.ok) {
      await db.storage.from(row.bucket).remove([row.path]);
      await db.from("media_objects").update({ status: "failed", error: verdict.message }).eq("id", mediaId);
      throw new MediaError(verdict.message!, 413);
    }
  }

  const uploadedAt = new Date().toISOString();
  const patch: Record<string, unknown> = { status: "stored", uploaded_at: uploadedAt, error: null };
  if (typeof bytes === "number") patch.bytes = bytes;
  if (typeof observed.durationSeconds === "number" && observed.durationSeconds > 0) {
    patch.duration_seconds = Math.round(observed.durationSeconds * 100) / 100;
  }
  if (typeof observed.width === "number" && observed.width > 0) patch.width = Math.round(observed.width);
  if (typeof observed.height === "number" && observed.height > 0) patch.height = Math.round(observed.height);
  const updated = await db.from("media_objects").update(patch).eq("id", mediaId);
  if (updated.error) throw new MediaError(`could not save the upload: ${updated.error.message}`);

  const signed = await db.storage.from(row.bucket).createSignedUrl(row.path, spec.signedSeconds);
  if (signed.error || !signed.data) throw new MediaError(`could not link the recording: ${signed.error?.message ?? "no url"}`);

  return {
    mediaId,
    bucket: row.bucket,
    path: row.path,
    url: signed.data.signedUrl,
    mimeType: row.mime_type ?? null,
    bytes: typeof patch.bytes === "number" ? (patch.bytes as number) : (row.bytes ?? null),
    durationSeconds: typeof patch.duration_seconds === "number" ? (patch.duration_seconds as number) : (row.duration_seconds ?? null),
    width: typeof patch.width === "number" ? (patch.width as number) : (row.width ?? null),
    height: typeof patch.height === "number" ? (patch.height as number) : (row.height ?? null),
    fileName: row.original_filename ?? null,
    uploadedAt,
  };
}

/** A fresh signed URL for an object we already hold. */
export async function freshUrl(db: MediaDb, mediaId: string): Promise<string> {
  const { data: row, error } = await db
    .from("media_objects").select("bucket, path, kind").eq("id", mediaId).maybeSingle();
  if (error) throw new MediaError(error.message);
  if (!row) throw new MediaError("no such recording", 404);
  const signed = await db.storage.from(row.bucket).createSignedUrl(row.path, MEDIA_KINDS[row.kind as MediaKind].signedSeconds);
  if (signed.error || !signed.data) throw new MediaError(signed.error?.message ?? "no url");
  return signed.data.signedUrl;
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
export async function readObject(db: MediaDb, bucket: string, path: string): Promise<Uint8Array> {
  const { data, error } = await db.storage.from(bucket).download(path);
  if (error || !data) throw new MediaError(`could not read the recording: ${error?.message ?? "not found"}`);
  return new Uint8Array(await data.arrayBuffer());
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
export async function removeMedia(db: MediaDb, rows: Array<{ id: string; bucket: string; path: string }>): Promise<PurgeReport> {
  const report: PurgeReport = { objects: 0, rows: 0, warnings: [] };
  if (!rows.length) return report;

  const byBucket = new Map<string, string[]>();
  for (const r of rows) {
    const list = byBucket.get(r.bucket) ?? [];
    list.push(r.path);
    byBucket.set(r.bucket, list);
  }
  for (const [bucket, paths] of byBucket) {
    for (const batch of batches(paths, 100)) {
      try {
        const { error } = await db.storage.from(bucket).remove(batch);
        if (error) report.warnings.push(`storage remove failed for ${batch.length} objects in ${bucket}: ${error.message}`);
        else report.objects += batch.length;
      } catch (e) {
        report.warnings.push(`storage remove threw for ${batch.length} objects in ${bucket}: ${(e as Error).message}`);
      }
    }
  }

  for (const batch of batches(rows.map((r) => r.id), 200)) {
    const { error } = await db.from("media_objects").delete().in("id", batch);
    if (error) report.warnings.push(`could not delete ${batch.length} media rows: ${error.message}`);
    else report.rows += batch.length;
  }
  return report;
}

async function rowsWhere(db: MediaDb, apply: (q: unknown) => unknown): Promise<Array<{ id: string; bucket: string; path: string }>> {
  const q = db.from("media_objects").select("id, bucket, path");
  const { data, error } = await (apply(q) as PromiseLike<DbResult<Array<{ id: string; bucket: string; path: string }>>>);
  if (error) throw new MediaError(error.message);
  return data ?? [];
}

/** Everything a survey owns, across every bucket. */
export async function purgeSurveyMedia(db: MediaDb, surveyId: string): Promise<PurgeReport> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await rowsWhere(db, (q: any) => q.eq("survey_id", surveyId));
  return removeMedia(db, rows);
}

/** One question's recordings — every take, not just the one still referenced. */
export async function purgeQuestionMedia(db: MediaDb, surveyId: string, questionId: string): Promise<PurgeReport> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await rowsWhere(db, (q: any) => q.eq("survey_id", surveyId).eq("question_id", questionId));
  return removeMedia(db, rows);
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
    const r = await removeMedia(db, rows);
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
  return removeMedia(db, rows);
}
