# Data Analytics audit — September 2026

The audit the R Studio upgrade started from. Baseline: 102 engine tests and
the 45-check browser suite green on `b8e54e4`.

## Confirmed engine / API bugs (fixed in this cycle)

| # | Where | What | Fix |
|---|---|---|---|
| A1 | `analyses/statistics.ts` segment profile | weighted means misaligned with weights when values are missing | pass the unfiltered column to `describe` |
| A2 | `analyses/statistics.ts` factor | % variance / cumulative multiplied by 100 twice | drop the second `* 100` |
| A3 | `dataset.ts` / `stats/multivariate.ts` | rim weighting `efficiency` is a proportion, consumers expect percent → every rim-weighted result warns "efficiency 1%" | store percent in `applyWeighting` |
| A4 | `analyses/basics.ts` crosstab | `measure: "mean"` ignored for scale rows; numeric rows ignore measure | branch on measure; scale rows get a Mean row via `numericColumn` |
| A5 | crosstab letters | letters from unweighted counts beside weighted % | weighted proportions with effective n |
| A6 | crosstab numeric rows | SD unweighted beside weighted mean | `describe(vals, ws)` |
| A7 | `analyses/index.ts` / `common.ts` | `base.total` differs between success and error paths; `filtered` always equals `n` | `total` = dataset in scope, `filtered` = after filter, `n` = valid |
| A8 | route `export` | unknown `format` silently returns PPTX | validate |
| A9 | `TEST_LABEL` | `wilcoxon_signed_rank` vs `wilcoxon` → raw id printed | key fixed |
| A10 | insights | "could not be testedly different" | sentence per case |
| A11 | letters | >26 columns reuse letters | `aa, ab…` |
| A12 | `lib/analytics.ts loadTheme` | theme looked up by id only → cross-customer read | scope by survey / customer |
| B1 | route `GET shares` | returns `token` to `analytics.read` roles without export rights | token only with `analytics.publish` |
| B2 | `lib/analytics.ts rowCache` | bounded by entry count, not bytes | byte budget |
| B3 | `basics.ts` crosstab | chi-square keeps all-zero columns | drop them |

## Kept as documented behaviour (not bugs)

- `ne` / `notIn` / `notSelected` are true for unanswered respondents (engine semantics, same as runtime logic).
- Inferential tests (t, ANOVA, chi-square, regression…) are unweighted even when descriptives are weighted; the tables now say so.
- `variables` counts are per environment; the run reports the real base.

## Capability gaps closed by the crosstab upgrade

Banner layout (all column variables side by side), row nesting, base
selection (answered / all with a "No answer" row), suppression below a
minimum base, row sorting, summary rows for scales (mean, top-2, bottom-2,
net), total row, counts under percentages, decimals, weighted significance
with effective n, letters beyond 26 columns, heat shading and significance
highlighting as saved formatting. All new options default to the old
behaviour, so a saved analysis reproduces its previous table.

## Workspace redesign

Analyses rail (search, new, open, duplicate, rename, reorder, delete) →
Builder (type · variables · filters · segments · options, in one scrollable
page) → Results → Visualization → Export, with an unsaved indicator. The
ten workspace tabs, the saved-analysis contract, reports, themes, sharing
and both export formats are unchanged.
