import { loadTestBuild } from "@/lib/deployment";
import { loadQuotaCounts } from "@/lib/session";
import { Runner } from "@/components/Runner";

export const dynamic = "force-dynamic";

/**
 * Test runtime (requirement §24): full respondent experience + inspector.
 *
 * A test URL runs the LATEST SUCCESSFULLY SAVED state of the survey — the
 * version the Studio just saved when it carries `?v=<versionId>`, otherwise the
 * autosaved draft, otherwise the current version. It used to serve whatever
 * the test deployment row pointed at, which moved only when "Test Survey" was
 * clicked; saving a version did not move it, so bookmarks, old tabs and the
 * Versions panel handed testers an older build with nothing to show for it.
 *
 * When the latest state cannot be loaded this page says so. It never falls
 * back to an older version: a tester who believes they are looking at their
 * latest work while testing something older is the most expensive failure a
 * test link can produce.
 */
export default async function TestSurveyPage({
  params,
  searchParams,
}: {
  params: { client: string; study: string };
  searchParams: Record<string, string>;
}) {
  const requested = typeof searchParams.v === "string" && searchParams.v ? searchParams.v : null;
  const res = await loadTestBuild(params.client, params.study, requested);

  if (res.kind === "none") {
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

  if (res.kind === "error") {
    return (
      <div className="rs-shell"><div className="rs-card rs-end" data-testid="test-build-error">
        <h2>{res.message}</h2>
        <p style={{ color: "var(--rs-subtle)" }}>{res.detail}</p>
        <p style={{ color: "var(--rs-subtle)", fontSize: ".9em" }}>
          Nothing older was shown in its place. Go back to the Studio, make sure the header reads
          “Saved”, and click <strong>Test Survey</strong> again.
        </p>
      </div></div>
    );
  }

  const { dep, build } = res;

  // the row is minted (or resumed) by the runner via /api/session/start —
  // see the live page for why; test mode mints a throwaway respondent for
  // unique-link and invitation surveys so every access mode can be tested
  const quotaCounts = await loadQuotaCounts(dep.surveyId, true);
  return (
    <Runner
      definition={dep.definition}
      mode="test"
      sessionBoot={{
        client: params.client,
        study: params.study,
        mode: "test",
        token: searchParams.token,
        requestedVersionId: requested,
        seed: searchParams.seed ? Number(searchParams.seed) : undefined,
        surveyDbId: dep.surveyId,
        versionDbId: dep.versionId,
      }}
      build={build}
      quotaCounts={quotaCounts}
      urlParams={searchParams}
    />
  );
}
