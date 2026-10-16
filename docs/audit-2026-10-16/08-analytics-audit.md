# 08 · Analytics audit — bases, statistics, plan integration, exports

Evidence: `raw/analytics.md`, controlled dataset `docs/audit-2026-10-16/repro/analytics/controlled.mjs` (84 hand-computed checks), orchestrator read-only SQL on the active project. Tests: `@rescript/analytics` 465/465; Studio analytics libs 31/31.

## Base rules as implemented (verified)
- Base = respondents who **answered** the variable(s). Not-asked (display logic) and skipped are both `null` → both excluded → indistinguishable (ANALYTICS-01; a design limitation, worth surfacing as "not asked" separately).
- Multi-select: respondent base; no mentions-base option.
- Numeric mean: valid numeric values only. Matrix row: answered that row.
- Crosstab cell: column base = answered both row and column variable; row/column/total percent bases all verified; with a layer variable `validN` falls back to "answered any" (ANALYTICS-13).
- Filters/segments: filtered base; segment n = cases in segment, not answered base (ANALYTICS-03).
- Weighted: zero-weight cases excluded; tests run unweighted and are labelled so.
- Default dataset scope: `status=complete`, `environment=LIVE`, quality `clean` optional, version-pinned rows read through the **draft** definition (ANALYTICS-12).
- Controlled dataset: 83/84 checks match hand-computed values across `buildDataset`, `frequencies`, `describe`, `crosstab` (col/row/base=all/multi/mean), filters, segments, partials, weighting, `topbox`, `statisticalTest`. The one mismatch is ANALYTICS-03.

## The "base of 20"
- No hard-coded 20 / `LIMIT 20` / `slice(0,20)` affects any base (`listRuns(limit=20)`, docx row cap 20 and a "<20 open ends" warning are unrelated).
- Read-only DB check (project `gouxrdjpiejuliucqwoy`): `analytics_runs` holds one run (Test10, LIVE, n=0 on 2026-10-09, legitimately before data existed); `analytics_result_cache` holds 36 payloads for one survey, all n=0 (its single response is a test row); no stored result with n=20. Largest survey (T&L Brand Tracker, 43 rows, all TEST): completes 32; on current version 31; quality PASS 2 / FLAGGED 14 / REVIEW 15; answered per question 24–31. Possible scopes yield 0 (LIVE default), 2 (clean = PASS only), 17, 24 (gated question), 31 — never 20.
- Conclusion: not reproducible from stored data; the class of defect is **scope reducing the base without the caption saying so** (environment, status, quality, answered-only, version). One real display defect was found: topbox/CSAT/ranking/allocation/segmentation tables carry the all-cases base while the header shows the answered n (ANALYTICS-02). Fix the class with one base-caption component that always prints `n = X answered · of Y in scope (completes · LIVE · clean)` and records scope in `analytics_runs` (OR-03).

## Analysis-plan integration (ANALYTICS-05/06/07)
Stored in `research.analysisPlan` → `planBridge` maps to analyses → `plan/run` executes → results displayed → exports. Working. Defects: a plan item naming a question by **code** passes validation but runs as "not in dictionary" with base 0 and no error code; manual runs execute blocked items; weighting taken from `items[0]` only. Missing variables are reported as warnings, not errors.

## Statistics
Full catalogue present and tested: chi-square (Cochran rule, Fisher 2×2), Welch/Student/paired t, one-way and two-way (Type II) ANOVA, Mann-Whitney, Wilcoxon, Kruskal-Wallis, Friedman, proportion z, correlation, regression; Holm-adjusted significance letters per column family; assumptions noted in table notes. Conjoint/MaxDiff: aggregate conditional logit (Newton-Raphson, ridge), limitations stated; MaxDiff has the P1 defects METHOD-02/03; ACBC/menu have no estimator (METHOD-06).

## Consistency and cache
Dashboard, charts, crosstabs, pptx/xlsx/docx, story and findings all consume one `compute()`/`runAnalysis` — no re-implemented frequency logic (ANALYTICS-10). Discoveries/`dataQuery` do their own unweighted counts (labelled). Cache invalidates by input hash (count + newest `updated_at`, version/revision/source, engine version, definition hash); `responses_touch` trigger covers quality/review updates; `expires_at` rows never swept (SCHEMA-09).
