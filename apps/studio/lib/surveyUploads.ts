/**
 * RESPONDENT-UPLOADED FILES ARE NOT A POSTGRES ROW.
 *
 * A file/photo/signature/audio answer lands in the private Supabase Storage
 * bucket `rescript-uploads` at `<sessionId>/<questionId>/<file>`
 * (apps/runtime/app/api/upload/route.ts — this bucket name must match that
 * file's `BUCKET` constant). Every OTHER piece of survey-owned data lives in
 * a Postgres table with a `survey_id` foreign key that is already `ON DELETE
 * CASCADE`, so deleting the `surveys` row cleans it up for free. Object
 * storage cannot participate in that — there is no FK from a bucket object
 * to a database row — which is why "deleted surveys continue to consume
 * storage" was a real, separate gap: nothing anywhere ever called
 * `storage.remove()` for a deleted survey's uploads.
 *
 * `responses.session_id` is the key that ties a runtime session (and so its
 * uploads) back to the survey it belongs to, so this must run BEFORE
 * `rescript_delete_project` cascades the `responses` rows away.
 *
 * Deliberately best-effort: Supabase Storage cannot join the same
 * transaction as the Postgres delete, so a storage hiccup must never block
 * or fail the authoritative database delete. Failures are collected and
 * returned to the caller (for the audit log) instead of thrown.
 */
const UPLOADS_BUCKET = "rescript-uploads";
const LIST_PAGE = 1000;
const REMOVE_BATCH = 100;

export interface PurgeResult {
  removed: number;
  warnings: string[];
}

/**
 * Only the slice of the Supabase client this helper actually calls — narrow
 * on purpose so this stays a plain, dependency-free function that a test can
 * drive with a stub, rather than requiring the full `SupabaseClient` type
 * (and, transitively, the Next-only `server-only` import chain that comes
 * with `supabaseAdmin()`). The real `supabaseAdmin()` client already
 * satisfies this shape structurally, so callers pass it unchanged.
 */
export interface StorageDb {
  from(table: "responses"): {
    select(columns: string): {
      eq(column: string, value: string): PromiseLike<{ data: { session_id: string | null }[] | null; error: { message: string } | null }>;
    };
  };
  storage: {
    listBuckets(): PromiseLike<{ data: { name: string }[] | null; error: { message: string } | null }>;
    from(bucket: string): {
      list(path: string, options?: { limit: number }): PromiseLike<{ data: { name: string }[] | null; error: { message: string } | null }>;
      remove(paths: string[]): PromiseLike<{ data: unknown; error: { message: string } | null }>;
    };
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function purgeSurveyUploads(
  db: StorageDb,
  surveyId: string,
): Promise<PurgeResult> {
  const warnings: string[] = [];
  let removed = 0;

  const { data: rows, error: readErr } = await db
    .from("responses")
    .select("session_id")
    .eq("survey_id", surveyId);
  if (readErr) {
    warnings.push(`could not list response sessions for storage cleanup: ${readErr.message}`);
    return { removed, warnings };
  }
  const sessionIds = Array.from(
    new Set((rows ?? []).map((r) => r.session_id as string | null).filter((s): s is string => !!s)),
  );
  if (sessionIds.length === 0) return { removed, warnings };

  /*
   * Same idempotent-bucket-existence check the upload route itself uses: a
   * customer whose surveys have never received a file upload has no
   * `rescript-uploads` bucket at all yet, and listing a nonexistent bucket
   * is an error, not an empty result — skip entirely rather than warning
   * about the overwhelmingly common case of "there was nothing to clean up".
   */
  const { data: buckets, error: bucketsErr } = await db.storage.listBuckets();
  if (bucketsErr) {
    warnings.push(`could not check storage buckets: ${bucketsErr.message}`);
    return { removed, warnings };
  }
  if (!buckets?.some((b) => b.name === UPLOADS_BUCKET)) return { removed, warnings };

  const allPaths: string[] = [];
  for (const sessionId of sessionIds) {
    try {
      const { data: entries, error: listErr } = await db.storage
        .from(UPLOADS_BUCKET)
        .list(sessionId, { limit: LIST_PAGE });
      if (listErr) {
        warnings.push(`storage list failed for session ${sessionId}: ${listErr.message}`);
        continue;
      }
      // entries here are the per-question folders (`<sessionId>/<questionId>/`)
      for (const entry of entries ?? []) {
        const questionPath = `${sessionId}/${entry.name}`;
        const { data: files, error: fileErr } = await db.storage
          .from(UPLOADS_BUCKET)
          .list(questionPath, { limit: LIST_PAGE });
        if (fileErr) {
          warnings.push(`storage list failed for ${questionPath}: ${fileErr.message}`);
          continue;
        }
        for (const f of files ?? []) allPaths.push(`${questionPath}/${f.name}`);
      }
    } catch (e) {
      warnings.push(`storage cleanup threw for session ${sessionId}: ${(e as Error).message}`);
    }
  }

  for (const batch of chunk(allPaths, REMOVE_BATCH)) {
    try {
      const { error: rmErr } = await db.storage.from(UPLOADS_BUCKET).remove(batch);
      if (rmErr) warnings.push(`storage remove failed for a batch of ${batch.length}: ${rmErr.message}`);
      else removed += batch.length;
    } catch (e) {
      warnings.push(`storage remove threw for a batch of ${batch.length}: ${(e as Error).message}`);
    }
  }

  return { removed, warnings };
}
