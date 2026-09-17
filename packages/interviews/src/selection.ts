import { hashString, mulberry32 } from "@rescript/engine";
/**
 * DRAWING ONE CANDIDATE'S QUESTIONS — REPRODUCIBLY.
 *
 * §8 asks that the exact sequence a completed interview used be reproducible
 * for audit. There are two ways to do that and only one of them works.
 *
 * The obvious one is to store a seed and re-run the draw. It is reproducible
 * right up until somebody edits the pool — adds a question, archives another,
 * reorders them — and then the same seed produces a different sequence and the
 * audit record quietly becomes fiction. Nobody notices, because the two runs
 * were never compared; the record is simply wrong from the day of the edit.
 *
 * So the draw is performed ONCE, at the moment the interview starts, and the
 * result is written to `interviews.question_sequence` and never recomputed.
 * The seed is stored beside it so the draw can be EXPLAINED as well as
 * replayed — `explainDraw` re-runs it against a given pool state and says
 * whether that state still produces the recorded answer. When it does not,
 * that is information, not a failure: it means the bank changed after this
 * candidate sat, which is exactly what an auditor wants to be told.
 *
 * ## The generator
 *
 * A 128-bit seed through xoshiro-style mixing, not `Math.random`. Three
 * properties matter and none of them is cryptographic:
 *
 *  · the same seed gives the same sequence on every machine and every Node
 *    version, which `Math.random` does not promise at all;
 *  · consecutive seeds give unrelated sequences, so two candidates invited a
 *    millisecond apart do not get near-identical draws;
 *  · it is deterministic in a test.
 *
 * Nothing here is a security boundary. The candidate never sees the seed, and
 * predicting a question order gains nothing that reading the question bank
 * would not.
 */

/* --------------------------------------------------------------- random */

/**
 * THE ENGINE'S GENERATOR, NOT A SECOND ONE.
 *
 * This file used to carry its own xoshiro128** and its own FNV seed-mixing.
 * `packages/engine/src/random.ts` already had a seeded generator, a string
 * hash and a Fisher–Yates that every survey randomization in the platform runs
 * on. Two RNGs in one repository is the actual duplication — not the draw
 * logic around them, which makes a decision the engine does not (record the
 * sequence once; explain it later). So the draw stays and the generator goes.
 *
 * Draws recorded before this change were made with the previous generator.
 * `explainDraw` will report those sequences as no longer reproducible from
 * their seed, which is the truth and is what `explainDraw` exists to say.
 */

/** A deterministic 0–1 generator. Same seed, same numbers, everywhere. */
export function seededRandom(seed: string): () => number {
  return mulberry32(hashString(seed));
}

/**
 * Fisher–Yates, with the generator supplied.
 *
 * Kept as a thin wrapper so the draw below can thread ONE generator through
 * several shuffles in sequence — pool order, then each pool's members — and
 * stay reproducible from one seed. `seededShuffle(items, seed)` reseeds per
 * call, which is the right shape for independent survey randomizations and
 * the wrong one for a single draw that has to be replayable as a whole.
 */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/* -------------------------------------------------------------- the draw */

export interface PoolSpec {
  id: string;
  code: string;
  /** How many to draw. `null` takes every question in the pool. */
  draw: number | null;
  /** Where this pool's block sits in the finished sequence. */
  position: number;
  /** Shuffle within the block. Off keeps the programmed order. */
  randomize?: boolean;
}

export interface QuestionSpec {
  id: string;
  code: string;
  poolId: string | null;
  position: number;
  required?: boolean;
}

export interface DrawnQuestion {
  questionId: string;
  code: string;
  poolId: string | null;
  /** 1-based, as the candidate experiences it. */
  position: number;
}

export interface DrawInput {
  pools: readonly PoolSpec[];
  questions: readonly QuestionSpec[];
  seed: string;
  /** Shuffle the pool BLOCKS as well as their contents. Off by default. */
  randomizePools?: boolean;
}

export class DrawError extends Error {}

/**
 * The sequence one candidate is asked.
 *
 * Pool blocks come out in their configured order; within a block, `draw` of
 * the pool's questions are taken. Questions belonging to no pool keep their
 * programmed position and are never shuffled — they are the fixed spine of
 * the interview (the introduction, the closing question), and a product that
 * randomised them would be surprising in a way nobody asked for.
 *
 * A pool asking for more questions than it holds gets all of them rather than
 * failing: an interview that will not start because somebody set `draw` to 8
 * on a pool of 7 is a worse outcome than an interview one question short, and
 * the shortfall is reported so the Studio can warn about it before anyone is
 * invited.
 */
export function drawSequence(input: DrawInput): {
  sequence: DrawnQuestion[];
  shortfalls: { poolCode: string; wanted: number; available: number }[];
} {
  if (!input.seed) throw new DrawError("A draw needs a seed, or it is not reproducible.");
  const random = seededRandom(input.seed);
  const shortfalls: { poolCode: string; wanted: number; available: number }[] = [];

  const byPool = new Map<string, QuestionSpec[]>();
  const loose: QuestionSpec[] = [];
  for (const q of [...input.questions].sort((a, b) => a.position - b.position)) {
    if (q.poolId) {
      const list = byPool.get(q.poolId) ?? [];
      list.push(q);
      byPool.set(q.poolId, list);
    } else {
      loose.push(q);
    }
  }

  let pools = [...input.pools].sort((a, b) => a.position - b.position);
  if (input.randomizePools) pools = shuffle(pools, random);

  const blocks: QuestionSpec[] = [];
  for (const pool of pools) {
    const available = byPool.get(pool.id) ?? [];
    const wanted = pool.draw == null ? available.length : Math.max(0, pool.draw);
    if (wanted > available.length) {
      shortfalls.push({ poolCode: pool.code, wanted, available: available.length });
    }
    const take = Math.min(wanted, available.length);
    if (take === 0) continue;
    /*
     * Shuffle ALWAYS when a subset is taken, even with `randomize` off:
     * "pick 7 of 30" with no shuffle means the same first seven for every
     * candidate, which is not a pool, it is a list with 23 unused rows. With
     * the whole pool taken, `randomize` decides whether the order moves.
     */
    const subset = take < available.length
      ? shuffle(available, random).slice(0, take)
      : (pool.randomize ? shuffle(available, random) : available);
    // a subset is presented in the bank's own order unless asked otherwise,
    // so a randomised SELECTION does not force a randomised PRESENTATION
    const ordered = take < available.length && !pool.randomize
      ? [...subset].sort((a, b) => a.position - b.position)
      : subset;
    blocks.push(...ordered);
  }

  /*
   * The loose questions are merged by their own position: a question at
   * position 0 opens the interview, one at position 999 closes it, and the
   * pool blocks fill the middle. This is what lets "introduce yourself" and
   * "anything you would like to add" bracket a randomised body.
   */
  const first = loose.filter((q) => q.position <= 0);
  const last = loose.filter((q) => q.position > 0);
  const all = [...first, ...blocks, ...last];

  return {
    sequence: all.map((q, i) => ({
      questionId: q.id, code: q.code, poolId: q.poolId, position: i + 1,
    })),
    shortfalls,
  };
}

/**
 * Does this pool state still produce the sequence that was recorded?
 *
 * The audit answer. `changed` is not an error — it means the question bank
 * was edited after this candidate sat, which is ordinary and worth knowing.
 * What would be an error is a product that could not tell the difference.
 */
export function explainDraw(recorded: readonly DrawnQuestion[], input: DrawInput): {
  matches: boolean;
  recomputed: DrawnQuestion[];
  /** Question codes in one and not the other, for a human-readable diff. */
  onlyRecorded: string[];
  onlyRecomputed: string[];
  reordered: boolean;
} {
  const { sequence } = drawSequence(input);
  const a = recorded.map((q) => q.questionId);
  const b = sequence.map((q) => q.questionId);
  const setA = new Set(a);
  const setB = new Set(b);
  const codeOf = new Map<string, string>();
  for (const q of [...recorded, ...sequence]) codeOf.set(q.questionId, q.code);
  const onlyRecorded = a.filter((id) => !setB.has(id)).map((id) => codeOf.get(id) ?? id);
  const onlyRecomputed = b.filter((id) => !setA.has(id)).map((id) => codeOf.get(id) ?? id);
  const sameMembers = onlyRecorded.length === 0 && onlyRecomputed.length === 0;
  return {
    matches: a.length === b.length && a.every((id, i) => id === b[i]),
    recomputed: sequence,
    onlyRecorded,
    onlyRecomputed,
    reordered: sameMembers && !a.every((id, i) => id === b[i]),
  };
}

/**
 * A seed for one sitting.
 *
 * The interview id is in it, so two candidates in the same project never draw
 * the same sequence by accident, and re-deriving it for an audit needs
 * nothing that is not already on the row.
 */
export function seedFor(interviewId: string, salt = ""): string {
  return `${interviewId}:${salt}`;
}
