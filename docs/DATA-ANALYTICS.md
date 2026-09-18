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
insights, text, **panel grid** — see below); dashboards are widget grids with
optional cross-filter highlighting. **Publish** computes every referenced analysis and freezes
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

## The research studio workspace (September 2026)

The Analysis tab is a workbench: an **Analyses rail** on the left (every saved
analysis in the researcher's own order — open, duplicate, rename, move up /
down, delete; `POST analyses/<id>/duplicate`, `POST analyses/reorder`,
`analytics_analyses.position`, migration 0041), and four **stages** on the
right — *Builder* (type · variables · filters · segments & weighting ·
options) → *Results* (chart preview, tables, tests, insights) → *Visualization*
(large chart, gallery, customizer, full screen, PNG / SVG) → *Export*
(PowerPoint, Excel, PNG, SVG, save chart, add to report). An unsaved
definition shows a dot in the stage bar, on its rail item and on the workspace
tab; leaving it asks first. A result older than the definition says so.

### The crosstab

`packages/analytics/src/analyses/crosstab.ts`. One pass accumulates weighted
and unweighted counts, Σw² and moments per column, so percentages, letters,
counts and means always describe the same respondents. Options (all on
`definition.options`, all defaulting to the previous table):

| option | meaning |
|---|---|
| `layout` `banner` / `separate` | every column variable side by side in one table, or one table per pair |
| `stackRows`, `nestRows` | row variables under section rows, or the second nested inside the first (group rows the UI collapses) |
| `base` `answered` / `all` | base on people who answered both, or everyone in the column with a "No answer" row |
| `minBase` | suppress cells of columns under this base; the column is starred |
| `sortRows`, `hideEmptyRows`, `totalRow` | row order by Total, drop empty rows, a 100 % check row |
| `summaryRows` | `mean`, `top1`, `top2`, `bottom1`, `bottom2`, `net` for numerically coded frames |
| `decimals`, `significance`, `alpha`, `sigVsTotal` | precision; letters (weighted proportions with effective bases; `aa`… after `z`); ▲▼ against the rest of the sample |
| `formatting` | how the table looks on screen (heat, counts under %, highlight, dense) — never a new version |

Rows carry `__kind` (`category` · `noanswer` · `summary` · `total` · `base` ·
`section` · `group`), `__level` and `__group`; columns carry `group`, `letter`
and `suppressed`. `ProTable` (`apps/studio/components/analytics/ProTable.tsx`)
renders any `ResultTable` with sticky header and stub, header groups,
expand / collapse, column sort, heat shading and windowing past 150 rows;
reports and the share view use it through `ResultTableView`.

`measure: "mean"` now works for scale rows (weighted mean, SD, n, letters by
a Welch z on effective bases). The audit that preceded this work, and the
engine fixes it produced, are in `docs/ANALYTICS-AUDIT-2026-09.md`.

## Panel grids and the Innovation post-launch tracker (§37, September 2026)

A single chart or table is a page; a tracker snapshot is a headline sentence
and two or more analyses read together — a brand funnel next to its sources,
a trial rate next to its motivations, eight small monthly trend lines side by
side. `ReportBlock` gained one new case for it, `panel_grid`, rather than a
family of new block types: a headline string, a `columns` hint, and a list of
panels — each one the same `{ analysisId, chart? | tableId?, title?,
caption? }` shape a lone chart/table block already has. Every existing
analysis (a funnel, a crosstab with significance letters, a wave-trend line,
a driver/regression table) drops into a panel unchanged.

* **Builder** (`apps/studio/components/analytics/ReportsPanel.tsx`) — add a
  panel grid from the block picker, edit its headline/columns, and add,
  reorder-free, or remove panels, each with its own analysis and chart-type
  (or table) pick.
* **On screen** (`ReportView.tsx`) — a CSS grid of mini charts/tables under
  the headline; an unfilled or deleted-analysis panel shows the same
  "waiting for an analysis" / "not available" placeholder a lone chart block
  already shows, never a blank space.
* **PowerPoint** (`packages/analytics/src/export/pptx.ts`) — `drawAnalysisVisual`
  factors the chart-or-table decision out of the old "chart" block handler so
  a panel draws with exactly the same logic, just inside a smaller box;
  `panelGridSlide` lays panels into an auto-sized grid under the headline,
  drawing a labelled placeholder for anything missing rather than skipping it.
* **Excel** — a workbook has no notion of several analyses on one page, so
  `buildXlsx` flattens a panel grid's panels the same way it already flattens
  a lone chart/table/kpi block: every referenced analysis still gets its own
  sheet and its chart-data rows.
* **Templates** — `applyTemplate` treats a panel grid exactly like a lone
  chart/table/kpi: a filled one from the existing report survives into the
  template's shape rather than being discarded, and its panels get fresh ids
  on every application. Saving a report's shape as a template, and the
  server's `computeReport` (which decides which analyses to fetch for a
  report at all), both know about panel-grid panels too — the first gap
  found while building this, since a report with a panel grid the server
  didn't look inside would render every panel as "not available" forever.
* **`BUILT_IN_REPORT_TEMPLATES`** ships a fourth shape, **"Innovation
  post-launch tracker"** (`builtin:innovation_tracker`): cover, headline KPI,
  an awareness-snapshot and a trial-snapshot panel grid per tracked
  innovation (duplicate the pair per innovation), a monthly trend panel grid,
  a lettered brand-comparison table, a driver-analysis chart, cohort tables,
  methodology — the shape of a Post-Launch Tracker deck, built entirely from
  analyses this platform already runs.

## Tests

* `pnpm --filter @rescript/analytics test` — 120 tests (stats vs scipy, every runner against planted data, report pages/templates, PPTX/XLSX builders including panel grids).
* `node scripts/analytics-test.mjs` — 59 browser checks (workspace, builder, the analyses rail, the four stages, the professional table, nested rows, filters, charts, gallery, customisation, save/version, segments, report builder, publish/immutability, panel grids and the tracker template, share link, read-only view, downloads, revoke, password, expiry, exports, table builder, themes, dashboard, existing navigation unchanged). Uses an in-process fake backend over the real engine because the dev container has no database credentials.
* `packages/analytics/src/analyses/crosstab.test.ts` — the crosstab’s options one by one (banner, nesting, stacking, base, suppression, sorting, summary rows, means, weighted letters) and the audit’s fixes (A1–A6, A11).
* Share-resolution SQL exercised against the live database in a rolled-back transaction (unknown / unpublished / pinned vs following / expired / revoked / password flag / access counting).
