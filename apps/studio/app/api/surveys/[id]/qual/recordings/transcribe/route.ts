import { NextRequest } from "next/server";
import { transcribe } from "@rescript/ai";
import { readObject, STT_MAX_BYTES } from "@rescript/media";
import { isFailure, requireProject } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { mediaDbOrResponse } from "@/lib/mediaRoute";
import { sttPrecheck } from "@/lib/byok/connect";
import { billingProjectFor, meteredSttCall, refusalResponse } from "@/lib/metering";
import { qualGuardCapability } from "@/lib/qual/qualAccess";
import { sessionView, sttTranscript } from "@/lib/qual/qualWorkspace";
import { checkRow, json, loadWorkspace, recordEvents, refuse, sessionRow, storeFailure, UUID } from "@/lib/qual/qualStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * TRANSCRIBE A SESSION RECORDING (2026-10-18) — POST { sessionId, language? }.
 *
 * Through the configured speech-to-text provider (the member's own, or the
 * installation's AI_STT_API_URL / AI_STT_API_KEY / AI_STT_MODEL), asking for
 * timed segments and speaker separation; whether the provider actually
 * separated speakers is recorded, never assumed. Metered per minute
 * (SPEECH_TO_TEXT_MINUTE) against the project. Data edit.
 *
 * LIMITS, stated rather than discovered: the provider reads at most 25 MB of
 * audio in one request (`STT_MAX_BYTES`) — about 50 minutes of 64 kbps audio,
 * much less for video. Recordings are NOT split here (splitting a compressed
 * recording needs re-encoding, which the Studio does not do); a longer one is
 * refused with that sentence, and the transcript can be made elsewhere and
 * imported (.vtt / .srt keep the timings). One transcript per recording: a
 * retry after success returns the existing one; a failure leaves the
 * recording stored and the button retryable.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, qualGuardCapability("manage"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "manage");
  if (refused) return refused;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const sessionId = String(body?.sessionId ?? "");
  if (!UUID.test(sessionId)) return json({ error: "which session (sessionId)" }, 400);
  const language = typeof body?.language === "string" ? body.language.trim().slice(0, 12) : "";
  const db = supabaseService();
  try {
    const session = await sessionRow(db, params.id, sessionId);
    if (!session) return json({ error: "no such session" }, 404);
    if (!session.recording_media_id) return json({ error: "this session has no recording yet — upload one first" }, 409);
    const existing = checkRow(await db.from("qual_transcripts").select("id, status").eq("survey_id", params.id).eq("media_id", session.recording_media_id).maybeSingle(), "transcript") as { id: string; status: string } | null;
    if (existing) return json({ ok: true, id: existing.id, already: true, workspace: await loadWorkspace(db, gate) });

    const ready = await sttPrecheck(gate.user, params.id, "qual_transcription");
    if (!ready.ok) return json({ error: ready.error, code: ready.code }, ready.status);
    const handle = mediaDbOrResponse();
    if ("response" in handle) return handle.response;
    const { data: media } = await handle.db.from("media_objects").select("id, bucket, path, storage_provider, mime_type, bytes, duration_seconds, status, original_filename").eq("id", session.recording_media_id).maybeSingle();
    if (!media || media.status !== "stored") return json({ error: "the recording has not finished uploading" }, 409);
    const tooBig = (n: number) => json({ error: `The recording is ${Math.round(n / 1024 / 1024)} MB and the transcription service reads at most ${STT_MAX_BYTES / 1024 / 1024} MB of audio in one request (about 50 minutes at 64 kbps). Split it into parts before uploading, or transcribe it elsewhere and import the .vtt / .srt file — the timings are kept.`, code: "stt_too_large" }, 413);
    if (Number(media.bytes) > STT_MAX_BYTES) return tooBig(Number(media.bytes));
    const billing = await billingProjectFor(gate.user, params.id, "responses.manage");
    if ("response" in billing) return billing.response;
    const bytes = await readObject(handle.db, { bucket: media.bucket, path: media.path, storage_provider: media.storage_provider });
    if (bytes.length > STT_MAX_BYTES) return tooBig(bytes.length);
    const seconds = Number(media.duration_seconds) > 0 ? Math.round(Number(media.duration_seconds)) : Math.max(1, Math.round(bytes.length / 8_000));
    const metered = await meteredSttCall(billing.meter, billing.ctx, "qual_transcription", seconds, () => transcribe(bytes, { segments: true, diarize: true, mimeType: media.mime_type ?? undefined, fileName: media.original_filename ?? media.path.split("/").pop(), language: language || undefined, durationSeconds: seconds, timeoutMs: 280_000 }));
    if (!metered.ok) return refusalResponse(metered);
    const heard = metered.value;
    if (!heard.ok) return json({ error: heard.reason, code: "stt_failed", retryable: true }, heard.status && heard.status >= 400 && heard.status < 600 ? 502 : 500);
    if (!heard.value.text.trim()) return json({ error: "The transcription service heard no speech in this recording. The recording is kept — check it is audible, then try again.", code: "stt_empty", retryable: true }, 422);
    const t = sttTranscript(heard.value, `${session.title} (transcribed)`, sessionView(session).participants);
    const row = checkRow(await db.from("qual_transcripts").insert({ survey_id: params.id, session_id: sessionId, media_id: media.id, title: t.title, source: "stt", format: "stt", language: t.language ?? null, segments: t.segments, speakers: t.speakers, char_count: t.char_count, meta: t.meta, status: "ready", created_by: gate.user.userId }).select("id").single(), "transcript") as { id: string };
    await recordEvents(db, gate, [{ actor: gate.user.userId, action: "transcript.transcribed", detail: `Transcribed the recording of “${session.title}” (${Math.round(seconds / 60)} min, ${t.segments.length} segments, ${t.meta.diarized ? "speakers separated" : "speakers not separated"}, ${heard.value.model})`, ids: [row.id, media.id] }]);
    return json({ ok: true, id: row.id, warnings: t.meta.warnings, workspace: await loadWorkspace(db, gate) });
  } catch (e) { return storeFailure(e); }
}
