import type { RetentionScope } from "./limits.js";

/**
 * WHAT THE SCHEDULED SWEEPS ARE ALLOWED TO DELETE.
 *
 * Three sweeps, all with their SQL written since 0030 and none with a
 * scheduler: retention, abandoned uploads, and objects in the bucket that no
 * row knows about. The arithmetic is here, away from the database and away
 * from the object store, because deletion is the one operation in this system
 * that cannot be undone and a mistake in it is somebody's research data.
 *
 * ## The rule that shapes all of it
 *
 * A sweep deletes only what it can NAME. Not "everything under this prefix",
 * not "everything older than", but a specific list of keys arrived at from
 * rows that say those keys should go. `rescript_interview_media_for` exists
 * precisely so the keys are read BEFORE the rows are dropped — an object whose
 * row is already gone is invisible for ever, and a bucket accumulating
 * invisible objects is a bill nobody can explain.
 *
 * The orphan sweep is the one that looks most like "delete everything under a
 * prefix", and it is the one hedged hardest: an object is only an orphan if it
 * is old enough that no upload could still be in flight, AND the database was
 * successfully asked about it, AND the answer was no.
 */

export interface RetentionPlan {
  /** the recordings themselves — bytes in the bucket */
  media: boolean;
  /** the words. Kept by default: a transcript is the research, the video is the source. */
  transcripts: boolean;
  /** the machine's reading of the words */
  analysis: boolean;
  /** true when nothing at all would be removed, so the sweep can skip the interview */
  empty: boolean;
}

/**
 * Read a project's scope into a plan.
 *
 * Missing means FALSE for everything except media, and that asymmetry is
 * deliberate. A project that set a retention period meant "stop holding the
 * recordings"; nobody who writes `retention_days: 90` is asking for their
 * analysis to be destroyed as well, and a sweep that inferred it would delete
 * the findings somebody wrote a report from.
 */
export function retentionPlan(
  /*
   * PARTIAL, because this reads a jsonb column. `retention_scope` has a
   * default in the schema but an older row, a hand-edited one, or one written
   * before a key existed can be missing any of them — and a sweep that threw
   * on a malformed scope would stop deleting anything at all.
   */
  scope: Partial<RetentionScope> | null | undefined,
): RetentionPlan {
  const s = scope ?? {};
  const media = s.media !== false;
  const transcripts = s.transcripts === true;
  const analysis = s.analysis === true;
  return { media, transcripts, analysis, empty: !media && !transcripts && !analysis };
}

/**
 * Is this interview actually due?
 *
 * Belt and braces over `rescript_interview_retention_due`, which already
 * filters — because the sweep reads a list and then acts on it item by item,
 * and between the read and the act somebody may have changed the policy.
 * Re-checking costs nothing and is the difference between a sweep and a
 * deletion script.
 */
export function isRetentionDue(
  interview: { completedAt: string | Date | null; mediaPurgedAt: string | Date | null },
  retentionDays: number | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!retentionDays || retentionDays <= 0) return false;
  if (interview.mediaPurgedAt) return false;
  if (!interview.completedAt) return false;
  const completed = new Date(interview.completedAt).getTime();
  if (!Number.isFinite(completed)) return false;
  return now.getTime() - completed >= retentionDays * 86_400_000;
}

/* ------------------------------------------------------ abandoned uploads */

/**
 * How long an unfinished upload is given before it is abandoned.
 *
 * Two hours. `UPLOAD_SECONDS` in `@rescript/storage` signs part URLs for that
 * long, so an upload still going after it cannot finish anyway — its URLs have
 * expired. Shorter would abort uploads that are merely slow; a candidate on a
 * train with a ninety-minute session is exactly the person this must not cut off.
 */
export const ABANDON_UPLOAD_AFTER_MS = 2 * 60 * 60 * 1000;

export function isAbandonedUpload(
  media: { uploadStatus: string; createdAt: string | Date },
  now: Date = new Date(),
): boolean {
  if (media.uploadStatus !== "pending" && media.uploadStatus !== "uploading") return false;
  const created = new Date(media.createdAt).getTime();
  if (!Number.isFinite(created)) return false;
  return now.getTime() - created >= ABANDON_UPLOAD_AFTER_MS;
}

/* ---------------------------------------------------------- orphans */

/**
 * An object may only be called an orphan after this long.
 *
 * Twenty-four hours, against two hours for an abandoned upload, because the
 * consequences are not symmetrical. Aborting an upload too early loses an
 * upload that could have been resumed; deleting an object too early loses a
 * recording. The window is long enough that every upload in flight has either
 * finished and written its row or been swept by the abandoned-upload sweep.
 */
export const ORPHAN_AFTER_MS = 24 * 60 * 60 * 1000;

export interface StoredObject {
  key: string;
  /** when the store says it was last written */
  lastModified: string | Date | null;
  size?: number;
}

export interface OrphanDecision {
  /** safe to delete: old enough, and no row claims it */
  orphans: string[];
  /** too recent to judge — an upload may still be finishing */
  tooNew: string[];
  /** a row claims this key, so it is not an orphan whatever its age */
  claimed: string[];
}

/**
 * Which objects in the bucket nothing knows about.
 *
 * `knownKeys` must be every key the database holds for this prefix, INCLUDING
 * deleted rows: a row marked `deleted_at` whose object has not yet been removed
 * is not an orphan, it is a pending deletion, and treating it as an orphan
 * would race the retention sweep to the same object.
 *
 * An object with no modification time is treated as too new, not as an orphan.
 * "The store could not tell us how old this is" is not evidence that nobody
 * wants it.
 */
export function findOrphans(
  objects: readonly StoredObject[],
  knownKeys: ReadonlySet<string>,
  now: Date = new Date(),
): OrphanDecision {
  const orphans: string[] = [];
  const tooNew: string[] = [];
  const claimed: string[] = [];

  for (const o of objects) {
    if (knownKeys.has(o.key)) { claimed.push(o.key); continue; }
    const at = o.lastModified ? new Date(o.lastModified).getTime() : Number.NaN;
    if (!Number.isFinite(at) || now.getTime() - at < ORPHAN_AFTER_MS) {
      tooNew.push(o.key);
      continue;
    }
    orphans.push(o.key);
  }

  return { orphans, tooNew, claimed };
}

/**
 * A ceiling on one sweep's deletions.
 *
 * Not a performance limit — a blast radius. A bug that makes every object look
 * like an orphan destroys a hundred recordings instead of a bucket, and the
 * next pass is five minutes away so a genuine backlog still clears. The number
 * is small on purpose: nobody has ever wished a deletion sweep had been faster.
 */
export const MAX_DELETIONS_PER_SWEEP = 100;

/**
 * Refuse a sweep that wants to delete an implausible share of what it saw.
 *
 * The failure this exists for: a listing that returns objects while the
 * database query silently returns none — a permission change, an outage, a
 * typo'd column — makes EVERY object look unclaimed. The proportion is the
 * signal, and it is checked before anything is deleted rather than after.
 */
export function orphanSweepIsSane(
  decision: OrphanDecision,
  seen: number,
  maxShare = 0.5,
): { ok: true } | { ok: false; reason: string } {
  if (!seen || !decision.orphans.length) return { ok: true };
  const share = decision.orphans.length / seen;
  if (share > maxShare) {
    return {
      ok: false,
      reason:
        `${decision.orphans.length} of ${seen} objects looked unclaimed ` +
        `(${Math.round(share * 100)}%). That is more likely a failed lookup than a real backlog, ` +
        "so nothing was deleted.",
    };
  }
  return { ok: true };
}
