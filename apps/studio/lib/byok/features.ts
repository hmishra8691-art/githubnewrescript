import type { Capability } from "@rescript/ai";
import type { AiFeature } from "./store.ts";

/**
 * WHICH SETTING GOVERNS WHICH OPERATION. One table, so no call site decides
 * for itself and the Settings screen's four rows mean exactly what they say.
 *
 *   Intelligent Mode        every `copilot_*` operation: the editing copilot,
 *                           research plans, document summaries and the steps
 *                           around them
 *   Additional AI features  everything else that talks to a language model:
 *                           rephrase, logic intent, import, analytics
 *                           interpretation and Ask, report and story wording,
 *                           speech synthesis
 *   Speech-to-text          every transcription the Studio asks for on a
 *                           researcher's behalf: spoken instructions (voice
 *                           input) and recordings in the media pipeline. NOT
 *                           respondents' or interviewees' audio — those run in
 *                           the runtime and interview apps, which stay
 *                           platform-managed.
 *   Translation             `translate` / `translate:src->tgt`: the Translation
 *                           Manager's strings, by a translation service (Google,
 *                           DeepL, Azure) on the person's own key, or by their AI
 *                           model (the connection saved under Other AI features)
 */
export const STT_OPERATIONS = ["intelligent_voice", "transcribe_question"] as const;
export const isSttOperation = (operation: string): boolean => (STT_OPERATIONS as readonly string[]).includes(operation);

export const isTranslateOperation = (operation: string): boolean => operation === "translate" || operation.startsWith("translate:");

export function featureOf(operation: string): AiFeature {
  if (isSttOperation(operation)) return "stt";
  if (isTranslateOperation(operation)) return "translation";
  /* the step that reads a spoken instruction in English is part of Intelligent Mode, though it names itself after the voice route */
  if (operation === "intelligent_voice_normalise") return "intelligent";
  return operation.startsWith("copilot_") ? "intelligent" : "additional";
}

/** what an operation needs from the provider beyond chat; a provider that lacks it is refused (or the platform used, in hybrid mode) rather than failing mid-call */
export function needsOf(operation: string): Capability[] {
  if (operation === "tts_preview" || operation === "story_narration" || operation === "report_narration") return ["tts"];
  return [];
}
