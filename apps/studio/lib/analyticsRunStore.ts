import type { AnalysisRun, DatasetSpec } from "@rescript/analytics";
import type { compactRun } from "@rescript/analytics";

/**
 * STORING AN ANALYSIS RUN (Research Engine audit, Phase 4) — the slice of
 * `lib/analytics.ts` that touches the `analytics_runs` table, kept free of
 * the Next-only `server-only` chain so a test can drive it with a stub.
 *
 * A run made after Phase 4 carries three more things than its findings:
 * the correction applied to the planned tests, the data advice, and what it
 * found beyond the plan. Migration 0048 adds a column for each. An
 * installation that has not run the migration yet must still keep its runs,
 * so the insert tries with the new columns and, when the database says it
 * has no such column, once more without them — the run is stored either
 * way, and the Studio shows what the database kept.
 */
export type CompactRun = ReturnType<typeof compactRun>;
export type StoredRun = CompactRun & { id: string; surveyVersion?: string | null; dataset?: DatasetSpec | null };

export interface RunInsertDb {
  from(table: "analytics_runs"): {
    insert(row: Record<string, unknown>): { select(columns: string): { single(): PromiseLike<{ data: Record<string, unknown> | null; error: { message: string } | null }> } };
  };
}

/** a stored row back into a run; the Phase 4 columns only when the row has them */
export function runFromRow(r: Record<string, unknown>): StoredRun {
  return {
    id: String(r.id), computedAt: String(r.computed_at), trigger: String(r.trigger), environment: r.environment as DatasetSpec["environment"], n: Number(r.n ?? 0),
    items: (r.items as StoredRun["items"]) ?? [], findings: (r.findings as StoredRun["findings"]) ?? [], verdicts: (r.verdicts as StoredRun["verdicts"]) ?? [], warnings: (r.warnings as string[]) ?? [],
    ...(r.corrections ? { corrections: r.corrections as AnalysisRun["corrections"] } : {}),
    ...(r.advice ? { advice: r.advice as AnalysisRun["advice"] } : {}),
    ...(r.discoveries ? { discoveries: r.discoveries as AnalysisRun["discoveries"] } : {}),
    ...(r.kpis ? { kpis: r.kpis as AnalysisRun["kpis"] } : {}),
    ...(r.since ? { since: r.since as AnalysisRun["since"] } : {}),
    surveyVersion: (r.survey_version as string | null) ?? null,
    dataset: (r.dataset as DatasetSpec | null) ?? null,
  };
}

/** among the runs before the one at hand (newest first), the latest on the same dataset kind — the "last wave" a run is compared with (Phase 8) */
export function pickPrevious(rows: Record<string, unknown>[], datasetKind: DatasetSpec["dataset"]): StoredRun | null {
  const row = rows.find((r) => ((r.dataset as DatasetSpec | null)?.dataset ?? "all") === datasetKind);
  return row ? runFromRow(row) : null;
}

/** does the database's error say a column we sent is not there? */
export const missingColumn = (message: string): boolean => /column|schema cache/i.test(message);

/**
 * Insert the run — with its Phase 4 fields, or without them when the table
 * predates migration 0048. The returned run carries the fields either way,
 * because the caller just computed them.
 */
export async function insertRun(db: RunInsertDb, surveyId: string, compact: CompactRun, spec: DatasetSpec, meta: { surveyVersion: string | null; userId: string | null }): Promise<{ stored: StoredRun | null; error?: string; withoutExtras?: boolean }> {
  const row = {
    survey_id: surveyId, trigger: compact.trigger, environment: compact.environment, n: compact.n, dataset: spec, computed_at: compact.computedAt,
    findings: compact.findings, verdicts: compact.verdicts, items: compact.items, warnings: compact.warnings, survey_version: meta.surveyVersion, created_by: meta.userId,
  };
  const extras = { corrections: compact.corrections ?? null, advice: compact.advice ?? null, discoveries: compact.discoveries ?? null };
  /* Phase 8: the KPI snapshot and the comparison with the previous run (migration 0049) — tried with, then without, then without the Phase 4 columns too */
  const waves = { kpis: compact.kpis ?? null, since: compact.since ?? null };
  let withoutExtras = false;
  let { data, error } = await db.from("analytics_runs").insert({ ...row, ...extras, ...waves }).select("*").single();
  if (error && missingColumn(error.message)) ({ data, error } = await db.from("analytics_runs").insert({ ...row, ...extras }).select("*").single());
  if (error && missingColumn(error.message)) { withoutExtras = true; ({ data, error } = await db.from("analytics_runs").insert(row).select("*").single()); }
  if (error || !data) return { stored: null, error: error?.message ?? "the run was not stored", withoutExtras };
  const stored = runFromRow(data);
  return { stored: { ...stored, ...(compact.corrections ? { corrections: compact.corrections } : {}), ...(compact.advice ? { advice: compact.advice } : {}), ...(compact.discoveries ? { discoveries: compact.discoveries } : {}), ...(compact.kpis ? { kpis: compact.kpis } : {}), ...(compact.since ? { since: compact.since } : {}) }, ...(withoutExtras ? { withoutExtras } : {}) };
}
