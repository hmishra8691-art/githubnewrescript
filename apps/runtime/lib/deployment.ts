import "server-only";
import { supabaseAdmin } from "./admin";
import { SurveyDefinition } from "@rescript/schema";
import { decideTestBuild, versionIdToFetch, type TestBuild } from "@rescript/engine";
import { ensureElementIds } from "@rescript/engine";
import { getCachedVersionDefinition } from "@rescript/quality/server";

export interface LoadedDeployment {
  deploymentId: string;
  surveyId: string;
  versionId: string;
  mode: "test" | "live";
  definition: SurveyDefinition;
  /** the project's lifecycle status, so the page can refuse politely */
  surveyStatus: string;
}

/**
 * Statuses that stop a LIVE link accepting respondents. Paused is reversible
 * — the study is on hold, not finished — so it gets its own message. Test
 * links keep working throughout, which is the point of having them.
 */
export const BLOCKING_STATUSES: Record<string, { title: string; body: string }> = {
  paused: {
    title: "This survey is paused",
    body: "It is temporarily not accepting responses. Please try again later.",
  },
  closed: {
    title: "This survey is closed",
    body: "Thank you for your interest — data collection has finished.",
  },
  archived: {
    title: "This survey is no longer available",
    body: "This study has been archived.",
  },
};

export async function loadDeployment(
  clientSlug: string,
  studySlug: string,
  mode: "test" | "live",
): Promise<LoadedDeployment | null> {
  const db = supabaseAdmin();
  const { data: dep } = await db
    .from("deployments")
    .select("id, survey_id, version_id, mode, active")
    .eq("client_slug", clientSlug)
    .eq("study_slug", studySlug)
    .eq("mode", mode)
    .eq("active", true)
    .maybeSingle();
  if (!dep) return null;

  /*
   * A published version is FROZEN by a database trigger (0012) — deliberately,
   * because a deployed link is pinned to that snapshot — so its definition
   * (element ids backfilled per §31–49, see `getCachedVersionDefinition`) is
   * safe to serve from memory once this process has read it once. This used
   * to be a fresh Postgres read plus a full Zod parse on EVERY call, and
   * `loadDeployment` runs at least twice per respondent — once rendering the
   * page, once again inside `/api/session/start` — for a live session that
   * never changes between those two calls.
   */
  const definition = await getCachedVersionDefinition(db, dep.version_id);
  if (!definition) return null;

  const { data: survey } = await db
    .from("surveys")
    .select("status")
    .eq("id", dep.survey_id)
    .maybeSingle();

  return {
    deploymentId: dep.id,
    surveyId: dep.survey_id,
    versionId: dep.version_id,
    mode: dep.mode,
    definition,
    surveyStatus: (survey?.status as string) ?? "live",
  };
}


/** What a test link is running — shown in the toolbar so the tester can see it. */
export interface TestBuildInfo {
  source: "requested" | "draft" | "current";
  version: string;
  versionId: string;
  revision: number | null;
  draftUpdatedAt?: string | null;
}

export type LoadedTestBuild =
  | { kind: "ok"; dep: LoadedDeployment; build: TestBuildInfo }
  | { kind: "error"; message: string; detail: string }
  | { kind: "none" };

/**
 * Resolve a TEST link to the latest successfully saved state.
 *
 * The slug still identifies the survey through its deployment row, but the
 * deployment's pinned `version_id` is NOT what runs: see `decideTestBuild` in
 * the engine for the rule and why. Every branch that cannot deliver the latest
 * state returns an error to show — never an older build.
 */
export async function loadTestBuild(
  clientSlug: string,
  studySlug: string,
  requestedVersionId: string | null,
): Promise<LoadedTestBuild> {
  const db = supabaseAdmin();
  const { data: dep } = await db
    .from("deployments")
    .select("id, survey_id, version_id, mode, active")
    .eq("client_slug", clientSlug)
    .eq("study_slug", studySlug)
    .eq("mode", "test")
    .eq("active", true)
    .maybeSingle();
  if (!dep) return { kind: "none" };

  const { data: survey, error: surveyErr } = await db
    .from("surveys")
    .select("id, status, current_version_id, draft_definition, draft_updated_at, revision")
    .eq("id", dep.survey_id)
    .maybeSingle();
  if (surveyErr || !survey) {
    return { kind: "error", message: "Unable to load the latest saved survey version. Please retry.", detail: surveyErr?.message ?? "survey row not found" };
  }

  const draft = survey.draft_definition
    ? (() => {
        const parsed = SurveyDefinition.safeParse(survey.draft_definition);
        return parsed.success
          ? { ok: true as const, definition: ensureElementIds(parsed.data).def, updatedAt: (survey.draft_updated_at as string | null) ?? null }
          : { ok: false as const, error: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
      })()
    : null;

  const wanted = versionIdToFetch({ requestedVersionId, currentVersionId: survey.current_version_id, draft });
  let version: Parameters<typeof decideTestBuild>[0]["version"] = null;
  if (wanted) {
    // small, cheap, no JSON blob — fetched every time regardless of the cache below
    const { data: ver, error } = await db
      .from("survey_versions")
      .select("id, survey_id, version")
      .eq("id", wanted)
      .maybeSingle();
    if (error || !ver) {
      version = { ok: false, error: error?.message ?? "not found" };
    } else {
      const definition = await getCachedVersionDefinition(db, wanted);
      if (definition) {
        version = { ok: true, id: ver.id, surveyId: ver.survey_id, version: ver.version, definition };
      } else {
        // cache miss AND schema failure — vanishingly rare for an already-published
        // version, but worth one more read to give the author the precise Zod error
        // rather than a bare "not found"
        const { data: raw } = await db.from("survey_versions").select("definition").eq("id", wanted).maybeSingle();
        const parsed = raw ? SurveyDefinition.safeParse(raw.definition) : null;
        version = {
          ok: false,
          error: parsed && !parsed.success
            ? `stored definition does not match the schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
            : "not found",
        };
      }
    }
  }

  const decision: TestBuild = decideTestBuild({
    surveyId: dep.survey_id,
    requestedVersionId,
    currentVersionId: survey.current_version_id,
    revision: typeof survey.revision === "number" ? survey.revision : null,
    draft,
    version,
  });

  // §17 — structured trace of what a test link resolved to
  console.info("[rescript:test-build]", JSON.stringify({
    surveyId: dep.survey_id, slug: `${clientSlug}/${studySlug}`,
    requestedVersionId, currentVersionId: survey.current_version_id, revision: survey.revision,
    hasDraft: !!survey.draft_definition, pinnedDeploymentVersionId: dep.version_id,
    result: decision.kind === "ok" ? { source: decision.source, version: decision.version, versionId: decision.versionId } : decision.detail,
  }));

  if (decision.kind === "error") return decision;
  return {
    kind: "ok",
    dep: {
      deploymentId: dep.id,
      surveyId: dep.survey_id,
      versionId: decision.versionId,
      mode: "test",
      definition: decision.definition as SurveyDefinition,
      surveyStatus: (survey.status as string) ?? "live",
    },
    build: {
      source: decision.source, version: decision.version, versionId: decision.versionId,
      revision: decision.revision, draftUpdatedAt: decision.draftUpdatedAt ?? null,
    },
  };
}
