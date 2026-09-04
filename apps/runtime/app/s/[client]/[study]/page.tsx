import { loadDeployment, BLOCKING_STATUSES } from "@/lib/deployment";
import { createSession, loadQuotaCounts } from "@/lib/session";
import { Runner } from "@/components/Runner";
import { headers } from "next/headers";
import { clientIp } from "@rescript/quality/server";

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

  const ua = headers().get("user-agent") ?? undefined;
  const session = await createSession(dep, {
    ip: clientIp(headers()),
    isTest: false,
    respondentToken: searchParams.token,
    userAgent: ua,
  });
  if ("error" in session) {
    return (
      <div className="rs-shell"><div className="rs-card rs-end"><h2>{session.error}</h2></div></div>
    );
  }
  const quotaCounts = await loadQuotaCounts(dep.surveyId, false);

  return (
    <Runner
      definition={dep.definition}
      mode="live"
      session={{
        sessionId: session.sessionId,
        seed: session.seed,
        surveyDbId: dep.surveyId,
        versionDbId: dep.versionId,
      }}
      quotaCounts={quotaCounts}
      urlParams={searchParams}
    />
  );
}
