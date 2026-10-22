import type { SupabaseClient } from "@supabase/supabase-js";
import { advancedStaleness, plannedIdOf, type AnalysisDefinition, type DatasetSpec, type Staleness } from "@rescript/analytics";

/**
 * THE ADVANCED MODELS OF A PLAN, LIVE (2026-10-22) — the part of the service
 * that reads the database, kept free of `server-only` so a test drives it over
 * the in-memory Supabase (the way modelJobs.test.ts drives the job service).
 *
 *   isAdvancedDefinition   HB / latent class / SEM, a bootstrapped mediation, ω, Gabor–Granger
 *   advancedStatus         each advanced item of the plan: when its valid result was computed (a
 *                          finished HB job, or the latest run of the plan), the completes that
 *                          arrived since, a running job's progress — fresh, stale, never run or running
 *   rerunTargets           what a re-run should redo: HB items to (re)start as jobs, and whether the
 *                          plan's other advanced items need a new run
 *
 * Nothing here overwrites a result: a stale one is flagged and kept until a
 * re-run replaces it (by hand, or by the plan's threshold policy in the cron).
 */

export function isAdvancedDefinition(def: Pick<AnalysisDefinition, "kind" | "options">): boolean {
  const o = (def.options ?? {}) as Record<string, unknown>;
  return def.kind === "hb" || def.kind === "lca" || def.kind === "sem"
    || (def.kind === "regression" && !!o.bootstrap) || (def.kind === "reliability" && o.omega === true) || (def.kind === "pricing" && o.method === "gabor_granger");
}

export interface AdvancedPlanItem { planned: string; title: string; definition: AnalysisDefinition; analysisId: string | null }
export interface AdvancedRunLike { computedAt: string; n: number; items: { definition: AnalysisDefinition; error?: { code?: string; message?: string } | null }[] }
export interface AdvancedJobBrief { id: string; status: string; pct: number; done: number; total: number; finishedAt: string | null }
export interface AdvancedItemStatus { planned: string; title: string; kind: string; analysisId: string | null; staleness: Staleness; job: AdvancedJobBrief | null }
export type AdvancedPolicy = { mode?: "manual" | "threshold"; newResponses?: number } | null | undefined;

interface JobRow { id: string; status: string; progress: { done?: number; total?: number } | null; finished_at: string | null; created_at: string; definition: unknown }

/** completes that arrived after `since` in this dataset's environment */
export async function completesSince(db: SupabaseClient, surveyId: string, environment: DatasetSpec["environment"], since: string): Promise<number> {
  let q = db.from("responses").select("id", { count: "exact", head: true }).eq("survey_id", surveyId).is("deleted_at", null).eq("status", "complete").gt("completed_at", since);
  if (environment === "LIVE") q = q.eq("is_test", false); else if (environment === "TEST") q = q.eq("is_test", true);
  const { count } = await q;
  return count ?? 0;
}

export async function advancedStatus(db: SupabaseClient, surveyId: string, input: { items: AdvancedPlanItem[]; run: AdvancedRunLike | null; environment: DatasetSpec["environment"]; policy?: AdvancedPolicy }): Promise<AdvancedItemStatus[]> {
  const items = input.items.filter((i) => isAdvancedDefinition(i.definition));
  if (!items.length) return [];
  /* the jobs table may not exist yet (0066): then no item has a job, and HB items are never run */
  const { data } = await db.from("analytics_model_jobs").select("id, status, progress, finished_at, created_at, definition").eq("survey_id", surveyId).order("created_at", { ascending: false }).limit(50);
  const jobs = ((data ?? []) as JobRow[]);
  const sinceCache = new Map<string, number>();
  const since = async (at: string) => { if (!sinceCache.has(at)) sinceCache.set(at, await completesSince(db, surveyId, input.environment, at)); return sinceCache.get(at)!; };
  const out: AdvancedItemStatus[] = [];
  for (const it of items) {
    const mine = jobs.filter((j) => plannedIdOf(j.definition as AnalysisDefinition) === it.planned);
    const running = mine.find((j) => j.status === "running");
    const done = mine.find((j) => j.status === "done");
    const job = running ?? mine[0];
    const brief: AdvancedJobBrief | null = job ? { id: job.id, status: job.status, done: Number(job.progress?.done ?? 0), total: Number(job.progress?.total ?? 0), pct: job.progress?.total ? Math.min(100, Math.round((Number(job.progress.done ?? 0) / Number(job.progress.total)) * 1000) / 10) : job.status === "done" ? 100 : 0, finishedAt: job.finished_at } : null;
    let computedAt: string | null = null, nAtRun: number | null = null;
    if (it.definition.kind === "hb") computedAt = done?.finished_at ?? null;
    else {
      const ran = input.run?.items.find((x) => plannedIdOf(x.definition) === it.planned);
      if (ran && !ran.error) { computedAt = input.run!.computedAt; nAtRun = input.run!.n; }
    }
    const newSince = computedAt ? await since(computedAt) : 0;
    out.push({ planned: it.planned, title: it.title, kind: it.definition.kind, analysisId: it.analysisId, job: brief, staleness: advancedStaleness({ computedAt, nAtRun, newSince, running: !!running, policy: input.policy }) });
  }
  return out;
}

/** what a re-run redoes: the HB items whose result is stale or missing (each a job), and whether any other advanced item needs the plan run again */
export function rerunTargets(status: readonly AdvancedItemStatus[], opts: { onlyAuto?: boolean } = {}): { hb: string[]; runPlan: boolean } {
  const want = (s: AdvancedItemStatus) => (opts.onlyAuto ? s.staleness.autoRerun : s.staleness.state === "stale" || s.staleness.state === "never_run");
  return {
    hb: status.filter((s) => s.kind === "hb" && s.staleness.state !== "running" && want(s)).map((s) => s.planned),
    runPlan: status.some((s) => s.kind !== "hb" && want(s)),
  };
}
