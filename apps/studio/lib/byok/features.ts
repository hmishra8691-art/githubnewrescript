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
 *   Speech-to-text, Translation   their own gates (Phases C and D)
 */
export function featureOf(operation: string): AiFeature {
  return operation.startsWith("copilot_") ? "intelligent" : "additional";
}

/** what an operation needs from the provider beyond chat; a provider that lacks it is refused (or the platform used, in hybrid mode) rather than failing mid-call */
export function needsOf(operation: string): Capability[] {
  if (operation === "tts_preview" || operation === "story_narration" || operation === "report_narration") return ["tts"];
  return [];
}
