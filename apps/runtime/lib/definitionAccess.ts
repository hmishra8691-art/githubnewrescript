/**
 * WHO MAY FETCH A VERSION'S DEFINITION (RUNTIME-11, audit 2026-10-16).
 *
 * `/api/runtime-definition/[versionId]` used to serve any version by UUID with
 * a one-year `immutable` cache. A closed survey's definition — attention-check
 * answers, scripts, redirect URLs — stayed fetchable by anyone who had ever
 * seen the id, and stayed in the CDN for a year after the survey closed.
 *
 * The only caller is the LIVE page (`RunnerLive`), which always asks for the
 * version its ACTIVE live deployment points at. Test links and the Studio
 * preview never use this route (a test link embeds its build inline; preview
 * receives the definition by postMessage), so the rule is exactly:
 *
 *   serve  ⇔  an active LIVE deployment pins this version
 *             AND the project is not paused / closed / archived
 *
 * — the same two conditions the live page itself checks before it renders
 * the runner. Anything else is a 404 marked `private, no-store`.
 *
 * The cache is bounded for the same reason: a version stays immutable, but
 * whether it may be SERVED changes when a deployment moves or the survey
 * closes. Ten minutes at the edge keeps nearly all of the CDN saving (one
 * origin hit per version per ten minutes instead of one per respondent) and
 * means a closed survey stops being served within ten minutes.
 *
 * Pure, so it can be tested without a database (definitionAccess.test.ts).
 */

export interface DeploymentRow {
  version_id: string;
  mode: string;
  active: boolean | null;
}

export interface DefinitionAccessInput {
  versionId: string;
  /** deployments that point at `versionId` (any mode, any active state) */
  deployments: DeploymentRow[];
  /** the owning survey's lifecycle status, or null when unknown */
  surveyStatus: string | null;
}

export type DefinitionAccess =
  | { serve: true; cacheControl: string }
  | { serve: false; reason: "bad_id" | "no_active_deployment" | "survey_blocked"; cacheControl: string };

/** Statuses that stop a live link — kept in step with `BLOCKING_STATUSES` (lib/deployment.ts). */
export const DEFINITION_BLOCKING_STATUSES: readonly string[] = ["paused", "closed", "archived"];

export const SERVE_CACHE_CONTROL = "public, max-age=60, s-maxage=600";
export const DENY_CACHE_CONTROL = "private, no-store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isVersionId(v: string): boolean {
  return UUID.test(v);
}

export function definitionAccess(input: DefinitionAccessInput): DefinitionAccess {
  if (!isVersionId(input.versionId)) return { serve: false, reason: "bad_id", cacheControl: DENY_CACHE_CONTROL };
  const live = input.deployments.some((d) =>
    d.version_id.toLowerCase() === input.versionId.toLowerCase() && d.mode === "live" && d.active === true);
  if (!live) return { serve: false, reason: "no_active_deployment", cacheControl: DENY_CACHE_CONTROL };
  if (input.surveyStatus && DEFINITION_BLOCKING_STATUSES.includes(input.surveyStatus)) {
    return { serve: false, reason: "survey_blocked", cacheControl: DENY_CACHE_CONTROL };
  }
  return { serve: true, cacheControl: SERVE_CACHE_CONTROL };
}
