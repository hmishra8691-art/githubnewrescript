import { NextRequest } from "next/server";
import { beginUpload, MediaError, stageLogger } from "@rescript/media";
import { isFailure, requireProject } from "@/lib/guard";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { qualGuardCapability } from "@/lib/qual/qualAccess";
import { json, refuse, UUID } from "@/lib/qual/qualStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * PERMISSION TO STORE ONE SESSION RECORDING (2026-10-18) — the `begin` of the
 * Studio's one uploader (`RecordingUploader`): a `media_objects` row of kind
 * `qual_recording` written BEFORE the bytes move, and a signed URL (or signed
 * parts, for a large file) to PUT them straight to the private `rescript-qual`
 * bucket. The same client token resumes the same upload after a dropped
 * connection or a reload (`parts`); `confirm` verifies the object exists.
 * Audio or video only. Data edit (`responses.manage`).
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, qualGuardCapability("manage"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "manage");
  if (refused) return refused;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const sessionId = String(body?.sessionId ?? "");
  if (!UUID.test(sessionId)) return json({ error: "which session is this the recording of (sessionId)" }, 400);
  const mimeType = typeof body?.mimeType === "string" ? body.mimeType : "";
  if (!/^(audio|video)\//.test(mimeType)) return json({ error: `a session recording is an audio or video file (this is ${mimeType || "an unknown type"})` }, 415);
  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;
  const { data: session } = await handle.db.from("qual_sessions").select("id").eq("survey_id", params.id).eq("id", sessionId).maybeSingle();
  if (!session) return json({ error: "no such session" }, 404);
  try {
    const ticket = await beginUpload(handle.db, {
      kind: "qual_recording", customerId: gate.survey.customer_id ?? gate.user.customerId!, surveyId: params.id, sessionId,
      fileName: typeof body?.fileName === "string" ? body.fileName : null, mimeType, bytes: Number(body?.bytes) || null,
      durationSeconds: Number(body?.durationSeconds) || null, clientToken: typeof body?.clientToken === "string" ? body.clientToken : null, createdBy: gate.user.userId,
    });
    stageLogger(`survey:${params.id}`)("upload_url_issued", { mediaId: ticket.mediaId, kind: "qual_recording", sessionId, parts: ticket.partCount });
    return json({ ok: true, ...ticket });
  } catch (e) {
    if (e instanceof MediaError) return json({ error: e.message }, e.status);
    return json({ error: (e as Error).message }, 500);
  }
}
