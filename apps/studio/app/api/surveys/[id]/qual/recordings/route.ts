import { NextRequest } from "next/server";
import { freshUrl, MediaError } from "@rescript/media";
import { isFailure, requireProject } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { qualGuardCapability } from "@/lib/qual/qualAccess";
import { json, recordEvents, refuse } from "@/lib/qual/qualStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * PLAY OR DOWNLOAD A SESSION RECORDING (2026-10-18) — GET ?mediaId=…[&download=1]:
 * after the access check, a signed URL good for 15 minutes; never a public
 * link. A voice or a face cannot be redacted, so this needs Data view AND
 * contact details (`responses.read_pii`). Every playback and download is
 * written to the history.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, qualGuardCapability("playback"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "playback");
  if (refused) return refused;
  const mediaId = req.nextUrl.searchParams.get("mediaId") ?? "";
  const download = req.nextUrl.searchParams.get("download") === "1";
  if (!mediaId) return json({ error: "mediaId required" }, 400);
  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;
  try {
    const { data: owned } = await handle.db.from("media_objects").select("id, survey_id, kind").eq("id", mediaId).maybeSingle();
    if (!owned || owned.survey_id !== params.id || owned.kind !== "qual_recording") return json({ error: "no such recording" }, 404);
    const { url } = await freshUrl(handle.db, mediaId, { download, seconds: 15 * 60 });
    await recordEvents(supabaseService(), gate, [{ actor: gate.user.userId, action: download ? "recording.downloaded" : "recording.played", detail: `${download ? "Downloaded" : "Played"} a session recording`, ids: [mediaId] }]);
    return json({ ok: true, url, expiresInSeconds: 15 * 60 });
  } catch (e) {
    if (e instanceof MediaError) return json({ error: e.message }, e.status);
    return json({ error: (e as Error).message }, 500);
  }
}
