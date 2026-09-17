import type { Question } from "@rescript/schema";
import type { FlagDraft, RuleContext } from "../types.js";
import { fnv1a, isDiagonal, normalizedEntropy, pct, repeatingPeriod } from "../metrics.js";
import { isMatrix, midpointIndex, optionIndex, rowPolarities } from "../survey.js";

/** Row → column index for a grid answer, in row order; null where unanswered. */
export function gridPositions(q: Question, answer: unknown): (number | null)[] {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return q.rows.map(() => null);
  const a = answer as Record<string, unknown>;
  return q.rows.map((r) => (a[String(r.code)] === undefined || a[String(r.code)] === null ? null : optionIndex(q, a[String(r.code)])));
}

/** Stable signature of a grid answer: row codes → column codes, for cross-respondent comparison. */
export function matrixSignature(q: Question, answer: unknown): string | null {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const a = answer as Record<string, unknown>;
  const parts = q.rows.map((r) => `${r.code}=${a[String(r.code)] ?? ""}`);
  if (parts.every((p) => p.endsWith("="))) return null;
  return fnv1a(parts.join("|"));
}

export function matrixRules(ctx: RuleContext): FlagDraft[] {
  const out: FlagDraft[] = [];
  const grids = ctx.def.questions.filter((q) => isMatrix(q) && ctx.response.answers[q.id] !== undefined);
  if (!grids.length) return out;

  const label = (q: Question) => q.code;
  const straight: string[] = [];
  const reverse: string[] = [];
  const diagonal: string[] = [];
  const alternating: string[] = [];
  let midRows = 0, extremeRows = 0, scaleRows = 0;
  const allPositions: number[] = [];
  const allCats: number[] = [];

  for (const q of grids) {
    const pos = gridPositions(q, ctx.response.answers[q.id]);
    const answered = pos.filter((p): p is number => p !== null);
    if (answered.length < 3) continue;
    allPositions.push(...answered);
    allCats.push(q.options.length);

    /* straight-lining */
    if (ctx.enabled("matrix.straightline") && ctx.applies("matrix.straightline", q.id) && answered.length >= ctx.param<number>("matrix.straightline", "minRows")) {
      const counts = new Map<number, number>();
      for (const p of answered) counts.set(p, (counts.get(p) ?? 0) + 1);
      const top = Math.max(...counts.values()) / answered.length;
      if (top >= ctx.param<number>("matrix.straightline", "sameShare")) {
        straight.push(q.id);
        // reverse-worded rows make one column insincere
        const pol = rowPolarities(q);
        if (pol.includes(-1) && pol.includes(1) && ctx.enabled("matrix.reverse_straightline")) reverse.push(q.id);
      }
    }

    /* diagonal */
    if (ctx.enabled("matrix.diagonal") && answered.length >= ctx.param<number>("matrix.diagonal", "minRows") && answered.length === pos.length && isDiagonal(answered)) diagonal.push(q.id);

    /* alternating / repeating */
    /*
     * A CYCLE THE WORDING EXPLAINS IS AN ATTITUDE, NOT A MECHANISM. A grid
     * whose third and sixth rows are reverse-worded is answered 5,5,2,5,5,2
     * by someone who likes their car — a period-3 cycle to the detector and a
     * perfectly consistent opinion to a person. The pattern is judged after
     * folding reverse-worded rows onto the same polarity; a cycle that
     * survives that is mechanical.
     */
    if (ctx.enabled("matrix.alternating") && answered.length >= ctx.param<number>("matrix.alternating", "minRows") && repeatingPeriod(answered) !== null) {
      const pol = rowPolarities(q);
      const cats = q.options.length;
      const folded = pos.map((p, i) => (p === null ? null : pol[i] === -1 ? cats - 1 - p : p)).filter((p): p is number => p !== null);
      const foldedFlat = new Set(folded).size <= 2 && Math.max(...folded) - Math.min(...folded) <= 1;
      if (!foldedFlat) alternating.push(q.id);
    }

    /* midpoint / extremes */
    const mid = midpointIndex(q);
    if (q.options.length >= 4) {
      scaleRows += answered.length;
      if (mid !== null) midRows += answered.filter((p) => p === mid).length;
      extremeRows += answered.filter((p) => p === 0 || p === q.options.length - 1).length;
    }
  }

  const gridsJudged = grids.length;
  if (straight.length && straight.length / gridsJudged >= ctx.param<number>("matrix.straightline", "gridShare")) {
    out.push({
      ruleId: "matrix.straightline",
      observed: `${straight.length} of ${gridsJudged} grids straight-lined (${straight.map((id) => label(ctx.def.questions.find((q) => q.id === id)!)).join(", ")})`,
      expected: `fewer than ${pct(ctx.param<number>("matrix.straightline", "gridShare"))} of grids`,
      explanation: "The same column was chosen for almost every row of the grid.",
      questionIds: straight,
      intensity: Math.min(1, 0.6 + (straight.length / gridsJudged) * 0.5),
    });
  }
  if (reverse.length) {
    out.push({
      ruleId: "matrix.reverse_straightline",
      observed: `${reverse.length} grid${reverse.length === 1 ? "" : "s"} with reverse-worded rows straight-lined`,
      explanation: "One column cannot be a sincere answer to both a positively and a negatively worded row.",
      questionIds: reverse,
    });
  }
  if (diagonal.length) {
    out.push({
      ruleId: "matrix.diagonal",
      observed: `${diagonal.length} grid${diagonal.length === 1 ? "" : "s"} answered in a strict column sequence`,
      explanation: "Columns were chosen in a straight diagonal down the grid (1, 2, 3, 4 …).",
      questionIds: diagonal,
    });
  }
  if (alternating.length) {
    out.push({
      ruleId: "matrix.alternating",
      observed: `${alternating.length} grid${alternating.length === 1 ? "" : "s"} with a short repeating cycle of columns`,
      explanation: "The rows were answered in a mechanical a-b-a-b (or a-b-c-a-b-c) cycle.",
      questionIds: alternating,
    });
  }

  /* low variance across all grids */
  if (ctx.enabled("matrix.low_variance") && allPositions.length >= 8 && !straight.length) {
    const cats = Math.max(...allCats);
    const e = normalizedEntropy(allPositions, cats);
    const maxE = ctx.param<number>("matrix.low_variance", "maxEntropy");
    if (e < maxE) {
      out.push({
        ruleId: "matrix.low_variance",
        observed: `normalised entropy of grid answers ${Math.round(e * 100) / 100} across ${allPositions.length} rows`,
        expected: `≥ ${maxE}`,
        explanation: "Answers across the grids barely vary — not a straight line, but nearly.",
        questionIds: grids.map((q) => q.id),
      });
    }
  }

  if (scaleRows >= 8) {
    if (ctx.enabled("matrix.midpoint")) {
      const share = midRows / scaleRows;
      const thr = ctx.param<number>("matrix.midpoint", "share");
      if (share > thr) out.push({ ruleId: "matrix.midpoint", observed: `${pct(share)} of ${scaleRows} grid rows on the midpoint`, expected: `≤ ${pct(thr)}`, explanation: "The neutral scale point was chosen for most rows.", questionIds: grids.map((q) => q.id) });
    }
    if (ctx.enabled("matrix.extremes")) {
      const share = extremeRows / scaleRows;
      const thr = ctx.param<number>("matrix.extremes", "share");
      if (share > thr) out.push({ ruleId: "matrix.extremes", observed: `${pct(share)} of ${scaleRows} grid rows on an end point`, expected: `≤ ${pct(thr)}`, explanation: "Only the end points of the scales were used.", questionIds: grids.map((q) => q.id) });
    }
  }

  /* identical signature across respondents */
  if (ctx.enabled("matrix.signature_match") && ctx.peers.length) {
    const minRows = ctx.param<number>("matrix.signature_match", "minRows");
    const hits: { q: Question; peers: string[]; confidence: number }[] = [];
    for (const q of grids) {
      if (q.rows.length < minRows) continue;
      const sig = matrixSignature(q, ctx.response.answers[q.id]);
      if (!sig) continue;
      // a straight line matches trivially and is reported by its own rule
      const pos = gridPositions(q, ctx.response.answers[q.id]).filter((p) => p !== null);
      if (new Set(pos).size <= 1) continue;
      const same = ctx.peers.filter((p) => p.sessionId !== ctx.response.sessionId && p.system?.SYSTEM_MATRIX_SIGNATURE?.[q.id] === sig).map((p) => p.sessionId);
      /*
       * A POPULAR PATTERN IS A POPULAR OPINION. On a five-row, five-point
       * grid, "agree with everything good, disagree with the bad row" is held
       * by many sincere people. A match counts only when the shared signature
       * is RARE among peers — held by at most `rareShare` of them (2%) — and
       * never when the grid has too few rows to make a coincidence unlikely.
       */
      if (!same.length) continue;
      /*
       * HOW MANY TWINS WOULD CHANCE PRODUCE? Each row's option has a frequency
       * among the peers who answered this grid; the chance a random peer
       * matches this whole grid is the product of those, and that times the
       * number of peers is the number of identical grids to EXPECT from
       * like-minded people alone. When that is a fraction of one, a match is
       * evidence; when it is one or more, a match is a popular opinion.
       */
      const peerPositions = ctx.peers
        .filter((p) => p.sessionId !== ctx.response.sessionId && p.answers?.[q.id])
        .map((p) => gridPositions(q, p.answers[q.id]));
      if (peerPositions.length >= 10) {
        let pMatch = 1;
        pos.forEach((mine, row) => {
          const answered = peerPositions.map((pp) => pp[row]).filter((x): x is number => x !== null);
          if (!answered.length) return;
          const f = answered.filter((x) => x === mine).length / answered.length;
          pMatch *= Math.max(0.01, f);
        });
        const expectedTwins = pMatch * peerPositions.length;
        /*
         * A 5-row, 5-point grid has 3,125 patterns; among two hundred people
         * somebody's grid has a twin by chance almost surely. Below a 0.5%
         * chance of a twin the match is full evidence; up to 2% it is half;
         * beyond that it is a coincidence the population size predicts.
         */
        if (expectedTwins >= 0.02) continue;
        hits.push({ q, peers: same, confidence: expectedTwins >= 0.005 ? 0.5 : 1 });
        continue;
      } else if (same.length > 1) continue;
      hits.push({ q, peers: same, confidence: 0.5 });
    }
    if (hits.length) {
      const related = [...new Set(hits.flatMap((h) => h.peers))];
      out.push({
        ruleId: "matrix.signature_match",
        observed: hits.map((h) => `${h.q.code} identical to ${h.peers.length} other${h.peers.length === 1 ? "" : "s"}`).join("; "),
        explanation: "A grid was answered exactly like another respondent's, row for row.",
        questionIds: hits.map((h) => h.q.id),
        relatedSessionIds: related.slice(0, 10),
        intensity: Math.min(1, 0.6 + hits.length * 0.2),
        confidence: Math.max(...hits.map((h) => h.confidence)),
        caveat: hits.every((h) => h.confidence < 1) ? "a grid this size has a twin by chance in a population this large" : undefined,
      });
    }
  }

  return out;
}
