import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireEditRight, requireProject } from "@/lib/guard";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { assetFor, removeMedia, updateAsset, MediaError } from "@rescript/media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * ONE LIBRARY ASSET.
 *
 *   GET     the asset and where it is used — every survey of the customer
 *           whose draft or published version carries its URL. The Studio
 *           shows this before a delete and beside the asset in the library.
 *   PATCH   rename, describe (alt text), share / unshare. Only the survey
 *           that uploaded the asset may; a shared asset seen from another
 *           survey is read-only there.
 *   DELETE  a verified delete (`removeMedia`: object gone, then row gone,
 *           audit written). Refused with 409 and the usage list when the
 *           asset is referenced anywhere, unless `?force=1` — the researcher
 *           has read the list and means it. Deleting the reference is the
 *           Studio's job (it rewrites the definition before calling force).
 */

interface Usage { surveyId: string; code: string; title: string; inDraft: boolean; inLive: boolean }

async function usageOf(db: { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> }, mediaId: string): Promise<Usage[]> {
  const { data, error } = await db.rpc("rescript_media_usage", { p_media: mediaId });
  if (error) {
    // an installation that has not applied 0040 yet: no usage information, said as such rather than as "unused"
    if (/rescript_media_usage|does not exist/i.test(error.message)) throw new MediaError("Usage lookup needs migration 0040_media_assets.sql.", 503);
    throw new MediaError(error.message);
  }
  return ((data as Array<Record<string, unknown>> | null) ?? []).map((r) => ({
    surveyId: String(r.survey_id), code: String(r.code ?? ""), title: String(r.title ?? ""),
    inDraft: !!r.in_draft, inLive: !!r.in_live,
  }));
}

export async function GET(req: NextRequest, { params }: { params: { id: string; mediaId: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;
  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;
  try {
    const asset = await assetFor(handle.db, params.mediaId, { surveyId: params.id, customerId: gate.survey.customer_id ?? gate.user.customerId ?? null });
    if (!asset) return NextResponse.json({ error: "no such asset" }, { status: 404 });
    const usage = await usageOf(handle.db, params.mediaId);
    return NextResponse.json({ ok: true, asset, usage }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof MediaError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string; mediaId: string } }) {
  const gate = await requireEditRight(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "expected a JSON body" }, { status: 400 }); }
  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;
  try {
    const patch: { displayName?: string | null; altText?: string | null; shared?: boolean } = {};
    if ("displayName" in body) patch.displayName = body.displayName == null ? null : String(body.displayName).trim();
    if ("altText" in body) patch.altText = body.altText == null ? null : String(body.altText).trim();
    if ("shared" in body) patch.shared = !!body.shared;
    const asset = await updateAsset(handle.db, params.mediaId, params.id, patch);
    if (!asset) return NextResponse.json({ error: "no such asset in this survey — a shared asset is edited from the survey that uploaded it" }, { status: 404 });
    return NextResponse.json({ ok: true, asset });
  } catch (e) {
    if (e instanceof MediaError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string; mediaId: string } }) {
  const gate = await requireEditRight(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;
  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;
  const db = handle.db;
  try {
    const { data: row } = await db.from("media_objects")
      .select("id, bucket, path, storage_provider, kind, bytes, customer_id, survey_id")
      .eq("id", params.mediaId).eq("kind", "survey_asset").maybeSingle();
    if (!row || row.survey_id !== params.id) return NextResponse.json({ error: "no such asset in this survey" }, { status: 404 });

    const usage = await usageOf(db, params.mediaId);
    const force = req.nextUrl.searchParams.get("force") === "1";
    if (usage.length && !force) {
      return NextResponse.json({
        error: `This asset is used in ${usage.length === 1 ? "a survey" : `${usage.length} surveys`}. Remove it there first, or delete anyway and those places will show a missing image.`,
        usage,
      }, { status: 409 });
    }
    const report = await removeMedia(db, [row], force && usage.length ? "asset deleted while in use" : "asset deleted");
    return NextResponse.json({ ok: true, ...report, usage });
  } catch (e) {
    if (e instanceof MediaError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
