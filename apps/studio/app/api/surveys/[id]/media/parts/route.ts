import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireEditRight } from "@/lib/guard";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { resumeUpload, MediaError } from "@rescript/media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * RESUME: WHICH PARTS DOES THE STORE HAVE?
 *
 * After an interruption the browser asks this rather than consulting its own
 * memory of what it sent — a part that returned 200 and then was not there
 * is exactly the case a client-side ledger gets wrong. The answer is the
 * store's list of parts and fresh signed URLs for the rest; `complete: true`
 * means nothing is missing and the browser should confirm.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireEditRight(req, params.id, "survey.edit");
  if (isFailure(gate)) return gate.response;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "expected a JSON body" }, { status: 400 }); }
  const mediaId = String(body.mediaId ?? "").trim();
  if (!mediaId) return NextResponse.json({ error: "mediaId required" }, { status: 400 });

  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;

  try {
    const { data: owned } = await handle.db.from("media_objects").select("id, survey_id").eq("id", mediaId).maybeSingle();
    if (!owned || owned.survey_id !== params.id) return NextResponse.json({ error: "no such recording" }, { status: 404 });
    const t = await resumeUpload(handle.db, mediaId, Number(body.bytes) || null);
    return NextResponse.json({
      ok: true, kind: t.kind, complete: t.alreadyStored || (t.kind === "multipart" && t.parts.length === 0),
      uploadUrl: t.uploadUrl, uploadId: t.uploadId, partBytes: t.partBytes, partCount: t.partCount,
      uploaded: t.uploaded, parts: t.parts,
    });
  } catch (e) {
    if (e instanceof MediaError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
