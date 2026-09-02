import { loadDeployment } from "@/lib/deployment";
import { createSession, loadQuotaCounts } from "@/lib/session";
import { Runner } from "@/components/Runner";

export const dynamic = "force-dynamic";

/** Test runtime (requirement §24): full respondent experience + inspector. */
export default async function TestSurveyPage({
  params,
  searchParams,
}: {
  params: { client: string; study: string };
  searchParams: Record<string, string>;
}) {
  /**
   * A test URL serves the TEST deployment, full stop.
   *
   * This used to fall back to the live deployment when no test row existed,
   * which meant a test link could quietly hand you an older, already-published
   * version — the exact "preview shows old configuration" complaint, with
   * nothing on screen to reveal it.
   */
  const dep = await loadDeployment(params.client, params.study, "test");
  if (!dep) {
    return (
      <div className="rs-shell"><div className="rs-card rs-end">
        <h2>No test build for this link</h2>
        <p>
          Nothing has been deployed to <code>/t/{params.client}/{params.study}</code> yet.
          Open the survey in the Studio and click <strong>Test Survey</strong> — it saves a
          version and deploys it here.
        </p>
      </div></div>
    );
  }

  /**
   * Test mode is for the programmer, so it must work for every access mode.
   * Unique-link and invitation surveys demand a respondent token; without one
   * the session refused to start and the tester saw a dead end that looked
   * like a bug. In test, a throwaway token is minted instead.
   */
  const session = await createSession(dep, {
    isTest: true,
    respondentToken: searchParams.token,
    allowTokenless: true,
  });
  if ("error" in session) {
    return <div className="rs-shell"><div className="rs-card rs-end"><h2>{session.error}</h2></div></div>;
  }
  const quotaCounts = await loadQuotaCounts(dep.surveyId, true);
  return (
    <Runner
      definition={dep.definition}
      mode="test"
      session={{
        sessionId: session.sessionId,
        seed: searchParams.seed ? Number(searchParams.seed) : session.seed,
        surveyDbId: dep.surveyId,
        versionDbId: dep.versionId,
      }}
      quotaCounts={quotaCounts}
      urlParams={searchParams}
    />
  );
}
