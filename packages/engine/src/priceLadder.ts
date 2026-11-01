import type { Question } from "@rescript/schema";

/**
 * S5c item 2 — ADAPTIVE GABOR–GRANGER PRICE LADDER (audit SM-07), variant `numeric.price_ladder`.
 *
 * WHY A VARIANT AND NOT A LOOP. The engine's loops iterate a list fixed when the loop starts, one page per
 * iteration; an adaptive ladder's next price depends on the last answer and it stops at the first reversal.
 * As a loop that is a page per step plus skip / branch logic for every path (2^n paths for n prices), and n
 * variables of which most are empty by design. As a variant it is ONE numeric variable — the highest price the
 * respondent accepted (0 = none) — which the ordinary numeric bounds check, the analysis reads directly, and the
 * path is kept beside it as paradata. The step logic is here, pure, so the renderer, the server's check and the
 * tests share it.
 *
 *   ladderPrices(q)            the ladder ascending, deduplicated, positive
 *   ladderStartIndex(n, start, r)   middle (default; the lower middle for an even ladder), lowest, highest or random (r ∈ [0,1))
 *   ladderStep(state, accepted)     the next index, or done with the highest accepted price
 *   ladderAnswerValid(q, v)    0 or one of the ladder's prices
 *   ladderParadataKeys(code)   GG_<CODE>_START (first price shown) and GG_<CODE>_PATH ("20:1,25:0" — price:accepted)
 *   lintPriceLadder(q)         fewer than 3 prices, duplicates, bounds that cannot hold the answer
 *
 * The rule (Gabor & Granger's adaptive form): ask at the start price; after "yes" move one step UP, after "no"
 * one step DOWN; stop when the next price in that direction was already answered (the first boundary), or at
 * either end of the ladder. The answer is the highest accepted price — under the method's monotonicity
 * assumption the respondent would also buy at every lower price, and would not at any higher one asked.
 */
export type LadderStart = "middle" | "lowest" | "highest" | "random";
export interface LadderState { prices: number[]; index: number; answers: { price: number; accepted: boolean }[]; done: boolean; highest: number }

export function ladderPrices(q: Pick<Question, "settings">): number[] {
  const raw = (q.settings as { priceLadder?: { prices?: unknown[] } }).priceLadder?.prices ?? [];
  return [...new Set(raw.map(Number).filter((p) => Number.isFinite(p) && p > 0))].sort((a, b) => a - b);
}

export function ladderStartIndex(n: number, start: LadderStart = "middle", r = 0): number {
  if (n <= 0) return 0;
  switch (start) {
    case "lowest": return 0;
    case "highest": return n - 1;
    case "random": return Math.min(n - 1, Math.max(0, Math.floor(r * n)));
    default: return Math.floor((n - 1) / 2);
  }
}

export function ladderInit(prices: number[], start: LadderStart = "middle", r = 0): LadderState {
  return { prices, index: ladderStartIndex(prices.length, start, r), answers: [], done: prices.length === 0, highest: 0 };
}

export function ladderStep(s: LadderState, accepted: boolean): LadderState {
  if (s.done) return s;
  const price = s.prices[s.index];
  const answers = [...s.answers, { price, accepted }];
  const highest = accepted ? Math.max(s.highest, price) : s.highest;
  const next = accepted ? s.index + 1 : s.index - 1;
  const asked = (i: number) => answers.some((a) => a.price === s.prices[i]);
  const done = next < 0 || next >= s.prices.length || asked(next);
  return { prices: s.prices, index: done ? s.index : next, answers, done, highest };
}

/** run a whole ladder against a respondent's true willingness to pay (who accepts every price ≤ wtp) — tests and the simulator */
export function ladderRun(prices: number[], wtp: number, start: LadderStart = "middle", r = 0): LadderState {
  let s = ladderInit(prices, start, r);
  for (let guard = 0; !s.done && guard < prices.length + 1; guard++) s = ladderStep(s, s.prices[s.index] <= wtp);
  return s;
}

export function ladderAnswerValid(q: Pick<Question, "settings">, v: unknown): boolean {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && (n === 0 || ladderPrices(q).includes(n));
}

export function ladderParadataKeys(code: string): { start: string; path: string } {
  const c = code.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
  return { start: `GG_${c}_START`, path: `GG_${c}_PATH` };
}
export const ladderPathText = (answers: LadderState["answers"]): string => answers.map((a) => `${a.price}:${a.accepted ? 1 : 0}`).join(",");

export function lintPriceLadder(q: Question): string[] {
  const out: string[] = [];
  const raw = ((q.settings as { priceLadder?: { prices?: unknown[] } }).priceLadder?.prices ?? []).map(Number);
  const prices = ladderPrices(q);
  if (prices.length < 3) out.push(`${q.code}: a price ladder needs at least three prices (${prices.length} given)`);
  if (raw.length !== new Set(raw).size) out.push(`${q.code}: two ladder prices are the same`);
  if (raw.some((p) => !(p > 0))) out.push(`${q.code}: every ladder price must be a positive number`);
  const min = q.settings.minValue, max = q.settings.maxValue;
  if (min != null && min > 0) out.push(`${q.code}: minValue must be 0 — 0 is the answer of a respondent who accepts no price`);
  if (max != null && prices.length && max < prices[prices.length - 1]) out.push(`${q.code}: maxValue ${max} is below the top ladder price ${prices[prices.length - 1]}`);
  return out;
}
