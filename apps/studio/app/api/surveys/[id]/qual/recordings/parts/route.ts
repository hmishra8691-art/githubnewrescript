import { NextRequest } from "next/server";
import { MediaError, resumeUpload } from "@rescript/media";
import { isFailure, requireProject } from "@/lib/guard";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { qualGuardCapability } from "@/lib/qual/qualAccess";
import { json, refuse } from "@/lib/qual/qualStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** RESUME A SESSION RECORDING'S UPLOAD (2026-10-18): which parts the store has, and grants for the rest. Data edit. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, qualGuardCapability("manage"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "manage");
  if (refused) return refused;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const mediaId = String(body?.mediaId ?? "").trim();
  if (!mediaId) return json({ error: "mediaId required" }, 400);
  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;
  try {
    const { data: owned } = await handle.db.from("media_objects").select("id, survey_id, kind").eq("id", mediaId).maybeSingle();
    if (!owned || owned.survey_id !== params.id || owned.kind !== "qual_recording") return json({ error: "no such recording" }, 404);
    const t = await resumeUpload(handle.db, mediaId, Number(body?.bytes) || null);
    return json({ ok: true, kind: t.kind, complete: t.alreadyStored || (t.kind === "multipart" && t.parts.length === 0), uploadUrl: t.uploadUrl, uploadId: t.uploadId, partBytes: t.partBytes, partCount: t.partCount, uploaded: t.uploaded, parts: t.parts });
  } catch (e) {
    if (e instanceof MediaError) return json({ error: e.message }, e.status);
    return json({ error: (e as Error).message }, 500);
  }
}
