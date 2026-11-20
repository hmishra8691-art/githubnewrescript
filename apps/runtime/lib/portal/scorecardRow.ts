import { benchmarkKey, cohortValues, computeScorecard, scorecardValues, type AssessmentResult, type ScorecardResult } from "@rescript/engine";
import type { SurveyDefinition } from "@rescript/schema";

/**
 * ONE COMPLETED INTERVIEW'S SCORES, AS STORED (phase 2, 2026-11-20; table portal_scorecards, migration 0104).
 * Used where an interview is completed (the final save), where a respondent changes an answer (the portal), and by
 * the Studio's "score again". null = the survey defines no scorecard, so nothing is stored.
 */
export interface ScoredInterview { key: string; scores: Record<string, number | null>; cohort: Record<string, string | null>; result: ScorecardResult }

export function scoreInterview(def: SurveyDefinition | null | undefined, state: { answers: Record<string, unknown>; calculated?: Record<string, unknown> | null; embedded?: Record<string, unknown> | null }, assessment?: AssessmentResult | null): ScoredInterview | null {
  if (!def) return null;
  const result = computeScorecard(def, { answers: state.answers ?? {}, calculated: state.calculated ?? {}, assessment: assessment ?? null });
  if (!result) return null;
  return { key: benchmarkKey(def, result.fingerprint), scores: scorecardValues(result), cohort: cohortValues(def, { answers: state.answers ?? {}, embedded: state.embedded ?? {} }), result };
}

export function scorecardRow(row: { id: string; survey_id: string; respondent_id?: string | null; is_test?: boolean | null }, s: ScoredInterview, completedAt: string | null) {
  return { response_id: row.id, survey_id: row.survey_id, respondent_id: row.respondent_id ?? null, is_test: !!row.is_test, fingerprint: s.key, scores: s.scores, cohort: s.cohort, result: s.result, completed_at: completedAt, updated_at: new Date().toISOString() };
}
