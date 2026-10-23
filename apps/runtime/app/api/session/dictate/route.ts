import { NextRequest, NextResponse } from "next/server";
import { speechInputQuestionOn, speechServerOn } from "@rescript/engine";
import { sttConfigured, sttProviderName, sttUnavailableReason, transcribe } from "@/lib/ai";
import { definitionForProviderCall } from "@/lib/aiSession";
import { meteredSessionStt } from "@/lib/metering";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * SERVER DICTATION — one recorded answer → text (engine item #16).
 *
 * The respondent's browser has no speech recogniser (Firefox) or its own
 * failed; the microphone recorded the answer (≤ 60 s, MediaRecorder) after
 * the respondent agreed, and sends it here. Body = the audio itself (≤ 4 MB);
 * headers: `x-session-id`, `x-question-id`, `x-language`, `x-duration-ms`.
 * Through the configured speech-to-text provider (the same `transcribe` every
 * recorded answer uses), METERED per minute on the session's project
 * (`respondent_dictation`). Nothing is stored: the text goes back to the page,
 * where the respondent can correct it before answering.
 *
 * Who may: a live in-progress session of a survey whose dictation and server
 * dictation are on (`deployment.speechInput` / `speechServer`) for that
 * question. A preview (`x-session-id: preview`) only against the FAKE provider
 * — free and deterministic — exactly as `/api/session/ai` allows.
 *
 * GET → `{ available }`: whether the page should offer server dictation at all.
 */
const MAX = 4 * 1024 * 1024;

export async function GET() {
  const available = sttConfigured();
  return NextResponse.json({ available, provider: available ? sttProviderName() : null, ...(available ? {} : { reason: sttUnavailableReason() ?? "speech-to-text is not configured" }) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const sessionId = req.headers.get("x-session-id") ?? "";
  const questionId = (req.headers.get("x-question-id") ?? "").slice(0, 120);
  if (!sttConfigured()) return NextResponse.json({ error: "Dictation is not available right now — please type your answer.", code: "stt_unavailable" }, { status: 501 });
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX) return NextResponse.json({ error: "That recording is too long — dictate a shorter answer, or type it." }, { status: 413 });

  let billing = null;
  if (sessionId !== "preview") {
    const gate = await definitionForProviderCall({ sessionId, build: undefined }, { configured: true, fake: sttProviderName() === "fake", what: "speech-to-text", unconfigured: "speech-to-text is not configured" });
    if ("response" in gate) return gate.response;
    const q = gate.def.questions.find((x) => x.id === questionId);
    if (!q) return NextResponse.json({ error: "unknown question" }, { status: 400 });
    if (!speechServerOn(gate.def) || !speechInputQuestionOn(gate.def, q)) return NextResponse.json({ error: "Dictation is turned off for this question.", code: "off" }, { status: 403 });
    billing = gate.billing;
  } else if (sttProviderName() !== "fake") {
    return NextResponse.json({ error: "a preview cannot use the speech-to-text provider; open a test link to try dictation", code: "preview" }, { status: 403 });
  }

  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length) return NextResponse.json({ error: "No audio was recorded." }, { status: 400 });
  if (bytes.length > MAX) return NextResponse.json({ error: "That recording is too long — dictate a shorter answer, or type it." }, { status: 413 });
  const seconds = Math.max(1, Math.min(120, (Number(req.headers.get("x-duration-ms")) || 0) / 1000 || bytes.length / 8000));
  const mime = (req.headers.get("content-type") ?? "audio/webm").split(";")[0].trim().slice(0, 60);
  const language = (req.headers.get("x-language") ?? "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 16) || undefined;
  const ext = /mp4|m4a|aac/.test(mime) ? "m4a" : /wav/.test(mime) ? "wav" : /ogg/.test(mime) ? "ogg" : /mpeg|mp3/.test(mime) ? "mp3" : "webm";
  try {
    const m = await meteredSessionStt(billing, { seconds, operation: "respondent_dictation" }, () =>
      transcribe(bytes, { language, mimeType: mime, fileName: `dictation.${ext}`, durationSeconds: seconds }));
    if ("refused" in m) return NextResponse.json({ error: "Dictation is unavailable right now — please type your answer.", code: "refused" }, { status: 402 });
    const out = m.value;
    if (!out.ok) {
      console.warn("[rescript:dictate] transcription failed", JSON.stringify({ session: sessionId.slice(0, 8), status: out.status ?? null }));
      return NextResponse.json({ error: "Your answer could not be turned into text — please try again, or type it.", code: "stt_failed" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, text: String(out.value.text ?? "").trim(), seconds }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error("[rescript:dictate] error", (e as Error).message);
    return NextResponse.json({ error: "Your answer could not be turned into text — please try again, or type it.", code: "error" }, { status: 500 });
  }
}
