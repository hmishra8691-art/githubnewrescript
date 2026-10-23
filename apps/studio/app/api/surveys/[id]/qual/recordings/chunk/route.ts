import { NextRequest } from "next/server";
import { transcribe, sttProviderName } from "@rescript/ai";
import { readWav, mergeChunkTranscripts, CHUNK_SAMPLE_RATE, type ChunkTranscript } from "@rescript/media";
import { isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { sttPrecheck } from "@/lib/byok/connect";
import { billingProjectFor, meteredSttCall, refusalResponse } from "@/lib/metering";
import { qualGuardCapability } from "@/lib/qual/qualAccess";
import { sessionView, sttTranscript } from "@/lib/qual/qualWorkspace";
import { checkRow, json, loadWorkspace, recordEvents, refuse, sessionRow, storeFailure, UUID } from "@/lib/qual/qualStore";
import { claimJob, ensureJob, saveJob } from "@/lib/qual/synthesisStore";
import { enqueueAutoCode } from "@/lib/qual/autoCode";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * ONE PART OF A RECORDING DECODED IN THE RESEARCHER'S BROWSER (2026-10-22, engine item #17).
 *
 * A recording the server cannot split (M4A/AAC, MP4, WebM/Opus, OGG, FLAC — no demuxer here) is decoded by
 * the Studio page with Web Audio, resampled to 16 kHz mono and re-encoded as WAV parts of at most 24 MB with
 * 2 s of overlap (`lib/qual/browserAudio.ts`, `@rescript/media` planChunks). Each part is POSTed here as the
 * request body (`audio/wav`), with headers saying where it sits:
 *
 *   x-part-index, x-part-count, x-offset (s), x-duration (s), x-overlap-before (s), x-overlap-after (s),
 *   x-language (hint), x-session-id (the qual session the recording belongs to — saved projects)
 *
 * Each part is transcribed with segment AND word timings, metered per minute to the project
 * (`qual_transcription`). A SAVED project keeps every part's result in a resumable job (`qual_jobs`, key
 * `stt-chunks:<recording>`) — a part sent twice is never paid twice — and when the last part is in, merges
 * them (timestamps moved onto the recording's clock, the overlaps de-duplicated by word timings) into ONE
 * transcript of the stored recording, so clips play from the original file. The SANDBOX (no storage) answers
 * each part's transcript and the page merges and keeps it.
 */
const MAX_PART_BYTES = 25 * 1024 * 1024;
const num = (v: string | null, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  /* the sandbox may call without an account only against the FAKE speech provider (free, deterministic) */
  const sandbox = params.id === "sandbox";
  if (isFailure(authed) && !(sandbox && sttProviderName() === "fake")) return authed.response;
  const user = isFailure(authed) ? null : authed;
  let gate: Exclude<Awaited<ReturnType<typeof requireProjectFor>>, { response: unknown }> | null = null;
  if (!sandbox) {
    const g = await requireProjectFor(user!, params.id, qualGuardCapability("manage"));
    if (isFailure(g)) return g.response;
    const refused = refuse(g, "manage");
    if (refused) return refused;
    gate = g;
  }

  const h = req.headers;
  const part = { index: Math.floor(num(h.get("x-part-index"), -1)), count: Math.floor(num(h.get("x-part-count"), 0)), offset: num(h.get("x-offset")), duration: num(h.get("x-duration")), before: num(h.get("x-overlap-before")), after: num(h.get("x-overlap-after")) };
  if (part.index < 0 || part.count < 1 || part.index >= part.count || part.count > 400 || part.offset < 0 || part.duration <= 0) return json({ error: "which part of the recording (x-part-index / x-part-count / x-offset / x-duration)" }, 400);
  const language = (h.get("x-language") ?? "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 12);
  const len = num(h.get("content-length"));
  if (len > MAX_PART_BYTES) return json({ error: "a part is at most 25 MB" }, 413);

  const ready = await sttPrecheck(user, params.id, "qual_transcription");
  if (!ready.ok) return json({ error: ready.error, code: ready.code }, ready.status);
  const billing = await billingProjectFor(user, params.id, sandbox ? undefined : "responses.manage");
  if ("response" in billing) return billing.response;

  const read = async (): Promise<Uint8Array | Response> => {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (!bytes.length) return json({ error: "the part is empty" }, 400);
    if (bytes.length > MAX_PART_BYTES) return json({ error: "a part is at most 25 MB" }, 413);
    const info = readWav(bytes);
    if (!info || info.channels !== 1 || info.sampleRate !== CHUNK_SAMPLE_RATE || info.bitsPerSample !== 16) return json({ error: "a part is a 16 kHz mono 16-bit WAV (decoded in the browser)" }, 415);
    return bytes;
  };
  const transcribePart = async (bytes: Uint8Array) => {
    const seconds = Math.max(1, Math.round(part.duration));
    return meteredSttCall(billing.meter, billing.ctx, "qual_transcription", seconds, () => transcribe(bytes, { segments: true, diarize: true, words: true, mimeType: "audio/wav", fileName: `part-${part.index + 1}.wav`, language: language || undefined, durationSeconds: seconds, timeoutMs: 240_000 }));
  };
  const asPart = (v: { text: string; segments?: ChunkTranscript["segments"]; words?: ChunkTranscript["words"]; diarized?: boolean; model?: string; language?: string }): ChunkTranscript & { model?: string; language?: string } => ({
    index: part.index, offsetSeconds: part.offset, durationSeconds: part.duration, overlapBefore: part.before, overlapAfter: part.after,
    text: v.text, ...(v.segments?.length ? { segments: v.segments } : {}), ...(v.words?.length ? { words: v.words } : {}), diarized: !!v.diarized, ...(v.model ? { model: v.model } : {}), ...(v.language ? { language: v.language } : {}),
  });

  /* ------------------------------------------------ the sandbox: the part's transcript, merged by the page */
  if (sandbox) {
    const bytes = await read();
    if (bytes instanceof Response) return bytes;
    const m = await transcribePart(bytes);
    if (!m.ok) return refusalResponse(m);
    if (!m.value.ok) return json({ error: `Part ${part.index + 1} of ${part.count}: ${m.value.reason}`, code: "stt_failed", retryable: true }, 502);
    return json({ ok: true, part: asPart(m.value.value) });
  }

  /* ------------------------------------------------ a saved project: kept in a job, merged into one transcript */
  const db = supabaseService();
  const g = gate!;
  try {
    const sessionId = h.get("x-session-id") ?? "";
    if (!UUID.test(sessionId)) return json({ error: "which session (x-session-id)" }, 400);
    const session = await sessionRow(db, params.id, sessionId);
    if (!session) return json({ error: "no such session" }, 404);
    if (!session.recording_media_id) return json({ error: "this session has no recording yet — upload one first (the parts are transcribed for the stored recording, so its clips play from it)" }, 409);
    const mediaId = session.recording_media_id;
    const existing = checkRow(await db.from("qual_transcripts").select("id").eq("survey_id", params.id).eq("media_id", mediaId).maybeSingle(), "transcript") as { id: string } | null;
    if (existing) return json({ ok: true, id: existing.id, already: true, workspace: await loadWorkspace(db, g) });
    const { job } = await ensureJob(db, params.id, { kind: "transcribe_long", key: `stt-chunks:${mediaId}`, sourceIds: [sessionId], userId: user?.userId ?? null });
    if (job.status === "done" || job.status === "refused") return json({ error: job.error ?? "this recording was handled already", code: "already" }, 409);
    const claimed = await claimJob(db, params.id, job.id, 290);
    if (!claimed) return json({ ok: true, busy: true, error: "another part of this recording is being transcribed — the page retries" }, 409);
    const cursor = (claimed.cursor ?? {}) as { parts?: (ChunkTranscript & { model?: string; language?: string })[]; count?: number };
    const done = Array.isArray(cursor.parts) ? cursor.parts : [];
    if (cursor.count && cursor.count !== part.count) { await saveJob(db, params.id, job.id, { release: true }); return json({ error: `this recording was started in ${cursor.count} parts; reload and transcribe it again`, code: "parts_changed" }, 409); }
    if (!done.some((p) => p.index === part.index)) {
      const bytes = await read();
      if (bytes instanceof Response) { await saveJob(db, params.id, job.id, { release: true }); return bytes; }
      const m = await transcribePart(bytes);
      if (!m.ok) { await saveJob(db, params.id, job.id, { release: true }); return refusalResponse(m); }
      if (!m.value.ok) { await saveJob(db, params.id, job.id, { error: m.value.reason, release: true }); return json({ error: `Part ${part.index + 1} of ${part.count}: ${m.value.reason}`, code: "stt_failed", retryable: true }, 502); }
      done.push(asPart(m.value.value));
    }
    const progress = { parts: part.count, done: done.length };
    if (done.length < part.count) {
      await saveJob(db, params.id, job.id, { cursor: { parts: done, count: part.count }, progress, release: true });
      return json({ ok: true, received: part.index, progress }, 202);
    }
    /* every part in: one transcript, on the recording's clock */
    const merged = mergeChunkTranscripts(done);
    if (!merged.text.trim()) { await saveJob(db, params.id, job.id, { status: "failed", error: "no speech was heard", release: true, finished: true }); return json({ error: "The transcription service heard no speech in this recording.", code: "stt_empty", retryable: true }, 422); }
    const last = done[done.length - 1];
    const durationSeconds = Math.round(last.offsetSeconds + last.durationSeconds);
    const t = sttTranscript({ text: merged.text, segments: merged.segments, ...(merged.words.length ? { words: merged.words } : {}), diarized: merged.diarized, model: done[0]?.model ?? "stt", language: done[0]?.language, durationSeconds }, `${session.title} (transcribed)`, sessionView(session).participants);
    t.meta.warnings = [...merged.warnings, ...t.meta.warnings];
    t.meta.parts = part.count; t.meta.split = "browser"; t.meta.deduplicatedWords = merged.deduplicated;
    const row = checkRow(await db.from("qual_transcripts").insert({ survey_id: params.id, session_id: sessionId, media_id: mediaId, title: t.title, source: "stt", format: "stt", language: t.language ?? null, segments: t.segments, speakers: t.speakers, char_count: t.char_count, meta: t.meta, status: "ready", created_by: user?.userId ?? null }).select("id").single(), "transcript") as { id: string };
    await saveJob(db, params.id, job.id, { status: "done", progress, cursor: {}, release: true, finished: true });
    await recordEvents(db, g, [{ actor: g.user.userId, action: "transcript.transcribed", detail: `Transcribed the recording of “${session.title}” in ${part.count} parts decoded in the browser (16 kHz mono WAV, ${Math.round(durationSeconds / 60)} min, ${t.segments.length} segments${merged.wordTimings ? ", word timings" : ""})`, ids: [row.id, mediaId] }]);
    await enqueueAutoCode(db, params.id, row.id, user?.userId ?? null).catch(() => null);
    return json({ ok: true, id: row.id, warnings: t.meta.warnings, workspace: await loadWorkspace(db, g) });
  } catch (e) { return storeFailure(e); }
}
