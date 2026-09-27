import { NextRequest, NextResponse } from "next/server";
import { transcribe, completeJson, sttConfigured, sttProviderName, sttUnavailableReason, aiProviderName } from "@rescript/ai";
import { requireAiCaller } from "@/lib/aiGate";
import { billingProjectFor, meteredAi, meteredStt, refusalResponse } from "@/lib/metering";
import { NORMALISE_SYSTEM_PROMPT, normaliseUserPrompt, coerceNormalised, tidyTranscript } from "@/lib/intelligent/voice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * A SPOKEN INSTRUCTION → TEXT → ENGLISH, for the Intelligent mode (UI upgrade §18–§21).
 *
 * Body: multipart form — `audio` (the recording), `surveyId`, optional
 * `language` (a BCP-47 hint; blank lets the provider detect it).
 * Reply: { ok, text, language, english?, model } — what was heard, in the
 * language it was spoken; the English reading when it was not English.
 *
 * Two providers, both swappable by configuration and neither known to this
 * file beyond its adapter: speech-to-text through `transcribe` (the same
 * cloud adapter the interview pipeline uses — AI_STT_API_URL, falling back
 * to AI_API_URL), and language normalisation through the chat model. The
 * route never sees a key. It never loads or writes a survey: the text goes
 * back to the browser, where the grammar, the model and the planner treat it
 * exactly as a typed sentence, and nothing is applied without review.
 *
 * Who may ask and who pays follow the logic route: a signed-in Studio user
 * billed to the named project; the sandbox against the fake provider needs
 * no session. Speech is metered by the minute (SPEECH_TO_TEXT_MINUTE), the
 * normalisation as one AI request.
 *
 * TEST SEAM: with the FAKE speech provider only, a `hint` field is taken as
 * the transcript, because the fake cannot hear. It is ignored — never read —
 * when a real provider is configured.
 */
const MAX_BYTES = 8 * 1024 * 1024;
const BYTES_PER_SECOND = 16_000;

export async function POST(req: NextRequest) {
  const gate = await requireAiCaller(req);
  if (!gate.ok) return gate.response;
  if (!sttConfigured()) return NextResponse.json({ error: "No transcription provider is configured on this Studio (AI_STT_API_URL).", code: "stt_unconfigured" }, { status: 501 });
  const impossible = sttUnavailableReason();
  if (impossible) return NextResponse.json({ error: impossible, code: "stt_unavailable" }, { status: 501 });

  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "expected a multipart form with an audio file" }, { status: 400 }); }
  const audio = form.get("audio");
  const surveyId = typeof form.get("surveyId") === "string" ? String(form.get("surveyId")) : "";
  const languageHint = typeof form.get("language") === "string" ? String(form.get("language")).trim().slice(0, 12) : "";
  const hint = sttProviderName() === "fake" && typeof form.get("hint") === "string" ? String(form.get("hint")).trim().slice(0, 2000) : "";
  const hintLanguage = sttProviderName() === "fake" && typeof form.get("hintLanguage") === "string" ? String(form.get("hintLanguage")).trim().slice(0, 12) : "";
  if (!(audio instanceof Blob) || audio.size === 0) return NextResponse.json({ error: "the recording is empty" }, { status: 400 });
  if (audio.size > MAX_BYTES) return NextResponse.json({ error: "the recording is too long — keep an instruction under a minute" }, { status: 413 });

  const billing = await billingProjectFor(gate.user, surveyId);
  if ("response" in billing) return billing.response;

  const bytes = new Uint8Array(await audio.arrayBuffer());
  const seconds = Math.max(1, Math.round(bytes.length / BYTES_PER_SECOND));
  const mimeType = audio.type || "audio/webm";
  const fileName = `instruction.${/ogg/.test(mimeType) ? "ogg" : /mp4|m4a/.test(mimeType) ? "m4a" : /mpeg|mp3/.test(mimeType) ? "mp3" : "webm"}`;

  /* 1. speech → text */
  const heard = await meteredStt(billing.meter, billing.ctx, "intelligent_voice", seconds, () =>
    transcribe(bytes, { language: languageHint || undefined, fileName, mimeType, durationSeconds: seconds, timeoutMs: 60_000 }));
  if ("refused" in heard) return NextResponse.json({ error: heard.refused, code: "wallet_refused" }, { status: 402 });
  if (!heard.value.ok) return NextResponse.json({ error: heard.value.reason, code: "stt_failed" }, { status: heard.value.status && heard.value.status >= 400 && heard.value.status < 600 ? 502 : 500 });
  let text = hint || heard.value.value.text || "";
  let language = (hint ? hintLanguage : heard.value.value.language) || languageHint || "en";
  language = language.split(/[-_]/)[0].toLowerCase();
  const model = heard.value.value.model;
  text = tidyTranscript(text);
  if (!text) return NextResponse.json({ ok: true, text: "", language, english: "", model });

  /* 2. language → English, when it is not English already (or when the provider could not tell) */
  let english: string | undefined;
  if (language !== "en" && aiProviderName() !== null) {
    try {
      const user = normaliseUserPrompt(text, language);
      const m = await meteredAi(billing.meter, billing.ctx, "AI_REQUEST", { estimateText: NORMALISE_SYSTEM_PROMPT + user, maxTokens: 300, operation: "intelligent_voice_normalise" },
        () => completeJson(NORMALISE_SYSTEM_PROMPT, user, 300, { timeoutMs: 20_000 }));
      if (!m.ok) return refusalResponse(m);
      const n = coerceNormalised(m.value);
      if (n) { english = n.english; if (n.language && n.language !== "und") language = n.language; }
    } catch (e) {
      console.warn("[rescript:ai] voice normalisation failed", JSON.stringify({ error: (e as Error).message }));
    }
  }
  return NextResponse.json({ ok: true, text, language, ...(english !== undefined ? { english } : {}), model });
}
