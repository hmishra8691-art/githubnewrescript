import "server-only";
import {
  ABANDON_UPLOAD_AFTER_MS, MAX_DELETIONS_PER_SWEEP, findOrphans, isRetentionDue,
  orphanSweepIsSane, retentionPlan,
} from "@rescript/interviews";
import { organizationPrefix } from "@rescript/storage";
import { supabaseAdmin } from "./admin";
import { storageOrResponse } from "./storage";

/**
 * THE THREE SWEEPS THAT KEEP A BUCKET HONEST.
 *
 * All three had their SQL written in 0030 and none had a scheduler, which
 * meant: retention policies were stored and never applied, abandoned uploads
 * accumulated parts nobody was billed for visibly, and an object whose row was
 * lost stayed in the bucket for ever. Storage is the one cost in this product
 * that grows whether or not anybody uses it.
 *
 * ## They run from the cron, not the queue
 *
 * A job in `interview_jobs` is work about one subject, enqueued by something
 * that knows the subject exists. A sweep is the opposite: its whole job is to
 * FIND the subjects. Putting it through the queue would need something to
 * enqueue it, which is the same scheduling problem one level down.
 *
 * ## Order of operations, in all three
 *
 *   read the keys  →  delete the objects  →  then update the rows
 *
 * Never the reverse. A row dropped before its object is deleted leaves an
 * object nothing can name — `rescript_interview_media_for` exists precisely to
 * make this order possible. If the object deletion fails, the row is untouched
 * and the next pass tries again; if the row update fails, the object is gone
 * and the next pass finds nothing to delete and fixes the row. Both failures
 * are recoverable. The other order is not.
 */

export interface SweepReport {
  retained: number;
  mediaDeleted: number;
  uploadsAbandoned: number;
  orphansDeleted: number;
  warnings: string[];
}

export function emptySweepReport(): SweepReport {
  return { retained: 0, mediaDeleted: 0, uploadsAbandoned: 0, orphansDeleted: 0, warnings: [] };
}

/* ------------------------------------------------------------ retention */

/**
 * Remove what a project's retention policy says should be gone.
 *
 * The SQL function finds interviews past their window; this re-checks each one
 * before acting, because the list was read a moment ago and a policy can change
 * between reading and acting. Re-checking costs nothing and is the difference
 * between a sweep and a deletion script.
 */
export async function sweepRetention(report: SweepReport, limit = 25): Promise<void> {
  const db = supabaseAdmin();
  const store = storageOrResponse();
  if ("response" in store) {
    report.warnings.push("storage is not configured, so retention could not run");
    return;
  }

  const { data: due, error } = await db.rpc("rescript_interview_retention_due", { p_limit: limit });
  if (error) {
    report.warnings.push(`could not list interviews due for retention: ${error.message}`);
    return;
  }

  for (const row of (due ?? []) as {
    interview_id: string; project_id: string; customer_id: string;
    retention_days: number | null; retention_scope: Record<string, boolean> | null;
    completed_at: string | null;
  }[]) {
    const plan = retentionPlan(row.retention_scope ?? undefined);
    if (plan.empty) continue;

    if (!isRetentionDue(
      { completedAt: row.completed_at, mediaPurgedAt: null }, row.retention_days,
    )) continue;

    try {
      if (plan.media) {
        /* keys FIRST — after the rows change, the objects are unnameable */
        const { data: objects } = await db.rpc("rescript_interview_media_for", {
          p_interview: row.interview_id,
        });
        const keys = ((objects ?? []) as { id: string; storage_key: string }[])
          .map((m) => m.storage_key)
          .filter(Boolean);

        if (keys.length) {
          await store.storage.delete(keys.slice(0, MAX_DELETIONS_PER_SWEEP));
          report.mediaDeleted += Math.min(keys.length, MAX_DELETIONS_PER_SWEEP);
        }

        await db.from("interview_media")
          .update({ upload_status: "deleted", deleted_at: new Date().toISOString() })
          .eq("interview_id", row.interview_id)
          .is("deleted_at", null);
      }

      if (plan.transcripts) {
        await db.from("interview_transcripts").delete().eq("interview_id", row.interview_id);
      }
      if (plan.analysis) {
        await db.from("interview_evidence").delete().eq("interview_id", row.interview_id);
        await db.from("interview_analysis").delete().eq("interview_id", row.interview_id);
      }

      /*
       * `media_purged_at` is what stops the same interview being swept every
       * five minutes for ever. Written last, so a failure anywhere above leaves
       * the interview due and the next pass finishes the job.
       */
      await db.from("interviews")
        .update({ media_purged_at: new Date().toISOString() })
        .eq("id", row.interview_id);

      report.retained++;
    } catch (e) {
      report.warnings.push(
        `retention failed for interview ${row.interview_id.slice(0, 8)}: ${(e as Error).message}`,
      );
    }
  }
}

/* --------------------------------------------------- abandoned uploads */

/**
 * Abort uploads that were begun and never finished.
 *
 * A browser that closes mid-transfer sends no request to say so. Without this
 * the parts sit in the bucket being billed for, invisibly, until the bucket's
 * own lifecycle rule notices — which is a backstop, not a plan, and only
 * exists if somebody configured it.
 *
 * The multipart abort comes first and its failure is tolerated: a store that
 * has already forgotten the upload is not a reason to leave the row saying an
 * upload is in progress for ever.
 */
export async function sweepAbandonedUploads(report: SweepReport, limit = 50): Promise<void> {
  const db = supabaseAdmin();
  const store = storageOrResponse();
  if ("response" in store) return;

  /*
   * The window comes from the constant rather than a literal, so the reason
   * for it — signed part URLs expire after this long, so an upload still going
   * cannot finish — lives with the number instead of beside a call.
   */
  const { data, error } = await db.rpc("rescript_interview_abandoned_uploads", {
    p_older_than_minutes: Math.round(ABANDON_UPLOAD_AFTER_MS / 60_000),
    p_limit: limit,
  });
  if (error) {
    report.warnings.push(`could not list abandoned uploads: ${error.message}`);
    return;
  }

  for (const row of (data ?? []) as {
    id: string; storage_key: string; multipart_upload_id: string | null; project_id: string;
  }[]) {
    try {
      if (row.multipart_upload_id) {
        await store.storage
          .abortMultipartUpload(row.storage_key, row.multipart_upload_id)
          .catch(() => { /* already gone, or never existed — the row still needs settling */ });
      }
      await db.from("interview_media").update({
        upload_status: "failed",
        multipart_upload_id: null,
        error: "the upload was never finished and has been abandoned",
      }).eq("id", row.id);
      report.uploadsAbandoned++;
    } catch (e) {
      report.warnings.push(`could not abandon upload ${row.id.slice(0, 8)}: ${(e as Error).message}`);
    }
  }
}

/* -------------------------------------------------------------- orphans */

/**
 * Objects in the bucket that no row knows about.
 *
 * The most dangerous of the three, and the most hedged. It runs for ONE
 * organization at a time, over one listing page, and it refuses outright if an
 * implausible share of what it saw looks unclaimed — because the way this goes
 * wrong is not a subtle miscount, it is the database lookup silently returning
 * nothing while the listing works, at which point every object in the bucket
 * looks like an orphan.
 */
export async function sweepOrphans(
  report: SweepReport, customerId: string, limit = 200,
): Promise<void> {
  const db = supabaseAdmin();
  const store = storageOrResponse();
  if ("response" in store) return;

  let listed;
  try {
    listed = await store.storage.list(organizationPrefix(customerId), { limit });
  } catch (e) {
    report.warnings.push(`could not list storage: ${(e as Error).message}`);
    return;
  }

  const objects = (listed?.objects ?? []).map((o) => ({
    key: o.key,
    lastModified: o.lastModified,
    size: o.size,
  }));
  if (!objects.length) return;

  /*
   * Every key the database holds for these objects, INCLUDING deleted rows: a
   * deleted row whose object is still there is a pending deletion, not an
   * orphan, and racing the retention sweep to the same object helps nobody.
   */
  const { data: known, error } = await db
    .from("interview_media")
    .select("storage_key")
    .in("storage_key", objects.map((o) => o.key));
  if (error) {
    /* a failed lookup is EXACTLY the condition that makes everything look unclaimed */
    report.warnings.push(`could not check which objects are known: ${error.message}`);
    return;
  }

  const decision = findOrphans(
    objects,
    new Set(((known ?? []) as { storage_key: string }[]).map((k) => k.storage_key)),
  );

  const sane = orphanSweepIsSane(decision, objects.length);
  if (!sane.ok) {
    report.warnings.push(sane.reason);
    return;
  }

  const toDelete = decision.orphans.slice(0, MAX_DELETIONS_PER_SWEEP);
  if (!toDelete.length) return;

  try {
    await store.storage.delete(toDelete);
    report.orphansDeleted += toDelete.length;
    console.info("[rescript:interviews] orphans removed", JSON.stringify({
      customer: customerId.slice(0, 8), deleted: toDelete.length, seen: objects.length,
    }));
  } catch (e) {
    report.warnings.push(`could not delete orphaned objects: ${(e as Error).message}`);
  }
}
