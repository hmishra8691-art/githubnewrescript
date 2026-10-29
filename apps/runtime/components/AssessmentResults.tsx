"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { assessmentSettings, respondentAssessmentReport, scoreAssessment, type RespondentAssessmentReport } from "@rescript/engine";
import { AssessmentReport } from "@rescript/renderer";

/**
 * THE RESULTS PAGE OF AN ASSESSMENT, IN THE RUNNER (K4 2026-10-25, ported 2026-10-29 — docs/ASSESSMENTS-2026-10-29.md).
 *
 * Where the report comes from, in order:
 *   1. the final save's answer (`/api/session/save` scores on the server and returns the report) — live and test;
 *   2. `/api/session/assessment` when that answer had none (a retried save that found the session finalised);
 *   3. the sandbox take page's own endpoint (`assessmentSubmit`, a runtime with no database);
 *   4. PREVIEW: scored in the programmer's browser against the definition the Studio sent (it is their own
 *      key), marked with a badge — "as a respondent" receives the stripped definition, the score still comes
 *      from the programmer's copy (`previewScoringDef`).
 * Nothing is shown when the survey is not an assessment, the end is not a completion, or the paper's
 * settings say results are never shown.
 */
type View = { kind: "none" } | { kind: "loading" } | { kind: "ready"; report: RespondentAssessmentReport; badge?: string } | { kind: "error"; message: string };

export interface AssessmentResultsInput {
  def: SurveyDefinition;
  mode: "live" | "test" | "preview";
  sessionId?: string | null;
  build?: unknown;
  assessmentSubmit?: { url: string; token: string };
  previewScoringDef?: SurveyDefinition;
}

export function useAssessmentResults(input: AssessmentResultsInput) {
  const [view, setView] = React.useState<View>({ kind: "none" });
  const inputRef = React.useRef(input);
  inputRef.current = input;

  const obtain = React.useCallback(async (saveResponse: unknown, status: string, answers: Record<string, unknown>) => {
    const { def, mode, sessionId, build, assessmentSubmit, previewScoringDef } = inputRef.current;
    const s = assessmentSettings(def);
    if (!s || status !== "complete" || s.showResults === "never") return;
    const fromSave = (saveResponse as { assessment?: RespondentAssessmentReport } | null | undefined)?.assessment;
    if (fromSave) { setView({ kind: "ready", report: fromSave }); return; }
    if (mode === "preview") {
      const full = previewScoringDef ?? def;
      const keyed = full.questions.some((q) => q.assessment && !q.assessment.withheld && q.assessment.correct?.length);
      if (!keyed) { setView({ kind: "error", message: "The answer key is not in this preview, so it cannot be scored here — respondents get their results from the server after they submit." }); return; }
      const report = respondentAssessmentReport(full, scoreAssessment(full, answers));
      if (report) setView({ kind: "ready", report, badge: "PREVIEW — scored in this browser with your answer key. Respondents never receive the key: their results come from the server after they submit." });
      return;
    }
    setView({ kind: "loading" });
    try {
      const r = assessmentSubmit
        ? await fetch(assessmentSubmit.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "submit", token: assessmentSubmit.token, answers }), cache: "no-store" })
        : sessionId
          ? await fetch("/api/session/assessment", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, build }), cache: "no-store" })
          : null;
      if (!r) { setView({ kind: "none" }); return; }
      const j = (await r.json().catch(() => ({}))) as { assessment?: RespondentAssessmentReport | null; attemptId?: string; error?: string };
      if (!r.ok) { setView({ kind: "error", message: j.error ?? `the results could not be loaded (${r.status})` }); return; }
      if (!j.assessment) { setView({ kind: "none" }); return; }
      setView({ kind: "ready", report: j.assessment });
      // the sandbox page remembers the attempt in its URL, so a reload shows the (re-scored) report again
      if (j.attemptId && typeof window !== "undefined") {
        const u = new URL(window.location.href);
        u.searchParams.set("attempt", j.attemptId);
        window.history.replaceState(null, "", u.toString());
      }
    } catch (e) {
      setView({ kind: "error", message: (e as Error).message || "network error" });
    }
  }, []);

  const reset = React.useCallback(() => setView({ kind: "none" }), []);

  const node = view.kind === "none" ? null
    : view.kind === "loading" ? <p className="rs-asmt-muted" data-testid="assessment-loading">Calculating your results…</p>
      : view.kind === "error" ? <p className="rs-asmt-muted" data-testid="assessment-error">{view.message}</p>
        : <AssessmentReport report={view.report} badge={view.badge} />;
  return { obtain, reset, node, view };
}

/** A finished attempt's report, for a server page (the sandbox page's `?attempt=` reload). */
export function AttemptReport({ report }: { report: RespondentAssessmentReport }) {
  return <AssessmentReport report={report} />;
}
