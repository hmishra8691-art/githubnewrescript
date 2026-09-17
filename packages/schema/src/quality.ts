import { z } from "zod";
import { Condition } from "./conditions.js";

/**
 * Response Quality & Fraud Detection — the CONFIGURATION half of the model.
 *
 * Everything the researcher can decide lives here, inside the survey
 * definition (`def.quality`), so it versions, autosaves, exports and previews
 * with the survey like every other feature area. The engine that reads it is
 * `@rescript/quality`; the runtime's event collector reads only
 * `quality.telemetry` (what it is allowed to record).
 *
 * Two principles the shape enforces:
 *   - every rule has an id, an enabled flag, a severity, a weight and its own
 *     thresholds, so "Custom" strictness is just a table of these values and
 *     the presets are values too (see `STRICTNESS_PRESETS` in the engine);
 *   - a result is never a verdict. The engine produces two separate scores
 *     (quality 0–100 where 100 is best; fraud risk 0–100 where 100 is worst)
 *     plus a classification derived from configurable bands, and every flag
 *     carries its observed value, benchmark, severity and contribution.
 */

export const Strictness = z.enum(["relaxed", "standard", "strict", "very_strict", "custom"]);
export type Strictness = z.infer<typeof Strictness>;

export const Severity = z.enum(["low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof Severity>;

export const QualityClass = z.enum(["CLEAN", "REVIEW", "SUSPICIOUS", "HIGHLY_SUSPICIOUS", "CRITICAL"]);
export type QualityClass = z.infer<typeof QualityClass>;

/** The categories every built-in rule belongs to — also the dashboard's columns. */
export const QualityCategory = z.enum([
  "timing", "matrix", "consistency", "pattern", "attention", "open_end",
  "interaction", "navigation", "device", "network", "bot", "duplicate", "cluster", "screener", "custom",
]);
export type QualityCategory = z.infer<typeof QualityCategory>;

/**
 * Per-rule settings. `params` are the rule's own thresholds (documented on the
 * rule in the engine's catalogue); `weight` scales its risk contribution and
 * `qualityWeight` its quality penalty. A rule that is not listed here runs
 * with the preset's defaults for the chosen strictness.
 */
/**
 * What a rule's firing is FOR.
 *
 * `classifying` — it counts toward the fraud-risk score and can move the
 * verdict. `informational` — it is shown as evidence and costs quality
 * points, but it never moves the classification on its own. A pasted answer,
 * one shared IP address, agreeing with every item on a satisfaction grid: real
 * observations, poor grounds for calling a person fraudulent.
 */
export const RuleRole = z.enum(["classifying", "informational"]);
export type RuleRole = z.infer<typeof RuleRole>;

export const RuleSetting = z.object({
  enabled: z.boolean().optional(),
  severity: Severity.optional(),
  /** whether the rule may move the classification, or only inform it */
  role: RuleRole.optional(),
  /** multiplier on the rule's fraud-risk points (1 = as designed) */
  weight: z.number().min(0).max(5).optional(),
  /** multiplier on the rule's quality penalty */
  qualityWeight: z.number().min(0).max(5).optional(),
  params: z.record(z.union([z.number(), z.string(), z.boolean()])).optional(),
  /** restrict the rule to these question ids (empty = all applicable) */
  questionIds: z.array(z.string()).optional(),
});
export type RuleSetting = z.infer<typeof RuleSetting>;

/**
 * A researcher-authored rule: an ordinary survey Condition (the same tree,
 * parser and evaluator as display logic) evaluated over the response, where
 * the quality metrics are exposed as calculations — `calc.SYSTEM_SPEEDER_SCORE
 * > 60 AND calc.SYSTEM_ATTENTION_FAILED >= 1`. When it holds, the rule adds
 * risk points / a quality penalty and optionally forces a classification floor.
 */
export const CustomQualityRule = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().default(true),
  when: Condition,
  severity: Severity.default("medium"),
  riskPoints: z.number().min(0).max(100).default(20),
  qualityPenalty: z.number().min(0).max(100).default(10),
  /** at least this classification when the rule fires */
  minClass: QualityClass.optional(),
  explanation: z.string().optional(),
  questionIds: z.array(z.string()).default([]),
});
export type CustomQualityRule = z.infer<typeof CustomQualityRule>;

/** Fraud-risk bands → classification. Upper bounds, inclusive, ascending. */
export const ClassificationBands = z.object({
  review: z.number().min(0).max(100).default(20),
  suspicious: z.number().min(0).max(100).default(40),
  highlySuspicious: z.number().min(0).max(100).default(60),
  critical: z.number().min(0).max(100).default(80),
});
export type ClassificationBands = z.infer<typeof ClassificationBands>;

/** What the runtime may record. Everything is derived metadata — never clipboard contents. */
export const TelemetryConfig = z.object({
  timing: z.boolean().default(true),
  focus: z.boolean().default(true),
  clipboard: z.boolean().default(true),
  navigation: z.boolean().default(true),
  interaction: z.boolean().default(true),
  device: z.boolean().default(true),
  /** hash the respondent's IP (salted) — never the raw address */
  network: z.boolean().default(true),
  /** text shown in the runtime footer, e.g. "This survey records response timing to protect data quality." */
  disclosure: z.string().optional(),
});
export type TelemetryConfig = z.infer<typeof TelemetryConfig>;

export const PrivacyConfig = z.object({
  /** days to keep raw telemetry after completion; 0 = keep (scores are kept regardless) */
  telemetryRetentionDays: z.number().int().min(0).default(0),
  /** link quality history across studies for the same external respondent id */
  longitudinal: z.boolean().default(false),
});
export type PrivacyConfig = z.infer<typeof PrivacyConfig>;

/**
 * HOW SIGNALS COMBINE INTO A VERDICT — the settings that decide whether a
 * respondent who merely answered quickly from an office network reads as
 * "fast" or as "fraud".
 *
 * `combination`: `correlated` treats signals within one category as views of
 * the same fact (five ways of saying "fast" is one fact, not five), taking
 * the strongest plus a fraction of the rest, and only then combining
 * categories as independent evidence. `independent` is the old noisy-OR
 * over every flag — every signal counted in full.
 *
 * `minPeers`: below this many completes the timing benchmark is the
 * definition's reading-time estimate, which assumes every word is read; a
 * flag against an estimate carries `estimateConfidence` and its points are
 * scaled by it.
 *
 * `minPopulation`: share-of-completes rules (one IP's share, one device's
 * share) are informational until this many completes exist — "7 of 7 from
 * one IP" is a test session, not a farm.
 *
 * `flagged`: what it takes to be FLAGGED rather than merely REVIEW.
 * `strong_or_two_categories` requires at least one strong classifying flag
 * (high-point, confident) or moderate classifying flags in at least
 * `flaggedMinCategories` distinct categories, on top of the risk band.
 * `bands_only` trusts the risk score alone.
 */
export const EvidenceConfig = z.object({
  combination: z.enum(["correlated", "independent"]).default("correlated"),
  minPeers: z.number().int().min(8).max(500).default(30),
  estimateConfidence: z.number().min(0.1).max(1).default(0.6),
  minPopulation: z.number().int().min(5).max(2000).default(30),
  flagged: z.enum(["strong_or_two_categories", "bands_only"]).default("strong_or_two_categories"),
  flaggedMinCategories: z.number().int().min(1).max(5).default(2),
});
export type EvidenceConfig = z.infer<typeof EvidenceConfig>;

/** The three-way verdict a researcher acts on. The five-class scale stays underneath it. */
export const QualityVerdict = z.enum(["PASS", "REVIEW", "FLAGGED"]);
export type QualityVerdict = z.infer<typeof QualityVerdict>;

export const QualityConfig = z.object({
  enabled: z.boolean().default(false),
  strictness: Strictness.default("standard"),
  evidence: EvidenceConfig.default({}),
  /** a saved profile this config was taken from (informational) */
  profile: z.string().optional(),
  bands: ClassificationBands.default({}),
  /** overrides per built-in rule id */
  rules: z.record(RuleSetting).default({}),
  customRules: z.array(CustomQualityRule).default([]),
  telemetry: TelemetryConfig.default({}),
  privacy: PrivacyConfig.default({}),
  /** peers considered for similarity / clustering (newest complete responses) */
  maxPeers: z.number().int().min(50).max(20000).default(3000),
});
export type QualityConfig = z.infer<typeof QualityConfig>;

/**
 * A question marked as an attention check. `expected` is the answer that
 * passes — codes for choice questions, a value (or list) otherwise; `text`
 * checks compare case-insensitively. Instruction-following checks ("select
 * the third option") are the same thing with the instruction in the text.
 */
export const AttentionCheck = z.object({
  kind: z.enum(["explicit", "instruction", "trap", "reverse", "repeat", "knowledge"]).default("explicit"),
  /** passing codes / values; for `trap` these are the codes that FAIL (impossible options) */
  expected: z.array(z.union([z.string(), z.number()])).default([]),
  /** for `repeat`: the earlier question this one must agree with */
  pairedQuestionId: z.string().optional(),
  severity: Severity.default("high"),
  riskPoints: z.number().min(0).max(100).default(25),
  qualityPenalty: z.number().min(0).max(100).default(20),
});
export type AttentionCheck = z.infer<typeof AttentionCheck>;
