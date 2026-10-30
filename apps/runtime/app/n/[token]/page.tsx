import { Runner } from "@/components/Runner";
import { respondentDefinition } from "@/lib/assessmentPayload";
import { sandboxAvailable, sandboxSurvey, sandboxSurveyId } from "@/lib/sessionSandbox";

export const dynamic = "force-dynamic";

/**
 * A SANDBOX TEST LINK (2026-10-30) — a runtime with no database. The real Runner in test mode with a real session:
 * /api/session/start mints / resumes a row in the in-memory store (lib/sessionSandbox.ts), every page goes through
 * /api/session/save (the replay check, the navigation trail of 0077), and `?r=<session>` resumes it on another
 * device exactly as a test or live link does.
 */
export default function SandboxTestLink({ params, searchParams }: { params: { token: string }; searchParams: Record<string, string> }) {
  const survey = sandboxAvailable() ? sandboxSurvey(params.token) : null;
  if (!survey) {
    return (
      <div className="rs-shell"><div className="rs-card rs-end" data-testid="sandbox-unknown">
        <h2>Survey not found</h2><p>This sandbox link is not active (the sandbox forgets its surveys when the server restarts).</p>
      </div></div>
    );
  }
  const id = sandboxSurveyId(survey.token);
  return (
    <Runner
      definition={respondentDefinition(survey.def)}
      mode="test"
      sessionBoot={{ client: "sandbox", study: survey.token, mode: "test", surveyDbId: id, versionDbId: id }}
      urlParams={searchParams}
    />
  );
}
