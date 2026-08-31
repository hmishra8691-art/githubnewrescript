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
  const dep =
    (await loadDeployment(params.client, params.study, "test")) ??
    (await loadDeployment(params.client, params.study, "live"));
  if (!dep) {
    return (
      <div className="rs-shell"><div className="rs-card rs-end"><h2>Test survey not found</h2></div></div>
    );
  }
  const session = await createSession(dep, { isTest: true });
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
