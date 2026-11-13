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

## Cross-tabs: whole tables in one step

In the cross-tab builder, **Quick tables** fills Rows and sets the table's shape for you:

- **All questions → Rows** puts every question that can be tabulated down the side of **one** banner table (a section per question). Put the banner in Columns before or after. A survey with sections also offers one section at a time.
- **One table for a loop or grid…** shows a looped question (the same question asked for each brand) or a grid as one table with **a row per brand or statement**, instead of one table per variable. A loop is read by item: each answer is counted under the brand it was about, whichever pass of the loop it came in.
  - With no banner, each row shows that item's base, its answers and its summary figures.
  - With a banner, each cell is one figure — NPS, the mean or a box score — for that banner column; choose it in Options.
- **Transpose** puts the items across the top. For an ordinary cross-tab, **Swap rows and columns (transpose)** exchanges the row questions and the banner.

**NPS.** A question programmed as NPS carries **Promoters (9–10)**, **Passives (7–8)**, **Detractors (0–6)** and **NPS (promoters − detractors)** in its cross-tab without being asked, for every banner column; any other 0–10 scale gets them from Options → summary rows. Item tables of a 0–10 scale lead with NPS.

The same tables can be asked for in words in **Ask**: "all questions by gender and region", "satisfaction grid in one table by region", "item table of the brand ratings, transposed". Item tables carry no significance letters: their rows are answered by overlapping respondents, so the column tests of a cross-tab do not apply.

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
