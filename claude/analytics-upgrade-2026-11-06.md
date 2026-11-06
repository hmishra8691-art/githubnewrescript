# The Analytics upgrade — 2026-11-06

The master prompt "Transform Rescript Studio Analytics into an Intelligent, Unified Research Analytics &
Visualization Workspace", implemented as ten commits on top of `origin/main = 0932c2c6`, each verified before
the next, each applied on the Mac clone (`~/Downloads/rescript-push`) with `git am`; the patches went to the chat
as `0069`–`0078`. Nothing was rebuilt: the engine, the saved analyses, charts, reports, dashboards, permissions
and every earlier link are what they were. The four modes are a navigation over them; every new capability is a
function of the stored data.

## The phases

| # | Commit | What |
|---|---|---|
| AA1 | `f03837e4` | **The analysis catalogue** (`packages/analytics/src/catalogue.ts`): hypotheses, crosstabs, tests, models, correlations, charts, themes & insights, reports, dashboards as one tree, every entry labelled in research terms (a KPI names its variable, a construct names its questions, otherwise the question's text becomes the thing it measures — "Purchase Intent by Brand Awareness", never "Q18 × Q14"), the technical identity kept beside it. `GET analytics/catalogue`. |
| AA2 | `be868839` | **Architect**: Explorer · Workspace · Properties, three resizable panes, results three at a time. |
| M1 | `b003ed47` | **Four modes** — Overview → Explore → Architect → Present — replacing the five places; every earlier tab and place name resolves; no more redirects to the Programming Studio ("Propose the plan" runs the engine's proposal in place). |
| M2 | `f82cd43f` | **The executive Overview** (`overview.ts`, `lib/analyticsOverview.ts`, `OverviewDashboard`): the band, the engine's executive summary with "Polish with AI" through the claim gate (`lib/analyticsNarrative.ts`, shared with the copilot's findings outputs), key findings that HOLD after correction as cards with chart, plain reading, evidence and why it matters, hypotheses, who answered, correlations, beyond the plan, themes, data quality. |
| M3 | `a8fc1417` | **Explore** (`lib/analyticsExplore.ts`, `ExploreBoard`): pick variables → the analysis that fits and why; chart switching; cross-filtering through the filter builder's own Condition; save as analysis + chart. |
| M4 | `b7112128` | **Architect**: Focus has Combined / Table / Chart / Details; a crosstab shows table, chart and heatmap together; All lays out everything, computed as it scrolls into view; the configuration (slots, measure, test, method, model, filter) is edited from Properties through the builder's route. |
| M5 | `000454db` | **Dual-layer interpretation** (`interpret.ts`, `POST analytics/interpret`, `InterpretationPanel`): the statistics as they are, the plain reading (what, why, meaning, patterns, objective, next), association never causation; the model's implications through the report builder's claim gate when asked. **The hypothesis driven by its evidence**: supported / partially / not / inconclusive / not testable, with the evidence lines and what is missing. |
| M6 | `8de3509a` | **The unified selection** (`selection.tsx`), **Present**, `lib/analyticsSelection.ts` (selection → one report definition), `buildPdf` (pdfkit, vector charts, paginated tables, `checkPdf`) and `buildCsv`; the export route takes `selection` and `format pdf | csv`; "Save as report" through the ordinary reports route. |
| M7 | `f6d243d8` | **Ask** with where/focus, "Why this chart?" from the engine's advice, the microphone (`DictateButton`, the browser's recogniser, nothing leaves the device); **Simple / Professional / Advanced** (`detail.tsx`). |
| M8 | this commit | **Attention** (`catalogueAdvice`: duplicates, untestable hypotheses, planned-not-created, blocked, stale, unplanned hypotheses, no run, coverage), duplicate marks, Explorer paging at 150, the public page *Data Analytics*, this record. |

## The acceptance workflows

1. **Executive overview** — Overview opens on the band, the summary and the key findings; each card opens its analysis in Architect's Focus.
2. **Interactive exploration** — Explore: Age group + Brand awareness + Purchase intention → a crosstab with column % and significance, drawn, switchable, cross-filtering the other panels on a click.
3. **Advanced analysis** — Architect: a crosstab in Focus shows its table, chart and heatmap together; Properties → Configuration edits rows, columns, measure and filter and recomputes in place.
4. **Research intelligence** — Ask: "compare satisfaction across regions" proposes the test or crosstab from the dictionary (rules first, the model only for what the rules cannot read), applied on review; the result's interpretation is the engine's.
5. **Hypothesis validation** — a hypothesis in Focus: its verdict from the run, the findings it rests on with evidence lines, the analyses that test it, what is missing when it cannot be tested.
6. **Research presentation** — select charts, tables, hypotheses, findings and a report across modes; Present exports one PPTX / PDF / XLSX / CSV with interpretations, or saves a report.
7. **Voice** — 🎤 Speak in Ask: the request is proposed when the speaker stops, inside Analytics.

## Verification (2026-11-06)

`pnpm -r typecheck` clean across 22 workspaces. Tests: engine 2673, studio lib 1167, analytics 805, recruitment 216, media 179, interviews 178, ai 150, exporters 148, designs 124, access 123, templates 121, runtime 112, storage 104, import 100, quality 97, billing 57, identity 34, mail 33, schema 18, renderer 12, reportvideo 6 — **6,457 passing, 0 failing**. `pnpm audit:code`: 279 + 77 handlers 0 problems, piping sweep 0, dependency boundaries 0 violations. Public docs current. Studio `next build` clean after every phase.

## What the engine already had, and was reused rather than rebuilt

The chart library (bars, stacked, 100 %, diverging Likert, heatmaps, lines, scatter, box plots, donuts, maps, correlation matrices, waterfall, funnel, treemap, sankey, histogram, pareto, radar, conjoint and MaxDiff pictures, small multiples as `panel_grid` blocks) and its question-aware recommendation (`adviseChart`, "why this chart"); the analysis plan, its apply and run with multiple-comparison correction; findings, verdicts and discoveries; the claim gate for model text; the PowerPoint and Excel builders; Ask's rules-first proposal engine; the qualitative themes.

## Not done, said plainly

- The PDF draws the chart families above; a chart type outside them (a map, a dendrogram, a word cloud) prints its table instead, as the animated story does.
- "Save a selection as a report configuration" saves a report; a named, re-loadable *selection* (separate from a report) is not stored.
- The Explore board's panels are not persisted across reloads; the saved analyses are.
- Dictation uses the browser's recogniser only; the runtime's server speech-to-text fallback (for Firefox) is not wired into Ask.
- The Mac clone needs `pnpm install` once (pdfkit) before its next build.
