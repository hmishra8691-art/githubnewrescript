/**
 * Survey lifecycle.
 *
 * draft → testing → live, with paused / closed / archived as end states.
 * `paused` and `archived` stop the LIVE runtime serving the survey without
 * deleting anything, so a study can be halted and resumed rather than closed
 * for good; test links keep working throughout.
 *
 * Mirrors the check constraint in supabase/migrations/0002_dashboard_stats.sql.
 */
export const SURVEY_STATUSES = [
  "draft",
  "testing",
  "live",
  "paused",
  "closed",
  "archived",
] as const;

export type SurveyStatus = (typeof SURVEY_STATUSES)[number];

export function isSurveyStatus(v: unknown): v is SurveyStatus {
  return SURVEY_STATUSES.includes(v as SurveyStatus);
}
