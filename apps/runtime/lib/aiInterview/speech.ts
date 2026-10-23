import "server-only";
import { synthesizeSpeech } from "@rescript/ai";
import { billingFor, meteredSpeech } from "./runtimeDeps";
import type { SpeakSink } from "./voice";

/**
 * THE CONVERSATION'S VOICE IN THE REPLY STREAM (G1 2026-10-22). Each sentence the speech gate clears is
 * announced at once (`{type:"speak", i, text}`) and synthesized in parallel through the configured
 * text-to-speech (metered per character as `qual_ai_interview_tts`, in the participant's language and the
 * installation's voice, AI_TTS_VOICE); its audio follows in the same NDJSON stream
 * (`{type:"audio", i, mime, b64}`, or `{type:"audio", i, none:true}` → the page uses the browser's voice
 * for that sentence). The page plays them in order of `i` — so the first sentence plays while the rest of
 * the reply is still being written. Only gated text is ever synthesized: this is not a free TTS service.
 */
export function speechSink(emit: (e: Record<string, unknown>) => void, language: () => string): { sink: SpeakSink; done: () => Promise<void> } {
  const pending: Promise<void>[] = [];
  const sink: SpeakSink = ({ i, text }, ctx) => {
    emit({ type: "speak", i, text });
    const lang = ctx.session?.language ?? language();
    pending.push((async () => {
      const out = await meteredSpeech(billingFor(ctx.study, ctx.session), text.length, lang, () => synthesizeSpeech(text.slice(0, 1500), { language: lang, format: "mp3", ...(process.env.AI_TTS_VOICE?.trim() ? { voiceId: process.env.AI_TTS_VOICE.trim() } : {}) })).catch(() => null);
      if (out?.bytes?.length) emit({ type: "audio", i, mime: out.mimeType, b64: Buffer.from(out.bytes).toString("base64"), ms: out.durationMs });
      else emit({ type: "audio", i, none: true });
    })());
  };
  return { sink, done: async () => { await Promise.all(pending); } };
}
