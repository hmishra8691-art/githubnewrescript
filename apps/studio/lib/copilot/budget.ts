/**
 * THE OUTPUT BUDGET OF INTELLIGENT MODE (Research Engine audit, Phase 7).
 *
 * Intelligent mode does not ration the answer: a questionnaire of sixty
 * questions, a review of every block, a narrative that covers every finding
 * must come back whole, and the right answer matters more than the tokens
 * it takes. So every model call in Intelligent mode asks the provider for
 * the CEILING — `AI_MAX_OUTPUT_TOKENS`, 32 000 by default (a provider that
 * allows less lowers it, see `completeJson`) — continues a cut-off answer
 * up to eight times, and waits as long as the provider is given.
 *
 * What is RESERVED from the wallet is not the ceiling: a reservation at
 * 32 000 output tokens would refuse a researcher with a modest balance for
 * a one-line edit. The reservation is the EXPECTED size of that kind of
 * call (what the old budgets were), and the meter settles with what the
 * provider actually reported — more when the answer was longer, less when
 * it was shorter. The ceiling bounds nothing but the provider's own cap.
 */
export type BudgetKind = "edit" | "review" | "ux" | "generate" | "plan" | "item" | "repair" | "coverage" | "narrative" | "summary";

export interface OutputBudget {
  /** what the provider is asked for — the ceiling */
  maxTokens: number;
  /** what the wallet is asked to hold — the expected size of this kind of answer */
  expectedTokens: number;
  /** how many times a cut-off answer is continued */
  continuations: number;
  /** how long the provider is given, in milliseconds */
  timeoutMs: number;
}

export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;
/** the expected size per kind — the reservation, and the cost preview */
const EXPECTED: Record<BudgetKind, number> = { edit: 2500, review: 3000, ux: 3500, generate: 8000, plan: 2000, item: 4000, repair: 2500, coverage: 8000, narrative: 1200, summary: 1800 };
/** the wait per kind: generation and anything that builds a questionnaire get the provider's full five minutes */
const TIMEOUT: Record<BudgetKind, number> = { edit: 180_000, review: 180_000, ux: 180_000, generate: 300_000, plan: 180_000, item: 300_000, repair: 180_000, coverage: 300_000, narrative: 120_000, summary: 180_000 };

/** the configured ceiling: AI_MAX_OUTPUT_TOKENS, or the default; never below the expected size of the largest call */
export function maxOutputTokens(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.AI_MAX_OUTPUT_TOKENS ?? "").trim();
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.max(8000, Math.min(1_000_000, Math.round(n)));
}

export function outputBudget(kind: BudgetKind, env: Record<string, string | undefined> = process.env): OutputBudget {
  const ceiling = maxOutputTokens(env);
  return { maxTokens: Math.max(ceiling, EXPECTED[kind]), expectedTokens: EXPECTED[kind], continuations: 8, timeoutMs: TIMEOUT[kind] };
}
