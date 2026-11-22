import type { AnalysisDefinition, AnalysisResult, ReportDefinition } from "@rescript/analytics";
import { failedResult, reportAnalysisIds } from "@rescript/analytics";
import type { Db } from "./db";
import { compute, type loadDefinition } from "./analytics";

const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

/**
 * Compute every analysis a report references.
 *
 * `extraFilterIds` is how a REPORT-LEVEL filter and a viewer filter (§36) are
 * applied: the ids are appended to each analysis's own `filterIds`, and
 * `resolveSaved` already ANDs those into one condition. So "the North region
 * report" is the same saved analyses seen through one more filter, rather
 * than a duplicate set of analyses that has to be maintained twice — which is
 * the mistake that makes regional reports drift from the national one.
 */
export async function computeReport(
  db: Db,
  surveyId: string,
  loaded: Awaited<ReturnType<typeof loadDefinition>> & { def: unknown },
  report: ReportDefinition | { widgets?: { analysisId?: string }[]; blocks?: unknown[] },
  extraFilterIds: string[] = [],
  /** R2 — an inline condition ANDed onto every analysis (a drill-down value), never from a viewer: from the report definition */
  extraCondition: Record<string, unknown> | null = null,
) {
  const ids = new Set<string>(reportAnalysisIds(report as ReportDefinition));
  if (!ids.size) return {};
  const reportFilter = (report as ReportDefinition).filterId;
  const applied = [...new Set([...(reportFilter ? [reportFilter] : []), ...extraFilterIds])].filter(isUuid);
  const { data } = await db.from("analytics_analyses").select("id, name, definition").in("id", [...ids]).eq("survey_id", surveyId).is("deleted_at", null);
  const results: Record<string, AnalysisResult> = {};
  for (const a of data ?? []) {
    const own = a.definition as AnalysisDefinition;
    const def = {
      ...own,
      id: a.id,
      name: a.name as string,
      ...(applied.length ? { filterIds: [...new Set([...(own.filterIds ?? []), ...applied])] } : {}),
      ...(extraCondition ? { filter: (own.filter ? { type: "group", op: "and", children: [own.filter, extraCondition] } : extraCondition) as AnalysisDefinition["filter"] } : {}),
    };
    /*
     * One analysis that cannot be computed must not take the whole report with
     * it: every other block still has its numbers. The failed one carries a
     * structured error the viewer turns into "could not be computed", and the
     * raw cause goes to the server log, not to the screen.
     */
    try { results[a.id] = await compute(db, surveyId, loaded as never, def); }
    catch (e) { console.error(`[analytics] report analysis ${a.id} failed:`, e); results[a.id] = { ...failedResult(a.name as string, own.kind), recommendations: [] } as never; }
  }
  return results;
}
