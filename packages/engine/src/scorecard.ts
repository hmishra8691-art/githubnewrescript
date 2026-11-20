import type { PortalScorecard, Question, ScoreBand, ScoreDimension, SurveyDefinition } from "@rescript/schema";
import { isAssessment, scoreAssessment, type AssessmentResult } from "./assessment.js";
import { portalSettings } from "./portalPolicy.js";
import { htmlToText } from "./validate.js";

/**
 * THE SCORECARD (Respondent Intelligence Engine, phase 2, 2026-11-20): one person's scores for one completed
 * interview, as the researcher defined them in `def.portal.scorecard`.
 *
 * Nothing is scored twice. A knowledge test is marked by `scoreAssessment`; a scale is normally a calculated
 * variable the survey already computes; a dimension reads one of those. Only `items` adds up answers here, for a
 * scale that has no variable of its own.
 *
 * Rules that keep a score honest:
 *   - a score that cannot be worked out is `null` with the reason — never zero, never a guess;
 *   - a SUM needs every item answered; a MEAN needs at least half of them;
 *   - `percent` is the position between the lowest and highest possible score (0–100), and exists only when both
 *     ends are known;
 *   - a band is looked up from the raw score, in the order the researcher wrote them.
 */
export interface DimensionScore {
  id: string;
  label: string;
  description?: string;
  score: number | null;
  min: number | null;
  max: number | null;
  percent: number | null;
  band: { label: string; note?: string } | null;
  higherIsBetter: boolean;
  /** why there is no score */
  reason?: string;
}
export interface ScorecardResult {
  v: 1;
  /** changes when the scorecard's definition (or the test's answer key) changes: scores are comparable only within one */
  fingerprint: string;
  dimensions: DimensionScore[];
  overall: { label: string; percent: number } | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function scorecardOf(def: Pick<SurveyDefinition, "portal">): PortalScorecard | null {
  const sc = portalSettings(def)?.scorecard;
  return sc && sc.dimensions.length ? sc : null;
}

const usesTest = (sc: PortalScorecard) => sc.dimensions.some((d) => d.source.kind === "test_total" || d.source.kind === "test_topic");

/** the band a raw score falls in: the first whose `upTo` is at or above it (bands sorted by `upTo`) */
export function bandFor(bands: ScoreBand[], score: number): { label: string; note?: string } | null {
  if (!bands.length) return null;
  const sorted = [...bands].sort((a, b) => a.upTo - b.upTo);
  const hit = sorted.find((b) => score <= b.upTo) ?? sorted[sorted.length - 1]!;
  return hit.note ? { label: hit.label, note: hit.note } : { label: hit.label };
}

/* ------------------------------------------------------------------ items */

type Coded = { code: string | number; value?: string | number };
/** the numbers an item can take: the option values, else the rating's own range */
function itemRange(q: Question): { lo: number; hi: number; valueOf: (code: unknown) => number | null } | null {
  /* a single-choice question and a single-choice grid both keep their scale points in `options` */
  const opts = (q.options ?? []) as Coded[];
  if (opts.length) {
    const map = new Map<string, number>();
    for (const o of opts) { const n = num(o.value ?? o.code); if (n !== null) map.set(String(o.code), n); }
    if (!map.size) return null;
    const all = [...map.values()];
    return { lo: Math.min(...all), hi: Math.max(...all), valueOf: (c) => (c === null || c === undefined ? null : map.get(String(c)) ?? null) };
  }
  const s = (q.settings ?? {}) as { minValue?: number; maxValue?: number };
  if (typeof s.minValue === "number" && typeof s.maxValue === "number" && s.maxValue > s.minValue) {
    return { lo: s.minValue, hi: s.maxValue, valueOf: (c) => { const n = num(c); return n !== null && n >= s.minValue! && n <= s.maxValue! ? n : null; } };
  }
  return null;
}

function scoreItems(def: SurveyDefinition, d: ScoreDimension, answers: Record<string, unknown>): Pick<DimensionScore, "score" | "min" | "max" | "reason"> {
  if (d.source.kind !== "items") return { score: null, min: null, max: null };
  const byId = new Map(def.questions.map((q) => [q.id, q]));
  const values: number[] = [];
  let lo = 0, hi = 0;
  for (const it of d.source.items) {
    const q = byId.get(it.question);
    if (!q) return { score: null, min: null, max: null, reason: "A question this score uses is no longer in the survey." };
    const range = itemRange(q);
    if (!range) return { score: null, min: null, max: null, reason: `Question ${q.code} has no numeric scale to score.` };
    lo += range.lo; hi += range.hi;
    const raw = it.row === undefined ? answers[q.id] : (answers[q.id] as Record<string, unknown> | null | undefined)?.[String(it.row)];
    const v = range.valueOf(Array.isArray(raw) ? null : raw);
    if (v !== null) values.push(it.reverse ? range.lo + range.hi - v : v);
  }
  const n = d.source.items.length;
  if (d.source.method === "sum") {
    if (values.length < n) return { score: null, min: lo, max: hi, reason: "Not every question of this score was answered." };
    return { score: r2(values.reduce((a, b) => a + b, 0)), min: lo, max: hi };
  }
  if (values.length * 2 < n || !values.length) return { score: null, min: r2(lo / n), max: r2(hi / n), reason: "Too few questions of this score were answered." };
  return { score: r2(values.reduce((a, b) => a + b, 0) / values.length), min: r2(lo / n), max: r2(hi / n) };
}

/* ------------------------------------------------------------------ the scorecard */

export interface ScorecardInput {
  answers: Record<string, unknown>;
  calculated?: Record<string, unknown> | null;
  /** the marked paper, when the caller already has it (the save route does) */
  assessment?: AssessmentResult | null;
}

export function scorecardFingerprint(def: SurveyDefinition, assessment?: AssessmentResult | null): string {
  const sc = scorecardOf(def);
  if (!sc) return "";
  const shape = sc.dimensions.map((d) => ({ id: d.id, source: d.source, min: d.min ?? null, max: d.max ?? null, hib: d.higherIsBetter, bands: d.bands.map((b) => [b.upTo, b.label]) }));
  return fnv1a(JSON.stringify({ shape, overall: !!sc.overall, key: usesTest(sc) ? assessment?.keyFingerprint ?? "" : "" }));
}

export function computeScorecard(def: SurveyDefinition, input: ScorecardInput): ScorecardResult | null {
  const sc = scorecardOf(def);
  if (!sc) return null;
  const marked = usesTest(sc) && isAssessment(def) ? input.assessment ?? scoreAssessment(def, input.answers) : null;
  const calculated = input.calculated ?? {};
  const codeToId = new Map(def.questions.map((q) => [q.code, q.id]));

  const dimensions: DimensionScore[] = sc.dimensions.map((d) => {
    let score: number | null = null, min: number | null = null, max: number | null = null, reason: string | undefined;
    const src = d.source;
    if (src.kind === "test_total" || src.kind === "test_topic") {
      if (!marked) reason = "This survey is not a scored test.";
      else if (src.kind === "test_total") { score = marked.marks; min = 0; max = marked.maxMarks; }
      else {
        const t = marked.topics.find((x) => x.topic === src.topic);
        if (!t) reason = `The test has no topic called "${src.topic}".`;
        else { score = t.marks; min = 0; max = t.maxMarks; }
      }
    } else if (src.kind === "variable") {
      const id = codeToId.get(src.name);
      score = num(calculated[src.name] ?? (id ? calculated[id] : undefined) ?? (id ? input.answers[id] : undefined));
      if (score === null) reason = "This score was not calculated for this interview.";
      else score = r2(score);
    } else {
      ({ score, min, max, reason } = scoreItems(def, d, input.answers));
    }
    /* the researcher's own ends win: a test with negative marking, a variable's known range */
    if (d.min !== undefined) min = d.min;
    if (d.max !== undefined) max = d.max;
    const percent = score !== null && min !== null && max !== null && max > min ? r2(Math.min(100, Math.max(0, ((score - min) / (max - min)) * 100))) : null;
    const out: DimensionScore = { id: d.id, label: htmlToText(d.label), score, min, max, percent, band: score === null ? null : bandFor(d.bands, score), higherIsBetter: d.higherIsBetter };
    if (d.description) out.description = d.description;
    if (score === null && reason) out.reason = reason;
    return out;
  });

  let overall: ScorecardResult["overall"] = null;
  if (sc.overall) {
    /* a "less is better" score counts from its good end, so the headline always reads "more is better" */
    const parts = dimensions.filter((x) => x.percent !== null).map((x) => (x.higherIsBetter ? x.percent! : 100 - x.percent!));
    if (parts.length) overall = { label: sc.overall.label, percent: r2(parts.reduce((a, b) => a + b, 0) / parts.length) };
  }
  return { v: 1, fingerprint: scorecardFingerprint(def, marked), dimensions, overall };
}

/** dimension id → the raw score, for storage and for comparison (null = not scored) */
export function scorecardValues(r: ScorecardResult): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const d of r.dimensions) out[d.id] = d.score;
  if (r.overall) out.__overall = r.overall.percent;
  return out;
}

/** which comparison group this interview belongs to, per grouping (null = no answer, so no group) */
export function cohortValues(def: SurveyDefinition, state: { answers: Record<string, unknown>; embedded?: Record<string, unknown> | null }): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const g of portalSettings(def)?.benchmark.groups ?? []) {
    let v: string | null = null;
    if (g.source.kind === "question") {
      const q = def.questions.find((x) => x.id === g.source.ref || x.code === g.source.ref);
      const raw = q ? state.answers[q.id] : undefined;
      if (q && (typeof raw === "string" || typeof raw === "number")) {
        const o = (q.options ?? []).find((x) => String(x.code) === String(raw));
        v = o ? htmlToText(String(o.label ?? o.code)) : String(raw);
      }
    } else {
      const raw = state.embedded?.[g.source.ref];
      if (typeof raw === "string" || typeof raw === "number") v = String(raw).trim() || null;
    }
    out[g.id] = v ? v.slice(0, 120) : null;
  }
  return out;
}

/** what the respondent is shown: nothing without the permission; bands only when allowed */
export function respondentScorecard(def: SurveyDefinition, r: ScorecardResult | null): ScorecardResult | null {
  const show = portalSettings(def)?.show;
  if (!r || !show?.scores) return null;
  return show.bands ? r : { ...r, dimensions: r.dimensions.map((d) => ({ ...d, band: null })) };
}

/** problems in a scorecard's definition, for the Studio (empty = fine) */
export function scorecardProblems(def: SurveyDefinition): { dimension: string; message: string }[] {
  const sc = portalSettings(def)?.scorecard;
  const out: { dimension: string; message: string }[] = [];
  if (!sc) return out;
  const seen = new Set<string>();
  const byId = new Map(def.questions.map((q) => [q.id, q]));
  const codes = new Set(def.questions.map((q) => q.code));
  for (const d of sc.dimensions) {
    const say = (message: string) => out.push({ dimension: d.id, message });
    if (seen.has(d.id)) say("Two scores have the same id.");
    seen.add(d.id);
    if (d.min !== undefined && d.max !== undefined && d.max <= d.min) say("The highest possible score must be above the lowest.");
    const s = d.source;
    if ((s.kind === "test_total" || s.kind === "test_topic") && !isAssessment(def)) say("This survey is not a scored test, so it has no marks to show.");
    if (s.kind === "variable") {
      if (!codes.has(s.name)) say(`There is no calculated variable called ${s.name}.`);
      if (d.min === undefined || d.max === undefined) say("Give the lowest and highest possible value, so the score can be drawn and compared.");
    }
    if (s.kind === "items") for (const it of s.items) {
      const q = byId.get(it.question);
      if (!q) say("A question this score uses is no longer in the survey.");
      else if (!itemRange(q)) say(`Question ${q.code} has no numeric scale to score.`);
    }
    const ups = d.bands.map((b) => b.upTo);
    if (new Set(ups).size !== ups.length) say("Two ranges end at the same value.");
  }
  const groups = portalSettings(def)?.benchmark.groups ?? [];
  for (const g of groups) if (g.source.kind === "question" && !def.questions.some((q) => q.id === g.source.ref || q.code === g.source.ref)) out.push({ dimension: g.id, message: `The comparison group "${g.label}" uses a question that is no longer in the survey.` });
  return out;
}
