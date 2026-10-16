# Analytics audit (Phase 8) — 2026-10-16

Scope: `packages/analytics` (src 24.7k lines incl. tests; 41 test files), `apps/studio/lib/analytics.ts`, `resultCache.ts`, `rowPaging.ts`, `analysisPlanCore.ts`, `apps/studio/app/api/surveys/[id]/analytics/[[...path]]/route.ts`, `apps/studio/components/analytics/*`, migrations 0050–0053.

Test run (cited):
```
$ pnpm --filter @rescript/analytics test 2>&1 | tail -5
# pass 465
# fail 0
# cancelled 0
# skipped 0
# todo 0
```
(465 tests across 41 files, 96.7 s; `dist` is current — no `src` file newer than `dist/index.js`.)
Studio lib: `node --experimental-strip-types --test lib/resultCache.test.ts lib/analyticsRunStore.test.ts lib/rowPaging.test.ts lib/analysisPlanCore.test.ts` → 31 pass, 0 fail.

Scratch scripts (not in repo): `docs/audit-2026-10-16/repro/analytics/controlled.mjs` (controlled dataset, 84 checks), `docs/audit-2026-10-16/repro/analytics/plan.mjs` (plan integration). Outputs in `docs/audit-2026-10-16/repro/analytics/*.out`.

## Findings table

| ID | Area | Classification | Severity | Summary |
|---|---|---|---|---|
| ANALYTICS-01 | Base rules | IMPLEMENTED | — | Base = respondents who ANSWERED the variable(s); not-asked (display logic) and skipped are indistinguishable and both excluded. Verified on controlled dataset (83/84 checks). |
| ANALYTICS-02 | Base display | BROKEN (repro) | P2 | Topbox / CSAT / ranking / allocation / segmentation tables carry `base.n = ds.cases.length` (all cases) while the result header carries the answered n. Same screen / same xlsx sheet shows two bases (30 vs 25). |
| ANALYTICS-03 | Segments | PARTIAL (repro) | P3 | `segments[].n` is the number of CASES in the segment, not the answered base of the analysed variable (15 shown where 10 answered); the low-base warning uses that number. |
| ANALYTICS-04 | "Base of 20" | UNVERIFIED (no DB) | P2 | No hard-coded 20 / LIMIT 20 / slice(0,20) affects any base. Most plausible sources are dataset-scope defaults (completes only, LIVE only, "clean"), draft-definition reads, or multi-version reads. Queries to confirm listed below. |
| ANALYTICS-05 | Plan → run | BROKEN (repro) | P2 | A plan item naming a question by CODE (`Q6`) passes validation (`surveyKnownNames` admits codes) but runs as "Variable Q6 is not in this survey's dictionary", base 0, `error` unset. |
| ANALYTICS-06 | Plan → run | PARTIAL (repro) | P3 | `POST plan/run` (manual) and `runPlan` do not filter blocked items: analyses referencing non-existent variables run, produce empty results with `error` undefined, and their warnings are merged into the run. Only `applyPlan` excludes them. |
| ANALYTICS-07 | Plan run dataset | PARTIAL (code) | P3 | `runPlanFor` builds the dataset from `items[0].definition` (`analytics.ts:430`), so weighting on the first planned item applies to the whole run; weighting on any other item is ignored. |
| ANALYTICS-08 | Stat tests | IMPLEMENTED | — | chi-square (Cochran rule, Fisher fallback for 2×2), Welch/Student t, paired t, one-way & two-way (Type II) ANOVA, Mann-Whitney, Wilcoxon, Kruskal-Wallis, Friedman, proportion z, Cochran-Armitage, Pearson/Spearman/Kendall, OLS/logistic/multinomial/mediation, factor, alpha, k-means/hierarchical, rim weighting. Letters Holm-adjusted per column family. Tests are unweighted and say so. |
| ANALYTICS-09 | Conjoint/MaxDiff | IMPLEMENTED (aggregate only) | P3 | Aggregate conditional logit (Newton-Raphson, ridge). No HB / individual utilities; MaxDiff per-respondent scores are count-based. Limitations documented in table notes. |
| ANALYTICS-10 | Consistency | IMPLEMENTED | — | Dashboard, charts, crosstabs, exports, story and findings all consume `AnalysisResult` from one `compute()`; no re-implemented frequency logic in the UI or exports. Two side paths compute their own counts (`synthesis.ts` discoveries, `dataQuery.ts`), unweighted. |
| ANALYTICS-11 | Cache | IMPLEMENTED | P3 | Invalidation is by input hash (data stamp = count + newest `updated_at`, survey stamp = version/revision/source, engine version, definition hash). `responses_touch` trigger bumps `updated_at` on every update, so quality/review changes invalidate. Gap: analytics reads the DRAFT definition; `stampCache` map is unbounded (tiny). |
| ANALYTICS-12 | Multi-version | UNVERIFIED (no DB) | P2 | In a draft context `versionId = current_version_id`; rows all on that version are read through the DRAFT, so unsaved draft edits (option code changes, variable renames) reshape live bases. |
| ANALYTICS-13 | Crosstab answered-base with layers | PARTIAL (code) | P3 | With a layer variable `validN` is undefined (`crosstab.ts:519`) and `makeResult` falls back to "answered ANY of the variables", so the header n can exceed the Total column base. |

---

## 1. Base calculation rules (verified)

Source of truth: `packages/analytics/src/dataset.ts`, `stats/descriptive.ts`, `analyses/crosstab.ts`, `analyses/common.ts`.

Pipeline: `loadRows` (status ∈ `spec.statuses ?? ["complete"]`, environment, `deleted_at is null`, optional date range) → `buildDataset` (environment, status, `inAnalyticsDataset` quality/review rule, dataset-level filter) → `rowToCase` (`rowToState` + `flattenVariables`: the exported variable map) → runner.

| Case | Rule | Evidence (file:line) | Controlled result |
|---|---|---|---|
| Single-select | valid n = cases with non-null, non-empty value; `validPct = w/weightedValid`; `pct = w/weightedN` (incl. missing); Missing row = inBase − valid | `descriptive.ts:166-205`, `basics.ts:74-79` | SAT: valid 25, missing 5, each code 20% ✔ |
| Multi-select | RESPONDENT base: a case counts once if ≥1 code; empty array = missing; counts per code; percentages sum >100% (noted) | `descriptive.ts:188-191`, `basics.ts:80` | AWARE base 27 of 30, Beta 55.6%, Σ% = 185% ✔ (no "mentions" base option exists) |
| Matrix single row | each `VAR_<row>` column has its own valid n | `dataset.ts:518 battery`, `descriptive.ts:108` | ITEMS_b valid 26, missing 4, mean 2.92 ✔ |
| Numeric mean | valid numeric only (`Number.isFinite`), NaN and "" are missing; SD Bessel on Kish effective n; CI uses t on nEff−1 | `descriptive.ts:22-31, 119-146` | AGE n 30 mean 34.5 sd 8.80 ✔ |
| Crosstab cells | column base = respondents who answered BOTH row and column variable(s) (`base:"answered"`); `pct_col` = cell/colBase, `pct_row` = cell/rowBase, `pct_total` = cell/Total base; Total column = answered any column var; `base:"all"` adds "No answer" row and bases on everyone answering the column | `crosstab.ts:180-206, 279-297` | SAT×GENDER bases 25/15/10, col%, row% 60/100, base=all 30 + No answer 5 ✔ |
| Multi rows in crosstab | respondent base per column; a respondent adds to every row they ticked; no chi-square for multi | `crosstab.ts:198-205, 407` | Male base 15, Alpha 100% ✔ |
| Multi as column (banner) | respondent appears in every column they ticked; Total counted once | `crosstab.ts:187-189` | not exercised |
| Filtered views | `def.filter` (+ resolved saved `filterIds`) evaluated by the survey engine's `matchesResponseCondition`; `base.total` = dataset cases, `base.filtered` = after filter, `base.n` = answered | `analyses/index.ts:28`, `dataset.ts:398-425`, `common.ts:36` | SAT among males n 15; filtered 15 of total 30 ✔ |
| Segments | `segmentDatasets` → `n = data.cases.length` (cases, not answered) | `basics.ts:110-117, 164-167` | see ANALYTICS-03 |
| Weighted | zero-weight case excluded from base (not "missing"); weighted n = Σw; letters/CI use effective n (Σw)²/Σw²; tests of kind test/correlation/regression/… are unweighted and warn | `descriptive.ts:111-121, 186`, `crosstab.ts:47`, `common.ts:77, 110-112` | SAT weighted base 40, code 1 20%, AGE wmean 34.33, Male weighted base 30 ✔ |
| Completes vs partials | default `statuses = ["complete"]`; partials only when the dataset spec names `in_progress` etc. | `dataset.ts:333`, `analytics.ts:107` | 30 vs 40 cases; AGE incl. partials n 35 ✔ |
| Not asked (display logic) | analytics never evaluates `displayLogic`/`visibleIf`; a question that was not shown has no answer key → null → MISSING. "Not asked" and "skipped" are the same thing in every base. With `base:"all"` both land in "No answer". | `dataset.ts:239-279`, grep: no `displayLogic` reference in `packages/analytics/src` | SPEND valid 15, missing 15 (the 15 not asked); crosstab Female base 0 ✔ |
| Missing / skipped | null, "", NaN, empty array, non-finite → missing; `describe.missing = inBase − n` | `descriptive.ts:183` | ✔ |
| Result header `base.n` | `validN` from the runner (crosstab: Total column base) else `answeredCases` = answered at least ONE of `variablesUsed` | `common.ts:91-93, 468-480` | ✔ |

Only mismatch in the controlled run: ANALYTICS-03 (segment n). Full output: `docs/audit-2026-10-16/repro/analytics/controlled.out` ("PASS 83  MISMATCH 1").

## 2. Controlled dataset

`docs/audit-2026-10-16/repro/analytics/controlled.mjs`: 6 questions (single, multi, numeric, matrix single 2 rows, numeric with `displayLogic` GENDER==1, 5-pt single); 40 rows (30 complete, 10 `in_progress`), deterministic distributions; expected values computed in plain JS; runners called via `runAnalysis` from `packages/analytics/dist`.

Checks by function: `buildDataset` (2), `descriptive/frequencies` (13), `descriptive/describe` (10), `makeResult` (5), `crosstab` pct_col/pct_row/base=all/multi/mean/display-logic (29), `filterDataset` (3), `segmentDatasets` (1 — MISMATCH), partials (3), weighted `frequencies`/`describe`/`crosstab` (6), `topbox/boxShares` (3), `statisticalTest` Welch t vs hand-computed (1), crosstab-vs-test chi-square identical (2).

Mismatch list:
- `segmentDatasets` (via `descriptive`): segment "Females" `n` = 15 (cases), expected 10 (answered SAT). Warning text says "Segment Females (n = 15)".

Noted but passing by design (worth a decision):
- `topbox` table footer base 30, result header n 25 (ANALYTICS-02; `basics.ts:169`).
- `csat` table base 30 vs result base 25 (`business.ts:157`).
- Crosstab chi-square on SAT×GENDER reports `assumptionMet:false` (10 of 10 cells expected <5) and the insight says "may differ (approximate)" — correct behaviour.

## 3. Analysis-plan integration (trace)

| Step | Exists? | Where |
|---|---|---|
| Schema | yes | `packages/schema/src/analysisPlan.ts` — `research.analysisPlan{crosstabs,tests,derived,segments}`; hypotheses are labels "H1".. by position in `research.hypotheses` |
| Stored | yes | in the survey definition (draft / version); `PUT plan` edits via `editPlan` (`analysisPlanService.ts`) |
| Mapped to definitions | yes | `planBridge.ts` `crosstabDefinition`/`testDefinition`/`plannedAnalyses` — names are passed through verbatim (no code→variableName resolution) |
| Derived variables / segments | yes | `plannedVariables.ts withPlannedVariables` — added as dataset columns in `buildFor` (every path) and again in `runPlan` (idempotent); missing sources → warning on the dataset, carried to results that name them (`analyses/index.ts:33-35`) |
| Validated | partial | `planCheck.ts validateAnalysis/reviewPlanned/reviewAgainstSaved`; `planWorkspace.ts:207` state "invalid". Both admit question CODES (`surveyKnownNames` line 143) that the dataset cannot resolve → ANALYTICS-05 |
| Executed | yes | `findings.ts runPlan` → `runAnalysis` per item; `apps/studio/lib/analytics.ts runPlanFor` (saved refinements replace planned defs by `options.planned`); `analysisPlanCore.ts applyPlan` (lock in `analytics_plan_applies`, migration 0050/0053) |
| Stored run | yes | `analytics_runs` (0048/0049), compact (no results); `analytics_plan_applies` summary |
| Displayed | yes | `PlanWorkspace.tsx` (items, variables, hypotheses, findings), `AnalyticsWorkspace.tsx` (saved analyses, charts), dashboard via `planDashboard` |
| Exported | yes | findings report (`reportFromRun`/`draftFindingsReport`) → `analytics_reports` → `POST export` pptx/xlsx (`export/pptx.ts`, `export/xlsx.ts`), story HTML |

What happens when a plan variable does not exist in responses (repro `docs/audit-2026-10-16/repro/analytics/plan.mjs`):
- Variable absent from survey entirely (`REGION`, `NOPE`): `reviewPlanned` blocks with "REGION is not in this survey's data." `applyPlan` marks it `skipped_invalid` and excludes it from the run. But `POST plan/run` → `runPlanFor` → `runPlan` runs it anyway: result has 1 empty table, `base.n = 0`, warnings "Variable REGION is not in this survey's dictionary", `error` undefined; the run's `warnings` carry it (ANALYTICS-06).
- Variable exists as question CODE only (`Q6` for `SAT`): passes validation (kept), saved as an analysis by apply, runs with base 0 and the dictionary warning; `applyPlan` then marks it `failed` through the `failedResult` regex (`analysisPlanCore.ts:360`). `runPlan`'s own item has no error code (ANALYTICS-05). Fix: resolve codes to `variableName` in `planBridge` (or alias codes in `variableMetadata`).
- Variable exists in the dictionary but nobody answered it: runs, base 0, warning "has no respondents in the selected data"; `applyPlan` → status `failed`.
- A derived variable whose source is missing: not computed; dataset warning "BAD: not computed — GHOST is not in the data." attached to any result naming BAD.

## 4. Statistical tests and choice models

`stats/tests.ts`: chi-square (Cochran's rule; Fisher exact for thin 2×2 with whole counts; `assumptionMet`, `pMethod` in detail), Cochran-Armitage trend, one-sample/Welch/Student/paired t, one-way ANOVA (η²), two-way ANOVA Type II (checked against numpy in tests), Mann-Whitney / Wilcoxon / Kruskal-Wallis / Friedman (tie-corrected), proportion z, Wilson CI. `stats/correlation.ts`: Pearson/Spearman/Kendall with CIs. `stats/regression.ts`: OLS, logistic, multinomial, mediation. `stats/multivariate.ts`: PCA/principal axis + varimax, Cronbach's alpha, k-means, hierarchical, rim weighting.

- Assumptions: chi-square expected-count rule enforced and reported; t defaults to Welch (`equalVariance=false`); no normality/Levene check, but `dataAdvice.ts adviseAnalysis` recommends non-parametric alternatives and `runPlan({adapt:true})` runs them beside the planned test. Crosstab refuses means of nominal variables (`crosstab.ts:142-145`).
- Multiple comparisons: `posthoc.ts adjustP` (Holm default, Bonferroni, BH). Crosstab letters: per row, per column-variable family, Holm-adjusted (`crosstab.ts:217-230`); "+/−" vs total likewise; "largest gap" insight requires MIN_BASE 30, adjusted p<α and ≥5 points. `runPlan` applies a correction family across the run (`applyCorrections`) and reports verdicts before/after.
- Weighting: crosstab proportions/means weighted with Kish effective bases; chi-square/ANOVA inside the crosstab use UNWEIGHTED counts and say "(unweighted counts)" (`crosstab.ts:400, 409`); kinds in `UNWEIGHTED_KINDS` (test, correlation, regression, factor, reliability, cluster, conjoint, maxdiff) warn that weights are ignored (`common.ts:77, 110-111`).
- Conjoint (`analyses/choice.ts:39`): aggregate conditional logit, effects-coded, none constant, McFadden R², hit rate, importance, shares via `logitShares`, WTP when a price attribute exists; every k-th respondent beyond 25 000 (warned). No HB, no individual part-worths, no interactions. MaxDiff (`choice.ts:148`): aggregate logit on best + reversed worst, anchored (dual-response) variant with free intercept; per-respondent `score` is a count-based B−W, not a model estimate; relative-scale limitation written into the table notes (`choice.ts:265`).

## 5. Consistency across surfaces

- `apps/studio/lib/analytics.ts compute()` is the single entry (`resolveSaved` → `buildFor` → `runAnalysis` → `adviseChart`), wrapped by `withResultCache`. The route's `run`, `reports/<id>/results`, `publish` (snapshot + viewer-filter variants), `export`, `report-builder/story`, and the plan run all go through it or through `runPlan` → the same `runAnalysis`.
- Consumers read `AnalysisResult` only: `Chart.tsx`, `ProTable.tsx`, `ReportView.tsx` (dashboard widgets and report blocks), `export/pptx.ts`, `export/xlsx.ts`, `export/docx.ts`, `story/charts.ts`, `findings.ts`, `reportPages.ts`. grep for re-implemented `frequencies`/percentage logic in `apps/studio` found none (only chart-local "% of total" tooltips over the result's series).
- Own counting outside the runners: `synthesis.ts` (segment discovery / anomalies / wave trends — raw unweighted counts, no `weights`), `dataQuery.ts` (ask-the-data; `describe` per group, unweighted for groups), `waves.ts kpiSnapshot` (uses `describe` with weights). These feed discoveries/KPIs, not the tables.
- Inconsistency inside one result (ANALYTICS-02): `ResultView.tsx:256` prints `r.base.n` (answered) and `ProTable.tsx:182` prints `table.base.n` (all cases) for topbox/csat/ranking/allocation/segmentation; `xlsx.ts:114` (sheet header, result base) vs `xlsx.ts:37` (table base) reproduce the same pair in one sheet; `pptx.ts:382` prefers `table.base.n`.

## 6. Cache staleness (`analytics_result_cache`, 0052)

Layers (all in `apps/studio/lib/analytics.ts` / `resultCache.ts`):
1. `stampCache` (2 s) → `computeStamp`: `count(*)` + newest `updated_at` of non-deleted responses in the environment.
2. `rowCache` (60 s TTL, 256 MB, keyed survey/env/statuses/dataset/quality/date + stamp) and `coldLoads` single-flight.
3. `datasetCache` (60 s, 8 entries, keyed survey + stamp + `def.dataset` + `def.weighting` + versionId/version + revision).
4. Result memo (300 entries, no TTL) and `analytics_result_cache` (30-day `expires_at`, `engine_version` checked on read, replaced on write) keyed by `inputHashOf(def, {dataVersion: stamp, surveyVersion: versionId:revision:source})`; `hashDefinition` strips id/name/notes/version, so renames share results; `fresh:true` bypasses lookup (`POST run {fresh:true}`).

Invalidation triggers that work: any insert/update/soft-delete of a response (`responses_touch` trigger, `0001_core_schema.sql:284`, bumps `updated_at`; count changes), quality re-classification and KEEP/REMOVE (same trigger), draft autosave (`revision`), new version (`versionId`), engine bump (`ANALYTICS_ENGINE_VERSION`), definition/filter/segment edits (conditions are inlined by `resolveSaved` before hashing), weighting changes (in the definition).

Not covered / caveats:
- Hard-deleted rows with the newest `updated_at` unchanged and count unchanged (delete + insert in the same window) — theoretical.
- The stamp is per environment, not per status/date range: a new partial response invalidates completes-only caches (safe direction, extra recompute).
- `stampCache` grows per survey/env without eviction (bytes, not a correctness issue).
- Published report versions and `analytics_runs` are snapshots by design; `methodFlag` marks results computed by an older engine.
- Analytics reads the DRAFT definition when one exists (`loadDefinition` → `loadQualityDefinition(db, id, "draft")`), so numbers on screen follow unsaved questionnaire edits (ANALYTICS-12).

## 7. "Base of 20" — where it could come from

Searched: `grep -rn "\b20\b"` across `packages/analytics/src`, `apps/studio/lib/analytics*.ts`, `apps/studio/components/analytics`, the route, `resultCache.ts`, `rowPaging.ts`, and `packages/quality/src`. Hits are layout sizes, `listRuns(limit = 20)` (run list, not a base), `claims.ts:100` (number-word parsing), `docx.ts resultTable(maxRows = 20)` (row cap in the Word export — truncates long tables, not bases), `text()` warning threshold (<20 texts), `quality/dataset.ts:218` (fixture prose). No LIMIT 20, page size 20, `slice(0,20)` or default sample size touches a base. Row paging is 1 000/page up to 250 000 with a stable order and a truncation flag.

Plausible sources, in order, with the query that confirms each (needs DB access):
1. Status scope: analytics bases on `status = 'complete'` only; the data grid / overview "responses" counts all statuses. If the questionnaire's end nodes do not set `status: "complete"` (or many respondents stop before the end), base = completes. Confirm: `select status, is_test, count(*) from responses where survey_id = $1 and deleted_at is null group by 1,2`.
2. Environment scope: saved analyses default to `environment: "LIVE"` (`analyticsAsk.ts:33`, plan apply `route.ts:298`); test-link responses are `is_test = true`. Same query.
3. Quality scope: `dataset: "clean"` keeps `classification in (null,'CLEAN')` or `review_status = 'KEEP'`, drops `REMOVE` always. Confirm: `select quality->>'classification', review_status, count(*) ... group by 1,2`.
4. Answered base: a variable gated by display logic / skip logic, or added in a later version, has n = those who answered; the header says "n = 20 · 40 of 40 responses in scope" (`ResultView.tsx:256`) — the second number is the tell.
5. Draft or multi-version read: `resolveAnalyticsVersions` reads rows on `current_version_id` through the draft; a draft that changed option codes of the banner variable drops those respondents from the column base (`crosstab.ts:187` `known.has(key)`). Confirm: `select draft_definition is not null, current_version_id from surveys where id=$1` and `select version_id, count(*) from responses ... group by 1`; compare the banner question's option codes between `survey_versions.definition` and `surveys.draft_definition`.
6. Stale cache: ruled out as a steady-state cause (hash includes count + newest `updated_at`); only a published snapshot or a stored run shows an old n, and both are labelled as such.
7. Segment n (ANALYTICS-03) or table-footer base (ANALYTICS-02) when the "20" appears as a segment count or a table footer rather than the header.

BROWSER-REPRO NEEDED: open the analysis showing base 20, read the header line "n = … · X of Y responses in scope" and the analysis's dataset (environment / quality / statuses) in the builder; then run the status/env/quality query above for the survey.

## Finding details

### ANALYTICS-02 — table base ≠ result base (P2)
- Evidence: `packages/analytics/src/analyses/basics.ts:169` (`base: { n: ds.cases.length }`), `:202`, `:225`; `business.ts:157` (csat); `statistics.ts:460`; versus `common.ts:91-93` (result base = answered).
- Repro: `docs/audit-2026-10-16/repro/analytics/controlled.mjs` → "topbox: table base n = 30", "topbox/makeResult: result.base.n = 25"; csat tables `base:{n:30}` with `result.base.n = 25`.
- Expected: one base per analysis (answered), or the table base labelled "respondents in dataset". Actual: ProTable footer "Base: n = 30", header "n = 25"; xlsx sheet A2 "base n = 25" and table row "Base: n = 30".
- Fix: pass `base: { n: <valid n from boxShares/describe> }` (topbox: `s.n` of the first item, or per-item n column only) or drop `base` from those tables and let the header speak.

### ANALYTICS-03 — segment n is cases, not answered (P3)
- Evidence: `basics.ts:113-116, 164-167`, `business.ts` segment paths; `common.ts:51-62 segmentBases` warns on that n.
- Repro: controlled.mjs "MISMATCH segmentDatasets: segment Females n — got 15 expected 10".
- Fix: compute `n` from `answeredCases(data, variablesUsed)` in each runner's segment map.

### ANALYTICS-05 — question codes validate but do not run (P2)
- Evidence: `planCheck.ts:141-145` admits `q.code`; `planWorkspace.ts:207` likewise; `planBridge.ts:44` passes names verbatim; `crosstab.ts:140` warns and continues with base 0.
- Repro: `docs/audit-2026-10-16/repro/analytics/plan.mjs` → "kept: [x1, t1, x3]" then "RUN x1: base.n=0 … Variable Q6 is not in this survey's dictionary".
- Fix: map code → `variableName` in `crosstabDefinition`/`testDefinition` (and in `withPlannedVariables` sources), or register code aliases in `variableMetadata`.

### ANALYTICS-06 — manual plan run executes invalid items (P3)
- Evidence: `apps/studio/lib/analytics.ts:414` only honours `opts.exclude`, which `POST plan/run` (`route.ts:309`) never sets; `findings.ts:579-592` runs every item and merges warnings.
- Repro: plan.mjs `runPlan` items `x2`, `t2` status "ok" with empty results and dictionary warnings in `run.warnings`.
- Fix: run `reviewPlanned` in `runPlanFor` and set `result.error = not_computable` for blocked items.

### ANALYTICS-07 — plan run weighting from first item (P3)
- Evidence: `analytics.ts:430` `buildFor(db, surveyId, ctx, { ...items[0].definition, dataset: spec })`.
- Fix: build per distinct weighting, or document that plan runs are unweighted unless the first planned item is.

### ANALYTICS-12 — draft definition drives live analytics (P2, UNVERIFIED without DB)
- Evidence: `analytics.ts:161-169` prefers the draft; `qualityDef.ts:33` sets `versionId = current_version_id` for the draft too; `analytics.ts:280` returns `undefined` when all rows are on that version, so `buildDataset` uses `ctx.def` (the draft).
- Risk: a draft that renames a variable makes saved analyses warn "not in dictionary" (base 0); a draft that changes option codes shrinks crosstab column bases; a draft that deletes a question removes it from every live table — all before publishing.
- Verify: survey with `draft_definition` differing from the current version; compare an analysis before/after a draft option-code edit (BROWSER-REPRO NEEDED).

### ANALYTICS-13 — layered crosstab header n (P3)
- Evidence: `crosstab.ts:519` `validN: layerVar ? undefined : tables[0]?.base?.n`; `common.ts:91` then counts cases answering ANY of row/column/layer variables.
