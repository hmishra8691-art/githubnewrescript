import "server-only";

/**
 * THE AI PROVIDER, as the runtime sees it. The client itself lives in
 * `@rescript/ai` — one implementation shared with the Studio (which uses it
 * to write spoken-friendly question versions for a programmer to approve).
 * Configuration is server env only (AI_API_URL, AI_API_KEY, AI_MODEL; see the
 * package); `server-only` here keeps every import of it out of the browser.
 */
export { aiConfigured, aiProviderName, classify, sentiment, writeProbe, rephraseForSpeech } from "@rescript/ai";
