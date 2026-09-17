import type { QualityCategory, QualityClass, QualityConfig, QualityVerdict, RuleRole, Severity, Strictness } from "@rescript/schema";
import type { EvidenceStrength, EvidenceSummary, FlagDraft, QualityFlag } from "./types.js";
import { RULE_BY_ID, SEVERITY_ORDER } from "./catalogue.js";
import { clamp } from "./metrics.js";

/**
 * Scoring & classification.
 *
 * ## What went wrong before
 *
 * Every flag was an independent piece of evidence in one noisy-OR. Five ways
 * of saying "this person was fast" — overall, per page, per grid, reading
 * time, short dwell — compounded as if five separate things had been
 * observed. A shared office IP counted three times (duplicate IP, IP density,
 * duplicate device signature). A pasted answer, agreeing with every item on
 * a satisfaction grid, one reload — each added to "fraud". And a benchmark
 * built from a reading-time estimate that assumes every word is read made
 * most real people speeders. The sum of many weak, correlated signals passed
 * 60 and a normal respondent was HIGHLY SUSPICIOUS.
 *
 * ## The model now
 *
 * 1. Every flag has a **role**. Classifying flags move the verdict;
 *    informational ones are shown as evidence and cost quality points, but
 *    never risk. Set per rule in the catalogue, overridable per survey.
 * 2. Every flag has a **confidence** (0–1). A flag measured against a
 *    reading-time estimate rather than this survey's own median, or against a
 *    thin population, carries less than 1, and its points are scaled by it.
 * 3. Signals **within a category are correlated**: the category's risk is
 *    its strongest flag plus a fraction of the rest (`CORRELATED_REST`), not
 *    a noisy-OR over all of them. Categories are then combined as independent
 *    evidence (noisy-OR), because "fast" and "identical answers to somebody
 *    else" really are two facts.
 * 4. The **verdict** — PASS / REVIEW / FLAGGED — needs minimum evidence.
 *    FLAGGED requires the risk band AND at least one strong, confident
 *    classifying flag, or moderate classifying flags in two distinct
 *    categories. A pile of weak signals can reach REVIEW; it cannot reach
 *    FLAGGED. The five-class scale stays underneath, capped at REVIEW unless
 *    the verdict is FLAGGED, so the two never disagree.
 *
 * Quality stays additive: 100 minus the penalties, floored at 0. Poor answers
 * accumulate linearly because each one is one more poor answer in the data.
 */

const SEVERITY_MULT: Record<Severity, number> = { low: 0.6, medium: 1, high: 1.3, critical: 1.6 };

/** How much of the non-strongest flags in a category still counts, under `correlated`. */
export const CORRELATED_REST = 0.35;

/** A flag this confident and this strong can carry a FLAGGED verdict on its own. */
export const STRONG_CONFIDENCE = 0.75;

/** Strength from the rule's DESIGN points (before weighting), so a researcher's weight cannot promote a weak signal to strong. */
export function strengthOf(designRiskPoints: number): EvidenceStrength {
  if (designRiskPoints >= 25) return "strong";
  if (designRiskPoints >= 12) return "moderate";
  return "weak";
}

export function roleOf(ruleId: string, config: QualityConfig, draft?: { role?: RuleRole }): RuleRole {
  return config.rules[ruleId]?.role ?? draft?.role ?? RULE_BY_ID[ruleId]?.role ?? "classifying";
}

export function finalizeFlags(drafts: FlagDraft[], config: QualityConfig, now: string): QualityFlag[] {
  const out: QualityFlag[] = [];
  for (const d of drafts) {
    const def = RULE_BY_ID[d.ruleId];
    const setting = config.rules[d.ruleId] ?? {};
    const category: QualityCategory = def?.category ?? "custom";
    const severity: Severity = d.severity ?? setting.severity ?? def?.defaultSeverity ?? "medium";
    const intensity = clamp(d.intensity ?? 1, 0, 1);
    const confidence = clamp(d.confidence ?? 1, 0, 1);
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
      riskPoints: Math.round(clamp(baseRisk * intensity * weight * sevMult * confidence)),
      qualityPenalty: Math.round(clamp(baseQ * (0.5 + intensity / 2) * qWeight * sevMult)),
      questionIds: [...new Set(d.questionIds ?? [])],
      relatedSessionIds: d.relatedSessionIds?.length ? [...new Set(d.relatedSessionIds)] : undefined,
      at: now,
      role: roleOf(d.ruleId, config, d),
      strength: strengthOf(baseRisk),
      confidence,
      caveat: d.caveat,
    });
  }
  return out;
}

export function noisyOr(points: number[]): number {
  let keep = 1;
  for (const p of points) keep *= 1 - clamp(p) / 100;
  return Math.round((1 - keep) * 100);
}

/** The flags that may move the verdict. */
export const classifying = (flags: QualityFlag[]): QualityFlag[] => flags.filter((f) => f.role !== "informational");

/**
 * One category's risk. `correlated`: the strongest signal in full, the rest
 * at `CORRELATED_REST` — they are mostly restatements of the same fact.
 * `independent`: the old noisy-OR.
 */
export function categoryRisk(points: number[], combination: QualityConfig["evidence"]["combination"] = "correlated"): number {
  if (!points.length) return 0;
  if (combination === "independent") return noisyOr(points);
  const sorted = [...points].sort((a, b) => b - a);
  const [top, ...rest] = sorted;
  const restRisk = noisyOr(rest) * CORRELATED_REST;
  return Math.round(clamp(top! + restRisk * (1 - top! / 100)));
}

export const CATEGORIES: QualityCategory[] = ["timing", "matrix", "consistency", "pattern", "attention", "open_end", "interaction", "navigation", "device", "network", "bot", "duplicate", "cluster", "screener", "custom"];

/** Per-category risk over CLASSIFYING flags — what SYSTEM_*_SCORE report. */
export function categoryScores(flags: QualityFlag[], config?: QualityConfig): Record<QualityCategory, number> {
  const mode = config?.evidence?.combination ?? "correlated";
  const cf = classifying(flags);
  const out = {} as Record<QualityCategory, number>;
  for (const c of CATEGORIES) out[c] = categoryRisk(cf.filter((f) => f.category === c).map((f) => f.riskPoints), mode);
  return out;
}

/**
 * The fraud-risk score: categories as independent evidence, each category
 * as correlated evidence. Informational flags are not in it.
 *
 * `device` and `network` are one fact — the same machine on the same
 * connection — so they are folded into one category before combining.
 */
export function riskScore(flags: QualityFlag[], config?: QualityConfig): number {
  const mode = config?.evidence?.combination ?? "correlated";
  const cf = classifying(flags);
  if (mode === "independent") return noisyOr(cf.map((f) => f.riskPoints));
  const byCat = new Map<string, number[]>();
  for (const f of cf) {
    const key = f.category === "network" ? "device" : f.category;
    byCat.set(key, [...(byCat.get(key) ?? []), f.riskPoints]);
  }
  return noisyOr([...byCat.values()].map((pts) => categoryRisk(pts, "correlated")));
}

export function qualityScore(flags: QualityFlag[]): number {
  return Math.round(clamp(100 - flags.reduce((s, f) => s + f.qualityPenalty, 0)));
}

export const CLASS_ORDER: Record<QualityClass, number> = { CLEAN: 0, REVIEW: 1, SUSPICIOUS: 2, HIGHLY_SUSPICIOUS: 3, CRITICAL: 4 };

/** The five-class reading of a risk score against the bands, before the verdict caps it. */
export function bandClass(risk: number, config: QualityConfig): QualityClass {
  const b = config.bands;
  return risk < b.review ? "CLEAN" : risk < b.suspicious ? "REVIEW" : risk < b.highlySuspicious ? "SUSPICIOUS" : risk < b.critical ? "HIGHLY_SUSPICIOUS" : "CRITICAL";
}

/**
 * THE VERDICT, with the evidence it rests on.
 *
 * FLAGGED needs the risk band (≥ `bands.suspicious`) AND, under
 * `strong_or_two_categories`, one strong classifying flag at or above
 * `STRONG_CONFIDENCE`, or moderate-or-stronger classifying flags in at least
 * `flaggedMinCategories` distinct categories. A custom rule's `minClass` of
 * SUSPICIOUS or higher is a researcher's explicit instruction and forces
 * FLAGGED. REVIEW is the risk band (≥ `bands.review`) or any strong flag on
 * its own. Otherwise PASS.
 */
export function verdictOf(flags: QualityFlag[], risk: number, config: QualityConfig, floor?: QualityClass): { verdict: QualityVerdict; evidence: EvidenceSummary } {
  const cf = classifying(flags).filter((f) => f.riskPoints > 0);
  const strong = cf.filter((f) => f.strength === "strong");
  const moderate = cf.filter((f) => f.strength === "moderate");
  const weak = cf.filter((f) => f.strength === "weak");
  const confidentStrong = strong.filter((f) => f.confidence >= STRONG_CONFIDENCE);
  const categories = [...new Set(cf.filter((f) => f.strength !== "weak").map((f) => f.category === "network" ? "device" : f.category))] as QualityCategory[];
  const informational = flags.length - classifying(flags).length;
  const ev = config.evidence ?? { combination: "correlated", minPeers: 30, estimateConfidence: 0.6, minPopulation: 30, flagged: "strong_or_two_categories", flaggedMinCategories: 2 };

  const forced = floor !== undefined && CLASS_ORDER[floor] >= CLASS_ORDER.SUSPICIOUS;
  const inBand = risk >= config.bands.suspicious;
  const enough = ev.flagged === "bands_only"
    ? true
    : confidentStrong.length >= 1 || categories.length >= ev.flaggedMinCategories;

  const ranked = [...cf].sort((a, b) => b.riskPoints - a.riskPoints || SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);
  const say = (f: QualityFlag) => f.title.toLowerCase();

  let verdict: QualityVerdict;
  let because: string;
  if (forced || (inBand && enough)) {
    verdict = "FLAGGED";
    if (forced) because = `A custom rule requires at least ${floor} for this response.`;
    else if (confidentStrong.length) because = `Strong evidence: ${confidentStrong.map(say).join("; ")} (risk ${risk}/100).`;
    else because = `Independent signals in ${categories.length} categories (${categories.join(", ")}) put the risk at ${risk}/100.`;
  } else if (risk >= config.bands.review || strong.length || (floor && CLASS_ORDER[floor] >= CLASS_ORDER.REVIEW)) {
    verdict = "REVIEW";
    if (inBand && !enough) {
      because = `Risk ${risk}/100 is in the flagging band, but it rests on ${cf.length} ${cf.length === 1 ? "signal" : "signals"} that are weak or correlated (${categories.length} categor${categories.length === 1 ? "y" : "ies"}); a person should look before excluding.`;
    } else if (strong.length && !confidentStrong.length) {
      because = `${strong.map(say).join("; ")} — measured against ${strong[0]!.caveat ?? "an estimate"}, so not conclusive on its own.`;
    } else {
      because = `Risk ${risk}/100 from ${cf.length} ${cf.length === 1 ? "signal" : "signals"}: ${ranked.slice(0, 3).map(say).join("; ")}.`;
    }
  } else {
    verdict = "PASS";
    because = cf.length
      ? `Only ${cf.length === 1 ? "one weak signal" : `${cf.length} weak signals`} (risk ${risk}/100); nothing that would call this response into question.`
      : informational
        ? `No signal affects the classification; ${informational} noted for information.`
        : "No quality signals.";
  }

  return {
    verdict,
    evidence: {
      strong: strong.length, moderate: moderate.length, weak: weak.length, informational,
      categories, because,
      carriedBy: ranked.slice(0, 5).map((f) => f.ruleId),
    },
  };
}

/**
 * The five-class classification, consistent with the verdict: a response
 * that is not FLAGGED reads no worse than REVIEW whatever its raw band, and a
 * FLAGGED one reads at least SUSPICIOUS.
 */
export function classify(risk: number, config: QualityConfig, floor?: QualityClass, verdict?: QualityVerdict): QualityClass {
  let c = bandClass(risk, config);
  if (floor && CLASS_ORDER[floor] > CLASS_ORDER[c]) c = floor;
  if (verdict === "PASS" && CLASS_ORDER[c] > CLASS_ORDER.CLEAN) c = "CLEAN";
  if (verdict === "REVIEW" && CLASS_ORDER[c] > CLASS_ORDER.REVIEW) c = "REVIEW";
  if (verdict === "REVIEW" && CLASS_ORDER[c] < CLASS_ORDER.REVIEW) c = "REVIEW";
  if (verdict === "FLAGGED" && CLASS_ORDER[c] < CLASS_ORDER.SUSPICIOUS) c = "SUSPICIOUS";
  return c;
}

export function recommendation(cls: QualityClass, quality: number, verdict?: QualityVerdict): "INCLUDE" | "REVIEW BEFORE INCLUSION" | "LIKELY EXCLUDE" {
  if (verdict) {
    if (verdict === "FLAGGED") return cls === "CRITICAL" || cls === "HIGHLY_SUSPICIOUS" ? "LIKELY EXCLUDE" : "REVIEW BEFORE INCLUSION";
    if (verdict === "REVIEW" || quality < 50) return "REVIEW BEFORE INCLUSION";
    return "INCLUDE";
  }
  if (cls === "CRITICAL" || cls === "HIGHLY_SUSPICIOUS") return "LIKELY EXCLUDE";
  if (cls === "SUSPICIOUS" || cls === "REVIEW" || quality < 50) return "REVIEW BEFORE INCLUSION";
  return "INCLUDE";
}

/**
 * The "Reasons:" list — classifying flags first, most important first, each
 * one sentence with the numbers; then what was noted but did not count.
 */
export function reasons(flags: QualityFlag[]): string[] {
  const order = (a: QualityFlag, b: QualityFlag) => (b.riskPoints + b.qualityPenalty) - (a.riskPoints + a.qualityPenalty) || SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
  const line = (f: QualityFlag) => `${f.title}: ${f.observed}${f.expected ? ` (expected ${f.expected})` : ""}${f.confidence < 1 && f.caveat ? ` — ${f.caveat}` : ""}.`;
  const cf = classifying(flags).sort(order).map(line);
  const inf = flags.filter((f) => f.role === "informational").sort(order).map((f) => `${line(f).slice(0, -1)} — noted, does not affect the classification.`);
  return [...cf, ...inf];
}

export function strictnessLabel(s: Strictness): string {
  return { relaxed: "Relaxed", standard: "Standard", strict: "Strict", very_strict: "Very strict", custom: "Custom" }[s];
}
