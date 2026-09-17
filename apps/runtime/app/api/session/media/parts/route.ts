import { NextRequest, NextResponse } from "next/server";
import { sessionForMedia } from "@/lib/aiSession";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { resumeUpload, MediaError } from "@rescript/media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Resume for a respondent's upload — see the Studio's `media/parts` for the reasoning. */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "expected a JSON body" }, { status: 400 }); }

  const gate = await sessionForMedia(body);
  if ("response" in gate) return gate.response;
  if (!gate.row) return NextResponse.json({ error: "a preview does not store recordings" }, { status: 403 });

  const mediaId = String(body.mediaId ?? "").trim();
  if (!mediaId) return NextResponse.json({ error: "mediaId required" }, { status: 400 });

  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;

  try {
    const { data: owned } = await handle.db.from("media_objects").select("id, session_id").eq("id", mediaId).maybeSingle();
    if (!owned || owned.session_id !== gate.row.sessionId) return NextResponse.json({ error: "no such recording" }, { status: 404 });
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
