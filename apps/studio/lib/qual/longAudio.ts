import "server-only";
import type { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { transcribe } from "@rescript/ai";
import { readObject, splitAudio, mergePartTranscripts, type MediaDb } from "@rescript/media";
import type { ProjectContext } from "@/lib/guard";
import { meteredSttCall, refusalResponse, type billingProjectFor } from "@/lib/metering";
import { sttTranscript, type Participant } from "./qualWorkspace";
import { checkRow, json, loadWorkspace, recordEvents } from "./qualStore";
import { claimJob, ensureJob, saveJob } from "./synthesisStore";
import { enqueueAutoCode } from "./autoCode";

/**
 * LONG RECORDINGS, TRANSCRIBED IN PARTS (2026-10-22). A recording over the provider's 25 MB is cut WITHOUT
 * re-encoding (`@rescript/media` splitAudio: WAV on block boundaries, MP3 on frame boundaries; other formats are
 * refused with the reason), each part transcribed (metered per minute of that part), the timings moved back onto
 * the recording's clock, and one transcript stored. It runs as a resumable job (`qual_jobs`, key `stt:<media>`):
 * each request transcribes parts until ~200 s, stores what it has, and answers 202 `{ continue: true }`; the
 * Studio calls again. A retry never pays twice for a part already transcribed.
 */
export const LONG_AUDIO_MAX_BYTES = 200 * 1024 * 1024;
type Billing = Exclude<Awaited<ReturnType<typeof billingProjectFor>>, { response: NextResponse }>;
interface PartResult { offsetSeconds: number; text: string; segments?: { start: number; end: number; text: string; speaker?: string }[]; diarized?: boolean; model?: string; language?: string }

export async function transcribeLong(o: { db: SupabaseClient; mediaDb: MediaDb; gate: ProjectContext; surveyId: string; session: { id: string; title: string }; participants: Participant[]; media: { id: string; bucket: string; path: string; storage_provider: string; mime_type: string | null; bytes: number; original_filename: string | null }; language?: string; billing: Billing }): Promise<NextResponse> {
  const { db, gate, surveyId, media } = o;
  if (Number(media.bytes) > LONG_AUDIO_MAX_BYTES) return json({ error: `The recording is ${Math.round(media.bytes / 1024 / 1024)} MB; recordings up to ${LONG_AUDIO_MAX_BYTES / 1024 / 1024} MB are split and transcribed here. Transcribe it elsewhere and import the .vtt / .srt — the timings are kept.`, code: "stt_too_large" }, 413);
  const { job } = await ensureJob(db, surveyId, { kind: "transcribe_long", key: `stt:${media.id}`, sourceIds: [o.session.id], userId: gate.user.userId });
  if (job.status === "done" || job.status === "refused") return json({ error: job.error ?? "this recording was handled already", code: "already" }, 409);
  const claimed = await claimJob(db, surveyId, job.id, 290);
  if (!claimed) return json({ ok: true, continue: true, busy: true, progress: job.progress }, 202);
  const started = Date.now();
  const bytes = await readObject(o.mediaDb, { bucket: media.bucket, path: media.path, storage_provider: media.storage_provider } as never);
  const split = splitAudio(bytes, media.mime_type ?? "");
  if (!split.ok) {
    await saveJob(db, surveyId, job.id, { status: "refused", error: split.reason, release: true, finished: true });
    return json({ error: `The recording is ${Math.round(bytes.length / 1024 / 1024)} MB, over the 25 MB a transcription request takes. ${split.reason}`, code: split.code === "unsupported" ? "stt_unsplittable" : "stt_too_large" }, split.code === "unsupported" ? 415 : 413);
  }
  const done: PartResult[] = Array.isArray((claimed.cursor as { parts?: unknown }).parts) ? (claimed.cursor as { parts: PartResult[] }).parts : [];
  for (let i = done.length; i < split.parts.length; i++) {
    if (Date.now() - started > 200_000) {
      await saveJob(db, surveyId, job.id, { cursor: { parts: done }, progress: { parts: split.parts.length, done: done.length }, release: true });
      return json({ ok: true, continue: true, progress: { parts: split.parts.length, done: done.length } }, 202);
    }
    const p = split.parts[i];
    const seconds = Math.max(1, Math.round(p.durationSeconds));
    const m = await meteredSttCall(o.billing.meter, o.billing.ctx, "qual_transcription", seconds, () => transcribe(p.bytes, { segments: true, diarize: true, mimeType: p.mimeType, fileName: p.fileName, language: o.language || undefined, durationSeconds: seconds, timeoutMs: 180_000 }));
    if (!m.ok) { await saveJob(db, surveyId, job.id, { cursor: { parts: done }, release: true }); return refusalResponse(m); }
    if (!m.value.ok) { await saveJob(db, surveyId, job.id, { cursor: { parts: done }, error: m.value.reason, release: true }); return json({ error: `Part ${i + 1} of ${split.parts.length}: ${m.value.reason}`, code: "stt_failed", retryable: true, progress: { parts: split.parts.length, done: done.length } }, 502); }
    const v = m.value.value;
    done.push({ offsetSeconds: p.offsetSeconds, text: v.text, ...(v.segments ? { segments: v.segments } : {}), diarized: !!v.diarized, model: v.model, ...(v.language ? { language: v.language } : {}) });
    await saveJob(db, surveyId, job.id, { cursor: { parts: done }, progress: { parts: split.parts.length, done: done.length } });
  }
  const merged = mergePartTranscripts(done);
  if (!merged.text.trim()) { await saveJob(db, surveyId, job.id, { status: "failed", error: "no speech was heard", release: true, finished: true }); return json({ error: "The transcription service heard no speech in this recording.", code: "stt_empty", retryable: true }, 422); }
  const t = sttTranscript({ text: merged.text, segments: merged.segments, diarized: merged.diarized, model: done[0]?.model ?? "stt", language: done[0]?.language, durationSeconds: Math.round(split.durationSeconds) }, `${o.session.title} (transcribed)`, o.participants);
  t.meta.warnings = [...merged.warnings, ...t.meta.warnings];
  t.meta.parts = split.parts.length; t.meta.split = split.format;
  const row = checkRow(await db.from("qual_transcripts").insert({ survey_id: surveyId, session_id: o.session.id, media_id: media.id, title: t.title, source: "stt", format: "stt", language: t.language ?? null, segments: t.segments, speakers: t.speakers, char_count: t.char_count, meta: t.meta, status: "ready", created_by: gate.user.userId }).select("id").single(), "transcript") as { id: string };
  await saveJob(db, surveyId, job.id, { status: "done", progress: { parts: split.parts.length, done: done.length }, cursor: {}, release: true, finished: true });
  await recordEvents(db, gate, [{ actor: gate.user.userId, action: "transcript.transcribed", detail: `Transcribed the recording of “${o.session.title}” in ${split.parts.length} parts (${split.format.toUpperCase()} split without re-encoding, ${Math.round(split.durationSeconds / 60)} min, ${t.segments.length} segments)`, ids: [row.id, media.id] }]);
  await enqueueAutoCode(db, surveyId, row.id, gate.user.userId).catch(() => null);
  return json({ ok: true, id: row.id, warnings: t.meta.warnings, workspace: await loadWorkspace(db, gate) });
}
