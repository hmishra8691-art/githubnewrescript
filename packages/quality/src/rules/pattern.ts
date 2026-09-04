import type { Question } from "@rescript/schema";
import type { FlagDraft, RuleContext } from "../types.js";
import { agreementPolarity, normalizedEntropy, pct, repeatingPeriod } from "../metrics.js";
import { isMulti, isNonSubstantive, isScale, isSingle, midpointIndex, optionIndex, orderedIds } from "../survey.js";
import { gridPositions } from "./matrix.js";
import { isMatrix } from "../survey.js";

/**
 * Response-pattern intelligence across the whole questionnaire — the
 * respondent's habit rather than any one question.
 */
export function patternRules(ctx: RuleContext): FlagDraft[] {
  const out: FlagDraft[] = [];
  const { def } = ctx;
  const a = ctx.response.answers;
  const order = orderedIds(def);
  const byId = new Map(def.questions.map((q) => [q.id, q]));

  // chosen option positions for single-choice questions, in survey order
  const singles: { q: Question; pos: number }[] = [];
  for (const id of order) {
    const q = byId.get(id);
    if (!q || !isSingle(q) || a[id] === undefined || a[id] === null) continue;
    const pos = optionIndex(q, a[id]);
    if (pos !== null) singles.push({ q, pos });
  }

  /* low entropy of positions */
  if (ctx.enabled("pattern.low_entropy")) {
    const minQ = ctx.param<number>("pattern.low_entropy", "minQuestions");
    const maxE = ctx.param<number>("pattern.low_entropy", "maxEntropy");
    if (singles.length >= minQ) {
      const cats = Math.max(...singles.map((s) => s.q.options.length));
      const e = normalizedEntropy(singles.map((s) => s.pos), Math.min(cats, 10));
      if (e < maxE) {
        const counts = new Map<number, number>();
        for (const s of singles) counts.set(s.pos, (counts.get(s.pos) ?? 0) + 1);
        const [topPos, topN] = [...counts.entries()].sort((x, y) => y[1] - x[1])[0];
        out.push({
          ruleId: "pattern.low_entropy",
          observed: `option position ${topPos + 1} chosen on ${topN} of ${singles.length} single-choice questions (entropy ${Math.round(e * 100) / 100})`,
          expected: `normalised entropy ≥ ${maxE}`,
          explanation: "The same option position was chosen far more often than chance across unrelated questions.",
          questionIds: singles.map((s) => s.q.id),
          intensity: Math.min(1, 0.6 + (maxE - e)),
        });
      }
    }
  }

  /* random pattern: maximal entropy plus incoherent grids */
  if (ctx.enabled("pattern.high_entropy") && singles.length >= 8) {
    const minE = ctx.param<number>("pattern.high_entropy", "minEntropy");
    const cats = Math.min(...singles.map((s) => s.q.options.length));
    const e = normalizedEntropy(singles.map((s) => s.pos), cats);
    // incoherence: within grids of a scale, adjacent rows disagree by ≥ half the scale most of the time
    let jumps = 0, pairs = 0;
    for (const q of def.questions) {
      if (!isMatrix(q) || a[q.id] === undefined) continue;
      const pos = gridPositions(q, a[q.id]).filter((p): p is number => p !== null);
      for (let i = 1; i < pos.length; i++) { pairs++; if (Math.abs(pos[i] - pos[i - 1]) >= Math.max(2, q.options.length / 2)) jumps++; }
    }
    const incoherent = pairs >= 6 && jumps / pairs > 0.6;
    if (e >= minE && (incoherent || pairs < 6) && cats >= 4) {
      out.push({
        ruleId: "pattern.high_entropy",
        observed: `entropy ${Math.round(e * 100) / 100} across ${singles.length} questions${pairs ? `; ${pct(jumps / pairs)} of adjacent grid rows jump ≥ half the scale` : ""}`,
        explanation: "Answers are spread as if drawn at random, with no consistency between related items.",
        questionIds: singles.map((s) => s.q.id),
      });
    }
  }

  /* non-substantive share */
  if (ctx.enabled("pattern.nonsubstantive")) {
    let offered = 0, taken = 0;
    const hit: string[] = [];
    for (const q of def.questions) {
      if (!(isSingle(q) || isMulti(q)) || a[q.id] === undefined || a[q.id] === null) continue;
      const ns = q.options.filter(isNonSubstantive);
      if (!ns.length) continue;
      offered++;
      const vals = Array.isArray(a[q.id]) ? (a[q.id] as unknown[]) : [a[q.id]];
      if (vals.some((v) => ns.some((o) => String(o.code) === String(v)))) { taken++; hit.push(q.id); }
    }
    const minOffered = ctx.param<number>("pattern.nonsubstantive", "minOffered");
    const share = ctx.param<number>("pattern.nonsubstantive", "share");
    if (offered >= minOffered && taken / offered > share) {
      out.push({
        ruleId: "pattern.nonsubstantive",
        observed: `Don't know / Other / Prefer not to say on ${taken} of ${offered} questions that offered them`,
        expected: `≤ ${pct(share)}`,
        explanation: "Non-substantive options were chosen wherever they were available.",
        questionIds: hit,
      });
    }
  }

  /* middle / extreme bias across scale singles */
  const scaleSingles = singles.filter((s) => isScale(s.q) && s.q.options.length >= 4);
  if (scaleSingles.length >= 5) {
    if (ctx.enabled("pattern.middle_bias")) {
      const mids = scaleSingles.filter((s) => midpointIndex(s.q) === s.pos).length;
      const withMid = scaleSingles.filter((s) => midpointIndex(s.q) !== null).length;
      const thr = ctx.param<number>("pattern.middle_bias", "share");
      if (withMid >= 5 && mids / withMid > thr) out.push({ ruleId: "pattern.middle_bias", observed: `${mids} of ${withMid} scale questions on the midpoint`, expected: `≤ ${pct(thr)}`, explanation: "The midpoint was chosen on nearly every scale.", questionIds: scaleSingles.map((s) => s.q.id) });
    }
    if (ctx.enabled("pattern.extreme_bias")) {
      const ext = scaleSingles.filter((s) => s.pos === 0 || s.pos === s.q.options.length - 1).length;
      const thr = ctx.param<number>("pattern.extreme_bias", "share");
      if (ext / scaleSingles.length > thr) out.push({ ruleId: "pattern.extreme_bias", observed: `${ext} of ${scaleSingles.length} scale questions on an end point`, expected: `≤ ${pct(thr)}`, explanation: "Only the end points of scales were chosen.", questionIds: scaleSingles.map((s) => s.q.id) });
    }
  }

  /* acquiescence: agree-polarity items including grid rows */
  if (ctx.enabled("pattern.acquiescence")) {
    let pos = 0, neg = 0;
    const ids: string[] = [];
    const tally = (q: Question, code: unknown) => {
      const o = q.options.find((x) => String(x.code) === String(code));
      if (!o) return;
      const pol = agreementPolarity(o.label);
      if (pol === 1) pos++; else if (pol === -1) neg++;
      if (pol !== 0) ids.push(q.id);
    };
    for (const q of def.questions) {
      if (a[q.id] === undefined || a[q.id] === null) continue;
      if (isSingle(q) && q.options.some((o) => agreementPolarity(o.label) !== 0)) tally(q, a[q.id]);
      if (isMatrix(q) && q.options.some((o) => agreementPolarity(o.label) !== 0)) {
        const row = a[q.id] as Record<string, unknown>;
        for (const v of Object.values(row)) tally(q, v);
      }
    }
    const items = pos + neg;
    const minItems = ctx.param<number>("pattern.acquiescence", "minItems");
    const thr = ctx.param<number>("pattern.acquiescence", "share");
    if (items >= minItems) {
      const share = Math.max(pos, neg) / items;
      if (share > thr) {
        out.push({
          ruleId: "pattern.acquiescence",
          observed: `${pos >= neg ? "agreement" : "disagreement"} on ${Math.max(pos, neg)} of ${items} agree-type items`,
          expected: `≤ ${pct(thr)} one polarity`,
          explanation: pos >= neg ? "Agreed with nearly every statement regardless of wording." : "Disagreed with nearly every statement regardless of wording.",
          questionIds: [...new Set(ids)],
        });
      }
    }
  }

  /* mechanical alternation across consecutive single-choice questions */
  if (ctx.enabled("pattern.mechanical")) {
    const minQ = ctx.param<number>("pattern.mechanical", "minQuestions");
    // judged on the scale-type questions (same option count), where a cycle is meaningful
    const pool = scaleSingles.length >= minQ ? scaleSingles : singles;
    if (pool.length >= minQ) {
      const seq = pool.map((s) => s.pos);
      const period = repeatingPeriod(seq);
      if (period !== null) {
        out.push({
          ruleId: "pattern.mechanical",
          observed: `option positions repeat with period ${period} across ${pool.length} consecutive questions`,
          explanation: "Answers cycle mechanically through option positions regardless of the question.",
          questionIds: pool.map((s) => s.q.id),
        });
      }
    }
  }

  /* rare-option abuse vs peers */
  if (ctx.enabled("pattern.rare_options") && ctx.peers.length >= 30) {
    const peerShare = ctx.param<number>("pattern.rare_options", "peerShare");
    const needed = ctx.param<number>("pattern.rare_options", "count");
    let rare = 0;
    const ids: string[] = [];
    for (const s of singles) {
      const n = ctx.peers.filter((p) => p.answers[s.q.id] !== undefined).length;
      if (n < 30) continue;
      const same = ctx.peers.filter((p) => String(p.answers[s.q.id]) === String(a[s.q.id])).length;
      if (same / n < peerShare) { rare++; ids.push(s.q.id); }
    }
    if (rare >= needed) {
      out.push({
        ruleId: "pattern.rare_options",
        observed: `${rare} options chosen that fewer than ${pct(peerShare)} of other respondents chose`,
        expected: `< ${needed}`,
        explanation: "Repeatedly chose options almost nobody else chooses.",
        questionIds: ids,
      });
    }
  }

  return out;
}
