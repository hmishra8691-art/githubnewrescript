/**
 * COPYING PUBLISHED VERSIONS INTO OBJECT STORAGE (scale readiness step 4, phase A; migration 0112).
 *
 * Two ways in, one rule. A version is copied right after it is cut (best effort, bounded — the cut has already
 * succeeded and must never fail because of this), and a sweep copies whatever that missed, plus every version that
 * existed before 0112. The rule: `definition_hash` is written only after the store has confirmed the object, and only
 * once (a database trigger refuses to change it), so a non-null hash always names an object that exists.
 *
 * Postgres keeps the jsonb in phase A. Nothing reads the copy yet.
 */
import { storeDefinition, type ObjectStore } from "@rescript/media";

/** the slice of a Supabase client this needs */
export interface VersionDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

export interface CopyResult { id: string; hash?: string; written?: boolean; error?: string }

/** Copy one version whose definition the caller already holds. Never throws. */
export async function copyVersionDefinition(db: VersionDb, store: ObjectStore, versionId: string, definition: unknown): Promise<CopyResult> {
  try {
    const s = await storeDefinition(store, definition);
    const { error } = await db.from("survey_versions")
      .update({ definition_hash: s.hash, definition_bytes: s.bytes, definition_store: s.store, definition_stored_at: new Date().toISOString() })
      .eq("id", versionId)
      .is("definition_stored_at", null);
    if (error) return { id: versionId, error: error.message };
    return { id: versionId, hash: s.hash, written: s.written };
  } catch (e) {
    return { id: versionId, error: (e as Error).message };
  }
}

/** The same, giving up after `ms` so a slow store never holds a request open. */
export async function copyVersionDefinitionWithin(ms: number, db: VersionDb, store: ObjectStore, versionId: string, definition: unknown): Promise<CopyResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<CopyResult>((resolve) => { timer = setTimeout(() => resolve({ id: versionId, error: `not copied within ${ms} ms (the sweep will)` }), ms); });
  try { return await Promise.race([copyVersionDefinition(db, store, versionId, definition), late]); }
  finally { clearTimeout(timer); }
}

export interface SweepReport { copied: number; deduplicated: number; failed: CopyResult[]; remaining: boolean; skipped?: string }

/**
 * Copy versions not yet in the store, oldest first, a few at a time (a definition can be megabytes, so the batch is
 * small and the loop is bounded by time). Missing columns (0112 not applied) answer `skipped`.
 */
export async function sweepVersionDefinitions(db: VersionDb, store: ObjectStore, opts: { budgetMs?: number; batch?: number; now?: () => number } = {}): Promise<SweepReport> {
  const now = opts.now ?? Date.now;
  const started = now();
  const budget = opts.budgetMs ?? 40_000;
  const batch = opts.batch ?? 10;
  const report: SweepReport = { copied: 0, deduplicated: 0, failed: [], remaining: false };
  const failedIds = new Set<string>();
  while (now() - started < budget) {
    let q = db.from("survey_versions").select("id, definition").is("definition_stored_at", null).order("created_at", { ascending: true }).limit(batch);
    if (failedIds.size) q = q.not("id", "in", `(${[...failedIds].join(",")})`);
    const { data, error } = await q;
    if (error) {
      if (/definition_stored_at|does not exist|schema cache/i.test(error.message)) return { ...report, skipped: "migration 0112 not applied" };
      report.failed.push({ id: "*", error: error.message });
      return report;
    }
    const rows = (data ?? []) as { id: string; definition: unknown }[];
    if (!rows.length) return report;
    for (const row of rows) {
      const r = await copyVersionDefinition(db, store, row.id, row.definition);
      if (r.error) { report.failed.push(r); failedIds.add(row.id); }
      else if (r.written) report.copied++;
      else report.deduplicated++;
    }
    if (rows.length < batch) return report;
  }
  report.remaining = true;
  return report;
}
