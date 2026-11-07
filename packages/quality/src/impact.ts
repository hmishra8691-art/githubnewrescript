import type { QualityCategory, SurveyDefinition } from "@rescript/schema";
import type { QualityAssessment } from "./types.js";

/**
 * HOW RESULTS READ TO A RESEARCHER, AND WHAT CLEANING DID TO THE SAMPLE (ResLens roadmap 1.3 and 1.4, tracker 1.5).
 *
 * Three display layers over the engine's assessment — none of them changes a score:
 *
 *   qualityDimensions   the engine's 15 rule categories folded into the roadmap's six dimensions (behavioural
 *                       integrity, response consistency, attention and engagement, open-end relevance, completion
 *                       behaviour, duplicate and identity risk); each dimension's risk is its strongest category's.
 *   qualityOutcome      the five outcomes a researcher acts on: verified, review, low quality, suspected fraud — and
 *                       INCONCLUSIVE, for a pass the engine could not really test (the timing or interaction
 *                       telemetry was not measured, or too few peers to compare against).
 *   cleaningImpact      the before-and-after report: completes before and after removals, why they were removed,
 *                       quality and outcomes before and after, the questions whose blanks changed, and — the part
 *                       that matters for bias — every answer share that cleaning moved by 3 points or more.
 */

export type QualityDimension = "behavioural_integrity" | "response_consistency" | "attention_engagement" | "open_end_relevance" | "completion_behaviour" | "duplicate_identity";

export const DIMENSIONS: { id: QualityDimension; label: string; categories: QualityCategory[] }[] = [
  { id: "behavioural_integrity", label: "Behavioural integrity", categories: ["interaction", "bot", "navigation"] },
  { id: "response_consistency", label: "Response consistency", categories: ["consistency", "pattern", "screener"] },
  { id: "attention_engagement", label: "Attention and engagement", categories: ["attention", "matrix"] },
  { id: "open_end_relevance", label: "Open-end relevance", categories: ["open_end"] },
  { id: "completion_behaviour", label: "Completion behaviour", categories: ["timing"] },
  { id: "duplicate_identity", label: "Duplicate and identity risk", categories: ["duplicate", "cluster", "device", "network"] },
];

/** each dimension's risk (0–100) = its strongest category's risk; custom rules stay outside the six */
export function qualityDimensions(categories: Partial<Record<QualityCategory, number>>): Record<QualityDimension, number> {
  const out = {} as Record<QualityDimension, number>;
  for (const d of DIMENSIONS) out[d.id] = Math.max(0, ...d.categories.map((c) => categories[c] ?? 0));
  return out;
}

export type QualityOutcome = "verified" | "review" | "low_quality" | "suspected_fraud" | "inconclusive";
export const OUTCOME_LABELS: Record<QualityOutcome, string> = {
  verified: "Verified", review: "Needs review", low_quality: "Low quality", suspected_fraud: "Suspected fraud", inconclusive: "Inconclusive",
};

/* automation and identity evidence is fraud on its own; answer similarity (duplicates, clusters) is fraud only
   when the response is not also a low-effort one — speeders who straightline look alike without being one person */
const IDENTITY = new Set<QualityCategory>(["bot", "network", "device"]);
const SIMILARITY = new Set<QualityCategory>(["duplicate", "cluster"]);
const LOW_EFFORT = new Set<QualityCategory>(["timing", "attention"]);

/**
 * The outcome for one assessment. FLAGGED splits by WHAT the classifying evidence is about: automation and identity
 * (bots, networks, devices) is suspected fraud; duplicate or coordinated answers are suspected fraud unless the
 * response is also a low-effort one (speeding, failed attention), in which case — as for speed, grids, open ends and
 * patterns — it is low quality. A PASS the engine could not test properly is inconclusive.
 */
export function qualityOutcome(a: QualityAssessment, opts: { minPeers?: number } = {}): QualityOutcome {
  if (a.verdict === "REVIEW") return "review";
  if (a.verdict === "FLAGGED") {
    const evidence = a.evidence?.categories?.length ? a.evidence.categories : a.flags.filter((f) => f.role !== "informational").map((f) => f.category);
    if (evidence.some((c) => IDENTITY.has(c))) return "suspected_fraud";
    if (evidence.some((c) => SIMILARITY.has(c)) && !evidence.some((c) => LOW_EFFORT.has(c))) return "suspected_fraud";
    return "low_quality";
  }
  const untested = a.notMeasured.includes("timing") || a.notMeasured.includes("interaction") || (a.benchmarks.peers < (opts.minPeers ?? 30) && a.benchmarks.medianDurationSec == null);
  return untested ? "inconclusive" : "verified";
}

/* ------------------------------------------------------------------ the before-and-after report */

export interface ImpactRow {
  sessionId: string;
  status: string;
  answers: Record<string, unknown>;
  quality: QualityAssessment | null;
  /** the researcher's decision: REMOVE takes the response out of the cleaned dataset */
  reviewStatus: string | null;
  reviewReason?: string | null;
}

export interface ShareShift { questionId: string; code: string; text: string; option: string; before: number; after: number; points: number }

export interface CleaningImpact {
  before: number;
  after: number;
  removed: number;
  pendingReview: number;
  removedBecause: { reason: string; count: number }[];
  qualityScore: { before: number | null; after: number | null };
  outcomes: { before: Record<QualityOutcome | "unscored", number>; after: Record<QualityOutcome | "unscored", number> };
  dimensions: { before: Record<QualityDimension, number>; after: Record<QualityDimension, number> };
  /** answer shares cleaning moved by at least `notablePoints` (absolute, percentage points), largest first */
  shifts: ShareShift[];
  /** blank rates (answered nothing among completes) that changed by at least 2 points */
  blanks: { questionId: string; code: string; before: number; after: number }[];
  notablePoints: number;
}

const strip = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
const isBlank = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

export function cleaningImpact(def: SurveyDefinition, rows: ImpactRow[], opts: { notablePoints?: number; minPeers?: number } = {}): CleaningImpact {
  const notable = opts.notablePoints ?? 3;
  const completes = rows.filter((r) => r.status === "complete");
  const kept = completes.filter((r) => r.reviewStatus !== "REMOVE");
  const removed = completes.filter((r) => r.reviewStatus === "REMOVE");
  const reasons = new Map<string, number>();
  for (const r of removed) {
    const why = (r.reviewReason && r.reviewReason.trim()) || (r.quality ? (r.quality.reasons[0]?.split(":")[0] ?? "flagged by quality checks") : "removed by a reviewer");
    reasons.set(why, (reasons.get(why) ?? 0) + 1);
  }
  const outcomesOf = (set: ImpactRow[]) => {
    const o = { verified: 0, review: 0, low_quality: 0, suspected_fraud: 0, inconclusive: 0, unscored: 0 } as Record<QualityOutcome | "unscored", number>;
    for (const r of set) o[r.quality ? qualityOutcome(r.quality, opts) : "unscored"]++;
    return o;
  };
  const dimsOf = (set: ImpactRow[]) => {
    const scored = set.filter((r) => r.quality);
    const out = {} as Record<QualityDimension, number>;
    for (const d of DIMENSIONS) out[d.id] = scored.length ? Math.round(scored.reduce((s, r) => s + qualityDimensions(r.quality!.categories)[d.id], 0) / scored.length * 10) / 10 : 0;
    return out;
  };
  /* sample composition: every closed single- or multi-choice question with a manageable number of answers */
  const shifts: ShareShift[] = [];
  const blanks: CleaningImpact["blanks"] = [];
  for (const q of def.questions) {
    const vals = (set: ImpactRow[]) => set.map((r) => r.answers[q.id]);
    const blankRate = (set: ImpactRow[]) => (set.length ? (vals(set).filter(isBlank).length / set.length) * 100 : 0);
    if (!["html", "hidden", "calculated", "embedded_data"].includes(q.type) && completes.length && kept.length) {
      const b0 = blankRate(completes), b1 = blankRate(kept);
      if (Math.abs(b1 - b0) >= 2) blanks.push({ questionId: q.id, code: q.code, before: Math.round(b0 * 10) / 10, after: Math.round(b1 * 10) / 10 });
    }
    const closed = ["single_select", "dropdown", "multi_select", "multi_dropdown", "image_select"].includes(q.type) && q.options.length > 0 && q.options.length <= 15;
    if (!closed || !completes.length || !kept.length) continue;
    const share = (set: ImpactRow[], code: string | number) => {
      const answered = vals(set).filter((v) => !isBlank(v));
      if (!answered.length) return 0;
      return (answered.filter((v) => (Array.isArray(v) ? v.some((x) => String(x) === String(code)) : String(v) === String(code))).length / answered.length) * 100;
    };
    for (const o of q.options) {
      const before = share(completes, o.code), after = share(kept, o.code);
      const points = Math.round((after - before) * 10) / 10;
      if (Math.abs(points) >= notable) shifts.push({ questionId: q.id, code: q.code, text: strip(q.text).slice(0, 90), option: strip(o.label), before: Math.round(before * 10) / 10, after: Math.round(after * 10) / 10, points });
    }
  }
  shifts.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return {
    before: completes.length, after: kept.length, removed: removed.length,
    pendingReview: completes.filter((r) => r.reviewStatus === "REVIEW_LATER").length,
    removedBecause: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    qualityScore: { before: mean(completes.flatMap((r) => (r.quality ? [r.quality.qualityScore] : []))), after: mean(kept.flatMap((r) => (r.quality ? [r.quality.qualityScore] : []))) },
    outcomes: { before: outcomesOf(completes), after: outcomesOf(kept) },
    dimensions: { before: dimsOf(completes), after: dimsOf(kept) },
    shifts, blanks, notablePoints: notable,
  };
}
