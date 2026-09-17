import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireEditRight } from "@/lib/guard";
import { getMeter, projectContext, recordUsage } from "@/lib/metering";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { confirmUpload, queueTranscript, MediaError, MEDIA_KINDS, stageLogger, type MediaKind } from "@rescript/media";
import { sttConfigured, sttUnavailableReason } from "@rescript/ai";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE BYTES ARRIVED — CHECKED, NOT ASSUMED.
 *
 * The browser uploaded straight to storage, so the only thing this route is
 * told is that the browser thinks it worked. It lists the object before
 * agreeing, because "the client reported success" and "the object exists" are
 * two different facts and the row is supposed to be the one that is true.
 *
 * A `question_audio` — the audio-only companion the recorder captures
 * alongside the video, purely so the transcript has something small to read —
 * also gets a transcription job queued here. The job is a durable row, not an
 * inline call: a five-minute clip takes a provider twenty to sixty seconds,
 * which is longer than the request the researcher is waiting on is allowed to
 * live.
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
  const db = handle.db;
  const log = stageLogger(`survey:${params.id}`);

  try {
    /* the row belongs to this survey, or it is not this caller's to confirm */
    const { data: owned } = await db.from("media_objects").select("id, kind, survey_id").eq("id", mediaId).maybeSingle();
    if (!owned || owned.survey_id !== params.id) return NextResponse.json({ error: "no such recording" }, { status: 404 });

    const stored = await confirmUpload(db, mediaId, {
      bytes: Number(body.bytes) || Number(body.bytesRecorded) || null,
      durationSeconds: Number(body.durationSeconds) || null,
      width: Number(body.width) || null,
      height: Number(body.height) || null,
    }, readParts(body.parts));
    log("storage_confirmed", { mediaId, kind: owned.kind, bytes: stored.bytes, seconds: stored.durationSeconds });

    /* question media is authoring content — a stimulus or a recorded prompt
       that ships with the questionnaire — so it is real spend, LIVE. The
       TRANSCRIPTION of a clip is a different question, answered per clip by
       `mediaEnvironment`. */
    void recordUsage(getMeter(), projectContext(gate, "LIVE"), {
      eventType: "FILE_UPLOAD",
      quantity: Math.max(0.001, (stored.bytes ?? 0) / (1024 * 1024)),
      metadata: { kind: owned.kind, bytes: stored.bytes, questionId: String(body.questionId ?? "") },
    });

    /*
     * A job is queued only if something could ever run it. Queuing one an
     * installation cannot service leaves a row at `waiting` forever and a
     * panel that polls it forever, which looks like slowness rather than the
     * configuration problem it is.
     */
    let transcriptStatus: string | null = null;
    let transcriptUnavailable: string | null = null;
    if (MEDIA_KINDS[owned.kind as MediaKind]?.transcribed) {
      if (sttConfigured()) {
        const job = await queueTranscript(db, mediaId, params.id);
        transcriptStatus = job.status;
        log("transcription_queued", { mediaId, jobId: job.id });
      } else {
        transcriptUnavailable = sttUnavailableReason() ?? "No transcription provider is configured on this installation.";
        log("transcription_failed", { mediaId, at: "not_configured", error: transcriptUnavailable });
      }
    }

    return NextResponse.json({
      ok: true,
      mediaId,
      transcriptStatus,
      transcriptUnavailable,
      /* exactly the shape `settings.interviewVideo` expects, so the caller
         stores what it is given rather than assembling a second version */
      video: {
        url: stored.url,
        path: stored.path,
        mediaId,
        mimeType: stored.mimeType ?? undefined,
        bytes: stored.bytes ?? undefined,
        durationSeconds: stored.durationSeconds ?? undefined,
        width: stored.width ?? undefined,
        height: stored.height ?? undefined,
        recordedAt: stored.uploadedAt,
        source: String(body.source ?? "uploaded") === "recorded" ? "recorded" : "uploaded",
        status: "ready",
        fileName: stored.fileName ?? undefined,
      },
    });
  } catch (e) {
    if (e instanceof MediaError) {
      log("transcription_failed", { mediaId, at: "confirm", error: e.message });
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
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
