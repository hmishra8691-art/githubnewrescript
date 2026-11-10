---
summary: Analysing results — Data Analytics' four modes (Overview, Explore, Architect, Present), every kind of analysis, the analysis plan, plain-language and statistical interpretation, and exports to PowerPoint, PDF, Excel and CSV
related: analytics, data-and-downloads, study-methodologies, maxdiff
status: available
---
# Analysing results

**Data Analytics** reads a survey's stored responses and turns them into tables, charts, tests, findings and deliverables. It opens from the project's **Results**. Every number is computed on the server from saved analysis definitions by one engine, so a figure is the same in the workspace, an export and a report.

The workflow has four modes:

| Mode | What it is for |
|---|---|
| **Overview** | The study at a glance: completes, hypotheses supported, findings, KPIs, data quality, the executive summary |
| **Explore** | Pick up to four variables and the board chooses the analysis that fits them; build tables, charts, segments and filters |
| **Architect** | Every hypothesis, crosstab, test, model, chart and report in research terms; the **analysis plan** is applied here |
| **Present** | Turn a selection into a deliverable — PowerPoint, PDF, Excel or CSV — or a report to brand, publish and share |

Every result has two layers: the **statistics** (the test, statistic, degrees of freedom, p-value against alpha, effect size, base, confidence intervals) and a **plain-language reading** of what it means. "Significant" is said only when the test says so; association is never called causation; a small base is called small.

## Every kind of analysis

::: catalog analyses

## When to use it

- Reporting a tracker's KPIs (NPS, CSAT) with their confidence intervals.
- Testing differences between groups (crosstabs with significance letters, tests).
- Choice and pricing models (MaxDiff, conjoint, Van Westendorp, Gabor-Granger, TURF).

## Set it up in the builder

::: steps Analyse a survey
1. **Plan it** — Survey Settings → Research design (objective, hypotheses); the analysis plan follows from it.
2. **Open Data Analytics** from the project's Results.
3. **Overview** — read the findings; **Explore** — pick variables.
4. **Architect** — apply the analysis plan; check each hypothesis.
5. **Present** — select results and export, or save a report.
:::

::: example analytics-results

## Common mistakes

- **Reading simulated or test data as findings** — analyse live data; the docs' sample output is simulated.
- **Testing everything** — many tests find something by chance; the plan applies a correction for multiple tests.

## Troubleshooting

- *An analysis has no result* — its variables have no answers in the chosen dataset, or the base is too small for the test.
- *Numbers differ from an export* — check the dataset (test, live, clean) and the filter; both use the same engine.
