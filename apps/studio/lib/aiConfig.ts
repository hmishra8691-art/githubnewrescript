/**
 * IS A LANGUAGE MODEL CONFIGURED — presence only, never a value (Research
 * Engine audit, Phase 1). Pure and `server-only`-free so it can be tested;
 * `platform.ts` reports it and `IntelligentView` is told through
 * /api/platform. The key is read nowhere here.
 */
export interface AiPresence {
  /** AI_API_URL is set */
  ai: boolean;
  /** AI_API_URL is the in-process fake provider */
  aiFake: boolean;
  /** AI_MODEL is named (unset means the OpenAI default, which an Anthropic endpoint refuses) */
  aiModel: boolean;
}

export function aiPresence(env: Record<string, string | undefined> = process.env): AiPresence {
  const url = (env.AI_API_URL ?? "").trim();
  return { ai: !!url, aiFake: url === "fake:", aiModel: !!(env.AI_MODEL ?? "").trim() };
}

/** The warning a deployment manager should read, or null when the model configuration is sound for this tier. */
export function aiConfigWarning(p: AiPresence, tier: "development" | "preview" | "production" | string): string | null {
  if (!p.ai) return "No language model is configured (AI_API_URL, AI_API_KEY, AI_MODEL), so Intelligent Mode is engine-only: requests that name their objects work; descriptive requests, generation from a brief, rewording and document cards do not.";
  if (p.aiFake && tier === "production") return "AI_API_URL is the FAKE provider in production — Intelligent Mode will answer every model request with nothing.";
  if (!p.aiFake && !p.aiModel) return "AI_MODEL is not set, so the copilot asks for the default (gpt-4o-mini) — an Anthropic or self-hosted endpoint refuses that name with a 404.";
  return null;
}
