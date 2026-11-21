import type { DimensionTrend, TrendPoint } from "./history.js";
import { OVERALL_ID } from "./history.js";
import type { ScorecardResult } from "./scorecard.js";

/**
 * WHAT A PERSON'S RESULTS SAY, IN A FEW SENTENCES (Respondent Intelligence Engine, phase 5, 2026-11-20).
 *
 * Written by FIXED RULES from the person's own figures — no model, no randomness: the same results always give
 * the same sentences, and every sentence can be traced to the numbers beside it (`basis`). The rules:
 *
 *   - a sentence states a fact about the scores (which is highest, what changed, a pattern in the changes, where
 *     the score sits in a group). It never gives a cause, never gives advice, never says what a score "means"
 *     about the person;
 *   - a change is only ever between like-for-like results (history.ts decided that);
 *   - a PATTERN needs evidence: three changes in a row the same way, or a latest change at least twice the
 *     person's usual one over four or more results;
 *   - a PROJECTION is arithmetic on at least four like results, always a RANGE, never shown when the results
 *     vary too much for the range to say anything — and it says it is not a prediction.
 *
 * The optional AI re-wording (the portal's) receives exactly these sentences and figures, and nothing else.
 */
export type InsightKind = "sustained" | "sudden" | "change" | "strongest" | "most_room" | "standing";
export interface Insight {
  kind: InsightKind;
  dimension: string;
  /** the direction for this score: better, worse, or neither */
  tone: "better" | "worse" | "neutral";
  text: string;
  /** the figures the sentence rests on */
  basis: Record<string, number | string>;
}

/** how a score sits in a group — the part of a comparison an insight may use */
export interface StandingFact { dimension: string; everyone: { n: number; below: number; above: number } | null }

const r1 = (n: number) => Math.round(n * 10) / 10;
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const like = (t: DimensionTrend): TrendPoint[] => t.points.filter((p) => p.comparable);

/** a pattern in a score's like-for-like changes: the same way three times running, or a latest change twice the usual */
export function detectPattern(t: DimensionTrend, minChange?: number): { kind: "sustained"; runs: number; direction: "up" | "down" } | { kind: "sudden"; latest: number; usual: number } | null {
  const pts = like(t);
  const deltas = pts.slice(1).map((p, i) => p.score - pts[i]!.score);
  const counts = (d: number) => (minChange !== undefined ? Math.abs(d) >= minChange : d !== 0);
  if (deltas.length >= 3) {
    let runs = 0;
    const sign = Math.sign(deltas.at(-1)!);
    for (let i = deltas.length - 1; i >= 0 && sign !== 0 && Math.sign(deltas[i]!) === sign && counts(deltas[i]!); i--) runs++;
    if (runs >= 3) return { kind: "sustained", runs, direction: sign > 0 ? "up" : "down" };
    const latest = Math.abs(deltas.at(-1)!);
    const usual = median(deltas.slice(0, -1).map(Math.abs));
    if (usual > 0 && latest >= 2 * usual && counts(deltas.at(-1)!)) return { kind: "sudden", latest: r1(latest), usual: r1(usual) };
  }
  return null;
}

const good = (d: { percent: number | null; higherIsBetter: boolean }) => (d.percent === null ? null : d.higherIsBetter ? d.percent : 100 - d.percent);
const of = (score: number, max: number | null) => `${r1(score)}${max !== null ? ` of ${r1(max)}` : ""}`;

/**
 * Up to `max` sentences, the most informative first: patterns, then the latest change, then the strongest score
 * and the one with most room, then standing in the group. Each score appears in at most two sentences.
 */
export function buildInsights(result: ScorecardResult, trends: DimensionTrend[] | null, standing: StandingFact[] | null, minChange: Record<string, number | undefined> = {}, max = 6): Insight[] {
  const out: Insight[] = [];
  const used = new Map<string, number>();
  const add = (i: Insight) => { if ((used.get(i.dimension) ?? 0) >= 2 || out.length >= max) return; used.set(i.dimension, (used.get(i.dimension) ?? 0) + 1); out.push(i); };
  const toneOf = (up: boolean, higherIsBetter: boolean): Insight["tone"] => (up === higherIsBetter ? "better" : "worse");

  for (const t of (trends ?? []).filter((x) => x.id !== OVERALL_ID)) {
    const p = detectPattern(t, minChange[t.id]);
    if (p?.kind === "sustained") add({ kind: "sustained", dimension: t.id, tone: toneOf(p.direction === "up", t.higherIsBetter), text: `${t.label} has moved ${p.direction} in each of your last ${p.runs + 1} results.`, basis: { results: p.runs + 1, direction: p.direction } });
    else if (p?.kind === "sudden") add({ kind: "sudden", dimension: t.id, tone: "neutral", text: `The latest change in ${t.label} (${p.latest}) is larger than your usual change between results (${p.usual}).`, basis: { latest: p.latest, usual: p.usual } });
  }
  for (const t of (trends ?? []).filter((x) => x.id !== OVERALL_ID && x.change && x.change.direction !== "same")) {
    const c = t.change!;
    add({ kind: "change", dimension: t.id, tone: c.direction === "better" ? "better" : "worse", text: `${t.label} is ${c.delta > 0 ? "up" : "down"} ${r1(Math.abs(c.delta))} since your previous result (from ${r1(c.from)} to ${r1(c.to)}).`, basis: { from: c.from, to: c.to, delta: c.delta } });
  }

  const scored = result.dimensions.filter((d) => d.score !== null && good(d) !== null);
  if (scored.length >= 2) {
    const ranked = [...scored].sort((a, b) => good(b)! - good(a)!);
    const top = ranked[0]!, low = ranked.at(-1)!;
    /* only said when the two really differ: ten points of the scale */
    if (good(top)! - good(low)! >= 10) {
      add({ kind: "strongest", dimension: top.id, tone: "neutral", text: `Of your scores, ${top.label} is the strongest (${of(top.score!, top.max)}).`, basis: { score: top.score!, position: r1(good(top)!) } });
      add({ kind: "most_room", dimension: low.id, tone: "neutral", text: `Of your scores, ${low.label} has the most room to move (${of(low.score!, low.max)}).`, basis: { score: low.score!, position: r1(good(low)!) } });
    }
  }
  for (const s of standing ?? []) {
    const d = result.dimensions.find((x) => x.id === s.dimension);
    if (!d || d.score === null || !s.everyone) continue;
    const e = s.everyone;
    if (e.below >= 75) add({ kind: "standing", dimension: d.id, tone: "neutral", text: `Your ${d.label} score is higher than most of the ${e.n} people compared.`, basis: { n: e.n, below: e.below } });
    else if (e.above >= 75) add({ kind: "standing", dimension: d.id, tone: "neutral", text: `Your ${d.label} score is lower than most of the ${e.n} people compared.`, basis: { n: e.n, above: e.above } });
  }
  return out;
}

/* ------------------------------------------------------------------ projection */

export const PROJECTION_MIN_RESULTS = 4;
/** 80% two-sided Student t, by degrees of freedom */
const T80 = [0, 3.078, 1.886, 1.638, 1.533, 1.476, 1.44, 1.415, 1.397, 1.383, 1.372, 1.363, 1.356, 1.35, 1.345, 1.341, 1.337, 1.333, 1.33, 1.328, 1.325];
const t80 = (df: number) => (df <= 0 ? Infinity : df < T80.length ? T80[df]! : df <= 30 ? 1.31 : 1.282);

export type Projection =
  | { dimension: string; label: string; ok: true; low: number; high: number; middle: number; results: number; text: string }
  | { dimension: string; label: string; ok: false; reason: "few_results" | "too_variable"; text: string };

/**
 * Where the next result would fall IF the pattern of the like results so far continued: a straight line through
 * them, and the 80% range around its next point, kept inside the score's possible range. With fewer than four like
 * results there is none; when the range would cover more than half of the scale it says nothing useful, and that
 * is what is reported instead.
 */
export function projectTrend(t: DimensionTrend): Projection {
  const pts = like(t);
  const n = pts.length;
  const base = { dimension: t.id, label: t.label };
  if (n < PROJECTION_MIN_RESULTS) return { ...base, ok: false, reason: "few_results", text: `A projection needs at least ${PROJECTION_MIN_RESULTS} results scored the same way; ${t.label} has ${n}.` };
  const xs = pts.map((_, i) => i), ys = pts.map((p) => p.score);
  const mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0) / sxx;
  const at = (x: number) => my + slope * (x - mx);
  const sse = ys.reduce((a, y, i) => a + (y - at(i)) ** 2, 0);
  const s = Math.sqrt(sse / (n - 2));
  const half = t80(n - 2) * s * Math.sqrt(1 + 1 / n + (n - mx) ** 2 / sxx);
  const clamp = (v: number) => Math.min(t.max ?? Infinity, Math.max(t.min ?? -Infinity, v));
  const middle = clamp(at(n)), low = clamp(at(n) - half), high = clamp(at(n) + half);
  const scale = t.max !== null && t.min !== null && t.max > t.min ? t.max - t.min : Math.max(...ys) - Math.min(...ys) || 1;
  if (high - low > scale / 2) return { ...base, ok: false, reason: "too_variable", text: `Your ${t.label} results vary too much from one to the next to project the next one.` };
  const [l, h, m] = [r1(low), r1(high), r1(middle)];
  return { ...base, ok: true, low: l, high: h, middle: m, results: n, text: l === h ? `If the pattern of your last ${n} results continued, your next ${t.label} score would be about ${m}.` : `If the pattern of your last ${n} results continued, your next ${t.label} score would most likely be between ${l} and ${h}.` };
}

export const PROJECTION_NOTE = "A projection is arithmetic on your past results. It is not a prediction of what will happen, and it says nothing about why your results change.";

/** a projection for every score that has enough like results to say something (the headline included) */
export function buildProjections(trends: DimensionTrend[]): Projection[] {
  return trends.map(projectTrend).filter((p) => p.ok || p.reason === "too_variable");
}
