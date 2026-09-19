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

## Operational dashboard widgets — photo, icon panel, steps, ranked list (§38, September 2026)

The Data Analytics Studio's dashboard builder was, until now, five analytical
widget kinds — kpi, chart, table, text, filter. A researcher shared Forsta/
Dapresy's public dashboard gallery (Misono, Junicom, StayLux, Neptune, FlyNow,
Hotel, CarFix — operational CX/EX dashboards, heavy on photography, gauge/ring
KPIs, colour-coded heatmap tables and icon-driven breakdowns) and asked for
that visual language here, phased. This is **phase 1 of that roadmap**: four
new `DashboardWidget` kinds for the pieces the gallery has that the platform
didn't — photography, pictograms, process panels, iconed rankings. Gauges,
donut/ring KPIs, KPI cards and heatmap crosstab tables already existed as real
chart types (`Chart.tsx`) before this work; they needed no new code.

* **`photo`** — an image tile (`imageUrl`, chosen or uploaded through the
  same `MediaUrlInput`/asset library every other media slot in Studio uses —
  no second upload system), with an optional big overlay figure
  (`overlayValue`, e.g. `"77%"`) and a small colour-coded trend chip
  (`overlayTrend`; a leading `+` is green, `-`/`−` is red, anything else
  neutral) — StayLux's room ratings, Hotel's "-2% less attractive" callouts.
* **`icon_panel`** — a pictogram breakdown of a categorical analysis: one row
  per category, an isotype row of glyphs (10 icons, filled left-to-right by
  the category's percentage) plus the label and value — Junicom's person-icon
  demographic panel. Bound to `analysisId` like `chart`/`table`; reuses
  `seriesForChart` for the same sort/topN/hidden-category rules every other
  chart already follows, so it never re-derives categories on its own.
  `icon` picks which glyph represents a row.
* **`steps`** — a static numbered process panel (`steps: {icon?, title,
  description?}[]`), no analysis attached — CarFix's "1 Receive actual
  customer issues → 2 Improve your weak spots → 3 Exchange success stories".
* **`ranked_list`** — an iconed, bar-scaled ranking of a categorical analysis:
  rank number, optional icon, label, a bar scaled to the top value, and the
  value itself — the ranked bar-and-flag lists that recur across the gallery
  (FlyNow, CarFix v.2).
* **Icon set** (`apps/studio/components/analytics/charts/Icons.tsx`) — nine
  plain-SVG glyphs (`person`, `star`, `flag`, `check`, `trend_up`,
  `trend_down`, `building`, `car`, `hotel`, `generic`) drawn with
  `currentColor`, the same "plain SVG, no new dependency" choice the chart
  library itself makes, plus `IconPictogram` for the isotype row.
* **Builder & viewer** — `ReportsPanel.tsx`'s widget picker and `BlockEditor`
  gained the four kinds (image picker, analysis + icon pickers, a repeatable
  step-list editor); `ReportView.tsx` renders all four for both the live
  builder preview and the read-only share page, since it is the one renderer
  both use. No server-side change was needed: the id-gathering in
  `computeReport` and the fake backend already loop over every widget's
  `analysisId` generically, and dashboards were never exported to
  PowerPoint/Excel (screen- and share-link-only), so the export builders are
  untouched.
* **Not in this phase** — real geographic maps (FlyNow's pinned Europe map;
  `map_bubble`/`map_country` still fall back to a scatter/bar chart), a
  free-form drag/resize canvas (widgets still stack in document order; `x`/`y`
  exist on `DashboardWidget` but are hardcoded to 0), background/hero photos
  behind a cluster of widgets, dark theme presets, and a dashboard template
  gallery. Those are phases 2–5 of the plan given to the team; nothing here
  forecloses any of them.

## Real maps (§39, September 2026)

Every geographic chart type used to draw something else. `map_country`,
`map_state` and `choropleth` fell back to a ranked bar chart with a footnote
saying so; `map_bubble` and `map_heat` fell back to a scatter plot whose axes
were longitude and latitude in name only. A researcher who picked "Country
map" got bars. This phase draws the map.

* **The data** (`packages/analytics/src/geo/regions.ts`) — 177 world countries
  and 56 US states/territories, outlines quantized to ~0.1 degrees (about 11 km),
  generated by `scripts/gen-geo.mjs` from world-atlas (Natural Earth 110m) and
  us-atlas (US Census 10m), both public domain. The generator runs by hand at
  authoring time and its output is committed, so the chart library keeps no
  geographic dependency at runtime — the same rule that keeps it free of a
  charting dependency. Simplification erased ten small countries (Cyprus,
  Qatar, Jamaica and seven others) at the first threshold tried, so any feature
  that does not survive simplification falls back to its raw outline: a country
  missing from a map reads as "no respondents there", which is a claim about
  the data, not about the compression.
* **Resolution** (`packages/analytics/src/geo/index.ts`) — a category label
  becomes a region by ISO alpha-2, alpha-3, name, or one of an alias table
  covering the everyday spellings ("USA", "UK", "Ivory Coast", "Czech
  Republic", "Burma") and the abbreviations the source data ships ("Dem. Rep.
  Congo", "Bosnia and Herz."). Matching folds accents, punctuation and case.
  The scope — world or US states — is chosen by whichever explains more of the
  labels, so a banner of countries and one of states both simply work;
  `mapScope` forces it when the data is ambiguous (a "Georgia" that is the
  country, not the state).
* **Anything that does not resolve is named on the chart**, never dropped.
  This is the whole design bias: a blank region reads as "nobody there", and a
  reader cannot otherwise distinguish that from "this label was spelled in a
  way the map did not recognise".
* **Projection** — equirectangular, fitted to the regions that carry data, so
  a study run in six European countries draws a map of Europe rather than a
  world map with six specks on it. Only each region's largest ring takes part
  in the fit: France's outline includes French Guiana and Spain's the
  Canaries, and fitting to every ring turned "western Europe" into a map of
  the Atlantic with Europe in the corner. The smaller rings are still drawn.
* **Choropleth** shades each region on the value scale with a legend, puts the
  value on the region's *area* centroid (the bounding-box centre put the UK's
  label in the Irish Sea), and supports click-to-cross-filter like every other
  chart. When several series exist — a crosstab has one per column — only one
  can be shaded, so the map says which: an unlabelled choropleth of
  "Satisfaction: 1" is indistinguishable from one of "Satisfaction: 5".
* **Bubble maps** size a marker per region, by *area* rather than radius: the
  first cut drew 9% as a 5px dot beside 15% as a 21px disc, seventeen times the
  ink for two thirds the value. They leave the basemap neutral rather than
  also drawing a choropleth underneath, and print the size range.
* **Points as coordinates are opt-in** (`pointsAreCoordinates`). A scatter of
  satisfaction (1-5) against age (18-78) is made of numbers that are perfectly
  valid coordinates, and sniffing the range would have quietly relocated a
  study to the Gulf of Guinea. `map_bubble` and `map_heat` therefore ask for
  categories, which is what a survey actually produces.
* **PowerPoint has no map chart**, so a geographic chart still exports as
  ranked bars — and now says so on the slide. Drawing the map as a picture in
  the deck is the obvious next step, and is deliberately not a silent one.
* **The fixture** gained a `COUNTRY` variable (eight European markets, one of
  them written "UK" so the alias path is exercised by real data) with a modest
  per-market satisfaction lift. It is assigned from the row index rather than
  the shared random stream, so no other suite's planted effects moved.

## Tests

* `pnpm --filter @rescript/analytics test` — 135 tests (stats vs scipy, every runner against planted data, report pages/templates, PPTX/XLSX builders including panel grids, and the geography: region resolution, aliases, scope choice, unmatched reporting, projection fitting).
* `node scripts/analytics-test.mjs` — 67 browser checks (workspace, builder, the analyses rail, the four stages, the professional table, nested rows, filters, charts, gallery, customisation, save/version, segments, report builder, publish/immutability, panel grids and the tracker template, share link, read-only view, downloads, revoke, password, expiry, exports, table builder, themes, dashboard, the four operational-dashboard widgets — photo/icon panel/steps/ranked list, real country and bubble maps, existing navigation unchanged). Uses an in-process fake backend over the real engine because the dev container has no database credentials.
* `packages/analytics/src/analyses/crosstab.test.ts` — the crosstab’s options one by one (banner, nesting, stacking, base, suppression, sorting, summary rows, means, weighted letters) and the audit’s fixes (A1–A6, A11).
* Share-resolution SQL exercised against the live database in a rolled-back transaction (unknown / unpublished / pinned vs following / expired / revoked / password flag / access counting).
