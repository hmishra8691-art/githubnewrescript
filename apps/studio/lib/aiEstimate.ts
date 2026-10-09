import { estimateTokens, type UsageSpec } from "@rescript/billing";
import { aiModelName, type AiModelTier } from "@rescript/ai";

/**
 * WHAT AN AI CALL IS PRICED AS — the one spec `meteredAi` reserves and
 * `estimateAi` prices (the Studio's metering). Kept apart from the metering
 * service so it can be tested without a server: it reads only the
 * environment and the model configuration.
 *
 * The TIER (Research Engine audit, Phase 6): a short structuring call is
 * priced at the small model when one is configured (AI_MODEL_SMALL); a
 * drafting call, or a call that names no tier, at the large one (AI_MODEL).
 * The cost preview and the reservation see the same model, so what the
 * card shows is what the wallet is asked for.
 */

/** Provider ids as the cost registry knows them; the fake provider is priced as the real one only when simulation is on. */
export function meterProvider(provider: string, kind: "chat" | "tts" | "stt" | "translate"): string {
  if (provider !== "fake") return provider;
  if (process.env.BILLING_SIMULATE_FAKE_COSTS !== "1") return "fake";
  return kind === "translate" ? "google" : "openai-compatible";
}
/** The model a usage row is priced at; under simulation the fake provider's "fake" model becomes the configured one (a real model name given is kept — the tier's). */
export function meterModel(provider: string, model: string | null, kind: "chat" | "tts" | "stt" | "translate"): string | null {
  if (provider !== "fake" || process.env.BILLING_SIMULATE_FAKE_COSTS !== "1") return model;
  if (kind === "translate") return "v2";
  if (kind === "chat") return model && model !== "fake" ? model : aiModelName();
  if (kind === "stt") return (process.env.AI_STT_MODEL ?? "").trim() || "whisper-1";
  return (process.env.AI_TTS_MODEL ?? "").trim() || "tts-1";
}

/** what a model call is expected to cost: the prompt's size, the reply's cap, the number of requests — and the tier, the large model when none is named */
export interface AiEstimate { estimateText: string; maxTokens: number; requests?: number; operation: string; tier?: AiModelTier }

/** The usage spec an AI call is reserved (and estimated) at — one definition for `meteredAi` and `estimateAi`. */
export function aiSpec(eventType: string, est: AiEstimate): UsageSpec {
  const providerName = process.env.AI_API_URL === "fake:" ? "fake" : "openai-compatible";
  const reqs = est.requests ?? 1;
  return {
    eventType, provider: meterProvider(providerName, "chat"), service: "chat", model: meterModel(providerName, aiModelName(est.tier), "chat"),
    inputUnits: (estimateTokens(est.estimateText) + 120) * reqs, outputUnits: est.maxTokens * reqs,
    metadata: { operation: est.operation },
  };
}
