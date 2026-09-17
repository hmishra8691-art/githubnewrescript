import "server-only";
import {
  ABANDON_UPLOAD_AFTER_MS, MAX_DELETIONS_PER_SWEEP, findOrphans, isRetentionDue,
  orphanSweepIsSane, retentionPlan,
} from "@rescript/interviews";
import { organizationPrefix, type MediaStorageProvider } from "@rescript/storage";
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
 * Delete objects in batches and say which ones actually went.
 *
 * Two things this fixes. First, the old sweep deleted `keys.slice(0, 100)` and
 * then marked EVERY row of the interview deleted — so an interview with more
 * than a hundred objects lost the rows' claim on objects 101+, which no row
 * could then name and the orphan sweep classified as claimed. They stayed in
 * the bucket for ever. Every key is now deleted, a hundred at a time, and a row
 * is marked only when its key was in a batch that succeeded.
 *
 * Second, nothing ever CHECKED. R2's batch delete is sent `Quiet`, so the only
 * failure signal was a transport error. Each key is now HEADed afterwards and
 * the result — gone, or still there — is written to `interview_deletions`. A
 * deletion that cannot be shown to have happened is not a deletion policy, it
 * is a hope.
 */
async function deleteVerified(
  store: MediaStorageProvider,
  keys: readonly string[],
  audit: (key: string, verified: boolean | null) => Promise<void>,
): Promise<{ deleted: string[]; failed: string[]; unverified: string[] }> {
  const deleted: string[] = [];
  const failed: string[] = [];
  const unverified: string[] = [];
  for (let at = 0; at < keys.length; at += MAX_DELETIONS_PER_SWEEP) {
    const batch = keys.slice(at, at + MAX_DELETIONS_PER_SWEEP);
    try {
      await store.delete(batch);
    } catch {
      failed.push(...batch);
      continue;
    }
    for (const key of batch) {
      let gone: boolean | null = null;
      try { gone = !(await store.exists(key)); } catch { gone = null; }
      if (gone === false) { failed.push(key); await audit(key, false); continue; }
      if (gone === null) unverified.push(key);
      deleted.push(key);
      await audit(key, gone);
    }
  }
  return { deleted, failed, unverified };
}

interface DueRow {
  interview_id: string; project_id: string; customer_id: string;
  retention_days: number | null; retention_hours: number | null;
  retention_scope: Record<string, boolean> | null;
  completed_at: string | null; last_activity_at: string | null; mode: string | null;
}

/**
 * Remove what a project's retention policy says should be gone.
 *
 * The SQL function finds interviews past their window — measured from last
 * activity, in hours when the project says hours — and this re-checks each one
 * before acting, because the list was read a moment ago and a policy can change
 * between reading and acting.
 *
 * The scope now reaches the PERSON. Media went before; transcripts and analysis
 * were optional. `responses`, `telemetry` and `identity` are new: typed
 * answers, the behavioural events, and the candidate's name, email, hashed IP,
 * user agent and roster row. A retention policy that deleted the video and
 * kept "Alex Morgan, alex@example.com, answered Q3 with…" for ever was not a
 * retention policy.
 *
 * Order, unchanged: keys → objects → rows. `media_purged_at` is written LAST so
 * a failure anywhere above leaves the interview due and the next pass finishes.
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

  for (const row of (due ?? []) as DueRow[]) {
    const plan = retentionPlan(row.retention_scope ?? undefined);
    if (plan.empty) continue;

    if (!isRetentionDue(
      { completedAt: row.completed_at, lastActivityAt: row.last_activity_at, mediaPurgedAt: null },
      row.retention_days, new Date(), row.retention_hours,
    )) continue;

    const now = new Date().toISOString();
    const log = (what: string, extra: Record<string, unknown> = {}) => db.from("interview_deletions").insert({
      customer_id: row.customer_id, project_id: row.project_id, interview_id: row.interview_id,
      what, reason: "retention", deleted_at: now, ...extra,
    });

    try {
      let mediaOk = true;
      if (plan.media) {
        /* keys FIRST — after the rows change, the objects are unnameable */
        const { data: objects } = await db.rpc("rescript_interview_media_for", { p_interview: row.interview_id });
        const rows = ((objects ?? []) as { id: string; storage_key: string }[]).filter((m) => m.storage_key);
        const byKey = new Map(rows.map((m) => [m.storage_key, m.id]));

        const outcome = await deleteVerified(store.storage, rows.map((m) => m.storage_key), async (key, verified) => {
          await log("media", {
            media_id: byKey.get(key) ?? null, storage_key: key, verified,
            verified_at: verified === null ? null : now,
          });
        });
        report.mediaDeleted += outcome.deleted.length;
        if (outcome.unverified.length) report.warnings.push(`${outcome.unverified.length} deletions could not be verified for interview ${row.interview_id.slice(0, 8)}`);
        if (outcome.failed.length) {
          mediaOk = false;
          report.warnings.push(`${outcome.failed.length} objects could not be deleted for interview ${row.interview_id.slice(0, 8)}; the interview stays due`);
        }

        /* only the rows whose objects are gone — a row must keep naming an object that still exists */
        const goneIds = outcome.deleted.map((k) => byKey.get(k)).filter((x): x is string => !!x);
        if (goneIds.length) {
          await db.from("interview_media")
            .update({ upload_status: "deleted", deleted_at: now })
            .in("id", goneIds).is("deleted_at", null);
        }
      }

      if (plan.transcripts) {
        await db.from("interview_transcripts").delete().eq("interview_id", row.interview_id);
        await log("transcripts");
      }
      if (plan.analysis) {
        await db.from("interview_evidence").delete().eq("interview_id", row.interview_id);
        await db.from("interview_analysis").delete().eq("interview_id", row.interview_id);
        await log("analysis");
      }
      if (plan.responses) {
        /*
         * The rows stay — they are the record that a question was asked and
         * answered, which the scorecard and the dashboard count — but the
         * CONTENT goes: what was typed, what was chosen, the transcript copied
         * onto the row.
         */
        await db.from("interview_responses")
          .update({ answer_text: null, answer_value: null, updated_at: now })
          .eq("interview_id", row.interview_id);
        await log("responses");
      }
      if (plan.telemetry) {
        await db.from("interview_telemetry").delete().eq("interview_id", row.interview_id);
        await log("telemetry");
      }
      if (plan.identity) {
        await db.from("interviews")
          .update({ candidate_name: null, candidate_email: null, ip_hash: null, user_agent: null })
          .eq("id", row.interview_id);
        /* the roster row the trigger mirrored the respondent into */
        await db.from("interview_people")
          .update({ display_name: "Removed under retention", email: null, archived_at: now })
          .eq("interview_id", row.interview_id).eq("derived", true);
        await log("identity");
      }

      /*
       * `media_purged_at` is what stops the same interview being swept every
       * five minutes for ever. Written only when the media step fully
       * succeeded, so a partial object deletion leaves the interview due.
       */
      if (mediaOk) {
        await db.from("interviews").update({ media_purged_at: now }).eq("id", row.interview_id);
        report.retained++;
      }
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

  const now = new Date().toISOString();
  const outcome = await deleteVerified(store.storage, toDelete, async (key, verified) => {
    await db.from("interview_deletions").insert({
      customer_id: customerId, what: "orphan", reason: "orphan", storage_key: key,
      deleted_at: now, verified, verified_at: verified === null ? null : now,
    });
  });
  report.orphansDeleted += outcome.deleted.length;
  if (outcome.failed.length) report.warnings.push(`${outcome.failed.length} orphaned objects could not be deleted`);
  console.info("[rescript:interviews] orphans removed", JSON.stringify({
    customer: customerId.slice(0, 8), deleted: outcome.deleted.length, seen: objects.length,
  }));
}

/**
 * The orphan sweep, for every organization that has interview projects.
 *
 * It was written per organization "from an explicit call" and nothing ever
 * called it, so an object whose row was lost stayed in the bucket for ever.
 * It is now on the schedule, still per organization, still bounded by the
 * same sanity check and blast radius per pass, and it stops when the cron's
 * time is spent. One listing page per organization per pass is enough: a
 * genuine backlog clears over a few passes, and a bucket that is emptier than
 * expected is exactly the condition `orphanSweepIsSane` refuses on.
 */
export async function sweepOrphansEverywhere(report: SweepReport, hasTime: () => boolean): Promise<void> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("rescript_interview_customers");
  if (error) { report.warnings.push(`could not list organizations for the orphan sweep: ${error.message}`); return; }
  for (const row of (data ?? []) as { customer_id: string }[]) {
    if (!hasTime()) { report.warnings.push("orphan sweep stopped early: the window was spent"); return; }
    await sweepOrphans(report, row.customer_id);
  }
}
