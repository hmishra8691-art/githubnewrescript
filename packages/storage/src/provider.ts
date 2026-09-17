/**
 * THE OBJECT STORE, AS AN INTERFACE.
 *
 * Every large media asset this platform holds — an interview recording, an
 * audio extract, a generated package — lives behind this and nothing else.
 * The application knows about keys, sizes and signed URLs; it does not know
 * about Cloudflare, about S3, about buckets-that-are-really-Supabase, and it
 * never learns.
 *
 * ## Why the indirection is worth its weight
 *
 * The lesson is already in this repository. `packages/media` talks to storage
 * through a six-method shim and is therefore portable; the two legacy upload
 * routes call `supabase.storage` directly and are not. The difference is not
 * theoretical — moving one to R2 is implementing this file, and moving the
 * other is rewriting the route.
 *
 * ## What a provider must actually promise
 *
 * Four things, and they are the four that upload correctness rests on:
 *
 *  1. **A signed URL grants exactly one operation on exactly one key.** Not a
 *     prefix, not a bucket. A ticket for `…/response-7/recording.webm` cannot
 *     be replayed against another respondent's key.
 *  2. **`exists` and `getMetadata` report the STORE's opinion**, never the
 *     client's. "The browser said the upload finished" and "the object is
 *     there" are different facts, and only the second one is allowed to end an
 *     interview question.
 *  3. **`delete` is idempotent.** Deleting a key that is not there succeeds.
 *     Retention sweeps run repeatedly over the same list by design.
 *  4. **Multipart parts are addressable individually**, so a browser that
 *     lost its connection at part 9 of 14 resumes at part 9 rather than at
 *     part 1. That is the whole of §6, and it is impossible without
 *     `signUploadPart` — which is why this interface has it and the brief's
 *     sketch does not.
 *
 * ## What it deliberately does NOT promise
 *
 * Nothing here streams. A provider takes and returns whole byte arrays,
 * because the one place this platform moves whole large objects through a
 * server (`readObject` for transcription) has a 25 MB provider ceiling
 * anyway, and every other path is browser→store direct. Adding streams would
 * buy nothing and would make the in-memory double a lie.
 *
 * Nor does it promise a public URL. There is no `getPublicUrl`, and its
 * absence is load-bearing: §13 says no predictable permanent public URL may
 * exist, and the cheapest way to keep a promise like that is to give the
 * application no way to break it.
 */

/** The seconds a signed URL may live. S3-compatible stores cap this at 7 days. */
export const MAX_SIGNED_SECONDS = 7 * 24 * 60 * 60;

/**
 * How long a playback or download link should live.
 *
 * Deliberately short. The existing survey media hands out one-year and
 * five-year signed URLs because Supabase permits it; an S3-compatible store
 * does not, and the limit is a better design than the permission. A URL is
 * minted when someone with the right to see the recording asks for it, and it
 * is useless by the time it reaches anyone else's inbox.
 */
export const PLAYBACK_SECONDS = 15 * 60;

/** How long a browser has to finish one upload ticket. */
export const UPLOAD_SECONDS = 2 * 60 * 60;

export interface ObjectMetadata {
  key: string;
  /** Bytes, as the store counts them — not as the client claimed. */
  size: number;
  contentType: string | null;
  etag: string | null;
  lastModified: Date | null;
}

export interface UploadOptions {
  contentType?: string;
  /**
   * Refuse to write when something is already at this key. Every key this
   * platform mints is unique by construction, so a collision means a bug or a
   * replay, and overwriting a respondent's recording is the worst possible
   * response to either.
   */
  ifAbsent?: boolean;
  /** Small, non-secret annotations stored beside the object. */
  metadata?: Record<string, string>;
}

export interface SignedUrlOptions {
  /** Seconds. Clamped to `MAX_SIGNED_SECONDS` by every provider. */
  expiresIn?: number;
  contentType?: string;
  /** Sets `response-content-disposition` so a download saves under a real name. */
  downloadAs?: string;
}

export interface MultipartUpload {
  key: string;
  uploadId: string;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

/**
 * A storage failure the application is expected to handle, carrying the HTTP
 * status it should answer with. Anything else a provider throws is a bug.
 */
export class StorageError extends Error {
  readonly status: number;
  readonly cause?: unknown;
  constructor(message: string, status = 502, cause?: unknown) {
    super(message);
    this.name = "StorageError";
    this.status = status;
    this.cause = cause;
  }
}

export interface MediaStorageProvider {
  /** What this is, for logging and for `interview_media.storage_provider`. */
  readonly name: string;

  /**
   * Write bytes from the server. The narrow path: generated artefacts,
   * exports, tests. Respondent recordings never come through here — they go
   * browser→store direct, which is the entire point of the signed URL below.
   */
  upload(key: string, body: Uint8Array, opts?: UploadOptions): Promise<ObjectMetadata>;

  /** A URL a browser may PUT one object to, once. */
  createSignedUploadUrl(key: string, opts?: SignedUrlOptions): Promise<string>;

  /** Begin a multipart upload. Returns the id every part and the completion need. */
  createMultipartUpload(key: string, opts?: UploadOptions): Promise<MultipartUpload>;

  /**
   * A URL a browser may PUT ONE PART to. Parts are 1-indexed, as S3 numbers
   * them. This is what makes an interrupted upload resumable: the parts
   * already accepted keep their numbers and are not sent again.
   */
  signUploadPart(key: string, uploadId: string, partNumber: number, opts?: SignedUrlOptions): Promise<string>;

  /** Assemble the parts into the object. Parts must be in ascending order. */
  completeMultipartUpload(key: string, uploadId: string, parts: CompletedPart[]): Promise<ObjectMetadata>;

  /** Give up, and stop paying for the parts already stored. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;

  /** Which parts the store has already accepted — the resume question. */
  listUploadedParts(key: string, uploadId: string): Promise<CompletedPart[]>;

  /** A URL to play or download this object with, short-lived. */
  createSignedDownloadUrl(key: string, opts?: SignedUrlOptions): Promise<string>;

  /** The store's own account of the object, or null when there is none. */
  getMetadata(key: string): Promise<ObjectMetadata | null>;

  /** Read the whole object. For transcription and processing only. */
  read(key: string): Promise<Uint8Array>;

  /** Idempotent. Keys that are not there are not an error. */
  delete(keys: string[]): Promise<void>;

  /**
   * Duplicate an object inside the store, server side. The bytes never leave
   * the store: this is what a survey clone uses so a copied question video is
   * a copy and not a shared object one deletion away from a broken clone.
   */
  copy(fromKey: string, toKey: string, opts?: { contentType?: string }): Promise<ObjectMetadata>;

  /** Cheap presence check. Equivalent to `getMetadata(key) !== null`. */
  exists(key: string): Promise<boolean>;

  /**
   * Every key under a prefix, for the orphan reconciliation §20 asks for.
   * Paged, because a bucket is not a list you hold in memory.
   */
  list(prefix: string, opts?: { limit?: number; cursor?: string }): Promise<{
    objects: ObjectMetadata[];
    cursor: string | null;
  }>;
}

/* ------------------------------------------------------------------- keys */

/**
 * ONE PLACE DECIDES WHERE AN OBJECT LIVES.
 *
 * §13 asks for keys that are predictable to us and useless to anyone else.
 * Those are not in tension: the structure below is completely predictable —
 *
 *     organizations/<org>/interviews/<interview>/responses/<response>/<file>
 *
 * — and guessing it buys nothing, because there is no unsigned way to read a
 * key. The structure is what makes the rest of the product possible: a
 * retention sweep for one interview is a prefix delete, an orphan check is a
 * prefix list, and an organization's whole footprint is one prefix.
 *
 * The ids are uuids, so the segments are already opaque; `safeKeySegment`
 * exists for the file name at the end, which is the only part a person ever
 * chooses.
 */
export function safeKeySegment(value: string | null | undefined, max = 80): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "_";
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^\.+/, "_");
  return cleaned.slice(0, max) || "_";
}

export interface ResponseKeyParts {
  organizationId: string;
  interviewId: string;
  responseId: string;
  /** "recording.webm", "audio.webm" — the role of the object, not a title. */
  fileName: string;
}

export function responseMediaKey(p: ResponseKeyParts): string {
  return [
    "organizations", safeKeySegment(p.organizationId),
    "interviews", safeKeySegment(p.interviewId),
    "responses", safeKeySegment(p.responseId),
    safeKeySegment(p.fileName),
  ].join("/");
}

export function interviewPrefix(organizationId: string, interviewId: string): string {
  return `organizations/${safeKeySegment(organizationId)}/interviews/${safeKeySegment(interviewId)}/`;
}

export function organizationPrefix(organizationId: string): string {
  return `organizations/${safeKeySegment(organizationId)}/`;
}

/** Seconds, clamped to what an S3-compatible store will actually sign. */
export function clampExpiry(seconds: number | undefined, fallback: number): number {
  const n = Number.isFinite(seconds) ? Math.floor(seconds as number) : fallback;
  return Math.min(MAX_SIGNED_SECONDS, Math.max(1, n));
}
