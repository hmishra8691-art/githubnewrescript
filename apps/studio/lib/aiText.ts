import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalJson, hash64, type Withheld } from "@rescript/analytics";
import { cacheGet, cachePut } from "./resultCache.ts";

/**
 * THE RECORD AND THE REUSE OF MODEL-WRITTEN TEXT (audit A-6, Phase 2).
 *
 * Every text a model wrote for a project leaves a record: which model, which
 * version of the prompt, which claims it rested on, what the checker did to
 * it (kept, replaced by the engine's wording, dropped and why) and what was
 * withheld from the prompt. Later, "why does this report say that, and who
 * wrote it?" is a question with an answer. The record is an audit event
 * (`analytics.ai_text_generated`), so the Activity tab already shows it.
 *
 * And a request that is the same is not paid for twice: the model's reply is
 * kept under a key made of the claims it was shown, the prompt's version and
 * the model, so an unchanged report regenerated tomorrow costs nothing — and
 * a changed prompt or changed numbers is a different key, never a stale
 * sentence. The checker runs on every use of a cached reply: the gate may have
 * been tightened since, and what stands is decided now. The project's AI
 * switch is asked BEFORE the cache is read, so a project that has gone
 * Internal is never served a reply written while it was not.
 */

export const replyKey = (parts: Record<string, unknown>): string => `ai_${hash64(canonicalJson(parts))}`;

export async function replyFromCache<T>(db: SupabaseClient | undefined, surveyId: string, key: string): Promise<T | null> {
  if (!db || !surveyId || surveyId === "sandbox") return null;
  const hit = await cacheGet<T>(db, surveyId, key).catch(() => null);
  return hit ? hit.payload : null;
}
export async function keepReply(db: SupabaseClient | undefined, surveyId: string, key: string, value: unknown): Promise<void> {
  if (!db || !surveyId || surveyId === "sandbox" || value == null) return;
  await cachePut(db, surveyId, key, value).catch(() => "skipped");
}

export interface AiTextRecord {
  operation: string;
  model: string;
  promptVersion: string;
  claimsHash: string;
  /** the claim ids the kept sentences cite */
  claims: string[];
  offered: number; kept: number; replaced: number;
  rejected: { reason: string }[];
  withheld: Withheld[];
  cached: boolean;
  charge: number;
}

type Who = { userId: string | null; surveyId: string; customerId?: string | null };
type Auditor = (a: { action: "analytics.ai_text_generated" | "analytics.ai_refused"; userId: string | null; surveyId: string | null; customerId?: string | null; entity: string; entityId: string | null; detail: Record<string, unknown> }) => Promise<void>;
let auditor: Auditor | null = null;
/** the tests record into a list instead of the database */
export function setAiAuditor(a: Auditor | null): void { auditor = a; }
async function write(a: Parameters<Auditor>[0]): Promise<void> {
  if (a.surveyId === "sandbox" || !a.surveyId) return;
  try { await (auditor ?? (await import("./guard")).audit)(a as never); } catch { /* an audit that cannot be written must not fail the action it describes */ }
}

export const recordAiText = (who: Who, r: AiTextRecord): Promise<void> => write({
  action: "analytics.ai_text_generated", userId: who.userId, surveyId: who.surveyId, customerId: who.customerId ?? null, entity: "analytics", entityId: r.claimsHash,
  detail: { operation: r.operation, model: r.model, promptVersion: r.promptVersion, claimsHash: r.claimsHash, claims: r.claims, offered: r.offered, kept: r.kept, replaced: r.replaced, rejected: r.rejected.slice(0, 10), withheld: r.withheld.slice(0, 20), cached: r.cached, charge: r.charge },
});
export const recordAiRefused = (who: Who, operation: string, why: string): Promise<void> => write({
  action: "analytics.ai_refused", userId: who.userId, surveyId: who.surveyId, customerId: who.customerId ?? null, entity: "analytics", entityId: null, detail: { operation, why },
});
