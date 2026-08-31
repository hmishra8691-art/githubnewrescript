import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

/** Deploy a specific version to /s/<client>/<study> (live) or /t/... (test). */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => null);
  const { versionId, clientSlug, studySlug, mode } = body ?? {};
  if (!versionId || !clientSlug || !studySlug || !["test", "live"].includes(mode))
    return NextResponse.json({ error: "versionId, clientSlug, studySlug, mode required" }, { status: 400 });

  const slugRe = /^[a-z0-9][a-z0-9-]{0,60}$/;
  if (!slugRe.test(clientSlug) || !slugRe.test(studySlug))
    return NextResponse.json({ error: "slugs must be lowercase letters/digits/hyphens" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: ver } = await db
    .from("survey_versions")
    .select("id")
    .eq("survey_id", params.id)
    .eq("id", versionId)
    .single();
  if (!ver) return NextResponse.json({ error: "version not found" }, { status: 404 });

  const { data: existing } = await db
    .from("deployments")
    .select("id, survey_id")
    .eq("client_slug", clientSlug)
    .eq("study_slug", studySlug)
    .eq("mode", mode)
    .maybeSingle();
  if (existing && existing.survey_id !== params.id)
    return NextResponse.json({ error: "that client/study URL is used by another survey" }, { status: 409 });

  const { error } = existing
    ? await db.from("deployments").update({ version_id: versionId, active: true }).eq("id", existing.id)
    : await db.from("deployments").insert({
        survey_id: params.id, version_id: versionId,
        client_slug: clientSlug, study_slug: studySlug, mode, active: true,
      });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await db.from("audit_logs").insert({
    action: "survey.deploy", entity: "deployment", entity_id: `${clientSlug}/${studySlug}`,
    detail: { survey_id: params.id, version_id: versionId, mode },
  });

  const base = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:3001";
  const url = `${base}/${mode === "test" ? "t" : "s"}/${clientSlug}/${studySlug}`;
  return NextResponse.json({ ok: true, url });
}
