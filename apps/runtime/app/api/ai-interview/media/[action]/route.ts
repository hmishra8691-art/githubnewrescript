import { NextRequest, NextResponse } from "next/server";
import { beginUpload, confirmUpload, resumeUpload, MediaError } from "@rescript/media";
import { aiInterviewDeps, errorResponse } from "@/lib/aiInterview/runtimeDeps";
import { interviewFor } from "@/lib/aiInterview/gate";
import { mediaDbOrResponse } from "@/lib/mediaRoute";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A CONSENTED RECORDING OF ONE ANSWER (voice: the audio; video: the camera) — the same three steps as
 * every respondent upload (`ticket` → `parts` → `confirm`, the browser's RecordingUploader), signed
 * straight to the PRIVATE uploads bucket, keyed by the interview, confirmed by the store. Refused
 * unless the participant agreed to recording. The turn names the media id; the turn route keeps it
 * only when this interview owns it.
 */
const KIND = { audio: "answer_audio", video: "answer_upload" } as const;

export async function POST(req: NextRequest, { params }: { params: { action: string } }) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const deps = aiInterviewDeps();
    if (deps.store.kind !== "supabase") return NextResponse.json({ error: "recordings need a database and storage (the sandbox keeps none)" }, { status: 403 });
    const { session, study } = await interviewFor(deps, body.sessionToken, { live: true });
    if (!session.consent.recording) return NextResponse.json({ error: "the participant did not agree to recording" }, { status: 403 });
    if (!study.customerId) return NextResponse.json({ error: "this study has no project to store against" }, { status: 409 });
    const handle = mediaDbOrResponse();
    if ("response" in handle) return handle.response;
    const db = handle.db;
    if (params.action === "ticket") {
      const kind = KIND[String(body.kind ?? "audio") as keyof typeof KIND];
      if (!kind || (kind === "answer_upload" && session.mode !== "video")) return NextResponse.json({ error: "audio, or video in a camera interview" }, { status: 400 });
      const ticket = await beginUpload(db, { kind, customerId: study.customerId, surveyId: study.surveyId, questionId: "ai_interview", sessionId: session.id, responseId: null, answerKey: null, fileName: typeof body.fileName === "string" ? body.fileName : null, mimeType: typeof body.mimeType === "string" ? body.mimeType : null, bytes: Number(body.bytes) || null, durationSeconds: Number(body.durationSeconds) || null, clientToken: typeof body.clientToken === "string" ? body.clientToken : null });
      return NextResponse.json({ ok: true, ...ticket });
    }
    const mediaId = String(body.mediaId ?? "");
    const { data: owned } = await db.from("media_objects").select("id, session_id").eq("id", mediaId).maybeSingle();
    if (!owned || owned.session_id !== session.id) return NextResponse.json({ error: "no such recording" }, { status: 404 });
    if (params.action === "parts") {
      const t = await resumeUpload(db, mediaId, Number(body.bytes) || null);
      return NextResponse.json({ ok: true, kind: t.kind, complete: t.alreadyStored || (t.kind === "multipart" && t.parts.length === 0), uploadUrl: t.uploadUrl, uploadId: t.uploadId, partBytes: t.partBytes, partCount: t.partCount, uploaded: t.uploaded, parts: t.parts });
    }
    if (params.action === "confirm") {
      const parts = (Array.isArray(body.parts) ? body.parts : []).map((p) => ({ partNumber: Number((p as { partNumber?: unknown })?.partNumber), etag: String((p as { etag?: unknown })?.etag ?? "").replace(/"/g, "") })).filter((p) => Number.isInteger(p.partNumber) && p.partNumber > 0 && !!p.etag);
      const stored = await confirmUpload(db, mediaId, { bytes: Number(body.bytes) || Number(body.bytesRecorded) || null, durationSeconds: Number(body.durationSeconds) || null }, parts);
      return NextResponse.json({ ok: true, mediaId, bytes: stored.bytes });
    }
    return NextResponse.json({ error: "ticket, parts or confirm" }, { status: 404 });
  } catch (e) {
    if (e instanceof MediaError) return NextResponse.json({ error: e.message }, { status: e.status });
    return errorResponse(e);
  }
}
