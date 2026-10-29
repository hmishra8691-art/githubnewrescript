import { respondentAssessmentReport, scoreAssessment } from "@rescript/engine";
import { AttemptReport } from "@/components/AssessmentResults";
import { Runner } from "@/components/Runner";
import { respondentDefinition } from "@/lib/assessmentPayload";
import { attemptOf, paperByToken, sandboxAvailable } from "@/lib/assessmentSandbox";

export const dynamic = "force-dynamic";

/**
 * THE SANDBOX'S "TAKE THE TEST" PAGE (K4 2026-10-25, ported 2026-10-29 — docs/ASSESSMENTS-2026-10-29.md) — a runtime
 * with no database. Preview / test of a paper end to end: stripped paper → submit → server score → results.
 *
 * The page carries the STRIPPED definition only (`respondentDefinition`): no correct option, explanation or
 * mistake note is in the HTML or any payload before submission. Submitting posts the answers to
 * /api/assessment/sandbox, which scores them against the full definition kept in this server's memory and
 * returns the report. `?attempt=<id>` (set after submit) shows that attempt's report again, RE-SCORED from the
 * stored answers — `data-reproduced="1"` when the re-score equals the stored result.
 */
export default function TakeTestPage({ params, searchParams }: { params: { token: string }; searchParams: Record<string, string> }) {
  const paper = sandboxAvailable() ? paperByToken(params.token) : null;
  if (!paper) {
    return (
      <div className="rs-shell"><div className="rs-card rs-end" data-testid="assessment-unknown">
        <h2>Test not found</h2><p>This test link is not active (the sandbox forgets its tests when the server restarts). Open it again from the Studio.</p>
      </div></div>
    );
  }
  const attemptId = searchParams.attempt;
  if (attemptId) {
    const a = attemptOf(paper, attemptId);
    if (a) {
      const again = scoreAssessment(paper.def, a.answers);
      const report = respondentAssessmentReport(paper.def, again);
      const reproduced = JSON.stringify(again) === JSON.stringify(a.result);
      return (
        <div className="rs-shell"><div className="rs-card rs-end" data-testid="assessment-attempt" data-reproduced={reproduced ? "1" : "0"} data-score={String(again.marks)}>
          <h2>Thank you — your answers were submitted.</h2>
          {report ? <AttemptReport report={report} /> : <p>Your results will be shared by the organiser.</p>}
        </div></div>
      );
    }
  }
  return (
    <Runner
      definition={respondentDefinition(paper.def)}
      mode="test"
      assessmentSubmit={{ url: "/api/assessment/sandbox", token: paper.token }}
      urlParams={searchParams}
    />
  );
}
