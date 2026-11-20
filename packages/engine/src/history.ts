import type { SurveyDefinition } from "@rescript/schema";
import { portalSettings } from "./portalPolicy.js";
import type { DimensionScore, ScorecardResult } from "./scorecard.js";

/**
 * RESULTS OVER TIME (Respondent Intelligence Engine, phase 3, 2026-11-20): one person's scores across their
 * attempts, and what changed.
 *
 * THE COMPARABILITY RULE. Two results of a score are compared only when the score was MADE the same way both times
 * (`DimensionScore.sig`: same items by code, same scale ends, same reverse-keying, same range and direction — or
 * the same test key). The latest result is the reference. An earlier result made differently is still listed, marked
 * not comparable, drawn apart, and never used in a "change" figure. A change figure is therefore always between
 * two like-for-like numbers; when there is no such pair, there is no change figure.
 *
 * WHAT A CHANGE SAYS. The difference between two of the person's own scores, and whether it is in the better
 * direction for that score. A difference below the score's `minChange` is "about the same". It makes no claim
 * about cause, and it is not a clinical or statistical judgement.
 */
export const OVERALL_ID = "__overall";

export interface HistoryPoint {
  /** when the attempt was completed */
  at: string;
  /** what the attempt is called in the series: the survey's period ("2026"), else empty */
  wave: string;
  surveyId: string;
  responseId: string;
  result: ScorecardResult;
  /** the average of everyone for that survey, per score — only where a group of the minimum size exists */
  group?: Record<string, { mean: number; n: number }>;
}

export interface TrendPoint { at: string; wave: string; responseId: string; score: number; percent: number | null; band: string | null; comparable: boolean; groupMean: number | null; groupN: number | null }
export type Direction = "better" | "worse" | "same";
export interface Change { fromAt: string; from: number; to: number; delta: number; direction: Direction; text: string }
export interface DimensionTrend {
  id: string;
  label: string;
  min: number | null;
  max: number | null;
  higherIsBetter: boolean;
  points: TrendPoint[];
  /** the latest result against the one before it */
  change: Change | null;
  /** …against the first comparable result, when that is a different one */
  sinceFirst: Change | null;
  /** …against the result closest to a year earlier (within 45 days), when there is one */
  yearOnYear: Change | null;
  note: string | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const show = (n: number) => String(r2(n));
const DAY = 86_400_000;

export function describeScoreChange(from: number, to: number, higherIsBetter: boolean, minChange: number | undefined): { delta: number; direction: Direction; text: string } {
  const delta = r2(to - from);
  const small = minChange !== undefined ? Math.abs(delta) < minChange : delta === 0;
  if (small) return { delta, direction: "same", text: delta === 0 ? `The same (${show(to)})` : `About the same (${show(from)} to ${show(to)})` };
  const direction: Direction = delta > 0 === higherIsBetter ? "better" : "worse";
  return { delta, direction, text: `${delta > 0 ? "Up" : "Down"} ${show(Math.abs(delta))} (from ${show(from)} to ${show(to)})` };
}

interface Seen { at: string; wave: string; responseId: string; d: Pick<DimensionScore, "score" | "percent" | "min" | "max" | "higherIsBetter" | "label"> & { band: string | null; sig: string }; group: { mean: number; n: number } | null }

/**
 * Every score that appears in the history, oldest result first. `minChange` comes from the definition that is
 * live now (score id → threshold). Results without a score for a dimension are simply not points of it.
 */
export function buildTrends(points: HistoryPoint[], minChange: Record<string, number | undefined> = {}): DimensionTrend[] {
  const ordered = [...points].filter((p) => !Number.isNaN(Date.parse(p.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const order: string[] = [];
  const seen = new Map<string, Seen[]>();
  const push = (id: string, s: Seen) => { if (!seen.has(id)) { seen.set(id, []); order.push(id); } seen.get(id)!.push(s); };
  for (const p of ordered) {
    for (const d of p.result.dimensions) {
      if (d.score === null) continue;
      push(d.id, { at: p.at, wave: p.wave, responseId: p.responseId, d: { score: d.score, percent: d.percent, min: d.min, max: d.max, higherIsBetter: d.higherIsBetter, label: d.label, band: d.band?.label ?? null, sig: d.sig ?? "" }, group: p.group?.[d.id] ?? null });
    }
    /* the headline is comparable only when the whole scoring is the same */
    if (p.result.overall) push(OVERALL_ID, { at: p.at, wave: p.wave, responseId: p.responseId, d: { score: p.result.overall.percent, percent: p.result.overall.percent, min: 0, max: 100, higherIsBetter: true, label: p.result.overall.label, band: null, sig: p.result.fingerprint }, group: p.group?.[OVERALL_ID] ?? null });
  }

  const out: DimensionTrend[] = [];
  /* the headline first, then the scores in the order the latest results list them */
  const ids = [...order].sort((a, b) => (a === OVERALL_ID ? -1 : b === OVERALL_ID ? 1 : 0));
  for (const id of ids) {
    const all = seen.get(id)!;
    const latest = all[all.length - 1]!;
    const pts: TrendPoint[] = all.map((s) => ({ at: s.at, wave: s.wave, responseId: s.responseId, score: s.d.score!, percent: s.d.percent, band: s.d.band, comparable: !!latest.d.sig && s.d.sig === latest.d.sig, groupMean: s.group?.mean ?? null, groupN: s.group?.n ?? null }));
    const like = all.filter((s, i) => pts[i]!.comparable);
    const versus = (earlier: Seen | undefined): Change | null => {
      if (!earlier || earlier === latest) return null;
      return { fromAt: earlier.at, from: earlier.d.score!, to: latest.d.score!, ...describeScoreChange(earlier.d.score!, latest.d.score!, latest.d.higherIsBetter, minChange[id]) };
    };
    const previous = like[like.length - 2];
    const first = like[0];
    const target = Date.parse(latest.at) - 365 * DAY;
    const yearAgo = like.slice(0, -1).map((s) => ({ s, off: Math.abs(Date.parse(s.at) - target) })).filter((x) => x.off <= 45 * DAY).sort((a, b) => a.off - b.off)[0]?.s;
    const apart = pts.filter((p) => !p.comparable).length;
    out.push({
      id, label: latest.d.label, min: latest.d.min, max: latest.d.max, higherIsBetter: latest.d.higherIsBetter, points: pts,
      change: versus(previous), sinceFirst: first !== previous ? versus(first) : null, yearOnYear: yearAgo && yearAgo !== previous ? versus(yearAgo) : null,
      note: apart ? `${apart} earlier result${apart === 1 ? " was" : "s were"} scored differently, so ${apart === 1 ? "it is" : "they are"} shown but not compared.` : null,
    });
  }
  return out;
}

/** score id → the smallest change that counts, from the definition that is live now */
export function minChanges(def: Pick<SurveyDefinition, "portal"> | null | undefined): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  for (const d of (def ? portalSettings(def) : null)?.scorecard?.dimensions ?? []) out[d.id] = d.minChange;
  return out;
}

/** when a repeated assessment is next due: `repeatEveryDays` after the last completion (null: not repeated, or never taken) */
export function nextDue(def: Pick<SurveyDefinition, "portal"> | null | undefined, lastCompletedAt: string | null, now: number): { at: string; overdue: boolean } | null {
  const every = (def ? portalSettings(def) : null)?.series?.repeatEveryDays;
  const last = lastCompletedAt ? Date.parse(lastCompletedAt) : Number.NaN;
  if (!every || Number.isNaN(last)) return null;
  const at = last + every * DAY;
  return { at: new Date(at).toISOString(), overdue: at <= now };
}

/** the series a survey belongs to, when its portal is on */
export function seriesOf(def: Pick<SurveyDefinition, "portal"> | null | undefined) {
  return (def ? portalSettings(def) : null)?.series ?? null;
}
