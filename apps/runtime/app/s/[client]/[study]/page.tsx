import { loadDeployment, BLOCKING_STATUSES } from "@/lib/deployment";
import { loadQuotaCounts } from "@/lib/session";
import { Runner } from "@/components/Runner";

export const dynamic = "force-dynamic";

export default async function SurveyPage({
  params,
  searchParams,
}: {
  params: { client: string; study: string };
  searchParams: Record<string, string>;
}) {
  const dep = await loadDeployment(params.client, params.study, "live");
  if (!dep) {
    return (
      <div className="rs-shell"><div className="rs-card rs-end"><h2>Survey not found</h2>
        <p>This survey link is not active. Please check the URL.</p></div></div>
    );
  }

  // A paused / closed / archived project stops taking live responses without
  // anything being deleted, and without touching its test link.
  const blocked = BLOCKING_STATUSES[dep.surveyStatus];
  if (blocked) {
    return (
      <div className="rs-shell"><div className="rs-card rs-end">
        <h2>{blocked.title}</h2><p>{blocked.body}</p>
      </div></div>
    );
  }

  const access = dep.definition.deployment.access;
  if (access.mode === "password" && searchParams.pw !== access.password) {
    return (
      <div className="rs-shell"><div className="rs-card rs-end">
        <h2>Password required</h2>
        <form method="get">
          <input className="rs-input" type="password" name="pw" placeholder="Survey password" />
          <div style={{ marginTop: 12 }}><button className="rs-btn" type="submit">Enter</button></div>
        </form>
      </div></div>
    );
  }

  /*
   * The response row is minted by the runner through /api/session/start —
   * not here. Creating it during the server render wrote one row per visit
   * (refreshes, crawlers, a respondent reloading mid-survey), which is where
   * the orphan in_progress rows came from. The runner also resumes its own
   * row after a reload, so a refresh keeps the answers instead of restarting.
   */
  const quotaCounts = await loadQuotaCounts(dep.surveyId, false);

  return (
    <Runner
      definition={dep.definition}
      mode="live"
      sessionBoot={{
        client: params.client,
        study: params.study,
        mode: "live",
        token: searchParams.token,
        surveyDbId: dep.surveyId,
        versionDbId: dep.versionId,
      }}
      quotaCounts={quotaCounts}
      urlParams={searchParams}
    />
  );
}
