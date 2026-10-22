import { NextRequest, NextResponse } from "next/server";
import { sttConfigured, sttUnavailableReason, transcribe } from "@rescript/ai";
import { aiInterviewDeps, billingFor, errorResponse } from "@/lib/aiInterview/runtimeDeps";
import { interviewFor } from "@/lib/aiInterview/gate";
import { meteredSessionStt } from "@/lib/metering";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * VOICE MODE: ONE SPOKEN CHUNK → TEXT. The body is the audio itself (≤ 4 MB — the page records an
 * answer in standalone chunks of at most 60 s, ~0.5 MB at 64 kbps, and joins the texts), the resume
 * token in `x-session-token`, the chunk's length in `x-duration-ms`. Through the configured
 * speech-to-text provider (the same `transcribe` as every recorded answer), metered per minute on the
 * study's project as `qual_ai_interview_stt`. The text comes back for the participant to CORRECT
 * before sending; the audio is not kept here (a consented recording is stored through /media).
 * 501 when no speech-to-text is configured: the page falls back to typing.
 */
const MAX = 4 * 1024 * 1024;
export async function POST(req: NextRequest) {
  try {
    const deps = aiInterviewDeps();
    const { session, study } = await interviewFor(deps, req.headers.get("x-session-token"), { live: true });
    if (session.mode === "text") return NextResponse.json({ error: "this interview is in text mode" }, { status: 400 });
    if (!sttConfigured()) return NextResponse.json({ error: sttUnavailableReason() ?? "speech-to-text is not configured", code: "stt_unavailable" }, { status: 501 });
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX) return NextResponse.json({ error: "that piece of audio is too long — speak in shorter answers" }, { status: 413 });
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (!bytes.length) return NextResponse.json({ error: "no audio" }, { status: 400 });
    if (bytes.length > MAX) return NextResponse.json({ error: "that piece of audio is too long — speak in shorter answers" }, { status: 413 });
    const seconds = Math.max(1, Math.min(120, (Number(req.headers.get("x-duration-ms")) || 0) / 1000 || bytes.length / 8000));
    const mime = (req.headers.get("content-type") ?? "audio/webm").split(";")[0].slice(0, 60);
    const m = await meteredSessionStt(billingFor(study, session), { seconds, operation: "qual_ai_interview_stt" }, () =>
      transcribe(bytes, { language: session.language, mimeType: mime, fileName: `answer.${/mp4|m4a/.test(mime) ? "m4a" : /wav/.test(mime) ? "wav" : /ogg/.test(mime) ? "ogg" : "webm"}`, durationSeconds: seconds }));
    if ("refused" in m) return NextResponse.json({ error: "Voice is unavailable right now — please type your answer.", code: "refused" }, { status: 402 });
    /* `transcribe` answers an outcome: the words, or the provider's reason (said to the participant as "type instead") */
    const out = m.value;
    if (!out.ok) {
      console.warn("[rescript:ai-interview] transcription failed", JSON.stringify({ session: session.id.slice(0, 8), status: out.status ?? null }));
      return NextResponse.json({ error: "Your answer could not be turned into text — please try again, or type it.", code: "stt_failed" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, text: String(out.value.text ?? "").trim(), seconds }, { headers: { "cache-control": "no-store" } });
  } catch (e) { return errorResponse(e); }
}
