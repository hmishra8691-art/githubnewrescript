import type { Question, SurveyDefinition } from "@rescript/schema";
import type { ResponseState } from "./state.js";

/**
 * S5c item 4 — IAT D-SCORE (audit SM-18): Greenwald, Nosek & Banaji (2003), the improved scoring algorithm, D600
 * form (the reaction-time variant records the first response to each stimulus, with no forced correction, so
 * errors get the built-in 600 ms penalty).
 *
 * The four combined blocks are four `experimental.reaction_time` questions, each tagged with its role and its
 * answer key in `settings.iatBlock` — B3 compatible practice, B4 compatible test, B6 incompatible practice, B7
 * incompatible test. A trial = one stimulus row: its latency is `<id>__rt[row]` (ms), it is correct when the
 * chosen category equals the key's code for that row.
 *
 *   1  use B3, B4, B6, B7 (any pair present: practice B3/B6, test B4/B7)
 *   2  drop trials with latency > 10,000 ms
 *   3  exclude the respondent (D = null) when more than 10 % of the remaining trials are faster than 300 ms
 *   4  inclusive SD of ALL remaining latencies of B3+B6, and of B4+B7 (sample SD, errors at their own latency)
 *   5  mean latency of the CORRECT trials of each block
 *   6  replace each error latency with its block's correct mean + 600 ms
 *   7  mean of the resulting latencies per block
 *   8  (mean B6 − mean B3) / SD(B3+B6) and (mean B7 − mean B4) / SD(B4+B7)
 *   9  D = the equal-weight mean of the ratios available
 * Positive D: faster on the compatible pairing. Computed by the engine after the calculations (flow.ts), so the
 * Runner and the server replay write the same IAT_D / IAT_TRIALS / IAT_FAST_SHARE / IAT_EXCLUDED.
 */
export type IatRole = "compatible_practice" | "compatible_test" | "incompatible_practice" | "incompatible_test";
export interface IatTrial { rt: number; correct: boolean }
export interface IatDResult { d: number | null; dPractice: number | null; dTest: number | null; trials: number; slowDropped: number; fastShare: number; excluded: boolean }

export const IAT_VARIABLES = ["IAT_D", "IAT_TRIALS", "IAT_FAST_SHARE", "IAT_EXCLUDED"] as const;
const SLOW_MS = 10_000, FAST_MS = 300, FAST_SHARE = 0.1, PENALTY_MS = 600;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function sd(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((t, x) => t + (x - m) ** 2, 0) / (xs.length - 1));
}

export function iatDScore(blocks: Partial<Record<IatRole, IatTrial[]>>): IatDResult {
  let slowDropped = 0;
  const kept: Partial<Record<IatRole, IatTrial[]>> = {};
  for (const [role, trials] of Object.entries(blocks) as [IatRole, IatTrial[]][]) {
    kept[role] = trials.filter((t) => { const ok = Number.isFinite(t.rt) && t.rt > 0 && t.rt <= SLOW_MS; if (!ok) slowDropped++; return ok; });
  }
  const all = Object.values(kept).flat() as IatTrial[];
  const fastShare = all.length ? all.filter((t) => t.rt < FAST_MS).length / all.length : 0;
  const base = { trials: all.length, slowDropped, fastShare };
  if (fastShare > FAST_SHARE) return { d: null, dPractice: null, dTest: null, excluded: true, ...base };
  const blockMean = (trials: IatTrial[] | undefined): number | null => {
    if (!trials?.length) return null;
    const cm = mean(trials.filter((t) => t.correct).map((t) => t.rt));
    if (cm == null) return null;               // no correct trial: the block cannot be scored
    return mean(trials.map((t) => (t.correct ? t.rt : cm + PENALTY_MS)));
  };
  const ratio = (comp: IatRole, inc: IatRole): number | null => {
    const a = kept[comp], b = kept[inc];
    if (!a?.length || !b?.length) return null;
    const s = sd([...a, ...b].map((t) => t.rt));
    const ma = blockMean(a), mb = blockMean(b);
    if (s == null || s === 0 || ma == null || mb == null) return null;
    return (mb - ma) / s;
  };
  const dPractice = ratio("compatible_practice", "incompatible_practice");
  const dTest = ratio("compatible_test", "incompatible_test");
  const parts = [dPractice, dTest].filter((x): x is number => x != null);
  return { d: parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null, dPractice, dTest, excluded: false, ...base };
}

type IatBlockSettings = { role?: IatRole; key?: Record<string, string | number> };
export const iatBlockOf = (q: Pick<Question, "settings">): IatBlockSettings | undefined => (q.settings as { iatBlock?: IatBlockSettings }).iatBlock;
export const hasIatBlocks = (def: SurveyDefinition): boolean => def.questions.some((q) => !!iatBlockOf(q)?.role);

/** the trials of each tagged block from a response state */
export function iatTrialsFromState(def: SurveyDefinition, state: Pick<ResponseState, "answers">): Partial<Record<IatRole, IatTrial[]>> {
  const out: Partial<Record<IatRole, IatTrial[]>> = {};
  for (const q of def.questions) {
    const b = iatBlockOf(q);
    if (!b?.role) continue;
    const ans = (state.answers[q.id] ?? {}) as Record<string, unknown>;
    const rts = (state.answers[`${q.id}__rt`] ?? {}) as Record<string, unknown>;
    const trials: IatTrial[] = [];
    for (const row of q.rows ?? []) {
      const rc = String(row.code);
      const rt = Number(rts[rc]);
      if (ans[rc] == null || !Number.isFinite(rt)) continue;
      const want = b.key?.[rc];
      trials.push({ rt, correct: want == null ? true : String(ans[rc]) === String(want) });
    }
    (out[b.role] ??= []).push(...trials);
  }
  return out;
}

/** IAT_D, IAT_TRIALS, IAT_FAST_SHARE, IAT_EXCLUDED — {} until a tagged block has a trial */
export function iatVariables(def: SurveyDefinition, state: Pick<ResponseState, "answers">): Record<string, number | null> {
  const blocks = iatTrialsFromState(def, state);
  if (!Object.values(blocks).some((t) => t && t.length)) return {};
  const r = iatDScore(blocks);
  return { IAT_D: r.d == null ? null : Math.round(r.d * 10_000) / 10_000, IAT_TRIALS: r.trials, IAT_FAST_SHARE: Math.round(r.fastShare * 10_000) / 10_000, IAT_EXCLUDED: r.excluded ? 1 : 0 };
}
