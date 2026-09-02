import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

/**
 * What each deployment mode is actually serving.
 *
 * Saving a version does NOT republish — a respondent part-way through a survey
 * must not have the questionnaire change under them. That is correct, but it
 * used to be invisible: the editor gave no hint that the live link was still
 * on an older version, so "I saved but the live link is stale" looked like a
 * bug rather than a deliberate safety property. This endpoint feeds the banner
 * that makes the gap obvious and offers a one-click publish.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("deployments")
    .select("mode, version_id, client_slug, study_slug, active, survey_versions(version)")
    .eq("survey_id", params.id)
    .eq("active", true);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const deployments = (data ?? []).map((d: Record<string, unknown>) => {
    const ver = d.survey_versions as { version?: string } | { version?: string }[] | null;
    const version = Array.isArray(ver) ? ver[0]?.version : ver?.version;
    return {
      mode: d.mode as string,
      versionId: d.version_id as string,
      version: version ?? "?",
      client_slug: d.client_slug as string,
      study_slug: d.study_slug as string,
    };
  });
  return NextResponse.json({ deployments });
}
