import type { SurveyDefinition } from "@rescript/schema";
import { assessmentAnalytics, assessmentKeyFingerprint, scoreAssessment, type AssessmentAnalytics, type AssessmentResult } from "@rescript/engine";

/**
 * THE RESEARCHER'S ASSESSMENT RESULTS (2026-10-29, step 4B; docs/ASSESSMENTS-2026-10-29.md part B) — the pure half of
 * `/api/surveys/[id]/assessment`: completed responses + the rows of `assessment_results` (0076) → one result per
 * response and the analytics the Data Analytics card draws.
 *
 * A stored result is used only when it was scored against the CURRENT key (same fingerprint); a response without
 * one (0076 not applied yet, a key changed since, a save whose upsert failed) is re-scored from its stored answers
 * with the same deterministic `scoreAssessment`, so the card never mixes two keys silently and says how many rows
 * were re-scored.
 */
export interface CompletedResponse { session_id: string; completed_at?: string | null; answers: Record<string, unknown> | null }
export interface StoredAssessmentRow { session_id: string; key_fingerprint: string | null; result: unknown }

export interface ResearcherAssessment {
  n: number;
  /** responses whose stored result was missing or scored against another key — re-scored here */
  rescored: number;
  keyFingerprint: string;
  results: AssessmentResult[];
  analytics: AssessmentAnalytics;
}

const isResult = (x: unknown): x is AssessmentResult =>
  !!x && typeof x === "object" && (x as { v?: unknown }).v === 1 && Array.isArray((x as { questions?: unknown }).questions) && typeof (x as { marks?: unknown }).marks === "number";

export function researcherAssessment(def: SurveyDefinition, responses: CompletedResponse[], stored: StoredAssessmentRow[]): ResearcherAssessment {
  const fp = assessmentKeyFingerprint(def);
  const bySession = new Map(stored.map((r) => [r.session_id, r]));
  let rescored = 0;
  const results = responses.map((r) => {
    const s = bySession.get(r.session_id);
    if (s && s.key_fingerprint === fp && isResult(s.result) && s.result.keyFingerprint === fp) return s.result;
    rescored++;
    return scoreAssessment(def, r.answers ?? {});
  });
  return { n: results.length, rescored, keyFingerprint: fp, results, analytics: assessmentAnalytics(def, results) };
}

/** A filename-safe stem for the Word download. */
export const docxName = (title: string): string => `${(title || "assessment").replace(/[^\w.-]+/g, "_").slice(0, 60) || "assessment"}-assessment.docx`;
