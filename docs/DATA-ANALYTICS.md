# Data Analytics, Visualization, Reporting, Sharing & Export

A modular analytics and reporting layer on top of the existing survey, variable,
response, authentication, project and database architecture. Nothing in the
survey-programming platform was changed to add it; it consumes stored responses
and the survey definition and produces analyses, charts, reports, shares and
exports.

## Where it lives

| Layer | Location | Purpose |
| --- | --- | --- |
| Engine | `packages/analytics` (`@rescript/analytics`) | Pure TypeScript: statistics, dataset extraction, 24 analysis runners, chart recommendations, executive summary. No I/O, no framework. |
| Exporters | `@rescript/analytics/export` | PowerPoint (pptxgenjs, native charts/tables) and Excel (exceljs) builders. Node-only subpath; never reaches the client bundle. |
| Server | `apps/studio/lib/analytics.ts`, `app/api/surveys/[id]/analytics/[[...path]]/route.ts`, `app/api/share/[token]/route.ts` | Server-side aggregation, persistence, publishing, sharing, exports. |
| Database | `supabase/migrations/0011_analytics.sql` (applied) | `analytics_analyses`, `_analysis_versions`, `_charts`, `_segments`, `_themes`, `_reports`, `_report_versions`, `_shares`, `_share_access`, `_exports`; functions `rescript_resolve_share`, `rescript_record_share_access`. |
| Access | `packages/access` | New capabilities `analytics.read / edit / publish / export` on the existing role table; new `analytics.*` audit events. |
| UI | `apps/studio/app/analytics/page.tsx`, `components/analytics/*`, `app/share/[token]/page.tsx` | The Data Analytics tab, workspace, builders and the read-only share view. |

Entry points: **Data Analytics** button in the dashboard header (`/analytics`), and a
**Data Analytics** link at the end of the Studio left nav (`/analytics?survey=<id>`).
The existing 17 Studio tabs and the dashboard header buttons are unchanged.

## Data flow (§32, §38)

```
responses (Supabase)  →  loadRows() streams in 1 000-row chunks, server only
                      →  buildDataset(def, rows)   dictionary-named columns (flattenVariables), roles, system columns
                      →  filters / segments        ordinary survey Conditions via matchesResponseCondition
                      →  weighting                 weight variable or rim (raking) targets
                      →  runAnalysis(definition)   AnalysisResult: tables, chart data, tests, insights, warnings, bases
                      →  recommendCharts(result)   ranked chart types with reasons
                      →  browser                   receives the RESULT only — never a response row
```

The browser never downloads the dataset. Every "Run", every report open, every
export and every publish is computed in the API route. A short-lived per-survey
row cache (60 s, keyed on response count + newest `updated_at` + spec) keeps
iterative analysis cheap.

## Analysis types

Descriptive · Top/Bottom box · Crosstab/Banner (row/col/total %, means, layers,
weighted, significance letters, chi-square) · Statistical tests (chi-square,
Fisher, one-sample/independent/Welch/paired t, one-/two-way ANOVA,
Mann-Whitney, Wilcoxon, Kruskal-Wallis, Friedman, proportion tests, CIs, effect
sizes) · Correlation (Pearson/Spearman/Kendall, matrix) · Regression (linear,
logistic, multinomial, interactions, moderation, mediation/Sobel) · Segment
profile · Cluster (k-means, hierarchical/Ward + dendrogram) · Factor/PCA
(varimax, KMO, scree) · Reliability (Cronbach α, item-total) · Trend
(period/wave, rolling average, baseline, linear trend test) · NPS (groups, by
segment, trend, drivers) · CSAT/CES · TURF · Importance-Performance/GAP ·
Pricing (Van Westendorp, Gabor-Granger) · Brand funnel/image · Ranking ·
Allocation · Text (words, phrases, sentiment, keyword themes, by segment) · Data
quality · Weighting diagnostics · Conjoint (conditional logit part-worths,
importance, share simulation, holdout hit rate, WTP) · MaxDiff (counts,
aggregate logit utilities, preference shares, by segment).

Reference values for the statistics were checked against scipy
(`packages/analytics/src/stats/stats.test.ts`); the analysis runners are checked
against a synthetic survey with planted structure
(`src/analyses/analyses.test.ts`, `src/analyses/fixture.ts`).

## Definitions, results, versions (§13, §17, §39)

An `AnalysisDefinition` is the reproducible object: dataset (environment,
quality, statuses, dates), variables/rows/columns/layers/measure, inline filter +
saved filter ids, segments, weighting, options, survey version. Saving stores it
in `analytics_analyses`; every change to the *analysis* part bumps `version` and
writes `analytics_analysis_versions`. A saved chart (`analytics_charts`) is a
`ChartSpec` (type + styling options + theme) linked to the analysis — styling
changes bump `style_version` only and never touch the analysis.

## Reports, publishing, sharing (§12, §18–§22, §33–§36)

Reports are ordered blocks (cover, executive summary, section, chart, table, KPI,
insights, text); dashboards are widget grids with optional cross-filter
highlighting. **Publish** computes every referenced analysis and freezes
definition + theme + results into `analytics_report_versions` (immutable).
Editing the draft afterwards does not change any published version; **Publish**
again to create v2.

A share (`analytics_shares`) always points at a published version — pinned to a
specific one or following the latest. Modes: Private / Specific users (email or
user id; they sign in) / Anyone with link. Options: expiry, password (salted
SHA-256), Viewer or Download-only permission, label, revoke, reshare (new
token). `/api/share/<token>` resolves through `rescript_resolve_share`, a
security-definer function that returns the snapshot and nothing else — there is
no path from a token to `responses`, to a live definition, or to any write. The
`/share/<token>` page renders the snapshot with no builder, no edit controls,
and shows Download PPT / Excel only when the share permits it. Every view and
download is recorded (`analytics_share_access`, counters on the share) and
listed under **Sharing → Manage shared reports**.

## Exports (§23–§26)

PowerPoint: cover (theme colours/logo), executive summary, section dividers,
one slide per chart (native editable pptx charts) or table (native tables, up
to 14 rows per slide), KPI cards, insights, sample and methodology slides,
footer, slide numbers. Excel: Summary (executive summary + analysis index with
sheet links), one sheet per analysis (insights, every table with numeric
percent cells and `sig.` columns, tests, notes), Chart data, Metadata. The
Export dialog exposes format, theme, include toggles and per-format options
(slide size, fonts, footer, background, chart size; sheet names, decimals,
percent format, table style, freeze panes, auto-filter). Shared viewers with
Download permission export the published snapshot with the same builders.

## Themes (§11, §27)

`analytics_themes` hold report branding — colours, palette, fonts, header,
footer, cover style, logo (data URL), chart defaults — scoped to the workspace
or a survey. They apply to on-screen charts, reports and both export formats and
are independent of the survey's respondent-facing branding.

## Permissions & audit (§33, §36, §37)

| Role | read | edit | publish/share | export |
| --- | --- | --- | --- | --- |
| owner, editor | ✓ | ✓ | ✓ | ✓ |
| programmer | ✓ | ✓ | – | ✓ |
| reviewer, deployment_manager | ✓ | – | – | ✓ |
| viewer | ✓ | – | – | – |
| test_user | – | – | – | – |

Every route passes `requireProject(req, surveyId, capability)`; the UI hides
what a role cannot do but the server decides. Shares expose only Viewer /
Download-only. Audit events: `analytics.analysis_created|modified|deleted`,
`chart_created|modified`, `report_created|modified|published|shared`,
`share_revoked`, `share_accessed`, `export_generated`, `report_downloaded`.

## Tests

* `pnpm --filter @rescript/analytics test` — 35 tests (stats vs scipy, every runner against planted data, PPTX/XLSX builders).
* `node scripts/analytics-test.mjs` — 38 browser checks (workspace, builder, filters, charts, gallery, customisation, save/version, segments, report builder, publish/immutability, share link, read-only view, downloads, revoke, password, expiry, exports, table builder, themes, dashboard, existing navigation unchanged). Uses an in-process fake backend over the real engine because the dev container has no database credentials.
* Share-resolution SQL exercised against the live database in a rolled-back transaction (unknown / unpublished / pinned vs following / expired / revoked / password flag / access counting).
