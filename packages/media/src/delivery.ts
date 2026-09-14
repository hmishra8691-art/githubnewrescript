/**
 * DELIVERING THE ORIGINAL RECORDING, THEN LETTING IT GO.
 *
 * A researcher needs the recording itself: the pauses, the tone, the thing on
 * the table the respondent picked up mid-sentence. A transcript is the datum
 * but it is not the evidence. At the same time a platform that keeps every
 * respondent's video forever is holding, indefinitely, the most identifying
 * material a research project ever collects.
 *
 * So the bytes are treated as a delivery rather than as storage. They are
 * held long enough to be fetched and no longer, and the thing that makes that
 * safe is the ordering: the transcript has already become the answer value
 * (0028) before anything here runs, so when the recording goes, the response
 * is still a complete research record.
 *
 * ## What this module is, and is not
 *
 * Policy and row-shuffling, in the same style as `store.ts`: the database is
 * an argument, there is no `server-only`, no Next, no Supabase import, and no
 * network. Sending the email is the app's job, because the transport lives
 * there; deciding what goes in the package, what it is called, when it
 * expires and what is deleted is this file's job, because those are rules and
 * rules should be testable without a mail server.
 *
 * ## The 48 hours
 *
 * Fixed, not configurable. A retention period that a project can lengthen is
 * a retention period that will be lengthened, one project at a time, until it
 * is not a retention period. The number is also a promise printed in the
 * email, and a promise that varies by project is one the platform cannot
 * keep on the project's behalf.
 */

import { createHash, randomBytes } from "node:crypto";
import { safeSegment } from "./plan.js";
import type { MediaDb } from "./store.js";
import { MediaError } from "./store.js";

/** The retention promise, in one place. Printed in the email; enforced by the sweep. */
export const RETENTION_HOURS = 48;
export const RETENTION_MS = RETENTION_HOURS * 60 * 60 * 1000;

/**
 * The kinds a researcher is sent. Respondent-side only: `question_video` and
 * `question_audio` are the researcher's OWN stimulus, already in their
 * project, and mailing it back to them would be absurd.
 */
export const DELIVERED_KINDS = ["answer_audio", "answer_upload"] as const;

export type DeliveryStatus =
  | "pending"      // discovered, nothing sent yet
  | "processing"   // a run has claimed it
  | "sent"         // the email is out and the link is live
  | "downloaded"   // opened at least once
  | "expired"      // past 48 hours; the link is dead
  | "deleted"      // the bytes are gone
  | "failed";      // gave up after the attempt budget

/** What the Studio prints. Plain sentences — a status column nobody can read is decoration. */
export const DELIVERY_SAY: Record<DeliveryStatus, string> = {
  pending: "Waiting to be packaged",
  processing: "Packaging",
  sent: "Emailed — download available",
  downloaded: "Downloaded",
  expired: "Expired — link no longer works",
  deleted: "Media deleted after 48 hours",
  failed: "Delivery failed",
};

/** A status nothing will move on its own, so the Studio can offer a retry. */
export function deliveryStalled(status: DeliveryStatus): boolean {
  return status === "failed";
}

/* ------------------------------------------------------------- the token */

/**
 * The download credential.
 *
 * Minted once, shown once — in the email — and never stored. What is stored
 * is the SHA-256, which is the rule 0016 set for password reset links and for
 * the same reason: a link in a mailbox is a bearer credential, and a database
 * that holds the credential turns one leak into two.
 *
 * 32 bytes because the link is unguessable or it is nothing; there is no rate
 * limit that makes a short token safe when it is also long-lived by design.
 */
export function mintDownloadToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashDownloadToken(token) };
}

export function hashDownloadToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/* ------------------------------------------------------------ the package */

export interface DeliveryFile {
  mediaId: string;
  bucket: string;
  path: string;
  /** The name inside the ZIP, including its folders. */
  fileName: string;
  kind: string;
  bytes: number;
  mimeType: string | null;
  questionId: string | null;
  questionCode: string | null;
  answerKey: string | null;
  durationSeconds: number | null;
}

export interface ManifestInput {
  projectName: string;
  respondentLabel: string;
  files: Array<{
    mediaId: string;
    bucket: string;
    path: string;
    kind: string;
    bytes: number | null;
    mimeType: string | null;
    originalFilename: string | null;
    questionId: string | null;
    questionCode: string | null;
    answerKey: string | null;
    durationSeconds: number | null;
  }>;
}

/**
 * The name a file has inside the package.
 *
 *     Beverage_Habits_2026/Respondent_A4F2/Q12_video_response.webm
 *
 * A researcher who unzips four of these into one folder must still be able to
 * tell whose is whose and which question it answers, which is why the
 * respondent and the question code are in the PATH and not only in the email
 * body. The extension is carried over from the stored object rather than
 * guessed from the kind: what was recorded is what is delivered.
 *
 * Every segment goes through `safeSegment`, the same function that sanitises
 * a storage path — so a question code someone typed as `Q1/../..` cannot walk
 * out of the folder when the archive is extracted.
 */
export function packagePath(
  projectName: string,
  respondentLabel: string,
  file: { kind: string; originalFilename: string | null; questionCode: string | null; questionId: string | null; answerKey: string | null },
  index: number,
): string {
  const project = safeSegment(projectName || "Project", 60);
  const respondent = `Respondent_${safeSegment(respondentLabel || "unknown", 40)}`;

  const ext = extensionOf(file.originalFilename) ?? (file.kind === "answer_audio" ? "webm" : "bin");
  const question = safeSegment(file.questionCode || file.questionId || `Q${index + 1}`, 24);
  const what = file.kind === "answer_audio" ? "audio_response" : "upload";
  /*
   * A loop asks the same question several times, and `answerKey` is the only
   * thing that tells two of those apart — without it the second iteration
   * would overwrite the first when the archive is extracted.
   */
  const iteration = file.answerKey && file.answerKey !== file.questionId
    ? `_${safeSegment(file.answerKey.replace(/^[^@]*@?/, ""), 20)}`
    : "";

  return `${project}/${respondent}/${question}${iteration}_${what}.${ext}`;
}

function extensionOf(name: string | null): string | null {
  if (!name) return null;
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1]!.toLowerCase() : null;
}

/** Build the manifest, resolving collisions so no two files share a name. */
export function buildManifest(input: ManifestInput): DeliveryFile[] {
  const used = new Set<string>();
  return input.files.map((f, i) => {
    let name = packagePath(input.projectName, input.respondentLabel, f, i);
    if (used.has(name)) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let n = 2;
      while (used.has(`${stem}_${n}${ext}`)) n++;
      name = `${stem}_${n}${ext}`;
    }
    used.add(name);
    return {
      mediaId: f.mediaId,
      bucket: f.bucket,
      path: f.path,
      fileName: name,
      kind: f.kind,
      bytes: f.bytes ?? 0,
      mimeType: f.mimeType,
      questionId: f.questionId,
      questionCode: f.questionCode,
      answerKey: f.answerKey,
      durationSeconds: f.durationSeconds,
    };
  });
}

/** The archive's own name, as it lands in the researcher's downloads folder. */
export function packageFileName(projectName: string, respondentLabel: string): string {
  return `${safeSegment(projectName || "Project", 50)}_${safeSegment(respondentLabel || "respondent", 30)}_media.zip`;
}

export function expiryFrom(now: Date): Date {
  return new Date(now.getTime() + RETENTION_MS);
}

/** Whole hours left, floored, never negative — what the email and the page print. */
export function hoursRemaining(expiresAt: Date, now: Date): number {
  return Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / (60 * 60 * 1000)));
}

/* ---------------------------------------------------------------- the rows */

export interface DeliveryRow {
  id: string;
  customer_id: string;
  survey_id: string;
  response_id: string;
  session_id: string;
  respondent_label: string | null;
  recipient_email: string;
  status: DeliveryStatus;
  media_count: number;
  total_bytes: number;
  manifest: DeliveryFile[];
  token_hash: string | null;
  expires_at: string | null;
  attempts: number;
  error: string | null;
  retry_after: string | null;
  email_sent_at: string | null;
  downloaded_at: string | null;
  download_count: number;
  deleted_at: string | null;
  created_at: string;
}

export interface DueResponse {
  response_id: string;
  survey_id: string;
  customer_id: string;
  session_id: string;
  respondent_label: string | null;
  recipient_email: string;
  media_count: number;
}

function fail(message: string, status = 500): never {
  throw new MediaError(message, status);
}

/** Responses that have earned a delivery and do not have one. */
export async function findDue(db: MediaDb, limit = 25): Promise<DueResponse[]> {
  const { data, error } = await db.rpc("rescript_media_deliveries_due", {
    p_limit: limit,
    p_window_hours: RETENTION_HOURS,
  });
  if (error) fail(`could not look for deliveries: ${error.message}`);
  return ((data ?? []) as DueResponse[]).map((r) => ({ ...r, media_count: Number(r.media_count) }));
}

/**
 * Create the delivery row at `pending`.
 *
 * `response_id` is uniquely indexed, so a second run that discovered the same
 * response before the first one inserted gets a duplicate-key error rather
 * than a second email. That is the real guard; the left join in the discovery
 * query only keeps the common case cheap.
 */
export async function openDelivery(db: MediaDb, due: DueResponse): Promise<DeliveryRow | null> {
  const { data, error } = await db.from("media_deliveries").insert({
    customer_id: due.customer_id,
    survey_id: due.survey_id,
    response_id: due.response_id,
    session_id: due.session_id,
    respondent_label: due.respondent_label,
    recipient_email: due.recipient_email,
    status: "pending",
  }).select("*").single();
  if (error) {
    // 23505: another run got there first, which is success, not failure
    if (/duplicate key|23505/i.test(error.message)) return null;
    fail(`could not open a delivery: ${error.message}`);
  }
  return data as DeliveryRow;
}

export interface ClaimedDelivery {
  id: string;
  customer_id: string;
  survey_id: string;
  response_id: string;
  session_id: string;
  respondent_label: string | null;
  recipient_email: string;
  attempts: number;
}

/** Take exclusive ownership of one delivery for this run, or return null. */
export async function claimDelivery(
  db: MediaDb,
  id: string,
  opts: { staleSeconds?: number; maxAttempts?: number } = {},
): Promise<ClaimedDelivery | null> {
  const { data, error } = await db.rpc("rescript_claim_media_delivery", {
    p_id: id,
    p_stale_seconds: opts.staleSeconds ?? 300,
    p_max_attempts: opts.maxAttempts ?? 5,
  });
  if (error) fail(`could not claim the delivery: ${error.message}`);
  const rows = (data ?? []) as ClaimedDelivery[];
  return rows[0] ?? null;
}

/** The stored media belonging to one session, in the order it was recorded. */
export async function sessionMedia(db: MediaDb, sessionId: string): Promise<ManifestInput["files"]> {
  const { data, error } = await db.from("media_objects")
    .select("id, bucket, path, kind, bytes, mime_type, original_filename, question_id, answer_key, duration_seconds")
    .eq("session_id", sessionId)
    .eq("status", "stored")
    .in("kind", DELIVERED_KINDS as unknown as string[])
    .order("created_at", { ascending: true });
  if (error) fail(`could not read the session's media: ${error.message}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((data ?? []) as any[]).map((r) => ({
    mediaId: r.id,
    bucket: r.bucket,
    path: r.path,
    kind: r.kind,
    bytes: r.bytes == null ? null : Number(r.bytes),
    mimeType: r.mime_type ?? null,
    originalFilename: r.original_filename ?? null,
    questionId: r.question_id ?? null,
    questionCode: null,
    answerKey: r.answer_key ?? null,
    durationSeconds: r.duration_seconds == null ? null : Number(r.duration_seconds),
  }));
}

/** Record the package and the live link. Called once the email is actually away. */
export async function markSent(
  db: MediaDb,
  id: string,
  args: { manifest: DeliveryFile[]; tokenHash: string; expiresAt: Date; providerId?: string | null },
): Promise<void> {
  const { error } = await db.from("media_deliveries").update({
    status: "sent",
    manifest: args.manifest,
    media_count: args.manifest.length,
    total_bytes: args.manifest.reduce((n, f) => n + (f.bytes || 0), 0),
    token_hash: args.tokenHash,
    expires_at: args.expiresAt.toISOString(),
    email_sent_at: new Date().toISOString(),
    provider_id: args.providerId ?? null,
    error: null,
  }).eq("id", id);
  if (error) fail(`could not record the delivery: ${error.message}`);
}

/**
 * Record a failure and leave it retryable.
 *
 * The manifest is written even here. A delivery that failed at the mail step
 * has already read the media, and keeping what it found means the retry does
 * not have to agree with the first attempt about what the package contained —
 * and means the row still says something after the media expires.
 */
export async function markFailed(
  db: MediaDb,
  id: string,
  reason: string,
  manifest?: DeliveryFile[],
  attempts = 1,
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: "failed",
    error: reason.slice(0, 500),
    /*
     * The failure names its own next attempt. Deriving it from `updated_at`
     * would let any unrelated write to this row restart the wait, because the
     * touch trigger rewrites that column on every update.
     */
    retry_after: new Date(Date.now() + backoffMs(attempts)).toISOString(),
  };
  if (manifest) {
    patch.manifest = manifest;
    patch.media_count = manifest.length;
    patch.total_bytes = manifest.reduce((n, f) => n + (f.bytes || 0), 0);
  }
  const { error } = await db.from("media_deliveries").update(patch).eq("id", id);
  if (error) fail(`could not record the failure: ${error.message}`);
}

/**
 * Five minutes, then ten, twenty, forty, eighty — capped at about five hours.
 *
 * Long enough that a provider outage is waited out rather than hammered, and
 * short enough that a transient failure is fixed within one working morning
 * without anyone pressing anything.
 */
export function backoffMs(attempts: number): number {
  const step = Math.min(Math.max(attempts, 1), 6);
  return 5 * 60 * 1000 * 2 ** (step - 1);
}

/** Look a download link up by the token the visitor presented. */
export async function deliveryForToken(db: MediaDb, token: string): Promise<DeliveryRow | null> {
  const { data, error } = await db.from("media_deliveries")
    .select("*")
    .eq("token_hash", hashDownloadToken(token))
    .maybeSingle();
  if (error) fail(`could not check the link: ${error.message}`);
  return (data as DeliveryRow) ?? null;
}

/**
 * Is this link usable right now?
 *
 * Expiry is judged against the clock, never against the row's status: a sweep
 * that has not run yet must not make an expired link work. The status is a
 * record of what was done, the timestamp is the promise.
 */
export function linkUsable(row: DeliveryRow, now: Date): { ok: true } | { ok: false; reason: string } {
  if (row.deleted_at) return { ok: false, reason: "expired" };
  if (row.status === "expired" || row.status === "deleted") return { ok: false, reason: "expired" };
  if (!row.expires_at) return { ok: false, reason: "not_ready" };
  if (new Date(row.expires_at).getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  if (row.status !== "sent" && row.status !== "downloaded") return { ok: false, reason: "not_ready" };
  return { ok: true };
}

/** Stamp a download. Never fails the download itself — the bytes are already going out. */
export async function recordDownload(db: MediaDb, id: string): Promise<void> {
  try {
    const { data } = await db.from("media_deliveries").select("download_count").eq("id", id).maybeSingle();
    const count = Number((data as { download_count?: number } | null)?.download_count ?? 0) + 1;
    await db.from("media_deliveries").update({
      status: "downloaded",
      downloaded_at: new Date().toISOString(),
      download_count: count,
    }).eq("id", id);
  } catch {
    /* a download that happened is more important than the note that it did */
  }
}

export interface ExpiringDelivery {
  id: string;
  survey_id: string;
  status: DeliveryStatus;
  manifest: DeliveryFile[];
}

export async function findExpiring(db: MediaDb, limit = 50): Promise<ExpiringDelivery[]> {
  const { data, error } = await db.rpc("rescript_media_deliveries_expiring", { p_limit: limit });
  if (error) fail(`could not look for expiries: ${error.message}`);
  return (data ?? []) as ExpiringDelivery[];
}

/**
 * Kill the link first, delete the bytes second.
 *
 * The order is the whole point. If deletion fails — storage is down, a path
 * moved — the link is already dead and the promise in the email is already
 * kept; the next sweep tries the bytes again. Doing it the other way round
 * leaves a window in which the media is gone and the link still looks alive,
 * and a longer one in which the media is alive and the link still works after
 * it was supposed to stop.
 */
export async function expireLink(db: MediaDb, id: string): Promise<void> {
  const { error } = await db.from("media_deliveries").update({
    status: "expired",
    token_hash: null,
  }).eq("id", id);
  if (error) fail(`could not expire the link: ${error.message}`);
}

export async function markDeleted(db: MediaDb, id: string, warnings: string[]): Promise<void> {
  const { error } = await db.from("media_deliveries").update({
    status: "deleted",
    deleted_at: new Date().toISOString(),
    error: warnings.length ? warnings.join("; ").slice(0, 500) : null,
  }).eq("id", id);
  if (error) fail(`could not record the deletion: ${error.message}`);
}

/**
 * Put a failed delivery back in the queue.
 *
 * Human-triggered only, like `resetTranscript`. Clearing `attempts` is what
 * makes it different from waiting for the backoff: a person who has just
 * fixed the address is not asking for one more try under the old budget.
 */
export async function retryDelivery(db: MediaDb, id: string): Promise<void> {
  const { error } = await db.from("media_deliveries").update({
    status: "pending",
    attempts: 0,
    error: null,
    claimed_at: null,
    retry_after: null,
  }).eq("id", id).eq("status", "failed");
  if (error) fail(`could not retry the delivery: ${error.message}`);
}
