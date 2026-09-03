import { seededShuffle } from "./random.js";

/**
 * Pairwise / tournament ranking — the pure algorithm.
 *
 * A respondent cannot hold ten items in their head at once, but they can
 * always answer "which of these two?". Binary-insertion sort turns that one
 * question into a full ranking in O(n log n) duels instead of the O(n²) a
 * round-robin would need, and — because a binary search never revisits a
 * range it has already excluded — no two items are ever put in front of the
 * respondent twice.
 *
 * The algorithm is a pure REPLAY of the duels answered so far: the renderer
 * keeps only the ordered list of outcomes (beside the answer, like
 * `<id>__other`), hands it back here, and gets the next duel plus the ranking
 * so far. That keeps the renderer stateless enough to survive a re-mount,
 * makes the whole thing unit-testable without a browser, and means the
 * inspector can reproduce exactly what a respondent was shown.
 */

export type TournamentCode = string | number;

/** One answered duel, recorded in the order it was answered. */
export interface TournamentDuel {
  /** the item being placed (the "challenger") */
  a: TournamentCode;
  /** the already-placed item it was compared against */
  b: TournamentCode;
  /** whichever of the two the respondent preferred */
  winner: TournamentCode;
}

export interface TournamentInput {
  /** the items to rank, in the order the option list gives them */
  codes: TournamentCode[];
  /**
   * Per-respondent seed for the presentation order (from `seedFor(p)` in the
   * runtime). Omit for the option list's own order — used by tests and by the
   * inspector when reproducing a session.
   */
  seed?: number;
  /** duels answered so far, oldest first */
  results?: TournamentDuel[];
  /**
   * Stop once the top N positions are settled: an item that has already lost
   * to N others cannot reach the top N, so it is placed without further
   * duels. Only the top N is stored.
   */
  topN?: number | null;
}

export interface TournamentStep {
  /** the seeded presentation order the duels are drawn from */
  order: TournamentCode[];
  /** best → worst, as far as the answered duels settle it */
  sorted: TournamentCode[];
  /** what to store as the answer: `sorted`, truncated to `topN` */
  ranking: TournamentCode[];
  /** the duel to ask next — `a` is the challenger, `b` the incumbent */
  duel: { a: TournamentCode; b: TournamentCode } | null;
  /** 1-based number of the duel in `duel` (or the count answered when done) */
  duelNumber: number;
  /** worst-case number of duels, for "Duel 4 of ~9" */
  estimatedDuels: number;
  done: boolean;
  /**
   * How many of `results` the replay consumed. Fewer than were passed in
   * means the rest are stale (the option list changed under them) and the
   * caller should drop them.
   */
  used: number;
}

const same = (a: TournamentCode, b: TournamentCode) => String(a) === String(b);

/** The seeded order the duels are drawn from — same seed, same first duel. */
export function tournamentOrder(codes: TournamentCode[], seed?: number): TournamentCode[] {
  return seed == null ? [...codes] : seededShuffle(codes, seed);
}

/**
 * Worst-case duel count: inserting into a sorted run of k items searches k+1
 * slots, so it costs ceil(log2(k+1)) comparisons. Bounded above by
 * n·ceil(log2 n), and much lower once `topN` caps the search window.
 */
export function estimateTournamentDuels(n: number, topN?: number | null): number {
  let total = 0;
  for (let k = 1; k < n; k++) {
    const slots = (topN != null && topN > 0 ? Math.min(k, topN) : k) + 1;
    total += Math.ceil(Math.log2(slots));
  }
  return total;
}

/**
 * Replay the answered duels and report the next one (or the finished
 * ranking). Pure: same input, same output.
 */
export function tournamentStep(input: TournamentInput): TournamentStep {
  const order = tournamentOrder(input.codes, input.seed);
  const results = input.results ?? [];
  const topN =
    input.topN != null && input.topN > 0 ? Math.min(Math.trunc(input.topN), order.length) : null;
  const estimatedDuels = estimateTournamentDuels(order.length, topN);
  const sorted: TournamentCode[] = [];
  let used = 0;

  const step = (duel: TournamentStep["duel"]): TournamentStep => ({
    order,
    sorted: [...sorted],
    ranking: topN == null ? [...sorted] : sorted.slice(0, topN),
    duel,
    duelNumber: used + 1,
    estimatedDuels,
    done: duel == null,
    used,
  });

  if (order.length === 0) return step(null);
  sorted.push(order[0]);

  for (let i = 1; i < order.length; i++) {
    const item = order[i];
    let lo = 0;
    // With a top-N cutoff the search window stops at slot N: converging there
    // means "worse than all N above", which is all we need to know.
    let hi = topN == null ? sorted.length : Math.min(sorted.length, topN);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const incumbent = sorted[mid];
      const r = results[used];
      // A recorded duel that no longer matches the pair we would ask (the
      // option list changed) is not usable — ask it again rather than
      // silently mis-ranking.
      if (!r || !same(r.a, item) || !same(r.b, incumbent)) {
        return step({ a: item, b: incumbent });
      }
      used++;
      if (same(r.winner, item)) hi = mid;
      else lo = mid + 1;
    }
    sorted.splice(lo, 0, item);
  }
  return step(null);
}
