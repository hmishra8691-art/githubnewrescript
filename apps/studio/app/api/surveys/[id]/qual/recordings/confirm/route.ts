import { NextRequest } from "next/server";
import { confirmUpload, MediaError, stageLogger } from "@rescript/media";
import { isFailure, requireProject } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { qualGuardCapability } from "@/lib/qual/qualAccess";
import { json, loadWorkspace, recordEvents, refuse, UUID } from "@/lib/qual/qualStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A SESSION RECORDING LANDED (2026-10-18) — verified in the store (not taken
 * on the browser's word), then attached to its session. Data edit. The answer
 * carries no URL: playback is a separate, access-checked, 15-minute signed URL.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, qualGuardCapability("manage"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "manage");
  if (refused) return refused;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const mediaId = String(body?.mediaId ?? "").trim();
  const sessionId = String(body?.sessionId ?? "");
  if (!mediaId || !UUID.test(sessionId)) return json({ error: "mediaId and sessionId required" }, 400);
  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;
  try {
    const { data: owned } = await handle.db.from("media_objects").select("id, survey_id, kind, session_id").eq("id", mediaId).maybeSingle();
    if (!owned || owned.survey_id !== params.id || owned.kind !== "qual_recording" || owned.session_id !== sessionId) return json({ error: "no such recording" }, 404);
    const parts = Array.isArray(body?.parts) ? (body!.parts as { partNumber?: unknown; etag?: unknown }[]).map((p) => ({ partNumber: Number(p?.partNumber), etag: String(p?.etag ?? "").replace(/"/g, "") })).filter((p) => Number.isInteger(p.partNumber) && p.partNumber > 0 && !!p.etag) : [];
    const stored = await confirmUpload(handle.db, mediaId, { bytes: Number(body?.bytes) || null, durationSeconds: Number(body?.durationSeconds) || null }, parts);
    stageLogger(`survey:${params.id}`)("storage_confirmed", { mediaId, kind: "qual_recording", bytes: stored.bytes });
    const db = supabaseService();
    await db.from("qual_sessions").update({ recording_media_id: mediaId, updated_by: gate.user.userId }).eq("survey_id", params.id).eq("id", sessionId);
    await recordEvents(db, gate, [{ actor: gate.user.userId, action: "recording.uploaded", detail: `Uploaded a recording (${Math.max(1, Math.round((stored.bytes ?? 0) / 1024 / 1024))} MB${stored.fileName ? `, ${stored.fileName}` : ""}) to a session`, ids: [sessionId, mediaId] }]);
    return json({ ok: true, mediaId, bytes: stored.bytes, workspace: await loadWorkspace(db, gate) });
  } catch (e) {
    if (e instanceof MediaError) return json({ error: e.message }, e.status);
    return json({ error: (e as Error).message }, 500);
  }
}
