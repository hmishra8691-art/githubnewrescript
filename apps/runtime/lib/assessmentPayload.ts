import type { SurveyDefinition } from "@rescript/schema";
import { isAssessment, respondentAssessmentReport, scoreAssessment, stripAssessmentForRespondent, type AssessmentResult, type RespondentAssessmentReport } from "@rescript/engine";

/**
 * ASSESSMENTS ON THE RUNTIME (K4 2026-10-25, ported 2026-10-29 — docs/ASSESSMENTS-2026-10-29.md).
 *
 * `respondentDefinition` is applied to EVERY definition this app hands a
 * respondent's browser: the live definition route, the test link's inline
 * build, the sandbox take page and the preview "as a respondent". The answer
 * key stays in the stored survey / version; the save route scores against
 * that server-side definition (`scoreForSubmission`) and stores the result in
 * `assessment_results` (migration 0076), one row per session.
 */
export function respondentDefinition<T>(def: T): T {
  const d = def as unknown as SurveyDefinition;
  if (!d || !Array.isArray(d.questions)) return def;
  return stripAssessmentForRespondent(d) as unknown as T;
}

export interface SubmissionScore {
  result: AssessmentResult;
  /** what the respondent may see (null: the paper shows no results) */
  report: RespondentAssessmentReport | null;
}

/** Score a completed submission against the SERVER's definition; null when the survey is not an assessment. */
export function scoreForSubmission(def: SurveyDefinition | null | undefined, answers: Record<string, unknown> | null | undefined): SubmissionScore | null {
  if (!def || !isAssessment(def)) return null;
  const result = scoreAssessment(def, answers ?? {});
  return { result, report: respondentAssessmentReport(def, result) };
}

/** The `assessment_results` row (0076) for one scored session — written by the save route, upserted on session_id. */
export function assessmentResultRow(
  row: { id: string; survey_id: string; version_id?: string | null; is_test?: boolean | null },
  sessionId: string,
  result: AssessmentResult,
) {
  return {
    session_id: sessionId,
    response_id: row.id,
    survey_id: row.survey_id,
    version_id: row.version_id ?? null,
    is_test: !!row.is_test,
    result,
    key_fingerprint: result.keyFingerprint,
    score: result.marks,
    max_score: result.maxMarks,
    percentage: result.percentage,
    passed: result.passed,
  };
}

/**
 * The result a session may be shown again: the stored one when it was scored
 * against the key the server holds now (same fingerprint), else a fresh,
 * deterministic re-score of the stored answers. Never anything before the
 * session is complete — the route checks that first.
 */
export function resultForSession(def: SurveyDefinition | null | undefined, answers: Record<string, unknown> | null | undefined, stored: unknown): { result: AssessmentResult; report: RespondentAssessmentReport | null; source: "stored" | "rescored" } | null {
  const scored = scoreForSubmission(def, answers);
  if (!scored || !def) return null;
  const s = stored as AssessmentResult | null | undefined;
  if (s && typeof s === "object" && s.v === 1 && s.keyFingerprint === scored.result.keyFingerprint) {
    return { result: s, report: respondentAssessmentReport(def, s), source: "stored" };
  }
  return { ...scored, source: "rescored" };
}
