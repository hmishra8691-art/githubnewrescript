import { buildTrends, minChanges, portalDefinition, scoreInterview, type DimensionTrend, type HistoryPoint, type ScorecardResult } from "@rescript/engine";
import type { SurveyDefinition } from "@rescript/schema";
import type { CompletedRow } from "./portalScoresCore.ts";

/**
 * ONE RESPONDENT'S RESULTS, FOR A MEMBER WHO MAY OPEN THEM (phase 3, 2026-11-20). Pure.
 *
 * The same engine the portal uses: each completed interview scored by the questions of its own version and the
 * settings that are live now, then put in order with the like-for-like rule. Unlike the respondent's own page
 * there is no visibility switch here — the member holds the permission to see the scores — but nothing else is
 * added either: no answers, no contact details.
 */
export const PERSON_ATTEMPTS = 24;

export interface PersonResults {
  attempts: number;
  latestAt: string | null;
  latest: ScorecardResult | null;
  trends: DimensionTrend[];
}

export function personResults(rows: CompletedRow[], live: SurveyDefinition, versions: Map<string, SurveyDefinition>): PersonResults {
  const points: HistoryPoint[] = [];
  const ordered = [...rows].filter((r) => r.completed_at).sort((a, b) => String(a.completed_at).localeCompare(String(b.completed_at))).slice(-PERSON_ATTEMPTS);
  for (const r of ordered) {
    const own = r.version_id ? versions.get(r.version_id) : undefined;
    const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
    const scored = own ? scoreInterview(portalDefinition(own, live), { answers: obj(r.answers), calculated: obj(r.calculated), embedded: obj(r.embedded) }) : null;
    if (scored) points.push({ at: r.completed_at!, wave: "", surveyId: r.survey_id, responseId: r.id, result: scored.result });
  }
  const last = points.at(-1) ?? null;
  return { attempts: ordered.length, latestAt: last?.at ?? null, latest: last?.result ?? null, trends: buildTrends(points, minChanges(live)) };
}
