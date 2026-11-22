/**
 * PUBLISHED LIMITS (Level 5 roadmap M10 — 2026-11-29).
 *
 * Every size limit and reading threshold the analytics engine enforces, and every test that checks the engine
 * against an outside reference, with its tolerance. Each limit is the engine's own constant, imported — not a copy —
 * so the published value cannot differ from the enforced one. docs/ANALYTICS-LIMITS.md is generated from this file
 * (`limitsMarkdown()`), and a test fails if the document and the code disagree.
 */
import { MIN_BASE } from "./analyses/common.js";
import { MAX_MODEL_RESPONDENTS } from "./analyses/choice.js";
import { HIERARCHICAL_MAX_ROWS } from "./analyses/statistics.js";
import { TURF_EXHAUSTIVE_ITEMS, NPS_MIN_CI_N } from "./analyses/business.js";
import { MAX_SHAPLEY } from "./stats/relativeImportance.js";
import { BENCHMARK_FLOOR } from "./benchmark.js";
import { MODEL_MIN_CELL } from "./redact.js";
/* from shared.ts, never pptx.ts: pptx pulls pptxgenjs (node:https) into every page that imports this package */
import { MAX_EMBEDDED_IMAGE_BYTES } from "./export/shared.js";
import { TRANSCRIPT_MAX_CHARS, TRANSCRIPT_MAX_TURNS } from "./qual/transcripts.js";
import { REEL_MAX_ITEMS } from "./qual/highlights.js";

/** responses read into one analysis dataset; above it the dataset says it was truncated (Studio's loader uses this) */
export const ANALYTICS_MAX_ROWS = 250_000;

export interface PublishedLimit { area: string; limit: string; value: number; unit: string; whenExceeded: string; source: string }
export interface ReferenceCheck { what: string; reference: string; tolerance: string; test: string }

export const PUBLISHED_LIMITS: PublishedLimit[] = [
  { area: "Data", limit: "Responses in one analysis dataset", value: ANALYTICS_MAX_ROWS, unit: "responses", whenExceeded: "The first responses by start time are read and every result built on them carries a warning saying so.", source: "limits.ts" },
  { area: "Reading", limit: "Smallest base read without a caution", value: MIN_BASE, unit: "respondents", whenExceeded: "Below it, the result carries a 'read with caution' warning; crosstab columns below it carry no significance letters.", source: "analyses/common.ts" },
  { area: "Reading", limit: "Smallest base for an NPS confidence interval", value: NPS_MIN_CI_N, unit: "respondents", whenExceeded: "Below it, NPS is shown without an interval.", source: "analyses/business.ts" },
  { area: "Privacy", limit: "Smallest group a benchmark is shown for", value: BENCHMARK_FLOOR, unit: "people", whenExceeded: "The group is hidden, with complementary suppression so it cannot be derived.", source: "benchmark.ts" },
  { area: "Privacy", limit: "Smallest group the AI may describe", value: MODEL_MIN_CELL, unit: "respondents", whenExceeded: "The figure is withheld from the model and from any text it writes.", source: "redact.ts" },
  { area: "Models", limit: "Respondents modelled in conjoint / MaxDiff", value: MAX_MODEL_RESPONDENTS, unit: "respondents", whenExceeded: "An even sample of respondents is modelled; counts still use everyone.", source: "analyses/choice.ts" },
  { area: "Models", limit: "Drivers in Shapley / LMG relative importance", value: MAX_SHAPLEY, unit: "drivers", whenExceeded: "Shapley is left out (it enumerates 2^p subsets); relative weights are still given.", source: "stats/relativeImportance.ts" },
  { area: "Models", limit: "Complete cases for hierarchical clustering", value: HIERARCHICAL_MAX_ROWS, unit: "cases", whenExceeded: "Refused with a message naming k-means, which handles the size.", source: "analyses/statistics.ts" },
  { area: "Models", limit: "Items searched exhaustively by TURF", value: TURF_EXHAUSTIVE_ITEMS, unit: "items", whenExceeded: "Greedy forward selection instead of every combination; the best set may be missed.", source: "analyses/business.ts" },
  { area: "Export", limit: "Image embedded in a PowerPoint slide", value: MAX_EMBEDDED_IMAGE_BYTES, unit: "bytes", whenExceeded: "The image is left out of the slide.", source: "export/shared.ts" },
  { area: "Qualitative", limit: "Characters in one transcript", value: TRANSCRIPT_MAX_CHARS, unit: "characters", whenExceeded: "Only the first part is imported, with a warning.", source: "qual/transcripts.ts" },
  { area: "Qualitative", limit: "Turns in one transcript", value: TRANSCRIPT_MAX_TURNS, unit: "turns", whenExceeded: "Only the first turns are imported, with a warning.", source: "qual/transcripts.ts" },
  { area: "Qualitative", limit: "Clips in one highlight reel", value: REEL_MAX_ITEMS, unit: "clips", whenExceeded: "Adding more is refused.", source: "qual/highlights.ts" },
];

/** only checks a test in this package asserts; `test` is the file, relative to src/ */
export const REFERENCE_CHECKS: ReferenceCheck[] = [
  { what: "Normal, t, χ² and F distributions; chi-square, Fisher, t-tests, correlations", reference: "R and scipy", tolerance: "1e-3 (most within 1e-6)", test: "stats/stats.test.ts" },
  { what: "Fisher's exact p on small 2×2 tables; Mann–Whitney with ties", reference: "scipy 1.17", tolerance: "1e-9", test: "stats/phase7.test.ts" },
  { what: "Normal CDF and inverse; proportion tests", reference: "scipy, statsmodels", tolerance: "1e-15", test: "stats/auditFixes.test.ts" },
  { what: "Bootstrap of an indirect effect (percentile and BCa intervals)", reference: "the same generator re-implemented in Python, numpy, scipy", tolerance: "1e-9", test: "stats/bootstrap.test.ts" },
  { what: "McDonald's ω on the Holzinger–Swineford CFA", reference: "published semTools reliability()", tolerance: "2e-5", test: "models/omega.test.ts" },
  { what: "SEM estimates, standard errors and fit", reference: "Python reference fit and published lavaan output", tolerance: "estimates and SEs 1e-4; χ² 1e-3; CFI/TLI/RMSEA/SRMR 1e-4", test: "models/sem.test.ts" },
  { what: "Van Westendorp, Newton–Miller–Smith and Gabor–Granger", reference: "hand-computed textbook values", tolerance: "exact to the stated decimals", test: "analyses/pricingModels.test.ts" },
  { what: "Conjoint part-worths recovered from data with known utilities", reference: "the generating utilities", tolerance: "as asserted per method in the test", test: "analyses/conjointRecovery.test.ts" },
  { what: "MaxDiff utilities recovered from data with known utilities", reference: "the generating utilities", tolerance: "as asserted in the test", test: "analyses/maxdiffRecovery.test.ts" },
];

const fmt = (n: number) => n.toLocaleString("en-GB");

export function limitsMarkdown(): string {
  const out = [
    "# Analytics limits and reference checks",
    "",
    "Generated from `packages/analytics/src/limits.ts`. Each limit is the engine's own constant, so this page and the",
    "product cannot disagree; a test fails if this file is not regenerated after a change.",
    "",
    "## Limits",
    "",
    "| Area | Limit | Value | When it is exceeded | Defined in |",
    "|---|---|---|---|---|",
    ...PUBLISHED_LIMITS.map((l) => `| ${l.area} | ${l.limit} | ${fmt(l.value)} ${l.unit} | ${l.whenExceeded} | \`${l.source}\` |`),
    "",
    "## Checked against outside references",
    "",
    "Each row is asserted by a test in `packages/analytics/src/`; the tolerance is the one the test uses.",
    "",
    "| What | Reference | Tolerance | Test |",
    "|---|---|---|---|",
    ...REFERENCE_CHECKS.map((r) => `| ${r.what} | ${r.reference} | ${r.tolerance} | \`${r.test}\` |`),
    "",
    "## Not covered",
    "",
    "- Hierarchical Bayes and latent class models are checked by parameter recovery and convergence diagnostics, not against another package's output.",
    "- Weighted significance tests use the effective base; they have not been compared with SPSS Complex Samples.",
    "- AI-written text (summaries, explanations) is not a statistical output and has no tolerance here.",
    "",
  ];
  return out.join("\n");
}
