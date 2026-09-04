import type { QualityCategory, QualityClass, QualityConfig, Severity, Strictness } from "@rescript/schema";
import type { FlagDraft, QualityFlag } from "./types.js";
import { RULE_BY_ID, SEVERITY_ORDER } from "./catalogue.js";
import { clamp } from "./metrics.js";

/**
 * Scoring & classification.
 *
 * Fraud risk is a noisy-OR over the flags' weighted risk points: each flag is
 * an independent piece of evidence with probability p = points/100, and the
 * risk is 1 − Π(1 − p). Two 30-point flags give 51, not 60; ten small flags
 * approach but never exceed 100; one 60-point flag alone is 60. That is the
 * behaviour a researcher expects: evidence accumulates, nothing is double
 * counted to certainty.
 *
 * Quality is additive: 100 minus the weighted penalties, floored at 0. Poor
 * quality accumulates linearly because each poor answer is one more poor
 * answer in the dataset.
 *
 * The two are never combined. Classification reads the RISK score against the
 * configured bands; a custom rule may raise the floor.
 */

const SEVERITY_MULT: Record<Severity, number> = { low: 0.6, medium: 1, high: 1.3, critical: 1.6 };

export function finalizeFlags(drafts: FlagDraft[], config: QualityConfig, now: string): QualityFlag[] {
  const out: QualityFlag[] = [];
  for (const d of drafts) {
    const def = RULE_BY_ID[d.ruleId];
    const setting = config.rules[d.ruleId] ?? {};
    const category: QualityCategory = def?.category ?? "custom";
    const severity: Severity = d.severity ?? setting.severity ?? def?.defaultSeverity ?? "medium";
    const intensity = clamp(d.intensity ?? 1, 0, 1);
    const weight = setting.weight ?? 1;
    const qWeight = setting.qualityWeight ?? 1;
    const baseRisk = def?.riskPoints ?? 10;
    const baseQ = def?.qualityPenalty ?? 5;
    // severity chosen by the researcher scales the design points
    const sevMult = SEVERITY_MULT[severity] / SEVERITY_MULT[def?.defaultSeverity ?? "medium"];
    out.push({
      ruleId: d.ruleId,
      category,
      severity,
      title: d.title ?? def?.title ?? d.ruleId,
      explanation: d.explanation,
      observed: d.observed,
      expected: d.expected,
      riskPoints: Math.round(clamp(baseRisk * intensity * weight * sevMult)),
      qualityPenalty: Math.round(clamp(baseQ * (0.5 + intensity / 2) * qWeight * sevMult)),
      questionIds: [...new Set(d.questionIds ?? [])],
      relatedSessionIds: d.relatedSessionIds?.length ? [...new Set(d.relatedSessionIds)] : undefined,
      at: now,
    });
  }
  return out;
}

export function noisyOr(points: number[]): number {
  let keep = 1;
  for (const p of points) keep *= 1 - clamp(p) / 100;
  return Math.round((1 - keep) * 100);
}

export function riskScore(flags: QualityFlag[]): number {
  return noisyOr(flags.map((f) => f.riskPoints));
}

export function qualityScore(flags: QualityFlag[]): number {
  return Math.round(clamp(100 - flags.reduce((s, f) => s + f.qualityPenalty, 0)));
}

export function categoryScores(flags: QualityFlag[]): Record<QualityCategory, number> {
  const cats: QualityCategory[] = ["timing", "matrix", "consistency", "pattern", "attention", "open_end", "interaction", "navigation", "device", "network", "bot", "duplicate", "cluster", "screener", "custom"];
  const out = {} as Record<QualityCategory, number>;
  for (const c of cats) out[c] = noisyOr(flags.filter((f) => f.category === c).map((f) => f.riskPoints));
  return out;
}

export function classify(risk: number, config: QualityConfig, floor?: QualityClass): QualityClass {
  const b = config.bands;
  let c: QualityClass = risk < b.review ? "CLEAN" : risk < b.suspicious ? "REVIEW" : risk < b.highlySuspicious ? "SUSPICIOUS" : risk < b.critical ? "HIGHLY_SUSPICIOUS" : "CRITICAL";
  if (floor && CLASS_ORDER[floor] > CLASS_ORDER[c]) c = floor;
  return c;
}

export const CLASS_ORDER: Record<QualityClass, number> = { CLEAN: 0, REVIEW: 1, SUSPICIOUS: 2, HIGHLY_SUSPICIOUS: 3, CRITICAL: 4 };

export function recommendation(cls: QualityClass, quality: number): "INCLUDE" | "REVIEW BEFORE INCLUSION" | "LIKELY EXCLUDE" {
  if (cls === "CRITICAL" || cls === "HIGHLY_SUSPICIOUS") return "LIKELY EXCLUDE";
  if (cls === "SUSPICIOUS" || cls === "REVIEW" || quality < 50) return "REVIEW BEFORE INCLUSION";
  return "INCLUDE";
}

/** The "Reasons:" list — most important first, each one sentence with the numbers. */
export function reasons(flags: QualityFlag[]): string[] {
  return [...flags]
    .sort((a, b) => (b.riskPoints + b.qualityPenalty) - (a.riskPoints + a.qualityPenalty) || SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity])
    .map((f) => `${f.title}: ${f.observed}${f.expected ? ` (expected ${f.expected})` : ""}.`);
}

export function strictnessLabel(s: Strictness): string {
  return { relaxed: "Relaxed", standard: "Standard", strict: "Strict", very_strict: "Very strict", custom: "Custom" }[s];
}
