import { AsyncLocalStorage } from "node:async_hooks";

/**
 * USAGE REPORTING — what a provider call consumed, handed to whoever is
 * metering it, without changing a single function signature.
 *
 * The client functions (`classify`, `writeProbe`, `translateBatch`,
 * `synthesizeSpeech`, the Google adapter…) report into an AsyncLocalStorage
 * sink. A route that wants to bill wraps its work in `collectUsage(fn)` and
 * receives every report made underneath — the tokens the model said it
 * used, the characters sent to Google — while a caller that does not wrap
 * gets exactly the behaviour it always had.
 */

export interface AiUsage {
  kind: "chat" | "tts" | "stt" | "translate";
  provider: string;            // openai-compatible | fake | google | …
  model: string | null;
  inputTokens?: number;
  outputTokens?: number;
  /** characters sent (translation, text-to-speech) */
  characters?: number;
  /** audio seconds (speech) */
  seconds?: number;
  requests: number;
  /** the provider did not report usage; the numbers are estimated from the text */
  estimated: boolean;
}

const sink = new AsyncLocalStorage<AiUsage[]>();

/** Run `fn` collecting every usage report made inside it. */
export async function collectUsage<T>(fn: () => Promise<T>): Promise<{ value: T; usage: AiUsage[] }> {
  const usage: AiUsage[] = [];
  const value = await sink.run(usage, fn);
  return { value, usage };
}

/** Report a provider call's consumption to the enclosing collector, if any. */
export function reportUsage(u: AiUsage): void {
  sink.getStore()?.push(u);
}

/** ~4 characters per token — the estimate used when a provider does not report usage. */
export function approxTokens(text: string): number {
  return Math.max(1, Math.ceil((text ?? "").length / 4));
}

/** Totals over a collection. */
export function sumUsage(list: AiUsage[]): { inputTokens: number; outputTokens: number; characters: number; seconds: number; requests: number; estimated: boolean; model: string | null; provider: string | null } {
  const t = { inputTokens: 0, outputTokens: 0, characters: 0, seconds: 0, requests: 0, estimated: false, model: null as string | null, provider: null as string | null };
  for (const u of list) {
    t.inputTokens += u.inputTokens ?? 0; t.outputTokens += u.outputTokens ?? 0; t.characters += u.characters ?? 0; t.seconds += u.seconds ?? 0; t.requests += u.requests;
    t.estimated = t.estimated || u.estimated; t.model = t.model ?? u.model; t.provider = t.provider ?? u.provider;
  }
  return t;
}
