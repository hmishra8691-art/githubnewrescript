import { NextRequest, NextResponse } from "next/server";
import { sessionForMedia } from "@/lib/aiSession";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { recordSessionUsage } from "@/lib/metering";
import { sttConfigured } from "@/lib/ai";
import { transcribes, savesAudio } from "@rescript/engine";
import { confirmUpload, queueTranscript, MediaError, stageLogger } from "@rescript/media";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE RESPONDENT'S ANSWER LANDED.
 *
 * The order here is the contract the whole interview rests on: the clip is
 * confirmed stored BEFORE anything is said about a transcript, and the
 * transcript is a queued row rather than an awaited call. The respondent may
 * move on as soon as their recording is safe, which is what "do not allow the
 * respondent to proceed until the audio response has been successfully
 * captured" actually requires — captured, not transcribed.
 *
 * Before, the two were one request: store, then call the provider inline, and
 * the respondent waited on both. A five-minute answer took the provider
 * longer than the function was allowed to live, so the request died AFTER the
 * clip was safely uploaded and the renderer told the respondent "your
 * recording could not be saved" — which was false, and invited them to record
 * it all again.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "expected a JSON body" }, { status: 400 }); }

  const gate = await sessionForMedia(body);
  if ("response" in gate) return gate.response;
  if (!gate.row) return NextResponse.json({ error: "a preview does not store recordings" }, { status: 403 });

  const mediaId = String(body.mediaId ?? "").trim();
  const questionId = String(body.questionId ?? "").trim();
  if (!mediaId) return NextResponse.json({ error: "mediaId required" }, { status: 400 });

  const handle = mediaDbOrResponse();
  if ("response" in handle) return handle.response;
  const db = handle.db;
  const log = stageLogger(`session:${gate.row.sessionId.slice(0, 8)}`);

  try {
    const { data: owned } = await db.from("media_objects").select("id, session_id, kind").eq("id", mediaId).maybeSingle();
    if (!owned || owned.session_id !== gate.row.sessionId) return NextResponse.json({ error: "no such recording" }, { status: 404 });

    const stored = await confirmUpload(db, mediaId, {
      bytes: Number(body.bytes) || Number(body.bytesRecorded) || null,
      durationSeconds: Number(body.durationSeconds) || null,
    }, readParts(body.parts));
    log("storage_confirmed", { mediaId, questionId, bytes: stored.bytes, seconds: stored.durationSeconds });

    if (gate.billing) {
      void recordSessionUsage(gate.billing, {
        eventType: "FILE_UPLOAD",
        quantity: Math.max(0.001, (stored.bytes ?? 0) / (1024 * 1024)),
        metadata: { kind: owned.kind, bytes: stored.bytes, questionId },
      });
    }

    const q = questionId ? gate.def.questions.find((x) => x.id === questionId) ?? null : null;
    /*
     * `saveAnswerAudio: false` means the researcher wants the words and not
     * the voice. The clip still had to be uploaded — there is nothing to
     * transcribe otherwise — so it is removed once the transcript exists,
     * which the runner does, rather than never being stored at all.
     */
    const keepAudio = q ? savesAudio(q) : true;
    const wantTranscript = q ? transcribes(q) : false;

    let transcriptStatus: string | null = null;
    if (wantTranscript && sttConfigured()) {
      const job = await queueTranscript(db, mediaId, gate.row.surveyId);
      transcriptStatus = job.status;
      log("transcription_queued", { mediaId, jobId: job.id });
    }

    return NextResponse.json({
      ok: true,
      mediaId,
      bytes: stored.bytes,
      transcriptStatus,
      keepAudio,
      /* a file answer — the shape `UploadedFile` stores; the URL is the stable one */
      file: owned.kind === "answer_upload" ? {
        url: stored.url, path: stored.path, mediaId,
        name: stored.fileName ?? "upload", size: stored.bytes ?? 0, type: stored.mimeType ?? "application/octet-stream",
      } : undefined,
      /* exactly the shape `InterviewAudio` expects */
      audio: {
        url: stored.url,
        path: stored.path,
        mediaId,
        mimeType: stored.mimeType ?? undefined,
        bytes: stored.bytes ?? undefined,
        durationSeconds: stored.durationSeconds ?? undefined,
        recordedAt: stored.uploadedAt,
        retakes: Number(body.retakes) || 0,
      },
    });
  } catch (e) {
    if (e instanceof MediaError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** The etags a multipart upload's parts came back with, as the uploader reports them. */
function readParts(raw: unknown): { partNumber: number; etag: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p) => ({ partNumber: Number((p as { partNumber?: unknown })?.partNumber), etag: String((p as { etag?: unknown })?.etag ?? "").replace(/"/g, "") }))
    .filter((p) => Number.isInteger(p.partNumber) && p.partNumber > 0 && !!p.etag);
}
