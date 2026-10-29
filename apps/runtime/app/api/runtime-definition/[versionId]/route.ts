import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { getCachedVersionDefinition } from "@rescript/quality/server";
import { definitionAccess, isVersionId, DENY_CACHE_CONTROL, type DeploymentRow } from "@/lib/definitionAccess";
import { respondentDefinition } from "@/lib/assessmentPayload";

/**
 * THE CACHEABLE HALF OF THE RESPONDENT RUNTIME (P0-1: Fast Origin Transfer).
 *
 * A published version's definition is frozen the moment it is cut (the
 * database trigger from migration 0012) and can never change under its own
 * id — a content change always produces a NEW version, and therefore a new
 * `versionId`. That makes it exactly the kind of content Vercel's CDN should
 * serve without ever coming back to this function: `max-age=31536000,
 * immutable` is safe forever, because there is no invalidation problem to
 * solve. There is nothing here a respondent could not already see — the
 * survey page already sends this same version id to the browser
 * (`sessionBoot.versionDbId`) and, until this route existed, embedded this
 * exact JSON inline in its own always-dynamic response.
 *
 * Before this route, `apps/runtime/app/s/[client]/[study]/page.tsx` embedded
 * the full definition in a `force-dynamic` server component, so every single
 * respondent hit re-transferred the whole survey JSON from Vercel's compute
 * straight through to the edge with no caching anywhere — the dominant
 * driver of Fast Origin Transfer for this platform, since respondent volume
 * dwarfs admin volume. Moving the definition to its own cacheable-by-id GET
 * lets the CDN answer every hit after the first one per version, for free.
 *
 * Deliberately NOT used for a TEST link's build (`loadTestBuild`): a draft
 * changes on every autosave, so caching it by id would serve stale content
 * the moment the programmer typed another character. Only the immutable,
 * published VERSION path is served this way.
 */
/*
 * RUNTIME-11 (audit 2026-10-16): "immutable forever" was true of the CONTENT
 * but not of whether it may be served. A version is now served only while an
 * active LIVE deployment pins it and its survey is not paused/closed/archived
 * (the same conditions the live page checks), with a bounded edge cache — see
 * lib/definitionAccess.ts. Everything else is a private, uncached 404.
 */
export async function GET(_req: NextRequest, { params }: { params: { versionId: string } }) {
  const notFound = (cacheControl: string) =>
    NextResponse.json({ error: "not found" }, { status: 404, headers: { "cache-control": cacheControl } });
  if (!isVersionId(params.versionId)) return notFound(DENY_CACHE_CONTROL);

  const db = supabaseAdmin();
  const { data: deps, error: depErr } = await db
    .from("deployments")
    .select("version_id, mode, active, survey_id")
    .eq("version_id", params.versionId)
    .eq("active", true);
  if (depErr) return notFound(DENY_CACHE_CONTROL);
  const surveyId = (deps ?? [])[0]?.survey_id as string | undefined;
  const { data: survey } = surveyId
    ? await db.from("surveys").select("status").eq("id", surveyId).maybeSingle()
    : { data: null };
  const access = definitionAccess({
    versionId: params.versionId,
    deployments: (deps ?? []) as DeploymentRow[],
    surveyStatus: (survey?.status as string | undefined) ?? null,
  });
  if (!access.serve) return notFound(access.cacheControl);

  const definition = await getCachedVersionDefinition(db, params.versionId);
  if (!definition) {
    // Not "unknown forever" — a version id that doesn't resolve today could
    // in principle be a migration/ordering hiccup, so this specific miss is
    // NOT cached, only successful, immutable hits are.
    return NextResponse.json({ error: "not found" }, { status: 404, headers: { "cache-control": "no-store" } });
  }

  // ASSESSMENTS (step 4A, 2026-10-29): the answer key, explanations and mistake notes never leave the server before submission
  return NextResponse.json(respondentDefinition(definition), {
    headers: { "cache-control": access.cacheControl },
  });
}
