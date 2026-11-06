# Data Analytics

Analytics reads the stored responses of a survey and turns them into tables, charts, tests, findings and deliverables. Everything is computed on the server from the saved **analysis definitions**; the browser only ever receives results. One engine (`@rescript/analytics`) serves every mode, every export and every report, so a number is the same wherever it is shown.

## The four modes

Analytics is one continuous workflow in four modes, in the order a researcher works. Ask — the panel that proposes changes from a sentence — opens from every one of them.

| Mode | What it is for | Views |
|---|---|---|
| **Overview** | The study at a glance for a reader who is not a statistician: completes, hypotheses supported, findings that hold, KPIs, data quality; the executive summary; the key findings as cards with their chart, a plain reading, the evidence and why it matters; who answered; correlations; beyond the plan; themes. | Overview, Findings |
| **Explore** | Interactive exploration. Pick up to four variables and the board chooses the analysis that fits them and says why; switch charts, click a bar to filter the other panels, save what is worth keeping. The builder, tables, charts, segments and filters live here too. | Explore, Analysis, Tables, Charts, Segments, Filters |
| **Architect** | The research environment: the **Analysis Explorer** (every hypothesis, crosstab, test, model, correlation, chart, theme, report and dashboard, in research terms), the **Workspace** (Focus: combined / table / chart / details; All: everything, section after section) and **Properties** (what it answers, the interpretation, recommended charts, the configuration — editable in place — and the technical identity). The analysis plan is applied from here. | Workspace, Analysis plan |
| **Present** | The selection becomes a deliverable: retitle, annotate and reorder what was selected anywhere, then export it all at once — PowerPoint, PDF, Excel or CSV — or save it as a report to template, brand, publish and share. | Present, Reports, Themes, Exports, Sharing |

Links written for earlier versions still work: `?tab=deliver` opens Reports, `?tab=plan` opens the plan under Architect, `?view=architect` opens Architect.

## Research labels

Every analysis is named in research terms, never by question codes: a KPI names its variable (*Net Promoter Score*), a construct names the questions that measure it (*Purchase Intent by Brand Awareness*), otherwise the question's text becomes the thing it measures (*Likelihood to buy Brand A*). The codes, variable names, saved names, kinds, methods and ids are kept on every entry — under *Technical details* in Properties — for traceability.

## Interpretation

Every result carries two layers, both computed from its own numbers:

- **Statistical** — the test, its statistic and degrees of freedom, the p-value against the alpha, the effect size named and sized by the conventions of its measure, the base, the alpha, confidence intervals where the tables hold them.
- **Plain language** — what was analysed, why (the hypotheses the plan ties it to, the plan's reason, the objective), what the result means, the patterns the engine read, how it bears on the objective, what to consider next.

Association is never called causation. "Significant" is said only when the test says so at its alpha. A small base is said to be small. A language model may add implications and recommendations when asked — through the claim gate, which checks every sentence against the numbers of the claims it cites — and that text is always marked as the model's, with how many sentences survived.

## Hypotheses

A hypothesis in Architect's Focus says where it stands — **Supported**, **Partially supported**, **Not supported**, **Inconclusive**, or **Not testable with the available data** — with the findings the verdict rests on and their evidence lines, the analyses that test it, the variables that are missing, and what would make an untestable one testable. Verdicts come from the run of the analysis plan and its correction for multiple tests; nothing is manufactured.

## Selection and export

Anything with a catalogue key can be selected: an analysis, a chart, a hypothesis, a finding, a theme, a whole report or dashboard. Tick entries in Architect's Explorer, press *Select* on an Overview finding or a saved Explore panel. The selection is one basket across the modes, remembered per survey. Present exports it as one PowerPoint (one slide per chart and table), PDF (vector charts, paginated tables), Excel workbook or CSV (every table once), with the interpretation under each analysis when wanted; or saves it as a report. Every number in an export is a fresh computation of the saved analysis.

## Ask

Ask proposes from a sentence — a crosstab, a test, a chart change, a comparison of groups, a report — and nothing changes until the proposal is applied; every statistic comes from the data. It knows which mode it was opened from and what is in focus there ("this"). *Why this chart?* answers from the engine's chart advice for the result in focus. The microphone uses the browser's own speech recognition: nothing leaves the device, and a browser without a recogniser shows no button.

## Levels of detail

**Simple**, **Professional** and **Advanced** (in the workspace head) change how much is shown, never what exists: Simple hides evidence lines, statistics and the details view; Advanced opens the statistics and the technical details by default. Switching loses nothing.

## The attention list

The Explorer names what deserves attention, for research reasons only: analyses that repeat another on the same variables, hypotheses that cannot be tested and why, planned analyses not yet created, analyses that cannot run, analyses stale against the plan, hypotheses nothing tests, a plan that has not been run.
