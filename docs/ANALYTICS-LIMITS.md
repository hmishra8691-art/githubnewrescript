# Analytics limits and reference checks

Generated from `packages/analytics/src/limits.ts`. Each limit is the engine's own constant, so this page and the
product cannot disagree; a test fails if this file is not regenerated after a change.

## Limits

| Area | Limit | Value | When it is exceeded | Defined in |
|---|---|---|---|---|
| Data | Responses in one analysis dataset | 250,000 responses | The first responses by start time are read and every result built on them carries a warning saying so. | `limits.ts` |
| Reading | Smallest base read without a caution | 30 respondents | Below it, the result carries a 'read with caution' warning; crosstab columns below it carry no significance letters. | `analyses/common.ts` |
| Reading | Smallest base for an NPS confidence interval | 10 respondents | Below it, NPS is shown without an interval. | `analyses/business.ts` |
| Privacy | Smallest group a benchmark is shown for | 10 people | The group is hidden, with complementary suppression so it cannot be derived. | `benchmark.ts` |
| Privacy | Smallest group the AI may describe | 5 respondents | The figure is withheld from the model and from any text it writes. | `redact.ts` |
| Models | Respondents modelled in conjoint / MaxDiff | 25,000 respondents | An even sample of respondents is modelled; counts still use everyone. | `analyses/choice.ts` |
| Models | Drivers in Shapley / LMG relative importance | 12 drivers | Shapley is left out (it enumerates 2^p subsets); relative weights are still given. | `stats/relativeImportance.ts` |
| Models | Complete cases for hierarchical clustering | 1,500 cases | Refused with a message naming k-means, which handles the size. | `analyses/statistics.ts` |
| Models | Items searched exhaustively by TURF | 12 items | Greedy forward selection instead of every combination; the best set may be missed. | `analyses/business.ts` |
| Export | Image embedded in a PowerPoint slide | 6,291,456 bytes | The image is left out of the slide. | `export/shared.ts` |
| Qualitative | Characters in one transcript | 2,000,000 characters | Only the first part is imported, with a warning. | `qual/transcripts.ts` |
| Qualitative | Turns in one transcript | 20,000 turns | Only the first turns are imported, with a warning. | `qual/transcripts.ts` |
| Qualitative | Clips in one highlight reel | 100 clips | Adding more is refused. | `qual/highlights.ts` |

## Checked against outside references

Each row is asserted by a test in `packages/analytics/src/`; the tolerance is the one the test uses.

| What | Reference | Tolerance | Test |
|---|---|---|---|
| Normal, t, χ² and F distributions; chi-square, Fisher, t-tests, correlations | R and scipy | 1e-3 (most within 1e-6) | `stats/stats.test.ts` |
| Fisher's exact p on small 2×2 tables; Mann–Whitney with ties | scipy 1.17 | 1e-9 | `stats/phase7.test.ts` |
| Normal CDF and inverse; proportion tests | scipy, statsmodels | 1e-15 | `stats/auditFixes.test.ts` |
| Bootstrap of an indirect effect (percentile and BCa intervals) | the same generator re-implemented in Python, numpy, scipy | 1e-9 | `stats/bootstrap.test.ts` |
| McDonald's ω on the Holzinger–Swineford CFA | published semTools reliability() | 2e-5 | `models/omega.test.ts` |
| SEM estimates, standard errors and fit | Python reference fit and published lavaan output | estimates and SEs 1e-4; χ² 1e-3; CFI/TLI/RMSEA/SRMR 1e-4 | `models/sem.test.ts` |
| Van Westendorp, Newton–Miller–Smith and Gabor–Granger | hand-computed textbook values | exact to the stated decimals | `analyses/pricingModels.test.ts` |
| Conjoint part-worths recovered from data with known utilities | the generating utilities | as asserted per method in the test | `analyses/conjointRecovery.test.ts` |
| MaxDiff utilities recovered from data with known utilities | the generating utilities | as asserted in the test | `analyses/maxdiffRecovery.test.ts` |

## Not covered

- Hierarchical Bayes and latent class models are checked by parameter recovery and convergence diagnostics, not against another package's output.
- Weighted significance tests use the effective base; they have not been compared with SPSS Complex Samples.
- AI-written text (summaries, explanations) is not a statistical output and has no tolerance here.
